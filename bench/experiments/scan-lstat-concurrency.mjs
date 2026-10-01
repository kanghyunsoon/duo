// T25.2 experiment: the scanner's lstat set (every candidate file and every ancestor directory, one lstat each)
// done with lstatSync in order (production) against fs.promises.lstat with bounded concurrency, interleaved.
//   node bench/experiments/scan-lstat-concurrency.mjs --repo <checkout> [--rounds 9] [--limits 4,16,32]
import fs from "node:fs"; import path from "node:path"; import { execFileSync } from "node:child_process"; import { performance } from "node:perf_hooks";
const arg = (n) => { const i = process.argv.indexOf("--" + n); return i < 0 ? undefined : process.argv[i + 1]; };
const root = fs.realpathSync(path.resolve(arg("repo"))); const rounds = Number(arg("rounds") ?? 9);
const limits = (arg("limits") ?? "4,16,32").split(",").map(Number);
const list = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 }).split("\0").filter(Boolean);
const dirs = new Set(); for (const p of list) { const s = p.split("/"); for (let k = 1; k < s.length; k++) dirs.add(s.slice(0, k).join("/")); }
const targets = [...dirs, ...list].map((p) => path.join(root, p));
const kind = (s) => (s.isSymbolicLink() ? "l" : s.isFile() ? "f" : s.isDirectory() ? "d" : "o");
const seq = async () => targets.map((t) => { try { return kind(fs.lstatSync(t)); } catch { return "m"; } }).join("");
const bounded = (c) => async () => { const out = new Array(targets.length); let next = 0;
  await Promise.all(Array.from({ length: c }, async () => { while (next < targets.length) { const i = next++; try { out[i] = kind(await fs.promises.lstat(targets[i])); } catch { out[i] = "m"; } } }));
  return out.join(""); };
const variants = [["lstatSync (production)", seq], ...limits.map((c) => ["async " + c, bounded(c)])];
const ref = await seq(); const ms = new Map(variants.map(([n]) => [n, []])); let equal = true;
for (const [, f] of variants) await f();
for (let r = 0; r < rounds; r++) for (const [n, f] of r % 2 ? [...variants].reverse() : variants) { const t = performance.now(); const v = await f(); ms.get(n).push(performance.now() - t); if (v !== ref) equal = false; }
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log(JSON.stringify({ repo: path.basename(root), entries: targets.length, equal, medianMs: Object.fromEntries([...ms].map(([n, v]) => [n, Math.round(med(v))])) }));

