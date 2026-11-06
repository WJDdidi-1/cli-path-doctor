import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathDelimiter } from './path-resolver.mjs';

export const CONTEXT_NAMES = ['current', 'login', 'non-login', 'daemon-like'];

const PATH_START = '__CLI_PATH_DOCTOR_PATH__';
const PATH_END = '__CLI_PATH_DOCTOR_END__';
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * A conservative PATH of the kind a launchd/systemd/CI daemon starts with.
 * Anything installed under a user's home or version-manager directory is
 * intentionally absent: that is exactly the failure this tool explains.
 */
export function defaultDaemonPath(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const root = env.SystemRoot || env.windir || 'C:\\Windows';
    const api = path.win32;
    return [
      api.join(root, 'System32'),
      root,
      api.join(root, 'System32', 'Wbem'),
      api.join(root, 'System32', 'WindowsPowerShell', 'v1.0'),
    ].join(';');
  }

  return ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'].join(':');
}

function isUsableShell(candidate) {
  if (!candidate || typeof candidate !== 'string') return false;

  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function resolveShell(env = process.env, platform = process.platform) {
  if (platform === 'win32') return env.ComSpec || env.COMSPEC || null;

  const configured = env.CLI_PATH_DOCTOR_SHELL || env.SHELL;
  if (isUsableShell(configured)) return configured;

  for (const fallback of ['/bin/sh', '/usr/bin/sh', '/bin/bash']) {
    if (isUsableShell(fallback)) return fallback;
  }

  return null;
}

function probeShellPath(shell, login, env, timeout) {
  if (!shell) {
    return { ok: false, reason: 'no usable shell found' };
  }

  // The sentinel lets us ignore anything a noisy shell profile prints.
  const script = `printf '%s%s%s' '${PATH_START}' "$PATH" '${PATH_END}'`;

  // A login shell reads the login startup files; a non-login shell does not.
  // We deliberately avoid forcing an interactive shell: that would run the
  // user's .zshrc/.bashrc on every diagnosis and can print prompts, start
  // background jobs, or hang.
  const variants = login
    ? [['-l', '-c', script], ['-c', script]]
    : [['-c', script]];

  const perVariantTimeout = Math.max(500, Math.floor(Math.max(1, timeout) / variants.length));
  const failures = [];
  for (const args of variants) {
    let result;
    try {
      result = spawnSync(shell, args, {
        encoding: 'utf8',
        env,
        timeout: perVariantTimeout,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      failures.push(error && error.message ? error.message : 'could not start shell');
      continue;
    }

    const stdout = result && result.stdout ? String(result.stdout) : '';
    const start = stdout.lastIndexOf(PATH_START);
    if (start !== -1) {
      const end = stdout.indexOf(PATH_END, start + PATH_START.length);
      if (end !== -1) {
        return {
          ok: true,
          pathValue: stdout.slice(start + PATH_START.length, end),
          args,
        };
      }
    }

    if (result && result.error) {
      failures.push(result.error.message);
    } else if (result && typeof result.status === 'number' && result.status !== 0) {
      failures.push(`shell exited with status ${result.status}`);
    } else {
      failures.push('shell did not report PATH');
    }
  }

  return { ok: false, reason: failures[failures.length - 1] || 'shell probe failed' };
}

function context(name, pathValue, source, note) {
  return {
    name,
    pathValue,
    source,
    note: note || null,
  };
}

/**
 * Build the four PATH environments we diagnose. Shell probing is best-effort:
 * if a login shell cannot be started we fall back to the current PATH and keep
 * the row, rather than hiding the context from the user.
 */
export function buildContexts(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const timeout = options.timeout == null ? DEFAULT_TIMEOUT_MS : options.timeout;
  const currentPath = env.PATH == null ? '' : String(env.PATH);

  const contexts = [
    context('current', currentPath, 'this process (process.env.PATH)'),
  ];

  if (platform === 'win32') {
    // Windows has no portable login/non-login shell PATH convention. Keep the
    // rows, but use the process PATH unless the caller supplied an override.
    const loginOverride = env.CLI_PATH_DOCTOR_LOGIN_PATH;
    const nonLoginOverride = env.CLI_PATH_DOCTOR_NON_LOGIN_PATH;
    contexts.push(
      context(
        'login',
        loginOverride == null ? currentPath : String(loginOverride),
        loginOverride == null ? 'Windows process PATH (no portable login shell)' : 'CLI_PATH_DOCTOR_LOGIN_PATH',
      ),
    );
    contexts.push(
      context(
        'non-login',
        nonLoginOverride == null ? currentPath : String(nonLoginOverride),
        nonLoginOverride == null ? 'Windows process PATH (no portable non-login shell)' : 'CLI_PATH_DOCTOR_NON_LOGIN_PATH',
      ),
    );
  } else {
    const shell = resolveShell(env, platform);
    const loginOverride = env.CLI_PATH_DOCTOR_LOGIN_PATH;
    const nonLoginOverride = env.CLI_PATH_DOCTOR_NON_LOGIN_PATH;

    if (loginOverride != null) {
      contexts.push(context('login', String(loginOverride), 'CLI_PATH_DOCTOR_LOGIN_PATH'));
    } else {
      const login = probeShellPath(shell, true, env, timeout);
      contexts.push(
        login.ok
          ? context('login', login.pathValue, `${shell} ${login.args.slice(0, -1).join(' ')}`)
          : context('login', currentPath, 'this process (login shell probe failed)', login.reason),
      );
    }

    if (nonLoginOverride != null) {
      contexts.push(context('non-login', String(nonLoginOverride), 'CLI_PATH_DOCTOR_NON_LOGIN_PATH'));
    } else {
      const nonLogin = probeShellPath(shell, false, env, timeout);
      contexts.push(
        nonLogin.ok
          ? context('non-login', nonLogin.pathValue, `${shell} ${nonLogin.args.slice(0, -1).join(' ')}`)
          : context('non-login', currentPath, 'this process (non-login shell probe failed)', nonLogin.reason),
      );
    }
  }

  const daemonOverride = env.CLI_PATH_DOCTOR_DAEMON_PATH;
  contexts.push(
    context(
      'daemon-like',
      daemonOverride == null ? defaultDaemonPath(platform, env) : String(daemonOverride),
      daemonOverride == null ? 'minimal system PATH (daemon/CI-like)' : 'CLI_PATH_DOCTOR_DAEMON_PATH',
    ),
  );

  return contexts;
}

/**
 * Return the first login-shell PATH directory that a daemon-like environment
 * does not have. Useful for naming the layer that broke.
 */
export function firstLoginOnlyDirectory(loginPath, daemonPath, platform = process.platform) {
  const delimiter = pathDelimiter(platform);
  const daemonDirectories = new Set(
    String(daemonPath == null ? '' : daemonPath)
      .split(delimiter)
      .filter(Boolean),
  );

  return String(loginPath == null ? '' : loginPath)
    .split(delimiter)
    .filter(Boolean)
    .find((directory) => !daemonDirectories.has(directory)) || null;
}
