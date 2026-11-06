import { npmFixes } from './npm-metadata.mjs';
import { pathApi, splitPathValue } from './path-resolver.mjs';

function quote(value, platform = process.platform) {
  const text = String(value);
  if (platform === 'win32') {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function pathExport(directory, platform = process.platform) {
  if (platform === 'win32') {
    return `$env:Path = '${String(directory).replace(/'/g, "''")};' + $env:Path`;
  }

  return `export PATH=${quote(directory, platform)}:"$PATH"`;
}

function addFix(fixes, value) {
  if (value && !fixes.includes(value)) fixes.push(value);
}

/**
 * Combine the npm-specific repairs with PATH guidance. The list is stable and
 * deduplicated so it can be printed as-is or emitted in --json output.
 */
export function buildFixes(options = {}) {
  const command = options.command;
  const rows = Array.isArray(options.rows) ? options.rows : [];
  const platform = options.platform || process.platform;
  const npmInspection = options.npmInspection || null;
  const fixes = [];

  for (const fix of npmInspection && Array.isArray(npmInspection.fixes)
    ? npmInspection.fixes
    : npmFixes(npmInspection, platform)) {
    addFix(fixes, fix);
  }

  if (options.loginOnlyDirectory) {
    addFix(fixes, pathExport(options.loginOnlyDirectory, platform));
  }

  const api = pathApi(platform);
  const daemon = rows.find((row) => row.name === 'daemon-like');
  const daemonDirectories = new Set(splitPathValue(daemon ? daemon.pathValue : '', platform).filter(Boolean));
  for (const row of rows) {
    if (!row.resolved || !row.path) continue;

    const directory = api.dirname(row.path);
    if (!daemonDirectories.has(directory)) {
      addFix(fixes, pathExport(directory, platform));
    }
  }

  const anyResolved = rows.some((row) => row.resolved);
  if (!anyResolved) {
    const hasNpmEvidence = npmInspection
      && ((npmInspection.candidates && npmInspection.candidates.length > 0)
        || (npmInspection.packages && npmInspection.packages.length > 0));

    if (!hasNpmEvidence) {
      addFix(fixes, `npm install -g ${quote(command, platform)}`);
    }
  }

  return fixes;
}
