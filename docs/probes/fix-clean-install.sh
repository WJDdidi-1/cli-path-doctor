#!/bin/sh
# Verify `--fix` from a clean, packed install, not from the checkout.
#
# The probe:
#   1. packs the repository and installs the tarball into an isolated prefix,
#   2. creates a real global bin link whose directory is not on any checked PATH,
#   3. runs the installed doctor with `--fix` against a temporary HOME,
#   4. checks the marked block in that HOME's startup file,
#   5. runs `--fix` a second time and checks the file is byte-for-byte unchanged,
#   6. starts a fresh login shell that resolves the command through the block,
#   7. removes the block the way the README documents and checks that the fresh
#      login shell no longer resolves the command.
#
# Run from anywhere:
#   sh docs/probes/fix-clean-install.sh
#
# Exits 0 only when every check above passes.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
cd "$ROOT"

NODE_BIN=${NODE_BIN:-$(command -v node || true)}
NPM_BIN=${NPM_BIN:-$(command -v npm || true)}
if [ -z "$NODE_BIN" ] || [ -z "$NPM_BIN" ]; then
  echo "probe failed: node and npm are required" >&2
  exit 1
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/cli-path-doctor-fix-clean.XXXXXX")
WORK=$(CDPATH= cd -- "$WORK" && pwd -P)
cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT HUP INT TERM

HOME_DIR="$WORK/home"
PREFIX="$WORK/prefix"
PREFIX_BIN="$PREFIX/bin"
PACKAGE_DIR="$WORK/package"
NPM_CACHE="$WORK/npm-cache"
COMMAND="fixprobe-$$"
BASE_PATH="$(dirname "$NODE_BIN"):$(dirname "$NPM_BIN"):/usr/bin:/bin"

mkdir -p "$HOME_DIR" "$PREFIX" "$PACKAGE_DIR"
printf '# user profile\n# keep me\nexport EDITOR=vi\n' > "$HOME_DIR/.profile"
cp "$HOME_DIR/.profile" "$WORK/profile.before"

export HOME="$HOME_DIR"
export NPM_CONFIG_PREFIX="$PREFIX"
export npm_config_prefix="$PREFIX"
export NPM_CONFIG_CACHE="$NPM_CACHE"
export npm_config_cache="$NPM_CACHE"
export npm_config_offline=true
export npm_config_audit=false
export npm_config_fund=false
export npm_config_update_notifier=false
export NO_UPDATE_NOTIFIER=1

echo "===== pack and install ====="
echo "\$ npm pack --pack-destination $PACKAGE_DIR"
"$NPM_BIN" pack --pack-destination "$PACKAGE_DIR" > /dev/null
TARBALL=$(find "$PACKAGE_DIR" -maxdepth 1 -name '*.tgz' -print | head -n 1)
if [ -z "$TARBALL" ]; then
  echo "probe failed: npm pack produced no tarball" >&2
  exit 1
fi

echo "\$ npm install -g $TARBALL --ignore-scripts"
"$NPM_BIN" install -g "$TARBALL" --ignore-scripts > /dev/null
DOCTOR="$PREFIX_BIN/cli-path-doctor"
if [ ! -x "$DOCTOR" ]; then
  echo "probe failed: no installed doctor at $DOCTOR" >&2
  exit 1
fi
echo "installed: $("$NODE_BIN" "$DOCTOR" --version)"

# A real global bin entry whose directory none of the checked PATHs contain.
printf '#!/bin/sh\nexit 0\n' > "$PREFIX_BIN/$COMMAND"
chmod 0755 "$PREFIX_BIN/$COMMAND"

echo
echo "===== first --fix ====="
echo "\$ HOME=$HOME_DIR PATH=$BASE_PATH NPM_CONFIG_PREFIX=$PREFIX CLI_PATH_DOCTOR_SHELL=/bin/sh $NODE_BIN $DOCTOR $COMMAND --fix --json"
set +e
env HOME="$HOME_DIR" PATH="$BASE_PATH" \
  NPM_CONFIG_PREFIX="$PREFIX" npm_config_prefix="$PREFIX" \
  CLI_PATH_DOCTOR_SHELL=/bin/sh \
  CLI_PATH_DOCTOR_LOGIN_PATH="$BASE_PATH" \
  CLI_PATH_DOCTOR_NON_LOGIN_PATH="$BASE_PATH" \
  CLI_PATH_DOCTOR_DAEMON_PATH="$BASE_PATH" \
  "$NODE_BIN" "$DOCTOR" "$COMMAND" --fix --json > "$WORK/first.json" 2> "$WORK/first.err"
FIRST_STATUS=$?
set -e
if [ "$FIRST_STATUS" -ne 1 ]; then
  echo "probe failed: expected exit 1 from the first --fix, got $FIRST_STATUS" >&2
  cat "$WORK/first.err" >&2
  exit 1
fi

"$NODE_BIN" -e '
const fs = require("fs");
const [file, expectedFile, prefixBin, command] = process.argv.slice(1);
const data = JSON.parse(fs.readFileSync(file, "utf8"));
function fail(message) {
  console.error(`probe failed: ${message}`);
  process.exit(1);
}
if (!data.fix) fail("--fix --json did not report a fix object");
if (data.fix.applied !== true) fail(`expected fix.applied true, got ${JSON.stringify(data.fix)}`);
if (data.fix.alreadyPresent !== false) fail(`expected fix.alreadyPresent false, got ${JSON.stringify(data.fix)}`);
if (data.fix.file !== expectedFile) fail(`fix.file is ${JSON.stringify(data.fix.file)}, expected ${JSON.stringify(expectedFile)}`);
if (!String(data.fix.line).includes(prefixBin)) fail(`fix.line does not name ${prefixBin}: ${data.fix.line}`);
console.log(JSON.stringify({
  applied: data.fix.applied,
  alreadyPresent: data.fix.alreadyPresent,
  file: data.fix.file,
  line: data.fix.line,
  reason: data.fix.reason,
}, null, 2));
console.log("checked: fix.applied=true, fix.alreadyPresent=false, file and PATH line are correct");
' "$WORK/first.json" "$HOME_DIR/.profile" "$PREFIX_BIN" "$COMMAND"

echo
echo "--- $HOME_DIR/.profile after the first --fix ---"
cat "$HOME_DIR/.profile"

cp "$HOME_DIR/.profile" "$WORK/profile.after-first"

echo
echo "===== second --fix (idempotence) ====="
set +e
env HOME="$HOME_DIR" PATH="$BASE_PATH" \
  NPM_CONFIG_PREFIX="$PREFIX" npm_config_prefix="$PREFIX" \
  CLI_PATH_DOCTOR_SHELL=/bin/sh \
  CLI_PATH_DOCTOR_LOGIN_PATH="$BASE_PATH" \
  CLI_PATH_DOCTOR_NON_LOGIN_PATH="$BASE_PATH" \
  CLI_PATH_DOCTOR_DAEMON_PATH="$BASE_PATH" \
  "$NODE_BIN" "$DOCTOR" "$COMMAND" --fix --json > "$WORK/second.json" 2> "$WORK/second.err"
SECOND_STATUS=$?
set -e
if [ "$SECOND_STATUS" -ne 1 ]; then
  echo "probe failed: expected exit 1 from the second --fix, got $SECOND_STATUS" >&2
  cat "$WORK/second.err" >&2
  exit 1
fi

"$NODE_BIN" -e '
const fs = require("fs");
const [file] = process.argv.slice(1);
const data = JSON.parse(fs.readFileSync(file, "utf8"));
function fail(message) {
  console.error(`probe failed: ${message}`);
  process.exit(1);
}
if (data.fix.applied !== false) fail(`second --fix must not apply, got ${JSON.stringify(data.fix)}`);
if (data.fix.alreadyPresent !== true) fail(`second --fix must report alreadyPresent, got ${JSON.stringify(data.fix)}`);
if (!/already present/.test(String(data.fix.reason))) fail(`unexpected reason: ${JSON.stringify(data.fix.reason)}`);
console.log(JSON.stringify({
  applied: data.fix.applied,
  alreadyPresent: data.fix.alreadyPresent,
  file: data.fix.file,
  line: data.fix.line,
  reason: data.fix.reason,
}, null, 2));
console.log("checked: second --fix applied=false, alreadyPresent=true");
' "$WORK/second.json"

if ! cmp -s "$WORK/profile.after-first" "$HOME_DIR/.profile"; then
  echo "probe failed: the second --fix changed the startup file" >&2
  diff -u "$WORK/profile.after-first" "$HOME_DIR/.profile" >&2 || true
  exit 1
fi
echo "checked: the startup file is byte-for-byte unchanged"

echo
echo "===== fresh login shell ====="
echo "\$ HOME=$HOME_DIR PATH=$BASE_PATH /bin/sh -l -c 'command -v $COMMAND'"
set +e
RESOLVED=$(HOME="$HOME_DIR" PATH="$BASE_PATH" /bin/sh -l -c 'command -v "$1"' sh "$COMMAND" 2> "$WORK/login.err")
LOGIN_STATUS=$?
set -e
if [ "$LOGIN_STATUS" -ne 0 ] || [ "$RESOLVED" != "$PREFIX_BIN/$COMMAND" ]; then
  echo "probe failed: fresh login shell did not resolve $COMMAND" >&2
  echo "status=$LOGIN_STATUS stdout=$RESOLVED" >&2
  cat "$WORK/login.err" >&2
  exit 1
fi
echo "resolved: $RESOLVED"

echo
echo "===== documented undo: remove the marked block ====="
sed '/^# >>> cli-path-doctor: .* >>>$/,/^# <<< cli-path-doctor: .* <<<$/d' \
  "$HOME_DIR/.profile" > "$WORK/profile.undone"
cp "$WORK/profile.undone" "$HOME_DIR/.profile"

if grep -q 'cli-path-doctor' "$HOME_DIR/.profile"; then
  echo "probe failed: the managed block is still present after undo" >&2
  cat "$HOME_DIR/.profile" >&2
  exit 1
fi
if ! grep -q 'export EDITOR=vi' "$HOME_DIR/.profile"; then
  echo "probe failed: undo removed unrelated profile content" >&2
  cat "$HOME_DIR/.profile" >&2
  exit 1
fi

set +e
UNDONE=$(HOME="$HOME_DIR" PATH="$BASE_PATH" /bin/sh -l -c 'command -v "$1"' sh "$COMMAND" 2> "$WORK/login-undone.err")
UNDONE_STATUS=$?
set -e
if [ "$UNDONE_STATUS" -eq 0 ] || [ -n "$UNDONE" ]; then
  echo "probe failed: the fresh login shell still resolves $COMMAND after undo" >&2
  echo "status=$UNDONE_STATUS stdout=$UNDONE" >&2
  exit 1
fi
echo "checked: fresh login shell no longer resolves $COMMAND"

echo
echo "OK: packed --fix wrote the block, second --fix was a no-op, a fresh login shell resolved $COMMAND, and undo removed the block"
