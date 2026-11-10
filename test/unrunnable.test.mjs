import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli-path-doctor.mjs');
const isWindows = process.platform === 'win32';
const basePath = process.env.PATH || '';

function makeTemp(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    ...options,
  });
}

function fixtureEnv(root, pathValue) {
  const home = path.join(root, 'home');
  const prefix = path.join(root, 'npm-prefix');

  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    NPM_CONFIG_PREFIX: prefix,
    npm_config_prefix: prefix,
    CLI_PATH_DOCTOR_LOGIN_PATH: pathValue,
    CLI_PATH_DOCTOR_NON_LOGIN_PATH: pathValue,
    CLI_PATH_DOCTOR_DAEMON_PATH: pathValue,
    PATH: pathValue,
    CARGO_HOME: '',
    BUN_INSTALL: '',
    VOLTA_HOME: '',
    GOBIN: '',
    GOPATH: '',
    DENO_INSTALL: '',
    PNPM_HOME: '',
    ASDF_DATA_DIR: '',
    MISE_DATA_DIR: '',
    PYENV_ROOT: '',
    RBENV_ROOT: '',
  };
}

function currentContext(json) {
  const context = json.contexts.find((entry) => entry.context === 'current');
  assert.ok(context, 'expected a current context');
  return context;
}

function writeFixture(root, command, body, mode) {
  const directory = path.join(root, 'bin');
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, command);
  writeFileSync(file, body, 'utf8');
  chmodSync(file, mode);
  return { directory, file };
}

test('reports a script whose shebang interpreter is missing as broken', { skip: isWindows }, () => {
  const root = makeTemp('cli-path-doctor-broken-shebang-');
  const command = `cpd-broken-shebang-${process.pid}-${Date.now()}`;
  const fixture = writeFixture(
    root,
    command,
    '#!/nonexistent/interpreter\necho this must not run\n',
    0o755,
  );

  try {
    const env = fixtureEnv(root, [fixture.directory, basePath].join(path.delimiter));

    const text = run([command], { env });
    assert.equal(text.status, 1, text.stderr);
    assert.match(text.stdout, /current\s+BROKEN/);
    assert.match(text.stdout, /nonexistent\/interpreter/);

    const json = run([command, '--json'], { env });
    assert.equal(json.status, 1, json.stderr);
    const data = JSON.parse(json.stdout);
    const current = currentContext(data);

    assert.equal(current.status, 'broken');
    assert.equal(current.runnable, false);
    assert.match(current.unrunnableReason, /nonexistent\/interpreter/);
    assert.equal(current.path, fixture.file);
    assert.equal(data.status, 'broken');
    assert.equal(data.runnable, false);
    assert.equal(data.exitCode, 1);
    assert.equal(data.path, fixture.file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a non-executable file keeps its miss reason and gets chmod, not npm install', { skip: isWindows }, () => {
  const root = makeTemp('cli-path-doctor-noexec-fix-');
  const command = `cpd-noexec-${process.pid}-${Date.now()}`;
  const fixture = writeFixture(root, command, '#!/bin/sh\nexit 0\n', 0o644);

  try {
    const env = fixtureEnv(root, [fixture.directory, basePath].join(path.delimiter));

    const text = run([command], { env });
    assert.equal(text.status, 1, text.stderr);
    assert.match(text.stdout, /MISS .*not executable/);
    assert.match(text.stderr, /fixes:/);
    assert.ok(text.stderr.includes(`chmod +x '${fixture.file}'`), text.stderr);
    assert.ok(!/npm install -g/.test(text.stderr), text.stderr);

    const json = run([command, '--json'], { env });
    assert.equal(json.status, 1, json.stderr);
    const data = JSON.parse(json.stdout);
    const current = currentContext(data);

    assert.equal(current.status, 'miss');
    assert.equal(current.resolved, false);
    assert.equal(current.runnable, false);
    assert.match(current.reason, /not executable/);
    assert.ok(data.fixes.includes(`chmod +x '${fixture.file}'`), JSON.stringify(data.fixes));
    assert.ok(!data.fixes.some((fix) => /npm install -g/.test(fix)), JSON.stringify(data.fixes));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a normal script still reports ok and runnable', { skip: isWindows }, () => {
  const root = makeTemp('cli-path-doctor-good-script-');
  const command = `cpd-good-script-${process.pid}-${Date.now()}`;
  const fixture = writeFixture(root, command, '#!/bin/sh\nexit 0\n', 0o755);

  try {
    const env = fixtureEnv(root, [fixture.directory, basePath].join(path.delimiter));

    const text = run([command], { env });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /current\s+/);
    assert.ok(!/BROKEN/.test(text.stdout), text.stdout);

    const json = run([command, '--json'], { env });
    assert.equal(json.status, 0, json.stderr);
    const data = JSON.parse(json.stdout);
    const current = currentContext(data);

    assert.equal(current.status, 'ok');
    assert.equal(current.resolved, true);
    assert.equal(current.runnable, true);
    assert.equal(current.unrunnableReason, null);
    assert.equal(current.path, fixture.file);
    assert.equal(data.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a compiled binary is not mistaken for a broken script', { skip: isWindows }, () => {
  const root = makeTemp('cli-path-doctor-compiled-');
  const command = `cpd-compiled-${process.pid}-${Date.now()}`;
  const directory = path.join(root, 'bin');
  const fixture = path.join(directory, command);
  mkdirSync(directory, { recursive: true });
  symlinkSync(process.execPath, fixture);

  try {
    const env = fixtureEnv(root, [directory, basePath].join(path.delimiter));

    const json = run([command, '--json'], { env });
    assert.equal(json.status, 0, json.stderr);
    const data = JSON.parse(json.stdout);
    const current = currentContext(data);

    assert.equal(current.status, 'ok');
    assert.equal(current.resolved, true);
    assert.equal(current.runnable, true);
    assert.equal(current.unrunnableReason, null);
    assert.equal(current.path, fixture);
    assert.equal(data.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a shebang using env is checked against the context PATH', { skip: isWindows }, () => {
  const root = makeTemp('cli-path-doctor-env-shebang-');
  const command = `cpd-env-shebang-${process.pid}-${Date.now()}`;
  const fixture = writeFixture(root, command, '#!/usr/bin/env node\nprocess.exit(0)\n', 0o755);

  try {
    // The temporary directory is first, but a PATH that supplies node still
    // lets the script start.
    const env = fixtureEnv(
      root,
      [fixture.directory, path.dirname(process.execPath), basePath].join(path.delimiter),
    );
    const ok = run([command, '--json'], { env });
    assert.equal(ok.status, 0, ok.stderr);
    const okContext = currentContext(JSON.parse(ok.stdout));
    assert.equal(okContext.status, 'ok');
    assert.equal(okContext.runnable, true);

    // With only the fixture directory on PATH, /usr/bin/env exists but cannot
    // find node, so the command is present but cannot start.
    const isolated = fixtureEnv(root, fixture.directory);
    const broken = run([command, '--json'], { env: isolated });
    assert.equal(broken.status, 1, broken.stderr);
    const brokenContext = currentContext(JSON.parse(broken.stdout));
    assert.equal(brokenContext.status, 'broken');
    assert.equal(brokenContext.runnable, false);
    assert.match(brokenContext.unrunnableReason, /cannot find node/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
