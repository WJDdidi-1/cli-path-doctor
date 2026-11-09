#!/bin/sh
# Verify the user-level toolchain search.
#
# The fixture creates real executables in the default cargo, bun and volta bin
# directories under a temporary HOME, while every checked PATH omits those
# directories. For each command the doctor must name the installed binary, add
# the toolchain directory to PATH, and suppress `npm install -g`.
#
# A fourth command is genuinely absent from every toolchain directory even
# though those directories exist and contain other executables. It must still
# get the `npm install -g` fallback and no PATH advice.
#
# Run from anywhere:
#   sh docs/probes/toolchain-bins.sh
#
# Exits 0 only when all four cases behave as documented.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
cd "$ROOT"

NODE_BIN=${NODE_BIN:-$(command -v node || true)}
if [ -z "$NODE_BIN" ]; then
  echo "probe failed: node is required" >&2
  exit 1
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/cli-path-doctor-toolchain-probe.XXXXXX")
# Normalize the path: some TMPDIR values end in "/", and a doubled separator
# would make the fixture path differ from the path the doctor prints.
WORK=$(CDPATH= cd -- "$WORK" && pwd -P)
cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT HUP INT TERM

HOME_DIR="$WORK/home"
CARGO_BIN="$HOME_DIR/.cargo/bin"
BUN_BIN="$HOME_DIR/.bun/bin"
VOLTA_BIN="$HOME_DIR/.volta/bin"
NPM_PREFIX="$WORK/npm-prefix"
BASE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
SHELL_BIN="$WORK/zsh"
RC_FILE='~/.zshrc'

CARGO_COMMAND="toolchain-probe-cargo-cli"
BUN_COMMAND="toolchain-probe-bun-cli"
VOLTA_COMMAND="toolchain-probe-volta-cli"
ABSENT_COMMAND="toolchain-probe-absent-cli"

mkdir -p "$CARGO_BIN" "$BUN_BIN" "$VOLTA_BIN" "$NPM_PREFIX"
printf '#!/bin/sh\nexit 0\n' > "$SHELL_BIN"
chmod +x "$SHELL_BIN"
for entry in "$CARGO_BIN/$CARGO_COMMAND" "$BUN_BIN/$BUN_COMMAND" "$VOLTA_BIN/$VOLTA_COMMAND"; do
  printf '#!/bin/sh\nexit 0\n' > "$entry"
  chmod +x "$entry"
done
# Unrelated executables prove the directories are searched by command name,
# not merely reported as existing.
for entry in "$CARGO_BIN/unrelated-cargo" "$BUN_BIN/unrelated-bun" "$VOLTA_BIN/unrelated-volta"; do
  printf '#!/bin/sh\nexit 0\n' > "$entry"
  chmod +x "$entry"
done

# All toolchain overrides are blanked (the inspector treats an empty value as
# unset) so the probe cannot pick up a real installation from the host.
run_doctor() {
  mode=$1
  command=$2
  out=$3
  err=$4

  set -- "$command"
  if [ -n "$mode" ]; then
    set -- "$@" "$mode"
  fi

  set +e
  HOME="$HOME_DIR" \
  USERPROFILE="$HOME_DIR" \
  PATH="$BASE_PATH" \
  NPM_CONFIG_PREFIX="$NPM_PREFIX" \
  CLI_PATH_DOCTOR_SHELL="$SHELL_BIN" \
  CLI_PATH_DOCTOR_LOGIN_PATH="$BASE_PATH" \
  CLI_PATH_DOCTOR_NON_LOGIN_PATH="$BASE_PATH" \
  CLI_PATH_DOCTOR_DAEMON_PATH="$BASE_PATH" \
  CARGO_HOME= BUN_INSTALL= VOLTA_HOME= GOBIN= GOPATH= DENO_INSTALL= \
  PNPM_HOME= ASDF_DATA_DIR= MISE_DATA_DIR= PYENV_ROOT= RBENV_ROOT= \
  "$NODE_BIN" bin/cli-path-doctor.mjs "$@" > "$out" 2> "$err"
  STATUS=$?
  set -e
}

assert_found() {
  toolchain=$1
  directory=$2
  command=$3
  json=$4

  "$NODE_BIN" -e '
const fs = require("fs");
const path = require("path");
const [file, toolchain, directory, command, rcFile] = process.argv.slice(1);
const data = JSON.parse(fs.readFileSync(file, "utf8"));
function fail(message) {
  console.error(`probe failed: ${message}`);
  process.exit(1);
}
const expectedPath = path.join(directory, command);
const candidate = data.toolchains.candidates.find((entry) => entry.path === expectedPath);
if (!candidate) {
  fail(`no ${toolchain} candidate at ${expectedPath}: ${JSON.stringify(data.toolchains.candidates)}`);
}
if (candidate.toolchain !== toolchain) {
  fail(`candidate toolchain is ${JSON.stringify(candidate.toolchain)}, expected ${JSON.stringify(toolchain)}`);
}
if (!candidate.exists || !candidate.isFile || !candidate.executable || candidate.broken) {
  fail(`candidate is not a usable executable: ${JSON.stringify(candidate)}`);
}
if (!data.toolchains.hint || !data.toolchains.hint.includes(expectedPath)) {
  fail(`hint does not name ${expectedPath}: ${JSON.stringify(data.toolchains.hint)}`);
}
if (!/not on PATH/.test(data.toolchains.hint)) {
  fail(`hint does not say the directory is off PATH: ${JSON.stringify(data.toolchains.hint)}`);
}
const pathFixes = data.fixes.filter(
  (fix) => /export PATH=/.test(fix) && fix.includes(directory),
);
if (pathFixes.length !== 1) {
  fail(`expected exactly one PATH fix for ${directory}, got ${JSON.stringify(data.fixes)}`);
}
if (!pathFixes[0].includes(rcFile)) {
  fail(`PATH fix does not name ${rcFile}: ${pathFixes[0]}`);
}
if (data.fixes.some((fix) => fix.includes("npm install"))) {
  fail(`toolchain evidence did not suppress npm install advice: ${JSON.stringify(data.fixes)}`);
}
console.log(JSON.stringify({
  command,
  toolchain,
  directory,
  candidate: {
    path: candidate.path,
    toolchain: candidate.toolchain,
    directorySource: candidate.directorySource,
    executable: candidate.executable,
  },
  hint: data.toolchains.hint,
  fixes: data.fixes,
}, null, 2));
' "$json" "$toolchain" "$directory" "$command" "$RC_FILE"
}

assert_absent() {
  command=$1
  json=$2

  "$NODE_BIN" -e '
const fs = require("fs");
const [file, command] = process.argv.slice(1);
const data = JSON.parse(fs.readFileSync(file, "utf8"));
function fail(message) {
  console.error(`probe failed: ${message}`);
  process.exit(1);
}
if (data.toolchains.candidates.length !== 0) {
  fail(`expected no toolchain candidate for ${command}: ${JSON.stringify(data.toolchains.candidates)}`);
}
if (data.toolchains.hint !== null) {
  fail(`expected no toolchain hint for ${command}: ${JSON.stringify(data.toolchains.hint)}`);
}
const installFixes = data.fixes.filter((fix) => fix.includes("npm install -g"));
if (installFixes.length !== 1) {
  fail(`expected exactly one npm install fix, got ${JSON.stringify(data.fixes)}`);
}
if (!installFixes[0].includes(command)) {
  fail(`npm install fix does not name ${command}: ${installFixes[0]}`);
}
if (data.fixes.some((fix) => /export PATH=/.test(fix))) {
  fail(`did not expect PATH advice for an absent command: ${JSON.stringify(data.fixes)}`);
}
console.log(JSON.stringify({
  command,
  candidates: data.toolchains.candidates,
  hint: data.toolchains.hint,
  fixes: data.fixes,
}, null, 2));
' "$json" "$command"
}

for toolchain in cargo bun volta; do
  case "$toolchain" in
    cargo)
      command=$CARGO_COMMAND
      directory=$CARGO_BIN
      ;;
    bun)
      command=$BUN_COMMAND
      directory=$BUN_BIN
      ;;
    volta)
      command=$VOLTA_COMMAND
      directory=$VOLTA_BIN
      ;;
  esac

  JSON_OUT="$WORK/$toolchain.json"
  JSON_ERR="$WORK/$toolchain.json.stderr"
  TEXT_OUT="$WORK/$toolchain.stdout"
  TEXT_ERR="$WORK/$toolchain.stderr"

  echo "===== $toolchain: $command (installed at $directory) ====="
  echo "\$ HOME=\"\$HOME\" PATH=$BASE_PATH NPM_CONFIG_PREFIX=\"\$PREFIX\" \\"
  echo "    CLI_PATH_DOCTOR_SHELL=\"\$SHELL_BIN\" \\"
  echo "    CLI_PATH_DOCTOR_LOGIN_PATH=\"\$PATH\" \\"
  echo "    CLI_PATH_DOCTOR_NON_LOGIN_PATH=\"\$PATH\" \\"
  echo "    CLI_PATH_DOCTOR_DAEMON_PATH=\"\$PATH\" \\"
  echo "    $NODE_BIN bin/cli-path-doctor.mjs $command --json"

  run_doctor --json "$command" "$JSON_OUT" "$JSON_ERR"
  if [ "$STATUS" -ne 1 ]; then
    echo "probe failed: expected exit 1 from --json for $command, got $STATUS" >&2
    cat "$JSON_ERR" >&2
    exit 1
  fi

  assert_found "$toolchain" "$directory" "$command" "$JSON_OUT"

  echo "--- text stderr (the copy-paste fixes) ---"
  run_doctor "" "$command" "$TEXT_OUT" "$TEXT_ERR"
  if [ "$STATUS" -ne 1 ]; then
    echo "probe failed: expected exit 1 from text output for $command, got $STATUS" >&2
    cat "$TEXT_ERR" >&2
    exit 1
  fi

  case "$(cat "$TEXT_ERR")" in
    *"$directory"*) ;;
    *)
      echo "probe failed: stderr does not name $directory" >&2
      cat "$TEXT_ERR" >&2
      exit 1
      ;;
  esac
  case "$(cat "$TEXT_ERR")" in
    *"$RC_FILE"*) ;;
    *)
      echo "probe failed: stderr does not name $RC_FILE" >&2
      cat "$TEXT_ERR" >&2
      exit 1
      ;;
  esac
  if grep -F "npm install" "$TEXT_ERR" >/dev/null 2>&1; then
    echo "probe failed: stderr suggests npm install for a toolchain binary" >&2
    cat "$TEXT_ERR" >&2
    exit 1
  fi

  cat "$TEXT_ERR"
  echo "--- exit code: $STATUS ---"
  echo
done

echo "===== genuinely absent: $ABSENT_COMMAND ====="
echo "\$ HOME=\"\$HOME\" PATH=$BASE_PATH NPM_CONFIG_PREFIX=\"\$PREFIX\" \\"
echo "    CLI_PATH_DOCTOR_SHELL=\"\$SHELL_BIN\" \\"
echo "    CLI_PATH_DOCTOR_LOGIN_PATH=\"\$PATH\" \\"
echo "    CLI_PATH_DOCTOR_NON_LOGIN_PATH=\"\$PATH\" \\"
echo "    CLI_PATH_DOCTOR_DAEMON_PATH=\"\$PATH\" \\"
echo "    $NODE_BIN bin/cli-path-doctor.mjs $ABSENT_COMMAND --json"

run_doctor --json "$ABSENT_COMMAND" "$WORK/absent.json" "$WORK/absent.json.stderr"
if [ "$STATUS" -ne 1 ]; then
  echo "probe failed: expected exit 1 from --json for $ABSENT_COMMAND, got $STATUS" >&2
  cat "$WORK/absent.json.stderr" >&2
  exit 1
fi

assert_absent "$ABSENT_COMMAND" "$WORK/absent.json"

echo "--- text stderr (the copy-paste fixes) ---"
run_doctor "" "$ABSENT_COMMAND" "$WORK/absent.stdout" "$WORK/absent.stderr"
if [ "$STATUS" -ne 1 ]; then
  echo "probe failed: expected exit 1 from text output for $ABSENT_COMMAND, got $STATUS" >&2
  cat "$WORK/absent.stderr" >&2
  exit 1
fi

case "$(cat "$WORK/absent.stderr")" in
  *"npm install -g"*"$ABSENT_COMMAND"*) ;;
  *)
    echo "probe failed: stderr does not contain the npm install fallback" >&2
    cat "$WORK/absent.stderr" >&2
    exit 1
    ;;
esac

cat "$WORK/absent.stderr"
echo "--- exit code: $STATUS ---"
echo

echo "OK: cargo, bun and volta binaries were named and fixed; the absent command kept the npm fallback"
