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

function makeTemp(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function npmExecutable() {
  return isWindows ? 'npm.cmd' : 'npm';
}

function runNpm(args, options) {
  return spawnSync(npmExecutable(), args, {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    shell: isWindows,
    ...options,
  });
}

function isolatedNpmEnv(root, prefix) {
  const cache = path.join(root, 'npm-cache');
  return {
    ...process.env,
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

function fixtureEnv(root, pathValue) {
  const home = path.join(root, 'home');
  const prefix = path.join(root, 'prefix');

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

/**
 * The epic's acceptance check is a clean install of the built package, not the
 * checkout: `npm pack`, install the tarball globally into an isolated prefix,
 * then run the installed link against fixtures on PATH. A bad-shebang script
 * must be BROKEN (resolved but not runnable), while a real command stays ok.
 */
test('a packed install reports BROKEN for a bad shebang and ok for a real command', { skip: isWindows }, () => {
  const root = makeTemp('cli-path-doctor-clean-install-');
  const packageDirectory = path.join(root, 'package');
  const prefix = path.join(root, 'prefix');
  const command = `cpd-clean-broken-${process.pid}-${Date.now()}`;
  const goodCommand = `cpd-clean-good-${process.pid}-${Date.now()}`;
  const missingCommand = `cpd-clean-missing-${process.pid}-${Date.now()}`;

  try {
    mkdirSync(packageDirectory, { recursive: true });
    mkdirSync(prefix, { recursive: true });
    mkdirSync(path.join(root, 'home'), { recursive: true });

    const env = isolatedNpmEnv(root, prefix);
    const packed = runNpm(['pack', '--pack-destination', packageDirectory], {
      cwd: repoRoot,
      env,
    });
    assert.equal(packed.status, 0, `npm pack failed:\n${packed.stdout}\n${packed.stderr}`);

    const tarball = readdirSync(packageDirectory).find((entry) => entry.endsWith('.tgz'));
    assert.ok(tarball, `npm pack produced no tarball:\n${packed.stdout}`);

    const installed = runNpm(
      ['install', '-g', path.join(packageDirectory, tarball), '--ignore-scripts'],
      { cwd: root, env },
    );
    assert.equal(installed.status, 0, `npm install -g failed:\n${installed.stdout}\n${installed.stderr}`);

    const installedBin = path.join(prefix, 'bin', 'cli-path-doctor');
    assert.ok(existsSync(installedBin), `expected the installed bin link at ${installedBin}`);

    const packageManifest = JSON.parse(
      readFileSync(path.join(prefix, 'lib', 'node_modules', 'cli-path-doctor', 'package.json'), 'utf8'),
    );
    const version = spawnSync(process.execPath, [installedBin, '--version'], { encoding: 'utf8' });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), packageManifest.version);

    const broken = writeFixture(
      root,
      command,
      '#!/nonexistent/interpreter\necho this must not run\n',
      0o755,
    );
    const good = writeFixture(root, goodCommand, '#!/bin/sh\necho good ran\n', 0o755);
    const nodeDirectory = path.dirname(process.execPath);
    const pathValue = [broken.directory, nodeDirectory, basePath].join(path.delimiter);
    const doctorEnv = fixtureEnv(root, pathValue);

    const runDoctor = (args) => spawnSync(process.execPath, [installedBin, ...args], {
      encoding: 'utf8',
      env: doctorEnv,
    });

    const brokenText = runDoctor([command]);
    assert.equal(brokenText.status, 1, brokenText.stderr);
    assert.match(brokenText.stdout, /current\s+BROKEN/);
    assert.match(brokenText.stdout, /shebang interpreter \/nonexistent\/interpreter does not exist/);
    assert.equal((brokenText.stdout.match(/BROKEN/g) || []).length, 4, brokenText.stdout);
    assert.ok(!/npm install -g/.test(brokenText.stderr), brokenText.stderr);

    const brokenJson = runDoctor([command, '--json']);
    assert.equal(brokenJson.status, 1, brokenJson.stderr);
    const brokenData = JSON.parse(brokenJson.stdout);
    const brokenCurrent = currentContext(brokenData);

    assert.equal(brokenData.status, 'broken');
    assert.equal(brokenData.resolved, true);
    assert.equal(brokenData.runnable, false);
    assert.equal(brokenData.exitCode, 1);
    assert.equal(brokenData.path, broken.file);
    assert.equal(brokenCurrent.status, 'broken');
    assert.equal(brokenCurrent.resolved, true);
    assert.equal(brokenCurrent.runnable, false);
    assert.match(brokenCurrent.unrunnableReason, /nonexistent\/interpreter/);
    assert.ok(
      !brokenData.fixes.some((fix) => /npm install -g/.test(fix)),
      `a present but unrunnable file must not get an install fix: ${JSON.stringify(brokenData.fixes)}`,
    );

    const goodText = runDoctor([goodCommand]);
    assert.equal(goodText.status, 0, goodText.stderr);
    assert.match(goodText.stdout, new RegExp(`current\\s+${good.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.ok(!/BROKEN/.test(goodText.stdout), goodText.stdout);

    const goodJson = runDoctor([goodCommand, '--json']);
    assert.equal(goodJson.status, 0, goodJson.stderr);
    const goodData = JSON.parse(goodJson.stdout);
    const goodCurrent = currentContext(goodData);

    assert.equal(goodData.status, 'ok');
    assert.equal(goodData.resolved, true);
    assert.equal(goodData.runnable, true);
    assert.equal(goodData.exitCode, 0);
    assert.equal(goodCurrent.status, 'ok');
    assert.equal(goodCurrent.runnable, true);
    assert.equal(goodCurrent.unrunnableReason, null);
    assert.equal(goodCurrent.path, good.file);

    // The installed package must also keep a genuinely real command working,
    // not only the shell-script fixture above.
    const realCommand = path.basename(process.execPath);
    const realJson = runDoctor([realCommand, '--json']);
    assert.equal(realJson.status, 0, realJson.stderr);
    const realData = JSON.parse(realJson.stdout);
    const realCurrent = currentContext(realData);

    assert.equal(realData.status, 'ok');
    assert.equal(realData.runnable, true);
    assert.equal(realCurrent.status, 'ok');
    assert.equal(realCurrent.runnable, true);
    assert.equal(realCurrent.unrunnableReason, null);
    assert.equal(path.basename(realCurrent.path), realCommand);

    // The contrast the README documents: a genuinely absent command still gets
    // the install line, while a present-but-broken one does not.
    const missingJson = runDoctor([missingCommand, '--json']);
    assert.equal(missingJson.status, 1, missingJson.stderr);
    const missingData = JSON.parse(missingJson.stdout);
    assert.equal(missingData.status, 'miss');
    assert.equal(missingData.resolved, false);
    assert.equal(missingData.runnable, false);
    assert.ok(
      missingData.fixes.includes(`npm install -g '${missingCommand}'`),
      JSON.stringify(missingData.fixes),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
