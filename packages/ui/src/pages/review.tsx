/** Review screen (T18.1): the Review service as it is. Never indexes, never records. */
import { message, t } from "../i18n.js";
import { Trans } from "react-i18next";
import { useState } from "react";
import { api } from "../api.js";
import { Command, Empty, ErrorBox, Label, Page, Provenance, Section, TableScroll, Verdict } from "../components.js";
import { authorityParts } from "../authority.js";
import { GapList } from "./context.js";
import { EvidenceList } from "./evidence.js";
import type { Claim, Evidence, ReviewResult, SemanticAssist } from "../types.js";

export const PASS_MEANING = "PASS means no Project Direction violation was found in the available evidence. It does not mean the tests pass or the code is bug-free.";

export function ClaimTable(props: { readonly claims: readonly Claim[]; readonly evidence: readonly Evidence[] }) {
  const [open, setOpen] = useState<string | undefined>();
  if (props.claims.length === 0) return <Empty>{t("review.no_claims")}</Empty>;
  return (
    <TableScroll label="Review claims"><table>
      <thead><tr><th scope="col">{t("review.alignment")}</th><th scope="col">{t("review.rule")}</th><th scope="col">{t("review.subject")}</th><th scope="col">{t("review.reason")}</th><th scope="col">{t("review.provenance")}</th><th scope="col">{t("review.evidence")}</th></tr></thead>
      <tbody>{props.claims.map((c) => (
        <tr key={c.id}>
          <td><Label text={c.alignment} tone={c.alignment === "ALIGNED" ? "ok" : c.alignment === "CONFLICT" ? (c.blockEligible ? "block" : "warn") : "info"} />{c.blockEligible ? <Label text="blocking" tone="block" /> : null}{c.drift ? <Label text="drift" tone="warn" /> : null}{c.informational === true ? <Label text="information" tone="info" /> : null}</td>
          <td>{c.rule}</td><td><code>{c.subject.id}</code>{c.decisionAuthority === undefined ? null : <div className="muted small">{authorityParts(c.decisionAuthority).join(" · ")}</div>}</td>
          <td>{c.reason}{c.observed === undefined ? null : <div className="muted small">{c.observed}</div>}</td>
          <td><Provenance value={c.provenance} /></td>
          <td>
            <button type="button" className="link" aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? undefined : c.id)}><Trans i18nKey="review.item_s" components={{ v0: <>{String((c.evidenceIds.length) ?? "")}</> }} /></button>
            {open === c.id ? <EvidenceList ids={c.evidenceIds} evidence={props.evidence} /> : null}
          </td>
        </tr>
      ))}</tbody>
    </table></TableScroll>
  );
}

export function SemanticSection(props: { readonly a: SemanticAssist; readonly evidence: readonly Evidence[] }) {
  const { a } = props;
  if (a.status === "not-requested") return null;
  return (
    <Section title={t("review.semantic_assistance_supplemental_never_blocks")}>
      <p><Label text={a.status} tone={a.status === "success" ? "ok" : "muted"} />{a.failure === undefined ? null : <span className="muted"> · {a.failure}</span>}{a.provider === undefined ? null : <span className="muted"> · {a.provider.id} {a.provider.model ?? ""}</span>}{a.cacheHits > 0 ? <span className="muted">{t("review.cached")}</span> : null}</p>
      <p className="muted small">{t("review.llm_answers_are_kept_apart_from_the")}</p>
      {a.claims.length === 0 ? null : <ul>{a.claims.map((c) => <li key={c.claimId}><Label text={c.alignment} tone="info" /> <code>{c.claimId}</code> {c.reason ?? ""}</li>)}</ul>}
      {a.verdict === undefined ? null : <p><Trans i18nKey="review.with_semantic_assistance" components={{ c0: <Verdict verdict={a.verdict} /> }} /></p>}
    </Section>
  );
}

export function ReviewView(props: { readonly r: ReviewResult }) {
  const { r } = props;
  if (r.status === "index-required") {
    return <p role="status" className="box box-warn"><Trans i18nKey="review.the_index_is_run_duoctl_index_then" components={{ c0: <Label text="index-required" tone="warn" />, v1: <>{r.freshness?.status ?? t("text.not current")}</>, c2: <Command children="" /> }} /></p>;
  }
  if (r.status === "failed") {
    // T40 (N1): a review DUO could not run, e.g. Project Truth it could read only in part. No verdict is shown.
    return (
      <div role="alert" className="box box-error">
        <strong>{t("review.review_not_run_no_verdict")}</strong>
        <ul>{(r.diagnostics ?? []).map((d, i) => <li key={i}><code>{d.code}</code> {d.message}</li>)}</ul>
      </div>
    );
  }
  if (r.status !== "ready") return <p role="alert" className="box box-error">{r.status}</p>;
  const bootstrap = r.diff?.files.filter((f) => f.provenance === "adoption-bootstrap") ?? [];
  return (
    <div aria-live="polite">
      <h2 className="verdict-line"><Trans i18nKey="review.deterministic_review" components={{ c0: <Verdict verdict={r.verdict} /> }} /></h2>
      {r.verdict === "PASS" ? <p className="muted">{message(PASS_MEANING)}</p> : null}
      <p className="muted small"><Trans i18nKey="review.diff_files_baseline_llm_calls" components={{ v0: <>{r.diff?.from}</>, v1: <>{r.diff?.to}</>, v2: <>{String(r.diff?.files.length ?? 0)}</>, v3: <>{r.baseline.status}</>, v4: <>{String((r.metrics.llmCalls) ?? "")}</> }} /></p>
      {bootstrap.length === 0 ? null : <p><Trans i18nKey="review.truth_file_s_exactly_as_init_wrote" components={{ c0: <Provenance value="adoption-bootstrap" />, v1: <>{String((bootstrap.length) ?? "")}</> }} /></p>}
      <Section title={t("review.claims")} count={r.claims.length}><ClaimTable claims={r.claims} evidence={r.evidence} /></Section>
      <Section title={t("review.knowledge_gaps")} count={r.gaps?.gaps.filter((g) => g.action !== "ignore").length ?? 0}>{r.gaps === undefined ? <Empty>{t("review.not_assessed")}</Empty> : <GapList gaps={r.gaps.gaps} />}</Section>
      <Section title={t("review.limitations")} count={r.limitations.length} open={false}><ul>{r.limitations.map((l) => <li key={l.code}><code>{l.code}</code> {l.message}</li>)}</ul></Section>
      <SemanticSection a={r.semanticAssist} evidence={r.evidence} />
      <p className="muted small"><Trans i18nKey="review.this_review_is_not_recorded_to_keep" components={{ c0: <Command children="" /> }} /></p>
    </div>
  );
}

export function ReviewPage() {
  const [task, setTask] = useState("");
  const [from, setFrom] = useState("HEAD");
  const [to, setTo] = useState("WORKTREE");
  const [semantic, setSemantic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ readonly r: ReviewResult; readonly ms?: number } | Error | undefined>();
  const run = async () => {
    setBusy(true);
    try {
      const e = await api.post<ReviewResult>("/api/review", { from, to, ...(task.trim() === "" ? {} : { task }), ...(semantic ? { includeSemanticAssist: true } : {}) });
      setResult({ r: e.data, ...(e.meta === undefined ? {} : { ms: e.meta.durationMs }) });
    } catch (error) {
      setResult(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page title={t("review.review")} durationMs={result !== undefined && !(result instanceof Error) ? result.ms : undefined}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <label>{t("form.from")} <input value={from} onChange={(e) => setFrom(e.target.value)} size={12} /></label>
        <label>{t("form.to")} <input value={to} onChange={(e) => setTo(e.target.value)} size={12} /></label>
        <label>{t("form.task_optional")} <input value={task} onChange={(e) => setTask(e.target.value)} size={30} /></label>
        <label className="check"><Trans i18nKey="review.use_semantic_assistance" components={{ c0: <input type="checkbox" checked={semantic} onChange={(e) => setSemantic(e.target.checked)} /> }} /></label>
        <button type="submit" disabled={busy}>{busy ? t("text.Reviewing…") : t("text.Review changes")}</button>
      </form>
      {semantic ? <p className="box box-warn small">{t("review.selected_evidence_slices_will_be_sent_to")}</p> : null}
      {result === undefined ? null : result instanceof Error ? <ErrorBox error={result} /> : <ReviewView r={result.r} />}
    </Page>
  );
}
