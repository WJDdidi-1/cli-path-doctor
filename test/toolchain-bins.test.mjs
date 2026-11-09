import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * Keep the fixture hermetic: HOME points at the temporary home, the npm prefix
 * is empty, and every toolchain override that could leak a real installation
 * from the host is blanked (the inspector treats an empty value as unset).
 */
function doctorEnv(root, options = {}) {
  const home = options.home || path.join(root, 'home');
  const npmPrefix = path.join(root, 'npm-prefix');

  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    NPM_CONFIG_PREFIX: npmPrefix,
    npm_config_prefix: npmPrefix,
    CLI_PATH_DOCTOR_SHELL: options.shell || '',
    CLI_PATH_DOCTOR_LOGIN_PATH: options.pathValue == null ? basePath : options.pathValue,
    CLI_PATH_DOCTOR_NON_LOGIN_PATH: options.pathValue == null ? basePath : options.pathValue,
    CLI_PATH_DOCTOR_DAEMON_PATH: options.pathValue == null ? basePath : options.pathValue,
    PATH: options.pathValue == null ? basePath : options.pathValue,
    CARGO_HOME: options.cargoHome || '',
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

function makeFixture(home, relativeDirectory, command) {
  const directory = path.join(home, ...relativeDirectory);
  const executable = path.join(directory, isWindows ? `${command}.CMD` : command);

  mkdirSync(directory, { recursive: true });
  writeExecutable(executable, isWindows ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n');

  return { directory, executable };
}

test('reports a cargo binary installed off PATH and fixes PATH instead of npm', { skip: isWindows }, () => {
  const root = makeTemp('cli-path-doctor-cargo-');
  const home = path.join(root, 'home');
  const command = `cli-path-doctor-cargo-${process.pid}-${Date.now()}`;

  try {
    const { directory, executable } = makeFixture(home, ['.cargo', 'bin'], command);
    const env = doctorEnv(root, {
      home,
      shell: fakeShell(root, 'zsh'),
      pathValue: basePath,
    });

    const result = run([command, '--json'], { env, cwd: root });
    assert.equal(result.status, 1, result.stderr);
    const data = JSON.parse(result.stdout);

    const candidate = data.toolchains.candidates.find((entry) => entry.path === executable);
    assert.ok(candidate, `expected the cargo binary in toolchains.candidates: ${result.stdout}`);
    assert.equal(candidate.toolchain, 'cargo');
    assert.equal(candidate.exists, true);
    assert.equal(candidate.executable, true);

    // The plural object is the public shape; the singular alias keeps
    // hand-written consumers working either way.
    assert.deepEqual(data.toolchain.candidates, data.toolchains.candidates);

    assert.match(data.toolchains.hint, /installed at /);
    assert.ok(data.toolchains.hint.includes(executable), data.toolchains.hint);
    assert.match(data.toolchains.hint, /not on PATH/);

    const pathFix = data.fixes.find(
      (fix) => /export PATH=/.test(fix) && fix.includes(directory),
    );
    assert.ok(pathFix, `expected a PATH fix for ${directory}: ${JSON.stringify(data.fixes)}`);
    assert.ok(pathFix.includes('~/.zshrc'), `expected ~/.zshrc in the fix: ${pathFix}`);
    assert.ok(
      !data.fixes.some((fix) => fix.includes('npm install')),
      `did not expect npm install advice: ${JSON.stringify(data.fixes)}`,
    );

    const text = run([command], { env, cwd: root });
    assert.equal(text.status, 1);
    assert.ok(text.stdout.includes(executable), text.stdout);
    assert.match(text.stdout, /installed at .* but not on PATH/);
    assert.ok(text.stderr.includes(directory), text.stderr);
    assert.ok(text.stderr.includes('~/.zshrc'), text.stderr);
    assert.ok(!text.stderr.includes('npm install'), text.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [toolchain, relativeDirectory] of [
  ['cargo', ['.cargo', 'bin']],
  ['bun', ['.bun', 'bin']],
  ['volta', ['.volta', 'bin']],
  ['go', ['go', 'bin']],
]) {
  test(`searches the ${toolchain} user bin directory`, { skip: isWindows }, () => {
    const root = makeTemp(`cli-path-doctor-${toolchain}-`);
    const home = path.join(root, 'home');
    const command = `cli-path-doctor-${toolchain}-${process.pid}-${Date.now()}`;

    try {
      const { directory, executable } = makeFixture(home, relativeDirectory, command);
      const env = doctorEnv(root, {
        home,
        shell: fakeShell(root, 'bash'),
        pathValue: basePath,
      });

      const result = run([command, '--json'], { env, cwd: root });
      assert.equal(result.status, 1, result.stderr);
      const data = JSON.parse(result.stdout);

      const candidate = data.toolchains.candidates.find((entry) => entry.path === executable);
      assert.ok(candidate, `expected the ${toolchain} binary: ${result.stdout}`);
      assert.equal(candidate.toolchain, toolchain);

      const pathFix = data.fixes.find(
        (fix) => /export PATH=/.test(fix) && fix.includes(directory),
      );
      assert.ok(pathFix, `expected a PATH fix for ${directory}: ${JSON.stringify(data.fixes)}`);
      assert.ok(pathFix.includes('~/.bashrc'), `expected ~/.bashrc in the fix: ${pathFix}`);
      assert.ok(
        !data.fixes.some((fix) => fix.includes('npm install')),
        `did not expect npm install advice: ${JSON.stringify(data.fixes)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('honors CARGO_HOME instead of assuming only ~/.cargo/bin', { skip: isWindows }, () => {
  const root = makeTemp('cli-path-doctor-cargo-home-');
  const home = path.join(root, 'home');
  const cargoHome = path.join(root, 'custom-cargo');
  const command = `cli-path-doctor-cargo-home-${process.pid}-${Date.now()}`;

  try {
    const { directory, executable } = makeFixture(cargoHome, ['bin'], command);
    const env = doctorEnv(root, {
      home,
      cargoHome,
      shell: fakeShell(root, 'zsh'),
      pathValue: basePath,
    });

    const result = run([command, '--json'], { env, cwd: root });
    assert.equal(result.status, 1, result.stderr);
    const data = JSON.parse(result.stdout);

    const candidate = data.toolchains.candidates.find((entry) => entry.path === executable);
    assert.ok(candidate, `expected the CARGO_HOME binary: ${result.stdout}`);
    assert.equal(candidate.directory, directory);
    assert.equal(candidate.directorySource, 'CARGO_HOME');

    const pathFix = data.fixes.find(
      (fix) => /export PATH=/.test(fix) && fix.includes(directory),
    );
    assert.ok(pathFix, `expected a PATH fix for ${directory}: ${JSON.stringify(data.fixes)}`);
    assert.ok(!data.fixes.some((fix) => fix.includes('npm install')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('offers chmod for a non-executable toolchain binary, not npm install', { skip: isWindows }, () => {
  const root = makeTemp('cli-path-doctor-cargo-mode-');
  const home = path.join(root, 'home');
  const command = `cli-path-doctor-cargo-mode-${process.pid}-${Date.now()}`;

  try {
    const directory = path.join(home, '.cargo', 'bin');
    const executable = path.join(directory, command);
    mkdirSync(directory, { recursive: true });
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(executable, 0o644);

    const env = doctorEnv(root, {
      home,
      shell: fakeShell(root, 'zsh'),
      pathValue: basePath,
    });

    const result = run([command, '--json'], { env, cwd: root });
    assert.equal(result.status, 1, result.stderr);
    const data = JSON.parse(result.stdout);

    assert.match(data.toolchains.hint, /not executable/);
    assert.ok(
      data.fixes.some((fix) => fix.includes('chmod +x') && fix.includes(executable)),
      `expected a chmod fix: ${JSON.stringify(data.fixes)}`,
    );
    assert.ok(
      !data.fixes.some((fix) => fix.includes('npm install')),
      `did not expect npm install advice: ${JSON.stringify(data.fixes)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a usable toolchain binary wins over incidental npm metadata', { skip: isWindows }, () => {
  const root = makeTemp('cli-path-doctor-toolchain-vs-npm-');
  const home = path.join(root, 'home');
  const command = `cli-path-doctor-toolchain-vs-npm-${process.pid}-${Date.now()}`;

  try {
    const { directory, executable } = makeFixture(home, ['.cargo', 'bin'], command);

    // A global npm package declares the same command but its bin target is
    // missing. That is npm evidence, yet the command was installed with cargo,
    // so the repair must be the cargo PATH, not an npm reinstall.
    const packageDirectory = path.join(
      root,
      'npm-prefix',
      'lib',
      'node_modules',
      'fixture-npm-package',
    );
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(
      path.join(packageDirectory, 'package.json'),
      JSON.stringify({
        name: 'fixture-npm-package',
        version: '1.0.0',
        bin: { [command]: 'bin/missing.js' },
      }),
      'utf8',
    );

    const env = doctorEnv(root, {
      home,
      shell: fakeShell(root, 'zsh'),
      pathValue: basePath,
    });

    const result = run([command, '--json'], { env, cwd: root });
    assert.equal(result.status, 1, result.stderr);
    const data = JSON.parse(result.stdout);

    assert.ok(
      data.npm.packages.some(
        (entry) => entry.source === 'global package' && entry.command === command,
      ),
      `expected npm evidence for the same command: ${result.stdout}`,
    );
    assert.ok(
      data.toolchains.candidates.some((entry) => entry.path === executable),
      `expected the cargo binary: ${result.stdout}`,
    );

    const pathFix = data.fixes.find(
      (fix) => /export PATH=/.test(fix) && fix.includes(directory),
    );
    assert.ok(pathFix, `expected the cargo PATH fix: ${JSON.stringify(data.fixes)}`);
    assert.ok(
      !data.fixes.some((fix) => fix.includes('npm install')),
      `toolchain evidence must suppress npm install advice: ${JSON.stringify(data.fixes)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('does not suggest adding a toolchain directory that is already on PATH', { skip: isWindows }, () => {
  const root = makeTemp('cli-path-doctor-cargo-onpath-');
  const home = path.join(root, 'home');
  const command = `cli-path-doctor-cargo-onpath-${process.pid}-${Date.now()}`;

  try {
    const { directory } = makeFixture(home, ['.cargo', 'bin'], command);
    const pathValue = `${directory}${path.delimiter}${basePath}`;
    const env = doctorEnv(root, {
      home,
      shell: fakeShell(root, 'zsh'),
      pathValue,
    });

    const result = run([command, '--json'], { env, cwd: root });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout);

    assert.equal(data.toolchains.hint, null);
    assert.ok(
      !data.fixes.some((fix) => /export PATH=/.test(fix) && fix.includes(directory)),
      `did not expect PATH advice for an on-PATH directory: ${JSON.stringify(data.fixes)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
