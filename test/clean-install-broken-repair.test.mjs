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
const MISSING_INTERPRETER = '/nonexistent/interp';

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

function doctorEnv(root, pathValue) {
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

function currentContext(json) {
  const context = json.contexts.find((entry) => entry.context === 'current');
  assert.ok(context, 'expected a current context');
  return context;
}

/**
 * The epic's final milestone installs the packed tarball the way a user does
 * and runs the broken-shebang probe against the installed binary. A `BROKEN`
 * command must get a repair that names the missing interpreter, in text and in
 * `--json`, and `--fix` must not claim there is nothing to fix. Because the
 * file is already on PATH there is no startup-file block to write.
 */
test('a packed install repairs a bad shebang by naming the missing interpreter', { skip: isWindows }, () => {
  const root = makeTemp('cli-path-doctor-clean-broken-repair-');
  const packageDirectory = path.join(root, 'package');
  const prefix = path.join(root, 'prefix');
  const home = path.join(root, 'home');
  const binDirectory = path.join(root, 'bin');
  const command = `cpd-clean-broken-repair-${process.pid}-${Date.now()}`;
  const fixture = path.join(binDirectory, command);

  try {
    mkdirSync(packageDirectory, { recursive: true });
    mkdirSync(prefix, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(binDirectory, { recursive: true });

    const npmEnv = isolatedNpmEnv(root, prefix);
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

    const installedBin = path.join(prefix, 'bin', 'cli-path-doctor');
    assert.ok(existsSync(installedBin), `expected the installed bin link at ${installedBin}`);
    const manifest = JSON.parse(
      readFileSync(path.join(prefix, 'lib', 'node_modules', 'cli-path-doctor', 'package.json'), 'utf8'),
    );
    const version = spawnSync(process.execPath, [installedBin, '--version'], { encoding: 'utf8' });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), manifest.version);

    writeFileSync(fixture, `#!${MISSING_INTERPRETER}\necho broken should not run\n`, 'utf8');
    chmodSync(fixture, 0o755);

    const nodeDirectory = path.dirname(process.execPath);
    const searchPath = [binDirectory, nodeDirectory, '/usr/bin', '/bin'].join(path.delimiter);
    const env = doctorEnv(root, searchPath);
    const runDoctor = (args) => spawnSync(process.execPath, [installedBin, ...args], {
      encoding: 'utf8',
      env,
    });

    const text = runDoctor([command, '--fix']);
    assert.equal(text.status, 1, text.stderr);
    assert.equal((text.stdout.match(/BROKEN/g) || []).length, 4, text.stdout);
    assert.ok(text.stderr.includes(MISSING_INTERPRETER), text.stderr);
    assert.match(text.stderr, /repair needed:/);
    assert.match(text.stderr, /fixes:/);
    assert.ok(!/nothing to fix/.test(text.stderr), text.stderr);
    assert.ok(!/cannot apply PATH fix/.test(text.stderr), text.stderr);
    assert.ok(!/npm install -g/.test(text.stderr), text.stderr);

    const json = runDoctor([command, '--fix', '--json']);
    assert.equal(json.status, 1, json.stderr);
    const data = JSON.parse(json.stdout);
    const current = currentContext(data);

    assert.equal(data.status, 'broken');
    assert.equal(data.resolved, true);
    assert.equal(data.runnable, false);
    assert.equal(data.exitCode, 1);
    assert.equal(data.path, fixture);
    assert.equal(current.status, 'broken');
    assert.equal(current.resolved, true);
    assert.equal(current.runnable, false);
    assert.equal(current.interpreter, MISSING_INTERPRETER);
    assert.match(current.unrunnableReason, /does not exist/);

    const interpreterFix = `install the missing shebang interpreter ${MISSING_INTERPRETER}, or change the shebang in '${fixture}'`;
    assert.ok(
      data.fixes.includes(interpreterFix),
      `expected the interpreter repair in ${JSON.stringify(data.fixes)}`,
    );
    assert.ok(!/nothing to fix/.test(JSON.stringify(data.fix)), JSON.stringify(data.fix));
    assert.equal(data.fix.applied, false, JSON.stringify(data.fix));
    assert.equal(data.fix.manual, true, JSON.stringify(data.fix));
    assert.equal(data.fix.file, null, JSON.stringify(data.fix));
    assert.ok(
      data.fix.reason.includes(MISSING_INTERPRETER),
      JSON.stringify(data.fix.reason),
    );
    assert.match(data.fix.reason, /cannot start/);
    assert.ok(
      !data.fixes.some((fix) => /npm install -g/.test(fix)),
      `a present but broken file must not get an install fix: ${JSON.stringify(data.fixes)}`,
    );

    // No PATH directory has to be added, so --fix must not write a startup
    // file just because the command is broken.
    assert.deepEqual(readdirSync(home), []);
    assert.ok(!existsSync(path.join(home, '.profile')), 'did not expect a startup file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
