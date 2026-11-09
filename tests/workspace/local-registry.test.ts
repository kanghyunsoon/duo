/**
 * Regression and contract tests for the throwaway in-process local npm registry
 * (`tests/distribution/local-registry.ts`, Issue #37 Option 3 / Jira S15P31A106-288).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readPackageJsonFromTarball,
  startLocalNpmRegistry,
  type LocalRegistryManifest,
} from "../distribution/local-registry.js";
import { compareInstalledTree, isolatedEnv, npm, runOnPath, type RuntimeTree } from "../distribution/support.js";

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // ignore transient Windows cleanup lock on temp directory
    }
  }
});

function mkTemp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

const sha256Text = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("throwaway local npm registry for CLI install E2E (#37, S15P31A106-288)", () => {
  let tarballPath = "";
  let manifest: LocalRegistryManifest;
  let expectedTarballBytes: Buffer;

  beforeAll(() => {
    const stage = mkTemp("duo-local-reg-stage-");
    const pkgDir = path.join(stage, "pkg");
    const bundledDepDir = path.join(pkgDir, "node_modules", "bundled-helper");
    fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
    fs.mkdirSync(bundledDepDir, { recursive: true });

    const helperPkgJson = `${JSON.stringify({ name: "bundled-helper", version: "1.0.0", type: "module", main: "index.js" }, null, 2)}\n`;
    const helperIndexJs = 'export const helperVersion = "1.0.0";\n';
    fs.writeFileSync(path.join(bundledDepDir, "package.json"), helperPkgJson, "utf8");
    fs.writeFileSync(path.join(bundledDepDir, "index.js"), helperIndexJs, "utf8");

    const helperContentHash = createHash("sha256")
      .update(`index.js\0${sha256Text(helperIndexJs)}\npackage.json\0${sha256Text(helperPkgJson)}\n`)
      .digest("hex");

    const runtimeTree: RuntimeTree = {
      format: "duo.runtime-tree/1",
      package: "@duo-director/cli@0.0.0-local-registry-test",
      delivery: "bundleDependencies",
      lock: { file: "apps/cli/npm-shrinkwrap.json", sha256: "0".repeat(64), registry: "https://registry.npmjs.org/" },
      packages: [
        {
          path: "node_modules/bundled-helper",
          name: "bundled-helper",
          version: "1.0.0",
          integrity: "sha512-test",
          license: "MIT",
          files: 2,
          contentHash: helperContentHash,
        },
      ],
      treeHash: sha256Text(helperContentHash),
    };

    fs.writeFileSync(
      path.join(pkgDir, "dist", "duoctl.js"),
      '#!/usr/bin/env node\nimport { helperVersion } from "bundled-helper";\nconsole.log(`duoctl 0.0.0-local-registry-test (${helperVersion})`);\n',
      "utf8",
    );
    fs.writeFileSync(path.join(pkgDir, "dist", "runtime-tree.json"), `${JSON.stringify(runtimeTree, null, 2)}\n`, "utf8");

    manifest = {
      name: "@duo-director/cli",
      version: "0.0.0-local-registry-test",
      type: "module",
      bin: { duoctl: "dist/duoctl.js" },
      files: ["dist"],
      dependencies: { "bundled-helper": "1.0.0" },
      bundleDependencies: ["bundled-helper"],
    };
    fs.writeFileSync(path.join(pkgDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const packed = npm(["pack", "--pack-destination", stage, "--loglevel=error"], pkgDir, isolatedEnv([]));
    expect(packed.status, packed.stderr).toBe(0);
    const tgzName = fs.readdirSync(stage).find((f) => f.endsWith(".tgz"));
    expect(tgzName).toBeDefined();
    tarballPath = path.join(stage, tgzName!);
    expectedTarballBytes = fs.readFileSync(tarballPath);
  }, 60_000);

  it("O1: serves scoped packument JSON (with SRI integrity, shasum, and bundledDependencies), streams the exact tarball, and returns 404 for unknown packages", async () => {
    const parsedFromTar = readPackageJsonFromTarball(expectedTarballBytes);
    expect(parsedFromTar.name).toBe(manifest.name);
    expect(parsedFromTar.version).toBe(manifest.version);

    // Passing only { tarballPath } extracts package/package.json directly from the .tgz
    const registry = await startLocalNpmRegistry({ tarballPath });
    try {
      const routes = ["/@duo-director%2fcli", "/@duo-director%2Fcli", "/%40duo-director%2fcli", "/@duo-director/cli"];
      for (const route of routes) {
        const res = await fetch(`${registry.url}${route}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          name: string;
          "dist-tags": { latest: string };
          versions: Record<
            string,
            {
              dist: { integrity: string; shasum: string; tarball: string };
              bundleDependencies: string[];
              bundledDependencies: string[];
            }
          >;
        };
        expect(body.name).toBe("@duo-director/cli");
        expect(body["dist-tags"].latest).toBe("0.0.0-local-registry-test");
        const ver = body.versions["0.0.0-local-registry-test"];
        expect(ver?.dist.integrity).toBe(registry.integrity);
        expect(ver?.dist.shasum).toBe(registry.shasum);
        expect(ver?.dist.tarball).toBe(registry.tarballUrl);
        expect(ver?.bundleDependencies).toEqual(["bundled-helper"]);
        expect(ver?.bundledDependencies).toEqual(["bundled-helper"]);
      }

      const headMeta = await fetch(`${registry.url}/@duo-director%2fcli`, { method: "HEAD" });
      expect(headMeta.status).toBe(200);
      expect(Number(headMeta.headers.get("content-length"))).toBeGreaterThan(0);

      const headTgz = await fetch(registry.tarballUrl, { method: "HEAD" });
      expect(headTgz.status).toBe(200);
      expect(Number(headTgz.headers.get("content-length"))).toBe(expectedTarballBytes.byteLength);

      const tgzRes = await fetch(registry.tarballUrl);
      expect(tgzRes.status).toBe(200);
      const tgzBytes = Buffer.from(await tgzRes.arrayBuffer());
      expect(tgzBytes.equals(expectedTarballBytes)).toBe(true);

      const unknownRes = await fetch(`${registry.url}/bundled-helper`);
      expect(unknownRes.status).toBe(404);
      const unknownBody = (await unknownRes.json()) as { error: string; path: string };
      expect(unknownBody).toEqual({ error: "Not found", path: "/bundled-helper" });

      const postRes = await fetch(`${registry.url}/@duo-director/cli`, { method: "POST" });
      expect(postRes.status).toBe(405);

      const snapshot = registry.requests;
      expect(snapshot.length).toBe(routes.length + 5);
    } finally {
      await registry.close();
      // Idempotent second close() call
      await registry.close();
    }
  });

  it("O2: installs @duo-director/cli@<version> from the local registry with zero third-party fetches, preserving the H-65 runtime tree and npx launcher", async () => {
    const registry = await startLocalNpmRegistry({ tarballPath });
    try {
      const proj = mkTemp("duo-local-reg-proj-");
      fs.writeFileSync(
        path.join(proj, "package.json"),
        `${JSON.stringify({ name: "consumer", version: "1.0.0", private: true }, null, 2)}\n`,
        "utf8",
      );
      const env = isolatedEnv([]);

      const cacheDir = path.join(proj, ".npm-cache");
      const inst = npm(
        [
          "install",
          "-D",
          registry.packageSpec,
          `--registry=${registry.url}`,
          `--cache=${cacheDir}`,
          "--no-update-notifier",
          "--no-audit",
          "--no-fund",
          "--loglevel=error",
        ],
        proj,
        env,
      );
      expect(inst.status, inst.stderr).toBe(0);

      // Every package request to the local registry succeeded (200) and exclusively touched @duo-director/cli metadata + tarball.
      const pkgRequests = registry.requests.filter((r) => r.url !== "/npm");
      const allowedUrls = new Set([
        "/@duo-director%2fcli",
        "/@duo-director%2Fcli",
        "/%40duo-director%2fcli",
        "/@duo-director/cli",
        `/@duo-director/cli/-/cli-${manifest.version}.tgz`,
      ]);
      expect(pkgRequests.length, JSON.stringify(registry.requests)).toBeGreaterThanOrEqual(2);
      expect(
        pkgRequests.every((r) => r.statusCode === 200 && allowedUrls.has(r.url)),
        JSON.stringify(registry.requests),
      ).toBe(true);
      expect(pkgRequests.some((r) => r.url.toLowerCase() === "/@duo-director%2fcli" || r.url === "/@duo-director/cli")).toBe(true);
      expect(pkgRequests.some((r) => r.url.endsWith(".tgz"))).toBe(true);
      expect(registry.requests.some((r) => r.url.includes("bundled-helper"))).toBe(false);

      // H-65 runtime tree check: bundled-helper stays inside @duo-director/cli/node_modules, nothing hoisted or extra.
      const installedCliDir = path.join(proj, "node_modules", "@duo-director", "cli");
      const tree = compareInstalledTree(installedCliDir, path.join(proj, "node_modules"));
      expect([...tree.mismatches, ...tree.extra, ...tree.outside]).toEqual([]);

      // npx --no-install duoctl runs the installed binary and resolves its bundled dependency.
      const versionRun = runOnPath("npx", ["--no-install", "duoctl", "--version"], proj, env);
      expect(versionRun.code, versionRun.stderr).toBe(0);
      expect(versionRun.stdout.trim()).toBe("duoctl 0.0.0-local-registry-test (1.0.0)");

      // Installing an unserved package against the isolated local registry fails with 404 (fail-closed).
      const missing = npm(
        [
          "install",
          "-D",
          "nonexistent-pkg@1.0.0",
          `--registry=${registry.url}`,
          `--cache=${cacheDir}`,
          "--no-update-notifier",
          "--fetch-retries=0",
          "--no-audit",
          "--no-fund",
          "--loglevel=error",
        ],
        proj,
        env,
      );
      expect(missing.status).not.toBe(0);
      expect(registry.requests.some((r) => r.statusCode === 404 && r.url.includes("nonexistent-pkg"))).toBe(true);
    } finally {
      await registry.close();
    }
  }, 60_000);

  it.runIf(process.env.DUO_BENCH_LOCAL_REGISTRY === "1")(
    "O3 (opt-in benchmark): compares real .dist local tarball install vs throwaway local registry install",
    async () => {
      const { IS_WIN, packReport } = await import("../distribution/support.js");
      const pack = packReport();
      const env = isolatedEnv([]);
      const registry = await startLocalNpmRegistry();
      try {
        // 1. Local tarball global install (cold cache)
        const prefixTarball = mkTemp("duo-bench-gtar-");
        const cacheGTar = mkTemp("duo-bench-cache-gtar-");
        const tGTar0 = performance.now();
        const rGTar = npm(
          [
            "install",
            "-g",
            "--prefix",
            prefixTarball,
            pack.tarball,
            `--cache=${cacheGTar}`,
            "--no-update-notifier",
            "--no-audit",
            "--no-fund",
            "--loglevel=error",
          ],
          prefixTarball,
          env,
        );
        const msGTar = Math.round(performance.now() - tGTar0);
        expect(rGTar.status, rGTar.stderr).toBe(0);
        const gTarPkgDir = path.join(prefixTarball, ...(IS_WIN ? [] : ["lib"]), "node_modules", "@duo-director", "cli");
        const gTarTree = compareInstalledTree(gTarPkgDir, path.join(prefixTarball, ...(IS_WIN ? [] : ["lib"]), "node_modules"));
        expect([...gTarTree.mismatches, ...gTarTree.extra, ...gTarTree.outside]).toEqual([]);

        // 2. Local registry global install (cold cache)
        const prefixReg = mkTemp("duo-bench-greg-");
        const cacheGReg = mkTemp("duo-bench-cache-greg-");
        const reqBeforeGReg = registry.requests.length;
        const tGReg0 = performance.now();
        const rGReg = npm(
          [
            "install",
            "-g",
            "--prefix",
            prefixReg,
            registry.packageSpec,
            `--registry=${registry.url}`,
            `--cache=${cacheGReg}`,
            "--no-update-notifier",
            "--no-audit",
            "--no-fund",
            "--loglevel=error",
          ],
          prefixReg,
          env,
        );
        const msGReg = Math.round(performance.now() - tGReg0);
        expect(rGReg.status, rGReg.stderr).toBe(0);
        const gRegRequests = registry.requests.slice(reqBeforeGReg);
        const gRegPkgDir = path.join(prefixReg, ...(IS_WIN ? [] : ["lib"]), "node_modules", "@duo-director", "cli");
        const gRegTree = compareInstalledTree(gRegPkgDir, path.join(prefixReg, ...(IS_WIN ? [] : ["lib"]), "node_modules"));
        expect([...gRegTree.mismatches, ...gRegTree.extra, ...gRegTree.outside]).toEqual([]);

        // 3. Local tarball project-local install -D (cold cache)
        const projTarball = mkTemp("duo-bench-ltar-");
        fs.writeFileSync(
          path.join(projTarball, "package.json"),
          `${JSON.stringify({ name: "proj-tar", version: "1.0.0", private: true }, null, 2)}\n`,
        );
        const cacheLTar = mkTemp("duo-bench-cache-ltar-");
        const tLTar0 = performance.now();
        const rLTar = npm(
          ["install", "-D", pack.tarball, `--cache=${cacheLTar}`, "--no-update-notifier", "--no-audit", "--no-fund", "--loglevel=error"],
          projTarball,
          env,
        );
        const msLTar = Math.round(performance.now() - tLTar0);
        expect(rLTar.status, rLTar.stderr).toBe(0);
        const lTarTree = compareInstalledTree(
          path.join(projTarball, "node_modules", "@duo-director", "cli"),
          path.join(projTarball, "node_modules"),
        );
        expect([...lTarTree.mismatches, ...lTarTree.extra, ...lTarTree.outside]).toEqual([]);
        const lTarVer = runOnPath("npx", ["--no-install", "duoctl", "--version"], projTarball, env);
        expect(lTarVer.stdout.trim()).toBe(`duoctl ${pack.version}`);

        // 4. Local registry project-local install -D (cold cache)
        const projReg = mkTemp("duo-bench-lreg-");
        fs.writeFileSync(
          path.join(projReg, "package.json"),
          `${JSON.stringify({ name: "proj-reg", version: "1.0.0", private: true }, null, 2)}\n`,
        );
        const cacheLReg = mkTemp("duo-bench-cache-lreg-");
        const reqBeforeLReg = registry.requests.length;
        const tLReg0 = performance.now();
        const rLReg = npm(
          [
            "install",
            "-D",
            registry.packageSpec,
            `--registry=${registry.url}`,
            `--cache=${cacheLReg}`,
            "--no-update-notifier",
            "--no-audit",
            "--no-fund",
            "--loglevel=error",
          ],
          projReg,
          env,
        );
        const msLReg = Math.round(performance.now() - tLReg0);
        expect(rLReg.status, rLReg.stderr).toBe(0);
        const lRegRequests = registry.requests.slice(reqBeforeLReg);
        const lRegTree = compareInstalledTree(
          path.join(projReg, "node_modules", "@duo-director", "cli"),
          path.join(projReg, "node_modules"),
        );
        expect([...lRegTree.mismatches, ...lRegTree.extra, ...lRegTree.outside]).toEqual([]);
        const lRegVer = runOnPath("npx", ["--no-install", "duoctl", "--version"], projReg, env);
        expect(lRegVer.stdout.trim()).toBe(`duoctl ${pack.version}`);

        // 5. Local registry project-local install -D (warm cache from global install)
        const projRegWarm = mkTemp("duo-bench-lreg-warm-");
        fs.writeFileSync(
          path.join(projRegWarm, "package.json"),
          `${JSON.stringify({ name: "proj-reg-warm", version: "1.0.0", private: true }, null, 2)}\n`,
        );
        const reqBeforeWarm = registry.requests.length;
        const tLRegWarm0 = performance.now();
        const rLRegWarm = npm(
          [
            "install",
            "-D",
            registry.packageSpec,
            `--registry=${registry.url}`,
            `--cache=${cacheGReg}`,
            "--no-update-notifier",
            "--no-audit",
            "--no-fund",
            "--loglevel=error",
          ],
          projRegWarm,
          env,
        );
        const msLRegWarm = Math.round(performance.now() - tLRegWarm0);
        expect(rLRegWarm.status, rLRegWarm.stderr).toBe(0);
        const warmRequests = registry.requests.slice(reqBeforeWarm);
        expect(warmRequests.some((r) => r.url.endsWith(".tgz"))).toBe(false);
        const lRegWarmTree = compareInstalledTree(
          path.join(projRegWarm, "node_modules", "@duo-director", "cli"),
          path.join(projRegWarm, "node_modules"),
        );
        expect([...lRegWarmTree.mismatches, ...lRegWarmTree.extra, ...lRegWarmTree.outside]).toEqual([]);
        const lRegWarmVer = runOnPath("npx", ["--no-install", "duoctl", "--version"], projRegWarm, env);
        expect(lRegWarmVer.stdout.trim()).toBe(`duoctl ${pack.version}`);

        console.log(
          "LOCAL_REGISTRY_BENCHMARK_JSON=" +
            JSON.stringify({
              pack: {
                version: pack.version,
                size: pack.size,
                unpackedSize: pack.unpackedSize,
                files: pack.files.length,
                bundledPackages: pack.runtimeTree?.packages ?? 0,
                treeHash: pack.runtimeTree?.treeHash,
              },
              globalInstallColdMs: {
                localTarball: msGTar,
                localRegistry: msGReg,
                speedupRatio: Number((msGTar / msGReg).toFixed(2)),
                savedMs: msGTar - msGReg,
              },
              projectLocalInstallMs: {
                localTarballCold: msLTar,
                localRegistryCold: msLReg,
                localRegistryWarm: msLRegWarm,
                speedupRatioCold: Number((msLTar / msLReg).toFixed(2)),
                speedupRatioWarm: Number((msLTar / msLRegWarm).toFixed(2)),
                savedMsCold: msLTar - msLReg,
                savedMsWarm: msLTar - msLRegWarm,
              },
              combinedTwoInstallsMs: {
                localTarballBoth: msGTar + msLTar,
                localRegistryColdThenWarm: msGReg + msLRegWarm,
                localRegistryBothCold: msGReg + msLReg,
              },
              httpRequests: {
                globalCold: gRegRequests,
                projectLocalCold: lRegRequests,
                projectLocalWarm: warmRequests,
              },
            }),
        );
      } finally {
        await registry.close();
      }
    },
    600_000,
  );
});
