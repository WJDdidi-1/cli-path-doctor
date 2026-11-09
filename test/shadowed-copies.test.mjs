import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { findCommandCopies } from '../lib/path-resolver.mjs';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli-path-doctor.mjs');
const isWindows = process.platform === 'win32';
const basePath = process.env.PATH || '';

function makeTemp(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function writeExecutable(file) {
  writeFileSync(file, isWindows ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n', 'utf8');
  chmodSync(file, 0o755);
}

function makeCopy(root, directoryName, command) {
  const directory = path.join(root, directoryName);
  const executable = path.join(directory, isWindows ? `${command}.CMD` : command);
  mkdirSync(directory, { recursive: true });
  writeExecutable(executable);
  return { directory, executable };
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    ...options,
  });
}

function shadowEnv(root, shadowPath, daemonPath) {
  const home = path.join(root, 'home');
  const prefix = path.join(root, 'npm-prefix');

  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    NPM_CONFIG_PREFIX: prefix,
    npm_config_prefix: prefix,
    CLI_PATH_DOCTOR_LOGIN_PATH: shadowPath,
    CLI_PATH_DOCTOR_NON_LOGIN_PATH: shadowPath,
    CLI_PATH_DOCTOR_DAEMON_PATH: daemonPath,
    PATH: shadowPath,
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

test('names both copies and says which one wins in text and JSON', { skip: isWindows }, () => {
  const root = makeTemp('cli-path-doctor-shadow-');
  const command = `cli-path-doctor-shadow-${process.pid}-${Date.now()}`;
  const first = makeCopy(root, path.join('a', 'bin'), command);
  const second = makeCopy(root, path.join('b', 'bin'), command);
  const shadowPath = [first.directory, second.directory, basePath].join(path.delimiter);
  const env = shadowEnv(root, shadowPath, basePath);

  try {
    const text = run([command], { env });
    assert.equal(text.status, 0, text.stderr);
    assert.ok(text.stdout.includes(first.executable), text.stdout);
    assert.ok(text.stdout.includes(second.executable), text.stdout);
    assert.match(text.stdout, /wins; shadows/);
    assert.match(text.stderr, /shadowed copies:/);
    assert.ok(text.stderr.includes(second.executable), text.stderr);

    const json = run([command, '--json'], { env });
    assert.equal(json.status, 0, json.stderr);
    const data = JSON.parse(json.stdout);

    const current = data.contexts.find((entry) => entry.context === 'current');
    assert.ok(current, 'expected the current context');
    assert.equal(current.path, first.executable);
    assert.equal(current.copies.length, 2);
    assert.equal(current.copies[0].path, first.executable);
    assert.equal(current.copies[0].winner, true);
    assert.equal(current.copies[0].shadowed, false);
    assert.equal(current.copies[1].path, second.executable);
    assert.equal(current.copies[1].winner, false);
    assert.equal(current.copies[1].shadowed, true);
    assert.deepEqual(current.shadowedPaths, [second.executable]);

    // The flat list is convenient for consumers that do not want to walk the
    // contexts, while `shadowing` groups the same evidence by context.
    assert.equal(data.copies.length, 2);
    assert.ok(data.copies.some((copy) => copy.context === 'current' && copy.path === second.executable));
    assert.equal(data.shadowed.length, 1);
    assert.ok(data.shadowed.some((copy) => copy.context === 'current' && copy.path === second.executable));
    assert.deepEqual(data.shadowedPaths, [second.executable]);
    assert.deepEqual(data.copiesByContext.current.map((copy) => copy.path), [first.executable, second.executable]);
    const currentShadowing = data.shadowing.find((entry) => entry.context === 'current');
    assert.ok(currentShadowing, 'expected current shadowing evidence');
    assert.equal(currentShadowing.winner, first.executable);
    assert.deepEqual(currentShadowing.shadowed, [second.executable]);

    // The winning directory is already on the current PATH; exporting it (or
    // the shadowed directory, also present) would only be noise.
    for (const directory of [first.directory, second.directory]) {
      assert.ok(
        !data.fixes.some((fix) => /export PATH=|env:Path/.test(fix) && fix.includes(directory)),
        `did not expect a useless PATH fix for ${directory}: ${JSON.stringify(data.fixes)}`,
      );
    }
    assert.ok(
      !text.stderr.includes(`export PATH='${first.directory}'`),
      `did not expect a useless PATH fix in stderr: ${text.stderr}`,
    );
    assert.ok(
      !text.stderr.includes(`export PATH='${second.directory}'`),
      `did not expect a useless PATH fix in stderr: ${text.stderr}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stays quiet when one copy is reachable, even if PATH repeats its directory', { skip: isWindows }, () => {
  const root = makeTemp('cli-path-doctor-no-shadow-');
  const command = `cli-path-doctor-no-shadow-${process.pid}-${Date.now()}`;
  const only = makeCopy(root, path.join('only', 'bin'), command);
  // The same directory twice is one copy, not a shadowing pair.
  const singlePath = [only.directory, only.directory, basePath].join(path.delimiter);
  const env = shadowEnv(root, singlePath, basePath);

  try {
    const text = run([command], { env });
    assert.equal(text.status, 0, text.stderr);
    assert.ok(text.stdout.includes(only.executable), text.stdout);
    assert.ok(!text.stdout.includes('wins; shadows'), text.stdout);
    assert.ok(!text.stderr.includes('shadowed copies:'), text.stderr);

    const json = run([command, '--json'], { env });
    assert.equal(json.status, 0, json.stderr);
    const data = JSON.parse(json.stdout);
    const current = data.contexts.find((entry) => entry.context === 'current');
    assert.equal(current.copies.length, 1);
    assert.equal(current.copies[0].winner, true);
    assert.deepEqual(current.shadowedPaths, []);
    assert.equal(data.copies.length, 1);
    assert.deepEqual(data.shadowed, []);
    assert.deepEqual(data.shadowedPaths, []);
    assert.deepEqual(data.shadowing, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('only runnable PATH lookups count as copies', { skip: isWindows }, () => {
  const root = makeTemp('cli-path-doctor-copy-rules-');
  const command = `cli-path-doctor-copy-rules-${process.pid}-${Date.now()}`;
  const winner = makeCopy(root, path.join('a', 'bin'), command);

  // A same-named file without an executable bit cannot be run, so it is not a
  // copy the winner can shadow.
  const nonExecutableDir = path.join(root, 'b', 'bin');
  const nonExecutable = path.join(nonExecutableDir, command);
  mkdirSync(nonExecutableDir, { recursive: true });
  writeFileSync(nonExecutable, '#!/bin/sh\nexit 0\n', 'utf8');
  chmodSync(nonExecutable, 0o644);

  // A broken symlink is left by a failed install, not a runnable copy.
  const brokenDir = path.join(root, 'c', 'bin');
  const brokenLink = path.join(brokenDir, command);
  mkdirSync(brokenDir, { recursive: true });
  symlinkSync(path.join(root, 'missing-target'), brokenLink);

  const pathValue = [winner.directory, nonExecutableDir, brokenDir, basePath].join(path.delimiter);
  const options = { platform: process.platform, env: process.env };

  try {
    const result = findCommandCopies(command, pathValue, options);
    assert.equal(result.copies.length, 1);
    assert.equal(result.winner.path, winner.executable);
    assert.deepEqual(result.shadowed, []);

    // A command written as a path is not looked up on PATH, so it cannot be
    // shadowed by (or shadow) anything.
    assert.deepEqual(findCommandCopies(winner.executable, pathValue, options).copies, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
