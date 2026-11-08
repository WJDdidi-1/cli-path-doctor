# Measured: a broken global install

This page records a measurement of `cli-path-doctor` against a real broken
global install, not a fixture the tool builds in memory. It exists because the
epic below was opened on the claim that the published package had never been
shown to explain this failure.

> cli-path-doctor 0.1.0 was validated on fixtures it builds itself. A user hits
> it when a globally installed CLI is missing: the bin target does not exist, or
> the prefix's bin directory is not on PATH. Nothing has proven the published
> package explains that case.

## What was measured

- **Date:** 2026-11-09 (UTC+08:00)
- **Machine:** macOS 27.2 (Darwin 27.2.0), arm64
- **Node.js:** v24.15.0
- **npm:** 11.12.1
- **Published package:** `cli-path-doctor@0.1.0` (published 2026-11-06T17:02:52Z)
- **Source under test:** commit `c9c9fbd19c5c4df6442407d4210bd5ee02e0a579`
  (`Validate cli-path-doctor against a real broken global install: Fix what the
  measurement exposes`)

The two binaries are kept separate on purpose: the published 0.1.0 tarball and
the checkout at `c9c9fbd`, both run against the same on-disk install.

## Case A: the declared `bin` target does not exist

This is the failure where `npm install -g` exits `0`, the package is present,
and the command does not exist because the package points its `bin` at a file
that was never shipped.

### Setup

```sh
demo=/tmp/path-doctor-global-demo
rm -rf "$demo"
mkdir -p "$demo/fixture-package/bin" "$demo/prefix"

cat > "$demo/fixture-package/package.json" <<'JSON'
{
  "name": "broken-global-cli-fixture",
  "version": "0.0.1",
  "bin": { "demo-cli": "bin/missing.js" }
}
JSON
echo fixture > "$demo/fixture-package/bin/keep.txt"

export NPM_CONFIG_PREFIX="$demo/prefix"
export NPM_CONFIG_CACHE="$demo/.npm-cache"
(cd "$demo/fixture-package" && npm pack --pack-destination "$demo" >/dev/null)
npm install -g "$demo/broken-global-cli-fixture-0.0.1.tgz" --ignore-scripts
```

`npm install -g` exits `0` and adds the package. `bin/missing.js` is not in the
tarball, so npm creates no `demo-cli` link at all and does not even create
`<prefix>/bin`:

```
$ ls /tmp/path-doctor-global-demo/prefix
lib
$ ls /tmp/path-doctor-global-demo/prefix/lib/node_modules/broken-global-cli-fixture
bin
package.json
```

Pin the shell contexts so PATH is not a second variable:

```sh
export CLI_PATH_DOCTOR_LOGIN_PATH=/usr/bin:/bin
export CLI_PATH_DOCTOR_NON_LOGIN_PATH=/usr/bin:/bin
export CLI_PATH_DOCTOR_DAEMON_PATH=/usr/bin:/bin
```

### Before: published 0.1.0 does not explain it

0.1.0 was installed outside the fixture prefix:

```sh
NPM_CONFIG_PREFIX=/tmp/path-doctor-published npm install -g cli-path-doctor@0.1.0
```

Command and output, verbatim:

```console
$ /tmp/path-doctor-published/bin/cli-path-doctor demo-cli
current      MISS (not found on PATH)
login        MISS (not found on PATH)
non-login    MISS (not found on PATH)
daemon-like  MISS (not found on PATH)
fixes:
  npm install -g 'demo-cli'
$ echo $?
1
```

This is a negative result: 0.1.0 reports only `not found on PATH`, and its fix
passes the command name (`demo-cli`) where npm expects a package name. It never
reads the globally installed package or its `bin` declaration, so it cannot
name `broken-global-cli-fixture` or `bin/missing.js`.

### After: this checkout at `c9c9fbd` explains it

Same fixture, same environment, run from the checkout:

```console
$ node ./bin/cli-path-doctor.mjs demo-cli
current      MISS (not found on PATH; globally installed package broken-global-cli-fixture declares bin demo-cli -> /tmp/path-doctor-global-demo/prefix/lib/node_modules/broken-global-cli-fixture/bin/missing.js but the target file is missing; npm bin link /tmp/path-doctor-global-demo/prefix/bin/demo-cli is missing)
login        MISS (not found on PATH; globally installed package broken-global-cli-fixture declares bin demo-cli -> /tmp/path-doctor-global-demo/prefix/lib/node_modules/broken-global-cli-fixture/bin/missing.js but the target file is missing; npm bin link /tmp/path-doctor-global-demo/prefix/bin/demo-cli is missing)
non-login    MISS (not found on PATH; globally installed package broken-global-cli-fixture declares bin demo-cli -> /tmp/path-doctor-global-demo/prefix/lib/node_modules/broken-global-cli-fixture/bin/missing.js but the target file is missing; npm bin link /tmp/path-doctor-global-demo/prefix/bin/demo-cli is missing)
daemon-like  MISS (not found on PATH; globally installed package broken-global-cli-fixture declares bin demo-cli -> /tmp/path-doctor-global-demo/prefix/lib/node_modules/broken-global-cli-fixture/bin/missing.js but the target file is missing; npm bin link /tmp/path-doctor-global-demo/prefix/bin/demo-cli is missing)
fixes:
  npm install -g 'broken-global-cli-fixture'
$ echo $?
1
```

The machine-readable form carries the same finding. Relevant excerpt from
`node ./bin/cli-path-doctor.mjs demo-cli --json`:

```json
{
  "npm": {
    "prefix": {
      "path": "/tmp/path-doctor-global-demo/prefix",
      "source": "NPM_CONFIG_PREFIX"
    },
    "packages": [
      {
        "package": "broken-global-cli-fixture",
        "source": "global package",
        "command": "demo-cli",
        "target": "/tmp/path-doctor-global-demo/prefix/lib/node_modules/broken-global-cli-fixture/bin/missing.js",
        "link": "/tmp/path-doctor-global-demo/prefix/bin/demo-cli",
        "linkExists": false,
        "exists": false
      }
    ],
    "hint": "globally installed package broken-global-cli-fixture declares bin demo-cli -> /tmp/path-doctor-global-demo/prefix/lib/node_modules/broken-global-cli-fixture/bin/missing.js but the target file is missing; npm bin link /tmp/path-doctor-global-demo/prefix/bin/demo-cli is missing",
    "fixes": [
      "npm install -g 'broken-global-cli-fixture'"
    ]
  },
  "fixes": [
    "npm install -g 'broken-global-cli-fixture'"
  ]
}
```

The full JSON also has the four `contexts` entries; the excerpt keeps only the
fields that answer the question "which layer broke". The exit code stays `1`
because no context can resolve `demo-cli`; naming the layer does not pretend the
command works.

## Case B: the prefix's `bin` directory is not on PATH

The second shape from the epic: the package installs correctly and npm creates
the link, but the directory holding it is not inherited by the shell or daemon.

### Setup

```sh
demo=/tmp/path-doctor-global-demo-ok
rm -rf "$demo"
mkdir -p "$demo/fixture-package/bin" "$demo/prefix"

cat > "$demo/fixture-package/package.json" <<'JSON'
{
  "name": "unlisted-global-cli-fixture",
  "version": "0.0.1",
  "bin": { "demo-ok": "bin/demo-ok.js" }
}
JSON
cat > "$demo/fixture-package/bin/demo-ok.js" <<'JS'
#!/usr/bin/env node
console.log('demo-ok');
JS
chmod +x "$demo/fixture-package/bin/demo-ok.js"

export NPM_CONFIG_PREFIX="$demo/prefix"
export NPM_CONFIG_CACHE="$demo/.npm-cache"
(cd "$demo/fixture-package" && npm pack --pack-destination "$demo" >/dev/null)
npm install -g "$demo/unlisted-global-cli-fixture-0.0.1.tgz" --ignore-scripts
```

`<prefix>/bin/demo-ok` now exists and points at the real target:

```
demo-ok -> ../lib/node_modules/unlisted-global-cli-fixture/bin/demo-ok.js
```

### Published 0.1.0 already explains this one

```console
$ NPM_CONFIG_PREFIX=/tmp/path-doctor-global-demo-ok/prefix \
    /tmp/path-doctor-published/bin/cli-path-doctor demo-ok
current      MISS (not found on PATH; npm bin exists at /tmp/path-doctor-global-demo-ok/prefix/bin/demo-ok but is not on this PATH)
login        MISS (not found on PATH; npm bin exists at /tmp/path-doctor-global-demo-ok/prefix/bin/demo-ok but is not on this PATH)
non-login    MISS (not found on PATH; npm bin exists at /tmp/path-doctor-global-demo-ok/prefix/bin/demo-ok but is not on this PATH)
daemon-like  MISS (not found on PATH; npm bin exists at /tmp/path-doctor-global-demo-ok/prefix/bin/demo-ok but is not on this PATH)
fixes:
  export PATH='/tmp/path-doctor-global-demo-ok/prefix/bin':"$PATH"
$ echo $?
1
```

The fix is the right one: add the discovered npm bin directory to PATH. The
checkout at `c9c9fbd` prints the same rows for this case.

## Conclusion

| Case | Published 0.1.0 | Checkout at `c9c9fbd` |
| --- | --- | --- |
| Global package's `bin` target missing | Generic `MISS`; suggests `npm install -g 'demo-cli'` | Names the package, the `bin` entry, the missing target, and the absent link; suggests reinstalling the package |
| Global install correct, prefix `bin` not on PATH | Explains the PATH layer and prints `export PATH=...` | Same |

The published 0.1.0 explains the PATH shape but **not** the missing-`bin`-target
shape. The fix is in the repository at `c9c9fbd` and is covered by
`test/global-install.test.mjs`; it is not in the published 0.1.0 tarball. Until a
release containing that commit is published, the global-package diagnosis is
only available from a checkout or from GitHub
(`npm install -g github:WJDdidi-1/cli-path-doctor`).

## Reproducing

The commands above are the complete reproduction; each run takes under a second
after `npm` is warm. To rerun the automated version of Case A:

```sh
npm test
```

`test/global-install.test.mjs` packs a fixture with a missing `bin` target,
runs `npm install -g` into an isolated `NPM_CONFIG_PREFIX`, and asserts the
package name, target, missing link, hint, and global reinstall fix.
