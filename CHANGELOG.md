# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.0]: https://github.com/WJDdidi-1/cli-path-doctor/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/WJDdidi-1/cli-path-doctor/releases/tag/v0.1.0
