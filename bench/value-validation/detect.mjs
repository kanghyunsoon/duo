#!/usr/bin/env node
// Value Validation 01 (T81): the deterministic detection test. Every ground-truth case (cases.mjs) is applied to a
// fresh copy of the condition C repository (it holds both the B checks and DUO) and checked by:
//   eslint: `eslint src` with the fixture's eslint.config.js plus scripts/check-deps.mjs (condition B's gate);
//   duo:    `duoctl review --refresh --fail-on block --json` (DUO's gate in condition C).
// Condition C's gate is both together. Condition A has no automatic gate. No LLM and no network are used.
//   node bench/value-validation/detect.mjs --duoctl <duoctl.js> --core <core dist index.js> --eslint <eslint bin.js> --work <dir> [--out results.json]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CASES } from "./cases.mjs";
import { generate, git, RULES } from "./fixture.mjs";

const a = process.argv.slice(2);
const arg = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined);
const duoctl = path.resolve(arg("--duoctl") ?? "");
const core = path.resolve(arg("--core") ?? "");
const eslint = path.resolve(arg("--eslint") ?? "");
const work = path.resolve(arg("--work") ?? "vv-work");
const outFile = arg("--out");
const run = (cmd, args, cwd, input) => { const t = performance.now(); const r = spawnSync(cmd, args, { cwd, input, encoding: "utf8", maxBuffer: 1 << 28, windowsHide: true, env: { ...process.env, NO_COLOR: "1", DUO_LOCALE: "en" } }); return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", ms: Math.round(performance.now() - t) }; };

/** Applies the written change of a case to a repository copy. */
function applyChange(root, c) {
  for (const [p, t] of Object.entries(c.write ?? {})) { const f = path.join(root, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); }
  for (const [p, { find, by }] of Object.entries(c.edit ?? {})) {
    const f = path.join(root, p); const text = fs.readFileSync(f, "utf8");
    if (!text.includes(find)) throw new Error(c.id + ": " + p + " does not contain the text to replace");
    fs.writeFileSync(f, text.replace(find, by));
  }
  if (c.pkg !== undefined) {
    const f = path.join(root, "package.json"); const pkg = JSON.parse(fs.readFileSync(f, "utf8"));
    for (const [field, deps] of Object.entries(c.pkg)) pkg[field] = { ...(pkg[field] ?? {}), ...deps };
    fs.writeFileSync(f, JSON.stringify(pkg, null, 2) + "\n");
  }
}

/** Category 4: a person approves moment. B: the dependency check and the written rule. C: also a Decision superseding D-002. */
async function approve(root) {
  const steps = [];
  const edit = (p, find, by) => { const f = path.join(root, p); const t = fs.readFileSync(f, "utf8"); if (!t.includes(find)) throw new Error("approval: " + p); fs.writeFileSync(f, t.replace(find, by)); steps.push({ by: "person", action: "edit " + p }); };
  const changed = "R2 (changed by the maintainer: moment is approved for date formatting).";
  edit("scripts/check-deps.mjs", 'const forbidden = ["moment"];', "const forbidden = [];");
  edit("AGENTS.md", RULES[1], changed);
  edit("docs/decisions.md", RULES[1], changed);
  const d = path.join(root, ".duo-project/decisions/D-004.yaml");
  fs.writeFileSync(d, ["id: D-004", "title: moment is allowed", "kind: decision", "state: proposed", "question: date_library", "answer: " + JSON.stringify(changed), "supersedes: D-002", ""].join("\n"));
  steps.push({ by: "person", action: "write .duo-project/decisions/D-004.yaml (supersedes D-002)" });
  const coreApi = await import(pathToFileURL(core).href);
  const r = await coreApi.createDecisionService({ root }).confirm({ kind: "human", name: "vv-maintainer" }, "D-004");
  if (r.value === undefined) throw new Error("confirm D-004: " + JSON.stringify(r.diagnostics));
  steps.push({ by: "person", action: "duoctl decision confirm D-004 (D-002 becomes superseded)" });
  git(root, "add", "-A");
  git(root, "commit", "--no-verify", "-qm", "Approve moment (R2 changed, D-004 supersedes D-002)");
  return steps;
}

function checkEslint(root) {
  const lint = run(process.execPath, [eslint, "src", "--format", "json"], root);
  const deps = run(process.execPath, ["scripts/check-deps.mjs"], root);
  let messages;
  try { messages = JSON.parse(lint.out).flatMap((f) => f.messages.map((m) => path.relative(root, f.filePath).replaceAll("\\", "/") + ":" + m.line + " " + (m.ruleId ?? "") + " " + m.message)); } catch { messages = [lint.out.slice(0, 300) + lint.err.slice(0, 300)]; }
  if (deps.code !== 0) messages.push(deps.err.trim());
  const ok = (lint.code === 0 || lint.code === 1) && (deps.code === 0 || deps.code === 1);
  return { outcome: !ok ? "error" : lint.code === 1 || deps.code === 1 ? "block" : "pass", ms: lint.ms + deps.ms, messages };
}

function checkDuo(root) {
  const r = run(process.execPath, [duoctl, "review", "--refresh", "--fail-on", "block", "--json"], root);
  let result;
  try { result = JSON.parse(r.out).result; } catch { /* reported as error */ }
  const verdict = result?.verdict;
  const outcome = result === undefined || verdict === undefined ? "error" : r.code === 4 ? "block" : verdict === "WARN" ? "warn" : verdict === "ASK" ? "ask" : verdict === "PASS" ? "pass" : "error";
  const claims = (result?.claims ?? []).filter((c) => c.alignment !== "ALIGNED").map((c) => ({ rule: c.rule, subject: c.subject?.id, alignment: c.alignment, reason: c.reason, provenance: c.provenance, observed: c.observed }));
  return { outcome, verdict: verdict ?? null, exit: r.code, ms: r.ms, claims, limitations: (result?.limitations ?? []).map((l) => l.code), error: outcome === "error" ? (r.out + r.err).slice(0, 500) : undefined };
}

fs.mkdirSync(work, { recursive: true });
const template = path.join(work, "template-C");
const fixture = fs.existsSync(template) ? { reused: true } : await generate(template, "C", { duoctl, core });
const results = [];
for (const c of CASES) {
  const root = path.join(work, "case-" + c.id);
  fs.rmSync(root, { recursive: true, force: true });
  fs.cpSync(template, root, { recursive: true });
  const approval = c.approval === true ? await approve(root) : [];
  if (c.approval === true) run(process.execPath, [duoctl, "index"], root);
  applyChange(root, c);
  results.push({ id: c.id, category: c.category, rule: c.rule, truth: c.truth, scope: c.scope, summary: c.summary, approval, eslint: checkEslint(root), duo: checkDuo(root) });
  const last = results[results.length - 1];
  console.log(c.id.padEnd(3), c.truth.padEnd(10), "eslint", last.eslint.outcome.padEnd(5), "duo", last.duo.outcome.padEnd(5), last.duo.claims.map((x) => x.rule + ":" + x.alignment + (x.provenance ? "/" + x.provenance : "")).join(", "));
}
const report = { format: "duo.value-validation-detection/1", at: new Date().toISOString(), node: process.version, duoctl: run(process.execPath, [duoctl, "--version"], work).out.trim(), eslint: run(process.execPath, [eslint, "--version"], work).out.trim(), fixture, results };
if (outFile !== undefined) fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n");

