# Measured: a broken command gets no repair

This page records the baseline for the epic **"Explain how to repair a command
whose interpreter is missing"**. It runs the current checkout
(`cli-path-doctor` 0.7.0) against a real executable script whose shebang names
an interpreter that does not exist, and quotes what the doctor says in text and
in `--json`.

The short result:

- The doctor correctly finds the file and reports `BROKEN` in all four
  contexts, with `runnable: false` and the reason
  `shebang interpreter /nonexistent/interp does not exist`. It exits `1`.
- The kernel agrees: executing the same file fails with
  `/nonexistent/interp: bad interpreter: No such file or directory` and exit
  `126`.
- `--fix` produces **no repair at all**. stderr is only
  `cli-path-doctor: cannot apply PATH fix: no PATH directory to add; nothing to fix`.
- `--fix --json` returns `status: "broken"`, `resolved: true`,
  `runnable: false`, `fixes: []`, and
  `fix.reason: "no PATH directory to add; nothing to fix"`.
- The README already describes the manual repair (edit the shebang or reinstall
  the package that owns the script), but the installed command never emits that
  advice. A user who runs `--fix` is told there is nothing to fix at the exact
  moment the command is known to be broken.

No source code was changed for this milestone. The point is to record the gap
in the release users can install today, so the repair milestone can be checked
against a real before/after.

## What was measured

| | |
| --- | --- |
| Date | 2026-11-11T19:16:31Z |
| Machine | macOS 27.2.1 (Darwin 27.2.0), arm64 |
| Node.js | v24.15.0 |
| npm | 11.12.1 |
| Package under test | this checkout, version `0.7.0` |
| Checkout reference | `3a88ffc012a2002894c987dae5ff695beb7ba6be` |
| Command | `brokentool`, a `0755` script on PATH |
| Missing interpreter | `/nonexistent/interp` |

The run uses `bin/cli-path-doctor.mjs` from the checkout, not a registry
release, so the numbers describe the code that the next milestone will change.
This reproduces the dossier's probe on merged `main` (2026-11-12).

## Fixture

The fixture is deliberately minimal: one executable file in one PATH
directory, no npm package and no toolchain install with that name. The only
thing that can explain the failure is the shebang.

```sh
probe=/tmp/cpd-broken-repair-0.7.0
rm -rf "$probe"
mkdir -p "$probe/bin" "$probe/home" "$probe/npm-cache" "$probe/prefix"

cat > "$probe/bin/brokentool" <<'SH'
#!/nonexistent/interp
echo broken should not run
SH
chmod 0755 "$probe/bin/brokentool"
```

The file is a regular file, is executable, and is first on every checked PATH:

| Property | Value |
| --- | --- |
| Path | `/tmp/cpd-broken-repair-0.7.0/bin/brokentool` |
| Mode | `0755` |
| First line | `#!/nonexistent/interp` |
| Interpreter exists? | No (`/nonexistent/interp` is absent) |
| On PATH? | Yes, first in `current`, `login`, `non-login`, and `daemon-like` |

The doctor environment is isolated so a real global install, shell profile, or
toolchain directory cannot hide the fixture:

```sh
export HOME="$probe/home"
export npm_config_cache="$probe/npm-cache"
export NPM_CONFIG_PREFIX="$probe/prefix"
export PATH="$probe/bin:/opt/homebrew/opt/node@24/bin:/usr/bin:/bin"
export CLI_PATH_DOCTOR_LOGIN_PATH="$probe/bin:/usr/bin:/bin"
export CLI_PATH_DOCTOR_NON_LOGIN_PATH="$probe/bin:/usr/bin:/bin"
export CLI_PATH_DOCTOR_DAEMON_PATH="$probe/bin:/usr/bin:/bin"
export CARGO_HOME='' BUN_INSTALL='' VOLTA_HOME='' GOBIN='' GOPATH=''
export DENO_INSTALL='' PNPM_HOME='' ASDF_DATA_DIR='' MISE_DATA_DIR=''
export PYENV_ROOT='' RBENV_ROOT=''
```

`/opt/homebrew/opt/node@24/bin` is present only so `node` and the doctor's own
launcher can start. It is not on the checked login/non-login/daemon PATHs,
which is why those rows search exactly the fixture directory plus
`/usr/bin:/bin`.

## The interpreter really is missing

Run the fixture directly, outside the doctor:

```console
$ /tmp/cpd-broken-repair-0.7.0/bin/brokentool
bash: /tmp/cpd-broken-repair-0.7.0/bin/brokentool: /nonexistent/interp: bad interpreter: No such file or directory
$ echo $?
126
```

`126` means the file was found but could not be executed. This is the failure
the doctor must explain and repair.

## Text output: `BROKEN`, then "nothing to fix"

```console
$ node bin/cli-path-doctor.mjs brokentool --fix
current      BROKEN (found at /tmp/cpd-broken-repair-0.7.0/bin/brokentool but shebang interpreter /nonexistent/interp does not exist)
login        BROKEN (found at /tmp/cpd-broken-repair-0.7.0/bin/brokentool but shebang interpreter /nonexistent/interp does not exist)
non-login    BROKEN (found at /tmp/cpd-broken-repair-0.7.0/bin/brokentool but shebang interpreter /nonexistent/interp does not exist)
daemon-like  BROKEN (found at /tmp/cpd-broken-repair-0.7.0/bin/brokentool but shebang interpreter /nonexistent/interp does not exist)
$ echo $?
1
```

stdout is the four `BROKEN` rows above. stderr contains exactly one line and
nothing else:

```console
cli-path-doctor: cannot apply PATH fix: no PATH directory to add; nothing to fix
```

The verdict is correct. The repair is absent. The tool has all the evidence it
needs — the file path and the missing interpreter — and still says there is
nothing to fix.

## Machine-readable output: `fixes: []`

`--fix --json` returns the same verdict with no repairs. This is an excerpt:
every field below is copied from the raw JSON, the first context object is
shown in full, and the `...` lines mark the three omitted context entries and
other omitted top-level fields. The other contexts have the same `status`,
`runnable`, and `unrunnableReason` values as `current`.

```json
  "command": "brokentool",
  "status": "broken",
  "resolved": true,
  "runnable": false,
  "anyResolved": true,
  "anyRunnable": false,
  "exitCode": 1,
  "path": "/tmp/cpd-broken-repair-0.7.0/bin/brokentool",
  "contexts": [
    {
      "name": "current",
      "context": "current",
      "status": "broken",
      "resolved": true,
      "runnable": false,
      "unrunnableReason": "shebang interpreter /nonexistent/interp does not exist",
      "path": "/tmp/cpd-broken-repair-0.7.0/bin/brokentool",
      "foundPath": "/tmp/cpd-broken-repair-0.7.0/bin/brokentool",
      "realPath": null,
      "symlink": false,
      "linkTarget": null,
      "copies": [
        {
          "path": "/tmp/cpd-broken-repair-0.7.0/bin/brokentool",
          "directory": "/tmp/cpd-broken-repair-0.7.0/bin",
          "realPath": null,
          "symlink": false,
          "linkTarget": null,
          "executable": true,
          "runnable": false,
          "unrunnableReason": "shebang interpreter /nonexistent/interp does not exist",
          "winner": true,
          "shadowed": false
        }
      ],
      "shadowed": [],
      "shadowedPaths": [],
      "reason": "found at /tmp/cpd-broken-repair-0.7.0/bin/brokentool but shebang interpreter /nonexistent/interp does not exist"
    },
    ...
  ],
  ...
  "fix": {
    "applied": false,
    "file": null,
    "line": null,
    "alreadyPresent": false,
    "reason": "no PATH directory to add; nothing to fix"
  },
  "fixes": [],
```

The exit code is `1`. `fixes=[]` is the defect: a command that is present and
known to be unrunnable gets zero repairs. `fix.reason` repeats the PATH-fix
refusal instead of naming `/nonexistent/interp` or the package that owns
`brokentool`.

## Why the repair list is empty

The path from the verdict to the empty list is deterministic in
`lib/fixes.mjs` and `lib/apply-fix.mjs`:

1. `buildFixes` only adds PATH directories from `pathDirectoriesToAdd`. A
   `BROKEN` row has `resolved: true` and a `path`, but its directory
   (`/tmp/cpd-broken-repair-0.7.0/bin`) is already in the current PATH, so
   there is no directory to add.
2. The `chmod +x` branch is driven by `row.nonExecutable`. The file is already
   `0755`, so that branch does not run. The missing piece is the interpreter,
   not the file mode.
3. The `npm install -g 'brokentool'` fallback is guarded by
   `!anyResolved`. Here `anyResolved` is `true` (the file was found), so the
   fallback is skipped. That guard is correct for a broken file — reinstalling
   a package named after the command is not a proven repair — but there is no
   broken-specific branch to take its place.
4. `--fix` calls `applyPathFix` with an empty directory list. It returns
   `no PATH directory to add; nothing to fix`, which the CLI prefixes with
   `cannot apply PATH fix:`. The `fixes` array was already empty, so nothing
   is printed under a `fixes:` heading either.

In other words, `resolved: true` means "this context found the file", not
"this command works". That distinction is now reported correctly, but it still
suppresses the only repair path the tool has, and no new repair path exists for
a broken shebang.

## Existing alternatives are not enough

- `command -v` and `which` only locate the file. They report the same path the
  doctor reports, and the user still has to read the shebang to discover the
  missing interpreter.
- Running the command gives `bad interpreter`, but that message does not say
  which package owns the script, whether a second copy exists, or how to
  repair the context/daemon split that made the command appear to exist.
- `npm ls -g`, `brew list`, and toolchain inventory commands can find an
  owning package, but they do not connect it to a PATH file or explain why the
  command cannot start.
- The existing `cli-path-doctor` `BROKEN` verdict is the right diagnosis and is
  better than all of the above. Its remaining gap is precisely the repair.

The README's prose ("Edit the shebang (or reinstall the package that owns the
script)") is correct but is not delivered by the command. A user debugging a
daemon or CI failure should not have to leave the terminal and find the README
to be told that the file they already located has a missing interpreter.

## Threshold for the next milestone

These are the acceptance conditions for the repair milestone. They are written
so the same fixture and the same `--fix` invocation can verify them.

1. **At least one repair.** A `BROKEN` command must produce
   `fixes.length >= 1` in `--fix --json`. `fixes: []` is a failure.
2. **The reason names the cause.** `fix.reason` must name the missing
   interpreter (for example `/nonexistent/interp`) or the owning package
   (the package that installed `brokentool`), not only a PATH directory.
3. **"Nothing to fix" is forbidden for `BROKEN`.** A broken command must never
   print `cannot apply PATH fix: no PATH directory to add; nothing to fix` or
   return that as `fix.reason`. "Nothing to fix" is allowed only when the
   command is genuinely healthy or the only remaining problem is outside this
   tool's scope, and then the reason must say what that problem is.
4. **The repair is actionable.** The text output and the JSON `fixes` entries
   must tell the user what to do about the interpreter (repair the shebang,
   install the interpreter, or reinstall the owning package). Repeating the
   `BROKEN` verdict is not a repair.
5. **Do not regress the working cases.** A normal `ok` command must stay
   `ok`, exit `0`, and get no repair. A `MISS` command with no evidence keeps
   the `npm install -g` fallback. A non-executable file keeps its local
   `chmod +x` repair. A present-but-broken file must still not receive a blind
   `npm install -g 'brokentool'` line unless the owning package is actually
   known.
6. **Verify from a clean install.** The final milestone must run the same
   broken-shebang probe through `npm pack` + `npm install -g` (not only the
   checkout) and record the repaired output, including the named interpreter
   or owning package.

The current result fails condition 1 and condition 2, and violates condition 3
on every run. Condition 5 is already covered by the existing tests for `ok`,
`MISS`, and non-executable files; the repair must keep them passing.

## Reproduce

From the repository root:

```sh
probe=/tmp/cpd-broken-repair-0.7.0
rm -rf "$probe"
mkdir -p "$probe/bin" "$probe/home" "$probe/npm-cache" "$probe/prefix"
printf '#!/nonexistent/interp\necho broken should not run\n' > "$probe/bin/brokentool"
chmod 0755 "$probe/bin/brokentool"

HOME="$probe/home" \
NPM_CONFIG_PREFIX="$probe/prefix" \
PATH="$probe/bin:$(dirname "$(command -v node)"):/usr/bin:/bin" \
CLI_PATH_DOCTOR_LOGIN_PATH="$probe/bin:/usr/bin:/bin" \
CLI_PATH_DOCTOR_NON_LOGIN_PATH="$probe/bin:/usr/bin:/bin" \
CLI_PATH_DOCTOR_DAEMON_PATH="$probe/bin:/usr/bin:/bin" \
CARGO_HOME= BUN_INSTALL= VOLTA_HOME= GOBIN= GOPATH= DENO_INSTALL= \
PNPM_HOME= ASDF_DATA_DIR= MISE_DATA_DIR= PYENV_ROOT= RBENV_ROOT= \
node bin/cli-path-doctor.mjs brokentool --fix

HOME="$probe/home" \
NPM_CONFIG_PREFIX="$probe/prefix" \
PATH="$probe/bin:$(dirname "$(command -v node)"):/usr/bin:/bin" \
CLI_PATH_DOCTOR_LOGIN_PATH="$probe/bin:/usr/bin:/bin" \
CLI_PATH_DOCTOR_NON_LOGIN_PATH="$probe/bin:/usr/bin:/bin" \
CLI_PATH_DOCTOR_DAEMON_PATH="$probe/bin:/usr/bin:/bin" \
CARGO_HOME= BUN_INSTALL= VOLTA_HOME= GOBIN= GOPATH= DENO_INSTALL= \
PNPM_HOME= ASDF_DATA_DIR= MISE_DATA_DIR= PYENV_ROOT= RBENV_ROOT= \
node bin/cli-path-doctor.mjs brokentool --fix --json
```

The expected current output is the `BROKEN` rows plus the
`cannot apply PATH fix` line, and `"fixes": []` in JSON. The next milestone
must change exactly those two observations while leaving the `ok`, `MISS`, and
non-executable cases intact.
