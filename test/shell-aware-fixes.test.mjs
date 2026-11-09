import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli-path-doctor.mjs');
const isWindows = process.platform === 'win32';
const basePath = process.env.PATH || '';

function makeTemp(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function writeExecutable(file, contents = '#!/bin/sh\nexit 0\n') {
  writeFileSync(file, contents, 'utf8');
  chmodSync(file, 0o755);
}

function fakeShell(directory, name) {
  const file = path.join(directory, name);
  writeExecutable(file);
  return file;
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    ...options,
  });
}

function doctorEnv(options) {
  return {
    ...process.env,
    NPM_CONFIG_PREFIX: options.prefix,
    npm_config_prefix: options.prefix,
    CLI_PATH_DOCTOR_SHELL: options.shell,
    CLI_PATH_DOCTOR_LOGIN_PATH: options.loginPath,
    CLI_PATH_DOCTOR_NON_LOGIN_PATH: options.nonLoginPath,
    CLI_PATH_DOCTOR_DAEMON_PATH: options.daemonPath,
    PATH: options.pathValue == null ? basePath : options.pathValue,
  };
}

function assertNoPathFixFor(fixes, directory) {
  assert.ok(
    !fixes.some((fix) => /export PATH=|env:Path/.test(fix) && fix.includes(directory)),
    `did not expect unusable PATH advice for ${directory}: ${JSON.stringify(fixes)}`,
  );
}

for (const [name, rcFile] of [['zsh', '~/.zshrc'], ['bash', '~/.bashrc']]) {
  test(`names ${rcFile} for a found-but-off-PATH npm bin (${name})`, { skip: isWindows }, () => {
    const root = makeTemp('cli-path-doctor-shell-');
    const prefix = path.join(root, 'prefix');
    const prefixBin = path.join(prefix, 'bin');
    const irrelevant = path.join(root, 'irrelevant-login-only');
    const command = `cli-path-doctor-shell-${name}-${process.pid}-${Date.now()}`;
    const executable = path.join(prefixBin, command);

    try {
      mkdirSync(prefixBin, { recursive: true });
      mkdirSync(irrelevant, { recursive: true });
      writeExecutable(executable);

      const env = doctorEnv({
        prefix,
        shell: fakeShell(root, name),
        loginPath: [irrelevant, basePath].join(path.delimiter),
        nonLoginPath: basePath,
        daemonPath: basePath,
      });

      const result = run([command, '--json'], { env });
      assert.equal(result.status, 1, result.stderr);
      const data = JSON.parse(result.stdout);

      assert.equal(data.shellName, name);
      assert.equal(data.rcFile, rcFile);
      assert.equal(data.loginOnlyDirectory, irrelevant);

      const pathFix = data.fixes.find(
        (fix) => /export PATH=/.test(fix) && fix.includes(prefixBin),
      );
      assert.ok(pathFix, `expected a PATH fix for ${prefixBin}: ${JSON.stringify(data.fixes)}`);
      assert.ok(pathFix.includes(rcFile), `expected the fix to name ${rcFile}: ${pathFix}`);
      assertNoPathFixFor(data.fixes, irrelevant);
      assert.ok(
        !data.fixes.some((fix) => fix.includes('npm install -g')),
        `did not expect a reinstall when the npm bin exists: ${JSON.stringify(data.fixes)}`,
      );

      const text = run([command], { env });
      assert.equal(text.status, 1);
      assert.match(text.stderr, /fixes:/);
      assert.ok(text.stderr.includes(rcFile), text.stderr);
      assert.ok(text.stderr.includes(prefixBin), text.stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`keeps the install line when nothing is found (${name})`, { skip: isWindows }, () => {
    const root = makeTemp('cli-path-doctor-nothing-');
    const prefix = path.join(root, 'prefix');
    const irrelevant = path.join(root, 'irrelevant-login-only');
    const command = `cli-path-doctor-nothing-${name}-${process.pid}-${Date.now()}`;

    try {
      mkdirSync(prefix, { recursive: true });
      mkdirSync(irrelevant, { recursive: true });

      const env = doctorEnv({
        prefix,
        shell: fakeShell(root, name),
        loginPath: [irrelevant, basePath].join(path.delimiter),
        nonLoginPath: basePath,
        daemonPath: basePath,
      });

      const result = run([command, '--json'], { env });
      assert.equal(result.status, 1, result.stderr);
      const data = JSON.parse(result.stdout);

      assert.equal(data.rcFile, rcFile);
      assert.ok(
        data.fixes.some((fix) => fix.includes('npm install -g') && fix.includes(command)),
        `expected the install line: ${JSON.stringify(data.fixes)}`,
      );
      assertNoPathFixFor(data.fixes, irrelevant);
      assert.ok(
        !data.fixes.some((fix) => /export PATH=/.test(fix)),
        `did not expect PATH advice when no directory can contain the command: ${JSON.stringify(data.fixes)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('adds a login-only directory only when it contains the command', { skip: isWindows }, () => {
  const root = makeTemp('cli-path-doctor-login-fix-');
  const prefix = path.join(root, 'prefix');
  const irrelevant = path.join(root, 'irrelevant-login-only');
  const useful = path.join(root, 'useful-login-only');
  const command = `cli-path-doctor-login-fix-${process.pid}-${Date.now()}`;
  const executable = path.join(useful, command);

  try {
    mkdirSync(prefix, { recursive: true });
    mkdirSync(irrelevant, { recursive: true });
    mkdirSync(useful, { recursive: true });
    writeExecutable(executable);

    const env = doctorEnv({
      prefix,
      shell: fakeShell(root, 'zsh'),
      loginPath: [irrelevant, useful, basePath].join(path.delimiter),
      nonLoginPath: basePath,
      daemonPath: basePath,
    });

    const result = run([command, '--json'], { env });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout);

    assert.equal(data.loginOnlyDirectory, irrelevant);
    const pathFix = data.fixes.find(
      (fix) => /export PATH=/.test(fix) && fix.includes(useful),
    );
    assert.ok(pathFix, `expected a PATH fix for ${useful}: ${JSON.stringify(data.fixes)}`);
    assert.ok(pathFix.includes('~/.zshrc'), `expected ~/.zshrc in the fix: ${pathFix}`);
    assertNoPathFixFor(data.fixes, irrelevant);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
