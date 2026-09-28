/**
 * duo_search_evidence: deterministic evidence candidates, no embeddings. ID exact, path exact /
 * prefix, entity reference, lexical text match over Project Truth definitions, current Graph
 * entities, Review Records and the Adoption Baseline. Candidates are evidence to look at, never
 * confirmed intent.
 */
import fs from "node:fs";
import path from "node:path";
import { loadAdoptionBaseline, REVIEWS_DIR } from "@duo-director/director";
import { compareUtf8, type EntityType } from "@duo-director/core";
import { guarded, project, withGraphReader, type Operation, type Failure } from "./common.js";

export const EVIDENCE_SEARCH_FORMAT = "duo.evidence-search/1";
export const SEARCH_NOTICE = "Evidence candidates found by exact or lexical match. They are not confirmed intent, Decisions or Requirements.";

interface Candidate { readonly source: string; readonly kind: string; readonly id: string; readonly match: string; readonly score: number; readonly [k: string]: unknown }

export function searchEvidence(root: string, query: string, limit: number): Promise<Operation<Record<string, unknown>>> {
  return guarded<Record<string, unknown>>(async () => {
    const p = project(root);
    if (p.value === undefined) return p.outcome as Failure;
    const { truth } = p.value;
    const q = query.trim();
    const lower = q.toLowerCase();
    const has = (s: string | undefined) => s !== undefined && s.toLowerCase().includes(lower);
    const out: Candidate[] = [];
    const defs = [
      ...truth.requirements.map((d) => ({ kind: "requirement", id: d.id, text: d.title, location: d.location })),
      ...truth.decisions.map((d) => ({ kind: "decision", id: d.id, text: `${d.title} ${d.question} ${d.answer}`, location: d.location })),
      ...truth.constraints.map((d) => ({ kind: "constraint", id: d.id, text: d.statement, location: d.location })),
      ...truth.issues.map((d) => ({ kind: "issue", id: d.id, text: d.title, location: d.location })),
      ...truth.milestones.map((d) => ({ kind: "milestone", id: d.id, text: d.title, location: d.location })),
    ];
    for (const d of defs) {
      if (d.id === q) out.push({ source: "project-truth", kind: d.kind, id: d.id, match: "id", score: 100, location: d.location });
      else if (has(d.text)) out.push({ source: "project-truth", kind: d.kind, id: d.id, match: "text", score: 40, location: d.location });
    }
    await withGraphReader(root, async (graph) => {
      for (const type of ["file", "symbol", "test"] as EntityType[]) {
        let afterId: string | undefined;
        for (;;) {
          const page = graph.listNodes({ type, limit: 1000, ...(afterId === undefined ? {} : { afterId }) });
          for (const n of page) {
            const filePath = n.ref.type === "file" || n.ref.type === "symbol" || n.ref.type === "test" ? n.ref.path : undefined;
            const name = typeof n.payload.qualifiedName === "string" ? n.payload.qualifiedName : typeof n.payload.fullName === "string" ? n.payload.fullName : undefined;
            const base = { source: "graph", kind: n.type, id: n.id, ...(filePath === undefined ? {} : { path: filePath }), ...(n.source === undefined ? {} : { location: n.source }) };
            if (n.id === q) out.push({ ...base, match: "id", score: 100 });
            else if (n.type === "file" && filePath === q) out.push({ ...base, match: "path", score: 90 });
            else if (name === q) out.push({ ...base, match: "entity", score: 80 });
            else if (n.type === "file" && filePath !== undefined && filePath.startsWith(q)) out.push({ ...base, match: "path-prefix", score: 60 });
            else if (lower.length >= 3 && has(name)) out.push({ ...base, match: "text", score: 30 });
          }
          if (page.length < 1000) break;
          afterId = page[page.length - 1]?.id;
        }
      }
    });
    const dir = path.join(root, REVIEWS_DIR);
    const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^review-[0-9a-f]{16}\.json$/u.test(n)).sort(compareUtf8) : [];
    for (const name of names) {
      let record: { id?: string; claims?: { id: string; rule: string; subject: { id: string }; alignment: string; reason: string; provenance?: string }[] };
      try { record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { continue; }
      for (const c of record.claims ?? []) {
        if (c.subject.id === q || c.id === q) out.push({ source: "review-record", kind: "claim", id: c.id, record: record.id ?? name, rule: c.rule, subject: c.subject.id, alignment: c.alignment, match: "id", score: 70, ...(c.provenance === undefined ? {} : { provenance: c.provenance }) });
        else if (lower.length >= 3 && (has(c.reason) || has(c.subject.id))) out.push({ source: "review-record", kind: "claim", id: c.id, record: record.id ?? name, rule: c.rule, subject: c.subject.id, alignment: c.alignment, match: "text", score: 20 });
      }
    }
    const baseline = loadAdoptionBaseline(root).baseline;
    for (const f of baseline?.findings ?? []) {
      if (f.key === q || f.governing === q || f.offending === q) out.push({ source: "adoption-baseline", kind: "finding", id: f.key, rule: f.rule, governing: f.governing, offending: f.offending, match: "id", score: 70 });
      else if (lower.length >= 3 && has(f.offending)) out.push({ source: "adoption-baseline", kind: "finding", id: f.key, rule: f.rule, governing: f.governing, offending: f.offending, match: "text", score: 20 });
    }
    out.sort((a, b) => b.score - a.score || compareUtf8(a.source, b.source) || compareUtf8(a.id, b.id));
    return { kind: "ok", diagnostics: [], payload: { format: EVIDENCE_SEARCH_FORMAT, query: q, notice: SEARCH_NOTICE, truncated: out.length > limit, candidates: out.slice(0, limit) } };
  });
}
