# Verified: shadowed copies on PATH

This page records the verification for the epic milestone **"Cover the
shadowing case and document it"**. Before commit `3faf33c`, the doctor named
the first runnable copy and stayed silent about a later copy, so a user who
installed 2.0 could keep running 1.0 without any hint. It could also offer an
`export PATH=...` line for a directory that was already on PATH, which is noise
rather than a repair.

The merged implementation resolves every runnable copy on each context's PATH,
marks the first one as the winner, reports the rest as shadowed, and suppresses
PATH fixes for directories the context already searches.

## What the probe verifies

The probe is a real fixture, not a mocked payload. It creates two temporary bin
directories with executable copies of one command and puts them on every
checked PATH in that order:

- `<work>/a/bin/shadow-probe-cli` (the 1.0 copy)
- `<work>/b/bin/shadow-probe-cli` (the 2.0 copy)

For the two-copy case the probe asserts:

- Text stdout names both paths and marks the first `(wins; shadows ...)`.
- Text stderr prints a `shadowed copies:` block whose row names the winner and
  the loser.
- `--json` gives the current context `path` = the first copy, `copies` in PATH
  order with `winner`/`shadowed` flags, and `shadowedPaths` = the loser.
- The top-level `copies`, `shadowed`, `shadowedPaths`, and `shadowing` fields
  carry the same evidence; the `shadowing` entry names the winner and the
  shadowed path.
- No `fixes` entry exports either directory, because both are already on PATH.
- Both text and `--json` exit `0`: a resolved command is not a failure just
  because it is shadowed.

For the single-copy case the probe creates only `a/bin/shadow-probe-cli` and
**repeats its directory twice on PATH**. A repeated directory is not a second
copy. The probe asserts that text output has no `wins; shadows` suffix and no
`shadowed copies:` block, that the current context has one copy marked
`winner: true`, and that top-level `shadowed`, `shadowedPaths`, and `shadowing`
are all empty.

On POSIX, a non-executable file is not a copy because the shell cannot run it, and a
command written as an explicit path is not looked up on PATH, so neither can
produce shadowing evidence. Those rules live in `findCommandCopies` in
`lib/path-resolver.mjs`.

## The probe

Run it from the repository root (or from anywhere; the script resolves the
checkout itself):

```sh
sh docs/probes/shadowed-copies.sh
```

The script is POSIX `sh`, uses only Node.js and standard shell tools, creates
its fixture under `mktemp -d`, and removes it on exit. It points
`NPM_CONFIG_PREFIX` at an empty fixture prefix, blanks every toolchain override,
and sets all four context PATH values explicitly, so no real global install and
no network call are involved.

## Captured run

- **Date:** 2026-11-09 (UTC)
- **Machine:** macOS 27.2 (Darwin 27.2.0), arm64
- **Node.js:** v24.15.0
- **Source under test:** commit `3faf33c` plus this milestone's probe, test, and docs

The temporary path below is the `mktemp -d` directory for this run; it is
removed when the probe exits. It is shown verbatim so the output can be compared
with a local run.

```console
$ sh docs/probes/shadowed-copies.sh
===== case 1: two copies (/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/a/bin/shadow-probe-cli wins over /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/b/bin/shadow-probe-cli) =====
$ PATH="/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/a/bin:/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/b/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    CLI_PATH_DOCTOR_LOGIN_PATH="$PATH" \
    CLI_PATH_DOCTOR_NON_LOGIN_PATH="$PATH" \
    CLI_PATH_DOCTOR_DAEMON_PATH="$PATH" \
    /opt/homebrew/opt/node@24/bin/node bin/cli-path-doctor.mjs shadow-probe-cli
--- stdout ---
current      /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/a/bin/shadow-probe-cli (wins; shadows /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/b/bin/shadow-probe-cli)
login        /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/a/bin/shadow-probe-cli (wins; shadows /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/b/bin/shadow-probe-cli)
non-login    /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/a/bin/shadow-probe-cli (wins; shadows /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/b/bin/shadow-probe-cli)
daemon-like  /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/a/bin/shadow-probe-cli (wins; shadows /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/b/bin/shadow-probe-cli)
--- stderr (guidance) ---
shadowed copies:
  current: /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/a/bin/shadow-probe-cli wins; shadowed: /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/b/bin/shadow-probe-cli
  login: /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/a/bin/shadow-probe-cli wins; shadowed: /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/b/bin/shadow-probe-cli
  non-login: /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/a/bin/shadow-probe-cli wins; shadowed: /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/b/bin/shadow-probe-cli
  daemon-like: /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/a/bin/shadow-probe-cli wins; shadowed: /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/b/bin/shadow-probe-cli
--- exit code: 0 ---

{
  "context": "current",
  "winner": "/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/a/bin/shadow-probe-cli",
  "copies": [
    {
      "path": "/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/a/bin/shadow-probe-cli",
      "winner": true,
      "shadowed": false
    },
    {
      "path": "/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/b/bin/shadow-probe-cli",
      "winner": false,
      "shadowed": true
    }
  ],
  "shadowedPaths": [
    "/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/b/bin/shadow-probe-cli"
  ],
  "shadowing": {
    "context": "current",
    "winner": "/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/a/bin/shadow-probe-cli",
    "winnerPath": "/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/a/bin/shadow-probe-cli",
    "copies": [
      "/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/a/bin/shadow-probe-cli",
      "/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/b/bin/shadow-probe-cli"
    ],
    "shadowed": [
      "/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/b/bin/shadow-probe-cli"
    ]
  }
}
{
  "fixes": []
}
===== case 2: one copy, directory repeated on PATH =====
$ PATH="/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/a/bin:/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/a/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    CLI_PATH_DOCTOR_LOGIN_PATH="$PATH" \
    CLI_PATH_DOCTOR_NON_LOGIN_PATH="$PATH" \
    CLI_PATH_DOCTOR_DAEMON_PATH="$PATH" \
    /opt/homebrew/opt/node@24/bin/node bin/cli-path-doctor.mjs shadow-probe-cli
--- stdout ---
current      /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/a/bin/shadow-probe-cli
login        /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/a/bin/shadow-probe-cli
non-login    /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/a/bin/shadow-probe-cli
daemon-like  /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/a/bin/shadow-probe-cli
--- stderr (guidance) ---
--- exit code: 0 ---

{
  "context": "current",
  "winner": "/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/a/bin/shadow-probe-cli",
  "copies": [
    {
      "path": "/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shadow-probe.JRXrtW/a/bin/shadow-probe-cli",
      "winner": true,
      "shadowed": false
    }
  ],
  "shadowedPaths": [],
  "shadowed": [],
  "shadowing": []
}
OK: two copies named a winner and a shadowed copy without PATH noise; one repeated copy stayed quiet
```

The contrast is the point: two real copies produce a winner, a named shadowed
copy, and the same evidence in `--json`; one copy, even with its directory
repeated, produces no shadowing noise at all.

## Same cases in `npm test`

`test/shadowed-copies.test.mjs` covers the same two fixtures under the normal
test runner:

- "names both copies and says which one wins in text and JSON" asserts the text
  suffix, the stderr block, the per-context and top-level `--json` fields, and
  the absence of a PATH fix for either directory.
- "stays quiet when one copy is reachable, even if PATH repeats its directory"
  asserts the single-copy text output and empty `shadowed`/`shadowedPaths`/
  `shadowing` fields.
- "only runnable PATH lookups count as copies" asserts that a same-named
  non-executable file and a broken symlink are not copies, and that a command
  written as an explicit path is not a PATH lookup that can be shadowed.

`test/core-behavior.test.mjs` also asserts that the doctor does not propose a
login-only directory that cannot contain the command, and
`test/toolchain-bins.test.mjs` covers the toolchain equivalent (including not
suggesting a toolchain directory that is already on PATH). Run all of them with:

```sh
npm test
```

README documents the text output and the `--json` fields in "Two installs, one
winner (shadowing)" and the JSON key table.

## Scope

The doctor reports copies; it does not uninstall or reorder them. It reads the
filesystem only and never executes a discovered command, so reporting a
fight between 1.0 and 2.0 cannot run either version. Choosing which copy should
win is left to the user: the output names both paths, and the fix list
deliberately stays empty when both directories are already on PATH.
