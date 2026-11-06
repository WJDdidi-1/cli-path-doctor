#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version;

const USAGE = `cli-path-doctor: a small developer tool

Usage:
  cli-path-doctor --help
  cli-path-doctor --version

MVP features:
  - Run \`cli-path-doctor <command>\` to print one row per context (current, login, non-login, daemon-like) with the resolved path or a miss.
  - Inspect local npm metadata: global prefix, \`node_modules/.bin\`, package \`bin\` entries, symlink targets, and executable bits.
  - Name the first PATH directory present in a login shell but absent from the daemon/CI environment, when one exists.
  - Print copy-paste fixes and exit 0 if any checked context resolves the command, otherwise exit 1.
  - Support \`--json\` for CI and run fully offline with no account or network call.
`;

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log(VERSION);
} else {
  console.log(USAGE);
}
