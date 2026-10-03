#!/usr/bin/env node
// DIY-2 for Decision Compliance Benchmark 2: DIY-1 plus a small versioned decision registry, so the gate applies only
// the current (confirmed) decisions, names the decision behind each finding and checks the supersession links.
// Git + Node standard library only; no DUO code, no network, no LLM.
//   registry (JSON, edited by people): [{ id, status: "confirmed"|"superseded", symbolContains, enforcement: "block"|"warn",
//                                        supersedes?: id, supersededBy?: id }]
//   node decision-gate.mjs adopt --at <commit> --registry <file> --state <file>   violations of every confirmed decision
//   node decision-gate.mjs check --base <c> --head <c> --registry <file> --state <file>
// A decision confirmed after adoption has no adoption entry, so all of its violations count as new.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const [cmd] = process.argv.slice(2);
const arg = (n) => process.argv[process.argv.indexOf("--" + n) + 1];
const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const SOURCE = /\.(?:[cm]?[jt]sx?)$/u;
const DECL = /^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:declare[ \t]+)?(?:abstract[ \t]+)?(?:class|interface|function\*?|type|enum|const|let|var)[ \t]+([A-Za-z_$][\w$]*)/gmu;

// The registry must be consistent before it is trusted.
function validate(registry) {
  const byId = new Map(registry.map((d) => [d.id, d]));
  const problems = [];
  if (byId.size !== registry.length) problems.push("duplicate decision id");
  for (const d of registry) {
    if (!["confirmed", "superseded"].includes(d.status)) problems.push(d.id + ": unknown status " + d.status);
    if (!["block", "warn"].includes(d.enforcement)) problems.push(d.id + ": unknown enforcement " + d.enforcement);
    if (typeof d.symbolContains !== "string" || d.symbolContains === "") problems.push(d.id + ": symbolContains missing");
    if (d.status === "superseded" && byId.get(d.supersededBy)?.supersedes !== d.id) problems.push(d.id + ": superseded without a decision that supersedes it");
    if (d.supersedes !== undefined && byId.get(d.supersedes)?.supersededBy !== d.id) problems.push(d.id + ": supersedes " + d.supersedes + " but the link is not mutual");
    if (d.supersedes !== undefined && d.status !== "confirmed") problems.push(d.id + ": a superseding decision must be confirmed");
  }
  if (problems.length > 0) { console.error("invalid registry:\n" + problems.join("\n")); process.exit(2); }
  return registry.filter((d) => d.status === "confirmed");
}

function declarations(rev, file) {
  let text;
  try { text = git("show", rev + ":" + file); } catch { return []; }
  const lines = text.split("\n");
  const out = [];
  for (const m of text.matchAll(DECL)) {
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
  const current = validate(readJson(arg("registry")));
  const files = sources(git("ls-tree", "-r", "--name-only", at));
  const known = Object.fromEntries(current.map((d) => [d.id, files.flatMap((f) => declarations(at, f).filter((s) => s.symbol.includes(d.symbolContains)).map((s) => f + "#" + s.symbol)).sort()]));
  fs.writeFileSync(arg("state"), JSON.stringify({ adoptedAt: at, known }, null, 2) + "\n");
} else if (cmd === "check") {
  const [base, head] = [arg("base"), arg("head")];
  const current = validate(readJson(arg("registry")));
  const state = readJson(arg("state"));
  const findings = [];
  for (const f of sources(git("diff", "--name-only", "--no-renames", base, head))) {
    const ranges = [...git("diff", "-U0", base, head, "--", f).matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gmu)]
      .map((m) => [Number(m[1]), Number(m[1]) + Math.max(0, (m[2] === undefined ? 1 : Number(m[2])) - 1)]);
    for (const s of declarations(head, f)) {
      if (!ranges.some(([a, b]) => a <= s.end && b >= s.start)) continue;
      for (const d of current.filter((x) => s.symbol.includes(x.symbolContains))) {
        const atAdoption = (state.known[d.id] ?? []).includes(f + "#" + s.symbol);
        findings.push({ decision: d.id, supersedes: d.supersedes ?? null, classification: atAdoption ? "known-at-adoption-touched" : "not-known-at-adoption",
          blocking: !atAdoption && d.enforcement === "block", file: f, symbol: s.symbol, lines: [s.start, s.end] });
      }
    }
  }
  findings.sort((a, b) => (a.decision + a.file + a.symbol < b.decision + b.file + b.symbol ? -1 : 1));
  const verdict = findings.some((x) => x.blocking) ? "BLOCK" : findings.length > 0 ? "WARN" : "PASS";
  console.log(JSON.stringify({ current: current.map((d) => d.id), adoptedAt: state.adoptedAt, base, head, verdict, findings }, null, 2));
  process.exitCode = verdict === "BLOCK" ? 1 : 0;
} else {
  console.error("usage: decision-gate.mjs adopt --at <c> --registry <f> --state <f> | check --base <c> --head <c> --registry <f> --state <f>");
  process.exitCode = 2;
}
