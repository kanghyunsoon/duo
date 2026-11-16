/**
 * Zero-dependency local HTTP npm registry for distribution E2E and #37 local-registry
 * install testing (Jira S15P31A106-288).
 *
 * Runs the HTTP server inside a `node:worker_threads` Worker so synchronous `npm(...)` calls
 * (`spawnSync` on the main thread) do not block the registry's event loop, and uses
 * `receiveMessageOnPort` so `registry.requests` is immediately up-to-date right after `spawnSync`
 * returns.
 *
 * Serves only the single packed package (by default @duo-director/cli from .dist/pack.json or
 * any supplied .tgz via `readPackageJsonFromTarball`) over 127.0.0.1:<ephemeral-port>. Every
 * other package or route returns 404 Not Found, proving at the network layer that npm installs
 * all bundled runtime dependencies from the tarball rather than fetching third-party packages
 * from the registry (H-65).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import zlib from "node:zlib";
import { packReport, REPO, type PackReport } from "./support.js";

export interface LocalRegistryManifest {
  readonly name: string;
  readonly version: string;
  readonly [key: string]: unknown;
}

export interface LocalRegistryOptions {
  readonly distDir?: string;
  readonly manifest?: LocalRegistryManifest;
  readonly tarballPath?: string;
  readonly integrity?: string;
}

export interface LocalRegistryRequest {
  readonly method: string;
  readonly url: string;
  readonly statusCode: number;
}

export interface LocalNpmRegistry {
  readonly url: string;
  readonly name: string;
  readonly version: string;
  readonly packageSpec: string;
  readonly tarballUrl: string;
  readonly integrity: string;
  readonly shasum: string;
  readonly requests: readonly LocalRegistryRequest[];
  close(): Promise<void>;
}

function readCString(buf: Buffer, start: number, end: number): string {
  let i = start;
  while (i < end && buf[i] !== 0) i++;
  return buf.subarray(start, i).toString("utf8");
}

function parseTarSize(buf: Buffer, offset: number): number {
  const firstByte = buf[offset] ?? 0;
  // Base-256 (binary) size encoding when high bit is set
  if ((firstByte & 0x80) !== 0) {
    let value = 0;
    for (let i = offset + 4; i < offset + 12; i++) {
      value = value * 256 + (buf[i] ?? 0);
    }
    return value;
  }
  const raw = readCString(buf, offset, offset + 12).trim();
  return raw.length === 0 ? 0 : Number.parseInt(raw, 8);
}

function parsePaxPath(payload: string): string | undefined {
  let pos = 0;
  while (pos < payload.length) {
    const spaceIdx = payload.indexOf(" ", pos);
    if (spaceIdx === -1) break;
    const len = Number.parseInt(payload.slice(pos, spaceIdx), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = payload.slice(spaceIdx + 1, pos + len - 1);
    if (record.startsWith("path=")) {
      return record.slice("path=".length);
    }
    pos += len;
  }
  return undefined;
}

/**
 * Extracts and parses `package/package.json` directly from a gzipped npm `.tgz` archive
 * using only `node:zlib` and a POSIX ustar / PAX / GNU LongLink header scanner.
 */
export function readPackageJsonFromTarball(tarballBytes: Buffer): LocalRegistryManifest {
  const tar = zlib.gunzipSync(tarballBytes);
  let offset = 0;
  let nextPaxPath: string | undefined;
  let nextLongLinkPath: string | undefined;

  while (offset + 512 <= tar.byteLength) {
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (tar[offset + i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    const name = readCString(tar, offset, offset + 100);
    const size = parseTarSize(tar, offset + 124);
    const typeflagByte = tar[offset + 156] ?? 0;
    const typeflag = typeflagByte === 0 ? "0" : String.fromCharCode(typeflagByte);
    const prefix = readCString(tar, offset + 345, offset + 500);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const paddedSize = Math.ceil(size / 512) * 512;

    if (dataEnd > tar.byteLength) break;

    if (typeflag === "x" || typeflag === "g") {
      const paxPayload = tar.subarray(dataStart, dataEnd).toString("utf8");
      const override = parsePaxPath(paxPayload);
      if (override !== undefined && typeflag === "x") {
        nextPaxPath = override;
      }
    } else if (typeflag === "L") {
      nextLongLinkPath = readCString(tar, dataStart, dataEnd);
    } else {
      const rawPath = nextPaxPath ?? nextLongLinkPath ?? (prefix.length > 0 ? `${prefix}/${name}` : name);
      nextPaxPath = undefined;
      nextLongLinkPath = undefined;
      const normalized = rawPath.replace(/\\/g, "/").replace(/^\.\//, "");
      if (typeflag === "0" && normalized === "package/package.json") {
        const parsed = JSON.parse(tar.subarray(dataStart, dataEnd).toString("utf8")) as LocalRegistryManifest;
        if (typeof parsed.name !== "string" || typeof parsed.version !== "string") {
          throw new Error("package/package.json inside tarball is missing string name or version");
        }
        return parsed;
      }
    }

    offset = dataStart + paddedSize;
  }

  throw new Error("package/package.json not found in tarball");
}

function resolveArtifact(options: LocalRegistryOptions): {
  manifest: LocalRegistryManifest;
  tarballPath: string;
  tarballSize: number;
  integrity: string;
  shasum: string;
} {
  if (options.tarballPath !== undefined) {
    const bytes = fs.readFileSync(options.tarballPath);
    const manifest = options.manifest ?? readPackageJsonFromTarball(bytes);
    const integrity = options.integrity ?? `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const shasum = createHash("sha1").update(bytes).digest("hex");
    return { manifest, tarballPath: options.tarballPath, tarballSize: bytes.byteLength, integrity, shasum };
  }
  const distDir = options.distDir ?? path.join(REPO, ".dist");
  const pack: PackReport = packReport(distDir);
  const bytes = fs.readFileSync(pack.tarball);
  const manifestPath = path.join(distDir, "cli-package", "package.json");
  const manifest =
    options.manifest ??
    (fs.existsSync(manifestPath)
      ? (JSON.parse(fs.readFileSync(manifestPath, "utf8")) as LocalRegistryManifest)
      : readPackageJsonFromTarball(bytes));
  const integrity = options.integrity ?? pack.integrity;
  const shasum = createHash("sha1").update(bytes).digest("hex");
  return { manifest, tarballPath: pack.tarball, tarballSize: bytes.byteLength, integrity, shasum };
}

const WORKER_SCRIPT = `
const fs = require("node:fs");
const http = require("node:http");
const { pipeline } = require("node:stream");
const { parentPort, workerData } = require("node:worker_threads");

const { manifest, tarballPath, tarballSize, integrity, shasum, plainName, tarballRoute, reqPort } = workerData;
const { name, version } = manifest;
let baseUrl = "";

const server = http.createServer((req, res) => {
  const method = req.method ?? "GET";
  const rawUrl = req.url ?? "/";
  const pathname = new URL(rawUrl, "http://127.0.0.1").pathname;
  let decodedPath = pathname;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    // keep raw pathname if malformed percent-encoding
  }
  const record = (statusCode) => {
    reqPort.postMessage({ method, url: rawUrl, statusCode });
    res.statusCode = statusCode;
  };

  if (method !== "GET" && method !== "HEAD") {
    record(405);
    res.end();
    return;
  }

  if (decodedPath === plainName) {
    const bundled = manifest.bundleDependencies ?? manifest.bundledDependencies;
    const versionMeta = {
      ...manifest,
      _id: name + "@" + version,
      ...(bundled === undefined ? {} : { bundleDependencies: bundled, bundledDependencies: bundled }),
      dist: {
        integrity,
        shasum,
        tarball: baseUrl + tarballRoute,
      },
    };
    const packument = {
      _id: name,
      name,
      "dist-tags": { latest: version },
      versions: { [version]: versionMeta },
    };
    const body = Buffer.from(JSON.stringify(packument), "utf8");
    record(200);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", String(body.byteLength));
    if (method === "HEAD") {
      res.end();
    } else {
      res.end(body);
    }
    return;
  }

  if (decodedPath === tarballRoute) {
    record(200);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(tarballSize));
    if (method === "HEAD") {
      res.end();
      return;
    }
    pipeline(fs.createReadStream(tarballPath), res, () => {});
    return;
  }

  record(404);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: "Not found", path: decodedPath }));
});

server.on("error", (err) => {
  parentPort.postMessage({ type: "error", message: String((err && err.message) || err) });
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  baseUrl = "http://127.0.0.1:" + port;
  parentPort.postMessage({ type: "listening", url: baseUrl });
});

parentPort.on("message", (msg) => {
  if (msg && msg.type === "close") {
    server.closeAllConnections?.();
    server.close(() => {
      reqPort.close();
      parentPort.postMessage({ type: "closed" });
    });
  }
});
`;

export async function startLocalNpmRegistry(options: LocalRegistryOptions = {}): Promise<LocalNpmRegistry> {
  const { manifest, tarballPath, tarballSize, integrity, shasum } = resolveArtifact(options);
  const { name, version } = manifest;
  const plainName = `/${name}`;
  const baseName = name.includes("/") ? name.slice(name.indexOf("/") + 1) : name;
  const tarballRoute = `${plainName}/-/${baseName}-${version}.tgz`;

  const { port1: mainReqPort, port2: workerReqPort } = new MessageChannel();
  const collectedRequests: LocalRegistryRequest[] = [];
  const drainRequests = (): readonly LocalRegistryRequest[] => {
    for (;;) {
      const msg = receiveMessageOnPort(mainReqPort);
      if (msg === undefined) break;
      collectedRequests.push(msg.message as LocalRegistryRequest);
    }
    return [...collectedRequests];
  };

  const worker = new Worker(WORKER_SCRIPT, {
    eval: true,
    workerData: {
      manifest,
      tarballPath,
      tarballSize,
      integrity,
      shasum,
      plainName,
      tarballRoute,
      reqPort: workerReqPort,
    },
    transferList: [workerReqPort],
  });

  const baseUrl = await new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      worker.off("error", onError);
      worker.off("exit", onExit);
      worker.off("message", onMsg);
    };
    const fail = (err: Error) => {
      cleanup();
      mainReqPort.close();
      void worker.terminate();
      reject(err);
    };
    const onError = (err: Error) => fail(err);
    const onExit = (code: number) => fail(new Error(`Local registry worker exited prematurely with code ${code}`));
    const onMsg = (msg: { type?: string; url?: string; message?: string }) => {
      if (msg?.type === "listening" && typeof msg.url === "string") {
        cleanup();
        resolve(msg.url);
      } else if (msg?.type === "error") {
        fail(new Error(msg.message ?? "Local registry server failed to start"));
      }
    };
    worker.once("error", onError);
    worker.once("exit", onExit);
    worker.on("message", onMsg);
  });

  let closePromise: Promise<void> | undefined;
  return {
    url: baseUrl,
    name,
    version,
    packageSpec: `${name}@${version}`,
    tarballUrl: `${baseUrl}${tarballRoute}`,
    integrity,
    shasum,
    get requests() {
      return drainRequests();
    },
    close: () => {
      closePromise ??= (async () => {
        await new Promise<void>((resolve) => {
          const cleanup = () => {
            worker.off("message", onClose);
            worker.off("exit", onDone);
            worker.off("error", onDone);
          };
          const onDone = () => {
            cleanup();
            resolve();
          };
          const onClose = (msg: { type?: string }) => {
            if (msg?.type === "closed") {
              onDone();
            }
          };
          worker.on("message", onClose);
          worker.once("exit", onDone);
          worker.once("error", onDone);
          worker.postMessage({ type: "close" });
        });
        drainRequests();
        mainReqPort.close();
        await worker.terminate();
      })();
      return closePromise;
    },
  };
}
