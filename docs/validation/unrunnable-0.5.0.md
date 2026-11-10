# Measured: 0.5.0 says a broken command is `ok`

This page records the baseline for the epic **"Say when a command on PATH cannot
actually run"**. It runs the published `cli-path-doctor@0.5.0` against three real
files in one PATH directory and quotes both what the doctor says and what the
kernel does when the same files are executed.

The short result:

- A script with `#!/nonexistent/interpreter` and mode `0755` is reported as
  resolved in every context (`status: "ok"`, `resolved: true`, exit `0`), even
  though executing it fails with `bad interpreter` and exit `126`.
- A script with mode `0644` is reported as `MISS`, which is correct, but the
  suggested repair is `npm install -g 'noexec'`, which cannot add the missing
  permission bit to the file that was found.
- A normal executable shell script is reported as resolved, exits `0`, and runs
  successfully.

No code was changed for this milestone. The point is to capture the wrong
verdicts from the release users can install today, so the next milestone can be
checked against a real before/after.

## What was measured

| | |
| --- | --- |
| Date | 2026-11-10 (UTC) |
| Machine | macOS 27.2.1 (Darwin 27.2.0), arm64 |
| Node.js | v24.15.0 |
| npm | 11.12.1 |
| Published package under test | `cli-path-doctor@0.5.0` |
| Registry tarball shasum | `9965eda5c0d6a7fbf975c86fcf4023de9501682d` |
| Registry tarball integrity | `sha512-Ib6ZLEEpjsGfNuqbV8I77gJXg9zsChh+VrfU3T9vRF/4LrpRyYYuxQcuXmRG6+CVH2Y7EoM1VdDasB4XMUQ6pA==` |
| Checkout reference | `e5ce1f1544a15085ae51ca323a178acfb680def8` |

The package was installed from the npm registry into an isolated prefix, not
run from the checkout. Verifying the installed binary:

```console
$ /tmp/cpd-unrunnable-0.5.0/prefix/bin/cli-path-doctor --version
0.5.0
$ echo $?
0
```

## Fixtures

All three files were created in one directory and made reachable in all four
contexts. They deliberately share a directory so the only different variable is
the file itself.

```sh
probe=/tmp/cpd-unrunnable-0.5.0
rm -rf "$probe"
mkdir -p "$probe/bin" "$probe/home" "$probe/npm-cache" "$probe/prefix"

cat > "$probe/bin/broken" <<'SH'
#!/nonexistent/interpreter
echo broken should not run
SH
chmod 0755 "$probe/bin/broken"

cat > "$probe/bin/noexec" <<'SH'
#!/bin/sh
echo noexec should run after chmod
SH
chmod 0644 "$probe/bin/noexec"

cat > "$probe/bin/good" <<'SH'
#!/bin/sh
echo good ran
SH
chmod 0755 "$probe/bin/good"
```

| Fixture | Mode | First line | Why it is interesting |
| --- | --- | --- | --- |
| `broken` | `0755` | `#!/nonexistent/interpreter` | The file is executable, but the interpreter named by the shebang does not exist. |
| `noexec` | `0644` | `#!/bin/sh` | The file and interpreter exist, but the file has no execute bit. |
| `good` | `0755` | `#!/bin/sh` | The control case: a normal command that should pass. |

### What the three files actually do

Executed directly with `bash`, outside the doctor:

```console
$ bash -c '/tmp/cpd-unrunnable-0.5.0/bin/broken'
bash: /tmp/cpd-unrunnable-0.5.0/bin/broken: /nonexistent/interpreter: bad interpreter: No such file or directory
$ echo $?
126
$ bash -c '/tmp/cpd-unrunnable-0.5.0/bin/noexec'
bash: /tmp/cpd-unrunnable-0.5.0/bin/noexec: Permission denied
$ echo $?
126
$ bash -c '/tmp/cpd-unrunnable-0.5.0/bin/good'
good ran
$ echo $?
0
```

So `broken` and `noexec` cannot start, and `good` can.

### Doctor environment

The published package was installed and run with an isolated `HOME` and npm
prefix, so no real global install or user toolchain could affect the result:

```sh
export HOME="$probe/home"
export npm_config_cache="$probe/npm-cache"
export NPM_CONFIG_PREFIX="$probe/prefix"
npm install -g cli-path-doctor@0.5.0 --ignore-scripts

export PATH="$probe/bin:/opt/homebrew/opt/node@24/bin:/usr/bin:/bin"
export CLI_PATH_DOCTOR_LOGIN_PATH="$PATH"
export CLI_PATH_DOCTOR_NON_LOGIN_PATH="$PATH"
export CLI_PATH_DOCTOR_DAEMON_PATH="$PATH"
```

`/opt/homebrew/opt/node@24/bin` is present only so the published doctor's
`#!/usr/bin/env node` line can start. All four contexts search the same PATH,
with `$probe/bin` first. `cli-path-doctor` below is
`$probe/prefix/bin/cli-path-doctor`.

## Case 1: `broken` is reported `ok` (wrong)

### Text output

```console
$ cli-path-doctor broken
current      /tmp/cpd-unrunnable-0.5.0/bin/broken
login        /tmp/cpd-unrunnable-0.5.0/bin/broken
non-login    /tmp/cpd-unrunnable-0.5.0/bin/broken
daemon-like  /tmp/cpd-unrunnable-0.5.0/bin/broken
$ echo $?
0
```

There is no stderr guidance: `cli-path-doctor broken` writes nothing to stderr
and exits `0`.

### Machine-readable output

The JSON output is large; these are the exact relevant lines from
`cli-path-doctor broken --json` (exit `0`). The `login`, `non-login`, and
`daemon-like` context objects have the same `status`, `resolved`, `path`, and
`executable` values as `current`.

```json
  "command": "broken",
  "resolved": true,
  "exitCode": 0,
  "contexts": [
    {
      "name": "current",
      "status": "ok",
      "resolved": true,
      "path": "/tmp/cpd-unrunnable-0.5.0/bin/broken",
      "copies": [
        {
          "path": "/tmp/cpd-unrunnable-0.5.0/bin/broken",
          "executable": true,
          "winner": true,
          "shadowed": false
        }
      ],
      "reason": null
    }
  ],
  "fixes": []
```

The doctor also writes a per-context `"exitCode": 0` field; the excerpt above
shows the top-level value and omits the per-context duplicates.

### Verdict

**Wrong.** All four contexts say the command resolves. The `copies` entry says
`executable: true`. The actual execution result is `bad interpreter` and exit
`126`. The doctor has confused "the execute bit is set" with "the kernel can
start this file". It never reads the shebang, so the missing interpreter is
invisible to it. This is the core defect the epic exists to fix.

## Case 2: `noexec` is reported `MISS` (status right, repair wrong)

### Text output

```console
$ cli-path-doctor noexec
current      MISS (found at /tmp/cpd-unrunnable-0.5.0/bin/noexec but it is not executable)
login        MISS (found at /tmp/cpd-unrunnable-0.5.0/bin/noexec but it is not executable)
non-login    MISS (found at /tmp/cpd-unrunnable-0.5.0/bin/noexec but it is not executable)
daemon-like  MISS (found at /tmp/cpd-unrunnable-0.5.0/bin/noexec but it is not executable)
fixes:
  npm install -g 'noexec'
$ echo $?
1
```

Here stdout is the four `MISS` lines, stderr is the `fixes:` block, and the exit
code is `1`.

### Machine-readable output

```json
  "command": "noexec",
  "resolved": false,
  "exitCode": 1,
  "contexts": [
    {
      "name": "current",
      "status": "miss",
      "resolved": false,
      "path": null,
      "copies": [],
      "reason": "found at /tmp/cpd-unrunnable-0.5.0/bin/noexec but it is not executable"
    }
  ],
  "fixes": [
    "npm install -g 'noexec'"
  ]
```

The other three contexts have the same `status`, `resolved`, `path`, `copies`,
and `reason` values as `current`.

### Verdict

**The status is right; the fix is wrong.** `noexec` cannot start, so `MISS` and
exit `1` are honest. But `npm install -g 'noexec'` is not a repair for this
file: it would look for a package named `noexec` and could not add a permission
bit to `/tmp/cpd-unrunnable-0.5.0/bin/noexec`. The local repair is:

```sh
chmod +x '/tmp/cpd-unrunnable-0.5.0/bin/noexec'
```

0.5.0's `chmod +x` advice is only generated for files it finds through its npm
bin inspection or its toolchain search. A same-named file found only by the
PATH lookup, with the wrong mode, does not enter either branch. A user following
the printed line would reinstall an unrelated (or nonexistent) package and
still have the unrunnable file first on PATH.

## Case 3: `good` is reported resolved (right)

### Text output

```console
$ cli-path-doctor good
current      /tmp/cpd-unrunnable-0.5.0/bin/good
login        /tmp/cpd-unrunnable-0.5.0/bin/good
non-login    /tmp/cpd-unrunnable-0.5.0/bin/good
daemon-like  /tmp/cpd-unrunnable-0.5.0/bin/good
$ echo $?
0
```

stderr is empty.

### Machine-readable output

```json
  "command": "good",
  "resolved": true,
  "exitCode": 0,
  "contexts": [
    {
      "name": "current",
      "status": "ok",
      "resolved": true,
      "path": "/tmp/cpd-unrunnable-0.5.0/bin/good",
      "copies": [
        {
          "path": "/tmp/cpd-unrunnable-0.5.0/bin/good",
          "executable": true,
          "winner": true,
          "shadowed": false
        }
      ],
      "reason": null
    }
  ],
  "fixes": []
```

The other three contexts have the same `status`, `resolved`, `path`, and
`executable` values as `current`.

### Verdict

**Right.** The file can start (`good ran`, exit `0`), and the doctor reports it
as resolved in all four contexts with exit `0` and no fix. This is what a
positive result should look like. It also shows that a fix cannot be "always
say it is broken": an actual runnable command must keep passing.

## Summary

| Fixture | Direct execution | 0.5.0 text verdict | 0.5.0 exit | Correct today? |
| --- | --- | --- | --- | --- |
| `broken` | `bad interpreter`, `126` | resolved in all four contexts | `0` | **No** — reports `ok` for a command that cannot start |
| `noexec` | `Permission denied`, `126` | `MISS` in all four contexts | `1` | Status **yes**; `npm install -g 'noexec'` repair **no** |
| `good` | `good ran`, `0` | resolved in all four contexts | `0` | **Yes** |

## Why 0.5.0 gets these verdicts

`lookupCommand` and `findCommandCopies` in `lib/path-resolver.mjs` accept a PATH
candidate once it is a regular file and `executableOnPlatform` succeeds. On
POSIX that check is `fs.accessSync(candidate, fs.constants.X_OK)`, which tests
the mode, not the interpreter or dynamic loader. Nothing reads the first line of
the file or tries to start it. The same inspect result feeds the copy list, so
`copies[].executable` is also `true` for `broken`.

The fix path has a separate gap. `buildFixes` returns `npm install -g
'<command>'` when no context resolved and there is no npm or toolchain evidence.
For `noexec`, the file was found, but because it was not executable it produced
no resolved row and no npm candidate, so the fallback was the only line left.
The `chmod +x` branches are driven by npm bin candidates and toolchain
candidates; a file found only by the PATH lookup never reaches them.

## What the next milestone must change

The baseline makes the required behavior concrete:

1. A PATH file whose shebang interpreter is missing or not executable must not
   be reported as `ok`. It is present, but it cannot start.
2. The report must distinguish "not found" from "found but cannot start" in
   text, in `--json`, and in the exit code, without claiming a fix that does not
   apply.
3. A file that only needs `chmod +x` should get that local repair, not an
   `npm install -g` line.
4. A normal command like `good` must continue to resolve and exit `0`.

This page is the recorded "before". The merged implementation has since been
validated from a clean `npm pack` + `npm install -g` of the built package against
the same fixtures; see
[`unrunnable-clean-install.md`](https://github.com/WJDdidi-1/cli-path-doctor/blob/main/docs/validation/unrunnable-clean-install.md).
This file remains the reference for what 0.5.0 said.
