import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const basePath = process.env.PATH || '';
const shell = '/bin/sh';
const originalProfile = '# user profile\n# keep me\nexport EDITOR=vi\n';

function makeTemp(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function runNpm(args, options) {
  return spawnSync('npm', args, {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    ...options,
  });
}

function isolatedNpmEnv(root, prefix, home) {
  const cache = path.join(root, 'npm-cache');
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    NPM_CONFIG_PREFIX: prefix,
    npm_config_prefix: prefix,
    NPM_CONFIG_CACHE: cache,
    npm_config_cache: cache,
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    NO_UPDATE_NOTIFIER: '1',
  };
}

function doctorEnv(home, prefix) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    NPM_CONFIG_PREFIX: prefix,
    npm_config_prefix: prefix,
    CLI_PATH_DOCTOR_SHELL: shell,
    CLI_PATH_DOCTOR_LOGIN_PATH: basePath,
    CLI_PATH_DOCTOR_NON_LOGIN_PATH: basePath,
    CLI_PATH_DOCTOR_DAEMON_PATH: basePath,
    PATH: basePath,
  };
}

function loginShellResolves(home, command) {
  return spawnSync(shell, ['-l', '-c', 'command -v "$1"', 'sh', command], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PATH: basePath,
    },
  });
}

/**
 * Undo the way the README documents it: delete the marked block. The blank
 * separator `--fix` inserted immediately before the block is removed too, so
 * a profile that had no managed block is returned to its original content.
 */
function removeManagedFixBlocks(content) {
  return content.replace(
    /\n# >>> cli-path-doctor: [^\n]* >>>\n# Managed by cli-path-doctor --fix\. Delete this block to undo\.\n[^\n]*\n# <<< cli-path-doctor: [^\n]* <<<\n?/g,
    '',
  );
}

/**
 * The acceptance check for this milestone runs the *packed* package, not the
 * checkout: `npm pack`, install the tarball globally into an isolated prefix,
 * then let the installed doctor write into a temporary HOME. The same profile
 * is used for a real login-shell resolution after the fix and after undo.
 */
test('--fix from a packed install writes an idempotent block a login shell uses', { skip: isWindows }, () => {
  const root = makeTemp('cli-path-doctor-clean-fix-');
  const packageDirectory = path.join(root, 'package');
  const prefix = path.join(root, 'prefix');
  const home = path.join(root, 'home');
  const prefixBin = path.join(prefix, 'bin');
  const command = `cpd-fix-clean-${process.pid}-${Date.now()}`;
  const rcFile = path.join(home, '.profile');

  try {
    mkdirSync(packageDirectory, { recursive: true });
    mkdirSync(prefix, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(rcFile, originalProfile, 'utf8');

    const npmEnv = isolatedNpmEnv(root, prefix, home);
    const packed = runNpm(['pack', '--pack-destination', packageDirectory], {
      cwd: repoRoot,
      env: npmEnv,
    });
    assert.equal(packed.status, 0, `npm pack failed:\n${packed.stdout}\n${packed.stderr}`);

    const tarball = readdirSync(packageDirectory).find((entry) => entry.endsWith('.tgz'));
    assert.ok(tarball, `npm pack produced no tarball:\n${packed.stdout}`);

    const installed = runNpm(
      ['install', '-g', path.join(packageDirectory, tarball), '--ignore-scripts'],
      { cwd: root, env: npmEnv },
    );
    assert.equal(installed.status, 0, `npm install -g failed:\n${installed.stdout}\n${installed.stderr}`);

    const installedBin = path.join(prefixBin, 'cli-path-doctor');
    assert.ok(existsSync(installedBin), `expected the installed bin link at ${installedBin}`);

    // A real global bin link whose directory is not on any checked PATH. This
    // is the same shape as a user's `npm install -g` that their daemon cannot
    // see; the installed doctor must offer to add exactly that directory.
    writeFileSync(path.join(prefixBin, command), '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(path.join(prefixBin, command), 0o755);

    const env = doctorEnv(home, prefix);
    const runDoctor = (args) => spawnSync(process.execPath, [installedBin, ...args], {
      encoding: 'utf8',
      env,
    });

    const help = spawnSync(process.execPath, [installedBin, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--fix/);

    const first = runDoctor([command, '--fix', '--json']);
    assert.equal(first.status, 1, first.stderr);
    const firstData = JSON.parse(first.stdout);
    assert.equal(firstData.fix.applied, true, JSON.stringify(firstData.fix));
    assert.equal(firstData.fix.alreadyPresent, false, JSON.stringify(firstData.fix));
    assert.equal(firstData.fix.file, rcFile);
    assert.match(firstData.fix.line, /^export PATH=/);
    assert.ok(firstData.fix.line.includes(prefixBin), firstData.fix.line);

    const afterFirst = readFileSync(rcFile, 'utf8');
    assert.ok(afterFirst.startsWith(originalProfile), afterFirst);
    assert.equal((afterFirst.match(/# >>> cli-path-doctor:/g) || []).length, 1, afterFirst);
    assert.ok(afterFirst.includes(`# >>> cli-path-doctor: ${prefixBin} >>>`), afterFirst);
    assert.ok(
      afterFirst.includes('# Managed by cli-path-doctor --fix. Delete this block to undo.'),
      afterFirst,
    );
    assert.ok(afterFirst.includes(`export PATH='${prefixBin}':"$PATH"`), afterFirst);
    assert.ok(afterFirst.includes(`# <<< cli-path-doctor: ${prefixBin} <<<`), afterFirst);

    const second = runDoctor([command, '--fix', '--json']);
    assert.equal(second.status, 1, second.stderr);
    const secondData = JSON.parse(second.stdout);
    assert.equal(secondData.fix.applied, false, JSON.stringify(secondData.fix));
    assert.equal(secondData.fix.alreadyPresent, true, JSON.stringify(secondData.fix));
    assert.equal(secondData.fix.file, rcFile);
    assert.match(secondData.fix.reason, /already present/);
    assert.equal(readFileSync(rcFile, 'utf8'), afterFirst, 'second --fix must not change the profile');
    assert.equal((afterFirst.match(/# >>> cli-path-doctor:/g) || []).length, 1, afterFirst);

    // A fresh login shell reads the temporary HOME's .profile. The command
    // must resolve to the real file, not merely appear in the profile text.
    const resolved = loginShellResolves(home, command);
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(resolved.stdout.trim(), path.join(prefixBin, command));

    // Documented undo: remove the marked block. The unrelated profile setup
    // stays, and the command is no longer resolved by a fresh login shell.
    const undone = removeManagedFixBlocks(afterFirst);
    assert.equal(undone, originalProfile);
    writeFileSync(rcFile, undone, 'utf8');

    const afterUndo = loginShellResolves(home, command);
    assert.equal(afterUndo.status, 1, `${afterUndo.stdout}\n${afterUndo.stderr}`);
    assert.equal(afterUndo.stdout.trim(), '');
    assert.ok(!readFileSync(rcFile, 'utf8').includes('cli-path-doctor'), readFileSync(rcFile, 'utf8'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
