#!/bin/sh
# Verify shadowed-copy reporting with real executables on PATH.
#
# Case 1 - two copies. A temporary `a/bin/shadow-probe-cli` precedes
# `b/bin/shadow-probe-cli` on every checked PATH. The doctor must name the
# winner and the shadowed copy in text and in --json, and it must not suggest
# exporting either directory because both are already on PATH.
#
# Case 2 - one copy. Only `a/bin/shadow-probe-cli` exists, and its directory is
# repeated on PATH. A repeated directory is not a second copy: the doctor must
# stay quiet and --json must expose empty shadowing evidence.
#
# Run from anywhere:
#   sh docs/probes/shadowed-copies.sh
#
# Exits 0 only when both cases behave as documented.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
cd "$ROOT"

NODE_BIN=${NODE_BIN:-$(command -v node || true)}
if [ -z "$NODE_BIN" ]; then
  echo "probe failed: node is required" >&2
  exit 1
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/cli-path-doctor-shadow-probe.XXXXXX")
# Normalize the path: some TMPDIR values end in "/", and a doubled separator
# would make the fixture path differ from the path the doctor prints.
WORK=$(CDPATH= cd -- "$WORK" && pwd -P)
cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT HUP INT TERM

HOME_DIR="$WORK/home"
NPM_PREFIX="$WORK/npm-prefix"
FIRST_BIN="$WORK/a/bin"
SECOND_BIN="$WORK/b/bin"
COMMAND="shadow-probe-cli"
BASE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

mkdir -p "$FIRST_BIN" "$SECOND_BIN" "$NPM_PREFIX" "$HOME_DIR"
printf '#!/bin/sh\nprintf "1.0\\n"\n' > "$FIRST_BIN/$COMMAND"
printf '#!/bin/sh\nprintf "2.0\\n"\n' > "$SECOND_BIN/$COMMAND"
chmod +x "$FIRST_BIN/$COMMAND" "$SECOND_BIN/$COMMAND"

# All toolchain overrides are blanked (the inspector treats an empty value as
# unset) so the probe cannot pick up a real installation from the host.
run_doctor() {
  path_value=$1
  mode=$2
  out=$3
  err=$4

  set -- "$COMMAND"
  if [ -n "$mode" ]; then
    set -- "$@" "$mode"
  fi

  set +e
  HOME="$HOME_DIR" \
  USERPROFILE="$HOME_DIR" \
  PATH="$path_value" \
  NPM_CONFIG_PREFIX="$NPM_PREFIX" \
  npm_config_prefix="$NPM_PREFIX" \
  CLI_PATH_DOCTOR_LOGIN_PATH="$path_value" \
  CLI_PATH_DOCTOR_NON_LOGIN_PATH="$path_value" \
  CLI_PATH_DOCTOR_DAEMON_PATH="$path_value" \
  CARGO_HOME= BUN_INSTALL= VOLTA_HOME= GOBIN= GOPATH= DENO_INSTALL= \
  PNPM_HOME= ASDF_DATA_DIR= MISE_DATA_DIR= PYENV_ROOT= RBENV_ROOT= \
  "$NODE_BIN" bin/cli-path-doctor.mjs "$@" > "$out" 2> "$err"
  STATUS=$?
  set -e
}

WINNER="$FIRST_BIN/$COMMAND"
LOSER="$SECOND_BIN/$COMMAND"
TWO_COPIES="$FIRST_BIN:$SECOND_BIN:$BASE_PATH"
ONE_COPY_REPEATED="$FIRST_BIN:$FIRST_BIN:$BASE_PATH"

assert_no_path_fix() {
  file=$1
  first=$2
  second=$3

  "$NODE_BIN" -e '
const fs = require("fs");
const [file, first, second] = process.argv.slice(1);
const data = JSON.parse(fs.readFileSync(file, "utf8"));
function fail(message) {
  console.error(`probe failed: ${message}`);
  process.exit(1);
}
const pathFixes = data.fixes.filter((fix) => /export PATH=|env:Path/.test(fix));
for (const directory of [first, second]) {
  if (pathFixes.some((fix) => fix.includes(directory))) {
    fail(`useless PATH fix for ${directory}: ${JSON.stringify(pathFixes)}`);
  }
}
console.log(JSON.stringify({ fixes: data.fixes }, null, 2));
' "$file" "$first" "$second"
}

echo "===== case 1: two copies ($WINNER wins over $LOSER) ====="
echo "\$ PATH=\"$TWO_COPIES\" \\"
echo "    CLI_PATH_DOCTOR_LOGIN_PATH=\"\$PATH\" \\"
echo "    CLI_PATH_DOCTOR_NON_LOGIN_PATH=\"\$PATH\" \\"
echo "    CLI_PATH_DOCTOR_DAEMON_PATH=\"\$PATH\" \\"
echo "    $NODE_BIN bin/cli-path-doctor.mjs $COMMAND"

run_doctor "$TWO_COPIES" "" "$WORK/two.stdout" "$WORK/two.stderr"
if [ "$STATUS" -ne 0 ]; then
  echo "probe failed: expected exit 0 for the shadowing case, got $STATUS" >&2
  cat "$WORK/two.stderr" >&2
  exit 1
fi

case "$(cat "$WORK/two.stdout")" in
  *"$WINNER"*) ;;
  *)
    echo "probe failed: stdout does not name the winner $WINNER" >&2
    cat "$WORK/two.stdout" >&2
    exit 1
    ;;
esac
case "$(cat "$WORK/two.stdout")" in
  *"$LOSER"*) ;;
  *)
    echo "probe failed: stdout does not name the shadowed copy $LOSER" >&2
    cat "$WORK/two.stdout" >&2
    exit 1
    ;;
esac
case "$(cat "$WORK/two.stdout")" in
  *"wins; shadows"*) ;;
  *)
    echo "probe failed: stdout does not say which copy wins" >&2
    cat "$WORK/two.stdout" >&2
    exit 1
    ;;
esac
case "$(cat "$WORK/two.stderr")" in
  *"shadowed copies:"*) ;;
  *)
    echo "probe failed: stderr does not print the shadowed-copies block" >&2
    cat "$WORK/two.stderr" >&2
    exit 1
    ;;
esac

echo "--- stdout ---"
cat "$WORK/two.stdout"
echo "--- stderr (guidance) ---"
cat "$WORK/two.stderr"
echo "--- exit code: $STATUS ---"
echo

run_doctor "$TWO_COPIES" "--json" "$WORK/two.json" "$WORK/two.json.stderr"
if [ "$STATUS" -ne 0 ]; then
  echo "probe failed: expected exit 0 from --json for the shadowing case, got $STATUS" >&2
  cat "$WORK/two.json.stderr" >&2
  exit 1
fi

"$NODE_BIN" -e '
const fs = require("fs");
const [file, winner, loser] = process.argv.slice(1);
const data = JSON.parse(fs.readFileSync(file, "utf8"));
function fail(message) {
  console.error(`probe failed: ${message}`);
  process.exit(1);
}
const current = data.contexts.find((entry) => entry.context === "current");
if (!current) fail("no current context");
if (current.path !== winner) {
  fail(`current winner is ${JSON.stringify(current.path)}, expected ${winner}`);
}
if (current.copies.length !== 2) {
  fail(`expected 2 copies in the current context, got ${JSON.stringify(current.copies)}`);
}
if (current.copies[0].path !== winner || current.copies[0].winner !== true || current.copies[0].shadowed !== false) {
  fail(`first copy is not the winner: ${JSON.stringify(current.copies[0])}`);
}
if (current.copies[1].path !== loser || current.copies[1].winner !== false || current.copies[1].shadowed !== true) {
  fail(`second copy is not marked shadowed: ${JSON.stringify(current.copies[1])}`);
}
if (JSON.stringify(current.shadowedPaths) !== JSON.stringify([loser])) {
  fail(`current shadowedPaths is ${JSON.stringify(current.shadowedPaths)}`);
}
if (data.copies.length !== 2) {
  fail(`expected 2 unique top-level copies, got ${JSON.stringify(data.copies)}`);
}
if (JSON.stringify(data.shadowedPaths) !== JSON.stringify([loser])) {
  fail(`top-level shadowedPaths is ${JSON.stringify(data.shadowedPaths)}`);
}
if (data.shadowed.length !== 1 || data.shadowed[0].path !== loser) {
  fail(`top-level shadowed is ${JSON.stringify(data.shadowed)}`);
}
const shadowing = data.shadowing.find((entry) => entry.context === "current");
if (!shadowing) fail("no current shadowing entry");
if (shadowing.winner !== winner) {
  fail(`shadowing winner is ${JSON.stringify(shadowing.winner)}, expected ${winner}`);
}
if (JSON.stringify(shadowing.shadowed) !== JSON.stringify([loser])) {
  fail(`shadowing shadowed is ${JSON.stringify(shadowing.shadowed)}`);
}
console.log(JSON.stringify({
  context: current.context,
  winner: current.path,
  copies: current.copies.map((copy) => ({ path: copy.path, winner: copy.winner, shadowed: copy.shadowed })),
  shadowedPaths: data.shadowedPaths,
  shadowing
}, null, 2));
' "$WORK/two.json" "$WINNER" "$LOSER"

assert_no_path_fix "$WORK/two.json" "$FIRST_BIN" "$SECOND_BIN"

echo "===== case 2: one copy, directory repeated on PATH ====="
echo "\$ PATH=\"$ONE_COPY_REPEATED\" \\"
echo "    CLI_PATH_DOCTOR_LOGIN_PATH=\"\$PATH\" \\"
echo "    CLI_PATH_DOCTOR_NON_LOGIN_PATH=\"\$PATH\" \\"
echo "    CLI_PATH_DOCTOR_DAEMON_PATH=\"\$PATH\" \\"
echo "    $NODE_BIN bin/cli-path-doctor.mjs $COMMAND"

run_doctor "$ONE_COPY_REPEATED" "" "$WORK/one.stdout" "$WORK/one.stderr"
if [ "$STATUS" -ne 0 ]; then
  echo "probe failed: expected exit 0 for the single-copy case, got $STATUS" >&2
  cat "$WORK/one.stderr" >&2
  exit 1
fi

if grep -F "wins; shadows" "$WORK/one.stdout" >/dev/null 2>&1; then
  echo "probe failed: a repeated directory was reported as a shadowing pair" >&2
  cat "$WORK/one.stdout" >&2
  exit 1
fi
if grep -F "shadowed copies:" "$WORK/one.stderr" >/dev/null 2>&1; then
  echo "probe failed: a repeated directory produced shadowed-copy noise" >&2
  cat "$WORK/one.stderr" >&2
  exit 1
fi

echo "--- stdout ---"
cat "$WORK/one.stdout"
echo "--- stderr (guidance) ---"
cat "$WORK/one.stderr"
echo "--- exit code: $STATUS ---"
echo

run_doctor "$ONE_COPY_REPEATED" "--json" "$WORK/one.json" "$WORK/one.json.stderr"
if [ "$STATUS" -ne 0 ]; then
  echo "probe failed: expected exit 0 from --json for the single-copy case, got $STATUS" >&2
  cat "$WORK/one.json.stderr" >&2
  exit 1
fi

"$NODE_BIN" -e '
const fs = require("fs");
const [file, winner] = process.argv.slice(1);
const data = JSON.parse(fs.readFileSync(file, "utf8"));
function fail(message) {
  console.error(`probe failed: ${message}`);
  process.exit(1);
}
const current = data.contexts.find((entry) => entry.context === "current");
if (!current) fail("no current context");
if (current.path !== winner) {
  fail(`current winner is ${JSON.stringify(current.path)}, expected ${winner}`);
}
if (current.copies.length !== 1) {
  fail(`a repeated PATH directory created a fake second copy: ${JSON.stringify(current.copies)}`);
}
if (current.copies[0].winner !== true || current.copies[0].shadowed !== false) {
  fail(`the only copy is not the winner: ${JSON.stringify(current.copies[0])}`);
}
if (current.shadowedPaths.length !== 0) {
  fail(`current shadowedPaths is ${JSON.stringify(current.shadowedPaths)}`);
}
if (data.copies.length !== 1) {
  fail(`expected 1 top-level copy, got ${JSON.stringify(data.copies)}`);
}
if (data.shadowed.length !== 0 || data.shadowedPaths.length !== 0 || data.shadowing.length !== 0) {
  fail(`expected empty shadowing evidence: ${JSON.stringify({
    shadowed: data.shadowed,
    shadowedPaths: data.shadowedPaths,
    shadowing: data.shadowing
  })}`);
}
console.log(JSON.stringify({
  context: current.context,
  winner: current.path,
  copies: current.copies.map((copy) => ({ path: copy.path, winner: copy.winner, shadowed: copy.shadowed })),
  shadowedPaths: data.shadowedPaths,
  shadowed: data.shadowed,
  shadowing: data.shadowing
}, null, 2));
' "$WORK/one.json" "$WINNER"

echo "OK: two copies named a winner and a shadowed copy without PATH noise; one repeated copy stayed quiet"
