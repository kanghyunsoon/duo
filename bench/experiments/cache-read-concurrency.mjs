// T21-D experiment: the analysis-cache check reads every cache entry of the structural files. Compares reading and
// parsing all entries one by one with synchronous reads (the current inspectIndex path, without its symlink check)
// against asynchronous reads with bounded concurrency. Same bytes and parsed values; only the scheduling differs.
//   node bench/experiments/cache-read-concurrency.mjs [large] [--rounds 3]
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const name = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "large";
const i = process.argv.indexOf("--rounds");
const rounds = i < 0 ? 3 : Number(process.argv[i + 1]);
const dir = fileURLToPath(new URL("../results/local/fixtures/" + name + "/.duo-project/cache/analysis/", import.meta.url));
const files = fs.readdirSync(dir).map((f) => path.join(dir, f));
const sequential = () => { let n = 0; for (const f of files) n += JSON.parse(fs.readFileSync(f, "utf8")).analysis ? 1 : 0; return n; };
const pooled = async (limit) => {
  let next = 0, n = 0;
  const worker = async () => { while (next < files.length) { const f = files[next++]; const text = await fs.promises.readFile(f, "utf8"); n += JSON.parse(text).analysis ? 1 : 0; } };
  await Promise.all(Array.from({ length: limit }, worker));
  return n;
};
const lstatChain = () => { for (const f of files) { let p = f; for (let k = 0; k < 4; k++) { fs.lstatSync(p); p = path.dirname(p); } } };
sequential(); // warm the OS file cache
const t = { sequentialSync: [], async16: [], async64: [], lstatChain4PerFile: [] };
for (let r = 0; r < rounds; r++) {
  let s = performance.now(); const a = sequential(); t.sequentialSync.push(performance.now() - s);
  s = performance.now(); const b = await pooled(16); t.async16.push(performance.now() - s);
  s = performance.now(); const c = await pooled(64); t.async64.push(performance.now() - s);
  s = performance.now(); lstatChain(); t.lstatChain4PerFile.push(performance.now() - s);
  if (a !== b || b !== c) throw new Error("different results");
}
const median = (xs) => { const s = [...xs].sort((x, y) => x - y); return Math.round(s[Math.floor(s.length / 2)]); };
console.log(JSON.stringify({ fixture: name, entries: files.length, rounds, medianMs: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, median(v)])) }));

