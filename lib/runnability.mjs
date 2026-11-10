import fs from 'node:fs';
import path from 'node:path';

const SHEBANG_BYTES = 4096;

function delimiterFor(platform) {
  return platform === 'win32' ? ';' : ':';
}

function readStart(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'r');
  } catch {
    // The execute bit can be set on a file this user cannot read. We cannot
    // learn anything from the bytes, so do not invent a verdict.
    return null;
  }

  try {
    const buffer = Buffer.alloc(SHEBANG_BYTES);
    const bytes = fs.readSync(descriptor, buffer, 0, SHEBANG_BYTES, 0);
    return buffer.subarray(0, bytes);
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch {
      // Nothing useful to do with a close failure.
    }
  }
}

function firstLine(bytes) {
  const end = bytes.indexOf(0x0a);
  const slice = end === -1 ? bytes : bytes.subarray(0, end);
  return slice.toString('utf8').replace(/\r$/, '');
}

function statInterpreter(interpreter) {
  try {
    return fs.statSync(interpreter);
  } catch (error) {
    return { error };
  }
}

function isExecutableFile(interpreter) {
  const stat = statInterpreter(interpreter);
  if (stat.error) {
    return { ok: false, reason: `shebang interpreter ${interpreter} does not exist` };
  }
  if (!stat.isFile()) {
    return { ok: false, reason: `shebang interpreter ${interpreter} is not a file` };
  }

  try {
    fs.accessSync(interpreter, fs.constants.X_OK);
  } catch {
    return { ok: false, reason: `shebang interpreter ${interpreter} is not executable` };
  }

  return { ok: true };
}

function envCommand(args) {
  const tokens = String(args || '')
    .split(/\s+/)
    .filter(Boolean);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '-u' || token === '--unset') {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    return token;
  }

  return null;
}

function findOnPath(command, pathValue, platform) {
  if (command.includes('/')) {
    // An explicit path in the shebang arguments is not a PATH lookup.
    const stat = statInterpreter(command);
    if (stat.error || !stat.isFile()) return null;
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }

  const api = platform === 'win32' ? path.win32 : path.posix;
  for (const entry of String(pathValue == null ? '' : pathValue).split(delimiterFor(platform))) {
    const directory = entry === '' ? '.' : entry;
    const candidate = api.join(directory, command);
    const stat = statInterpreter(candidate);
    if (stat.error || !stat.isFile()) continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep looking: a later PATH entry may supply a runnable copy.
    }
  }

  return null;
}

/**
 * Decide whether a file that is already known to exist and carry an execute
 * bit can actually be started by the kernel.
 *
 * Only a `#!` file can be checked without running it. The kernel reads the
 * interpreter path from the first line and fails with ENOENT/EACCES when that
 * interpreter is missing or not executable. A compiled binary has no shebang,
 * so the mode check the caller already made is the best available evidence and
 * the file is treated as runnable.
 */
export function inspectRunnability(file, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;

  if (platform === 'win32') {
    return { runnable: true, reason: null, kind: 'windows' };
  }

  const bytes = readStart(file);
  if (!bytes || bytes.length === 0 || bytes[0] !== 0x23 || bytes[1] !== 0x21) {
    return { runnable: true, reason: null, kind: 'binary' };
  }

  const line = firstLine(bytes);
  const body = line.slice(2).trim();
  const [interpreter, ...argumentParts] = body.split(/\s+/).filter(Boolean);

  if (!interpreter) {
    return {
      runnable: false,
      reason: 'the shebang line does not name an interpreter',
      kind: 'script',
      interpreter: null,
    };
  }

  if (!path.posix.isAbsolute(interpreter)) {
    return {
      runnable: false,
      reason: `shebang interpreter ${interpreter} is not an absolute path`,
      kind: 'script',
      interpreter,
    };
  }

  const check = isExecutableFile(interpreter);
  if (!check.ok) {
    return { runnable: false, reason: check.reason, kind: 'script', interpreter };
  }

  // `#!/usr/bin/env node` succeeds only when the named command is reachable.
  // Check it against the PATH of the context being diagnosed, not this
  // process, so a daemon-only miss is reported honestly.
  if (path.posix.basename(interpreter) === 'env') {
    const target = envCommand(argumentParts.join(' '));
    if (target) {
      const pathValue = options.pathValue == null ? env.PATH : options.pathValue;
      const resolvedTarget = findOnPath(target, pathValue, platform);
      if (!resolvedTarget) {
        return {
          runnable: false,
          reason: `shebang ${interpreter} cannot find ${target} on this PATH`,
          kind: 'script',
          interpreter,
          envCommand: target,
        };
      }
    }
  }

  return {
    runnable: true,
    reason: null,
    kind: 'script',
    interpreter,
    shebang: line,
  };
}
