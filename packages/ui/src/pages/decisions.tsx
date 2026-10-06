/**
 * Pending human decisions (T18.1): the listDecisionProposals() read model as the server returns it.
 * Confirm and Reject are explicit human actions in a dialog (the ID typed again for confirm); the
 * result is read back from the server, never assumed (no optimistic state). Informed confirm (T34.2):
 * the dialog shows the candidate from DecisionService.previewConfirm (the same reading the CLI shows,
 * enforcement and forbids included) and the confirm carries that preview's digest.
 */
import { useRef, useState } from "react";
import { api, ApiError } from "../api.js";
import { Command, Empty, ErrorBox, Label, Loading, Loc, Page, Section, useApi } from "../components.js";
import { FORBIDS_SCOPE, hasForbids } from "../forbids.js";
import { entityPath, Link } from "../router.js";
import type { Diag, Preview, ProposalItem } from "../types.js";

interface ProposalsData { readonly proposals: readonly ProposalItem[]; readonly previews: Readonly<Record<string, Preview>> }
interface ActionResult { readonly status: string; readonly result?: { readonly decisionId?: string; readonly path?: string }; readonly diagnostics?: readonly Diag[]; readonly warnings?: readonly Diag[] }

export function DecisionsPage() {
  const [load, reload] = useApi<ProposalsData>("/api/proposals");
  const [message, setMessage] = useState<{ readonly text: string; readonly error: boolean } | undefined>();
  const done = (text: string, error = false) => { setMessage({ text, error }); reload(); };
  return (
    <Page title="Pending decisions" onRefresh={reload} durationMs={load.state === "ok" ? load.durationMs : undefined}>
      <p className="muted">AI may propose; only a human confirms or rejects. Actions here use the same DecisionService as <Command>duoctl decision</Command> with your Git user name as the actor label (not an authentication).</p>
      {message === undefined ? null : <p role={message.error ? "alert" : "status"} className={message.error ? "box box-error" : "box box-ok"}>{message.text}</p>}
      {load.state === "loading" ? <Loading /> : load.state === "error" ? <ErrorBox error={load.error} /> : <Body data={load.data} done={done} />}
    </Page>
  );
}

function Body(props: { readonly data: ProposalsData; readonly done: (text: string, error?: boolean) => void }) {
  const { proposals, previews } = props.data;
  if (proposals === undefined) return <Empty>Not a DUO project yet: run duoctl init.</Empty>;
  const of = (s: ProposalItem["status"]) => proposals.filter((p) => p.status === s);
  return (
    <>
      <Section title="Pending" count={of("pending").length}>
        {of("pending").length === 0 ? <Empty>No proposal is waiting for a human.</Empty> : of("pending").map((p) => <Pending key={p.id} p={p} preview={previews[p.id]} done={props.done} />)}
      </Section>
      <Section title="Committed (confirmed as Decisions)" count={of("committed").length} open={false}>
        {of("committed").length === 0 ? <Empty>None.</Empty> : <ul>{of("committed").map((p) => <li key={p.id}>{p.id} {p.title} → <Link to={entityPath(p.decisionId ?? "")}>{p.decisionId}</Link> <Label text="CONFIRMED" tone="ok" /></li>)}</ul>}
      </Section>
      <Section title="Rejected" count={of("rejected").length} open={false}>
        {of("rejected").length === 0 ? <Empty>None.</Empty> : <ul>{of("rejected").map((p) => <li key={p.id}>{p.id} {p.title} <Label text="REJECTED" tone="muted" />{p.reason === undefined ? null : <span className="muted"> · {p.reason}</span>}</li>)}</ul>}
      </Section>
    </>
  );
}

/** A field value as the file has it: absent → (not set), empty → (none). Nothing is defaulted. */
export function fieldText(value: unknown, nested = false): string {
  if (value === undefined || value === null) return "(not set)";
  if (Array.isArray(value)) return value.length === 0 ? "(none)" : value.map((v) => fieldText(v, true)).join(", ");
  if (typeof value === "object") {
    const parts = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0))
      .map(([k, v]) => `${k}: ${fieldText(v, true)}`);
    if (parts.length === 0) return "(none)";
    return nested ? `{${parts.join("; ")}}` : parts.join("; ");
  }
  return String(value);
}

function Content(props: { readonly p: ProposalItem; readonly preview: Preview | undefined }) {
  const { p, preview } = props;
  const c = preview?.candidate;
  return (
    <dl className="facts">
      <div><dt>Question</dt><dd><code>{p.question}</code></dd></div>
      <div><dt>Answer</dt><dd>{p.answer}</dd></div>
      {p.rationale === null ? null : <div><dt>Rationale</dt><dd>{p.rationale}</dd></div>}
      <div><dt>Governs</dt><dd>{[...p.governs.requirements, ...p.governs.paths, ...p.governs.symbols].join(", ") || "—"}</dd></div>
      {c === undefined ? null : <div><dt>Forbids</dt><dd>{fieldText(c.forbids)}</dd></div>}
      {c === undefined || !hasForbids(c.forbids) ? null : <div><dt>Forbids scope</dt><dd>{FORBIDS_SCOPE}</dd></div>}
      {c === undefined ? null : <div><dt>Enforcement</dt><dd>{fieldText(c.enforcement)}</dd></div>}
      <div><dt>Supersedes</dt><dd>{p.supersedes ?? "—"}</dd></div>
      <div><dt>Proposed by</dt><dd>{p.proposedBy}{p.proposedAt === null ? null : <span className="muted"> · {p.proposedAt}</span>}</dd></div>
      <div><dt>File</dt><dd><Loc location={p.location} /></dd></div>
    </dl>
  );
}

/**
 * Staleness is tracked for proposals only (based_on); for a YAML Decision it does not apply, which is
 * not the same as "checked and fresh" (T34.3, same meaning as the CLI).
 */
export function staleText(preview: Preview): string {
  if (preview.sourceKind === "decision") return "not applicable (staleness is tracked for proposals only)";
  if (preview.stale === undefined) return "no";
  return `yes, Project Truth changed since this proposal was made${preview.stale.changedRefs.length > 0 ? ` (changed: ${preview.stale.changedRefs.join(", ")})` : ""}`;
}

/** The proposer the proposal file records (H-71), as the CLI shows it: "codex (agent)". */
export function proposerText(preview: Preview): string {
  if (preview.proposedBy === undefined) return "(not set)";
  return preview.proposedByKind === undefined ? preview.proposedBy : `${preview.proposedBy} (${preview.proposedByKind})`;
}

/** The candidate a confirm acts on (previewConfirm), every content field shown, absent ones as (not set). */
export function Candidate(props: { readonly preview: Preview }) {
  const c = props.preview.candidate ?? {};
  const rows: [string, unknown][] = [["Title", c.title], ["Question", c.question], ["Answer", c.answer], ["Kind", c.kind], ["Rationale", c.rationale],
    ["Governs", c.governs], ["Forbids", c.forbids], ...(hasForbids(c.forbids) ? [["Forbids scope", FORBIDS_SCOPE] as [string, unknown]] : []),
    ["Enforcement", c.enforcement], ["Supersedes", c.supersedes]];
  for (const k of ["evidence", "source", "extensions"] as const) if (c[k] !== undefined) rows.push([k[0]?.toUpperCase() + k.slice(1), c[k]]);
  return (
    <dl className="facts">
      {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{fieldText(value)}</dd></div>)}
      {props.preview.sourceKind !== "proposal" ? null : <div><dt>Proposed by</dt><dd>{proposerText(props.preview)} <span className="muted">(audit label, not an authenticated identity)</span></dd></div>}
      <div><dt>Stale</dt><dd>{staleText(props.preview)}</dd></div>
      <div><dt>Expected Decision ID</dt><dd>{props.preview.expectedDecisionId ?? "—"} <span className="muted">(expected; the confirm result is authoritative)</span></dd></div>
    </dl>
  );
}

function Pending(props: { readonly p: ProposalItem; readonly preview: Preview | undefined; readonly done: (text: string, error?: boolean) => void }) {
  const { p, preview } = props;
  const confirmRef = useRef<HTMLDialogElement>(null);
  const rejectRef = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (kind: "confirm" | "reject") => {
    setBusy(true);
    try {
      const body = kind === "confirm" ? { confirmId: typed, previewDigest: preview?.digest ?? "" } : reason.trim() === "" ? {} : { reason: reason.trim() };
      const r = (await api.post<ActionResult>(`/api/proposals/${encodeURIComponent(p.id)}/${kind}`, body)).data;
      if (r.status === "failed") props.done(`${p.id}: ${(r.diagnostics ?? []).map((d) => `${d.code} ${d.message}`).join("; ")}`, true);
      else if (kind === "confirm") props.done(`${p.id} confirmed as ${r.result?.decisionId ?? "?"} (${r.result?.path ?? ""}). Run duoctl index so the graph shows it.${(r.warnings ?? []).length > 0 ? ` Warnings: ${(r.warnings ?? []).map((w) => w.code).join(", ")}` : ""}`);
      else props.done(`${p.id} rejected.`);
    } catch (error) {
      props.done(error instanceof ApiError ? `${error.code}: ${error.message}` : String(error), true);
    } finally {
      setBusy(false);
      confirmRef.current?.close();
      rejectRef.current?.close();
    }
  };
  return (
    <article className="card" aria-labelledby={`p-${p.id}`}>
      <h3 id={`p-${p.id}`}>{p.id} <Label text="PROPOSED · pending" tone="info" /> {p.title}</h3>
      <Content p={p} preview={preview} />
      <div className="actions">
        <button type="button" onClick={() => { setTyped(""); confirmRef.current?.showModal(); }}>Confirm…</button>
        <button type="button" className="secondary" onClick={() => { setReason(""); rejectRef.current?.showModal(); }}>Reject…</button>
      </div>
      <dialog ref={confirmRef} aria-labelledby={`c-${p.id}`}>
        <form method="dialog" onSubmit={(e) => { e.preventDefault(); if (typed.trim() === p.id) void run("confirm"); }}>
          <h2 id={`c-${p.id}`}>Confirm {p.id}?</h2>
          <p>Confirming makes this proposal a <strong>confirmed Decision</strong> in Project Truth with exactly the contents below. If they change before you confirm, nothing is confirmed and you review them again.</p>
          {preview?.candidate === undefined ? <Content p={p} preview={preview} /> : <Candidate preview={preview} />}
          {preview?.stale === undefined ? null : (
            <p role="alert" className="box box-warn">Stale: Project Truth changed since this proposal was made{preview.stale.changedRefs.length > 0 ? ` (changed: ${preview.stale.changedRefs.join(", ")})` : ""}. Check it before confirming.</p>
          )}
          {preview?.supersedes === undefined ? null : (
            <p className="box box-warn">It supersedes <strong>{preview.supersedes.id}</strong> “{preview.supersedes.title}” ({preview.supersedes.state}), which becomes SUPERSEDED.</p>
          )}
          {preview?.error === undefined ? null : <p role="alert" className="box box-error">Cannot preview: {preview.error.join(", ")}</p>}
          <label>Type <code>{p.id}</code> to confirm <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus aria-describedby={`c-${p.id}`} /></label>
          <div className="actions">
            <button type="submit" disabled={busy || typed.trim() !== p.id || preview?.digest === undefined}>Confirm {p.id}</button>
            <button type="button" className="secondary" onClick={() => confirmRef.current?.close()}>Cancel</button>
          </div>
        </form>
      </dialog>
      <dialog ref={rejectRef} aria-labelledby={`r-${p.id}`}>
        <form method="dialog" onSubmit={(e) => { e.preventDefault(); void run("reject"); }}>
          <h2 id={`r-${p.id}`}>Reject {p.id}?</h2>
          <p>The proposal stays as a rejected record; it never becomes a Decision.</p>
          <label>Reason (optional) <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} rows={3} /></label>
          <div className="actions">
            <button type="submit" disabled={busy}>Reject {p.id}</button>
            <button type="button" className="secondary" onClick={() => rejectRef.current?.close()}>Cancel</button>
          </div>
        </form>
      </dialog>
    </article>
  );
}
