# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-11-10

### Added

- A command that is present and executable but cannot start is now reported as
  `BROKEN` instead of `ok`. The doctor reads a script's shebang, so a missing or
  non-executable interpreter is named in text output and in
  `--json` (`status: "broken"`, `resolved: true`, `runnable: false`,
  `unrunnableReason`, exit code `1`). A plain non-executable file keeps its
  `MISS` reason and gets `chmod +x`, not an `npm install -g` line.
- A clean-install acceptance test packs the built package, installs the tarball
  into an isolated prefix, and verifies the installed doctor reports `BROKEN`
  for a bad-shebang script, `ok` for a real command, and the
  `npm install -g` fallback for an absent command.
- README now shows the `BROKEN` output and explains why a present-but-unrunnable
  file gets no install line, unlike a missing command. The captured
  clean-install run is in `docs/validation/unrunnable-clean-install.md`.

## [0.5.0] - 2026-11-10

### Added

- When more than one runnable copy of a command is on a context's PATH, the
  doctor resolves every copy, marks the first one as the winner, and reports the
  rest as shadowed. Text output names both paths (`(wins; shadows ...)`) and
  prints a `shadowed copies:` block on stderr, so a user running 1.0 can see
  that a 2.0 install exists later on PATH.
- `--json` exposes the shadowing evidence: per-context `copies` (with `winner`
  and `shadowed` flags) and `shadowedPaths`, plus top-level `copies`,
  `shadowed`, `shadowedPaths`, and a `shadowing` summary naming the winner and
  shadowed paths for each context.
- A documented probe (`docs/probes/shadowed-copies.sh`) with two real PATH
  copies and a repeated single copy; the captured run and the JSON fields are in
  `docs/shadowed-copies.md`.
- `test/shadowed-copies.test.mjs` covers the two-copy and single-copy cases and
  the rule that a non-executable file, a broken symlink, or an explicit path is
  not a PATH lookup that can be shadowed.

### Fixed

- A directory repeated on PATH is no longer counted as a second copy of the
  command, so the shadowing report stays quiet when there is only one install.
- A PATH fix is no longer proposed for a directory the context already
  searches; shadowed-copy reporting leaves the fix list empty when both copies
  are already reachable.

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

[0.6.0]: https://github.com/WJDdidi-1/cli-path-doctor/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/WJDdidi-1/cli-path-doctor/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/WJDdidi-1/cli-path-doctor/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/WJDdidi-1/cli-path-doctor/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/WJDdidi-1/cli-path-doctor/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/WJDdidi-1/cli-path-doctor/releases/tag/v0.1.0
