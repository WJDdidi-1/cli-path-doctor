import fs from 'node:fs';
import path from 'node:path';
import { homeDirectory } from './toolchain-metadata.mjs';
import { pathLineForShell, rcFileForShell, shellName } from './shell-rc.mjs';

/**
 * Directories are applied one marker block at a time. The directory is part of
 * both markers so a second run can recognize the same block, and a user can
 * delete exactly the block they no longer want.
 */
export const FIX_BLOCK_START = '# >>> cli-path-doctor:';
export const FIX_BLOCK_END = '# <<< cli-path-doctor:';
export const FIX_BLOCK_NOTE = '# Managed by cli-path-doctor --fix. Delete this block to undo.';

const EDITABLE_SHELLS = new Set([
  'zsh',
  'bash',
  'dash',
  'sh',
  'ash',
  'ksh',
  'mksh',
  'yash',
  'fish',
]);

/**
 * The rc-file mapping in shell-rc.mjs deliberately falls back to ~/.profile so
 * diagnosis always names a file. Writing is stricter: an unknown shell gets a
 * refusal instead of a guess about which startup file to modify.
 */
export function editableRcFileForShell(shell, platform = process.platform) {
  if (platform === 'win32') return null;

  const name = shellName(shell);
  if (!name) return null;

  if (EDITABLE_SHELLS.has(name)) return rcFileForShell(shell, platform);
  if (name.startsWith('zsh')) return rcFileForShell(shell, platform);
  if (name.startsWith('bash')) return rcFileForShell(shell, platform);
  if (name.includes('fish')) return rcFileForShell(shell, platform);

  return null;
}

export function resolveRcFilePath(rcFile, env = process.env, platform = process.platform) {
  if (!rcFile || typeof rcFile !== 'string') return null;
  if (platform === 'win32') return null;

  const api = path.posix;
  const home = homeDirectory(env, platform);

  if (rcFile === '~') return home ? api.normalize(home) : null;
  if (rcFile.startsWith('~/')) {
    return home ? api.normalize(api.join(home, rcFile.slice(2))) : null;
  }

  return api.isAbsolute(rcFile) ? api.normalize(rcFile) : null;
}

function markerStart(directory) {
  return `${FIX_BLOCK_START} ${directory} >>>`;
}

function markerEnd(directory) {
  return `${FIX_BLOCK_END} ${directory} <<<`;
}

export function pathFixBlock(directory, options = {}) {
  return [
    markerStart(directory),
    FIX_BLOCK_NOTE,
    pathLineForShell(directory, options),
    markerEnd(directory),
  ].join('\n');
}

function refusal(reason, file = null) {
  return {
    applied: false,
    file,
    line: null,
    alreadyPresent: false,
    reason,
  };
}

function readExisting(file) {
  try {
    return { ok: true, content: fs.readFileSync(file, 'utf8') };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, content: '' };
    return {
      ok: false,
      reason: `cannot read ${file}: ${error && error.message ? error.message : 'unknown error'}`,
    };
  }
}

/**
 * Append one marked block per directory that is not already managed in the rc
 * file. Existing content is never rewritten, so unrelated shell setup is kept
 * intact. Running the same fix twice returns applied:false / alreadyPresent:true
 * and leaves the file byte-for-byte unchanged.
 */
export function applyPathFix(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const shell = options.shell === undefined ? env.SHELL : options.shell;
  const directories = [...new Set(
    (Array.isArray(options.directories) ? options.directories : [])
      .filter((directory) => typeof directory === 'string' && directory.length > 0),
  )];

  if (platform === 'win32') {
    return refusal('--fix is only supported for POSIX shells; use your PowerShell profile');
  }

  if (directories.length === 0) {
    return refusal('no PATH directory to add; nothing to fix');
  }

  const shellLabel = shellName(shell);
  if (!shellLabel) {
    return refusal('unknown shell; cannot choose a startup file to edit');
  }

  const editableRcFile = editableRcFileForShell(shell, platform);
  if (!editableRcFile) {
    return refusal(`unknown shell ${shellLabel}; refusing to guess which startup file to edit`);
  }

  const rcFile = options.rcFile || editableRcFile;
  const file = resolveRcFilePath(rcFile, env, platform);
  if (!file) {
    return refusal(`cannot resolve the startup file ${rcFile} for ${shellLabel}`);
  }

  const existing = readExisting(file);
  if (!existing.ok) return refusal(existing.reason, file);

  const missing = directories.filter(
    (directory) => !existing.content.includes(markerStart(directory)),
  );
  const lines = directories
    .map((directory) => pathLineForShell(directory, { ...options, shell, platform }))
    .join('\n');

  if (missing.length === 0) {
    return {
      applied: false,
      file,
      line: lines,
      alreadyPresent: true,
      reason: `PATH fix already present in ${file}`,
    };
  }

  const blocks = missing
    .map((directory) => pathFixBlock(directory, { ...options, shell, platform }))
    .join('\n\n');
  const separator = existing.content.length === 0
    ? ''
    : existing.content.endsWith('\n')
      ? '\n'
      : '\n\n';

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${separator}${blocks}\n`, 'utf8');
  } catch (error) {
    return refusal(
      `cannot write ${file}: ${error && error.message ? error.message : 'unknown error'}`,
      file,
    );
  }

  return {
    applied: true,
    file,
    line: lines,
    alreadyPresent: false,
    reason: null,
  };
}
