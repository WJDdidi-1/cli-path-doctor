import { npmFixes } from './npm-metadata.mjs';
import { pathApi } from './path-resolver.mjs';
import { formatPathFix } from './shell-rc.mjs';
import { directoryOnPath } from './toolchain-metadata.mjs';

function quote(value, platform = process.platform) {
  const text = String(value);
  if (platform === 'win32') {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function addFix(fixes, value) {
  if (value && !fixes.includes(value)) fixes.push(value);
}

function uniqueDirectoryAdder(platform) {
  const api = pathApi(platform);
  const directories = [];
  const seen = new Set();

  return {
    add(directory) {
      if (!directory) return;
      const normalized = api.normalize(String(directory));
      const key = platform === 'win32' ? normalized.toLowerCase() : normalized;
      if (seen.has(key)) return;
      seen.add(key);
      directories.push(normalized);
    },
    values: directories,
  };
}

/**
 * Every directory that a PATH fix should add, in the same order in which they
 * are printed. `--fix` uses this list so the file it edits is exactly the set of
 * directories the diagnosis recommended. npm candidates are included only when
 * npm advice is still relevant (a usable toolchain binary suppresses it), which
 * mirrors buildFixes.
 */
export function pathDirectoriesToAdd(options = {}) {
  const rows = Array.isArray(options.rows) ? options.rows : [];
  const platform = options.platform || process.platform;
  const npmInspection = options.npmInspection || null;
  const toolchainInspection = options.toolchainInspection || null;
  const toolchainCandidates = toolchainInspection && Array.isArray(toolchainInspection.candidates)
    ? toolchainInspection.candidates
    : [];
  const includeNpm = options.includeNpm !== false;
  const api = pathApi(platform);
  const directories = uniqueDirectoryAdder(platform);

  const current = rows.find((row) => row.name === 'current');
  const currentPathValues = current ? [current.pathValue] : [];
  const daemon = rows.find((row) => row.name === 'daemon-like');
  const daemonPathValues = daemon ? [daemon.pathValue] : [];
  const rowPathValues = rows.map((row) => row.pathValue);
  const hasUsableToolchain = toolchainCandidates.some(
    (candidate) => candidate.exists
      && candidate.isFile
      && candidate.executable
      && !candidate.broken,
  );

  if (includeNpm && !hasUsableToolchain && npmInspection) {
    for (const candidate of npmInspection.candidates || []) {
      if (!candidate.exists || !candidate.isFile || !candidate.executable) continue;

      const directory = candidate.directory || api.dirname(candidate.path);
      if (!directoryOnPath(directory, currentPathValues, platform)) {
        directories.add(directory);
      }
    }
  }

  for (const row of rows) {
    if (!row.resolved || !row.path) continue;

    const directory = api.dirname(row.path);
    if (!directoryOnPath(directory, daemonPathValues, platform)
      && !directoryOnPath(directory, currentPathValues, platform)) {
      directories.add(directory);
    }
  }

  for (const candidate of toolchainCandidates) {
    if (!candidate.exists || !candidate.isFile || candidate.broken) continue;
    if (!candidate.executable) continue;
    if (!directoryOnPath(candidate.directory, rowPathValues, platform)) {
      directories.add(candidate.directory);
    }
  }

  return directories.values;
}

/**
 * Combine the npm-specific repairs with PATH guidance. The list is stable and
 * deduplicated so it can be printed as-is or emitted in --json output.
 *
 * PATH advice is only emitted for a directory that actually contains the
 * command and that the current PATH does not already search. A login-only
 * directory with no matching executable is reported as a context difference but
 * is not suggested as a fix. Every POSIX PATH fix names the startup file for the
 * detected shell, so it can be followed directly.
 */
export function buildFixes(options = {}) {
  const command = options.command;
  const rows = Array.isArray(options.rows) ? options.rows : [];
  const platform = options.platform || process.platform;
  const npmInspection = options.npmInspection || null;
  const toolchainInspection = options.toolchainInspection || null;
  const toolchainCandidates = toolchainInspection && Array.isArray(toolchainInspection.candidates)
    ? toolchainInspection.candidates
    : [];
  const shell = options.shell !== undefined
    ? options.shell
    : (platform === 'win32' ? null : process.env.SHELL);
  const fixOptions = {
    platform,
    shell,
    rcFile: options.rcFile,
  };
  const fixes = [];
  const hasUsableToolchain = toolchainCandidates.some(
    (candidate) => candidate.exists
      && candidate.isFile
      && candidate.executable
      && !candidate.broken,
  );

  // Regenerate npm repairs with the shell mapping rather than reusing the
  // cached list: the cached list may have been built before the shell was
  // resolved. A usable toolchain binary wins: the command is already installed
  // there, so npm reinstall advice would add a second, unrelated copy.
  const current = rows.find((row) => row.name === 'current');
  const currentPathValues = current ? [current.pathValue] : [];
  const nonExecutablePaths = rows
    .filter((row) => row.nonExecutable && row.foundPath)
    .map((row) => row.foundPath);

  // A file the PATH lookup actually found is repaired by its local permission
  // bit, not by reinstalling a package that may not exist. Do this before the
  // npm branches so a generic install line cannot be the only advice.
  const hasLocalPermissionFix = platform !== 'win32' && nonExecutablePaths.length > 0;
  if (hasLocalPermissionFix) {
    for (const foundPath of new Set(nonExecutablePaths)) {
      addFix(fixes, `chmod +x ${quote(foundPath, platform)}`);
    }
  }

  if (!hasUsableToolchain) {
    for (const fix of npmInspection
      ? npmFixes(npmInspection, platform, { ...fixOptions, pathValues: currentPathValues })
      : []) {
      addFix(fixes, fix);
    }
  }

  // Resolved rows and toolchain candidates share the directory rules with
  // --fix. npm candidates are handled by npmFixes above, so they are excluded
  // here to avoid printing the same PATH line twice.
  for (const directory of pathDirectoriesToAdd({
    ...options,
    includeNpm: false,
  })) {
    addFix(fixes, formatPathFix(directory, fixOptions));
  }

  // A toolchain binary that is present but not executable is repaired in
  // place; it is not a PATH problem.
  for (const candidate of toolchainCandidates) {
    if (!candidate.exists || !candidate.isFile || candidate.broken) continue;
    if (!candidate.executable && platform !== 'win32') {
      addFix(fixes, `chmod +x ${quote(candidate.path, platform)}`);
    }
  }

  const anyResolved = rows.some((row) => row.resolved);
  if (!anyResolved) {
    const hasNpmEvidence = npmInspection
      && ((npmInspection.candidates && npmInspection.candidates.length > 0)
        || (npmInspection.packages && npmInspection.packages.length > 0));
    const hasToolchainEvidence = toolchainCandidates.length > 0;

    // Keep the install line whenever nothing was found. This is the only
    // actionable advice when there is no directory to add to PATH. A binary
    // found in a cargo/bun/volta/go directory is not an npm install, so it
    // suppresses the npm line even when the PATH fix is the real repair. A
    // path-local non-executable file is repaired by chmod above, so a package
    // named after the command is not evidence that reinstalling will help.
    if (!hasNpmEvidence && !hasToolchainEvidence && !hasLocalPermissionFix) {
      addFix(fixes, `npm install -g ${quote(command, platform)}`);
    }
  }

  return fixes;
}
