// Canonical semantic projection of a DUO review result (duo.cli.review/1 → duo.review/1) for repeat comparison.
// Keeps every field that carries meaning (verdict and basis, each claim with its Decision, rule, provenance, blocking
// meaning, expected/observed text, and the full Evidence it cites: kind, basis, path, symbol, lines, change, content
// hash), plus gaps, limitations and the baseline reference. Claim, Evidence and gap IDs are kept (DUO derives them
// from content, so keeping them makes the comparison stricter). Drops only run-specific values: performance timings,
// metrics, meta and diagnostics. The raw files keep everything.
import crypto from "node:crypto";

const byJson = (a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);

export function canonicalReview(envelope) {
  const r = envelope.result;
  const evidence = new Map((r.evidence ?? []).map((e) => [e.id, e]));
  const ev = (id) => {
    const e = evidence.get(id);
    if (e === undefined) return { missing: id };
    const p = e.pointer ?? {};
    return { kind: e.kind, basis: e.basis, path: p.path ?? e.source?.path ?? null, symbol: p.symbol ?? e.entity?.symbol ?? null, id: e.entity?.id ?? null,
      evidenceId: e.id,
      lines: p.lines ?? null, change: p.change ?? null, commit: p.commit ?? null, contentHash: e.contentHash ?? p.contentHash ?? null };
  };
  const claims = (r.claims ?? []).map((c) => ({
    id: c.id, rule: c.rule, subject: c.subject, alignment: c.alignment, reason: c.reason, provenance: c.provenance ?? null,
    enforced: c.enforced, blockEligible: c.blockEligible, drift: c.drift, expected: c.expected, observed: c.observed,
    evidence: c.evidenceIds.map(ev).sort(byJson),
  })).sort(byJson);
  const g = r.gaps ?? {};
  return {
    format: r.format, status: r.status, verdict: r.verdict ?? null, verdictBasis: r.verdictBasis ?? null,
    baseline: r.baseline ?? null, diff: { from: r.diff?.from ?? null, to: r.diff?.to ?? null, files: (r.diff?.files ?? []).map((f) => ({ path: f.path, kind: f.kind })).sort(byJson) },
    claims,
    gaps: { status: g.status ?? null, requiresHumanInput: g.requiresHumanInput ?? null,
      items: (g.gaps ?? []).map((x) => ({ id: x.id, kind: x.kind, relevance: x.relevance, action: x.action, reasons: (x.reasons ?? []).map((y) => y.code).sort(),
        anchors: (x.anchors ?? []).map((a) => [a.type, a.path ?? "", a.symbol ?? a.id ?? ""].join(":")).sort() })).sort(byJson) },
    limitations: [...(r.limitations ?? [])].map((l) => (typeof l === "string" ? l : l.code ?? l.id ?? JSON.stringify(l))).sort(),
    semanticAssist: r.semanticAssist === undefined || r.semanticAssist === null ? null : "present",
  };
}

export const sha256 = (value) => "sha256:" + crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
