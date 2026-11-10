# Verified: a command that is present but cannot start

This page records the acceptance check for the epic milestone **"Verify the
broken-command verdict from a clean install and document it"**. The baseline in
[`unrunnable-0.5.0.md`](https://github.com/WJDdidi-1/cli-path-doctor/blob/main/docs/validation/unrunnable-0.5.0.md)
shows the published 0.5.0 reporting a bad-shebang script as `ok`, exit `0`.

The merged implementation was verified the same way a user installs it: `npm
pack` from the checkout, `npm install -g` of the tarball into an isolated
prefix, then the installed `cli-path-doctor` against real files on PATH.

The short result:

- A script with `#!/nonexistent/interpreter` and mode `0755` is now `BROKEN` in
  every context, exits `1`, and says which interpreter is missing. `--json`
  reports `status: "broken"`, `resolved: true`, `runnable: false`, and
  `unrunnableReason`.
- A normal executable script is still `ok`, exits `0`, and is `runnable: true`.
  The fix does not make every command look broken.
- A genuinely absent command is still `MISS`, exits `1`, and gets the fallback
  `npm install -g` line. The broken command does **not** get that line: the file
  already exists, and reinstalling a package would not repair its shebang.

## What was measured

| | |
| --- | --- |
| Date | 2026-11-10 (UTC) |
| Machine | macOS 27.2.1 (Darwin 27.2.0), arm64 |
| Node.js | v24.15.0 |
| npm | 11.12.1 |
| Checkout under test | `cb56978f08838d01041bfdafeeb20002bb48a5a1` plus this milestone's test and docs |
| Package version | `0.5.0` (the version bump is a separate publish step) |
| Install | local tarball built with `npm pack`, installed with `npm install -g --ignore-scripts` |

The install ran with an isolated cache and prefix and with npm's network,
audit, and fund checks disabled, so it did not depend on the registry or on a
real global install. Only the packed files were installed; the checkout's `test`
and `docs` directories are not in the tarball.

## Pack and install

```console
$ probe=/tmp/cpd-unrunnable-clean-install
$ rm -rf "$probe"
$ mkdir -p "$probe/bin" "$probe/home" "$probe/cache" "$probe/prefix" "$probe/package"
$ export NPM_CONFIG_CACHE="$probe/cache" npm_config_cache="$probe/cache"

$ npm pack --pack-destination "$probe/package"
npm notice
npm notice 📦  cli-path-doctor@0.5.0
npm notice Tarball Contents
npm notice 7.7kB CHANGELOG.md
npm notice 11.3kB LICENSE
npm notice 35.8kB README.md
npm notice 15.5kB bin/cli-path-doctor.mjs
npm notice 3.8kB examples/path-gap.mjs
npm notice 2.0kB examples/README.md
npm notice 7.4kB lib/contexts.mjs
npm notice 5.7kB lib/fixes.mjs
npm notice 22.0kB lib/npm-metadata.mjs
npm notice 11.3kB lib/path-resolver.mjs
npm notice 5.4kB lib/runnability.mjs
npm notice 2.4kB lib/shell-rc.mjs
npm notice 10.1kB lib/toolchain-metadata.mjs
npm notice 893B package.json
npm notice Tarball Details
npm notice name: cli-path-doctor
npm notice version: 0.5.0
npm notice filename: cli-path-doctor-0.5.0.tgz
npm notice package size: 37.5 kB
npm notice unpacked size: 141.4 kB
npm notice total files: 14
npm notice
cli-path-doctor-0.5.0.tgz

$ NPM_CONFIG_PREFIX="$probe/prefix" npm_config_prefix="$probe/prefix" \
    npm install -g "$probe/package/cli-path-doctor-0.5.0.tgz" --ignore-scripts
added 1 package in 112ms

$ "$probe/prefix/bin/cli-path-doctor" --version
0.5.0
```

The pack notice is abridged to the package-contents and size lines; npm also
prints a per-run tarball shasum and integrity value.

The installed binary is the one used for every result below. It was not run
from the checkout.

## Fixtures

Both files live in one PATH directory, so the only difference between them is
the file itself:

```sh
cat > "$probe/bin/broken" <<'SH'
#!/nonexistent/interpreter
echo this must not run
SH
chmod 0755 "$probe/bin/broken"

cat > "$probe/bin/good" <<'SH'
#!/bin/sh
echo good ran
SH
chmod 0755 "$probe/bin/good"
```

All four context PATHs were set to the same value, with `$probe/bin` first:

```sh
export HOME="$probe/home"
export PATH="$probe/bin:/opt/homebrew/opt/node@24/bin:/usr/bin:/bin"
export CLI_PATH_DOCTOR_LOGIN_PATH="$PATH"
export CLI_PATH_DOCTOR_NON_LOGIN_PATH="$PATH"
export CLI_PATH_DOCTOR_DAEMON_PATH="$PATH"
```

`/opt/homebrew/opt/node@24/bin` is present only so the installed doctor's
`#!/usr/bin/env node` line can start. No real global npm package and no real
user toolchain directory is reachable.

### What the files actually do

```console
$ bash -c "$probe/bin/broken"
bash: /tmp/cpd-unrunnable-clean-install/bin/broken: /nonexistent/interpreter: bad interpreter: No such file or directory
$ echo $?
126
$ bash -c "$probe/bin/good"
good ran
$ echo $?
0
```

So `broken` cannot start and `good` can.

## Case 1: `broken` is `BROKEN` (fixed)

### Text output

```console
$ cli-path-doctor broken
current      BROKEN (found at /tmp/cpd-unrunnable-clean-install/bin/broken but shebang interpreter /nonexistent/interpreter does not exist)
login        BROKEN (found at /tmp/cpd-unrunnable-clean-install/bin/broken but shebang interpreter /nonexistent/interpreter does not exist)
non-login    BROKEN (found at /tmp/cpd-unrunnable-clean-install/bin/broken but shebang interpreter /nonexistent/interpreter does not exist)
daemon-like  BROKEN (found at /tmp/cpd-unrunnable-clean-install/bin/broken but shebang interpreter /nonexistent/interpreter does not exist)
$ echo $?
1
```

stderr is empty: there is no install line, because the file is already on disk
and the failure is its shebang, not a missing package.

### Machine-readable output

The JSON output is large; these are the exact relevant fields from
`cli-path-doctor broken --json` (exit `1`). The `login`, `non-login`, and
`daemon-like` context objects have the same values as `current`.

```json
{
  "status": "broken",
  "resolved": true,
  "runnable": false,
  "exitCode": 1,
  "path": "/tmp/cpd-unrunnable-clean-install/bin/broken",
  "contexts": [
    {
      "name": "current",
      "status": "broken",
      "resolved": true,
      "runnable": false,
      "path": "/tmp/cpd-unrunnable-clean-install/bin/broken",
      "unrunnableReason": "shebang interpreter /nonexistent/interpreter does not exist"
    }
  ],
  "fixes": []
}
```

### Verdict

**Fixed.** The file is found (`resolved: true`), but its interpreter is not
present (`runnable: false`), the context status is `broken`, and the exit code
is `1`. This matches the kernel's result (`bad interpreter`, `126`) instead of
claiming the command is `ok`.

## Case 2: `good` is `ok` (control)

### Text output

```console
$ cli-path-doctor good
current      /tmp/cpd-unrunnable-clean-install/bin/good
login        /tmp/cpd-unrunnable-clean-install/bin/good
non-login    /tmp/cpd-unrunnable-clean-install/bin/good
daemon-like  /tmp/cpd-unrunnable-clean-install/bin/good
$ echo $?
0
```

### Machine-readable output

```json
{
  "status": "ok",
  "resolved": true,
  "runnable": true,
  "exitCode": 0,
  "path": "/tmp/cpd-unrunnable-clean-install/bin/good",
  "contexts": [
    {
      "name": "current",
      "status": "ok",
      "resolved": true,
      "runnable": true,
      "path": "/tmp/cpd-unrunnable-clean-install/bin/good",
      "unrunnableReason": null
    }
  ],
  "fixes": []
}
```

### Verdict

**Right.** A command that can start is still reported as resolved, exits `0`,
and has no fix. The broken verdict is not a blanket failure.

The automated clean-install test also runs the installed doctor against the real
Node.js binary on the same PATH and asserts `status: "ok"` and
`runnable: true`. The `good` script is quoted above to keep the fixture output
minimal.

## Case 3: a missing command still gets the install line

This is the contrast the README shows. A command with no file anywhere is
`MISS`, not `BROKEN`:

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

No file was found, so there is nothing local to repair and the install line is
the only actionable advice. For `broken`, the file was found and the install
line is suppressed.

## Summary

| Fixture | Direct execution | Text verdict | Exit | `--json` | Fix proposed |
| --- | --- | --- | --- | --- | --- |
| `broken` (`0755`, bad shebang) | `bad interpreter`, `126` | `BROKEN` in all four contexts | `1` | `status: broken`, `resolved: true`, `runnable: false` | none |
| `good` (`0755`, `#!/bin/sh`) | `good ran`, `0` | resolved in all four contexts | `0` | `status: ok`, `resolved: true`, `runnable: true` | none |
| `definitely-not-installed-cli` | not found | `MISS` in all four contexts | `1` | `status: miss`, `resolved: false`, `runnable: false` | `npm install -g 'definitely-not-installed-cli'` |

The baseline's `noexec` case (mode `0644`) is covered separately by
`test/unrunnable.test.mjs`: it stays `MISS` and now gets
`chmod +x '<path>'`, not an npm install.

## Reproduce

The acceptance check is automated as a test. It packs this checkout, installs
the tarball into a temporary prefix, and asserts the three outcomes above:

```sh
node --test test/clean-install-unrunnable.test.mjs
```

The full suite still runs with:

```sh
npm test
```

The test skips on Windows, where the shebang and executable-bit fixtures do not
apply the same way.
