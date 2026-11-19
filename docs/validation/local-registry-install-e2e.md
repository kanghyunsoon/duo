# Throwaway local npm registry for CLI install E2E (#37, S15P31A106-288)

This report documents the design, verification, and Windows 11 benchmark measurements for installing the packed `@duo-director/cli` artifact through a zero-dependency throwaway local HTTP npm registry (`tests/distribution/local-registry.ts`), as proposed in Issue #37 (T83 Option 3).

## Background and problem statement

`tests/distribution/dist.e2e.test.ts` and `scripts/release/conformance.mjs` verify the packed CLI tarball (`.dist/duo-director-cli-<version>.tgz`, 7,468 files and 67 bundled runtime packages) across two `npm install` surfaces:

1. Global install (`npm install -g --prefix <dir>`) in `tests/distribution/dist.e2e.test.ts` `beforeAll` and `scripts/release/conformance.mjs`.
2. Project-local install (`npm install -D <tarballPath>`) to verify `npx --no-install duoctl`.

Issue #37 noted that `npm install <local-tarball.tgz>` has hit 180s timeouts on Windows runners and proposed **Option 3**: serving the already-built `.tgz` from a throwaway `127.0.0.1` HTTP registry (`startLocalNpmRegistry`) and installing `@duo-director/cli@<version> --registry=http://127.0.0.1:<port>`. PR #206 switched the `beforeAll` global install (`npm install -g`) in `tests/distribution/dist.e2e.test.ts` to `startLocalNpmRegistry({ tarballPath: pack.tarball })`, and this follow-up (#222) switches the project-local `npx` install (`npm install -D`) to `startLocalNpmRegistry` as well. The direct `.tgz` global install is still checked on every CI run by `scripts/release/conformance.mjs` (`npm install -g --prefix <prefix> <pack.tarball>`); the direct `.tgz` project-local install now runs only in the opt-in `O3` benchmark (`DUO_BENCH_LOCAL_REGISTRY=1` in `tests/workspace/local-registry.test.ts`).

## Architecture of `startLocalNpmRegistry` (`tests/distribution/local-registry.ts`)

`startLocalNpmRegistry({ tarballPath })` uses only Node.js built-in modules (`node:http`, `node:worker_threads`, `node:crypto`, `node:fs`, `node:zlib`):

1. **Tarball inspection without external tar libraries (`readPackageJsonFromTarball`)**:
   - Reads the `.tgz` once to compute `dist.shasum` (hex SHA-1) and `dist.integrity` (`sha512-<base64>` SRI).
   - Decompresses the gzip stream via `zlib.gunzipSync` and scans POSIX ustar / PAX / GNU `LongLink` 512-byte headers until `package/package.json` is extracted, preserving `name`, `version`, `bin`, `dependencies`, `bundleDependencies`, and `bundledDependencies`.
2. **Independent `node:worker_threads` HTTP loop**:
   - The existing distribution test helper `npm(args, cwd, env)` in `tests/distribution/support.ts` uses `child_process.spawnSync`, which blocks the main thread's event loop until `npm` exits.
   - Running `http.createServer` inside a `Worker` gives the local registry its own event loop so synchronous `npm(...)` calls on the main thread are served immediately without deadlocking, and `stream.pipeline(fs.createReadStream(tarballPath), res, ...)` ensures aborted connections never leak open file descriptors on Windows.
   - Each HTTP request is posted over a `MessageChannel` and drained synchronously on the main thread via `receiveMessageOnPort` whenever `registry.requests` is read.
3. **Scoped package routing and H-65 isolation**:
   - Normalizes URL-encoded scoped package paths via `decodeURIComponent(pathname)`, matching `/@duo-director%2fcli` (what `npm` sends on the wire), `/@duo-director%2Fcli`, `/%40duo-director%2fcli`, and `/@duo-director/cli`.
   - Serves the tarball byte stream at `/@duo-director/cli/-/cli-<version>.tgz`.
   - Returns HTTP `404` (`{"error":"Not found","path":"<decodedPath>"}`) for any other package route. If a future packaging change accidentally omits a runtime dependency from `bundledDependencies`, `npm install --registry=<local-url>` fails immediately with `404` instead of silently fetching from `registry.npmjs.org`.

## Benchmark on the real `.dist` artifact (Windows 11, Node 24)

Measured via `DUO_BENCH_LOCAL_REGISTRY=1 pnpm exec vitest run tests/workspace/local-registry.test.ts` against `.dist/duo-director-cli-0.4.0-rc.1.tgz`:

- **Artifact**: `duo-director-cli-0.4.0-rc.1.tgz`
- **Packed size**: `24,517,680` bytes (23.38 MiB)
- **Unpacked size**: `114,714,814` bytes (109.40 MiB) across `7,468` files and `67` bundled packages
- **Installed tree hash (`compareInstalledTree`)**: `fd01e8228a333479a7a76848fc5c98da649e8ef4daa167d594f89c8997a5bfdb` (identical across all 6 install runs)

### Idle workstation baseline vs. under-load run

| Scenario | Local tarball (`npm install <tgz>`, idle / under load) | Throwaway local registry (`--registry=http://127.0.0.1:<port>`, idle / under load) | Speedup (idle / under load) | Time saved (idle / under load) |
|---|---:|---:|---:|---:|
| Global install (`npm install -g`, cold `--cache`) | 31,824 ms / 103,735 ms | 9,363 ms / 40,898 ms | **3.40x / 2.54x** | −22.5 s / −62.8 s |
| Project-local install (`npm install -D`, cold `--cache`) | 27,785 ms / 126,935 ms | 9,406 ms / 29,964 ms | **2.95x / 4.24x** | −18.4 s / −97.0 s |
| Project-local install (`npm install -D`, warm `--cache` shared with global install) | 27,340 ms / 124,871 ms (`FileFetcher` bypasses `_cacache`) | 9,407 ms / 29,237 ms (`_cacache` hit, no `.tgz` HTTP stream) | **2.91x / 4.27x** | −17.9 s / −95.6 s |
| **Combined 2 installs (global cold + project-local warm)** | **59,164 ms / 228,606 ms** | **18,770 ms / 70,135 ms** | **3.15x / 3.26x** | **−40.4 s / −158.5 s** |

### HTTP requests recorded by `startLocalNpmRegistry`

| Install run | HTTP requests received by local registry | External network calls |
|---|---|---:|
| Global install (cold `--cache`) | `GET /@duo-director%2fcli` (`200`), `GET /@duo-director/cli/-/cli-0.4.0-rc.1.tgz` (`200`) | 0 |
| Project-local install (cold `--cache`) | `GET /@duo-director%2fcli` (`200`), `GET /@duo-director/cli/-/cli-0.4.0-rc.1.tgz` (`200`) | 0 |
| Project-local install (warm `--cache` shared with global install) | `GET /@duo-director%2fcli` (`200`) only — `.tgz` stream skipped via `_cacache` SHA-512 `dist.integrity` hit | 0 |

## Why registry install is ~3x faster than local file tarball install

When `npm install <local-tarball.tgz>` is given a local file specifier (`type: "file"` in `npm-package-arg`), `pacote`'s `FileFetcher` has no precomputed packument:

1. During `Arborist.buildIdealTree()`, `pacote.manifest(tarballPath)` must open, gunzip, and scan the entire 24.5 MiB tarball (7,468 entries) to read `package/package.json` and compute a SHA-512 integrity digest over the archive.
2. During `Arborist.reify()`, `pacote.extract(tarballPath)` reads, gunzips, and extracts the 24.5 MiB tarball a second time into `node_modules/@duo-director/cli`.

When `npm install @duo-director/cli@0.4.0-rc.1 --registry=http://127.0.0.1:<port>` is given a registry version specifier:

1. `Arborist.buildIdealTree()` fetches only the ~2 KiB packument JSON (`GET /@duo-director%2fcli`), which already supplies `version`, `dependencies`, `bundleDependencies`, and `dist.integrity` (`sha512-...`).
2. `Arborist.reify()` streams and extracts the `.tgz` only once (or, when `--cache` is shared across installs, reads directly from `_cacache` by `dist.integrity` without streaming the `.tgz` over HTTP a second time). By contrast, `pacote`'s `FileFetcher` bypasses `_cacache` for local `.tgz` paths, so passing a warm `--cache` to `npm install -D <pack.tarball>` still re-reads the 24.5 MiB tarball from disk twice (`124,871 ms` warm vs `126,935 ms` cold under load). On `127.0.0.1` loopback, streaming 23.38 MiB over HTTP takes only a few milliseconds, so the duration of both cold-cache and warm-cache registry installs reflects the baseline NTFS extraction cost of unpacking 7,468 files into `node_modules`.

## Trade-offs and recommendations

| Dimension | Direct tarball (`npm install <tgz>`) | Local registry (`startLocalNpmRegistry`) |
|---|---|---|
| Windows install duration (single install) | ~28–32 s idle (~104–127 s under I/O load) | ~9.4 s idle (~29–41 s under I/O load; ~2.5–4.3x faster) |
| Exercises real npm registry resolution (`@duo-director/cli@<version>`) | No (`file:` specifier) | Yes (scoped packument + SRI integrity check) |
| Enforces H-65 offline bundled dependency completeness | Only if `--offline` is also passed or network is absent | Yes — any unbundled dependency request hits local registry and fails immediately with `404` |
| Tests offline `.tgz` file specifier path | Yes | No |

### Applied in `tests/distribution/dist.e2e.test.ts` and `next` Windows CI observations

1. **Post-#206 `next` Windows CI comparison (`verify (windows-latest, node 24)`)**:
   - After PR #206 switched the `beforeAll` global install to `startLocalNpmRegistry` while leaving the project-local install on `npm install -D <pack.tarball>`, the 5 consecutive `next` runs showed a consistent **2.76–3.04x** speedup on the global registry install relative to the project-local `.tgz` install on the same runner:

| Phase | Run ID | `next` commit | Global install (`beforeAll`) | Project-local `npmInstall` (`npm install -D`) | Same-runner ratio |
|---|---|---|---:|---:|---:|
| Pre-#206 | `43338982005` | `943d46d` | `325.6 s` (`.tgz`) | `306.7 s` (`.tgz`) | 0.94x |
| Pre-#206 | `43347214193` | `f0c1342` | `141.8 s` (`.tgz`) | `134.8 s` (`.tgz`) | 0.95x |
| Pre-#206 | `43351153997` | `6841fcb` | `221.9 s` (`.tgz`) | `212.7 s` (`.tgz`) | 0.96x |
| Post-#206 (1) | `43385762539` | `3847ce2` (#206) | **`42.2 s`** (`42,190 ms`, registry) | `116.5 s` (`116,473 ms`, `.tgz`) | **2.76x faster** |
| Post-#206 (2) | `43388949691` | `183edd8` | **`46.6 s`** (`46,627 ms`, registry) | `138.9 s` (`138,896 ms`, `.tgz`) | **2.98x faster** |
| Post-#206 (3) | `43779204360` | `280aae2` | **`30.2 s`** (`30,203 ms`, registry) | `84.9 s` (`84,909 ms`, `.tgz`) | **2.81x faster** |
| Post-#206 (4) | `43785190133` | `efded41` | **`32.6 s`** (`32,628 ms`, registry) | `99.1 s` (`99,057 ms`, `.tgz`) | **3.04x faster** |
| Post-#206 (5) | `43802458731` | `a84329f` | **`60.3 s`** (`60,332 ms`, registry) | `171.4 s` (`171,397 ms`, `.tgz`) | **2.84x faster** |
| PR #222 (both registry) | `43994776826` | `c5cb5dd` (#222) | **`58.0 s`** (`57,970 ms`, registry) | **`54.8 s`** (`54,812 ms`, registry) | **0.95x (parity)** |

2. **Both `dist.e2e.test.ts` installs now use `startLocalNpmRegistry`**:
   - Both `beforeAll` (`npm install -g --prefix <prefix>`) and `project-local install` (`npm install -D`) in `tests/distribution/dist.e2e.test.ts` now install `@duo-director/cli@<version>` from `startLocalNpmRegistry({ tarballPath: pack.tarball })`, assert `formatNpmFailure` on error, and verify that every package request to the local registry returned HTTP `200` (enforcing the H-65 `404` guard on both install surfaces).
   - The direct `.tgz` global install is still checked on every CI run by `scripts/release/conformance.mjs` (`npm install -g --prefix <prefix> <pack.tarball>`); the direct `.tgz` project-local install now runs only in the opt-in `O3` benchmark (`DUO_BENCH_LOCAL_REGISTRY=1` in `tests/workspace/local-registry.test.ts`).
3. **Fast regression suite in `tests/workspace/local-registry.test.ts`**:
   - The default suite (`O1` + `O2`) runs in under 2 seconds using a synthetic scoped tarball and continuously verifies `readPackageJsonFromTarball`, `startLocalNpmRegistry`, and `npm install --registry=<local-url>` + `npx --no-install duoctl`.
   - The 6-install `.dist` benchmark (`O3`) remains opt-in via `DUO_BENCH_LOCAL_REGISTRY=1` so `pnpm test` stays fast.
