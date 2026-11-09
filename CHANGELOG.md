# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-11-09

### Added

- A command installed outside npm is now found in the user-level bin
  directories used by cargo/rustup, bun, volta, go, deno, pnpm, yarn, asdf,
  mise, pyenv, rbenv, and per-user installers such as pipx/uv. The doctor
  reports the installed path, names the toolchain and directory, and offers a
  PATH fix for that directory instead of an `npm install -g` line.
- `--json` exposes the whole search under `toolchains` (also `toolchain`):
  `directories`, `candidates` with `toolchain`/`directory`/`directorySource`,
  `preferred`, and `hint`. A configured location (`CARGO_HOME`, `BUN_INSTALL`,
  `VOLTA_HOME`, and others) is searched in addition to the toolchain default.
- A documented probe (`docs/probes/toolchain-bins.sh`) verifies cargo, bun, and
  volta binaries found off PATH, the PATH fix and rc file, and the npm fallback
  for a genuinely absent command. The captured run is in
  `docs/toolchain-search.md`.

## [0.3.0] - 2026-11-09

### Added

- POSIX PATH fixes name the shell startup file to edit: `~/.zshrc` for zsh,
  `~/.bashrc` for bash, and `~/.profile` for an unknown POSIX shell. Windows
  fixes name `$PROFILE`.
- `--json` now exposes `shellName` and `rcFile` alongside the existing `fixes`
  array, so tooling can read the same shell-aware advice.
- The `fixes` array is documented as the machine-readable copy of the stderr
  guidance: each POSIX PATH entry is one copy-pasteable line that embeds the
  startup file to edit (for example
  `export PATH='<dir>':"$PATH"  # add to ~/.bashrc, then open a new shell`).
  When no directory can contain the command, the array falls back to
  `npm install -g '<command>'`.
- A scripted probe (`docs/probes/shell-aware-fixes.sh`) verifies the shell
  mapping with `SHELL=/bin/zsh` and `SHELL=/bin/bash`. It asserts the JSON
  `rcFile` and `fixes` fields and the text stderr, and rejects the unrelated
  login-only directory and a needless reinstall. The commands, captured
  output, and assertions are recorded in `docs/shell-aware-fixes.md`.

### Fixed

- The doctor no longer suggests adding the first login-only PATH directory just
  because it differs between contexts. PATH advice is emitted only for a
  directory that actually contains the command (a resolved context or an npm
  bin candidate).
- When no context resolves the command and there is no npm evidence, the
  `npm install -g <command>` line is still printed as the actionable fix.

## [0.2.0] - 2026-11-08

### Added

- Global npm installs are inspected, not just the current project's
  `node_modules/.bin`. When a globally installed package declares the command,
  the doctor reads its `bin` entry under `<prefix>/lib/node_modules` (POSIX) or
  `<prefix>/node_modules` (Windows), checks the declared target file, and
  checks the link in `<prefix>/bin` (POSIX) or `<prefix>` (Windows) even when
  npm created no link because the target was missing.
- The `npm.packages` array in `--json` output includes globally installed
  packages, with the same `target`, `link`, `linkExists`, `exists`, `isFile`,
  `executable`, and `broken` fields used for local packages.

### Fixed

- A global install whose declared `bin` target is missing is now diagnosed
  instead of reported as a bare `not found on PATH`. Each context row names
  the globally installed package, its declared `bin` target, the missing target
  file, and the absent npm bin link. The suggested fix is
  `npm install -g <package>` (or `npm rebuild -g <package>`) for the package
  that declares the command, rather than treating the command name itself as
  the package to install.
- A global package whose target exists and is executable but whose npm bin link
  is missing is reported as an unlinked package instead of only a PATH miss.

### Changed

- Exit codes are unchanged: naming the broken npm layer does not pretend the
  command works. If every checked context misses, the exit code is still `1`.

## [0.1.0] - 2026-11-06

### Added

- `cli-path-doctor <command>` resolves the command in four PATH contexts
  (`current`, `login`, `non-login`, `daemon-like`) and prints one row per
  context.
- Local and global npm metadata inspection: the global prefix,
  `node_modules/.bin`, `<prefix>/bin`, package `bin` entries, symlink targets,
  and executable bits, including entries whose link was never created.
- The first PATH directory present in a login shell but absent from the
  daemon/CI environment, when one exists.
- Copy-paste fixes for PATH, `npm install`, and `chmod +x`, with human guidance
  on stderr so stdout stays one row per context.
- `--json` output and fully offline operation with no account or network call.
- Exit codes `0` (at least one context resolves), `1` (no context resolves), and
  `2` (usage error).

[0.4.0]: https://github.com/WJDdidi-1/cli-path-doctor/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/WJDdidi-1/cli-path-doctor/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/WJDdidi-1/cli-path-doctor/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/WJDdidi-1/cli-path-doctor/releases/tag/v0.1.0
