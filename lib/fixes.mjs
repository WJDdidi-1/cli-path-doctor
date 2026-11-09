import { npmFixes } from './npm-metadata.mjs';
import { splitPathValue, pathApi } from './path-resolver.mjs';
import { formatPathFix } from './shell-rc.mjs';

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
 * command. A login-only directory with no matching executable is reported as a
 * context difference but is not suggested as a fix. Every POSIX PATH fix names
 * the startup file for the detected shell, so it can be followed directly.
 */
export function buildFixes(options = {}) {
  const command = options.command;
  const rows = Array.isArray(options.rows) ? options.rows : [];
  const platform = options.platform || process.platform;
  const npmInspection = options.npmInspection || null;
  const shell = options.shell !== undefined
    ? options.shell
    : (platform === 'win32' ? null : process.env.SHELL);
  const fixOptions = {
    platform,
    shell,
    rcFile: options.rcFile,
  };
  const fixes = [];

  // Regenerate npm repairs with the shell mapping rather than reusing the
  // cached list: the cached list may have been built before the shell was
  // resolved.
  for (const fix of npmInspection ? npmFixes(npmInspection, platform, fixOptions) : []) {
    addFix(fixes, fix);
  }

  const api = pathApi(platform);
  const daemon = rows.find((row) => row.name === 'daemon-like');
  const daemonDirectories = new Set(splitPathValue(daemon ? daemon.pathValue : '', platform).filter(Boolean));
  for (const row of rows) {
    if (!row.resolved || !row.path) continue;

    const directory = api.dirname(row.path);
    if (!daemonDirectories.has(directory)) {
      addFix(fixes, formatPathFix(directory, fixOptions));
    }
  }

  const anyResolved = rows.some((row) => row.resolved);
  if (!anyResolved) {
    const hasNpmEvidence = npmInspection
      && ((npmInspection.candidates && npmInspection.candidates.length > 0)
        || (npmInspection.packages && npmInspection.packages.length > 0));

    // Keep the install line whenever nothing was found. This is the only
    // actionable advice when there is no directory to add to PATH.
    if (!hasNpmEvidence) {
      addFix(fixes, `npm install -g ${quote(command, platform)}`);
    }
  }

  return fixes;
}
