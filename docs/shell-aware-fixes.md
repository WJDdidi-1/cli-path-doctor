# Verified: shell-aware fixes name the rc file

This page records the verification for the epic milestone **"Make the fixes say
which shell file to edit"**. The previous advice was generic: it could suggest a
login-only PATH directory that had nothing to do with the missing command, and
it never named the shell startup file to edit. The merged implementation
(`745b992`) maps the detected shell to its startup file and attaches that file
to every POSIX PATH fix.

## What the probe verifies

The probe is a real fixture, not a mocked payload: a temporary npm global
prefix contains an executable `shell-probe-cli` in `<prefix>/bin`, while the
checked PATHs deliberately omit that directory. A second, unrelated directory
is placed on the login-only PATH so the doctor has a login-only difference that
cannot contain the command.

For each of `SHELL=/bin/zsh` and `SHELL=/bin/bash`, the probe asserts:

- `shellName` is `zsh` / `bash` and the top-level `rcFile` is `~/.zshrc` /
  `~/.bashrc`.
- Exactly one `fixes` entry is an `export PATH=` line for `<prefix>/bin`, and
  that line names the same rc file.
- `loginOnlyDirectory` is the unrelated directory, but no `fixes` entry tells
  the user to add it.
- There is no `npm install -g` line, because the npm bin already exists.
- The text-mode stderr names the same rc file and the same `<prefix>/bin`
  directory as the JSON `fixes` array.
- Both modes exit `1`: the command is genuinely missing from every checked
  context, and naming the fix does not pretend otherwise.

## The probe

Run it from the repository root (or from anywhere; the script resolves the
checkout itself):

```sh
sh docs/probes/shell-aware-fixes.sh
```

The script is POSIX `sh`, uses only Node.js and standard shell tools, creates
its fixture under `mktemp -d`, and removes it on exit. It unsets
`CLI_PATH_DOCTOR_SHELL` first, because that override takes precedence over
`SHELL`; this makes the run exercise the documented `SHELL` detection path.
`NPM_CONFIG_PREFIX` points at the fixture prefix, so no real global install and
no network call are involved.

## Captured run

- **Date:** 2026-11-09 (UTC)
- **Machine:** macOS 27.2 (Darwin 27.2.0), arm64
- **Node.js:** v24.15.0
- **Shells:** `/bin/zsh` and `/bin/bash`
- **Source under test:** commit `745b992e6b92b47ab016f0761c6f033b5c361ece`

The temporary path below is the `mktemp -d` directory for this run; it is
removed when the probe exits.

```console
$ sh docs/probes/shell-aware-fixes.sh
===== SHELL=/bin/zsh =====
$ SHELL=/bin/zsh PATH=/usr/bin:/bin NPM_CONFIG_PREFIX="$PREFIX" \
    CLI_PATH_DOCTOR_LOGIN_PATH="$IRRELEVANT:/usr/bin:/bin" \
    CLI_PATH_DOCTOR_NON_LOGIN_PATH=/usr/bin:/bin \
    CLI_PATH_DOCTOR_DAEMON_PATH=/usr/bin:/bin \
    /opt/homebrew/opt/node@24/bin/node bin/cli-path-doctor.mjs shell-probe-cli --json
{
  "shell": "/bin/zsh",
  "shellName": "zsh",
  "rcFile": "~/.zshrc",
  "loginOnlyDirectory": "/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shell-probe.2UT0UT/login-only-irrelevant",
  "fixes": [
    "export PATH='/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shell-probe.2UT0UT/prefix/bin':\"$PATH\"  # add to ~/.zshrc, then open a new shell"
  ]
}
--- text stderr (the copy-paste fixes) ---
first login-only PATH directory: /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shell-probe.2UT0UT/login-only-irrelevant
fixes:
  export PATH='/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shell-probe.2UT0UT/prefix/bin':"$PATH"  # add to ~/.zshrc, then open a new shell
--- exit code: 1 ---

===== SHELL=/bin/bash =====
$ SHELL=/bin/bash PATH=/usr/bin:/bin NPM_CONFIG_PREFIX="$PREFIX" \
    CLI_PATH_DOCTOR_LOGIN_PATH="$IRRELEVANT:/usr/bin:/bin" \
    CLI_PATH_DOCTOR_NON_LOGIN_PATH=/usr/bin:/bin \
    CLI_PATH_DOCTOR_DAEMON_PATH=/usr/bin:/bin \
    /opt/homebrew/opt/node@24/bin/node bin/cli-path-doctor.mjs shell-probe-cli --json
{
  "shell": "/bin/bash",
  "shellName": "bash",
  "rcFile": "~/.bashrc",
  "loginOnlyDirectory": "/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shell-probe.2UT0UT/login-only-irrelevant",
  "fixes": [
    "export PATH='/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shell-probe.2UT0UT/prefix/bin':\"$PATH\"  # add to ~/.bashrc, then open a new shell"
  ]
}
--- text stderr (the copy-paste fixes) ---
first login-only PATH directory: /private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shell-probe.2UT0UT/login-only-irrelevant
fixes:
  export PATH='/private/var/folders/lq/04c4wm1x23j3zy1psr9z3_0w0000gn/T/cli-path-doctor-shell-probe.2UT0UT/prefix/bin':"$PATH"  # add to ~/.bashrc, then open a new shell
--- exit code: 1 ---

OK: SHELL=/bin/zsh named ~/.zshrc and SHELL=/bin/bash named ~/.bashrc
```

The key comparison is the `fixes` entry in each block: the directory is the
same npm prefix bin in both runs, while the trailing comment changes from
`~/.zshrc` to `~/.bashrc` with the detected shell. The unrelated login-only
directory appears only in `loginOnlyDirectory` and in the explanatory stderr
line, never in the copy-paste fixes.

## How the shell mapping is chosen

`lib/shell-rc.mjs` owns the mapping. `resolveShell` (in `lib/contexts.mjs`)
uses `CLI_PATH_DOCTOR_SHELL` first, then `SHELL`, then falls back to a usable
`/bin/sh`, `/usr/bin/sh`, or `/bin/bash`. The rc file is then attached by
`formatPathFix`, and the CLI also exposes it as the top-level `rcFile` field in
`--json`.

| Detected shell | Startup file named in the fix |
| --- | --- |
| `zsh` (including versioned names) | `~/.zshrc` |
| `bash` (including versioned names) | `~/.bashrc` |
| `fish` | `~/.config/fish/config.fish` (fix uses `fish_add_path`) |
| `ksh` | `~/.kshrc` |
| `mksh` | `~/.mkshrc` |
| `dash`, `sh`, `ash`, `yash`, unknown POSIX shell | `~/.profile` |
| Windows / PowerShell | `$PROFILE` (fix uses the PowerShell `$env:Path` form) |

The fix is one copy-pasteable line:

```text
export PATH='<directory>':"$PATH"  # add to <rc file>, then open a new shell
```

`--json` keeps the same line in the top-level `fixes` array, so CI or tooling
can read the advice without scraping stderr. When no checked directory can
contain the command and there is no npm evidence, the array contains the
fallback `npm install -g '<command>'` instead.

## Scope

The doctor prints the fix; it does not edit the rc file. The named file is the
conventional startup file for the detected shell, not proof that every startup
mode reads it (for example, a login bash shell may read `~/.bash_profile`
first). The text output and the JSON `fixes` array always carry the same
advice.
