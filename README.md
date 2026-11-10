# cli-path-doctor

[![CI](https://github.com/WJDdidi-1/cli-path-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/WJDdidi-1/cli-path-doctor/actions/workflows/ci.yml)
[![version](https://img.shields.io/badge/version-0.6.0-blue)](https://github.com/WJDdidi-1/cli-path-doctor/blob/main/CHANGELOG.md)

Diagnose why a CLI command is missing across shells, npm installs, toolchains,
and daemons.

A bare `command not found` gives you no clue which layer broke. `cli-path-doctor`
resolves the command in four PATH contexts, inspects npm's global and local bin
links, searches the user-level bin directories used by cargo, bun, volta, go and
other toolchains, and prints the layer that failed plus a copy-paste fix. When a
second copy of the command is earlier on PATH, it names both copies and says
which one wins. It runs fully offline: no account, no network call.

## Who it is for

Developers and CI/release engineers who install CLIs with npm, cargo, bun, volta,
go, pipx/uv, apt, or curl, then invoke them from an interactive shell, a daemon,
or a CI job.

## Releases

This tree is version **0.6.0**. Release tags follow `v<version>`, so its tag is
`v0.6.0`. The [CHANGELOG](https://github.com/WJDdidi-1/cli-path-doctor/blob/main/CHANGELOG.md)
describes what shipped in each version. Version 0.6.0 reports a command that is
present and executable but cannot start as `BROKEN` instead of `ok`: the doctor
reads its shebang and names the missing or non-executable interpreter in text and
`--json`, and it keeps a plain non-executable file on the `chmod +x` path.
Version 0.5.0 shipped shadowed-copy reporting: when more than one runnable copy
of the command is on PATH, the doctor names the winner and every shadowed copy in
text and `--json`, and it stops proposing PATH entries for directories the shell
already searches. Version 0.4.0 shipped the user-level toolchain search: a
command installed by cargo, bun, volta, go, or another toolchain is found even
when its bin directory is missing from PATH, and the fix names that directory
instead of suggesting `npm install -g`. Version 0.3.0 shipped shell-aware PATH
fixes: every POSIX fix names the startup file to edit (`~/.zshrc`, `~/.bashrc`,
...), and `--json` exposes `shellName` and `rcFile`. Version 0.2.0 shipped the
global broken-`bin`-target diagnosis measured below.

## The problem

A documented command is absent, or resolves in one context but not another,
because PATH, npm bin links, toolchain bin directories, executable bits, and
postinstall behavior differ between interactive shells, daemons, and CI.
`which` and `command -v` only inspect the current process PATH; they say nothing
about login-shell startup, npm's `bin` field or link state, the user-level
directory where cargo, bun, volta, or go installed the binary, or the reduced
PATH a daemon inherits.

## Install

Requires Node.js 18 or newer. The package has no runtime dependencies.

```sh
# From npm
npm install -g cli-path-doctor

# Straight from GitHub
npm install -g github:WJDdidi-1/cli-path-doctor

# From a local checkout
git clone https://github.com/WJDdidi-1/cli-path-doctor.git
cd cli-path-doctor
npm install -g .
```

You can also run it without installing:

```sh
npx cli-path-doctor <command>
```

Verify that the bin link is on your PATH:

```sh
cli-path-doctor --version
# 0.6.0

# POSIX
command -v cli-path-doctor

# Windows (PowerShell or cmd)
where.exe cli-path-doctor
```

If the install succeeded but the command still is not found, ask the doctor
about itself from the checkout:

```sh
node ./bin/cli-path-doctor.mjs cli-path-doctor
```

## Use

```sh
cli-path-doctor <command>            # one row per context
cli-path-doctor <command> --json     # machine-readable output
cli-path-doctor <command> --verbose  # add shell/PATH details to stdout
cli-path-doctor --help
cli-path-doctor --version
```

| Context | What it represents |
| --- | --- |
| `current` | The PATH of the process running the doctor (your shell, CI job, or daemon). |
| `login` | The PATH reported by a login shell (`$SHELL -l -c`), falling back to a non-login probe. |
| `non-login` | The PATH reported by a non-login shell (`$SHELL -c`). |
| `daemon-like` | A minimal system PATH of the kind launchd, systemd, or a CI runner starts with. |

On Windows there is no portable login/non-login shell convention, so those rows
use the process PATH unless you supply the overrides described below. Command
lookup honors `PATHEXT`, and fixes name `$PROFILE` in PowerShell form. On POSIX
a PATH fix names the startup file for the detected shell (`~/.zshrc` for zsh,
`~/.bashrc` for bash, and `~/.profile` for an unknown POSIX shell).

### A real session

The following is a captured session. It puts a `demo-cli` executable in a
directory that only the `login` context is told about, which reproduces a
classic "works in my shell, not in the daemon" failure:

```console
$ mkdir -p /tmp/path-doctor-demo/bin
$ printf '#!/bin/sh\nexit 0\n' > /tmp/path-doctor-demo/bin/demo-cli
$ chmod +x /tmp/path-doctor-demo/bin/demo-cli

$ CLI_PATH_DOCTOR_LOGIN_PATH=/tmp/path-doctor-demo/bin:/usr/bin:/bin \
    CLI_PATH_DOCTOR_NON_LOGIN_PATH=/usr/bin:/bin \
    CLI_PATH_DOCTOR_DAEMON_PATH=/usr/bin:/bin \
    cli-path-doctor demo-cli
current      MISS (not found on PATH)
login        /tmp/path-doctor-demo/bin/demo-cli
non-login    MISS (not found on PATH)
daemon-like  MISS (not found on PATH; login shell adds /tmp/path-doctor-demo/bin, which this PATH lacks)
first login-only PATH directory: /tmp/path-doctor-demo/bin
fixes:
  export PATH='/tmp/path-doctor-demo/bin':"$PATH"  # add to ~/.zshrc, then open a new shell
$ echo $?
0
```

Reading the output:

- stdout contains exactly one row per context. Each row is a resolved path,
  `BROKEN` with the reason (the file was found but cannot start), or `MISS`
  with the reason. When a context has more than one copy, the row names the
  winning path first and lists every copy it shadows.
- Human guidance (`first login-only PATH directory`, `shadowed copies`, and
  `fixes`) goes to stderr, so `cli-path-doctor <command> | ...` stays one row
  per line.
- A PATH fix is only offered for a directory that actually contains the command
  and is not already on the current PATH. The login-only directory is explained,
  but it is not suggested just because it differs between contexts. When the
  command is missing everywhere, the doctor prints the `npm install -g` line
  only if neither npm metadata nor a searched toolchain directory contains it.
- Each POSIX PATH fix names the shell startup file to edit, so the advice can be
  followed without guessing where PATH is set.
- The exit code is `0` because at least one checked context can run the
  command. If every row is `MISS` or `BROKEN`, the exit code is `1`.
- The `daemon-like` row names the first directory that the login shell adds and
  the daemon PATH lacks, which is the layer that broke.

### Found, but it cannot start

An executable file is not necessarily a command that runs. A script whose
shebang names a missing interpreter is present on PATH, but the kernel cannot
start it. The doctor reads the shebang and reports `BROKEN` instead of a
resolved path:

```console
$ mkdir -p /tmp/path-doctor-broken-demo/bin
$ printf '#!/nonexistent/interpreter\necho nope\n' > /tmp/path-doctor-broken-demo/bin/broken-cli
$ chmod +x /tmp/path-doctor-broken-demo/bin/broken-cli

$ broken_path=/tmp/path-doctor-broken-demo/bin:$PATH
$ PATH="$broken_path" \
    CLI_PATH_DOCTOR_LOGIN_PATH="$broken_path" \
    CLI_PATH_DOCTOR_NON_LOGIN_PATH="$broken_path" \
    CLI_PATH_DOCTOR_DAEMON_PATH="$broken_path" \
    cli-path-doctor broken-cli
current      BROKEN (found at /tmp/path-doctor-broken-demo/bin/broken-cli but shebang interpreter /nonexistent/interpreter does not exist)
login        BROKEN (found at /tmp/path-doctor-broken-demo/bin/broken-cli but shebang interpreter /nonexistent/interpreter does not exist)
non-login    BROKEN (found at /tmp/path-doctor-broken-demo/bin/broken-cli but shebang interpreter /nonexistent/interpreter does not exist)
daemon-like  BROKEN (found at /tmp/path-doctor-broken-demo/bin/broken-cli but shebang interpreter /nonexistent/interpreter does not exist)
$ echo $?
1
```

The repair is not an install. The file already exists; the missing piece is the
interpreter on its first line, so the doctor prints no `npm install -g` line.
Edit the shebang (or reinstall the package that owns the script) and re-run the
doctor. A command that really is absent is different: no file was found, so the
install fallback is the only actionable advice:

```console
$ cli-path-doctor definitely-not-installed-cli
current      MISS (not found on PATH)
login        MISS (not found on PATH)
non-login    MISS (not found on PATH)
daemon-like  MISS (not found on PATH)
fixes:
  npm install -g 'definitely-not-installed-cli'
$ echo $?
1
```

`--json` carries the same distinction: a present-but-unrunnable file has
`status: "broken"`, `resolved: true`, `runnable: false`, `exitCode: 1`, and an
`unrunnableReason`, while a genuinely absent command is `status: "miss"` with
`resolved: false`. A normal command still has `status: "ok"`, `runnable: true`,
and exit code `0`. A file that only lacks the execute bit stays `MISS` and gets
`chmod +x`, not an install. The verdict above was verified from a clean
`npm pack` + `npm install -g` of the built package; the exact run is in
[`docs/validation/unrunnable-clean-install.md`](https://github.com/WJDdidi-1/cli-path-doctor/blob/main/docs/validation/unrunnable-clean-install.md).

### Two installs, one winner (shadowing)

A Homebrew install plus an npm install is a normal way to end up with two copies
of the same command. Whichever directory comes first on PATH runs, and the other
copy is silently shadowed. The doctor reports both:

```console
$ mkdir -p /tmp/path-doctor-shadow-demo/a/bin /tmp/path-doctor-shadow-demo/b/bin
$ printf '#!/bin/sh\necho 1.0\n' > /tmp/path-doctor-shadow-demo/a/bin/demo-cli
$ printf '#!/bin/sh\necho 2.0\n' > /tmp/path-doctor-shadow-demo/b/bin/demo-cli
$ chmod +x /tmp/path-doctor-shadow-demo/a/bin/demo-cli /tmp/path-doctor-shadow-demo/b/bin/demo-cli

$ shadow_path=/tmp/path-doctor-shadow-demo/a/bin:/tmp/path-doctor-shadow-demo/b/bin:$PATH
$ PATH="$shadow_path" \
    CLI_PATH_DOCTOR_LOGIN_PATH="$shadow_path" \
    CLI_PATH_DOCTOR_NON_LOGIN_PATH="$shadow_path" \
    CLI_PATH_DOCTOR_DAEMON_PATH="$shadow_path" \
    cli-path-doctor demo-cli
current      /tmp/path-doctor-shadow-demo/a/bin/demo-cli (wins; shadows /tmp/path-doctor-shadow-demo/b/bin/demo-cli)
login        /tmp/path-doctor-shadow-demo/a/bin/demo-cli (wins; shadows /tmp/path-doctor-shadow-demo/b/bin/demo-cli)
non-login    /tmp/path-doctor-shadow-demo/a/bin/demo-cli (wins; shadows /tmp/path-doctor-shadow-demo/b/bin/demo-cli)
daemon-like  /tmp/path-doctor-shadow-demo/a/bin/demo-cli (wins; shadows /tmp/path-doctor-shadow-demo/b/bin/demo-cli)
shadowed copies:
  current: /tmp/path-doctor-shadow-demo/a/bin/demo-cli wins; shadowed: /tmp/path-doctor-shadow-demo/b/bin/demo-cli
  login: /tmp/path-doctor-shadow-demo/a/bin/demo-cli wins; shadowed: /tmp/path-doctor-shadow-demo/b/bin/demo-cli
  non-login: /tmp/path-doctor-shadow-demo/a/bin/demo-cli wins; shadowed: /tmp/path-doctor-shadow-demo/b/bin/demo-cli
  daemon-like: /tmp/path-doctor-shadow-demo/a/bin/demo-cli wins; shadowed: /tmp/path-doctor-shadow-demo/b/bin/demo-cli
```

The winning directory is already on every listed PATH, so there is deliberately
no `export PATH=...` fix: exporting it again would be noise. A repeated PATH
entry is not reported as a second copy, and a non-executable file or broken
symlink is not a runnable copy.

With `--json`, every context carries `copies` (each entry has `path`,
`directory`, `realPath`, `symlink`, `linkTarget`, `winner`, and `shadowed`) and
`shadowedPaths`. The top-level object also has a unique `copies` list (the same
copy seen in several contexts is one entry with `contexts`, `winnerIn`, and
`shadowedIn`), a `copiesByContext` map, flat `shadowed`/`shadowedPaths`
lists, and a `shadowing` summary with the winner and shadowed paths per context.
The reproducible two-copy fixture, the single-copy check, and a captured run are
in [`docs/shadowed-copies.md`](https://github.com/WJDdidi-1/cli-path-doctor/blob/main/docs/shadowed-copies.md).

### Run the example yourself

[`examples/path-gap.mjs`](https://github.com/WJDdidi-1/cli-path-doctor/blob/main/examples/path-gap.mjs)
reproduces that session for real. It creates a temporary
`demo-path-doctor-<pid>` executable, gives only the `login` context a PATH that
contains it, runs the doctor, and checks the diagnosis:

```sh
# from a checkout
node examples/path-gap.mjs

# or through the package script
npm run example
```

The script prints the doctor's actual output and exits `0` only when `current`
and `non-login` miss, `login` resolves, the `daemon-like` row names the
login-only directory, and stderr prints the matching PATH fix with the shell
startup file to edit (`~/.zshrc`/`~/.bashrc` or `~/.profile` on POSIX, `$PROFILE`
on Windows). It is cross-platform, has no dependencies,
makes no network call, and cleans up its temp directory. See
[`examples/README.md`](https://github.com/WJDdidi-1/cli-path-doctor/blob/main/examples/README.md)
for the captured output and the exact checks.

### A real npm session

The doctor also reads npm metadata even when the link is not on PATH. Here a
`node_modules/.bin` link points at a package target that was never installed:

```console
$ mkdir -p /tmp/path-doctor-npm-demo/node_modules/.bin
$ cd /tmp/path-doctor-npm-demo
$ ln -s ../demo-pkg/cli.js node_modules/.bin/demo-cli

$ cli-path-doctor demo-cli
current      MISS (not found on PATH; broken npm bin link /private/tmp/path-doctor-npm-demo/node_modules/.bin/demo-cli -> ../demo-pkg/cli.js)
login        MISS (not found on PATH; broken npm bin link /private/tmp/path-doctor-npm-demo/node_modules/.bin/demo-cli -> ../demo-pkg/cli.js)
non-login    MISS (not found on PATH; broken npm bin link /private/tmp/path-doctor-npm-demo/node_modules/.bin/demo-cli -> ../demo-pkg/cli.js)
daemon-like  MISS (not found on PATH; broken npm bin link /private/tmp/path-doctor-npm-demo/node_modules/.bin/demo-cli -> ../demo-pkg/cli.js)
fixes:
  rm -f '/private/tmp/path-doctor-npm-demo/node_modules/.bin/demo-cli'
  (cd '/private/tmp/path-doctor-npm-demo' && npm install)
$ echo $?
1
```

(`/tmp` resolves to `/private/tmp` on macOS, which is why the captured paths
look longer than the setup commands.) The doctor found the npm layer even though
the link was never on PATH, and it distinguished a broken link from a missing
binary, a non-executable file, and a missing package `bin` target.

### A real toolchain session (cargo)

The doctor also searches the directories where modern toolchains install
commands, even when those directories are not on PATH. Here `rg` exists at
`~/.cargo/bin/rg` under a probe HOME, and no checked PATH contains
`~/.cargo/bin`:

```console
$ home=/tmp/path-doctor-cargo-demo
$ rm -rf "$home" && mkdir -p "$home/.cargo/bin"
$ printf '#!/bin/sh\nexit 0\n' > "$home/.cargo/bin/rg"
$ chmod +x "$home/.cargo/bin/rg"
$ base=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

$ HOME="$home" \
    CLI_PATH_DOCTOR_LOGIN_PATH="$base" \
    CLI_PATH_DOCTOR_NON_LOGIN_PATH="$base" \
    CLI_PATH_DOCTOR_DAEMON_PATH="$base" \
    PATH="$base" \
    node ./bin/cli-path-doctor.mjs rg
current      MISS (not found on PATH; installed at /tmp/path-doctor-cargo-demo/.cargo/bin/rg but not on PATH)
login        MISS (not found on PATH; installed at /tmp/path-doctor-cargo-demo/.cargo/bin/rg but not on PATH)
non-login    MISS (not found on PATH; installed at /tmp/path-doctor-cargo-demo/.cargo/bin/rg but not on PATH)
daemon-like  MISS (not found on PATH; installed at /tmp/path-doctor-cargo-demo/.cargo/bin/rg but not on PATH)
fixes:
  export PATH='/tmp/path-doctor-cargo-demo/.cargo/bin':"$PATH"  # add to ~/.zshrc, then open a new shell
$ echo $?
1
```

The rows name the installed binary, and the fix names the directory to add plus
the startup file for the detected shell. There is no `npm install -g` line,
because `rg` was not installed with npm. The search covers these directories,
in this order. A configured location is searched before its default, and a
directory is searched once even when several variables point at it:

| Toolchain | Directories searched |
| --- | --- |
| Rust / cargo | `$CARGO_HOME/bin` (when set), then `~/.cargo/bin` |
| Bun | `$BUN_INSTALL/bin` (when set), then `~/.bun/bin` |
| Volta | `$VOLTA_HOME/bin` (when set), then `~/.volta/bin`; `%LOCALAPPDATA%\Volta\bin` on Windows |
| Go | `$GOBIN` (when set), each `$GOPATH/bin` (when set), then `~/go/bin` |
| Deno | `$DENO_INSTALL/bin` (when set), then `~/.deno/bin` |
| pnpm | `$PNPM_HOME` (when set), then `~/.local/share/pnpm` and `~/Library/pnpm`; `%LOCALAPPDATA%\pnpm` on Windows |
| Yarn classic | `~/.yarn/bin` |
| asdf | `$ASDF_DATA_DIR/shims` (when set), then `~/.asdf/shims` |
| mise | `$MISE_DATA_DIR/shims` (when set), then `~/.local/share/mise/shims` |
| pyenv | `$PYENV_ROOT/shims` (when set), then `~/.pyenv/shims` |
| rbenv | `$RBENV_ROOT/shims` (when set), then `~/.rbenv/shims` |
| Per-user installers | `~/.local/bin` (pipx, uv, standalone tools) |

A configured variable is searched in addition to the default directory, so
setting `CARGO_HOME` or `BUN_INSTALL` does not hide a binary that still lives in
the default location. A binary found in a non-executable state gets a
`chmod +x` fix; a broken link is reported as broken and is not turned into PATH
advice. A command that is absent from every directory in this table still gets
the fallback `npm install -g '<command>'` line, because there is no toolchain
evidence to name. `--json` exposes the whole search under `toolchains`.

The exact list lives in
[`lib/toolchain-metadata.mjs`](https://github.com/WJDdidi-1/cli-path-doctor/blob/main/lib/toolchain-metadata.mjs).
[`test/toolchain-bins.test.mjs`](https://github.com/WJDdidi-1/cli-path-doctor/blob/main/test/toolchain-bins.test.mjs)
asserts every default and configured directory, a cargo/bun/volta binary found
off PATH, and the npm fallback for a genuinely absent command.
[`docs/toolchain-search.md`](https://github.com/WJDdidi-1/cli-path-doctor/blob/main/docs/toolchain-search.md)
records a reproducible probe of that behavior.

### A real broken global install (measured)

The session above is a local `.bin` link. The harder case is a *global* install:
`npm install -g` exits `0`, the package is on disk, and the command still does
not exist because the package's declared `bin` target was never shipped.

The measurement below was taken on 2026-11-09 on macOS arm64 with Node 24.15.0
and npm 11.12.1. Build a fixture whose `bin` points at a file that does not
exist, and install it globally into an isolated prefix:

```sh
demo=/tmp/path-doctor-global-demo
rm -rf "$demo"
mkdir -p "$demo/fixture-package/bin" "$demo/prefix"

cat > "$demo/fixture-package/package.json" <<'JSON'
{
  "name": "broken-global-cli-fixture",
  "version": "0.0.1",
  "bin": { "demo-cli": "bin/missing.js" }
}
JSON
echo fixture > "$demo/fixture-package/bin/keep.txt"

export NPM_CONFIG_PREFIX="$demo/prefix"
export NPM_CONFIG_CACHE="$demo/.npm-cache"
(cd "$demo/fixture-package" && npm pack --pack-destination "$demo" >/dev/null)
npm install -g "$demo/broken-global-cli-fixture-0.0.1.tgz" --ignore-scripts
```

npm reports success and installs the package, but it creates no `demo-cli`
link: the target does not exist, so `<prefix>/bin` is never created. Pin the
shell contexts so PATH is not a second variable:

```sh
export CLI_PATH_DOCTOR_LOGIN_PATH=/usr/bin:/bin
export CLI_PATH_DOCTOR_NON_LOGIN_PATH=/usr/bin:/bin
export CLI_PATH_DOCTOR_DAEMON_PATH=/usr/bin:/bin
```

Before the fix, the published `cli-path-doctor@0.1.0` was installed outside the
fixture prefix and run against this install:

```sh
NPM_CONFIG_PREFIX=/tmp/path-doctor-published npm install -g cli-path-doctor@0.1.0
```

```console
$ /tmp/path-doctor-published/bin/cli-path-doctor demo-cli
current      MISS (not found on PATH)
login        MISS (not found on PATH)
non-login    MISS (not found on PATH)
daemon-like  MISS (not found on PATH)
fixes:
  npm install -g 'demo-cli'
$ echo $?
1
```

That is the gap 0.1.0 leaves: it never names `broken-global-cli-fixture` or the
missing `bin/missing.js` target, and its fix treats the *command* `demo-cli` as
the package to install.

After the fix, the same fixture run through this checkout's code:

```console
$ node ./bin/cli-path-doctor.mjs demo-cli
current      MISS (not found on PATH; globally installed package broken-global-cli-fixture declares bin demo-cli -> /tmp/path-doctor-global-demo/prefix/lib/node_modules/broken-global-cli-fixture/bin/missing.js but the target file is missing; npm bin link /tmp/path-doctor-global-demo/prefix/bin/demo-cli is missing)
login        MISS (not found on PATH; globally installed package broken-global-cli-fixture declares bin demo-cli -> /tmp/path-doctor-global-demo/prefix/lib/node_modules/broken-global-cli-fixture/bin/missing.js but the target file is missing; npm bin link /tmp/path-doctor-global-demo/prefix/bin/demo-cli is missing)
non-login    MISS (not found on PATH; globally installed package broken-global-cli-fixture declares bin demo-cli -> /tmp/path-doctor-global-demo/prefix/lib/node_modules/broken-global-cli-fixture/bin/missing.js but the target file is missing; npm bin link /tmp/path-doctor-global-demo/prefix/bin/demo-cli is missing)
daemon-like  MISS (not found on PATH; globally installed package broken-global-cli-fixture declares bin demo-cli -> /tmp/path-doctor-global-demo/prefix/lib/node_modules/broken-global-cli-fixture/bin/missing.js but the target file is missing; npm bin link /tmp/path-doctor-global-demo/prefix/bin/demo-cli is missing)
fixes:
  npm install -g 'broken-global-cli-fixture'
$ echo $?
1
```

Every row now names the globally installed package, the `bin` declaration, the
missing target, and the absent link, and the fix reinstalls the package that
declares the command. The exit code is still `1`, because naming the broken
layer does not pretend the command works.

The other shape is a correct install whose prefix `bin` directory is not on
PATH. A fixture that ships its target installs cleanly:

```sh
demo=/tmp/path-doctor-global-demo-ok
rm -rf "$demo"
mkdir -p "$demo/fixture-package/bin" "$demo/prefix"

cat > "$demo/fixture-package/package.json" <<'JSON'
{
  "name": "unlisted-global-cli-fixture",
  "version": "0.0.1",
  "bin": { "demo-ok": "bin/demo-ok.js" }
}
JSON
cat > "$demo/fixture-package/bin/demo-ok.js" <<'JS'
#!/usr/bin/env node
console.log('demo-ok');
JS
chmod +x "$demo/fixture-package/bin/demo-ok.js"

export NPM_CONFIG_PREFIX="$demo/prefix"
export NPM_CONFIG_CACHE="$demo/.npm-cache"
(cd "$demo/fixture-package" && npm pack --pack-destination "$demo" >/dev/null)
npm install -g "$demo/unlisted-global-cli-fixture-0.0.1.tgz" --ignore-scripts
```

`<prefix>/bin/demo-ok` then exists and points at the real target. Published
0.1.0 already explains this case:

```console
$ NPM_CONFIG_PREFIX=/tmp/path-doctor-global-demo-ok/prefix \
    /tmp/path-doctor-published/bin/cli-path-doctor demo-ok
current      MISS (not found on PATH; npm bin exists at /tmp/path-doctor-global-demo-ok/prefix/bin/demo-ok but is not on this PATH)
login        MISS (not found on PATH; npm bin exists at /tmp/path-doctor-global-demo-ok/prefix/bin/demo-ok but is not on this PATH)
non-login    MISS (not found on PATH; npm bin exists at /tmp/path-doctor-global-demo-ok/prefix/bin/demo-ok but is not on this PATH)
daemon-like  MISS (not found on PATH; npm bin exists at /tmp/path-doctor-global-demo-ok/prefix/bin/demo-ok but is not on this PATH)
fixes:
  export PATH='/tmp/path-doctor-global-demo-ok/prefix/bin':"$PATH"  # add to ~/.zshrc, then open a new shell
$ echo $?
1
```

So the measured gap is specific: 0.1.0 handles a global `bin` link whose
directory is missing from PATH, and does not handle a declared `bin` whose
target file is missing. Version `0.2.0` ships the fix (commit `c9c9fbd`, covered
by `test/global-install.test.mjs`), so installing `cli-path-doctor@0.2.0`
produces the after behavior shown above. The full raw captures, JSON excerpt,
and exact setup are in
[`docs/measured-global-install.md`](https://github.com/WJDdidi-1/cli-path-doctor/blob/main/docs/measured-global-install.md).

### JSON output

`--json` is intended for CI and for tooling. The top-level object contains:

| Key | Meaning |
| --- | --- |
| `command`, `status`, `resolved`, `runnable`, `anyResolved`, `anyRunnable`, `exitCode` | The command and overall outcome. `status` is `ok`, `broken` (found but cannot start), or `miss`. |
| `path` | The first resolved path, if any. For a broken command it names the file that cannot start. |
| `contexts` (also `rows`) | One entry per context with `status`, `resolved`, `runnable`, `unrunnableReason`, `path`, `realPath`, `symlink`, `linkTarget`, `copies`, `shadowed`, `shadowedPaths`, `reason`, `searchPath`, `source`, `note`, and `reliable`. |
| `copies` | Every distinct runnable copy found across the contexts, in first-seen PATH order. Each entry adds `context` (first context that saw it), `contexts`, `command`, `winnerIn`, and `shadowedIn`. |
| `copiesByContext` | Each context's own resolution order, keyed by context name. |
| `shadowed` | The subset of `copies` that a winner hides in at least one context. |
| `shadowedPaths` | The paths from `shadowed`, as strings. |
| `shadowing` | Per-context `{ context, winner, copies, shadowed }` entries, only for contexts with a shadowed copy. |
| `shell` | The shell used for probing, or `null` on Windows. |
| `shellName` | The detected shell's basename (`zsh`, `bash`, ...), or `null` if unknown. |
| `rcFile` | The startup file a PATH fix tells you to edit (`~/.zshrc`, `~/.bashrc`, ...), or `null` on Windows. |
| `loginOnlyDirectory` | The first login-only PATH directory, or `null`. |
| `fixes` | Copy-paste fixes, as an array of strings. POSIX PATH fixes embed the startup file name. |
| `npm` | `prefix`, `globalPrefix`, `preferred`, `candidates`, `local`, `global`, `packages`, `hint`, and `fixes`. |
| `toolchains` (also `toolchain`) | `command`, `home`, `directories`, `candidates`, `preferred`, and `hint` for the user-level cargo, bun, volta, go, deno, pnpm, shim, and `~/.local/bin` search. |

`fixes` is the same array the default text mode writes to stderr, so tooling can
read the advice without scraping output. A POSIX PATH entry is one copy-pasteable
line that embeds the file to edit. For example, a bash run whose npm prefix bin
is `/tmp/path-doctor-demo/bin` returns (abridged to the shell and fix fields):

```json
{
  "shell": "/bin/bash",
  "shellName": "bash",
  "rcFile": "~/.bashrc",
  "fixes": [
    "export PATH='/tmp/path-doctor-demo/bin':\"$PATH\"  # add to ~/.bashrc, then open a new shell"
  ]
}
```

The top-level `rcFile` matches the file named inside the fix. When no checked
directory can contain the command, and there is neither npm evidence nor a
binary in a searched toolchain directory, `fixes` holds
`npm install -g '<command>'` instead. The zsh and bash mappings are verified by
a scripted probe, `sh docs/probes/shell-aware-fixes.sh`, which asserts both the
JSON fields and the text stderr; the captured run and assertions are in
[`docs/shell-aware-fixes.md`](https://github.com/WJDdidi-1/cli-path-doctor/blob/main/docs/shell-aware-fixes.md).

`npm.packages` includes package `bin` declarations even when the
`node_modules/.bin` link was never created, and reports the target, link,
symlink target, executable bit, and broken/missing state. `toolchains.candidates`
reports the same fields for a binary found in a user-level toolchain directory,
plus `toolchain`, `directory`, and `directorySource`; `toolchains.hint` is the
sentence embedded in a `MISS` row.

## What the MVP does

- Run `cli-path-doctor <command>` to print one row per context (current, login,
  non-login, daemon-like) with the resolved path or a miss.
- List every runnable copy of the command on each context's PATH, name the
  winner, report the shadowed copies, and expose the same evidence through
  `copies`/`shadowed`/`shadowing` in `--json`.
- Read a script's shebang and report a command that is present but cannot start
  (for example its interpreter is missing) as `BROKEN` with the reason. It
  keeps `resolved: true` but sets `runnable: false` and exits `1`, and it does
  not propose an install for a file that is already on disk.
- Inspect npm metadata for local and global installs: the global prefix,
  `node_modules/.bin`, `<prefix>/bin`, package `bin` entries, symlink targets,
  and executable bits. It reads package `bin` declarations even when the link
  was never created, including a global package whose declared target is
  missing.
- Search the user-level bin directories used by cargo/rustup, bun, volta, go,
  deno, pnpm, yarn, asdf, mise, pyenv, rbenv, and per-user installers such as
  pipx/uv (`~/.local/bin`). A binary found there is reported with its full path
  and suppresses the `npm install -g` line.
- Name the first PATH directory present in a login shell but absent from the
  daemon/CI environment, when one exists. That directory is only turned into a
  PATH fix when it actually contains the command.
- Print copy-paste fixes (the shell `export PATH=...` form, `npm install`, or
  `chmod +x` as appropriate). POSIX PATH fixes name the startup file for the
  detected shell (`~/.zshrc`, `~/.bashrc`, ...), and the install line is kept
  only when no checked directory or toolchain contains the command. A PATH fix
  is never emitted for a directory that the current PATH already searches.
  Human guidance goes to stderr so stdout stays one row per context.
- Support `--json` and run fully offline with no account or network call.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | At least one checked context can run the command (or help/version was printed). |
| `1` | No checked context can run the command: every row is `MISS` or `BROKEN`. |
| `2` | Usage error: missing command, too many arguments, or an unknown option. |

## Environment overrides

These are primarily for tests and deterministic CI output, but they are also
handy for reproducing a daemon's environment from a normal shell:

| Variable | Effect |
| --- | --- |
| `CLI_PATH_DOCTOR_SHELL` | Shell used for login/non-login probing (POSIX). |
| `CLI_PATH_DOCTOR_LOGIN_PATH` | Use this PATH for the `login` row instead of probing. |
| `CLI_PATH_DOCTOR_NON_LOGIN_PATH` | Use this PATH for the `non-login` row instead of probing. |
| `CLI_PATH_DOCTOR_DAEMON_PATH` | Use this PATH for the `daemon-like` row instead of the built-in minimal PATH. |

## FAQ

### Why does the doctor say MISS when I can run the command in my terminal?

The doctor resolves names through PATH. It does not use your shell's aliases or
functions, and it deliberately never starts an interactive shell, so names that
only exist after interactive startup files run can be missed. Ask your shell
what the name actually is, then rerun the check:

```sh
type node
cli-path-doctor node --verbose
```

`type` (POSIX) reports whether the name is an alias, a function, or a file on
PATH. If it is an alias or function, add it to the environment the daemon or CI
job uses, or invoke the real file by path.

### Why does it mention `~/.cargo/bin` when I installed with cargo?

The doctor searches the user-level directories where cargo, bun, volta, go and
other toolchains install commands. If it finds the binary there, it reports the
full path and offers a PATH export for that directory instead of
`npm install -g`, which would install a second, unrelated copy under npm's
prefix. Use `--json` and read `toolchains.candidates` to see which directory and
toolchain matched.

### Why do `login` and `non-login` show the same path as `current`?

Either your login startup does not change PATH, or the shell probe failed and
the row fell back to the current PATH. A fallback row is marked unreliable;
`--verbose` prints each row's source and any failure note:

```sh
cli-path-doctor node --verbose
```

On Windows the `login` and `non-login` rows use the process PATH unless you set
`CLI_PATH_DOCTOR_LOGIN_PATH` or `CLI_PATH_DOCTOR_NON_LOGIN_PATH`.

### Does it change my PATH or edit my shell profile?

No. It diagnoses and prints copy-paste fixes; it does not apply them. Human
guidance and fixes go to stderr, so on POSIX you can see just the four rows:

```sh
cli-path-doctor node 2>/dev/null
```

### Is `daemon-like` my real daemon's PATH?

No. It is a conservative built-in PATH
(`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` on POSIX), not
the PATH of launchd, systemd, or your CI runner. To check a real daemon's PATH,
copy it from that environment and override the row. For example, if the daemon
only sees `/usr/bin:/bin`:

```sh
CLI_PATH_DOCTOR_DAEMON_PATH="/usr/bin:/bin" cli-path-doctor node
```

On Windows the built-in value is derived from `SystemRoot`; the same override
works there.

### How do I use it in CI?

Use `--json` for machine-readable output and the exit code for pass/fail. Swap
`node` for the command your job needs:

```sh
cli-path-doctor node --json > path-doctor.json
```

Exit `0` means at least one checked context resolves the command, `1` means none
does, and `2` is a usage error. The output includes each context's
`searchPath`, the resolved path, and any fixes, so a failed job has a record of
the environment it ran in.

## Development

```sh
npm test
```

CI runs `npm test` on Ubuntu, macOS, and Windows with Node.js 18, 20, and 22,
and checks the publishable package contents with `npm pack --dry-run`. The tests
cover real PATH resolution, a non-executable file fixed with `chmod`, a broken
npm bin link, package `bin` entries whose link is missing, the npm global prefix
under `NPM_CONFIG_PREFIX`, a real `npm install -g` into an isolated prefix whose
declared `bin` target is missing, a real `npm pack` + `npm install -g` whose
bad-shebang command is reported `BROKEN` while a real command stays `ok`,
shell-aware PATH fixes for zsh and bash, a
found-but-off-PATH npm bin, the first login-only PATH directory, copy-paste
fixes, offline `--json` output, shadowed copies in text and `--json`, suppression
of PATH fixes for directories already searched, and user-level cargo, bun,
volta, and go bin directories (including `CARGO_HOME`, a non-executable
toolchain binary, a toolchain directory already on PATH, and npm metadata for
the same command losing to the toolchain evidence).

To re-run the shadowing verification with two real PATH copies and a repeated
single copy:

```sh
sh docs/probes/shadowed-copies.sh
```

It asserts the winner and shadowed path in text and `--json`, checks that no
useless PATH fix is offered, and confirms a repeated directory is not reported
as a second copy. The captured run is in
[`docs/shadowed-copies.md`](https://github.com/WJDdidi-1/cli-path-doctor/blob/main/docs/shadowed-copies.md).

To re-run the shell-aware verification against a real npm-prefix fixture:

```sh
sh docs/probes/shell-aware-fixes.sh
```

It prints the zsh and bash JSON excerpts and text fixes, and exits `0` only when
each names the right rc file. The captured run is in
[`docs/shell-aware-fixes.md`](https://github.com/WJDdidi-1/cli-path-doctor/blob/main/docs/shell-aware-fixes.md).

## Status

Early MVP, version 0.6.0. The features listed above are the scope; anything not
listed is not built yet.

The measured broken-install diagnosis ships in `cli-path-doctor@0.2.0`; the
before capture above is from the published 0.1.0. The [CHANGELOG](https://github.com/WJDdidi-1/cli-path-doctor/blob/main/CHANGELOG.md)
records every release. See
[`docs/measured-global-install.md`](https://github.com/WJDdidi-1/cli-path-doctor/blob/main/docs/measured-global-install.md)
for the before/after captures.

## License

Apache-2.0. See [LICENSE](LICENSE).
