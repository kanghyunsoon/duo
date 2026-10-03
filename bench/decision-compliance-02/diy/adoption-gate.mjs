#!/usr/bin/env node
// DIY-1 for Decision Compliance Benchmark 2: the one-rule gate (no symbol whose name contains SessionStore) plus a
// persisted adoption baseline, so "legacy" means "known at adoption", not "present at the diff base".
// Git + Node standard library only; no DUO code, no network, no LLM.
//   node adoption-gate.mjs adopt --at <commit> --state <file>       record the violations known at adoption
//   node adoption-gate.mjs check --base <commit> --head <commit> --state <file>
// check prints JSON and exits 1 when a SessionStore symbol that was not known at adoption is added or changed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const [cmd] = process.argv.slice(2);
const arg = (n) => process.argv[process.argv.indexOf("--" + n) + 1];
const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const PATTERN = "SessionStore";
const SOURCE = /\.(?:[cm]?[jt]sx?)$/u;
const DECL = /^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:declare[ \t]+)?(?:abstract[ \t]+)?(?:class|interface|function\*?|type|enum|const|let|var)[ \t]+([A-Za-z_$][\w$]*)/gmu;

function symbols(rev, file) {
  let text;
  try { text = git("show", rev + ":" + file); } catch { return []; }
  const lines = text.split("\n");
  const out = [];
  for (const m of text.matchAll(DECL)) {
    if (!m[1].includes(PATTERN)) continue;
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
const sources = (list) => list.split("\n").filter((f) => SOURCE.test(f) && !f.startsWith(".duo-project/"));

if (cmd === "adopt") {
  const at = git("rev-parse", arg("at")).trim();
  const known = sources(git("ls-tree", "-r", "--name-only", at)).flatMap((f) => symbols(at, f).map((s) => f + "#" + s.symbol)).sort();
  fs.writeFileSync(arg("state"), JSON.stringify({ rule: "no symbol whose name contains " + PATTERN + " (D-001)", adoptedAt: at, known }, null, 2) + "\n");
} else if (cmd === "check") {
  const [base, head] = [arg("base"), arg("head")];
  const state = JSON.parse(fs.readFileSync(arg("state"), "utf8"));
  const known = new Set(state.known);
  const findings = [];
  for (const f of sources(git("diff", "--name-only", "--no-renames", base, head))) {
    const ranges = [...git("diff", "-U0", base, head, "--", f).matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gmu)]
      .map((m) => [Number(m[1]), Number(m[1]) + Math.max(0, (m[2] === undefined ? 1 : Number(m[2])) - 1)]);
    for (const s of symbols(head, f)) {
      if (!ranges.some(([a, b]) => a <= s.end && b >= s.start)) continue;
      const atAdoption = known.has(f + "#" + s.symbol);
      findings.push({ classification: atAdoption ? "known-at-adoption-touched" : "not-known-at-adoption", blocking: !atAdoption, file: f, symbol: s.symbol, lines: [s.start, s.end] });
    }
  }
  findings.sort((a, b) => (a.file + a.symbol < b.file + b.symbol ? -1 : 1));
  const verdict = findings.some((x) => x.blocking) ? "BLOCK" : findings.length > 0 ? "WARN" : "PASS";
  console.log(JSON.stringify({ rule: state.rule, adoptedAt: state.adoptedAt, base, head, verdict, findings }, null, 2));
  process.exitCode = verdict === "BLOCK" ? 1 : 0;
} else {
  console.error("usage: adoption-gate.mjs adopt --at <commit> --state <file> | check --base <c> --head <c> --state <file>");
  process.exitCode = 2;
}
