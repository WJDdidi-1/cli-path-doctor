# Measured: `--fix` from a clean install, and undo

This page records the acceptance run for the final milestone of the epic
**"Apply the PATH fix instead of only printing it"**. The package under test is
the tarball produced by `npm pack` from this checkout, not the source tree and
not a published npm release. The doctor is installed into an isolated prefix,
writes into a temporary `HOME`, and the startup file is read by a fresh login
shell before and after the documented undo.

The short result:

- `npm pack` + `npm install -g` produces a real installed bin, and a real global
  bin entry exists in a directory that no checked PATH contains.
- `cli-path-doctor <command> --fix --json` reports
  `applied: true`, `alreadyPresent: false`, and writes one marked block to
  `$PROBE/home/.profile` (`/bin/sh` is the detected shell).
- The block names the directory in both markers, carries the undo note, and
  contains the same `export PATH=...` line the text mode used to print.
- A second `--fix` reports `applied: false`, `alreadyPresent: true`, leaves the
  startup file byte-for-byte unchanged, and keeps exactly one block.
- A fresh login shell (`/bin/sh -l`) with the temporary `HOME` resolves the
  command to the real file in the prefix's `bin` directory.
- Removing the marker block with the documented `sed` range removes it from the
  login shell's PATH: the same fresh login shell no longer resolves the command,
  while unrelated startup-file content remains.

No source was changed for this milestone. The change is the packed-install
acceptance test (`test/clean-install-fix.test.mjs`), the reproducible probe
(`docs/probes/fix-clean-install.sh`), the README documentation, and this record.

## What was measured

| | |
| --- | --- |
| Date | 2026-11-11T18:09:50Z |
| Machine | macOS 27.2.1 (Darwin 27.2.0), arm64 |
| Node.js | v24.15.0 |
| npm | 11.12.1 |
| Package under test | `cli-path-doctor` packed from this checkout |
| Packed version | `0.6.0` (the unreleased `--fix` change is in this tree) |
| Checkout reference | `48655d45dfde569c037dc69f7fa427c2c22b0333` |
| Startup file | `$PROBE/home/.profile` (detected shell `/bin/sh`) |
| Command | `fixprobe-<pid>`, a real global bin link in `$PROBE/prefix/bin` |

`$PROBE` is the `mktemp -d` directory for the run. The captured lines below use
it in place of the random `/private/var/folders/.../cli-path-doctor-fix-clean.*`
root so the block stays readable; only that root differs from the raw output.

## How to reproduce

The probe packs the current tree, installs the tarball with an isolated
`HOME`, prefix, and npm cache, and runs every check itself:

```sh
sh docs/probes/fix-clean-install.sh
```

It prints the packed tarball contents, the installed version, both `--fix`
runs, the resulting startup file, the fresh login-shell lookup, and the undo
check, then exits `0` only when all of them pass. It is also run as
`test/clean-install-fix.test.mjs` under `npm test`.

## First `--fix`

The temporary startup file starts with unrelated user content:

```sh
# user profile
# keep me
export EDITOR=vi
```

The command's directory is on no checked PATH. The installed doctor is invoked
by absolute path with a forced `/bin/sh` detection so the startup file is
predictable; the login, non-login, and daemon-like PATHs are fixed to the same
safe base PATH so a real host profile cannot hide the fixture:

```console
$ HOME="$PROBE/home" PATH="$SAFE_PATH" NPM_CONFIG_PREFIX="$PROBE/prefix" \
    CLI_PATH_DOCTOR_SHELL=/bin/sh \
    CLI_PATH_DOCTOR_LOGIN_PATH="$SAFE_PATH" \
    CLI_PATH_DOCTOR_NON_LOGIN_PATH="$SAFE_PATH" \
    CLI_PATH_DOCTOR_DAEMON_PATH="$SAFE_PATH" \
    node "$PROBE/prefix/bin/cli-path-doctor" fixprobe-$$ --fix --json
{
  "applied": true,
  "alreadyPresent": false,
  "file": "$PROBE/home/.profile",
  "line": "export PATH='$PROBE/prefix/bin':\"$PATH\"",
  "reason": null
}
```

The exit code is `1` because no checked context can run the command yet. After
the first run the startup file contains the original lines plus one managed
block:

```sh
# user profile
# keep me
export EDITOR=vi

# >>> cli-path-doctor: $PROBE/prefix/bin >>>
# Managed by cli-path-doctor --fix. Delete this block to undo.
export PATH='$PROBE/prefix/bin':"$PATH"
# <<< cli-path-doctor: $PROBE/prefix/bin <<<
```

The probe also asserts that the marker count is exactly one, that both markers
include the prefix `bin` directory, and that the original profile text is still
the prefix of the file.

## Second `--fix` changes nothing

Running the same command again reports the block as present rather than adding
another one:

```console
$ ... node "$PROBE/prefix/bin/cli-path-doctor" fixprobe-$$ --fix --json
{
  "applied": false,
  "alreadyPresent": true,
  "file": "$PROBE/home/.profile",
  "line": "export PATH='$PROBE/prefix/bin':\"$PATH\"",
  "reason": "PATH fix already present in $PROBE/home/.profile"
}
checked: second --fix applied=false, alreadyPresent=true
checked: the startup file is byte-for-byte unchanged
```

The byte-for-byte check is `cmp` against the copy taken after the first run,
not a normalized comparison. The marker count is still one.

## A fresh login shell resolves the command

With the temporary `HOME` and the same safe PATH, a new login shell reads
`.profile` and finds the command through the block:

```console
$ HOME="$PROBE/home" PATH="$SAFE_PATH" /bin/sh -l -c 'command -v "$1"' sh fixprobe-$$
$PROBE/prefix/bin/fixprobe-$$
```

The probe requires exit code `0` and requires stdout to equal the real
executable path, so a command that merely appears in the file does not pass.

## Undo removes the block

The README undo command deletes the marker range and keeps a backup:

```sh
sed -i.bak '/^# >>> cli-path-doctor: .* >>>$/,/^# <<< cli-path-doctor: .* <<<$/d' ~/.profile
```

The probe applies the same range to the temporary `.profile`, then checks that
no `cli-path-doctor` marker remains and that the unrelated
`export EDITOR=vi` line is still there. A fresh login shell no longer resolves
the command:

```console
$ HOME="$PROBE/home" PATH="$SAFE_PATH" /bin/sh -l -c 'command -v "$1"' sh fixprobe-$$
$ echo $?
1
checked: fresh login shell no longer resolves fixprobe-$$
```

Removing the block does not uninstall the command; it only removes that
directory from the login shell's PATH when the startup file is read. The
current shell is not modified by `--fix`, so both the fix and the undo take
effect in a new shell.

## Limits of this check

- The probe forces `/bin/sh`, which writes `~/.profile`. The same code path
  covers zsh (`~/.zshrc`), bash (`~/.bashrc`), and fish
  (`~/.config/fish/config.fish`); the existing `fix-apply` and shell-aware
  tests exercise those spellings.
- The probe does not run on Windows. `--fix` refuses on Windows by design
  because the supported shell startup mapping is POSIX; use your PowerShell
  `$PROFILE` there.
- The probe installs the local packed tarball offline; it does not test a
  registry publish, which happens in a separate release step.
