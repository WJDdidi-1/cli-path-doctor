import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

function run(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    ...options,
  });
}

function fixture(shellName = 'zsh') {
  const root = makeTemp('cli-path-doctor-fix-');
  const home = path.join(root, 'home');
  const prefix = path.join(root, 'prefix');
  const prefixBin = path.join(prefix, 'bin');
  const shellDirectory = path.join(root, 'shells');
  const command = `cli-path-doctor-fix-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(home, { recursive: true });
  mkdirSync(prefixBin, { recursive: true });
  mkdirSync(shellDirectory, { recursive: true });
  writeExecutable(path.join(prefixBin, command));

  const shell = path.join(shellDirectory, shellName);
  writeExecutable(shell);

  const env = {
    ...process.env,
    HOME: home,
    NPM_CONFIG_PREFIX: prefix,
    npm_config_prefix: prefix,
    CLI_PATH_DOCTOR_SHELL: shell,
    CLI_PATH_DOCTOR_LOGIN_PATH: basePath,
    CLI_PATH_DOCTOR_NON_LOGIN_PATH: basePath,
    CLI_PATH_DOCTOR_DAEMON_PATH: basePath,
    PATH: basePath,
  };

  return {
    root,
    home,
    prefix,
    prefixBin,
    command,
    shell,
    env,
    rcFile: path.join(home, shellName === 'bash' ? '.bashrc' : '.zshrc'),
  };
}

test('--fix appends one marked PATH block and reports it in --json', { skip: isWindows }, () => {
  const { root, prefixBin, command, env, rcFile } = fixture();

  try {
    const result = run([command, '--fix', '--json'], { env });
    assert.equal(result.status, 1, result.stderr);
    const data = JSON.parse(result.stdout);

    assert.equal(data.fix.applied, true, JSON.stringify(data.fix));
    assert.equal(data.fix.alreadyPresent, false, JSON.stringify(data.fix));
    assert.equal(data.fix.file, rcFile);
    assert.match(data.fix.line, /^export PATH=/);
    assert.ok(data.fix.line.includes(prefixBin), data.fix.line);

    assert.ok(existsSync(rcFile), `expected ${rcFile} to exist`);
    const content = readFileSync(rcFile, 'utf8');
    assert.equal((content.match(/# >>> cli-path-doctor:/g) || []).length, 1, content);
    assert.ok(content.includes(`# >>> cli-path-doctor: ${prefixBin} >>>`), content);
    assert.ok(content.includes(`export PATH='${prefixBin}':"$PATH"`), content);
    assert.ok(content.includes('# <<< cli-path-doctor:'), content);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--fix writes the bash startup file for bash', { skip: isWindows }, () => {
  const { root, prefixBin, command, env, rcFile } = fixture('bash');

  try {
    const result = run([command, '--fix', '--json'], { env });
    assert.equal(result.status, 1, result.stderr);
    const data = JSON.parse(result.stdout);

    assert.equal(data.fix.applied, true, JSON.stringify(data.fix));
    assert.equal(data.fix.file, rcFile);
    assert.ok(rcFile.endsWith('.bashrc'), rcFile);
    assert.ok(readFileSync(rcFile, 'utf8').includes(`export PATH='${prefixBin}':"$PATH"`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--fix is idempotent and keeps the rc file unchanged on the second run', { skip: isWindows }, () => {
  const { root, command, env, rcFile } = fixture();

  try {
    const first = run([command, '--fix', '--json'], { env });
    assert.equal(first.status, 1, first.stderr);
    assert.equal(JSON.parse(first.stdout).fix.applied, true);
    const afterFirst = readFileSync(rcFile, 'utf8');

    const second = run([command, '--fix', '--json'], { env });
    assert.equal(second.status, 1, second.stderr);
    const data = JSON.parse(second.stdout);
    assert.equal(data.fix.applied, false, JSON.stringify(data.fix));
    assert.equal(data.fix.alreadyPresent, true, JSON.stringify(data.fix));
    assert.equal(data.fix.file, rcFile);
    assert.match(data.fix.reason, /already present/);
    assert.equal(readFileSync(rcFile, 'utf8'), afterFirst);
    assert.equal((afterFirst.match(/# >>> cli-path-doctor:/g) || []).length, 1, afterFirst);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--fix refuses an unknown shell without writing a startup file', { skip: isWindows }, () => {
  const { root, command, env, rcFile } = fixture();
  const unknownShell = path.join(root, 'shells', 'tcsh');
  writeExecutable(unknownShell);

  try {
    const result = run([command, '--fix', '--json'], {
      env: { ...env, CLI_PATH_DOCTOR_SHELL: unknownShell },
    });
    assert.equal(result.status, 1, result.stderr);
    const data = JSON.parse(result.stdout);

    assert.equal(data.fix.applied, false, JSON.stringify(data.fix));
    assert.equal(data.fix.alreadyPresent, false, JSON.stringify(data.fix));
    assert.match(data.fix.reason, /unknown shell/);
    assert.ok(!existsSync(rcFile), `refusal must not create ${rcFile}`);
    assert.ok(!existsSync(path.join(root, 'home', '.profile')), 'refusal must not create a fallback rc file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('never writes a startup file without --fix', { skip: isWindows }, () => {
  const { root, command, env, rcFile } = fixture();

  try {
    const result = run([command, '--json'], { env });
    assert.equal(result.status, 1, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.equal(data.fix, null, '--json without --fix must not claim a fix was applied');
    assert.ok(!existsSync(rcFile), `did not expect ${rcFile} without --fix`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
