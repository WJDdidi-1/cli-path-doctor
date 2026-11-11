#!/bin/sh
# Verify the repair for a broken shebang from a clean, packed install.
#
# The probe:
#   1. packs the repository and installs the tarball into an isolated prefix,
#   2. creates a 0755 script whose shebang names a missing interpreter,
#   3. runs the installed doctor with --fix and checks the text repair,
#   4. runs --fix --json and checks fixes[], fix.reason, and fix.manual,
#   5. checks that --fix did not write a startup file, because there is no PATH
#      directory to add.
#
# Run from anywhere:
#   sh docs/probes/broken-repair-clean-install.sh
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

WORK=$(mktemp -d "${TMPDIR:-/tmp}/cli-path-doctor-broken-repair-clean.XXXXXX")
WORK=$(CDPATH= cd -- "$WORK" && pwd -P)
cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT HUP INT TERM

HOME_DIR="$WORK/home"
PREFIX="$WORK/prefix"
PREFIX_BIN="$PREFIX/bin"
PACKAGE_DIR="$WORK/package"
FIXTURE_DIR="$WORK/bin"
NPM_CACHE="$WORK/npm-cache"
COMMAND="brokenprobe-$$"
FIXTURE="$FIXTURE_DIR/$COMMAND"
MISSING_INTERPRETER=/nonexistent/interp
SEARCH_PATH="$FIXTURE_DIR:$(dirname "$NODE_BIN"):/usr/bin:/bin"
SHELL_PATH="$FIXTURE_DIR:/usr/bin:/bin"

mkdir -p "$HOME_DIR" "$PREFIX" "$PACKAGE_DIR" "$FIXTURE_DIR"

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

echo
echo "===== fixture ====="
printf '#!/nonexistent/interp\necho broken should not run\n' > "$FIXTURE"
chmod 0755 "$FIXTURE"
echo "\$ printf '#!/nonexistent/interp\\necho broken should not run\\n' > $FIXTURE"
echo "\$ chmod 0755 $FIXTURE"
echo "fixture: $FIXTURE (mode 0755, interpreter $MISSING_INTERPRETER absent)"

run_doctor() {
  env HOME="$HOME_DIR" PATH="$SEARCH_PATH" \
    NPM_CONFIG_PREFIX="$PREFIX" npm_config_prefix="$PREFIX" \
    CLI_PATH_DOCTOR_LOGIN_PATH="$SHELL_PATH" \
    CLI_PATH_DOCTOR_NON_LOGIN_PATH="$SHELL_PATH" \
    CLI_PATH_DOCTOR_DAEMON_PATH="$SHELL_PATH" \
    CARGO_HOME='' BUN_INSTALL='' VOLTA_HOME='' GOBIN='' GOPATH='' \
    DENO_INSTALL='' PNPM_HOME='' ASDF_DATA_DIR='' MISE_DATA_DIR='' \
    PYENV_ROOT='' RBENV_ROOT='' \
    "$NODE_BIN" "$DOCTOR" "$@"
}

echo
echo "===== --fix (text) ====="
set +e
run_doctor "$COMMAND" --fix > "$WORK/text.out" 2> "$WORK/text.err"
TEXT_STATUS=$?
set -e
echo "exit: $TEXT_STATUS"
cat "$WORK/text.out"
cat "$WORK/text.err"
if [ "$TEXT_STATUS" -ne 1 ]; then
  echo "probe failed: expected exit 1 from --fix, got $TEXT_STATUS" >&2
  exit 1
fi

"$NODE_BIN" -e '
const fs = require("fs");
const [stdoutFile, stderrFile, interpreter, fixture, command] = process.argv.slice(1);
const stdout = fs.readFileSync(stdoutFile, "utf8");
const stderr = fs.readFileSync(stderrFile, "utf8");
function fail(message) {
  console.error(`probe failed: ${message}`);
  process.exit(1);
}
const rows = (stdout.match(/BROKEN/g) || []).length;
if (rows !== 4) fail(`expected four BROKEN rows, got ${rows}:\n${stdout}`);
if (!stdout.includes(`shebang interpreter ${interpreter} does not exist`)) fail("the text verdict does not name the missing interpreter");
if (!stderr.includes(interpreter)) fail(`stderr does not name ${interpreter}:\n${stderr}`);
if (!/repair needed:/.test(stderr)) fail(`stderr has no repair line:\n${stderr}`);
if (!/fixes:/.test(stderr)) fail(`stderr does not list the repair:\n${stderr}`);
if (/nothing to fix/.test(stderr)) fail(`stderr still says there is nothing to fix:\n${stderr}`);
if (/cannot apply PATH fix/.test(stderr)) fail(`stderr still refuses the PATH fix:\n${stderr}`);
if (/npm install -g/.test(stderr)) fail(`a present but broken file must not get an install line:\n${stderr}`);
if (!stderr.includes(`install the missing shebang interpreter ${interpreter}`)) fail("stderr does not give the interpreter repair");
if (!stderr.includes(fixture)) fail(`the repair does not name the file ${fixture}`);
if (!stderr.includes(command)) fail(`the repair does not name the command ${command}`);
console.log("checked: four BROKEN rows, the missing interpreter is named, and the fix gives a real repair");
' "$WORK/text.out" "$WORK/text.err" "$MISSING_INTERPRETER" "$FIXTURE" "$COMMAND"

echo
echo "===== --fix --json ====="
set +e
run_doctor "$COMMAND" --fix --json > "$WORK/json.out" 2> "$WORK/json.err"
JSON_STATUS=$?
set -e
echo "exit: $JSON_STATUS"
if [ "$JSON_STATUS" -ne 1 ]; then
  echo "probe failed: expected exit 1 from --fix --json, got $JSON_STATUS" >&2
  cat "$WORK/json.err" >&2
  exit 1
fi

"$NODE_BIN" -e '
const fs = require("fs");
const [file, interpreter, fixture, home, command] = process.argv.slice(1);
const data = JSON.parse(fs.readFileSync(file, "utf8"));
function fail(message) {
  console.error(`probe failed: ${message}`);
  process.exit(1);
}
const current = (data.contexts || []).find((entry) => entry.context === "current");
if (!current) fail("no current context");
if (data.command !== command) fail(`command is ${JSON.stringify(data.command)}, expected ${JSON.stringify(command)}`);
if (data.status !== "broken") fail(`status is ${JSON.stringify(data.status)}, expected broken`);
if (data.resolved !== true) fail(`resolved is ${JSON.stringify(data.resolved)}, expected true`);
if (data.runnable !== false) fail(`runnable is ${JSON.stringify(data.runnable)}, expected false`);
if (data.exitCode !== 1) fail(`exitCode is ${JSON.stringify(data.exitCode)}, expected 1`);
if (data.path !== fixture) fail(`path is ${JSON.stringify(data.path)}, expected ${JSON.stringify(fixture)}`);
if (current.status !== "broken") fail(`current.status is ${JSON.stringify(current.status)}`);
if (current.interpreter !== interpreter) fail(`current.interpreter is ${JSON.stringify(current.interpreter)}`);
if (!Array.isArray(data.fixes) || data.fixes.length === 0) fail("fixes is empty");
const expected = `install the missing shebang interpreter ${interpreter}, or change the shebang in \x27${fixture}\x27`;
if (!data.fixes.includes(expected)) fail(`fixes does not contain the interpreter repair: ${JSON.stringify(data.fixes)}`);
if (data.fixes.some((fix) => /npm install -g/.test(fix))) fail(`a present but broken file got an install fix: ${JSON.stringify(data.fixes)}`);
if (data.fix.applied !== false) fail(`fix.applied is ${JSON.stringify(data.fix.applied)}`);
if (data.fix.manual !== true) fail(`fix.manual is ${JSON.stringify(data.fix.manual)}`);
if (data.fix.file !== null) fail(`fix.file is ${JSON.stringify(data.fix.file)}, expected null`);
if (!String(data.fix.reason).includes(interpreter)) fail(`fix.reason does not name ${interpreter}: ${JSON.stringify(data.fix.reason)}`);
if (!/cannot start/.test(String(data.fix.reason))) fail(`fix.reason does not say the command cannot start: ${JSON.stringify(data.fix.reason)}`);
if (/nothing to fix/.test(JSON.stringify(data.fix))) fail(`fix.reason still says there is nothing to fix: ${JSON.stringify(data.fix)}`);

const homeEntries = fs.readdirSync(home);
if (homeEntries.length !== 0) fail(`--fix wrote into HOME although there is no PATH directory to add: ${JSON.stringify(homeEntries)}`);

console.log(JSON.stringify({
  command: data.command,
  status: data.status,
  resolved: data.resolved,
  runnable: data.runnable,
  exitCode: data.exitCode,
  path: data.path,
  contexts: [{
    name: current.name,
    status: current.status,
    resolved: current.resolved,
    runnable: current.runnable,
    interpreter: current.interpreter,
    unrunnableReason: current.unrunnableReason,
    path: current.path,
  }],
  fixes: data.fixes,
  fix: data.fix,
}, null, 2));
console.log("checked: fixes[] names the interpreter, fix.manual=true, fix.reason explains the cause, and HOME was not written");
' "$WORK/json.out" "$MISSING_INTERPRETER" "$FIXTURE" "$HOME_DIR" "$COMMAND"

echo
echo "OK: the packed install repairs a broken shebang in text and JSON without writing a startup file"
