#!/usr/bin/env node
// DIY baseline for Decision Compliance Benchmark 1: a bespoke gate for ONE rule (no symbol whose name contains
// SessionStore; existing ones are legacy debt). Git + Node standard library only, no DUO code, no network, no LLM.
//   node session-store-gate.mjs --base <commit> --head <commit>   (run inside the repository)
// Prints JSON; exit 1 when a new SessionStore symbol is introduced, else 0.
import { execFileSync } from "node:child_process";

const arg = (n) => process.argv[process.argv.indexOf("--" + n) + 1];
const [base, head] = [arg("base"), arg("head")];
const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const SOURCE = /\.(?:[cm]?[jt]sx?)$/u;
const DECL = /^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:declare[ \t]+)?(?:abstract[ \t]+)?(?:class|interface|function\*?|type|enum|const|let|var)[ \t]+([A-Za-z_$][\w$]*)/gmu;

// Declarations whose name contains SessionStore, with the line range of their body (brace matching, good enough for one rule).
function symbols(rev, file) {
  let text;
  try { text = git("show", rev + ":" + file); } catch { return []; }
  const lines = text.split("\n");
  const out = [];
  for (const m of text.matchAll(DECL)) {
    if (!m[1].includes("SessionStore")) continue;
    const start = text.slice(0, m.index).split("\n").length;
    let depth = 0, end = start, opened = false;
    for (let i = start - 1; i < lines.length; i++) {
      for (const ch of lines[i]) { if (ch === "{") { depth++; opened = true; } else if (ch === "}") depth--; }
      end = i + 1;
      if (opened && depth <= 0) break;
      if (!opened && lines[i].includes(";")) break;
    }
    out.push({ symbol: m[1], start, end });
  }
  return out;
}
const files = (rev) => git("ls-tree", "-r", "--name-only", rev).split("\n").filter((f) => SOURCE.test(f) && !f.startsWith(".duo-project/"));

// Changed line ranges in the head version (and deleted-at positions), from a zero-context diff.
function changedRanges(file) {
  const ranges = [];
  for (const m of git("diff", "-U0", base, head, "--", file).matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gmu)) {
    const start = Number(m[1]), count = m[2] === undefined ? 1 : Number(m[2]);
    ranges.push([start, Math.max(start, start + count - 1)]);
  }
  return ranges;
}

const legacy = new Map(); // "file#symbol" → range at base
for (const f of files(base)) for (const s of symbols(base, f)) legacy.set(f + "#" + s.symbol, s);
const legacyNames = new Set([...legacy.keys()].map((k) => k.split("#")[1]));
const changed = git("diff", "--name-only", "--no-renames", base, head).split("\n").filter((f) => SOURCE.test(f) && !f.startsWith(".duo-project/"));

const findings = [];
const touchedLegacy = new Set();
for (const f of changed) {
  const ranges = changedRanges(f);
  for (const s of symbols(head, f)) {
    const key = f + "#" + s.symbol;
    const touched = ranges.some(([a, b]) => a <= s.end && b >= s.start);
    if (legacy.has(key) || legacyNames.has(s.symbol)) {
      if (touched) { findings.push({ classification: "pre-existing-touched", blocking: false, file: f, symbol: s.symbol, lines: [s.start, s.end] }); touchedLegacy.add(key); }
    } else {
      findings.push({ classification: "introduced", blocking: true, file: f, symbol: s.symbol, lines: [s.start, s.end] });
    }
  }
}
for (const [key, s] of legacy) if (!touchedLegacy.has(key)) findings.push({ classification: "pre-existing", blocking: false, file: key.split("#")[0], symbol: s.symbol, lines: [s.start, s.end] });
findings.sort((a, b) => (a.file + a.symbol < b.file + b.symbol ? -1 : 1));
const verdict = findings.some((x) => x.blocking) ? "BLOCK" : findings.some((x) => x.classification === "pre-existing-touched") ? "WARN" : "PASS";
console.log(JSON.stringify({ rule: "no symbol whose name contains SessionStore (D-001)", base, head, verdict, findings }, null, 2));
process.exitCode = verdict === "BLOCK" ? 1 : 0;
