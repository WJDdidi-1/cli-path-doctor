import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli-path-doctor.mjs');
const contextNames = ['current', 'login', 'non-login', 'daemon-like'];
const resolvedCommand = process.platform === 'win32' ? 'node' : 'sh';

function run(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    ...options,
  });
}

function rowsFrom(stdout) {
  return stdout
    .trimEnd()
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
}

test('prints one row for every context and resolves a real command', () => {
  const result = run([resolvedCommand]);
  if (result.status !== 0) throw new Error(`expected exit 0, got ${result.status}: ${result.stderr}`);
  if (result.error) throw result.error;

  const rows = rowsFrom(result.stdout);
  if (rows.length !== contextNames.length) {
    throw new Error(`expected ${contextNames.length} rows, got ${rows.length}:\n${result.stdout}`);
  }

  for (const name of contextNames) {
    const row = rows.find((line) => line.startsWith(`${name} `));
    if (!row) throw new Error(`missing context row: ${name}\n${result.stdout}`);
    if (!/MISS|[/\\]/.test(row)) throw new Error(`row does not show a path or miss: ${row}`);
  }

  const current = rows.find((line) => line.startsWith('current '));
  if (!/MISS|[/\\]/.test(current)) throw new Error(`current did not resolve ${resolvedCommand}`);
});

test('reports a miss in every context with exit 1', () => {
  const result = run(['cli-path-doctor-no-such-command-42']);
  if (result.status !== 1) throw new Error(`expected exit 1, got ${result.status}`);

  const rows = rowsFrom(result.stdout);
  if (rows.length !== contextNames.length) {
    throw new Error(`expected ${contextNames.length} rows, got ${rows.length}:\n${result.stdout}`);
  }

  for (const name of contextNames) {
    const row = rows.find((line) => line.startsWith(`${name} `));
    if (!row || !/MISS/.test(row)) throw new Error(`expected a MISS row for ${name}:\n${result.stdout}`);
  }
});

test('--json is machine readable and includes every context', () => {
  const result = run([resolvedCommand, '--json']);
  if (result.status !== 0) throw new Error(`expected exit 0, got ${result.status}: ${result.stderr}`);

  const data = JSON.parse(result.stdout);
  if (data.command !== resolvedCommand) throw new Error(`unexpected command: ${data.command}`);
  if (data.resolved !== true) throw new Error('expected resolved=true');
  if (!Array.isArray(data.contexts) || data.contexts.length !== contextNames.length) {
    throw new Error('expected four contexts in JSON');
  }

  for (const name of contextNames) {
    const row = data.contexts.find((entry) => entry.context === name);
    if (!row) throw new Error(`missing JSON context: ${name}`);
  }
});

test('misses a non-executable file and resolves it after chmod', { skip: process.platform === 'win32' }, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cli-path-doctor-'));
  const command = `cli-path-doctor-fixture-${process.pid}-${Date.now()}`;
  const executable = path.join(directory, command);
  const env = { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH || ''}` };

  try {
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(executable, 0o644);

    const missing = run([command], { env });
    if (missing.status !== 1) throw new Error(`expected exit 1 for non-executable file, got ${missing.status}`);
    if (!/not executable/i.test(missing.stdout)) {
      throw new Error(`expected a not-executable diagnosis:\n${missing.stdout}`);
    }

    chmodSync(executable, 0o755);
    const fixed = run([command, '--json'], { env });
    if (fixed.status !== 0) throw new Error(`expected exit 0 after chmod, got ${fixed.status}`);
    const data = JSON.parse(fixed.stdout);
    const current = data.contexts.find((entry) => entry.context === 'current');
    if (!current || current.path !== executable) {
      throw new Error(`current did not resolve ${executable}: ${fixed.stdout}`);
    }
    const daemon = data.contexts.find((entry) => entry.context === 'daemon-like');
    if (!daemon || daemon.resolved) {
      throw new Error('daemon-like context should not inherit the temporary PATH');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('names a broken npm bin link', { skip: process.platform === 'win32' }, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cli-path-doctor-npm-'));
  const binDirectory = path.join(directory, 'node_modules', '.bin');

  try {
    mkdirSync(binDirectory, { recursive: true });
    symlinkSync('../fixture/bin/missing.js', path.join(binDirectory, 'fixture-cmd'));

    const result = run(['fixture-cmd'], { cwd: directory });
    if (result.status !== 1) throw new Error(`expected exit 1, got ${result.status}`);
    if (!result.stdout.includes(path.join('node_modules', '.bin', 'fixture-cmd'))) {
      throw new Error(`expected the npm bin link to be named:\n${result.stdout}`);
    }
    if (!/broken npm bin link/i.test(result.stdout)) {
      throw new Error(`expected a broken-link diagnosis:\n${result.stdout}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
