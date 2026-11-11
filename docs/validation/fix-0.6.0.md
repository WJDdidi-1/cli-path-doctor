# Measured: 0.6.0 prints the PATH fix but never applies it

This page records the baseline for the epic **"Apply the PATH fix instead of
only printing it"**. It runs the published `cli-path-doctor@0.6.0` against a real
temporary npm global prefix whose `bin` directory is not on any checked PATH, and
quotes what the doctor prints, what its options accept, and what happens to the
shell startup file it names.

The short result:

- The doctor finds the command's npm bin at
  `/tmp/cpd-fix-0.6.0/prefix/bin/fixprobe`, reports `MISS` in all four contexts,
  and exits `1`.
- stderr contains the complete repair:
  `export PATH='/tmp/cpd-fix-0.6.0/prefix/bin':"$PATH"  # add to ~/.zshrc, then open a new shell`.
  It is text for a human to copy. Nothing writes it anywhere.
- `--help` lists exactly `--json`, `--verbose`, `-h/--help`, and `-v/--version`.
  There is no `--fix`. Passing `--fix` is rejected as an unknown option with
  exit `2`.
- `--json` already exposes `shell`, `shellName`, `rcFile`, and the same `fixes`
  strings, so the doctor knows which file to edit; it just does not edit it.
- The named rc file, `/tmp/cpd-fix-0.6.0/home/.zshrc`, is byte-for-byte
  unchanged. Its SHA-256 is identical before and after every run, and its
  modification time is still its birth time.

No code was changed for this milestone. The point is to capture the gap in the
release users can install today, so the next milestone (`--fix`) can be checked
against a real before/after.

## What was measured

| | |
| --- | --- |
| Date | 2026-11-11 (UTC) |
| Machine | macOS 27.2.1 (Darwin 27.2.0), arm64 |
| Node.js | v24.15.0 |
| npm | 11.12.1 |
| Published package under test | `cli-path-doctor@0.6.0` |
| Registry tarball shasum | `6e28423fa1a5317e708e45a54f0731a0a6000b81` |
| Registry tarball integrity | `sha512-E9ctjz3HlxdH1DCyYWh8fz6Zi89xG5qMUo7joqEx6XWBRqYZbR4rsT9TArwtGSHaue+CMhKQp454RR9J6DBNDA==` |
| Checkout reference | `a9e1dabe69e2bacf0b5a5c145e011692e12ae668` |

The package was installed from the npm registry into an isolated prefix, not run
from the checkout. The installed copy identifies itself as the published
version:

```console
$ /tmp/cpd-fix-0.6.0/prefix/bin/cli-path-doctor --version
0.6.0
```

## Fixture

A temporary prefix is used for both the doctor and a tiny fixture package. The
fixture package exists only to make npm create a real global bin link, the same
way a user's own globally installed CLI would appear. Its `bin` entry is a
normal `#!/usr/bin/env node` script.

```sh
probe=/tmp/cpd-fix-0.6.0
rm -rf "$probe"
mkdir -p "$probe/home" "$probe/prefix" "$probe/npm-cache" \
  "$probe/fixture/fixprobe-cli/bin"

# The startup file the doctor will name. It has unrelated user content so a
# rewrite, append, or truncation would be visible.
printf '# user zshrc\n# keep me\nexport EDITOR=vi\n' > "$probe/home/.zshrc"
shasum -a 256 "$probe/home/.zshrc" > "$probe/rc-before.sha256"

cat > "$probe/fixture/fixprobe-cli/package.json" <<'JSON'
{
  "name": "fixprobe-cli",
  "version": "1.0.0",
  "bin": { "fixprobe": "bin/fixprobe.js" }
}
JSON
cat > "$probe/fixture/fixprobe-cli/bin/fixprobe.js" <<'JS'
#!/usr/bin/env node
console.log('fixprobe ran');
JS
chmod 0755 "$probe/fixture/fixprobe-cli/bin/fixprobe.js"
```

Both packages are installed into the prefix with an isolated `HOME` and npm
cache, so no real global install or user rc file can affect the result:

```sh
export HOME="$probe/home"
export npm_config_cache="$probe/npm-cache"
export NPM_CONFIG_PREFIX="$probe/prefix"
export PATH="/opt/homebrew/opt/node@24/bin:/usr/bin:/bin"

npm install -g cli-path-doctor@0.6.0 --ignore-scripts
npm install -g "$probe/fixture/fixprobe-cli" --ignore-scripts
```

Each install adds one package. The prefix then contains two real bin links:

```console
$ ls -l /tmp/cpd-fix-0.6.0/prefix/bin
lrwxr-xr-x  1 felixwjd  wheel  59 ... cli-path-doctor -> ../lib/node_modules/cli-path-doctor/bin/cli-path-doctor.mjs
lrwxr-xr-x  1 felixwjd  wheel  48 ... fixprobe -> ../lib/node_modules/fixprobe-cli/bin/fixprobe.js
```

`/opt/homebrew/opt/node@24/bin` is on PATH only so the `#!/usr/bin/env node`
launchers and npm can start. The prefix's `bin` directory is deliberately absent
from every PATH the doctor checks. No `CLI_PATH_DOCTOR_*` override is set: the
login and non-login rows come from real shell probes, and the daemon-like row is
the built-in minimal PATH.

The rc file named by the fix is the file under the temporary `HOME`:

| | |
| --- | --- |
| Path | `/tmp/cpd-fix-0.6.0/home/.zshrc` |
| Size | 40 bytes |
| SHA-256 before any doctor run | `4ffb40a31896d6bf8ba5747d63009ac3df3b506200f15079f9f316deb4911a38` |
| Birth time (UTC) | `2026-11-11T17:49:57Z` |
| Modification time before any doctor run (UTC) | `2026-11-11T17:49:57Z` |

The "before" hash was recorded after the fixture was created and before either
npm install or any doctor invocation.

## `--help` has no `--fix`

The usage block lists four invocation forms and four options. There is no `fix`
form and no `--fix` option:

```console
$ cli-path-doctor --help | sed -n '1,12p'
cli-path-doctor: diagnose why a CLI command is missing across shells, npm installs, toolchains, and daemons.

Usage:
  cli-path-doctor <command>
  cli-path-doctor <command> --json
  cli-path-doctor --help
  cli-path-doctor --version

Contexts (one row each):
  current      the PATH of this process
  login        PATH reported by a login shell (for example: $SHELL -l -c)
  non-login    PATH reported by a non-login shell (for example: $SHELL -c)
```

The rest of the usage describes the four contexts, the output rules, the
options block below, and the feature list.

```console
$ cli-path-doctor --help | sed -n '/^Options:/,/^$/p'
Options:
  --json       machine-readable output
  --verbose    add shell/PATH diagnostics to text output
  -h, --help   show this help
  -v, --version
```

A direct search confirms the absence:

```console
$ cli-path-doctor --help | grep -n -- '--fix'
$ echo $?
1
```

`--fix` is not silently ignored, either. It falls through the unknown-option
branch of the parser and exits `2`:

```console
$ cli-path-doctor --fix fixprobe; echo "exit=$?"
cli-path-doctor: unknown option: --fix

cli-path-doctor: diagnose why a CLI command is missing across shells, npm installs, toolchains, and daemons.
... usage omitted ...
exit=2
```

So a user who guesses the flag the epic is about gets an error and the full
usage text, not a repair.

## What 0.6.0 prints

With `fixprobe` installed in the prefix and absent from every checked PATH:

```console
$ cli-path-doctor fixprobe
current      MISS (not found on PATH; npm bin exists at /tmp/cpd-fix-0.6.0/prefix/bin/fixprobe but is not on this PATH)
login        MISS (not found on PATH; npm bin exists at /tmp/cpd-fix-0.6.0/prefix/bin/fixprobe but is not on this PATH)
non-login    MISS (not found on PATH; npm bin exists at /tmp/cpd-fix-0.6.0/prefix/bin/fixprobe but is not on this PATH)
daemon-like  MISS (not found on PATH; npm bin exists at /tmp/cpd-fix-0.6.0/prefix/bin/fixprobe but is not on this PATH; login shell adds /System/Cryptexes/App/usr/bin, which this PATH lacks)
$ echo $?
1
```

stdout is the four rows. The repair is on stderr, in full:

```console
$ cli-path-doctor fixprobe 2>&1 >/dev/null
first login-only PATH directory: /System/Cryptexes/App/usr/bin
fixes:
  export PATH='/tmp/cpd-fix-0.6.0/prefix/bin':"$PATH"  # add to ~/.zshrc, then open a new shell
```

The fix line is exact and complete for a human:

```
export PATH='/tmp/cpd-fix-0.6.0/prefix/bin':"$PATH"  # add to ~/.zshrc, then open a new shell
```

It names the directory, the shell startup file, and the required action ("open a
new shell"). The `first login-only PATH directory` line is unrelated context
information from the real login-shell probe; it is not part of the fix.

What the tool does not do is any of the steps the line describes. It does not
append the export to `~/.zshrc`, it does not back up or validate that file, and
it does not start a new shell. The user still has to open the right file, paste
the line, save it, and start a fresh shell. If they skip the last step, the
current shell keeps the old PATH and the command stays missing.

### The same repair in `--json`

`--json` already carries everything a `--fix` implementation needs to locate the
target file and the block to write. This is the selected subset of
`cli-path-doctor fixprobe --json` (exit `1`), with the fields in their original
order; the full payload also contains the per-context rows, copies, npm, and
toolchain details:

```json
{
  "command": "fixprobe",
  "status": "miss",
  "resolved": false,
  "runnable": false,
  "exitCode": 1,
  "shell": "/bin/zsh",
  "shellName": "zsh",
  "rcFile": "~/.zshrc",
  "fixes": [
    "export PATH='/tmp/cpd-fix-0.6.0/prefix/bin':\"$PATH\"  # add to ~/.zshrc, then open a new shell"
  ]
}
```

The JSON has no `applied`, `written`, `changed`, or `backup` field. The `fixes`
array is the same list of strings the text mode prints; it is data about what a
human could do, not a record of anything the process did. `rcFile` is `~/.zshrc`,
not an absolute path, and is resolved under the `HOME` of the doctor process.

## The rc file is unchanged

The hash is identical before and after the text run, the JSON run, and the
`--fix` attempt. First, the hash recorded at fixture creation:

```console
$ cat /tmp/cpd-fix-0.6.0/rc-before.sha256
4ffb40a31896d6bf8ba5747d63009ac3df3b506200f15079f9f316deb4911a38  /tmp/cpd-fix-0.6.0/home/.zshrc
```

Then the same hash after all doctor runs:

```console
$ shasum -a 256 /tmp/cpd-fix-0.6.0/home/.zshrc
4ffb40a31896d6bf8ba5747d63009ac3df3b506200f15079f9f316deb4911a38  /tmp/cpd-fix-0.6.0/home/.zshrc
```

The two values match. The file's content is still exactly:

```console
$ cat /tmp/cpd-fix-0.6.0/home/.zshrc
# user zshrc
# keep me
export EDITOR=vi
```

Its modification time is still its birth time, `2026-11-11T17:49:57Z`, so it has
not been written since it was created:

```console
$ stat -f 'birth=%B modified=%m size=%z' /tmp/cpd-fix-0.6.0/home/.zshrc
birth=1794419397 modified=1794419397 size=40
```

`1794419397` is `2026-11-11T17:49:57Z` in both fields. A rewrite that preserved
the bytes would still normally change the modification time; no change occurred
at all.

Nothing else appeared under the temporary `HOME` either — no backup, state, or
`.zshrc`-adjacent file:

```console
$ find /tmp/cpd-fix-0.6.0/home -mindepth 1 -maxdepth 3 -print
/tmp/cpd-fix-0.6.0/home/.zshrc
```

## Summary

| Check | 0.6.0 result | Does it apply the fix? |
| --- | --- | --- |
| `--help` options | `--json`, `--verbose`, `-h/--help`, `-v/--version` | No `--fix` exists |
| `--fix fixprobe` | `unknown option: --fix`, exit `2` | Rejected |
| Text run | four `MISS` rows on stdout, exit `1`; fix line on stderr | Printed only |
| `--json` run | `shell`, `shellName`, `rcFile`, `fixes` present | Printed only |
| `~/.zshrc` SHA-256 | `4ffb40a3…4911a38` before and after | Unchanged |
| `~/.zshrc` mtime | birth time equals modification time | Unchanged |

The doctor correctly identifies the layer that broke: npm created a bin link,
but the prefix's `bin` directory is not on the shell PATH. It names the exact
directory and the exact startup file. The missing step is applying that repair.
This is the same gap as the 0.5.0 baseline for the unrunnable-command epic: the
diagnosis is useful, but it stops at advice.

## What the next milestone must change

The baseline makes the next milestone concrete:

1. Accept `--fix` as a real option instead of an unknown one, and keep `--help`
   honest by documenting it.
2. Write an idempotent PATH block into the `rcFile` for the detected shell
   (here `~/.zshrc`), creating the file if needed, without disturbing unrelated
   user content. Here the block would add
   `/tmp/cpd-fix-0.6.0/prefix/bin`, exactly the directory the stderr line names.
3. Report what was written, to which file, and how to undo it, and make a second
   `--fix` run detect its own block instead of appending a duplicate.
4. Prove it from a clean install: run `--fix` against this same fixture, show the
   rc file hash changes once, show a second run leaves it unchanged, and show the
   new shell resolves `fixprobe`.

This page is the recorded "before" for that work. Its numbers should be quoted
in the `--fix` validation page so the diff is against a real run, not a
description.
