import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli-path-doctor.mjs');
const isWindows = process.platform === 'win32';
const basePath = process.env.PATH || '';
const MISSING_INTERPRETER = '/nonexistent/interp';

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

function writeFixture(root, command, body, mode) {
  const directory = path.join(root, 'bin');
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, command);
  writeFileSync(file, body, 'utf8');
  chmodSync(file, mode);
  return { directory, file };
}

function currentContext(json) {
  const context = json.contexts.find((entry) => entry.context === 'current');
  assert.ok(context, 'expected a current context');
  return context;
}

test('--fix names the missing shebang interpreter instead of refusing', { skip: isWindows }, () => {
  const root = makeTemp('cli-path-doctor-broken-repair-');
  const home = path.join(root, 'home');
  const command = `cpd-broken-repair-${process.pid}-${Date.now()}`;
  const fixture = writeFixture(
    root,
    command,
    `#!${MISSING_INTERPRETER}\necho this must not run\n`,
    0o755,
  );

  try {
    mkdirSync(home, { recursive: true });
    const env = fixtureEnv(root, [fixture.directory, basePath].join(path.delimiter));

    const text = run([command, '--fix'], { env });
    assert.equal(text.status, 1, text.stderr);
    assert.match(text.stdout, /current\s+BROKEN/);
    assert.ok(text.stderr.includes(MISSING_INTERPRETER), text.stderr);
    assert.match(text.stderr, /fixes:/);
    assert.ok(!/nothing to fix/.test(text.stderr), text.stderr);
    assert.ok(!/cannot apply PATH fix/.test(text.stderr), text.stderr);

    const json = run([command, '--fix', '--json'], { env });
    assert.equal(json.status, 1, json.stderr);
    const data = JSON.parse(json.stdout);
    const current = currentContext(data);

    assert.equal(data.status, 'broken');
    assert.equal(data.runnable, false);
    assert.equal(current.runnable, false);
    assert.equal(current.interpreter, MISSING_INTERPRETER);
    assert.ok(Array.isArray(data.fixes) && data.fixes.length > 0, JSON.stringify(data.fixes));
    assert.ok(
      data.fixes.some((fix) => fix.includes(MISSING_INTERPRETER)),
      JSON.stringify(data.fixes),
    );
    assert.equal(data.fix.applied, false, JSON.stringify(data.fix));
    assert.equal(data.fix.manual, true, JSON.stringify(data.fix));
    assert.ok(
      data.fix.reason.includes(MISSING_INTERPRETER),
      JSON.stringify(data.fix),
    );
    assert.ok(!/nothing to fix/.test(data.fix.reason), JSON.stringify(data.fix));
    assert.ok(!/nothing to fix/.test(text.stderr), text.stderr);

    // There is no PATH directory to append: --fix must not create a startup
    // file just because the command is broken.
    assert.deepEqual(readdirSync(home), []);
    assert.ok(!existsSync(path.join(home, '.profile')), 'did not expect a startup file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--fix names the owning npm global package for a broken global command', { skip: isWindows }, () => {
  const root = makeTemp('cli-path-doctor-broken-global-');
  const home = path.join(root, 'home');
  const prefix = path.join(root, 'prefix');
  const packageName = 'broken-global-repair-fixture';
  const command = `cpd-broken-global-${process.pid}-${Date.now()}`;
  const packageDirectory = path.join(prefix, 'lib', 'node_modules', packageName);
  const target = path.join(packageDirectory, 'bin', 'cli.js');
  const prefixBin = path.join(prefix, 'bin');
  const link = path.join(prefixBin, command);

  try {
    mkdirSync(path.join(packageDirectory, 'bin'), { recursive: true });
    mkdirSync(prefixBin, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      path.join(packageDirectory, 'package.json'),
      JSON.stringify({
        name: packageName,
        version: '1.0.0',
        bin: { [command]: 'bin/cli.js' },
      }),
      'utf8',
    );
    writeFileSync(target, `#!${MISSING_INTERPRETER}\nprocess.exit(0)\n`, 'utf8');
    chmodSync(target, 0o755);
    symlinkSync(target, link);

    const env = fixtureEnv(root, [prefixBin, basePath].join(path.delimiter));
    env.NPM_CONFIG_PREFIX = prefix;
    env.npm_config_prefix = prefix;

    const json = run([command, '--fix', '--json'], { env });
    assert.equal(json.status, 1, json.stderr);
    const data = JSON.parse(json.stdout);

    assert.equal(data.status, 'broken');
    assert.equal(data.runnable, false);
    assert.ok(
      data.fixes.some((fix) => fix.includes(MISSING_INTERPRETER)),
      JSON.stringify(data.fixes),
    );
    assert.ok(
      data.fixes.includes(`npm install -g '${packageName}'`),
      `expected the owning global package in ${JSON.stringify(data.fixes)}`,
    );
    assert.ok(
      data.fix.reason.includes(MISSING_INTERPRETER),
      JSON.stringify(data.fix),
    );
    assert.ok(!/nothing to fix/.test(data.fix.reason), JSON.stringify(data.fix));

    const text = run([command, '--fix'], { env });
    assert.equal(text.status, 1, text.stderr);
    assert.ok(text.stderr.includes(MISSING_INTERPRETER), text.stderr);
    assert.ok(text.stderr.includes(`npm install -g '${packageName}'`), text.stderr);
    assert.ok(!/nothing to fix/.test(text.stderr), text.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing env interpreter is named in the repair', { skip: isWindows }, () => {
  const root = makeTemp('cli-path-doctor-broken-env-');
  const command = `cpd-broken-env-${process.pid}-${Date.now()}`;
  const fixture = writeFixture(
    root,
    command,
    '#!/usr/bin/env node\nprocess.exit(0)\n',
    0o755,
  );

  try {
    // Only the fixture directory is on PATH: /usr/bin/env exists, but it
    // cannot find node, so the command is present and cannot start.
    const env = fixtureEnv(root, fixture.directory);
    const json = run([command, '--fix', '--json'], { env });
    assert.equal(json.status, 1, json.stderr);
    const data = JSON.parse(json.stdout);

    assert.equal(data.status, 'broken');
    assert.equal(data.runnable, false);
    assert.match(data.contexts[0].unrunnableReason, /cannot find node/);
    assert.ok(
      data.fixes.some((fix) => /install node on PATH/.test(fix)),
      JSON.stringify(data.fixes),
    );
    assert.ok(!/nothing to fix/.test(data.fix.reason), JSON.stringify(data.fix));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--fix keeps the chmod repair for a non-executable file', { skip: isWindows }, () => {
  const root = makeTemp('cli-path-doctor-noexec-repair-');
  const command = `cpd-noexec-repair-${process.pid}-${Date.now()}`;
  const fixture = writeFixture(root, command, '#!/bin/sh\nexit 0\n', 0o644);

  try {
    const env = fixtureEnv(root, [fixture.directory, basePath].join(path.delimiter));
    const json = run([command, '--fix', '--json'], { env });
    assert.equal(json.status, 1, json.stderr);
    const data = JSON.parse(json.stdout);

    assert.equal(currentContext(data).status, 'miss');
    assert.ok(
      data.fixes.includes(`chmod +x '${fixture.file}'`),
      JSON.stringify(data.fixes),
    );
    assert.ok(!/nothing to fix/.test(data.fix.reason), JSON.stringify(data.fix));
    assert.ok(data.fix.reason.includes('not executable'), JSON.stringify(data.fix));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
