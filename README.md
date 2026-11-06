# cli-path-doctor

Diagnose why a CLI command is missing across shells, npm installs, and daemons.

## Who it is for

Developers and CI/release engineers who install CLIs with npm, apt, or curl, then invoke them from an interactive shell, a daemon, or a CI job.

## The problem

A documented command is absent, or resolves in one context but not another, because PATH, npm bin links, executable bits, and postinstall behavior differ between interactive shells, daemons, and CI. A bare 'command not found' gives no clue which layer broke.

## Why not the obvious answer

`which` and `command -v` only inspect the current process PATH and say nothing about login-shell startup, npm's bin field or link state, or the reduced PATH a daemon inherits. Reinstall instructions assume a clean environment and cannot distinguish a missing binary from a broken symlink or an unexported directory.

## Install

```sh
npm install -g cli-path-doctor
```

## Use

```sh
cli-path-doctor --help
```

## What the MVP does

- Run `cli-path-doctor <command>` to print one row per context (current, login, non-login, daemon-like) with the resolved path or a miss.
- Inspect local npm metadata: global prefix, `node_modules/.bin`, package `bin` entries, symlink targets, and executable bits.
- Name the first PATH directory present in a login shell but absent from the daemon/CI environment, when one exists.
- Print copy-paste fixes and exit 0 if any checked context resolves the command, otherwise exit 1.
- Support `--json` for CI and run fully offline with no account or network call.

## How we know it works

In a temp project, install a fixture package whose `bin` file is missing; `npx cli-path-doctor fixture-cmd` exits 1 and names the missing link; correct the bin and rerun to get exit 0; `cli-path-doctor sh` also exits 0.

## Status

Early MVP. The features above are the scope; anything not listed is not built yet.

## Licence

Apache-2.0.
