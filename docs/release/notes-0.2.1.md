# DUO 0.2.1 release notes

Packaging patch on top of 0.2.0. DUO itself is unchanged: only the way the package carries its runtime dependencies changed (C242, H-65).

## Problem

0.2.0 pinned its transitive runtime dependency tree with an `npm-shrinkwrap.json` file inside the package. npm 12 no longer reads that file in an installed package, and npm 10 and 11 do not use it when the package is installed from a local tarball. After `mdast-util-to-markdown` 2.2.0 was published on 2026-10-03, those installs resolved 2.2.0 instead of the locked 2.1.3.

## Impact

Observed on Windows with Node.js 24.18.0 and npm 10.9.9, 11.21.0 and 12.2.0: every install of 0.2.0 succeeded, `duoctl` ran, `init` and `status` worked, and no install script ran. Installing `@duo-director/cli@0.2.0` from the registry with npm 10 or 11 kept the locked tree. With npm 12, and with a local tarball on any of the three, 1 of 67 packages differed from the lock. No DUO function was observed to fail, but the guarantee that you get the dependency tree the release was tested with did not hold.

## Fix

0.2.1 carries the locked tree inside the package.

- At release time the lock is installed into an isolated directory from registry.npmjs.org (each tarball checked against the lock's integrity, no install scripts) and those packages are bundled in the package's `node_modules/` (`bundleDependencies`). npm installs them from the package and does not resolve versions again.
- `dist/runtime-tree.json` records each bundled package: path, version, lock integrity, license and a content hash. The release checks compare installations with it.
- The bundled versions are the 0.2.0 lock: 67 packages, `mdast-util-to-markdown` stays 2.1.3.
- Checked with npm 10, 11 and 12, for global and project-local installs and `npx --no-install duoctl`: the installed tree equals `dist/runtime-tree.json` (paths, versions, file contents), nothing is installed next to the package, and no install script runs.
- `dist/THIRD_PARTY_NOTICES.md` lists every bundled package with its license text.
- `npm-shrinkwrap.json` is no longer in the package. It stays in the repository as the input the release build installs.

npm packs a bundled package with the files that package declares. A file that a dependency published outside its own `files` list is not carried; `dist/runtime-tree.json` lists it (in 0.2.1 only `CHANGELOG.md` of `which` 2.0.2).

## Package size

The download is larger because the dependencies now come inside the package: 24,333,166 bytes instead of 1,379,978 (unpacked 114,025,940 bytes instead of 14,151,823; 7,468 files instead of 25). What ends up on disk is about the same as with 0.2.0, because npm already installed the same 67 packages next to DUO (Windows, npm 11: 113.9 MB for both).

## Compatibility

- Node.js `>=24.15.0`, unchanged.
- Commands, options, exit codes, public formats (CLI JSON, MCP, UI API, Review Record, Adoption Baseline), Project Truth and `project.yaml` are unchanged, and so is runtime behavior.
- No re-initialization, re-adoption or migration. An index built by 0.2.0 stays current; `duoctl index` after the upgrade has nothing to redo.
- Fixes in bundled dependencies reach users with a new DUO release, as before.

Known limitations are those of [0.2.0](notes-0.2.0.md#known-limitations).

