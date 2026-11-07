#!/usr/bin/env node
/**
 * Runnable example for cli-path-doctor.
 *
 * Reproduces the classic "works in my login shell, missing in the daemon"
 * failure with a throwaway executable, then runs the doctor against it.
 * Everything happens under the OS temp directory and is removed afterwards.
 * No dependencies, no network, and no changes to the caller's PATH.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const doctor = path.join(here, '..', 'bin', 'cli-path-doctor.mjs');
const isWindows = process.platform === 'win32';
const command = `demo-path-doctor-${process.pid}`;
const demoRoot = mkdtempSync(path.join(tmpdir(), 'cli-path-doctor-example-'));
const demoBin = path.join(demoRoot, 'bin');
const executable = path.join(demoBin, isWindows ? `${command}.CMD` : command);

try {
  mkdirSync(demoBin, { recursive: true });
  writeFileSync(executable, isWindows ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n', 'utf8');
  if (!isWindows) chmodSync(executable, 0o755);

  const processPath = process.env.PATH || '';
  const env = {
    ...process.env,
    // Pretend a login shell startup file adds demoBin. The current process,
    // the non-login shell, and the daemon-like environment still lack it.
    CLI_PATH_DOCTOR_LOGIN_PATH: [demoBin, processPath].filter(Boolean).join(path.delimiter),
    CLI_PATH_DOCTOR_NON_LOGIN_PATH: processPath,
  };

  console.log('Runnable example: "works in my shell, missing in the daemon"');
  console.log('');
  console.log(`fixture: ${executable}`);
  console.log(`command: ${command}`);
  console.log('');
  console.log(`$ node bin/cli-path-doctor.mjs ${command}`);
  const result = spawnSync(process.execPath, [doctor, command], { encoding: 'utf8', env });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  console.log(`exit code: ${result.status}`);
  console.log('');

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`expected exit code 0, got ${result.status}`);
  }

  const rows = String(result.stdout || '').trimEnd().split(/\r?\n/);
  if (rows.length !== 4) {
    throw new Error(`expected one row per context (4), got ${rows.length}`);
  }

  const row = (name) => rows.find((line) => line.startsWith(`${name} `));
  const currentRow = row('current');
  const loginRow = row('login');
  const nonLoginRow = row('non-login');
  const daemonRow = row('daemon-like');

  if (!currentRow || !currentRow.includes('MISS')) {
    throw new Error('expected the current context to MISS');
  }
  if (!loginRow || !loginRow.includes(executable)) {
    throw new Error(`expected the login context to resolve ${executable}`);
  }
  if (!nonLoginRow || !nonLoginRow.includes('MISS')) {
    throw new Error('expected the non-login context to MISS');
  }
  if (!daemonRow || !daemonRow.includes('MISS') || !daemonRow.includes(demoBin)) {
    throw new Error('expected the daemon-like context to MISS and name the login-only directory');
  }

  const stderr = String(result.stderr || '');
  if (!stderr.includes(`first login-only PATH directory: ${demoBin}`)) {
    throw new Error('expected stderr to name the first login-only PATH directory');
  }
  const pathFix = isWindows ? /\$env:Path\s*=/ : /export PATH=/;
  if (!pathFix.test(stderr)) {
    throw new Error('expected stderr to print a copy-paste PATH fix');
  }

  console.log('Checked: current and non-login MISS, login resolves,');
  console.log('and the daemon-like row names the directory only the login shell adds.');
} finally {
  rmSync(demoRoot, { recursive: true, force: true });
}
