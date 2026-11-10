import fs from 'node:fs';
import path from 'node:path';
import { inspectRunnability } from './runnability.mjs';

const DEFAULT_PATHEXT = [
  '.COM',
  '.EXE',
  '.BAT',
  '.CMD',
  '.VBS',
  '.VBE',
  '.JS',
  '.JSE',
  '.WSF',
  '.WSH',
  '.MSC',
  '.PS1',
];

export function pathDelimiter(platform = process.platform) {
  return platform === 'win32' ? ';' : ':';
}

export function pathApi(platform = process.platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function splitPathValue(pathValue, platform = process.platform) {
  return String(pathValue == null ? '' : pathValue).split(pathDelimiter(platform));
}

export function windowsExtensions(env = process.env) {
  const raw = env && env.PATHEXT ? String(env.PATHEXT) : '';
  const extensions = raw
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => (extension.startsWith('.') ? extension : `.${extension}`));

  return extensions.length > 0 ? extensions : DEFAULT_PATHEXT;
}

/**
 * Names that a bare command could have in one directory. On POSIX a command
 * name stands alone; on Windows we also try the PATHEXT suffixes.
 */
export function commandNames(command, platform = process.platform, env = process.env) {
  if (platform !== 'win32') return [command];

  const api = pathApi(platform);
  if (api.extname(command) !== '') return [command];

  return [command, ...windowsExtensions(env).map((extension) => `${command}${extension}`)];
}

function isWindowsExecutableExtension(candidate, env) {
  const extension = path.win32.extname(candidate).toLowerCase();
  if (!extension) return false;
  return windowsExtensions(env).some((entry) => entry.toLowerCase() === extension);
}

function executableOnPlatform(candidate, stat, platform, env) {
  if (platform === 'win32') return stat.isFile() && isWindowsExecutableExtension(candidate, env);
  if (!stat.isFile()) return false;

  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Inspect one candidate without throwing. Broken symlinks are reported as
 * existing-but-broken so callers can name the link that npm left behind.
 */
export function inspectFile(candidate, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;

  let linkStat;
  try {
    linkStat = fs.lstatSync(candidate);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { path: candidate, exists: false, broken: false };
    }
    return { path: candidate, exists: false, broken: false, error: error && error.message };
  }

  const symlink = linkStat.isSymbolicLink();
  let linkTarget = null;
  if (symlink) {
    try {
      linkTarget = fs.readlinkSync(candidate);
    } catch {
      linkTarget = null;
    }
  }

  let stat;
  try {
    stat = fs.statSync(candidate);
  } catch (error) {
    if (symlink && error && error.code === 'ENOENT') {
      return {
        path: candidate,
        exists: true,
        broken: true,
        symlink: true,
        linkTarget,
        executable: false,
        isFile: false,
        error: error.message,
      };
    }

    return {
      path: candidate,
      exists: true,
      broken: false,
      symlink,
      linkTarget,
      executable: false,
      isFile: false,
      error: error && error.message,
    };
  }

  let realPath = null;
  if (symlink) {
    try {
      realPath = fs.realpathSync(candidate);
    } catch {
      realPath = null;
    }
  }

  return {
    path: candidate,
    exists: true,
    broken: false,
    symlink,
    linkTarget,
    realPath,
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    executable: executableOnPlatform(candidate, stat, platform, env),
    mode: stat.mode,
  };
}

function directCandidates(command, cwd, options) {
  const platform = options.platform;
  const env = options.env;
  const api = pathApi(platform);
  const absolute = api.isAbsolute(command) ? command : api.resolve(cwd, command);
  const names = api.extname(absolute) === '' && platform === 'win32'
    ? commandNames(absolute, platform, env)
    : [absolute];

  return names;
}

function lookupInDirectories(command, directories, options) {
  const platform = options.platform;
  const env = options.env;
  const api = pathApi(platform);
  const names = commandNames(command, platform, env);

  let foundNonExecutable = null;
  let foundBroken = null;
  let checked = 0;

  for (const rawDirectory of directories) {
    const directory = rawDirectory === '' ? '.' : rawDirectory;
    checked += 1;

    for (const name of names) {
      const candidate = api.join(directory, name);
      const inspected = inspectFile(candidate, { platform, env });

      if (inspected.broken) {
        if (!foundBroken) foundBroken = inspected;
        continue;
      }

      if (!inspected.exists || !inspected.isFile) continue;

      if (inspected.executable) {
        const runnability = inspectRunnability(candidate, {
          platform,
          env,
          pathValue: options.pathValue,
        });

        return {
          resolved: true,
          path: candidate,
          realPath: inspected.realPath,
          symlink: inspected.symlink,
          linkTarget: inspected.linkTarget,
          mode: inspected.mode,
          runnable: runnability.runnable,
          unrunnableReason: runnability.reason,
          checked,
        };
      }

      if (!foundNonExecutable) foundNonExecutable = inspected;
    }
  }

  if (foundNonExecutable) {
    return {
      resolved: false,
      path: null,
      reason: `found at ${foundNonExecutable.path} but it is not executable`,
      foundPath: foundNonExecutable.path,
      nonExecutable: foundNonExecutable,
      checked,
    };
  }

  if (foundBroken) {
    return {
      resolved: false,
      path: null,
      reason: `broken symlink ${foundBroken.path} -> ${foundBroken.linkTarget || '?'}`,
      foundPath: foundBroken.path,
      brokenLink: foundBroken,
      checked,
    };
  }

  return {
    resolved: false,
    path: null,
    reason: 'not found on PATH',
    checked,
  };
}

/**
 * Resolve a command using one PATH value. The result always has `resolved`
 * and `path`; misses also carry a human-readable `reason`.
 */
export function lookupCommand(command, pathValue, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const api = pathApi(platform);

  if (typeof command !== 'string' || command.length === 0) {
    return { resolved: false, path: null, reason: 'no command was given', checked: 0 };
  }

  const looksLikePath =
    command.includes('/') ||
    (platform === 'win32' && (command.includes('\\') || /^[A-Za-z]:/.test(command)));

  if (looksLikePath) {
    const names = directCandidates(command, cwd, { platform, env });

    for (const candidate of names) {
      const inspected = inspectFile(candidate, { platform, env });

      if (inspected.broken) {
        return {
          resolved: false,
          path: null,
          reason: `broken symlink ${candidate} -> ${inspected.linkTarget || '?'}`,
          foundPath: candidate,
          brokenLink: inspected,
          checked: 1,
        };
      }

      if (inspected.exists && inspected.isFile && inspected.executable) {
        const runnability = inspectRunnability(candidate, {
          platform,
          env,
          pathValue: env.PATH,
        });

        return {
          resolved: true,
          path: candidate,
          realPath: inspected.realPath,
          symlink: inspected.symlink,
          linkTarget: inspected.linkTarget,
          mode: inspected.mode,
          runnable: runnability.runnable,
          unrunnableReason: runnability.reason,
          checked: 1,
        };
      }

      if (inspected.exists && inspected.isFile && !inspected.executable) {
        return {
          resolved: false,
          path: null,
          reason: `found at ${candidate} but it is not executable`,
          foundPath: candidate,
          nonExecutable: inspected,
          checked: 1,
        };
      }
    }

    return {
      resolved: false,
      path: null,
      reason: `${command} does not exist`,
      checked: names.length,
    };
  }

  const directories = splitPathValue(pathValue, platform);
  return lookupInDirectories(command, directories, { platform, env, pathValue });
}

/**
 * Every runnable copy of a bare command that PATH can reach, in resolution
 * order. The first copy wins; later copies are shadowed. A PATH entry repeated
 * twice does not create a fake second copy, and a non-executable file is not a
 * copy because the shell cannot run it.
 */
export function findCommandCopies(command, pathValue, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const api = pathApi(platform);

  if (typeof command !== 'string' || command.length === 0) {
    return { command: null, copies: [], winner: null, shadowed: [] };
  }

  const looksLikePath =
    command.includes('/') ||
    (platform === 'win32' && (command.includes('\\') || /^[A-Za-z]:/.test(command)));

  // A command written as a path is not looked up on PATH, so it cannot shadow
  // or be shadowed by another PATH entry.
  if (looksLikePath) {
    return { command, copies: [], winner: null, shadowed: [] };
  }

  const directories = splitPathValue(pathValue, platform);
  const names = commandNames(command, platform, env);
  const seen = new Set();
  const copies = [];

  for (const rawDirectory of directories) {
    const directory = rawDirectory === '' ? '.' : rawDirectory;

    for (const name of names) {
      const candidate = api.join(directory, name);
      const inspected = inspectFile(candidate, { platform, env });

      if (!inspected.exists || inspected.broken || !inspected.isFile || !inspected.executable) {
        continue;
      }

      const key = platform === 'win32' ? candidate.toLowerCase() : candidate;
      if (seen.has(key)) break;
      seen.add(key);

      const runnability = inspectRunnability(candidate, {
        platform,
        env,
        pathValue,
      });

      copies.push({
        path: candidate,
        directory,
        realPath: inspected.realPath || null,
        symlink: Boolean(inspected.symlink),
        linkTarget: inspected.linkTarget || null,
        executable: true,
        runnable: runnability.runnable,
        unrunnableReason: runnability.reason,
      });
      // On Windows the PATHEXT variants are alternatives for one entry; the
      // first runnable one is the copy that entry provides.
      break;
    }
  }

  const marked = copies.map((copy, index) => ({
    ...copy,
    winner: index === 0,
    shadowed: index > 0,
  }));

  return {
    command,
    copies: marked,
    winner: marked[0] || null,
    shadowed: marked.slice(1),
  };
}

/**
 * A concise explanation for a miss, optionally enriched with npm bin state.
 */
export function describeMiss(result, extra) {
  const parts = [result && result.reason ? result.reason : 'not found on PATH'];
  if (extra) parts.push(extra);
  return parts.join('; ');
}
