#!/usr/bin/env node
// SDD traceability validator for this repository.
// Parsing, schemas and trace rules come from @duo/core: the same parser DUO uses for .duo/.
// This script adds only repository documentation policy: which files define REQ/ADR/TASK/Milestone,
// link and anchor checks, and the REQ-/ADR-/TASK-/AC- mention convention.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { analyzeTrace, formatDiagnostic, parseDefinitionDocument, parseMarkdown } from "@duo/core";

const SKIP = new Set([".git", "node_modules", "dist", "coverage", "tmp", ".worklog", "fixtures"]);
const MENTION = /\b(?:REQ-[A-Z]+-\d{3}|ADR-\d{3}|TASK-\d{3}[A-Z]?|AC-\d{3}[A-Z]?-\d{2})\b/g;

/** Files that define REQ/ADR/TASK/Milestone (ADR-014). */
export function isDefinitionSource(repoPath) {
  return ["docs/01-requirements.md", "docs/tasks/TASKS.md", "docs/12-roadmap.md"].includes(repoPath)
    || /^docs\/adr\/ADR-\d+[^/]*\.md$/.test(repoPath);
}

/** GitHub-style heading anchor. */
export function slug(text) {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
}

function walk(root, dir = "", out = []) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(root, rel, out);
    else if (rel.endsWith(".md")) out.push(rel);
  }
  return out.sort();
}

export function validateDocs(root) {
  const problems = [];
  const report = (d) => problems.push(formatDiagnostic(d));
  const docs = new Map();
  for (const file of walk(root)) {
    const parsed = parseMarkdown(file, fs.readFileSync(path.join(root, file), "utf8"));
    parsed.diagnostics.forEach(report);
    if (parsed.value) docs.set(file, parsed.value);
  }

  // Links and anchors
  const anchors = new Map([...docs].map(([file, doc]) => [file, new Set(doc.blocks.filter((b) => b.kind === "heading").map((b) => slug(b.text)))]));
  for (const [file, doc] of docs) {
    for (const link of doc.links) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(link.url)) continue; // http:, https:, mailto:, codex: ...
      const [target, anchor] = link.url.split("#");
      const targetPath = target ? path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURIComponent(target))) : file;
      const at = `${link.location.path}:${link.location.startLine}`;
      if (!fs.existsSync(path.join(root, targetPath))) problems.push(`${at} broken link ${link.url}`);
      else if (anchor && anchors.has(targetPath) && !anchors.get(targetPath).has(decodeURIComponent(anchor))) problems.push(`${at} broken anchor ${link.url}`);
    }
  }

  // Definitions and trace (core)
  const defs = { requirements: [], decisions: [], constraints: [], issues: [], milestones: [], proposals: [] };
  for (const [file, doc] of docs) {
    if (!isDefinitionSource(file)) continue;
    const parsed = parseDefinitionDocument(doc);
    parsed.diagnostics.forEach((d) => d.severity !== "info" && report(d));
    for (const key of Object.keys(defs)) defs[key].push(...(parsed.value?.[key] ?? []));
  }
  const trace = analyzeTrace(defs, { requireTrackedRequirements: true });
  trace.diagnostics.filter((d) => d.severity !== "info").forEach(report);

  // ID mentions outside definitions must refer to defined IDs
  const known = (id) => (id.startsWith("AC-") ? trace.model.acceptance.has(id) : trace.model.entities.has(id));
  const unknown = new Set();
  for (const [file, doc] of docs) {
    if (file.startsWith("docs/references/")) continue;
    for (const t of doc.texts) {
      for (const m of t.value.matchAll(MENTION)) {
        if (!known(m[0])) unknown.add(`${t.location.path}:${t.location.startLine} unknown ID ${m[0]}`);
      }
    }
  }
  problems.push(...[...unknown].sort());

  return {
    report: {
      files: docs.size,
      requirements: defs.requirements.length,
      decisions: defs.decisions.length,
      issues: defs.issues.length,
      milestones: defs.milestones.length,
      acceptanceCriteria: trace.model.acceptance.size,
      links: trace.model.links.length,
    },
    problems,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { report, problems } = validateDocs(root);
  console.log(JSON.stringify(report, null, 1));
  for (const p of problems) console.error(p);
  if (problems.length > 0) {
    console.error(`validate-docs: ${problems.length} problem(s)`);
    process.exitCode = 1;
  } else {
    console.error("validate-docs: OK");
  }
}
