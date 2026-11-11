# Verified: repair for a broken shebang from a clean install

This page records the acceptance run for the final milestone of the epic
**"Explain how to repair a command whose interpreter is missing"**. The
baseline in [`broken-repair-0.7.0.md`](https://github.com/WJDdidi-1/cli-path-doctor/blob/main/docs/validation/broken-repair-0.7.0.md)
shows the 0.7.0 checkout reporting `BROKEN` but returning `fixes: []` and
`fix.reason: "no PATH directory to add; nothing to fix"`.

The repair was verified the way a user installs it: `npm pack` from the
checkout, `npm install -g` of the tarball into an isolated prefix, then the
installed `cli-path-doctor` against a real script whose shebang names a missing
interpreter.

The short result:

- A `0755` script with `#!/nonexistent/interp` is still `BROKEN` in every
  context, exits `1`, and reports the file and the missing interpreter.
- `--fix` no longer refuses. Text output adds
  `cli-path-doctor: repair needed: ...` and a `fixes:` entry that names the
  missing interpreter and the file, instead of
  `cannot apply PATH fix: ... nothing to fix`.
- `--fix --json` now has a non-empty `fixes` array with the same repair.
  `fix.manual` is `true`, `fix.applied` is `false`, `fix.file` and `fix.line`
  are `null`, and `fix.reason` says the command cannot start and repeats the
  interpreter repair.
- A present-but-broken file still gets no blind `npm install -g` line. The
  repair is the interpreter (or the owning package, when npm metadata proves
  one).
- `--fix` does **not** write a shell startup file for this case: there is no
  PATH directory to add, and the temporary `HOME` stays empty. The repair is
  printed for the user to run.

## What was measured

| | |
| --- | --- |
| Date | 2026-11-11T19:34:47Z |
| Machine | macOS 27.2.1 (Darwin 27.2.0), arm64 |
| Node.js | v24.15.0 |
| npm | 11.12.1 |
| Package under test | `cli-path-doctor` packed from this checkout |
| Packed version | `0.7.0` |
| Checkout reference | `65bf3ca5ee1af81a38fe691d255c92ec84f045b9` |
| Command | `brokenprobe-<pid>`, a `0755` script on every checked PATH |
| Missing interpreter | `/nonexistent/interp` |

`$PROBE` is the `mktemp -d` directory for the run. The captured lines below use
it in place of the random `/private/var/folders/...` root, and `<pid>` in place
of the probe process id, so the output stays readable. Only those values differ
from the raw run.

## How to reproduce

The probe packs the current tree, installs the tarball with an isolated `HOME`,
prefix, and npm cache, and runs every check itself:

```sh
sh docs/probes/broken-repair-clean-install.sh
```

It prints the installed version, the fixture, both `--fix` runs, and the JSON
repair fields, then exits `0` only when all of them pass. The same checks run
under `npm test` as `test/clean-install-broken-repair.test.mjs`.

## Pack and install

```console
$ npm pack --pack-destination $PROBE/package
$ npm install -g $PROBE/package/cli-path-doctor-0.7.0.tgz --ignore-scripts
installed: 0.7.0
```

The installed binary is `$PROBE/prefix/bin/cli-path-doctor`. It is the one used
for every result below; no result comes from the checkout's
`bin/cli-path-doctor.mjs`.

## Fixture

One executable file in one PATH directory, with no npm package of the same name:

```sh
mkdir -p "$PROBE/bin"
printf '#!/nonexistent/interp\necho broken should not run\n' > "$PROBE/bin/brokenprobe-<pid>"
chmod 0755 "$PROBE/bin/brokenprobe-<pid>"
```

All four checked contexts search the same directory, so the only possible
explanation is the shebang:

```sh
PATH="$PROBE/bin:$(dirname "$(command -v node)"):/usr/bin:/bin"
CLI_PATH_DOCTOR_LOGIN_PATH="$PROBE/bin:/usr/bin:/bin"
CLI_PATH_DOCTOR_NON_LOGIN_PATH="$PROBE/bin:/usr/bin:/bin"
CLI_PATH_DOCTOR_DAEMON_PATH="$PROBE/bin:/usr/bin:/bin"
```

The doctor's `.mjs` launcher is invoked with an absolute `node`, and the node
directory is on `PATH` only so that launcher can run. No real global npm
package, shell profile, or toolchain directory is reachable.

## Text `--fix`: a repair, not "nothing to fix"

```console
$ cli-path-doctor brokenprobe-<pid> --fix
current      BROKEN (found at $PROBE/bin/brokenprobe-<pid> but shebang interpreter /nonexistent/interp does not exist)
login        BROKEN (found at $PROBE/bin/brokenprobe-<pid> but shebang interpreter /nonexistent/interp does not exist)
non-login    BROKEN (found at $PROBE/bin/brokenprobe-<pid> but shebang interpreter /nonexistent/interp does not exist)
daemon-like  BROKEN (found at $PROBE/bin/brokenprobe-<pid> but shebang interpreter /nonexistent/interp does not exist)
cli-path-doctor: repair needed: brokenprobe-<pid> cannot start: shebang interpreter /nonexistent/interp does not exist; repair: install the missing shebang interpreter /nonexistent/interp, or change the shebang in '$PROBE/bin/brokenprobe-<pid>'
fixes:
  install the missing shebang interpreter /nonexistent/interp, or change the shebang in '$PROBE/bin/brokenprobe-<pid>'
$ echo $?
1
```

stdout is still exactly the four verdict rows; the repair goes to stderr with
the other human guidance. The exit code is `1` because no context can run the
command, which is correct: this is advice, not a claim that the command works
now.

The probe asserts that the stderr:

- names `/nonexistent/interp` and the fixture path,
- contains `repair needed:` and a `fixes:` entry,
- contains neither `nothing to fix` nor `cannot apply PATH fix`,
- does not propose `npm install -g` for a file that is already on disk.

## `--fix --json`: a non-empty `fixes` array

This excerpt is copied from the installed doctor's raw JSON, leaving out the
`login`, `non-login`, and `daemon-like` context objects and other fields that do
not bear on the repair:

```json
{
  "command": "brokenprobe-<pid>",
  "status": "broken",
  "resolved": true,
  "runnable": false,
  "exitCode": 1,
  "path": "$PROBE/bin/brokenprobe-<pid>",
  "contexts": [
    {
      "name": "current",
      "status": "broken",
      "resolved": true,
      "runnable": false,
      "interpreter": "/nonexistent/interp",
      "unrunnableReason": "shebang interpreter /nonexistent/interp does not exist",
      "path": "$PROBE/bin/brokenprobe-<pid>"
    }
  ],
  "fixes": [
    "install the missing shebang interpreter /nonexistent/interp, or change the shebang in '$PROBE/bin/brokenprobe-<pid>'"
  ],
  "fix": {
    "applied": false,
    "file": null,
    "line": null,
    "alreadyPresent": false,
    "manual": true,
    "reason": "brokenprobe-<pid> cannot start: shebang interpreter /nonexistent/interp does not exist; repair: install the missing shebang interpreter /nonexistent/interp, or change the shebang in '$PROBE/bin/brokenprobe-<pid>'"
  }
}
```

The exit code is `1`. `fixes` has one actionable entry instead of the baseline's
empty array. `fix.manual: true` distinguishes this from a failed PATH edit: there
was no PATH edit to make. A script can still read `fix.reason` for the cause and
the top-level `fixes` array for the next step without parsing the human line.

## No startup file was written

After both runs, the temporary `HOME` contains no files:

```console
$ ls -A $PROBE/home
$ echo $?
0
```

The probe asserts `readdirSync(home)` is empty and that no `.profile` exists.
This is intentional: `--fix` only edits a shell startup file when it has a PATH
directory to append. For a broken shebang there is no directory to add, so the
repair is a printed instruction, not a silent edit to an unrelated file.

## Before and after

| Observation | Baseline (`broken-repair-0.7.0.md`) | Packed install after the repair |
| --- | --- | --- |
| Verdict | `BROKEN` in all four contexts, exit `1` | unchanged |
| `unrunnableReason` | names `/nonexistent/interp` | unchanged |
| Text `--fix` stderr | `cannot apply PATH fix: no PATH directory to add; nothing to fix` | `repair needed: ... cannot start: ...; repair: install the missing shebang interpreter ...` |
| `fixes` | `[]` | one interpreter repair |
| `fix.reason` | `no PATH directory to add; nothing to fix` | names the missing interpreter and the file, and says the command cannot start |
| `fix.applied` / `fix.manual` | `false` / absent | `false` / `true` |
| Startup file | none | none (correct: no PATH directory to add) |

## Limits of this check

- The probe uses one missing absolute interpreter, `/nonexistent/interp`. The
  `#!/usr/bin/env node` form and the npm-global-owner hint are covered by
  `test/broken-repair.test.mjs`. The other runnability reasons (interpreter is
  not executable, is not a file, or is a relative path) share the same repair
  builder in `lib/fixes.mjs` but are not separately exercised by this probe.
- The repair is advice. It does not edit the shebang or install the interpreter
  itself; changing another package's file or installing a system interpreter is
  outside what the doctor should do silently.
- The probe is not run on Windows, where the shebang and executable-bit
  fixtures do not apply the same way. The corresponding `npm test` case is
  skipped there too.
- The probe installs the local packed tarball offline. It does not test a
  registry publish, which happens in a separate release step.

## Reproduce

```sh
node --test test/clean-install-broken-repair.test.mjs
```

The full suite still runs with:

```sh
npm test
```
