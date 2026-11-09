#!/bin/sh
# Verify that the fixes name the startup file for the detected shell.
#
# The fixture is a real npm global prefix whose bin directory contains the
# command but is not on any checked PATH. A second, unrelated directory is put
# on the login-only PATH: the doctor must name it as a context difference but
# must not suggest adding it, because it cannot contain the command.
#
# Run from anywhere:
#   sh docs/probes/shell-aware-fixes.sh
#
# Exits 0 only when both SHELL=/bin/zsh and SHELL=/bin/bash produce the right
# rc file in the JSON `rcFile` field, in each `fixes` entry, and in stderr.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
cd "$ROOT"

NODE_BIN=${NODE_BIN:-$(command -v node || true)}
if [ -z "$NODE_BIN" ]; then
  echo "probe failed: node is required" >&2
  exit 1
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/cli-path-doctor-shell-probe.XXXXXX")
# Normalize the path: some TMPDIR values end in "/", and a doubled separator
# would make the fixture path differ from the path the doctor prints.
WORK=$(CDPATH= cd -- "$WORK" && pwd -P)
cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT HUP INT TERM

PREFIX="$WORK/prefix"
PREFIX_BIN="$PREFIX/bin"
IRRELEVANT="$WORK/login-only-irrelevant"
COMMAND="shell-probe-cli"

mkdir -p "$PREFIX_BIN" "$IRRELEVANT"
printf '#!/bin/sh\nexit 0\n' > "$PREFIX_BIN/$COMMAND"
chmod +x "$PREFIX_BIN/$COMMAND"

# CLI_PATH_DOCTOR_SHELL wins over SHELL in the doctor. Unset it so the probe
# exercises the documented SHELL detection path.
unset CLI_PATH_DOCTOR_SHELL

for SHELL_PATH in /bin/zsh /bin/bash; do
  NAME=${SHELL_PATH##*/}

  case "$NAME" in
    zsh) RC_FILE='~/.zshrc' ;;
    bash) RC_FILE='~/.bashrc' ;;
    *)
      echo "probe failed: no expected rc file for $SHELL_PATH" >&2
      exit 1
      ;;
  esac

  if [ ! -x "$SHELL_PATH" ]; then
    echo "probe failed: $SHELL_PATH is not executable on this machine" >&2
    exit 1
  fi

  JSON_OUT="$WORK/$NAME.json"
  JSON_ERR="$WORK/$NAME.json.stderr"
  TEXT_OUT="$WORK/$NAME.stdout"
  TEXT_ERR="$WORK/$NAME.stderr"

  echo "===== SHELL=$SHELL_PATH ====="
  echo "\$ SHELL=$SHELL_PATH PATH=/usr/bin:/bin NPM_CONFIG_PREFIX=\"\$PREFIX\" \\"
  echo "    CLI_PATH_DOCTOR_LOGIN_PATH=\"\$IRRELEVANT:/usr/bin:/bin\" \\"
  echo "    CLI_PATH_DOCTOR_NON_LOGIN_PATH=/usr/bin:/bin \\"
  echo "    CLI_PATH_DOCTOR_DAEMON_PATH=/usr/bin:/bin \\"
  echo "    $NODE_BIN bin/cli-path-doctor.mjs $COMMAND --json"

  set +e
  SHELL="$SHELL_PATH" \
  PATH=/usr/bin:/bin \
  NPM_CONFIG_PREFIX="$PREFIX" \
  CLI_PATH_DOCTOR_LOGIN_PATH="$IRRELEVANT:/usr/bin:/bin" \
  CLI_PATH_DOCTOR_NON_LOGIN_PATH=/usr/bin:/bin \
  CLI_PATH_DOCTOR_DAEMON_PATH=/usr/bin:/bin \
  "$NODE_BIN" bin/cli-path-doctor.mjs "$COMMAND" --json > "$JSON_OUT" 2> "$JSON_ERR"
  JSON_STATUS=$?
  set -e

  if [ "$JSON_STATUS" -ne 1 ]; then
    echo "probe failed: expected exit 1 from --json, got $JSON_STATUS" >&2
    cat "$JSON_ERR" >&2
    exit 1
  fi

  "$NODE_BIN" -e '
const fs = require("fs");
const [file, expectedName, expectedRc, prefixBin, irrelevant] = process.argv.slice(1);
const data = JSON.parse(fs.readFileSync(file, "utf8"));
function fail(message) {
  console.error(`probe failed: ${message}`);
  process.exit(1);
}
if (data.shellName !== expectedName) {
  fail(`shellName is ${JSON.stringify(data.shellName)}, expected ${JSON.stringify(expectedName)}`);
}
if (data.rcFile !== expectedRc) {
  fail(`rcFile is ${JSON.stringify(data.rcFile)}, expected ${JSON.stringify(expectedRc)}`);
}
if (data.loginOnlyDirectory !== irrelevant) {
  fail(`loginOnlyDirectory is ${JSON.stringify(data.loginOnlyDirectory)}, expected ${JSON.stringify(irrelevant)}`);
}
const pathFixes = data.fixes.filter(
  (fix) => /export PATH=/.test(fix) && fix.includes(prefixBin),
);
if (pathFixes.length !== 1) {
  fail(`expected exactly one PATH fix for ${prefixBin}, got ${JSON.stringify(data.fixes)}`);
}
if (!pathFixes[0].includes(expectedRc)) {
  fail(`PATH fix does not name ${expectedRc}: ${pathFixes[0]}`);
}
if (data.fixes.some((fix) => fix.includes(irrelevant))) {
  fail(`fixes suggest the unrelated login-only directory: ${JSON.stringify(data.fixes)}`);
}
if (data.fixes.some((fix) => fix.includes("npm install -g"))) {
  fail(`fixes suggest a reinstall although the npm bin exists: ${JSON.stringify(data.fixes)}`);
}
console.log(JSON.stringify({
  shell: data.shell,
  shellName: data.shellName,
  rcFile: data.rcFile,
  loginOnlyDirectory: data.loginOnlyDirectory,
  fixes: data.fixes,
}, null, 2));
' "$JSON_OUT" "$NAME" "$RC_FILE" "$PREFIX_BIN" "$IRRELEVANT"

  echo "--- text stderr (the copy-paste fixes) ---"
  set +e
  SHELL="$SHELL_PATH" \
  PATH=/usr/bin:/bin \
  NPM_CONFIG_PREFIX="$PREFIX" \
  CLI_PATH_DOCTOR_LOGIN_PATH="$IRRELEVANT:/usr/bin:/bin" \
  CLI_PATH_DOCTOR_NON_LOGIN_PATH=/usr/bin:/bin \
  CLI_PATH_DOCTOR_DAEMON_PATH=/usr/bin:/bin \
  "$NODE_BIN" bin/cli-path-doctor.mjs "$COMMAND" > "$TEXT_OUT" 2> "$TEXT_ERR"
  TEXT_STATUS=$?
  set -e

  if [ "$TEXT_STATUS" -ne 1 ]; then
    echo "probe failed: expected exit 1 from text output, got $TEXT_STATUS" >&2
    cat "$TEXT_ERR" >&2
    exit 1
  fi

  case "$(cat "$TEXT_ERR")" in
    *"$RC_FILE"*) ;;
    *)
      echo "probe failed: stderr does not name $RC_FILE" >&2
      cat "$TEXT_ERR" >&2
      exit 1
      ;;
  esac

  case "$(cat "$TEXT_ERR")" in
    *"$PREFIX_BIN"*) ;;
    *)
      echo "probe failed: stderr does not name $PREFIX_BIN" >&2
      cat "$TEXT_ERR" >&2
      exit 1
      ;;
  esac

  cat "$TEXT_ERR"
  echo "--- exit code: $TEXT_STATUS ---"
  echo
done

echo "OK: SHELL=/bin/zsh named ~/.zshrc and SHELL=/bin/bash named ~/.bashrc"
