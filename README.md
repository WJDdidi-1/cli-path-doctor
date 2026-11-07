# cli-path-doctor

[![CI](https://github.com/WJDdidi-1/cli-path-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/WJDdidi-1/cli-path-doctor/actions/workflows/ci.yml)

Diagnose why a CLI command is missing across shells, npm installs, and daemons.

A bare `command not found` gives you no clue which layer broke. `cli-path-doctor`
resolves the command in four PATH contexts, inspects npm's global and local bin
links, and prints the layer that failed plus a copy-paste fix. It runs fully
offline: no account, no network call.

## Who it is for

Developers and CI/release engineers who install CLIs with npm, apt, or curl, then
invoke them from an interactive shell, a daemon, or a CI job.

## The problem

A documented command is absent, or resolves in one context but not another,
because PATH, npm bin links, executable bits, and postinstall behavior differ
between interactive shells, daemons, and CI. `which` and `command -v` only
inspect the current process PATH; they say nothing about login-shell startup,
npm's `bin` field or link state, or the reduced PATH a daemon inherits.

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
# 0.1.0

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
lookup honors `PATHEXT`, and fixes are printed in PowerShell form.

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
  export PATH='/tmp/path-doctor-demo/bin':"$PATH"
$ echo $?
0
```

Reading the output:

- stdout contains exactly one row per context. Each row is a resolved path or
  `MISS` with the reason.
- Human guidance (`first login-only PATH directory` and `fixes`) goes to
  stderr, so `cli-path-doctor <command> | ...` stays one row per line.
- The exit code is `0` because at least one checked context resolves the
  command. If every row is `MISS`, the exit code is `1`.
- The `daemon-like` row names the first directory that the login shell adds and
  the daemon PATH lacks, which is the layer that broke.

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
login-only directory, and stderr prints the matching PATH fix (`export PATH=`
on POSIX, `$env:Path` on Windows). It is cross-platform, has no dependencies,
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

### JSON output

`--json` is intended for CI and for tooling. The top-level object contains:

| Key | Meaning |
| --- | --- |
| `command`, `resolved`, `anyResolved`, `exitCode` | The command and overall outcome. |
| `path` | The first resolved path, if any. |
| `contexts` (also `rows`) | One entry per context with `status`, `resolved`, `path`, `realPath`, `symlink`, `linkTarget`, `reason`, `searchPath`, `source`, `note`, and `reliable`. |
| `shell` | The shell used for probing, or `null` on Windows. |
| `loginOnlyDirectory` | The first login-only PATH directory, or `null`. |
| `fixes` | Copy-paste fixes, as an array of strings. |
| `npm` | `prefix`, `globalPrefix`, `preferred`, `candidates`, `local`, `global`, `packages`, `hint`, and `fixes`. |

`npm.packages` includes package `bin` declarations even when the
`node_modules/.bin` link was never created, and reports the target, link,
symlink target, executable bit, and broken/missing state.

## What the MVP does

- Run `cli-path-doctor <command>` to print one row per context (current, login,
  non-login, daemon-like) with the resolved path or a miss.
- Inspect local npm metadata: global prefix, `node_modules/.bin`, package `bin`
  entries, symlink targets, and executable bits. It reads package `bin`
  declarations even when the `.bin` link was never created.
- Name the first PATH directory present in a login shell but absent from the
  daemon/CI environment, when one exists.
- Print copy-paste fixes (the shell `export PATH=...` form, `npm install`, or
  `chmod +x` as appropriate). Human guidance goes to stderr so stdout stays one
  row per context.
- Support `--json` and run fully offline with no account or network call.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | At least one checked context resolves the command (or help/version was printed). |
| `1` | No checked context resolves the command. |
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
under `NPM_CONFIG_PREFIX`, the first login-only PATH directory, copy-paste fixes,
and offline `--json` output.

## Status

Early MVP. The features listed above are the scope; anything not listed is not
built yet.

## License

Apache-2.0. See [LICENSE](LICENSE).
