import fs from 'node:fs';
import os from 'node:os';
import { commandNames, inspectFile, pathApi, pathDelimiter, splitPathValue } from './path-resolver.mjs';

function envValue(env, name) {
  if (!env) return null;
  const value = env[name];
  return value == null || value === '' ? null : String(value);
}

/**
 * The user's home directory, honoring the same variables the shell and the
 * toolchains use. `HOME` is the POSIX convention; Windows sets USERPROFILE (or
 * HOMEDRIVE + HOMEPATH).
 */
export function homeDirectory(env = process.env, platform = process.platform) {
  const api = pathApi(platform);
  const configured = envValue(env, 'HOME')
    || envValue(env, 'USERPROFILE')
    || (env && env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : null)
    || os.homedir();

  return configured ? api.normalize(String(configured)) : null;
}

function expandPath(value, home, api) {
  if (value == null) return null;

  const text = String(value);
  if (text === '~') return home || null;
  if (text.startsWith('~/') || text.startsWith('~\\')) {
    return home ? api.normalize(api.join(home, text.slice(2))) : null;
  }

  if (api.isAbsolute(text)) return api.normalize(text);
  return home ? api.normalize(api.join(home, text)) : api.normalize(text);
}

function directoryKey(directory, platform) {
  const api = pathApi(platform);
  const normalized = api.normalize(directory);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Every user-level directory a modern toolchain may install a command into.
 * The list is ordered from the most explicit toolchain to generic shim
 * directories. Configured locations are searched in addition to the default
 * ones, so overriding CARGO_HOME or BUN_INSTALL does not hide a binary that
 * still lives in the default directory.
 *
 * The returned entries always carry `toolchain`, `directory`, and `source`.
 */
export function toolchainDirectories(env = process.env, platform = process.platform) {
  const api = pathApi(platform);
  const home = homeDirectory(env, platform);
  const entries = [];
  const seen = new Set();

  const add = (toolchain, directory, source) => {
    if (!directory) return;
    const normalized = api.normalize(directory);
    const key = directoryKey(normalized, platform);
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ toolchain, directory: normalized, source });
  };

  const atHome = (...parts) => (home ? api.join(home, ...parts) : null);
  const configured = (name) => envValue(env, name);
  const localAppData = configured('LOCALAPPDATA');
  const under = (base, ...parts) => {
    const expanded = expandPath(base, home, api);
    return expanded ? api.join(expanded, ...parts) : null;
  };

  // Rust: rustup installs the cargo/rustc proxies into CARGO_HOME/bin.
  const cargoHome = configured('CARGO_HOME');
  if (cargoHome) add('cargo', under(cargoHome, 'bin'), 'CARGO_HOME');
  add('cargo', atHome('.cargo', 'bin'), '~/.cargo/bin');

  // Bun: `bun install -g` uses BUN_INSTALL/bin (default ~/.bun/bin).
  const bunInstall = configured('BUN_INSTALL');
  if (bunInstall) add('bun', under(bunInstall, 'bin'), 'BUN_INSTALL');
  add('bun', atHome('.bun', 'bin'), '~/.bun/bin');

  // Volta: global packages and shims live under VOLTA_HOME/bin. On Windows the
  // installer defaults to %LOCALAPPDATA%\Volta instead of ~/.volta.
  const voltaHome = configured('VOLTA_HOME');
  if (voltaHome) add('volta', under(voltaHome, 'bin'), 'VOLTA_HOME');
  add('volta', atHome('.volta', 'bin'), '~/.volta/bin');
  if (platform === 'win32' && localAppData) {
    add('volta', under(localAppData, 'Volta', 'bin'), 'LOCALAPPDATA');
  }

  // Go: GOBIN wins, then each GOPATH entry, then the default ~/go/bin.
  const gobin = configured('GOBIN');
  if (gobin) add('go', expandPath(gobin, home, api), 'GOBIN');
  const gopath = configured('GOPATH');
  if (gopath) {
    for (const entry of gopath.split(pathDelimiter(platform))) {
      if (!entry) continue;
      add('go', under(entry, 'bin'), 'GOPATH');
    }
  }
  add('go', atHome('go', 'bin'), '~/go/bin');

  // Deno: `deno install` writes to DENO_INSTALL/bin (default ~/.deno/bin).
  const denoInstall = configured('DENO_INSTALL');
  if (denoInstall) add('deno', under(denoInstall, 'bin'), 'DENO_INSTALL');
  add('deno', atHome('.deno', 'bin'), '~/.deno/bin');

  // pnpm: PNPM_HOME is the supported location; the defaults vary by OS.
  const pnpmHome = configured('PNPM_HOME');
  if (pnpmHome) add('pnpm', expandPath(pnpmHome, home, api), 'PNPM_HOME');
  add('pnpm', atHome('.local', 'share', 'pnpm'), '~/.local/share/pnpm');
  add('pnpm', atHome('Library', 'pnpm'), '~/Library/pnpm');
  if (platform === 'win32') {
    add(
      'pnpm',
      localAppData ? under(localAppData, 'pnpm') : atHome('AppData', 'Local', 'pnpm'),
      localAppData ? 'LOCALAPPDATA' : '~/AppData/Local/pnpm',
    );
  }

  // Yarn classic installs global bins into ~/.yarn/bin.
  add('yarn', atHome('.yarn', 'bin'), '~/.yarn/bin');

  // Version-manager shim directories.
  const asdfData = configured('ASDF_DATA_DIR');
  if (asdfData) add('asdf', under(asdfData, 'shims'), 'ASDF_DATA_DIR');
  add('asdf', atHome('.asdf', 'shims'), '~/.asdf/shims');

  const miseData = configured('MISE_DATA_DIR');
  if (miseData) add('mise', under(miseData, 'shims'), 'MISE_DATA_DIR');
  add('mise', atHome('.local', 'share', 'mise', 'shims'), '~/.local/share/mise/shims');

  const pyenvRoot = configured('PYENV_ROOT');
  if (pyenvRoot) add('pyenv', under(pyenvRoot, 'shims'), 'PYENV_ROOT');
  add('pyenv', atHome('.pyenv', 'shims'), '~/.pyenv/shims');

  const rbenvRoot = configured('RBENV_ROOT');
  if (rbenvRoot) add('rbenv', under(rbenvRoot, 'shims'), 'RBENV_ROOT');
  add('rbenv', atHome('.rbenv', 'shims'), '~/.rbenv/shims');

  // Generic per-user install location used by pipx, uv, and standalone tools.
  add('local', atHome('.local', 'bin'), '~/.local/bin');

  return entries;
}

function directoryExists(directory) {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function candidateRank(candidate) {
  if (candidate.broken) return 3;
  if (!candidate.exists || !candidate.isFile) return 2;
  return candidate.executable ? 0 : 1;
}

function preferredCandidate(candidates) {
  return [...candidates].sort((left, right) => {
    const rank = candidateRank(left) - candidateRank(right);
    if (rank !== 0) return rank;
    return String(left.path).localeCompare(String(right.path));
  })[0] || null;
}

function sameDirectory(left, right, platform) {
  return directoryKey(left, platform) === directoryKey(right, platform);
}

export function directoryOnPath(directory, pathValues, platform = process.platform) {
  if (!Array.isArray(pathValues)) return false;

  return pathValues.some((pathValue) => splitPathValue(pathValue, platform)
    .map((entry) => (entry === '' ? '.' : entry))
    .some((entry) => sameDirectory(entry, directory, platform)));
}

/**
 * A short explanation for a toolchain binary that exists on disk but did not
 * resolve. Only a usable binary that is genuinely absent from every checked
 * PATH gets the "installed at ... but not on PATH" wording; a non-executable
 * file or a broken link gets its own diagnosis.
 */
export function toolchainHint(inspection, options = {}) {
  const candidate = inspection && inspection.preferred;
  if (!candidate) return null;

  if (candidate.broken) {
    return `installed at ${candidate.path} but it is a broken symlink -> ${candidate.linkTarget || '?'}`;
  }

  if (!candidate.exists || !candidate.isFile) {
    return `found ${candidate.path} but it is not a regular file`;
  }

  if (!candidate.executable) {
    return `installed at ${candidate.path} but it is not executable`;
  }

  const platform = inspection.platform || process.platform;
  if (directoryOnPath(candidate.directory, options.pathValues, platform)) {
    // The directory is already searched by at least one context, so a PATH
    // fix would not explain this miss. The context rows carry the real reason.
    return null;
  }

  return `installed at ${candidate.path} but not on PATH`;
}

/**
 * Search the user-level toolchain directories for a command, whether or not
 * they are currently on PATH. A found binary is evidence that the command was
 * installed with cargo, bun, volta, go, deno, pnpm, a version manager, or a
 * per-user installer, and that `npm install -g` is the wrong repair.
 */
export function inspectToolchainBins(command, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const api = pathApi(platform);
  const home = homeDirectory(env, platform);
  const directories = toolchainDirectories(env, platform).map((entry) => ({
    ...entry,
    exists: directoryExists(entry.directory),
  }));

  if (typeof command !== 'string' || command.length === 0) {
    return {
      command: null,
      platform,
      home,
      directories,
      candidates: [],
      preferred: null,
      hint: null,
    };
  }

  const names = commandNames(command, platform, env);
  const seen = new Set();
  const candidates = [];

  for (const entry of directories) {
    if (!entry.exists) continue;

    for (const name of names) {
      const candidate = api.join(entry.directory, name);
      const inspected = inspectFile(candidate, { platform, env });
      if (!inspected.exists && !inspected.broken) continue;
      if (inspected.isDirectory) continue;

      const key = platform === 'win32' ? candidate.toLowerCase() : candidate;
      if (seen.has(key)) continue;
      seen.add(key);

      candidates.push({
        ...inspected,
        toolchain: entry.toolchain,
        directory: entry.directory,
        directorySource: entry.source,
        source: `${entry.toolchain} bin`,
      });
    }
  }

  const inspection = {
    command,
    platform,
    home,
    directories,
    candidates,
    preferred: preferredCandidate(candidates),
  };
  inspection.hint = toolchainHint(inspection);
  return inspection;
}
