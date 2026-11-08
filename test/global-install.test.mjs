import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli-path-doctor.mjs');
const isWindows = process.platform === 'win32';

function makeTemp(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function npmExecutable() {
  return isWindows ? 'npm.cmd' : 'npm';
}

function isolatedNpmEnv(prefix) {
  const cache = path.join(prefix, '.npm-cache');
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

function runNpm(args, options) {
  return spawnSync(npmExecutable(), args, {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    shell: isWindows,
    ...options,
  });
}

function withStableShells(env, pathValue) {
  return {
    ...env,
    CLI_PATH_DOCTOR_LOGIN_PATH: pathValue,
    CLI_PATH_DOCTOR_NON_LOGIN_PATH: pathValue,
  };
}

function runDoctor(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    ...options,
  });
}

function globalNodeModules(prefix) {
  return isWindows
    ? path.join(prefix, 'node_modules')
    : path.join(prefix, 'lib', 'node_modules');
}

/**
 * Reproduce the published-install failure from the epic: npm installs a real
 * package globally, the package's `bin` target does not exist, so npm creates
 * no usable command. The tool must explain that layer instead of only
 * suggesting `npm install -g <command>`.
 */
test('explains a real global install whose bin target is missing', () => {
  const root = makeTemp('cli-path-doctor-global-install-');
  const packageDirectory = path.join(root, 'fixture-package');
  const prefix = path.join(root, 'prefix');
  const packageName = 'broken-global-cli-fixture';
  const command = `broken-global-cli-${process.pid}-${Date.now()}`;
  const target = path.join(globalNodeModules(prefix), packageName, 'bin', 'missing.js');

  try {
    mkdirSync(path.join(packageDirectory, 'bin'), { recursive: true });
    writeFileSync(
      path.join(packageDirectory, 'package.json'),
      JSON.stringify({
        name: packageName,
        version: '0.0.1',
        bin: { [command]: 'bin/missing.js' },
      }),
      'utf8',
    );
    // Declared bin target deliberately absent. npm pack/install must still
    // complete so the broken global installation exists on disk.
    writeFileSync(path.join(packageDirectory, 'bin', 'keep.txt'), 'fixture\n', 'utf8');
    chmodSync(path.join(packageDirectory, 'bin'), 0o755);

    const packed = runNpm(['pack', '--pack-destination', root], {
      cwd: packageDirectory,
      env: isolatedNpmEnv(prefix),
    });
    assert.equal(packed.status, 0, `npm pack failed:\n${packed.stdout}\n${packed.stderr}`);

    const tarball = readdirSync(root).find((entry) => entry.endsWith('.tgz'));
    assert.ok(tarball, `npm pack produced no tarball:\n${packed.stdout}`);

    const installed = runNpm(
      ['install', '-g', path.join(root, tarball), '--ignore-scripts'],
      { cwd: root, env: isolatedNpmEnv(prefix) },
    );
    assert.equal(installed.status, 0, `npm install -g failed:\n${installed.stdout}\n${installed.stderr}`);

    const fullPath = process.env.PATH || '';
    const env = withStableShells(
      {
        ...process.env,
        NPM_CONFIG_PREFIX: prefix,
        PATH: fullPath,
      },
      fullPath,
    );

    const json = runDoctor([command, '--json'], { cwd: root, env });
    assert.equal(json.status, 1, json.stderr);
    const data = JSON.parse(json.stdout);

    const pkg = data.npm.packages.find(
      (entry) => entry.source === 'global package' && entry.command === command,
    );
    assert.ok(pkg, `expected the global package bin declaration: ${json.stdout}`);
    assert.equal(pkg.package, packageName);
    assert.equal(pkg.target, target);
    assert.equal(pkg.exists, false);
    assert.ok(pkg.link.startsWith(prefix), `expected a global bin link under ${prefix}: ${pkg.link}`);

    assert.match(data.npm.hint, /globally installed package/i);
    assert.match(data.npm.hint, /target file is missing/i);
    assert.ok(
      data.fixes.some((fix) => fix.includes('npm install -g') && fix.includes(packageName)),
      `expected a global reinstall fix: ${JSON.stringify(data.fixes)}`,
    );

    const text = runDoctor([command], { cwd: root, env });
    assert.equal(text.status, 1);
    assert.match(text.stdout, /target file is missing/i);
    assert.match(text.stderr, /npm install -g/);
    assert.ok(text.stderr.includes(packageName), text.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
