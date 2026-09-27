/**
 * R-DRIFT for External Sources (T13.1, ADR-007, ADR-014). A confirmed Truth item that cites
 * { path, hash, section? } is checked against the document on the reviewed side of the diff. The
 * check is deterministic: the recorded hash against the hash of the canonical text (whole file or
 * heading section). A different hash, or a section that is gone, is PARTIAL drift (non-blocking);
 * DUO never edits the Truth item. Only items in the Review context, items whose Truth file changed
 * and items whose source document changed are checked.
 *
 * A source the current evidence providers cannot read (a URL, Jira, GitHub, Linear, a path outside
 * the repository, a secret file, a missing file) is never guessed at: it becomes an
 * external-source-unavailable limitation. A future adapter can feed the same rule.
 */
import { isSecretFileName } from "@duo-director/analyzer";
import {
  compareSourceHash, compareUtf8, externalSourceSlice, isRemoteSourcePath, normalizeRepoPath, type SourceLocation, type SourceRef,
} from "@duo-director/core";
import { documentEvidence } from "../evidence/sources.js";
import { decisionEvidence, isActive, makeClaim, requirementEvidence, type RuleContext } from "./claims.js";
import { sideText } from "./rules.js";
import type { ReviewClaim, ReviewLimitation } from "./types.js";

type External = Extract<SourceRef, { kind: "external" }>;

interface SourcedItem {
  readonly subject: { readonly kind: string; readonly id: string };
  readonly location: SourceLocation;
  readonly sources: readonly External[];
  readonly truth: () => string | undefined;
}

const externals = (sources: readonly SourceRef[]) => sources.filter((s): s is External => s.kind === "external");

function sourcedItems(ctx: RuleContext): SourcedItem[] {
  const items: SourcedItem[] = [];
  for (const r of ctx.truth.requirements) items.push({ subject: { kind: "requirement", id: r.id }, location: r.location, sources: externals(r.sources), truth: () => requirementEvidence(ctx, r.id) });
  for (const d of ctx.truth.decisions.filter(isActive)) items.push({ subject: { kind: "decision", id: d.id }, location: d.location, sources: externals(d.sources), truth: () => decisionEvidence(ctx, d.id) });
  for (const c of ctx.truth.constraints.filter((x) => x.state === "confirmed")) items.push({ subject: { kind: "constraint", id: c.id }, location: c.location, sources: externals(c.sources), truth: () => decisionEvidence(ctx, c.id) });
  const v = ctx.truth.vision;
  if (v !== undefined && v.status === "confirmed") {
    items.push({ subject: { kind: "vision", id: v.location.path }, location: v.location, sources: externals(v.sources), truth: () => {
      const text = ctx.reader.text(v.location.path).value;
      return text === undefined ? undefined : documentEvidence(ctx.store, { basis: "project-truth", path: v.location.path, text });
    } });
  }
  return items.filter((i) => i.sources.length > 0);
}

export interface DriftResult {
  readonly claims: ReviewClaim[];
  readonly limitations: ReviewLimitation[];
}

export async function externalSourceDrift(ctx: RuleContext): Promise<DriftResult> {
  const changed = new Set<string>(ctx.files.flatMap((f) => (f.oldPath === undefined ? [f.path] : [f.path, f.oldPath])));
  const packet = ctx.reviewPacket;
  const inContext = new Set((packet === undefined ? [] : [...packet.intent.requirements, ...packet.intent.constraints, ...packet.decisions.active]).map((i) => i.ref));
  const claims: ReviewClaim[] = [];
  const unavailable = new Set<string>();
  const invalid = new Set<string>();
  for (const item of sourcedItems(ctx)) {
    const relevant = inContext.has(item.subject.id) || changed.has(item.location.path) || item.sources.some((s) => changed.has(s.path));
    if (!relevant) continue;
    for (const src of item.sources) {
      const repoPath = isRemoteSourcePath(src.path) ? undefined : normalizeRepoPath(src.path).value;
      const text = repoPath === undefined || isSecretFileName(repoPath) ? undefined : await sideText(ctx, ctx.to, repoPath);
      if (repoPath === undefined || text === undefined) { unavailable.add(item.subject.id); continue; }
      const slice = externalSourceSlice(repoPath, text, src.section);
      if (slice.status === "section-unsupported") { unavailable.add(item.subject.id); continue; }
      const file = ctx.files.find((f) => f.path === repoPath);
      const key = `${repoPath}#${src.section ?? ""}`;
      const where = `${repoPath}${src.section === undefined ? "" : ` § ${src.section}`}`;
      if (slice.status === "section-missing") {
        const c = makeClaim(ctx, {
          rule: "external-source-drift", subject: item.subject, key, alignment: "PARTIAL", reason: "external-section-missing",
          expected: `${where} still exists as confirmed for ${item.subject.id}`, observed: `section "${src.section ?? ""}" not found in ${repoPath}`,
          evidence: [item.truth(), documentEvidence(ctx.store, { basis: "repository", path: repoPath, text, commit: ctx.toLabel }), ...(file?.evidenceIds ?? [])],
        });
        if (c !== undefined) claims.push(c);
        continue;
      }
      const compared = compareSourceHash(src.hash, slice.hash);
      if (compared === "invalid") { invalid.add(item.subject.id); continue; }
      if (compared === "match" && file === undefined) continue;
      const evidence = documentEvidence(ctx.store, { basis: "repository", path: repoPath, text: slice.text, location: slice.location, commit: ctx.toLabel, ...(src.section === undefined ? {} : { section: src.section }) });
      const c = makeClaim(ctx, {
        rule: "external-source-drift", subject: item.subject, key, alignment: compared === "match" ? "ALIGNED" : "PARTIAL",
        reason: compared === "match" ? "external-source-unchanged" : "external-source-changed",
        expected: `${where} has hash ${src.hash} as confirmed for ${item.subject.id}`,
        observed: compared === "match" ? `${where} is unchanged` : `${where} now has hash ${slice.hash} (the confirmed Truth is not changed; a human decides)`,
        evidence: [item.truth(), evidence, ...(file?.evidenceIds ?? [])],
      });
      if (c !== undefined) claims.push(c);
    }
  }
  const limitations: ReviewLimitation[] = [];
  if (unavailable.size > 0) {
    limitations.push({ code: "external-source-unavailable", message: `External sources of ${[...unavailable].sort(compareUtf8).join(", ")} cannot be read by the current evidence providers (remote, outside the repository, secret or missing); no drift is inferred for them.` });
  }
  if (invalid.size > 0) {
    limitations.push({ code: "external-source-hash-invalid", message: `The recorded source hash of ${[...invalid].sort(compareUtf8).join(", ")} is not a sha256 value (at least 7 hex digits); drift is not checked.` });
  }
  return { claims, limitations };
}
