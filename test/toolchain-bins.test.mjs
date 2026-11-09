import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { toolchainDirectories } from '../lib/toolchain-metadata.mjs';

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
    BUN_INSTALL: options.bunInstall || '',
    VOLTA_HOME: options.voltaHome || '',
    GOBIN: options.goBin || '',
    GOPATH: options.goPath || '',
    DENO_INSTALL: options.denoInstall || '',
    PNPM_HOME: options.pnpmHome || '',
    ASDF_DATA_DIR: options.asdfDataDir || '',
    MISE_DATA_DIR: options.miseDataDir || '',
    PYENV_ROOT: options.pyenvRoot || '',
    RBENV_ROOT: options.rbenvRoot || '',
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

test('covers every default toolchain directory in the documented list', () => {
  const home = path.posix.join('/home', `cli-path-doctor-default-dirs-${process.pid}`);
  const entries = toolchainDirectories({ HOME: home }, 'linux');
  const directoriesByToolchain = new Map();

  for (const entry of entries) {
    assert.ok(entry.directory, `expected a directory for ${entry.toolchain}`);
    assert.ok(entry.source, `expected a source for ${entry.toolchain}`);
    if (!directoriesByToolchain.has(entry.toolchain)) {
      directoriesByToolchain.set(entry.toolchain, []);
    }
    directoriesByToolchain.get(entry.toolchain).push(entry.directory);
  }

  const expected = {
    cargo: [path.posix.join(home, '.cargo', 'bin')],
    bun: [path.posix.join(home, '.bun', 'bin')],
    volta: [path.posix.join(home, '.volta', 'bin')],
    go: [path.posix.join(home, 'go', 'bin')],
    deno: [path.posix.join(home, '.deno', 'bin')],
    pnpm: [
      path.posix.join(home, '.local', 'share', 'pnpm'),
      path.posix.join(home, 'Library', 'pnpm'),
    ],
    yarn: [path.posix.join(home, '.yarn', 'bin')],
    asdf: [path.posix.join(home, '.asdf', 'shims')],
    mise: [path.posix.join(home, '.local', 'share', 'mise', 'shims')],
    pyenv: [path.posix.join(home, '.pyenv', 'shims')],
    rbenv: [path.posix.join(home, '.rbenv', 'shims')],
    local: [path.posix.join(home, '.local', 'bin')],
  };

  for (const [toolchain, directories] of Object.entries(expected)) {
    assert.deepEqual(
      directoriesByToolchain.get(toolchain),
      directories,
      `unexpected default directories for ${toolchain}: ${JSON.stringify(entries)}`,
    );
  }

  // The same directory must not be searched twice when several toolchains
  // happen to share a location.
  assert.equal(new Set(entries.map((entry) => entry.directory)).size, entries.length);
});

test('searches configured toolchain homes in addition to their defaults', () => {
  const home = path.posix.join('/home', `cli-path-doctor-configured-dirs-${process.pid}`);
  const custom = (name) => path.posix.join('/tmp', `cli-path-doctor-${name}-${process.pid}`);
  const cargoHome = custom('cargo-home');
  const bunInstall = custom('bun-install');
  const voltaHome = custom('volta-home');
  const goBin = custom('go-bin');
  const goPathA = custom('gopath-a');
  const goPathB = custom('gopath-b');
  const goPath = [goPathA, goPathB].join(':');
  const denoInstall = custom('deno-install');
  const pnpmHome = custom('pnpm-home');
  const asdfData = custom('asdf-data');
  const miseData = custom('mise-data');
  const pyenvRoot = custom('pyenv-root');
  const rbenvRoot = custom('rbenv-root');

  const entries = toolchainDirectories({
    HOME: home,
    CARGO_HOME: cargoHome,
    BUN_INSTALL: bunInstall,
    VOLTA_HOME: voltaHome,
    GOBIN: goBin,
    GOPATH: goPath,
    DENO_INSTALL: denoInstall,
    PNPM_HOME: pnpmHome,
    ASDF_DATA_DIR: asdfData,
    MISE_DATA_DIR: miseData,
    PYENV_ROOT: pyenvRoot,
    RBENV_ROOT: rbenvRoot,
  }, 'linux');
  const directories = entries.map((entry) => entry.directory);

  const expectedConfigured = [
    path.posix.join(cargoHome, 'bin'),
    path.posix.join(bunInstall, 'bin'),
    path.posix.join(voltaHome, 'bin'),
    goBin,
    path.posix.join(goPathA, 'bin'),
    path.posix.join(goPathB, 'bin'),
    path.posix.join(denoInstall, 'bin'),
    pnpmHome,
    path.posix.join(asdfData, 'shims'),
    path.posix.join(miseData, 'shims'),
    path.posix.join(pyenvRoot, 'shims'),
    path.posix.join(rbenvRoot, 'shims'),
  ];
  for (const directory of expectedConfigured) {
    assert.ok(directories.includes(directory), `expected configured directory ${directory}: ${JSON.stringify(entries)}`);
  }

  // A configured location does not replace the default one: a binary left in
  // the default directory must still be found.
  for (const directory of [
    path.posix.join(home, '.cargo', 'bin'),
    path.posix.join(home, '.bun', 'bin'),
    path.posix.join(home, '.volta', 'bin'),
    path.posix.join(home, 'go', 'bin'),
    path.posix.join(home, '.deno', 'bin'),
    path.posix.join(home, '.asdf', 'shims'),
    path.posix.join(home, '.local', 'share', 'mise', 'shims'),
    path.posix.join(home, '.pyenv', 'shims'),
    path.posix.join(home, '.rbenv', 'shims'),
  ]) {
    assert.ok(directories.includes(directory), `expected default directory ${directory}: ${JSON.stringify(entries)}`);
  }
});

for (const [toolchain, envName, optionName] of [
  ['bun', 'BUN_INSTALL', 'bunInstall'],
  ['volta', 'VOLTA_HOME', 'voltaHome'],
]) {
  test(`searches the configured ${toolchain} home`, { skip: isWindows }, () => {
    const root = makeTemp(`cli-path-doctor-${toolchain}-configured-`);
    const home = path.join(root, 'home');
    const configuredHome = path.join(root, `${toolchain}-home`);
    const command = `cli-path-doctor-${toolchain}-configured-${process.pid}-${Date.now()}`;

    try {
      const { directory, executable } = makeFixture(configuredHome, ['bin'], command);
      const env = doctorEnv(root, {
        home,
        [optionName]: configuredHome,
        shell: fakeShell(root, 'bash'),
        pathValue: basePath,
      });

      const result = run([command, '--json'], { env, cwd: root });
      assert.equal(result.status, 1, result.stderr);
      const data = JSON.parse(result.stdout);

      const candidate = data.toolchains.candidates.find((entry) => entry.path === executable);
      assert.ok(candidate, `expected the configured ${toolchain} binary: ${result.stdout}`);
      assert.equal(candidate.toolchain, toolchain);
      assert.equal(candidate.directory, directory);
      assert.equal(candidate.directorySource, envName);

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

test('recommends npm install for a command genuinely absent from every toolchain directory', { skip: isWindows }, () => {
  const root = makeTemp('cli-path-doctor-absent-');
  const home = path.join(root, 'home');
  const command = `cli-path-doctor-absent-${process.pid}-${Date.now()}`;
  const unrelated = `cli-path-doctor-unrelated-${process.pid}`;

  try {
    // The directories exist and contain other executables, so an empty
    // candidate list proves the search is by command name, not by directory.
    const cargo = makeFixture(home, ['.cargo', 'bin'], `${unrelated}-cargo`);
    const bun = makeFixture(home, ['.bun', 'bin'], `${unrelated}-bun`);
    const volta = makeFixture(home, ['.volta', 'bin'], `${unrelated}-volta`);
    const env = doctorEnv(root, {
      home,
      shell: fakeShell(root, 'zsh'),
      pathValue: basePath,
    });

    const result = run([command, '--json'], { env, cwd: root });
    assert.equal(result.status, 1, result.stderr);
    const data = JSON.parse(result.stdout);

    const searched = data.toolchains.directories.map((entry) => entry.directory);
    for (const directory of [cargo.directory, bun.directory, volta.directory]) {
      assert.ok(searched.includes(directory), `expected ${directory} in the search list: ${result.stdout}`);
    }
    assert.deepEqual(
      data.toolchains.candidates,
      [],
      `expected no toolchain candidate for ${command}: ${JSON.stringify(data.toolchains.candidates)}`,
    );
    assert.equal(data.toolchains.hint, null);

    const installFix = data.fixes.find((fix) => fix.includes('npm install -g'));
    assert.ok(installFix, `expected npm install advice: ${JSON.stringify(data.fixes)}`);
    assert.ok(installFix.includes(command), installFix);
    for (const directory of [cargo.directory, bun.directory, volta.directory]) {
      assert.ok(
        !data.fixes.some((fix) => /export PATH=/.test(fix) && fix.includes(directory)),
        `did not expect PATH advice for ${directory}: ${JSON.stringify(data.fixes)}`,
      );
    }

    const text = run([command], { env, cwd: root });
    assert.equal(text.status, 1);
    assert.match(text.stdout, /MISS \(not found on PATH\)/);
    assert.match(text.stderr, /npm install -g/);
    assert.ok(text.stderr.includes(command), text.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
