# Examples

## `path-gap.mjs`: "works in my shell, missing in the daemon"

A runnable reproduction of the failure `cli-path-doctor` is built for. The
script creates a throwaway executable in a temp directory, puts that directory
only on the `login` context's PATH, runs the doctor, and checks the output.

```sh
# from the repository root
node examples/path-gap.mjs

# or through the package script
npm run example
```

The script prints the doctor's real output. On POSIX it looks like this
(paths shortened):

```console
$ node examples/path-gap.mjs
Runnable example: "works in my shell, missing in the daemon"

fixture: /tmp/cli-path-doctor-example-XXXX/bin/demo-path-doctor-12345
command: demo-path-doctor-12345

$ node bin/cli-path-doctor.mjs demo-path-doctor-12345
current      MISS (not found on PATH)
login        /tmp/cli-path-doctor-example-XXXX/bin/demo-path-doctor-12345
non-login    MISS (not found on PATH)
daemon-like  MISS (not found on PATH; login shell adds /tmp/cli-path-doctor-example-XXXX/bin, which this PATH lacks)
first login-only PATH directory: /tmp/cli-path-doctor-example-XXXX/bin
fixes:
  export PATH='/tmp/cli-path-doctor-example-XXXX/bin':"$PATH"
exit code: 0
```

What the script checks:

- `current` and `non-login` miss the command.
- `login` resolves it.
- The `daemon-like` row misses it and names the first login-only directory.
- stderr names the same directory and prints a copy-paste PATH fix.
- The exit code is `0`, because at least one checked context resolves the
  command.

The example is cross-platform: on Windows it writes a `.CMD` fixture and
`PATHEXT`/PowerShell forms are used. It has no dependencies, makes no network
call, and only sets `CLI_PATH_DOCTOR_LOGIN_PATH` and
`CLI_PATH_DOCTOR_NON_LOGIN_PATH` for the child process. The temp directory is
removed when the script exits.

For the opposite case, replace the command with one that exists nowhere and
the doctor prints four `MISS` rows and exits `1`.
