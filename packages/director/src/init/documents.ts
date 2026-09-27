/**
 * Candidate document discovery (TASK-014). Bounded and deterministic: candidates come from the
 * Scanner's file list (so .gitignore and secret files are already out) and are ranked by their path
 * alone (location tier + keyword bonus); only the top candidates are read, each up to a size cap.
 * Not every Markdown file is read. Reading serves three things: the provenance hash, DUO definitions
 * already written in a compatible format (import candidates, never written as Truth), and a suggested
 * project goal (README first paragraph, else package.json description), which stays a suggestion.
 */
import fs from "node:fs";
import path from "node:path";
import {
  compareUtf8, externalSourceSlice, METADATA_BLOCK_LANG, parseDefinitionMarkdown, parseMarkdown, readSourceFile, STATE_DIR_NAME, type RepoPath,
} from "@duo-director/core";
import type { CandidateDocument, DocumentKind, ImportCandidate, InitQuestion } from "./types.js";

export interface DiscoveryOptions {
  readonly maxDocuments?: number;
  readonly maxBytes?: number;
}

const DOC_EXT = /\.(?:md|markdown|mdx|rst|adoc|txt)$/iu;
const KEYWORDS = ["architecture", "design", "spec", "specification", "specs", "requirements", "requirement", "prd", "rfc", "adr", "decisions", "decision", "roadmap", "vision", "overview", "plan", "기획", "설계", "요구사항"];
const LEGAL = /^(?:license|licence|copying|notice|code_of_conduct|code-of-conduct|security|changelog|changes|history)(?:\.|$)/iu;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", "vendor", ".github", "fixtures", "__fixtures__", "test", "tests"]);
const DEFAULT_MAX_DOCUMENTS = 20;
const DEFAULT_MAX_BYTES = 256 * 1024;
const MAX_IMPORT_DEFINITIONS = 200;
const MAX_SUGGESTION = 500;

function tokens(p: string): string[] {
  return p.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t !== "");
}

/** ASCII keywords match whole path tokens; Hangul keywords also match inside a token ("기획서" contains "기획"). */
const keywordHit = (token: string, keyword: string): boolean => token === keyword || (/\p{Script=Hangul}/u.test(keyword) && token.includes(keyword));

interface Ranked {
  readonly path: RepoPath;
  readonly kind: DocumentKind;
  readonly score: number;
  readonly reasons: string[];
}

function rank(p: RepoPath): Ranked | undefined {
  if (!DOC_EXT.test(p) || p.startsWith(`${STATE_DIR_NAME}/`)) return undefined;
  const segs = p.split("/");
  const name = segs[segs.length - 1] ?? "";
  const dirs = segs.slice(0, -1).map((s) => s.toLowerCase());
  if (LEGAL.test(name) || dirs.some((d) => SKIP_DIRS.has(d))) return undefined;
  const stem = name.toLowerCase().replace(/\.[^.]*$/u, "");
  const depth = dirs.length;
  const inDocs = dirs[0] === "docs" || dirs[0] === "doc";
  let kind: DocumentKind = "other";
  let score = 0;
  const reasons: string[] = [];
  if (stem === "readme" && depth === 0) { kind = "readme"; score = 100; reasons.push("root-readme"); }
  else if (stem === "contributing" && depth === 0) { kind = "contributing"; score = 80; reasons.push("root-contributing"); }
  else if ((stem === "architecture" || stem === "design") && depth === 0) { kind = "design"; score = 80; reasons.push("root-design"); }
  else if (inDocs) { kind = "docs"; score = Math.max(30, 60 - 5 * (depth - 1)); reasons.push(depth === 1 ? "docs" : "docs-nested"); }
  else if (stem === "readme") { kind = "package-readme"; score = Math.max(20, 40 - 5 * (depth - 1)); reasons.push("nested-readme"); }
  else if (depth === 0) { score = 60; reasons.push("root-document"); }
  const pathTokens = tokens(p);
  const hits = KEYWORDS.filter((k) => pathTokens.some((t) => keywordHit(t, k))).sort(compareUtf8);
  if (hits.length > 0) {
    score += Math.min(40, 20 * hits.length);
    reasons.push(...hits.map((h) => `keyword:${h}`));
    if (kind === "other" || kind === "docs") kind = "design";
  }
  return score >= 30 ? { path: p, kind, score, reasons } : undefined;
}

export interface Discovery {
  readonly documents: CandidateDocument[];
  readonly importCandidates: ImportCandidate[];
  readonly goal?: Pick<InitQuestion, "suggestedValue" | "evidence">;
}

function readBounded(root: string, p: RepoPath, maxBytes: number): string | undefined {
  try {
    if (fs.statSync(path.join(root, p)).size > maxBytes) return undefined;
  } catch {
    return undefined;
  }
  return readSourceFile(root, p).value;
}

function firstParagraph(p: RepoPath, text: string): string | undefined {
  const doc = parseMarkdown(p, text).value;
  const para = doc?.blocks.find((b) => b.kind === "other" && (b.paragraph ?? "") !== "");
  const value = para?.kind === "other" ? para.paragraph : undefined;
  return value === undefined ? undefined : value.length > MAX_SUGGESTION ? `${value.slice(0, MAX_SUGGESTION - 1)}…` : value;
}

const FENCE = new RegExp(`^(?:\`\`\`|~~~)${METADATA_BLOCK_LANG}\\s*$`, "mu");

export function discoverDocuments(root: string, files: readonly RepoPath[], rootDescription: string | undefined, options: DiscoveryOptions = {}): Discovery {
  const max = options.maxDocuments ?? DEFAULT_MAX_DOCUMENTS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const ranked = files.flatMap((f) => rank(f) ?? []).sort((a, b) => b.score - a.score || compareUtf8(a.path, b.path)).slice(0, max);
  const documents: CandidateDocument[] = [];
  const importCandidates: ImportCandidate[] = [];
  let importCount = 0;
  let goal: Discovery["goal"];
  for (const r of ranked) {
    const text = readBounded(root, r.path, maxBytes);
    const slice = text === undefined ? undefined : externalSourceSlice(r.path, text);
    const hash = slice?.status === "ok" ? slice.hash : undefined;
    let definitions = 0;
    if (text !== undefined && hash !== undefined && /\.(?:md|markdown|mdx)$/iu.test(r.path) && FENCE.test(text)) {
      const defs = parseDefinitionMarkdown(r.path, text).value;
      const found = defs === undefined ? [] : [
        ...defs.requirements.map((d) => ({ kind: "requirement" as const, id: d.id, title: d.title })),
        ...defs.decisions.map((d) => ({ kind: "decision" as const, id: d.id, title: d.title })),
        ...defs.issues.map((d) => ({ kind: "issue" as const, id: d.id, title: d.title })),
        ...defs.milestones.map((d) => ({ kind: "milestone" as const, id: d.id, title: d.title })),
      ].sort((a, b) => compareUtf8(a.id, b.id));
      definitions = found.length;
      const room = Math.max(0, MAX_IMPORT_DEFINITIONS - importCount);
      if (found.length > 0 && room > 0) {
        importCandidates.push({ status: "candidate", path: r.path, hash, definitions: found.slice(0, room) });
        importCount += Math.min(room, found.length);
      }
    }
    if (goal === undefined && r.kind === "readme" && text !== undefined && hash !== undefined && /\.(?:md|markdown|mdx)$/iu.test(r.path)) {
      const value = firstParagraph(r.path, text);
      if (value !== undefined) goal = { suggestedValue: value, evidence: [{ path: r.path, hash }] };
    }
    documents.push({ path: r.path, kind: r.kind, score: r.score, reasons: r.reasons, ...(hash === undefined ? {} : { hash }), definitions });
  }
  if (goal === undefined && rootDescription !== undefined) {
    goal = { suggestedValue: rootDescription.slice(0, MAX_SUGGESTION), evidence: [{ path: "package.json" as RepoPath, field: "description" }] };
  }
  return { documents, importCandidates, ...(goal === undefined ? {} : { goal }) };
}

