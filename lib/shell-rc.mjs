import path from 'node:path';

/**
 * The startup file a user edits to persist PATH for the detected shell.
 * The mapping is deliberately conservative: an unknown shell falls back to
 * `~/.profile`, which POSIX shells read on login.
 */
const SHELL_RC_FILES = {
  zsh: '~/.zshrc',
  bash: '~/.bashrc',
  dash: '~/.profile',
  sh: '~/.profile',
  ash: '~/.profile',
  ksh: '~/.kshrc',
  mksh: '~/.mkshrc',
  yash: '~/.profile',
};

export function shellName(shell) {
  if (!shell || typeof shell !== 'string') return null;

  const normalized = shell.replace(/\\/g, '/');
  const base = path.posix.basename(normalized).toLowerCase();
  return base.endsWith('.exe') ? base.slice(0, -4) : base;
}

export function rcFileForShell(shell, platform = process.platform) {
  if (platform === 'win32') return null;

  const name = shellName(shell);
  if (!name) return '~/.profile';
  if (SHELL_RC_FILES[name]) return SHELL_RC_FILES[name];

  if (name.startsWith('zsh')) return '~/.zshrc';
  if (name.startsWith('bash')) return '~/.bashrc';
  if (name.includes('fish')) return '~/.config/fish/config.fish';
  return '~/.profile';
}

function quote(value, platform = process.platform) {
  const text = String(value);
  if (platform === 'win32') {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function pathExportLine(directory, platform = process.platform) {
  if (platform === 'win32') {
    return `$env:Path = '${String(directory).replace(/'/g, "''")};' + $env:Path`;
  }

  return `export PATH=${quote(directory, platform)}:"$PATH"`;
}

/**
 * A single copy-pasteable line: the PATH change plus the file it belongs in.
 * Keeping it on one line means a consumer can print it, copy it, or store it
 * in --json without separating the file name from the command it applies to.
 */
/**
 * The single command line that persists one directory for the detected shell.
 * Fish has its own path helper; a POSIX shell uses an export. This is shared by
 * the printed advice and by `--fix` so the file receives exactly what was
 * recommended.
 */
export function pathLineForShell(directory, options = {}) {
  const platform = options.platform || process.platform;
  const name = shellName(options.shell);

  if (platform === 'win32') return pathExportLine(directory, platform);
  if (name === 'fish') return `fish_add_path ${quote(directory, platform)}`;
  return pathExportLine(directory, platform);
}

/**
 * A single copy-pasteable line: the PATH change plus the file it belongs in.
 * Keeping it on one line means a consumer can print it, copy it, or store it
 * in --json without separating the file name from the command it applies to.
 */
export function formatPathFix(directory, options = {}) {
  const platform = options.platform || process.platform;

  if (platform === 'win32') {
    return `${pathExportLine(directory, platform)}  # add to your PowerShell profile ($PROFILE), then open a new shell`;
  }

  const rcFile = options.rcFile || rcFileForShell(options.shell, platform);
  const line = pathLineForShell(directory, options);

  return `${line}  # add to ${rcFile}, then open a new shell`;
}
