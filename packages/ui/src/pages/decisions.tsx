/**
 * Pending human decisions (T18.1): the listDecisionProposals() read model as the server returns it.
 * Confirm and Reject are explicit human actions in a dialog (the ID typed again for confirm); the
 * result is read back from the server, never assumed (no optimistic state). Informed confirm (T34.2):
 * the dialog shows the candidate from DecisionService.previewConfirm (the same reading the CLI shows,
 * enforcement and forbids included) and the confirm carries that preview's digest.
 */
import { message, t } from "../i18n.js";
import { Trans } from "react-i18next";
import { useRef, useState } from "react";
import { api, ApiError } from "../api.js";
import { Command, Empty, ErrorBox, Label, Loading, Loc, Page, Section, useApi } from "../components.js";
import { forbidsScope, hasForbids } from "../forbids.js";
import { entityPath, Link } from "../router.js";
import type { Diag, Preview, ProposalItem } from "../types.js";

interface ProposalsData { readonly proposals: readonly ProposalItem[]; readonly previews: Readonly<Record<string, Preview>> }
interface ActionResult { readonly status: string; readonly result?: { readonly decisionId?: string; readonly path?: string }; readonly diagnostics?: readonly Diag[]; readonly warnings?: readonly Diag[] }

export function DecisionsPage() {
  const [load, reload] = useApi<ProposalsData>("/api/proposals");
  const [message, setMessage] = useState<{ readonly text: string; readonly error: boolean } | undefined>();
  const done = (text: string, error = false) => { setMessage({ text, error }); reload(); };
  return (
    <Page title={t("decisions.pending_decisions")} onRefresh={reload} durationMs={load.state === "ok" ? load.durationMs : undefined}>
      <p className="muted"><Trans i18nKey="decisions.ai_may_propose_only_a_human_confirms" components={{ c0: <Command children="" /> }} /></p>
      {message === undefined ? null : <p role={message.error ? "alert" : "status"} className={message.error ? "box box-error" : "box box-ok"}>{message.text}</p>}
      {load.state === "loading" ? <Loading /> : load.state === "error" ? <ErrorBox error={load.error} /> : <Body data={load.data} done={done} />}
    </Page>
  );
}

function Body(props: { readonly data: ProposalsData; readonly done: (text: string, error?: boolean) => void }) {
  const { proposals, previews } = props.data;
  if (proposals === undefined) return <Empty>{t("decisions.not_a_duo_project_yet_run_duoctl")}</Empty>;
  const of = (s: ProposalItem["status"]) => proposals.filter((p) => p.status === s);
  return (
    <>
      <Section title={t("decisions.pending")} count={of("pending").length}>
        {of("pending").length === 0 ? <Empty>{t("decisions.no_proposal_is_waiting_for_a_human")}</Empty> : of("pending").map((p) => <Pending key={p.id} p={p} preview={previews[p.id]} done={props.done} />)}
      </Section>
      <Section title={t("decisions.committed_confirmed_as_decisions")} count={of("committed").length} open={false}>
        {of("committed").length === 0 ? <Empty>{t("decisions.none")}</Empty> : <ul>{of("committed").map((p) => <li key={p.id}>{p.id} {p.title} → <Link to={entityPath(p.decisionId ?? "")}>{p.decisionId}</Link> <Label text="CONFIRMED" tone="ok" /></li>)}</ul>}
      </Section>
      <Section title={t("decisions.rejected")} count={of("rejected").length} open={false}>
        {of("rejected").length === 0 ? <Empty>{t("decisions.none")}</Empty> : <ul>{of("rejected").map((p) => <li key={p.id}>{p.id} {p.title} <Label text="REJECTED" tone="muted" />{p.reason === undefined ? null : <span className="muted"> · {p.reason}</span>}</li>)}</ul>}
      </Section>
    </>
  );
}

/** A field value as the file has it: absent → (not set), empty → (none). Nothing is defaulted. */
export function fieldText(value: unknown, nested = false): string {
  if (value === undefined || value === null) return t("text.(not set)");
  if (Array.isArray(value)) return value.length === 0 ? t("text.(none)") : value.map((v) => fieldText(v, true)).join(", ");
  if (typeof value === "object") {
    const parts = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0))
      .map(([k, v]) => `${k}: ${fieldText(v, true)}`);
    if (parts.length === 0) return t("text.(none)");
    return nested ? `{${parts.join("; ")}}` : parts.join("; ");
  }
  return String(value);
}

function Content(props: { readonly p: ProposalItem; readonly preview: Preview | undefined }) {
  const { p, preview } = props;
  const c = preview?.candidate;
  return (
    <dl className="facts">
      <div><dt>{t("decisions.question")}</dt><dd><code>{p.question}</code></dd></div>
      <div><dt>{t("decisions.answer")}</dt><dd>{p.answer}</dd></div>
      {p.rationale === null ? null : <div><dt>{t("decisions.rationale")}</dt><dd>{p.rationale}</dd></div>}
      <div><dt>{t("decisions.governs")}</dt><dd>{[...p.governs.requirements, ...p.governs.paths, ...p.governs.symbols].join(", ") || "—"}</dd></div>
      {c === undefined ? null : <div><dt>{t("decisions.forbids")}</dt><dd>{fieldText(c.forbids)}</dd></div>}
      {c === undefined || !hasForbids(c.forbids) ? null : <div><dt>{t("decisions.forbids_scope")}</dt><dd>{message(forbidsScope(c.forbids))}</dd></div>}
      {c === undefined ? null : <div><dt>{t("decisions.enforcement")}</dt><dd>{fieldText(c.enforcement)}</dd></div>}
      <div><dt>{t("decisions.supersedes")}</dt><dd>{p.supersedes ?? "—"}</dd></div>
      <div><dt>{t("decisions.proposed_by")}</dt><dd>{p.proposedBy}{p.proposedAt === null ? null : <span className="muted"> · {p.proposedAt}</span>}</dd></div>
      <div><dt>{t("decisions.file")}</dt><dd><Loc location={p.location} /></dd></div>
    </dl>
  );
}

/**
 * Staleness is tracked for proposals only (based_on); for a YAML Decision it does not apply, which is
 * not the same as "checked and fresh" (T34.3, same meaning as the CLI).
 */
export function staleText(preview: Preview): string {
  if (preview.sourceKind === "decision") return t("text.not applicable (staleness is tracked for proposals only)");
  if (preview.stale === undefined) return t("text.no");
  return t("decisions.stale_yes", { changes: preview.stale.changedRefs.length > 0 ? t("decisions.changed_refs", { refs: preview.stale.changedRefs.join(", ") }) : "" });
}

/** The proposer the proposal file records (H-71), as the CLI shows it: "codex (agent)". */
export function proposerText(preview: Preview): string {
  if (preview.proposedBy === undefined) return t("text.(not set)");
  return preview.proposedByKind === undefined ? preview.proposedBy : `${preview.proposedBy} (${preview.proposedByKind})`;
}

/** The candidate a confirm acts on (previewConfirm), every content field shown, absent ones as (not set). */
export function Candidate(props: { readonly preview: Preview }) {
  const c = props.preview.candidate ?? {};
  const rows: [string, unknown][] = [[t("text.Title"), c.title], [t("text.Question"), c.question], [t("text.Answer"), c.answer], [t("text.Kind"), c.kind], [t("text.Rationale"), c.rationale],
    [t("text.Governs"), c.governs], [t("text.Forbids"), c.forbids], ...(hasForbids(c.forbids) ? [[t("text.Forbids scope"), message(forbidsScope(c.forbids))] as [string, unknown]] : []),
    [t("text.Enforcement"), c.enforcement], [t("text.Supersedes"), c.supersedes]];
  for (const k of ["evidence", "source", "extensions"] as const) if (c[k] !== undefined) rows.push([message(k[0]?.toUpperCase() + k.slice(1)), c[k]]);
  return (
    <dl className="facts">
      {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{fieldText(value)}</dd></div>)}
      {props.preview.sourceKind !== "proposal" ? null : <div><dt>{t("decisions.proposed_by")}</dt><dd>{proposerText(props.preview)} <span className="muted">{t("decisions.audit_label_not_an_authenticated_identity")}</span></dd></div>}
      <div><dt>{t("decisions.stale")}</dt><dd>{staleText(props.preview)}</dd></div>
      <div><dt>{t("decisions.expected_decision_id")}</dt><dd>{props.preview.expectedDecisionId ?? "—"} <span className="muted">{t("decisions.expected_the_confirm_result_is_authoritative")}</span></dd></div>
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
      else if (kind === "confirm") props.done(t("decisions.confirmed_result", { id: p.id, decisionId: r.result?.decisionId ?? "?", path: r.result?.path ?? "", warnings: (r.warnings ?? []).length > 0 ? t("decisions.warnings", { codes: (r.warnings ?? []).map((w) => w.code).join(", ") }) : "" }));
      else props.done(t("decisions.rejected_result", { id: p.id }));
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
        <button type="button" onClick={() => { setTyped(""); confirmRef.current?.showModal(); }}>{t("decisions.confirm")}</button>
        <button type="button" className="secondary" onClick={() => { setReason(""); rejectRef.current?.showModal(); }}>{t("decisions.reject")}</button>
      </div>
      <dialog ref={confirmRef} aria-labelledby={`c-${p.id}`}>
        <form method="dialog" onSubmit={(e) => { e.preventDefault(); if (typed.trim() === p.id) void run("confirm"); }}>
          <h2 id={`c-${p.id}`}><Trans i18nKey="decisions.confirm_2" components={{ v0: <>{p.id}</> }} /></h2>
          <p><Trans i18nKey="decisions.confirming_makes_this_proposal_a_confirmed_decision" components={{ c0: <strong /> }} /></p>
          {preview?.candidate === undefined ? <Content p={p} preview={preview} /> : <Candidate preview={preview} />}
          {preview?.stale === undefined ? null : (
            <p role="alert" className="box box-warn"><Trans i18nKey="decisions.stale_project_truth_changed_since_this_proposal" components={{ v0: <>{preview.stale.changedRefs.length > 0 ? t("decisions.changed_refs", { refs: preview.stale.changedRefs.join(", ") }) : ""}</> }} /></p>
          )}
          {preview?.supersedes === undefined ? null : (
            <p className="box box-warn"><Trans i18nKey="decisions.it_supersedes_which_becomes_superseded" components={{ c0: <strong />, v1: <>{preview.supersedes.id}</>, v2: <>{preview.supersedes.title}</>, v3: <>{preview.supersedes.state}</> }} /></p>
          )}
          {preview?.error === undefined ? null : <p role="alert" className="box box-error"><Trans i18nKey="decisions.cannot_preview" components={{ v0: <>{preview.error.join(", ")}</> }} /></p>}
          <label><Trans i18nKey="decisions.type_to_confirm" components={{ c0: <code />, v1: <>{p.id}</>, c2: <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus aria-describedby={`c-${p.id}`} /> }} /></label>
          <div className="actions">
            <button type="submit" disabled={busy || typed.trim() !== p.id || preview?.digest === undefined}><Trans i18nKey="decisions.confirm_3" components={{ v0: <>{p.id}</> }} /></button>
            <button type="button" className="secondary" onClick={() => confirmRef.current?.close()}>{t("decisions.cancel")}</button>
          </div>
        </form>
      </dialog>
      <dialog ref={rejectRef} aria-labelledby={`r-${p.id}`}>
        <form method="dialog" onSubmit={(e) => { e.preventDefault(); void run("reject"); }}>
          <h2 id={`r-${p.id}`}><Trans i18nKey="decisions.reject_2" components={{ v0: <>{p.id}</> }} /></h2>
          <p>{t("decisions.the_proposal_stays_as_a_rejected_record")}</p>
          <label>{t("form.reason_optional")} <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} rows={3} /></label>
          <div className="actions">
            <button type="submit" disabled={busy}><Trans i18nKey="decisions.reject_3" components={{ v0: <>{p.id}</> }} /></button>
            <button type="button" className="secondary" onClick={() => rejectRef.current?.close()}>{t("decisions.cancel")}</button>
          </div>
        </form>
      </dialog>
    </article>
  );
}
