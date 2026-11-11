import fs from 'node:fs';
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

function isBrokenRow(row) {
  if (!row || row.runnable !== false) return false;
  if (!row.path && !row.foundPath) return false;
  return row.status === 'broken' || Boolean(row.resolved);
}

function interpreterFromRow(row) {
  if (row.interpreter) return row.interpreter;
  const match = String(row.unrunnableReason || '').match(/shebang interpreter (\S+)/);
  return match ? match[1] : null;
}

function envCommandFromRow(row) {
  if (row.envCommand) return row.envCommand;
  const match = String(row.unrunnableReason || '').match(/cannot find (\S+) on this PATH/);
  return match ? match[1] : null;
}

/**
 * A broken command is not repaired by adding a PATH directory: the shell can
 * already find the file, it just cannot start it. Naming the file, the missing
 * interpreter, and the exact next step is the repair for this failure mode.
 */
function brokenRepair(row, platform = process.platform) {
  const file = row.path || row.foundPath;
  const reason = String(row.unrunnableReason || 'the command cannot start');
  const interpreter = interpreterFromRow(row);
  const envCommand = envCommandFromRow(row);
  const quotedFile = quote(file, platform);

  if (envCommand) {
    return `install ${envCommand} on PATH (the shebang interpreter ${interpreter || 'env'} cannot find it), or change the shebang in ${quotedFile}`;
  }

  if (interpreter && /does not exist/.test(reason)) {
    return `install the missing shebang interpreter ${interpreter}, or change the shebang in ${quotedFile}`;
  }

  if (interpreter && /is not executable/.test(reason)) {
    return `chmod +x ${quote(interpreter, platform)}, or change the shebang in ${quotedFile}`;
  }

  if (interpreter && /is not a file/.test(reason)) {
    return `replace ${interpreter} with an executable file, or change the shebang in ${quotedFile}`;
  }

  if (interpreter && /is not an absolute path/.test(reason)) {
    return `change the shebang in ${quotedFile} to an absolute path to ${interpreter}`;
  }

  if (interpreter) {
    return `repair the shebang interpreter ${interpreter}, or change the shebang in ${quotedFile}`;
  }

  return `change the shebang in ${quotedFile} to an interpreter that exists`;
}

function resolvedForComparison(file, platform) {
  if (!file) return null;
  try {
    return fs.realpathSync(file);
  } catch {
    return pathApi(platform).resolve(String(file));
  }
}

function sameFile(left, right, platform) {
  const first = resolvedForComparison(left, platform);
  const second = resolvedForComparison(right, platform);
  if (!first || !second) return false;
  return platform === 'win32'
    ? first.toLowerCase() === second.toLowerCase()
    : first === second;
}

function relativeIsInside(relative, api) {
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${api.sep}`)
    && !api.isAbsolute(relative);
}

function isInsideDirectory(parent, child, platform) {
  if (!parent || !child) return false;
  const api = pathApi(platform);

  const lexical = api.relative(api.resolve(parent), api.resolve(child));
  if (relativeIsInside(lexical, api)) return true;

  // The reported PATH entry and the configured npm prefix can spell the same
  // directory differently (a temporary directory under /var on macOS is often
  // /private/var). Resolve both before deciding the file is outside npm.
  const resolvedParent = resolvedForComparison(parent, platform);
  const resolvedChild = resolvedForComparison(child, platform);
  if (!resolvedParent || !resolvedChild) return false;

  return relativeIsInside(api.relative(resolvedParent, resolvedChild), api);
}

/**
 * The npm global prefix is the only place where reinstalling a named package is
 * provably the repair. A random PATH file has no owning package, so a blind
 * `npm install -g <command>` would be a guess and is deliberately not emitted.
 */
function globalPackageForBrokenRow(row, npmInspection, command, platform) {
  if (!npmInspection) return null;
  const prefix = npmInspection.globalPrefix
    || (npmInspection.prefix && npmInspection.prefix.path)
    || null;
  if (!prefix) return null;

  const files = [row.path, row.realPath].filter(Boolean);
  if (!files.some((file) => isInsideDirectory(prefix, file, platform))) return null;

  const globals = (npmInspection.packages || [])
    .filter((pkg) => pkg.source === 'global package');
  const matching = globals.filter((pkg) => pkg.command === command || !command);

  const byPath = matching.find((pkg) => [pkg.target, pkg.link, pkg.packageDirectory]
    .some((candidate) => files.some((file) => sameFile(candidate, file, platform))));
  if (byPath) return byPath;

  return matching.length === 1 ? matching[0] : null;
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

  // A file that is present and executable but cannot start is repaired at the
  // interpreter or owning-package layer, not by adding another PATH directory.
  const seenBroken = new Set();
  for (const row of rows.filter(isBrokenRow)) {
    const file = row.path || row.foundPath;
    const key = platform === 'win32' ? String(file).toLowerCase() : String(file);
    if (seenBroken.has(key)) continue;
    seenBroken.add(key);

    addFix(fixes, brokenRepair(row, platform));

    const pkg = globalPackageForBrokenRow(row, npmInspection, command, platform);
    if (pkg) addFix(fixes, `npm install -g ${quote(pkg.package, platform)}`);
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

/**
 * `--fix` only edits a shell startup file when there is a PATH directory to
 * add. For every other repair (missing interpreter, chmod, package reinstall)
 * the result still needs an honest reason. In particular a command that cannot
 * run must never be described as "nothing to fix".
 */
export function manualRepairReason(options = {}) {
  const command = options.command || 'the command';
  const rows = Array.isArray(options.rows) ? options.rows : [];
  const fixes = Array.isArray(options.fixes) ? options.fixes : [];
  const runnable = options.runnable !== false;
  const unrunnable = rows.find(
    (row) => row.runnable === false && row.unrunnableReason,
  );

  if (unrunnable) {
    const firstRepair = fixes.length > 0 ? `; repair: ${fixes[0]}` : '';
    return `${command} cannot start: ${unrunnable.unrunnableReason}${firstRepair}`;
  }

  if (!runnable) {
    const firstRepair = fixes.length > 0 ? `: ${fixes[0]}` : '';
    return `${command} is not runnable${firstRepair}`;
  }

  if (fixes.length > 0) return `manual repair required: ${fixes[0]}`;
  return 'no PATH directory to add';
}
