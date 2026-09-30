// T21-D experiment: wall time of fingerprintRepositoryFiles on a fixture at several concurrency levels (default 16).
//   node bench/experiments/fingerprint-concurrency.mjs [large] [--rounds 3]
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { fingerprintRepositoryFiles, scanRepository } from "@duo-director/analyzer";
import { loadProjectTruth } from "@duo-director/core";

const name = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "large";
const i = process.argv.indexOf("--rounds");
const rounds = i < 0 ? 3 : Number(process.argv[i + 1]);
const root = fileURLToPath(new URL("../results/local/fixtures/" + name + "/", import.meta.url));
const truth = loadProjectTruth(root).value.truth;
const scan = await scanRepository(root, { include: truth.config.index.include, exclude: truth.config.index.exclude });
const levels = [4, 8, 16, 32, 64];
const times = new Map(levels.map((l) => [l, []]));
let reference;
await fingerprintRepositoryFiles(root, scan.files); // warm the OS file cache
for (let r = 0; r < rounds; r++) {
  for (const level of r % 2 === 0 ? levels : [...levels].reverse()) {
    const s = performance.now();
    const out = await fingerprintRepositoryFiles(root, scan.files, { concurrency: level });
    times.get(level).push(performance.now() - s);
    const digest = out.fingerprints.map((f) => f.path + ":" + f.contentHash).join("\n");
    if (reference === undefined) reference = digest; else if (digest !== reference) throw new Error("fingerprints differ at concurrency " + level);
  }
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.floor(s.length / 2)]); };
console.log(JSON.stringify({ fixture: name, files: scan.files.length, rounds, identicalResults: true, medianMs: Object.fromEntries(levels.map((l) => [l, median(times.get(l))])) }));

