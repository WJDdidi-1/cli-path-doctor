import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { commandNames, inspectFile, pathApi, splitPathValue } from './path-resolver.mjs';
import { formatPathFix } from './shell-rc.mjs';

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function quote(value, platform = process.platform) {
  const text = String(value);
  if (platform === 'win32') {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function pathFix(directory, options = {}) {
  return formatPathFix(directory, options);
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

/**
 * The npm global prefix is the directory npm installs global packages under.
 * Prefer npm's own environment overrides, then the platform default. Deriving
 * it from the running node binary keeps the check local and offline (nvm,
 * Homebrew, /usr/local and Windows' APPDATA/npm all follow this layout).
 */
export function resolveGlobalPrefix(env = process.env, platform = process.platform, execPath = process.execPath) {
  const configured = env && (env.NPM_CONFIG_PREFIX || env.npm_config_prefix);
  if (configured) {
    return { path: String(configured), source: 'NPM_CONFIG_PREFIX' };
  }

  const api = pathApi(platform);
  if (platform === 'win32') {
    const appData = env && (env.APPDATA || env.AppData);
    if (appData) return { path: api.join(appData, 'npm'), source: 'APPDATA' };
    if (env && env.PREFIX) return { path: String(env.PREFIX), source: 'PREFIX' };
  }

  if (!execPath) return null;

  const nodeDirectory = api.dirname(execPath);
  const prefix = api.basename(nodeDirectory) === 'bin'
    ? api.dirname(nodeDirectory)
    : nodeDirectory;

  return { path: prefix, source: 'node binary location' };
}

function npmConfiguredPrefix(env, platform, timeout = 3000) {
  const api = pathApi(platform);
  if (!env) return null;

  let result;
  try {
    result = spawnSync(
      platform === 'win32' ? 'npm.cmd' : 'npm',
      ['prefix', '-g', '--offline'],
      {
        encoding: 'utf8',
        env: {
          ...env,
          npm_config_offline: 'true',
          npm_config_update_notifier: 'false',
          npm_config_audit: 'false',
          npm_config_fund: 'false',
          NO_UPDATE_NOTIFIER: '1',
        },
        timeout,
        windowsHide: true,
        shell: platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch {
    return null;
  }

  if (!result || result.error || result.status !== 0) return null;

  const lines = String(result.stdout || '')
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const candidate = lines.length > 0 ? lines[lines.length - 1] : '';
  if (!candidate || !api.isAbsolute(candidate)) return null;

  return { path: candidate, source: 'npm prefix -g' };
}

/**
 * Ask npm for its global prefix when it is available (Homebrew and other
 * distributions relocate it), then fall back to an offline derivation.
 */
export function discoverGlobalPrefix(env = process.env, platform = process.platform, execPath = process.execPath) {
  const fallback = resolveGlobalPrefix(env, platform, execPath);
  if (fallback && fallback.source === 'NPM_CONFIG_PREFIX') return fallback;

  return npmConfiguredPrefix(env, platform) || fallback;
}

function globalBinDirectories(env, platform, globalPrefix, execPath) {
  const api = pathApi(platform);
  const directories = [];

  if (globalPrefix && globalPrefix.path) {
    directories.push(
      platform === 'win32'
        ? globalPrefix.path
        : api.join(globalPrefix.path, 'bin'),
    );
  }

  // The directory containing the running node binary is usually the global
  // npm bin directory on Unix (for example an nvm or Homebrew installation).
  if (execPath) directories.push(api.dirname(execPath));

  if (env && env.PNPM_HOME) directories.push(env.PNPM_HOME);
  if (env && env.VOLTA_HOME) directories.push(api.join(env.VOLTA_HOME, 'bin'));

  if (platform === 'win32') {
    const appData = env && (env.APPDATA || env.AppData);
    if (appData) directories.push(api.join(appData, 'npm'));
    if (env && env.PREFIX) directories.push(env.PREFIX);
    if (env && env.PNPM_HOME) directories.push(env.PNPM_HOME);
  }

  return unique(directories);
}

function inspectDirectory(directory, names, platform, env, source) {
  const api = pathApi(platform);
  const found = [];

  for (const name of names) {
    const candidate = api.join(directory, name);
    const inspected = inspectFile(candidate, { platform, env });
    if (!inspected.exists && !inspected.broken) continue;

    found.push({
      ...inspected,
      source,
      directory,
    });
  }

  return found;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function packageBinEntries(pkg) {
  if (!pkg || typeof pkg !== 'object') return [];

  if (typeof pkg.bin === 'string' && pkg.bin.length > 0) {
    const name = typeof pkg.name === 'string' ? pkg.name.split('/').pop() : null;
    return name ? [{ name, target: pkg.bin }] : [];
  }

  if (pkg.bin && typeof pkg.bin === 'object' && !Array.isArray(pkg.bin)) {
    return Object.entries(pkg.bin)
      .filter(([name, target]) => typeof name === 'string' && name.length > 0 && typeof target === 'string')
      .map(([name, target]) => ({ name, target }));
  }

  return [];
}

function packageDirectories(nodeModulesDirectory) {
  let entries;
  try {
    entries = fs.readdirSync(nodeModulesDirectory, { withFileTypes: true });
  } catch {
    return [];
  }

  const directories = [];
  for (const entry of entries) {
    if (entry.name === '.bin' || entry.name === '.package-lock.json' || entry.name.startsWith('.')) {
      continue;
    }

    const entryPath = path.join(nodeModulesDirectory, entry.name);
    if (entry.name.startsWith('@')) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

      let scoped;
      try {
        scoped = fs.readdirSync(entryPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const child of scoped) {
        if (!child.isDirectory() && !child.isSymbolicLink()) continue;
        directories.push({ directory: path.join(entryPath, child.name), nodeModulesDirectory });
      }
      continue;
    }

    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    directories.push({ directory: entryPath, nodeModulesDirectory });
  }

  return directories;
}

function localNodeModulesDirectories(cwd, platform) {
  const api = pathApi(platform);
  const directories = [];
  let current = api.resolve(cwd);

  for (let depth = 0; depth < 64; depth += 1) {
    directories.push(api.join(current, 'node_modules'));
    const parent = api.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return unique(directories);
}

function linkForPackage(binDirectory, binName, platform, env) {
  const api = pathApi(platform);
  const names = commandNames(binName, platform, env);

  for (const name of names) {
    const candidate = api.join(binDirectory, name);
    const inspected = inspectFile(candidate, { platform, env });
    if (inspected.exists || inspected.broken) {
      return { link: candidate, inspected };
    }
  }

  const fallback = api.join(binDirectory, binName);
  return {
    link: fallback,
    inspected: inspectFile(fallback, { platform, env }),
  };
}

function inspectPackage(pkg, pkgDirectory, nodeModulesDirectory, names, platform, env, source, options = {}) {
  const api = pathApi(platform);
  const projectDirectory = options.projectDirectory
    || (nodeModulesDirectory ? api.dirname(nodeModulesDirectory) : pkgDirectory);
  const binDirectory = options.binDirectory
    || api.join(nodeModulesDirectory || api.join(pkgDirectory, 'node_modules'), '.bin');
  const commandSet = new Set(names);

  return packageBinEntries(pkg)
    .filter((entry) => commandSet.has(entry.name))
    .map((entry) => {
      const target = api.resolve(pkgDirectory, entry.target);
      const targetInspection = inspectFile(target, { platform, env });
      const link = linkForPackage(binDirectory, entry.name, platform, env);

      return {
        package: pkg.name || api.basename(pkgDirectory),
        version: pkg.version || null,
        packageJson: api.join(pkgDirectory, 'package.json'),
        packageDirectory: pkgDirectory,
        projectDirectory,
        source,
        command: entry.name,
        target,
        targetRelative: entry.target,
        link: link.link,
        linkExists: Boolean(link.inspected.exists),
        linkBroken: Boolean(link.inspected.broken),
        linkSymlink: Boolean(link.inspected.symlink),
        linkTarget: link.inspected.linkTarget || null,
        exists: Boolean(targetInspection.exists),
        broken: Boolean(targetInspection.broken),
        executable: Boolean(targetInspection.executable),
        isFile: Boolean(targetInspection.isFile),
        isDirectory: Boolean(targetInspection.isDirectory),
        symlink: Boolean(targetInspection.symlink),
        realPath: targetInspection.realPath || null,
        mode: targetInspection.mode,
        error: targetInspection.error || null,
      };
    });
}

/**
 * npm keeps global packages under <prefix>/lib/node_modules on POSIX and
 * <prefix>/node_modules on Windows. Their bin links live directly in
 * <prefix>/bin and <prefix>, not in node_modules/.bin.
 */
function globalNodeModulesDirectory(globalPrefix, platform) {
  if (!globalPrefix || !globalPrefix.path) return null;

  const api = pathApi(platform);
  return platform === 'win32'
    ? api.join(globalPrefix.path, 'node_modules')
    : api.join(globalPrefix.path, 'lib', 'node_modules');
}

function globalBinDirectory(globalPrefix, platform) {
  if (!globalPrefix || !globalPrefix.path) return null;

  const api = pathApi(platform);
  return platform === 'win32'
    ? api.resolve(globalPrefix.path)
    : api.join(globalPrefix.path, 'bin');
}

/**
 * Read package.json `bin` declarations, including packages whose
 * node_modules/.bin (or global prefix bin) link has not been created yet.
 * Globally installed packages are inspected too: when their bin target is
 * missing npm may create no link at all, leaving only 'command not found'.
 */
export function inspectPackageBins(command, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const cwd = options.cwd || process.cwd();
  const names = commandNames(command, platform, env);
  const api = pathApi(platform);

  if (typeof command !== 'string' || command.length === 0) return [];

  const packages = [];
  const seen = new Set();
  const add = (pkg, pkgDirectory, nodeModulesDirectory, source, details = {}) => {
    for (const inspected of inspectPackage(
      pkg,
      pkgDirectory,
      nodeModulesDirectory,
      names,
      platform,
      env,
      source,
      details,
    )) {
      const key = `${inspected.packageJson}\u0000${inspected.command}`;
      if (seen.has(key)) continue;
      seen.add(key);
      packages.push(inspected);
    }
  };

  const projectPackageJson = api.join(api.resolve(cwd), 'package.json');
  const projectPackage = readJsonFile(projectPackageJson);
  if (projectPackage) {
    add(projectPackage, api.resolve(cwd), api.join(api.resolve(cwd), 'node_modules'), 'project package');
  }

  for (const nodeModulesDirectory of localNodeModulesDirectories(cwd, platform)) {
    for (const entry of packageDirectories(nodeModulesDirectory)) {
      const packageJsonPath = api.join(entry.directory, 'package.json');
      const pkg = readJsonFile(packageJsonPath);
      if (pkg) add(pkg, entry.directory, entry.nodeModulesDirectory, 'local package');
    }
  }

  const globalPrefix = options.globalPrefix
    || discoverGlobalPrefix(env, platform, options.execPath || process.execPath);
  const globalNodeModules = globalNodeModulesDirectory(globalPrefix, platform);
  if (globalNodeModules) {
    for (const entry of packageDirectories(globalNodeModules)) {
      const packageJsonPath = api.join(entry.directory, 'package.json');
      const pkg = readJsonFile(packageJsonPath);
      if (pkg) {
        add(pkg, entry.directory, globalNodeModules, 'global package', {
          projectDirectory: globalPrefix.path,
          binDirectory: globalBinDirectory(globalPrefix, platform),
        });
      }
    }
  }

  return packages;
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

function uniqueCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.path)) return false;
    seen.add(candidate.path);
    return true;
  });
}

function addFix(fixes, value) {
  if (value && !fixes.includes(value)) fixes.push(value);
}

function directoryKey(directory, platform) {
  const api = pathApi(platform);
  const normalized = api.normalize(directory);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function directoryOnPath(directory, pathValues, platform) {
  if (!Array.isArray(pathValues)) return false;
  const key = directoryKey(directory, platform);

  return pathValues.some((pathValue) => splitPathValue(pathValue, platform)
    .map((entry) => (entry === '' ? '.' : entry))
    .some((entry) => directoryKey(entry, platform) === key));
}

function localProjectForLink(link, platform) {
  const api = pathApi(platform);
  const binDirectory = api.dirname(link);
  if (api.basename(binDirectory) !== '.bin') return null;

  const nodeModulesDirectory = api.dirname(binDirectory);
  if (api.basename(nodeModulesDirectory) !== 'node_modules') return null;

  return api.dirname(nodeModulesDirectory);
}

/**
 * Copy-paste commands that address the npm layer. The list is intentionally
 * conservative: it only suggests commands for states the inspection proved.
 */
export function npmFixes(inspection, platform = process.platform, options = {}) {
  const fixes = [];
  if (!inspection) return fixes;
  const fixOptions = { ...options, platform };

  for (const pkg of inspection.packages || []) {
    const isGlobal = pkg.source === 'global package';
    const packageSpec = quote(pkg.package, platform);

    if (pkg.broken || !pkg.exists) {
      addFix(
        fixes,
        isGlobal
          ? `npm install -g ${packageSpec}`
          : `(cd ${quote(pkg.projectDirectory, platform)} && npm install)`,
      );
      if (pkg.linkBroken) addFix(fixes, `rm -f ${quote(pkg.link, platform)}`);
    } else if (pkg.isFile && !pkg.executable && platform !== 'win32') {
      addFix(fixes, `chmod +x ${quote(pkg.target, platform)}`);
    }

    if (!pkg.linkExists && pkg.exists) {
      addFix(
        fixes,
        isGlobal
          ? `npm rebuild -g ${packageSpec}`
          : `(cd ${quote(pkg.projectDirectory, platform)} && npm install)`,
      );
    }
  }

  const globalPackage = (inspection.packages || []).find(
    (pkg) => pkg.source === 'global package' && pkg.command === inspection.command,
  );

  for (const candidate of inspection.candidates || []) {
    if (candidate.broken) {
      addFix(fixes, `rm -f ${quote(candidate.path, platform)}`);
      const projectDirectory = candidate.source === 'local npm bin'
        ? localProjectForLink(candidate.path, platform)
        : null;
      if (projectDirectory) {
        addFix(fixes, `(cd ${quote(projectDirectory, platform)} && npm install)`);
      } else {
        const spec = globalPackage ? globalPackage.package : inspection.command || candidate.path;
        addFix(fixes, `npm install -g ${quote(spec, platform)}`);
      }
      continue;
    }

    if (candidate.exists && candidate.isFile && !candidate.executable && platform !== 'win32') {
      addFix(fixes, `chmod +x ${quote(candidate.path, platform)}`);
      continue;
    }

    if (candidate.exists && candidate.isFile && candidate.executable) {
      const directory = candidate.directory || pathApi(platform).dirname(candidate.path);
      // A directory that this context already searches cannot be repaired by
      // exporting it again; that is noise, not a fix.
      if (!directoryOnPath(directory, options.pathValues, platform)) {
        addFix(fixes, pathFix(directory, fixOptions));
      }
    }
  }

  return fixes;
}

/**
 * Find npm-created bin entries even when they are not on any checked PATH.
 * A broken link or a package.json bin target that is missing is reported:
 * that is often the missing layer.
 */
export function inspectNpmBins(command, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const cwd = options.cwd || process.cwd();

  if (typeof command !== 'string' || command.length === 0) {
    return {
      command: null,
      platform,
      prefix: null,
      globalPrefix: null,
      candidates: [],
      local: [],
      global: [],
      packages: [],
      preferred: null,
      fixes: [],
    };
  }

  const names = commandNames(command, platform, env);
  const execPath = options.execPath || process.execPath;
  const globalPrefix = options.globalPrefix || discoverGlobalPrefix(env, platform, execPath);

  const local = unique(localBinDirectories(cwd, platform)).flatMap((directory) =>
    inspectDirectory(directory, names, platform, env, 'local npm bin'),
  );
  const global = globalBinDirectories(env, platform, globalPrefix, execPath).flatMap((directory) =>
    inspectDirectory(directory, names, platform, env, 'global npm bin'),
  );

  const candidates = uniqueCandidates([...local, ...global]);
  const packages = inspectPackageBins(command, { env, platform, cwd, globalPrefix, execPath });
  const inspection = {
    command,
    platform,
    prefix: globalPrefix,
    globalPrefix: globalPrefix ? globalPrefix.path : null,
    candidates,
    local,
    global,
    packages,
    preferred: preferredCandidate(candidates),
  };

  inspection.fixes = npmFixes(inspection, platform, {
    shell: options.shell,
    rcFile: options.rcFile,
    pathValues: options.pathValues,
  });
  return inspection;
}

function packageLabel(pkg) {
  return pkg && pkg.source === 'global package'
    ? 'globally installed package'
    : 'package';
}

function packageHint(packages) {
  const brokenTarget = packages.find((pkg) => pkg.broken || !pkg.exists);
  if (brokenTarget) {
    const linkState = brokenTarget.linkBroken
      ? `; broken npm bin link ${brokenTarget.link} -> ${brokenTarget.linkTarget || '?'}`
      : brokenTarget.linkExists
        ? ''
        : `; npm bin link ${brokenTarget.link} is missing`;
    return `${packageLabel(brokenTarget)} ${brokenTarget.package} declares bin ${brokenTarget.command} -> ${brokenTarget.target} but the target file is missing${linkState}`;
  }

  const notExecutable = packages.find(
    (pkg) => pkg.exists && pkg.isFile && !pkg.executable,
  );
  if (notExecutable) {
    return `${packageLabel(notExecutable)} ${notExecutable.package} declares bin ${notExecutable.command} -> ${notExecutable.target} but it is not executable`;
  }

  const unlinked = packages.find(
    (pkg) => pkg.exists && pkg.isFile && pkg.executable && !pkg.linkExists,
  );
  if (unlinked) {
    return `${packageLabel(unlinked)} ${unlinked.package} declares bin ${unlinked.command} -> ${unlinked.target} but the npm bin link ${unlinked.link} is missing`;
  }

  return null;
}

/**
 * A short, copy-paste-friendly diagnosis for npm bin state, or null when there
 * is nothing npm-specific to say.
 */
export function npmHint(inspection, options = {}) {
  if (!inspection) return null;

  const packages = Array.isArray(inspection.packages) ? inspection.packages : [];
  const packageProblem = packageHint(packages);
  if (packageProblem) return packageProblem;

  if (!Array.isArray(inspection.candidates) || inspection.candidates.length === 0) {
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
    const platform = inspection.platform || process.platform;
    const directory = usable.directory || pathApi(platform).dirname(usable.path);
    const pathValues = Array.isArray(options.pathValues) ? options.pathValues : null;
    const directoryIsOnPath = pathValues
      ? pathValues.some((pathValue) => splitPathValue(pathValue, platform)
        .map((entry) => (entry === '' ? '.' : entry))
        .includes(directory))
      : false;

    if (!directoryIsOnPath) {
      return `npm bin exists at ${usable.path} but is not on this PATH`;
    }
  }

  return null;
}
