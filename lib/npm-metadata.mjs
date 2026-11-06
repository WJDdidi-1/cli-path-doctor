import path from 'node:path';
import { commandNames, inspectFile, pathApi } from './path-resolver.mjs';

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function localBinDirectories(cwd, platform) {
  const api = pathApi(platform);
  const directories = [];
  let current = api.resolve(cwd);

  for (let depth = 0; depth < 64; depth += 1) {
    directories.push(api.join(current, 'node_modules', '.bin'));
    const parent = api.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return directories;
}

function globalBinDirectories(env, platform) {
  const api = pathApi(platform);
  const directories = [];

  const prefix = env.NPM_CONFIG_PREFIX || env.npm_config_prefix;
  if (prefix) {
    directories.push(platform === 'win32' ? prefix : api.join(prefix, 'bin'));
  }

  // The directory containing the running node binary is usually the global
  // npm bin directory on Unix (for example an nvm or Homebrew installation).
  directories.push(api.dirname(process.execPath));

  if (env.PNPM_HOME) directories.push(env.PNPM_HOME);
  if (env.VOLTA_HOME) directories.push(api.join(env.VOLTA_HOME, 'bin'));

  if (platform === 'win32') {
    const appData = env.APPDATA || env.AppData;
    if (appData) directories.push(api.join(appData, 'npm'));
    const prefixFromEnv = env.PREFIX;
    if (prefixFromEnv) directories.push(prefixFromEnv);
  }

  return unique(directories);
}

function inspectDirectory(directory, names, platform, env, source) {
  const api = pathApi(platform);
  const found = [];

  for (const name of names) {
    const candidate = api.join(directory, name);
    const inspected = inspectFile(candidate, { platform, env });
    if (!inspected.exists) continue;

    found.push({
      ...inspected,
      source,
      directory,
    });
  }

  return found;
}

const SOURCE_PRIORITY = {
  'local npm bin': 0,
  'global npm bin': 1,
};

function preferredCandidate(candidates) {
  const sorted = [...candidates].sort((left, right) => {
    const leftPriority = left.broken ? 0 : left.executable ? 2 : 1;
    const rightPriority = right.broken ? 0 : right.executable ? 2 : 1;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;

    const leftSource = SOURCE_PRIORITY[left.source] == null ? 9 : SOURCE_PRIORITY[left.source];
    const rightSource = SOURCE_PRIORITY[right.source] == null ? 9 : SOURCE_PRIORITY[right.source];
    return leftSource - rightSource;
  });

  return sorted[0] || null;
}

/**
 * Find npm-created bin entries even when they are not on any checked PATH.
 * A broken link is reported as a link: that is often the missing layer.
 */
export function inspectNpmBins(command, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const cwd = options.cwd || process.cwd();

  if (typeof command !== 'string' || command.length === 0) {
    return { candidates: [], local: [], global: [], preferred: null };
  }

  const names = commandNames(command, platform, env);

  const local = unique(localBinDirectories(cwd, platform)).flatMap((directory) =>
    inspectDirectory(directory, names, platform, env, 'local npm bin'),
  );
  const global = globalBinDirectories(env, platform).flatMap((directory) =>
    inspectDirectory(directory, names, platform, env, 'global npm bin'),
  );

  const candidates = [...local, ...global];
  return {
    candidates,
    local,
    global,
    preferred: preferredCandidate(candidates),
  };
}

/**
 * A short, copy-paste-friendly diagnosis for npm bin state, or null when there
 * is nothing npm-specific to say.
 */
export function npmHint(inspection) {
  if (!inspection || !Array.isArray(inspection.candidates) || inspection.candidates.length === 0) {
    return null;
  }

  const broken = inspection.candidates.find((candidate) => candidate.broken);
  if (broken) {
    return `broken npm bin link ${broken.path} -> ${broken.linkTarget || '?'}`;
  }

  const notExecutable = inspection.candidates.find(
    (candidate) => candidate.exists && candidate.isFile && !candidate.executable,
  );
  if (notExecutable) {
    return `npm bin ${notExecutable.path} is not executable`;
  }

  const usable = inspection.candidates.find(
    (candidate) => candidate.exists && candidate.isFile && candidate.executable,
  );
  if (usable) {
    return `npm bin exists at ${usable.path} but is not on this PATH`;
  }

  return null;
}
