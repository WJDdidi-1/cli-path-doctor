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
  const api = pathApi(platform);
  const current = rows.find((row) => row.name === 'current');
  const currentPathValues = current ? [current.pathValue] : [];

  if (!hasUsableToolchain) {
    for (const fix of npmInspection
      ? npmFixes(npmInspection, platform, { ...fixOptions, pathValues: currentPathValues })
      : []) {
      addFix(fixes, fix);
    }
  }

  const daemon = rows.find((row) => row.name === 'daemon-like');
  const daemonPathValues = daemon ? [daemon.pathValue] : [];
  for (const row of rows) {
    if (!row.resolved || !row.path) continue;

    const directory = api.dirname(row.path);
    // The daemon needs the directory, but telling a user whose current shell
    // already searches it to export it again is noise. Fixes target the shell
    // the user is reading the output in, so only a directory missing from the
    // current PATH is worth a copy-paste line.
    if (!directoryOnPath(directory, daemonPathValues, platform)
      && !directoryOnPath(directory, currentPathValues, platform)) {
      addFix(fixes, formatPathFix(directory, fixOptions));
    }
  }

  // A toolchain binary that is already on disk is repaired by adding its
  // directory to PATH (or by chmod, below), never by reinstalling it with npm.
  // A directory already present in one of the checked PATHs is left to the
  // resolved-row loop above, which only offers a fix when the daemon-like PATH
  // lacks it.
  const rowPathValues = rows.map((row) => row.pathValue);
  for (const candidate of toolchainCandidates) {
    if (!candidate.exists || !candidate.isFile || candidate.broken) continue;

    if (!candidate.executable && platform !== 'win32') {
      addFix(fixes, `chmod +x ${quote(candidate.path, platform)}`);
      continue;
    }

    if (candidate.executable && !directoryOnPath(candidate.directory, rowPathValues, platform)) {
      addFix(fixes, formatPathFix(candidate.directory, fixOptions));
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
    // suppresses the npm line even when the PATH fix is the real repair.
    if (!hasNpmEvidence && !hasToolchainEvidence) {
      addFix(fixes, `npm install -g ${quote(command, platform)}`);
    }
  }

  return fixes;
}
