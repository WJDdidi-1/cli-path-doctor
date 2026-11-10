#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { buildContexts, firstLoginOnlyDirectory, resolveShell } from '../lib/contexts.mjs';
import { describeMiss, findCommandCopies, lookupCommand } from '../lib/path-resolver.mjs';
import { inspectNpmBins, npmHint } from '../lib/npm-metadata.mjs';
import { inspectToolchainBins, toolchainHint } from '../lib/toolchain-metadata.mjs';
import { buildFixes } from '../lib/fixes.mjs';
import { rcFileForShell, shellName } from '../lib/shell-rc.mjs';

const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const USAGE = `cli-path-doctor: diagnose why a CLI command is missing across shells, npm installs, toolchains, and daemons.

Usage:
  cli-path-doctor <command>
  cli-path-doctor <command> --json
  cli-path-doctor --help
  cli-path-doctor --version

Contexts (one row each):
  current      the PATH of this process
  login        PATH reported by a login shell (for example: $SHELL -l -c)
  non-login    PATH reported by a non-login shell (for example: $SHELL -c)
  daemon-like  a minimal system PATH, similar to launchd, systemd, or CI

The default output is one line per context: the command's resolved path, or
MISS with the reason. A file that is present and executable but cannot start
(for example its shebang interpreter is missing) is BROKEN with the reason. If a
context has more than one runnable copy, the row names the winning path and
every path it shadows. Copy-paste fixes and other human guidance go to stderr so
stdout stays one row per context. Exit 0 if at least one context finds a command
that can start, otherwise exit 1.

Options:
  --json       machine-readable output
  --verbose    add shell/PATH diagnostics to text output
  -h, --help   show this help
  -v, --version

MVP features:
  - Print one row per context (current, login, non-login, daemon-like) with
    the resolved path or a miss.
  - Inspect local npm metadata: global prefix, node_modules/.bin, package bin
    entries, symlink targets, and executable bits.
  - Search user-level toolchain bin directories (cargo/rustup, bun, volta, go,
    deno, pnpm, yarn, asdf, mise, pyenv, rbenv, and ~/.local/bin) so a command
    installed there is named and fixed by adding that directory to PATH.
  - Name the first PATH directory present in a login shell but absent from the
    daemon-like environment, when one exists.
  - Print copy-paste fixes and exit 0 if any checked context resolves the
    command, otherwise exit 1.
  - Name the startup file to edit (for example ~/.zshrc or ~/.bashrc) and do
    not suggest a PATH directory that cannot contain the command.
  - List every copy of the command that a context's PATH can reach, say which
    copy wins, and report the directories it shadows; --json exposes the same
    copies. A fix never exports a directory that is already on the current PATH.
  - Read a script's shebang and report a file that is present but cannot start
    (missing or non-executable interpreter) as BROKEN, with runnable and
    unrunnableReason in --json. A plain non-executable file keeps its MISS
    reason and gets a chmod +x repair.
  - Support --json and run fully offline with no account or network call.
`;

function parseArguments(argv) {
  const parsed = {
    command: null,
    json: false,
    verbose: false,
    help: false,
    version: false,
    error: null,
  };

  let index = 0;
  for (; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--') {
      const rest = argv.slice(index + 1);
      if (rest.length > 0) {
        if (parsed.command === null) parsed.command = rest[0];
        if (rest.length > 1) parsed.error = 'expected exactly one command';
      }
      break;
    }

    if (argument === '--json') {
      parsed.json = true;
    } else if (argument === '--verbose') {
      parsed.verbose = true;
    } else if (argument === '--help' || argument === '-h') {
      parsed.help = true;
    } else if (argument === '--version' || argument === '-v') {
      parsed.version = true;
    } else if (argument.startsWith('-') && argument !== '-') {
      parsed.error = `unknown option: ${argument}`;
    } else if (parsed.command === null) {
      parsed.command = argument;
    } else {
      parsed.error = 'expected exactly one command';
    }
  }

  return parsed;
}

function printUsage(stream) {
  stream.write(USAGE);
}

function indentFix(fix, indent) {
  return String(fix).split('\n').join(`\n${indent}`);
}

function shadowSuffix(row) {
  const shadowed = Array.isArray(row.shadowed) ? row.shadowed : [];
  if (row.status !== 'ok' || shadowed.length === 0) return '';
  return ` (wins; shadows ${shadowed.map((copy) => copy.path).join(', ')})`;
}

function shadowLines(rows) {
  return rows
    .filter((row) => row.status === 'ok' && Array.isArray(row.shadowed) && row.shadowed.length > 0)
    .map((row) => `  ${row.name}: ${row.path} wins; shadowed: ${row.shadowed
      .map((copy) => copy.path)
      .join(', ')}`);
}

function runCommand(command, options) {
  const shell = process.platform === 'win32' ? null : resolveShell(process.env, process.platform);
  const rcFile = rcFileForShell(shell, process.platform);
  const contexts = buildContexts();
  const pathValues = contexts.map((environment) => environment.pathValue);
  const currentContext = contexts.find((environment) => environment.name === 'current');
  const currentPathValues = currentContext ? [currentContext.pathValue] : [];
  const npmInspection = inspectNpmBins(command, {
    shell,
    rcFile,
    pathValues: currentPathValues,
  });
  const toolchainInspection = inspectToolchainBins(command, { shell, rcFile });
  const npmHintValue = npmHint(npmInspection, { pathValues });
  const toolchainHintValue = toolchainHint(toolchainInspection, { pathValues });
  const preferredToolchain = toolchainInspection.preferred;
  const usableToolchain = Boolean(preferredToolchain
    && preferredToolchain.exists
    && preferredToolchain.isFile
    && preferredToolchain.executable
    && !preferredToolchain.broken);
  // A usable toolchain binary is the installation the user is asking about, so
  // its explanation wins over incidental npm metadata with the same name.
  const hint = (usableToolchain ? toolchainHintValue : null) || npmHintValue || toolchainHintValue;

  const loginContext = contexts.find((environment) => environment.name === 'login');
  const daemonContext = contexts.find((environment) => environment.name === 'daemon-like');
  const loginOnlyDirectory = loginContext && daemonContext && loginContext.reliable && daemonContext.reliable
    ? firstLoginOnlyDirectory(loginContext.pathValue, daemonContext.pathValue, process.platform)
    : null;

  const rows = contexts.map((environment) => {
    const lookupOptions = {
      platform: process.platform,
      env: process.env,
      cwd: process.cwd(),
    };
    const result = lookupCommand(command, environment.pathValue, lookupOptions);
    const copies = findCommandCopies(command, environment.pathValue, lookupOptions).copies;

    const status = result.resolved
      ? (result.runnable === false ? 'broken' : 'ok')
      : 'miss';
    const nonExecutable = Boolean(result.nonExecutable);
    const foundPath = result.resolved ? result.path : (result.foundPath || null);

    let reason = null;
    let unrunnableReason = null;
    if (status === 'broken') {
      unrunnableReason = result.unrunnableReason || 'the file cannot start';
      reason = `found at ${result.path} but ${unrunnableReason}`;
    } else if (status === 'miss') {
      reason = describeMiss(result, hint);
      if (nonExecutable) unrunnableReason = reason;
    }

    return {
      name: environment.name,
      pathValue: environment.pathValue,
      source: environment.source,
      note: environment.note,
      reliable: environment.reliable,
      status,
      resolved: Boolean(result.resolved),
      runnable: status === 'ok',
      unrunnableReason,
      path: result.resolved ? result.path : null,
      foundPath,
      nonExecutable,
      realPath: result.realPath || null,
      symlink: Boolean(result.symlink),
      linkTarget: result.linkTarget || null,
      copies,
      shadowed: copies.filter((copy) => copy.shadowed),
      reason,
    };
  });

  if (loginOnlyDirectory) {
    const daemonRow = rows.find((row) => row.name === 'daemon-like' && !row.resolved);
    if (daemonRow) {
      daemonRow.reason = `${daemonRow.reason}; login shell adds ${loginOnlyDirectory}, which this PATH lacks`;
    }
  }

  const anyResolved = rows.some((row) => row.resolved);
  const anyRunnable = rows.some((row) => row.runnable);
  const firstRunnable = rows.find((row) => row.runnable) || null;
  const firstResolved = rows.find((row) => row.resolved) || null;
  const fixes = buildFixes({
    command,
    rows,
    loginOnlyDirectory,
    npmInspection,
    toolchainInspection,
    platform: process.platform,
    shell,
    rcFile,
  });

  if (options.json) {
    const jsonRows = rows.map((row) => ({
      name: row.name,
      context: row.name,
      status: row.status,
      resolved: row.resolved,
      runnable: row.runnable,
      unrunnableReason: row.unrunnableReason,
      path: row.path,
      foundPath: row.foundPath,
      realPath: row.realPath,
      symlink: row.symlink,
      linkTarget: row.linkTarget,
      copies: row.copies,
      shadowed: row.shadowed,
      shadowedPaths: row.shadowed.map((copy) => copy.path),
      reason: row.reason,
      searchPath: row.pathValue,
      pathValue: row.pathValue,
      source: row.source,
      note: row.note,
      reliable: row.reliable,
    }));

    // The same executable is often visible in several contexts. The flat
    // top-level list is unique by path, while each context row below keeps its
    // own resolution order.
    const uniqueCopies = new Map();
    for (const row of rows) {
      for (const copy of row.copies) {
        const key = process.platform === 'win32' ? copy.path.toLowerCase() : copy.path;
        const existing = uniqueCopies.get(key);
        if (existing) {
          existing.contexts.push(row.name);
          if (copy.winner) existing.winnerIn.push(row.name);
          if (copy.shadowed) existing.shadowedIn.push(row.name);
          existing.winner = existing.winner || Boolean(copy.winner);
          existing.shadowed = existing.shadowed || Boolean(copy.shadowed);
          continue;
        }

        uniqueCopies.set(key, {
          ...copy,
          command,
          context: row.name,
          contexts: [row.name],
          winnerIn: copy.winner ? [row.name] : [],
          shadowedIn: copy.shadowed ? [row.name] : [],
        });
      }
    }

    const flatCopies = [...uniqueCopies.values()];
    const shadowedCopies = flatCopies.filter((copy) => copy.shadowed);
    const shadowedPaths = shadowedCopies.map((copy) => copy.path);
    const copiesByContext = Object.fromEntries(
      rows.map((row) => [row.name, row.copies]),
    );
    const shadowing = rows
      .filter((row) => row.status === 'ok' && row.shadowed.length > 0)
      .map((row) => ({
        context: row.name,
        winner: row.path,
        winnerPath: row.path,
        copies: row.copies.map((copy) => copy.path),
        shadowed: row.shadowed.map((copy) => copy.path),
      }));

    const toolchainPayload = {
      command: toolchainInspection.command,
      home: toolchainInspection.home,
      directories: toolchainInspection.directories,
      candidates: toolchainInspection.candidates,
      preferred: toolchainInspection.preferred,
      hint: toolchainHintValue,
    };

    const payload = {
      command,
      status: anyRunnable ? 'ok' : anyResolved ? 'broken' : 'miss',
      resolved: anyResolved,
      runnable: anyRunnable,
      anyResolved,
      anyRunnable,
      exitCode: anyRunnable ? 0 : 1,
      path: firstRunnable ? firstRunnable.path : firstResolved ? firstResolved.path : null,
      contexts: jsonRows,
      rows: jsonRows,
      copies: flatCopies,
      copiesByContext,
      shadowed: shadowedCopies,
      shadowedPaths,
      shadowing,
      shell,
      shellName: shellName(shell),
      rcFile,
      loginOnlyDirectory,
      fixes,
      npm: {
        command: npmInspection.command,
        prefix: npmInspection.prefix,
        globalPrefix: npmInspection.globalPrefix,
        preferred: npmInspection.preferred,
        candidates: npmInspection.candidates,
        local: npmInspection.local,
        global: npmInspection.global,
        packages: npmInspection.packages,
        hint: npmHintValue,
        fixes: npmInspection.fixes,
      },
      toolchains: toolchainPayload,
      toolchain: toolchainPayload,
    };

    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    const width = rows.reduce((largest, row) => Math.max(largest, row.name.length), 0);
    for (const row of rows) {
      let rendered;
      if (row.status === 'ok') {
        rendered = `${row.path}${shadowSuffix(row)}`;
      } else if (row.status === 'broken') {
        rendered = `BROKEN (${row.reason})`;
      } else {
        rendered = `MISS (${row.reason})`;
      }
      process.stdout.write(`${row.name.padEnd(width)}  ${rendered}\n`);
    }

    const copies = shadowLines(rows);
    if (options.verbose) {
      process.stdout.write('\nDetails:\n');
      for (const row of rows) {
        const note = row.note ? `; ${row.note}` : '';
        process.stdout.write(`  ${row.name}: ${row.source}${note}\n`);
      }
      if (npmHintValue) process.stdout.write(`  npm: ${npmHintValue}\n`);
      if (toolchainHintValue) process.stdout.write(`  toolchains: ${toolchainHintValue}\n`);
      if (loginOnlyDirectory) {
        process.stdout.write(`  first login-only PATH directory: ${loginOnlyDirectory}\n`);
      }
      if (copies.length > 0) {
        process.stdout.write('  shadowed copies:\n');
        for (const line of copies) process.stdout.write(`${line}\n`);
      }
      if (fixes.length > 0) {
        process.stdout.write('  fixes:\n');
        for (const fix of fixes) process.stdout.write(`    ${indentFix(fix, '    ')}\n`);
      }
    } else {
      const guidance = [];
      if (loginOnlyDirectory) {
        guidance.push(`first login-only PATH directory: ${loginOnlyDirectory}`);
      }
      if (copies.length > 0) {
        guidance.push('shadowed copies:');
        for (const line of copies) guidance.push(line);
      }
      if (fixes.length > 0) {
        guidance.push('fixes:');
        for (const fix of fixes) guidance.push(`  ${indentFix(fix, '  ')}`);
      }
      if (guidance.length > 0) process.stderr.write(`${guidance.join('\n')}\n`);
    }
  }

  process.exitCode = anyRunnable ? 0 : 1;
}

function main(argv) {
  const parsed = parseArguments(argv);

  if (parsed.help || argv.length === 0) {
    printUsage(process.stdout);
    process.exitCode = 0;
    return;
  }

  if (parsed.version) {
    process.stdout.write(`${VERSION}\n`);
    process.exitCode = 0;
    return;
  }

  if (parsed.error) {
    process.stderr.write(`cli-path-doctor: ${parsed.error}\n\n`);
    printUsage(process.stderr);
    process.exitCode = 2;
    return;
  }

  if (!parsed.command) {
    process.stderr.write('cli-path-doctor: a command is required\n\n');
    printUsage(process.stderr);
    process.exitCode = 2;
    return;
  }

  runCommand(parsed.command, parsed);
}

main(process.argv.slice(2));
