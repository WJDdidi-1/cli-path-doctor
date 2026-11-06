import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli-path-doctor.mjs');
const contextNames = ['current', 'login', 'non-login', 'daemon-like'];
const isWindows = process.platform === 'win32';

function run(args, options = {}) {
  const env = options.env || process.env;
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    ...options,
    env,
  });
}

function rowsFrom(stdout) {
  return stdout
    .trimEnd()
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
}

function withStableShells(env, pathValue = env.PATH || '') {
  return {
    ...env,
    CLI_PATH_DOCTOR_LOGIN_PATH: pathValue,
    CLI_PATH_DOCTOR_NON_LOGIN_PATH: pathValue,
  };
}

function makeTemp(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function writeExecutable(file, contents) {
  writeFileSync(file, contents, 'utf8');
  chmodSync(file, 0o755);
}

test('inspects the npm global prefix and its bin directory', () => {
  const prefix = makeTemp('cli-path-doctor-prefix-');
  const command = `cli-path-doctor-global-${process.pid}-${Date.now()}`;
  const binDirectory = isWindows ? prefix : path.join(prefix, 'bin');
  const executable = path.join(binDirectory, isWindows ? `${command}.CMD` : command);

  try {
    mkdirSync(binDirectory, { recursive: true });
    writeExecutable(executable, isWindows ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n');

    const fullPath = `${binDirectory}${path.delimiter}${process.env.PATH || ''}`;
    const env = withStableShells(
      {
        ...process.env,
        NPM_CONFIG_PREFIX: prefix,
        PATH: fullPath,
      },
      fullPath,
    );

    const result = run([command, '--json'], { env });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout);

    assert.equal(data.npm.globalPrefix, prefix);
    assert.deepEqual(data.npm.prefix, { path: prefix, source: 'NPM_CONFIG_PREFIX' });
    assert.equal(data.npm.command, command);

    const candidate = data.npm.global.find((entry) => entry.path === executable);
    assert.ok(candidate, `expected ${executable} in npm.global`);
    assert.equal(candidate.source, 'global npm bin');
    assert.equal(candidate.exists, true);
    assert.equal(candidate.executable, true);
    assert.equal(candidate.symlink, false);
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});

test('inspects package bin entries, links, symlink targets and executable bits', { skip: isWindows }, () => {
  const project = makeTemp('cli-path-doctor-package-');
  const realProject = realpathSync(project);
  const command = `cli-path-doctor-package-${process.pid}-${Date.now()}`;
  const packageDirectory = path.join(realProject, 'node_modules', 'fixture-pkg');
  const binDirectory = path.join(realProject, 'node_modules', '.bin');
  const target = path.join(packageDirectory, 'cli.js');
  const link = path.join(binDirectory, command);

  try {
    mkdirSync(binDirectory, { recursive: true });
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(
      path.join(packageDirectory, 'package.json'),
      JSON.stringify({
        name: 'fixture-pkg',
        version: '1.2.3',
        bin: { [command]: 'cli.js' },
      }),
      'utf8',
    );
    writeExecutable(target, '#!/bin/sh\nexit 0\n');
    symlinkSync('../fixture-pkg/cli.js', link);

    const fullPath = `${binDirectory}${path.delimiter}${process.env.PATH || ''}`;
    const env = withStableShells({ ...process.env, PATH: fullPath }, fullPath);

    const result = run([command, '--json'], { env, cwd: project });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout);

    const pkg = data.npm.packages.find((entry) => entry.package === 'fixture-pkg');
    assert.ok(pkg, 'expected the package bin declaration to be inspected');
    assert.equal(pkg.command, command);
    assert.equal(pkg.target, target);
    assert.equal(pkg.packageJson, path.join(packageDirectory, 'package.json'));
    assert.equal(pkg.link, link);
    assert.equal(pkg.linkExists, true);
    assert.equal(pkg.linkBroken, false);
    assert.equal(pkg.linkSymlink, true);
    assert.equal(pkg.linkTarget, '../fixture-pkg/cli.js');
    assert.equal(pkg.exists, true);
    assert.equal(pkg.executable, true);

    const localCandidate = data.npm.local.find((entry) => entry.path === link);
    assert.ok(localCandidate, 'expected node_modules/.bin to be inspected');
    assert.equal(localCandidate.symlink, true);
    assert.equal(localCandidate.linkTarget, '../fixture-pkg/cli.js');
    assert.equal(localCandidate.realPath, realpathSync(target));

    chmodSync(target, 0o644);
    const brokenBits = run([command, '--json'], { env, cwd: project });
    assert.equal(brokenBits.status, 1);
    const notExecutable = JSON.parse(brokenBits.stdout);
    assert.equal(notExecutable.npm.packages[0].executable, false);
    assert.match(notExecutable.npm.hint, /not executable/i);
    assert.ok(
      notExecutable.fixes.some((fix) => fix.includes('chmod +x') && fix.includes(target)),
      `expected a chmod fix for ${target}: ${JSON.stringify(notExecutable.fixes)}`,
    );

    const text = run([command], { env, cwd: project });
    assert.equal(text.status, 1);
    assert.match(text.stderr, /fixes:/);
    assert.match(text.stderr, /chmod \+x/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('reads package.json bin entries even when the bin link is missing', () => {
  const project = makeTemp('cli-path-doctor-missing-target-');
  const realProject = realpathSync(project);
  const command = `cli-path-doctor-missing-${process.pid}-${Date.now()}`;
  const packageDirectory = path.join(realProject, 'node_modules', 'fixture-pkg');

  try {
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(
      path.join(packageDirectory, 'package.json'),
      JSON.stringify({
        name: 'fixture-pkg',
        version: '1.2.3',
        bin: { [command]: './bin/missing.js' },
      }),
      'utf8',
    );

    const env = withStableShells({ ...process.env });
    const result = run([command, '--json'], { env, cwd: project });
    assert.equal(result.status, 1);
    const data = JSON.parse(result.stdout);

    const pkg = data.npm.packages.find((entry) => entry.package === 'fixture-pkg');
    assert.ok(pkg, 'expected the missing package bin to be inspected');
    assert.equal(path.relative(realProject, pkg.target), path.join('node_modules', 'fixture-pkg', 'bin', 'missing.js'));
    assert.equal(pkg.exists, false);
    assert.equal(pkg.linkExists, false);
    assert.match(data.npm.hint, /target file is missing/i);
    assert.ok(
      data.npm.fixes.some((fix) => fix.includes('npm install')),
      `expected an npm install fix: ${JSON.stringify(data.npm.fixes)}`,
    );

    const text = run([command], { env, cwd: project });
    assert.equal(text.status, 1);
    assert.equal(rowsFrom(text.stdout).length, contextNames.length);
    assert.match(text.stderr, /fixes:/);
    assert.match(text.stderr, /npm install/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('names the first login-only PATH directory and emits a copy-paste fix', () => {
  const first = path.join(tmpdir(), `cli-path-doctor-login-first-${process.pid}`);
  const second = path.join(tmpdir(), `cli-path-doctor-login-second-${process.pid}`);
  const shared = path.join(tmpdir(), `cli-path-doctor-shared-${process.pid}`);
  const loginPath = [first, second, shared].join(path.delimiter);
  const daemonPath = shared;
  const env = {
    ...process.env,
    CLI_PATH_DOCTOR_LOGIN_PATH: loginPath,
    CLI_PATH_DOCTOR_NON_LOGIN_PATH: loginPath,
    CLI_PATH_DOCTOR_DAEMON_PATH: daemonPath,
  };

  const result = run(['cli-path-doctor-no-such-command-42', '--json'], { env });
  assert.equal(result.status, 1);
  const data = JSON.parse(result.stdout);
  assert.equal(data.loginOnlyDirectory, first);
  assert.ok(
    data.fixes.some((fix) => /export PATH=|env:Path/.test(fix) && fix.includes(first)),
    `expected a PATH fix for ${first}: ${JSON.stringify(data.fixes)}`,
  );

  const text = run(['cli-path-doctor-no-such-command-42'], { env });
  assert.equal(text.status, 1);
  assert.equal(rowsFrom(text.stdout).length, contextNames.length);
  assert.ok(text.stdout.includes(first), `expected ${first} in the daemon row: ${text.stdout}`);
  assert.match(text.stderr, /first login-only PATH directory:/);
  assert.ok(text.stderr.includes(first), text.stderr);

  const same = run(['cli-path-doctor-no-such-command-42', '--json'], {
    env: {
      ...env,
      CLI_PATH_DOCTOR_LOGIN_PATH: daemonPath,
    },
  });
  assert.equal(JSON.parse(same.stdout).loginOnlyDirectory, null);
});

test('prints copy-paste npm PATH fixes to stderr while stdout stays one row per context', () => {
  const prefix = makeTemp('cli-path-doctor-fixes-');
  const command = `cli-path-doctor-fixes-${process.pid}-${Date.now()}`;
  const binDirectory = isWindows ? prefix : path.join(prefix, 'bin');
  const executable = path.join(binDirectory, isWindows ? `${command}.CMD` : command);

  try {
    mkdirSync(binDirectory, { recursive: true });
    writeExecutable(executable, isWindows ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n');

    const env = withStableShells({
      ...process.env,
      NPM_CONFIG_PREFIX: prefix,
    });

    const result = run([command], { env });
    assert.equal(result.status, 1);
    assert.equal(rowsFrom(result.stdout).length, contextNames.length);
    assert.match(result.stderr, /fixes:/);
    assert.match(result.stderr, /export PATH=|env:Path/);
    assert.ok(result.stderr.includes(binDirectory), result.stderr);

    const json = run([command, '--json'], { env });
    assert.equal(json.status, 1);
    const data = JSON.parse(json.stdout);
    assert.ok(Array.isArray(data.fixes) && data.fixes.length > 0);
    assert.ok(data.fixes.some((fix) => fix.includes(binDirectory)));
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});

test('runs fully offline and still returns machine-readable output', () => {
  const noNetwork = 'http://127.0.0.1:9';
  const fullPath = process.env.PATH || '';
  const env = withStableShells(
    {
      ...process.env,
      HTTP_PROXY: noNetwork,
      HTTPS_PROXY: noNetwork,
      ALL_PROXY: noNetwork,
      npm_config_registry: noNetwork,
      NPM_CONFIG_REGISTRY: noNetwork,
    },
    fullPath,
  );

  const result = run(['cli-path-doctor-no-such-command-42', '--json'], { env });
  assert.equal(result.status, 1, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.command, 'cli-path-doctor-no-such-command-42');
  assert.equal(data.resolved, false);
  assert.equal(data.contexts.length, contextNames.length);
  assert.ok(
    typeof data.npm.globalPrefix === 'string' && data.npm.globalPrefix.length > 0,
    `expected a global prefix: ${JSON.stringify(data.npm)}`,
  );
});
