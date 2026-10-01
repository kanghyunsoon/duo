// T25.2 upper bound of the repositoryState header query: the production git status --branch against the
// two queries that give the same two fields (HEAD oid, symbolic ref), and git diff-files, timed alternately.
//   node bench/experiments/git-header-cost.mjs --repo <checkout> [--rounds 7]
import { execFile } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
const arg = (n) => { const i = process.argv.indexOf("--" + n); return i < 0 ? undefined : process.argv[i + 1]; };
const root = path.resolve(arg("repo")); const rounds = Number(arg("rounds") ?? 7);
const git = (args) => new Promise((res) => { const t = performance.now(); execFile("git", args, { cwd: root, windowsHide: true, maxBuffer: 1 << 26 }, (e, out) => res({ ms: performance.now() - t, out: String(out), code: e?.code ?? 0 })); });
const Q = {
  "status --branch (production)": ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=no", "--ignore-submodules=all"],
  "symbolic-ref -q HEAD": ["symbolic-ref", "-q", "HEAD"],
  "rev-parse -q --verify HEAD": ["rev-parse", "-q", "--verify", "HEAD"],
  "diff-files -z --name-only --diff-filter=T (scan)": ["diff-files", "-z", "--name-only", "--diff-filter=T"],
};
const ms = Object.fromEntries(Object.keys(Q).map((k) => [k, []]));
for (const k of Object.keys(Q)) await git(Q[k]);
for (let r = 0; r < rounds; r++) for (const k of (r % 2 ? Object.keys(Q).reverse() : Object.keys(Q))) ms[k].push((await git(Q[k])).ms);
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const header = (await git(Q["status --branch (production)"])).out.split("\0").filter((t) => t.startsWith("# branch.")).join(" | ");
console.log(JSON.stringify({ repo: path.basename(root), header, symbolic: (await git(Q["symbolic-ref -q HEAD"])).out.trim(), head: (await git(Q["rev-parse -q --verify HEAD"])).out.trim(), medianMs: Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, Math.round(med(v))])) }));

