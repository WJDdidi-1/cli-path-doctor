# Verified: the user-level toolchain search

This page records the verification for the epic milestone **"Cover the
toolchain list and document it"**. The doctor previously inspected only npm
prefixes, so a binary installed by cargo, bun, volta, or go was reported as
missing and the suggested repair was `npm install -g`. The merged
implementation searches the user-level directories those toolchains use and
names the actual directory to add to PATH.

## What the probe verifies

The probe is a real fixture, not a mocked payload. It creates a temporary HOME
with executables in the default cargo, bun, and volta bin directories:

- `~/.cargo/bin/toolchain-probe-cargo-cli`
- `~/.bun/bin/toolchain-probe-bun-cli`
- `~/.volta/bin/toolchain-probe-volta-cli`

Every checked PATH deliberately omits those directories. Each directory also
contains an unrelated executable, so a match proves the search is by command
name rather than a directory-existence check.

For each command the probe asserts:

- The JSON `toolchains.candidates` entry has the right path, `toolchain`,
  `directorySource`, and a usable executable bit.
- `toolchains.hint` names the installed path and says it is "not on PATH".
- Exactly one `fixes` entry is an `export PATH=` line for the toolchain
  directory, and it names `~/.zshrc` for the fixture's detected shell.
- There is no `npm install -g` line, because the command was not installed with
  npm.
- The text-mode stderr names the same directory and rc file.

A fourth command, `toolchain-probe-absent-cli`, is genuinely absent from every
searched directory even though those directories exist and contain other
executables. The probe asserts that it has no toolchain candidate and no
toolchain hint, that `fixes` contains exactly the fallback
`npm install -g 'toolchain-probe-absent-cli'`, and that no PATH advice is
offered for a directory that cannot contain it.

The same cases are covered by `npm test` in `test/toolchain-bins.test.mjs`.
That suite also asserts the full default directory list and every configured
override (`CARGO_HOME`, `BUN_INSTALL`, `VOLTA_HOME`, `GOBIN`, `GOPATH`,
`DENO_INSTALL`, `PNPM_HOME`, `ASDF_DATA_DIR`, `MISE_DATA_DIR`, `PYENV_ROOT`, and
`RBENV_ROOT`), with CLI fixtures for the configured cargo, bun, and volta
homes. README's "A real toolchain session (cargo)" section lists every searched
directory.

## The probe

Run it from the repository root (or from anywhere; the script resolves the
checkout itself):

```sh
sh docs/probes/toolchain-bins.sh
```

The script is POSIX `sh`, uses only Node.js and standard shell tools, creates
its fixture under `mktemp -d`, and removes it on exit. It blanks every
toolchain override so a real host installation cannot leak into the result.
`NPM_CONFIG_PREFIX` points at an empty fixture prefix, so no real global
install and no network call are involved.

## Captured run

- **Date:** 2026-11-09 (UTC)
- **Machine:** macOS 27.2 (Darwin 27.2.0), arm64
- **Node.js:** v24.15.0
- **Source under test:** commit `37302b0` plus this milestone's tests and docs

The temporary path below is the `mktemp -d` directory for this run; it is
removed when the probe exits.

```console
$ sh docs/probes/toolchain-bins.sh
===== cargo: toolchain-probe-cargo-cli (installed at /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-toolchain-probe.Oiz6rO/home/.cargo/bin) =====
$ HOME="$HOME" PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin NPM_CONFIG_PREFIX="$PREFIX" \
    CLI_PATH_DOCTOR_SHELL="$SHELL_BIN" \
    CLI_PATH_DOCTOR_LOGIN_PATH="$PATH" \
    CLI_PATH_DOCTOR_NON_LOGIN_PATH="$PATH" \
    CLI_PATH_DOCTOR_DAEMON_PATH="$PATH" \
    /opt/homebrew/opt/node@24/bin/node bin/cli-path-doctor.mjs toolchain-probe-cargo-cli --json
{
  "command": "toolchain-probe-cargo-cli",
  "toolchain": "cargo",
  "directory": "/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-toolchain-probe.Oiz6rO/home/.cargo/bin",
  "candidate": {
    "path": "/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-toolchain-probe.Oiz6rO/home/.cargo/bin/toolchain-probe-cargo-cli",
    "toolchain": "cargo",
    "directorySource": "~/.cargo/bin",
    "executable": true
  },
  "hint": "installed at /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-toolchain-probe.Oiz6rO/home/.cargo/bin/toolchain-probe-cargo-cli but not on PATH",
  "fixes": [
    "export PATH='/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-toolchain-probe.Oiz6rO/home/.cargo/bin':\"$PATH\"  # add to ~/.zshrc, then open a new shell"
  ]
}
--- text stderr (the copy-paste fixes) ---
fixes:
  export PATH='/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-toolchain-probe.Oiz6rO/home/.cargo/bin':"$PATH"  # add to ~/.zshrc, then open a new shell
--- exit code: 1 ---

===== bun: toolchain-probe-bun-cli (installed at /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-toolchain-probe.Oiz6rO/home/.bun/bin) =====
$ HOME="$HOME" PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin NPM_CONFIG_PREFIX="$PREFIX" \
    CLI_PATH_DOCTOR_SHELL="$SHELL_BIN" \
    CLI_PATH_DOCTOR_LOGIN_PATH="$PATH" \
    CLI_PATH_DOCTOR_NON_LOGIN_PATH="$PATH" \
    CLI_PATH_DOCTOR_DAEMON_PATH="$PATH" \
    /opt/homebrew/opt/node@24/bin/node bin/cli-path-doctor.mjs toolchain-probe-bun-cli --json
{
  "command": "toolchain-probe-bun-cli",
  "toolchain": "bun",
  "directory": "/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-toolchain-probe.Oiz6rO/home/.bun/bin",
  "candidate": {
    "path": "/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-toolchain-probe.Oiz6rO/home/.bun/bin/toolchain-probe-bun-cli",
    "toolchain": "bun",
    "directorySource": "~/.bun/bin",
    "executable": true
  },
  "hint": "installed at /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-toolchain-probe.Oiz6rO/home/.bun/bin/toolchain-probe-bun-cli but not on PATH",
  "fixes": [
    "export PATH='/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-toolchain-probe.Oiz6rO/home/.bun/bin':\"$PATH\"  # add to ~/.zshrc, then open a new shell"
  ]
}
--- text stderr (the copy-paste fixes) ---
fixes:
  export PATH='/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-toolchain-probe.Oiz6rO/home/.bun/bin':"$PATH"  # add to ~/.zshrc, then open a new shell
--- exit code: 1 ---

===== volta: toolchain-probe-volta-cli (installed at /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-toolchain-probe.Oiz6rO/home/.volta/bin) =====
$ HOME="$HOME" PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin NPM_CONFIG_PREFIX="$PREFIX" \
    CLI_PATH_DOCTOR_SHELL="$SHELL_BIN" \
    CLI_PATH_DOCTOR_LOGIN_PATH="$PATH" \
    CLI_PATH_DOCTOR_NON_LOGIN_PATH="$PATH" \
    CLI_PATH_DOCTOR_DAEMON_PATH="$PATH" \
    /opt/homebrew/opt/node@24/bin/node bin/cli-path-doctor.mjs toolchain-probe-volta-cli --json
{
  "command": "toolchain-probe-volta-cli",
  "toolchain": "volta",
  "directory": "/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-toolchain-probe.Oiz6rO/home/.volta/bin",
  "candidate": {
    "path": "/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-toolchain-probe.Oiz6rO/home/.volta/bin/toolchain-probe-volta-cli",
    "toolchain": "volta",
    "directorySource": "~/.volta/bin",
    "executable": true
  },
  "hint": "installed at /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-toolchain-probe.Oiz6rO/home/.volta/bin/toolchain-probe-volta-cli but not on PATH",
  "fixes": [
    "export PATH='/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-toolchain-probe.Oiz6rO/home/.volta/bin':\"$PATH\"  # add to ~/.zshrc, then open a new shell"
  ]
}
--- text stderr (the copy-paste fixes) ---
fixes:
  export PATH='/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-toolchain-probe.Oiz6rO/home/.volta/bin':"$PATH"  # add to ~/.zshrc, then open a new shell
--- exit code: 1 ---

===== genuinely absent: toolchain-probe-absent-cli =====
$ HOME="$HOME" PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin NPM_CONFIG_PREFIX="$PREFIX" \
    CLI_PATH_DOCTOR_SHELL="$SHELL_BIN" \
    CLI_PATH_DOCTOR_LOGIN_PATH="$PATH" \
    CLI_PATH_DOCTOR_NON_LOGIN_PATH="$PATH" \
    CLI_PATH_DOCTOR_DAEMON_PATH="$PATH" \
    /opt/homebrew/opt/node@24/bin/node bin/cli-path-doctor.mjs toolchain-probe-absent-cli --json
{
  "command": "toolchain-probe-absent-cli",
  "candidates": [],
  "hint": null,
  "fixes": [
    "npm install -g 'toolchain-probe-absent-cli'"
  ]
}
--- text stderr (the copy-paste fixes) ---
fixes:
  npm install -g 'toolchain-probe-absent-cli'
--- exit code: 1 ---

OK: cargo, bun and volta binaries were named and fixed; the absent command kept the npm fallback
```

The contrast is the point: the three installed commands produce a toolchain
candidate, a "not on PATH" hint, and a PATH fix for the directory that holds
them. The absent command produces no candidate and keeps the npm fallback,
because there is no evidence that another toolchain installed it.

## Scope

The doctor reads the filesystem; it does not install or repair toolchains. A
directory is reported only when it actually contains a file with the requested
command name. A non-executable file gets a `chmod +x` fix instead of PATH
advice, and a broken symlink is reported as broken rather than treated as a
usable install.
