/** Context Inspector (T18.1): the Context Compiler through the shared operation. Never indexes. */
import { t } from "../i18n.js";
import { Trans } from "react-i18next";
import { useState } from "react";
import { api } from "../api.js";
import { Command, Empty, ErrorBox, Label, Page, Section } from "../components.js";
import { entityPath, Link } from "../router.js";
import type { ContextData, Gap, PacketItem } from "../types.js";

function Items(props: { readonly items: readonly PacketItem[] }) {
  if (props.items.length === 0) return <Empty>{t("context.none")}</Empty>;
  return (
    <ol className="packet-items">{props.items.map((i) => (
      <li key={i.id}><div><Link to={entityPath(i.ref)}>{i.ref}</Link> <span className="muted"><Trans i18nKey="context.rank_tokens" components={{ v0: <>{String((i.rank) ?? "")}</>, v1: <>{i.level}</>, v2: <>{String((i.tokens) ?? "")}</> }} /></span></div><pre className="slice">{i.text}</pre></li>
    ))}</ol>
  );
}

export function GapList(props: { readonly gaps: readonly Gap[] }) {
  const shown = props.gaps.filter((g) => g.action !== "ignore");
  const ignored = props.gaps.length - shown.length;
  return (
    <>
      {shown.length === 0 ? <Empty>{t("context.no_gap_needs_attention")}</Empty> : (
        <ul>{shown.map((g) => <li key={g.id}><Label text={g.action.toUpperCase()} tone={g.action === "ask" ? "warn" : "info"} /> {g.kind} <span className="muted">({g.relevance})</span>{g.text === undefined ? null : <> — {g.text}</>}</li>)}</ul>
      )}
      {ignored === 0 ? null : <p className="muted small"><Trans i18nKey="context.gap_s_judged_not_relevant_ignore_are" components={{ v0: <>{String((ignored) ?? "")}</> }} /></p>}
    </>
  );
}

export function ContextPage() {
  const [task, setTask] = useState("");
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ readonly data: ContextData; readonly ms?: number } | Error | undefined>();
  const compile = async () => {
    setBusy(true);
    try {
      const r = await api.post<ContextData>("/api/context", { task, ...(budget.trim() === "" ? {} : { budget: Number(budget) }) });
      setResult({ data: r.data, ...(r.meta === undefined ? {} : { ms: r.meta.durationMs }) });
    } catch (error) {
      setResult(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page title={t("context.context_inspector")} durationMs={result !== undefined && !(result instanceof Error) ? result.ms : undefined}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (task.trim() !== "") void compile(); }}>
        <label>{t("form.task")} <textarea value={task} onChange={(e) => setTask(e.target.value)} rows={2} placeholder={t("text.AUTH-03, a symbol, a path or a sentence")} /></label>
        <label>{t("form.budget")} <input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="numeric" size={8} /></label>
        <button type="submit" disabled={busy || task.trim() === ""}>{busy ? t("text.Compiling…") : t("text.Compile context")}</button>
      </form>
      {result === undefined ? null : result instanceof Error ? <ErrorBox error={result} /> : <ContextResultView data={result.data} />}
    </Page>
  );
}

export function ContextResultView(props: { readonly data: ContextData }) {
  const { data } = props;
  if (data.status === "index-required") {
    return <p role="status" className="box box-warn"><Trans i18nKey="context.the_index_is_not_current_run_duoctl" components={{ c0: <Label text="index-required" tone="warn" />, c1: <Command children="" /> }} /></p>;
  }
  if (data.status === "not-initialized" || data.status === "failed") return <p role="alert" className="box box-error">{data.status}: {(data.diagnostics ?? []).map((d) => d.message).join("; ")}</p>;
  const c = data.context;
  const p = c?.packet;
  const gaps = data.gaps;
  return (
    <div aria-live="polite">
      <p><Label text={t("context.status", { status: data.status })} tone={data.status === "ready" ? "ok" : "warn"} /></p>
      {gaps === null || gaps === undefined ? null : gaps.requiresHumanInput && gaps.primaryQuestion !== undefined ? (
        <div role="alert" className="box box-warn"><strong>{t("context.question_for_the_human")}</strong> {gaps.primaryQuestion.question}
          {gaps.additionalQuestions.length === 0 ? null : <ul>{gaps.additionalQuestions.map((a) => <li key={a.id}>{a.question}</li>)}</ul>}</div>
      ) : null}
      {c?.resolution?.ambiguities.length ? <div className="box box-warn"><Trans i18nKey="context.ambiguous" components={{ v0: <>{c.resolution.ambiguities.map((a) => `${a.term} → ${a.options.map((o) => o.ref).join(", ")}`).join("; ")}</> }} /></div> : null}
      {p === undefined ? null : (
        <>
          <Section title={t("context.token_metrics")}>
            <dl className="facts">
              <div><dt>{t("context.packet_tokens")}</dt><dd><Trans i18nKey="context.of_o200k_base" components={{ v0: <>{String((p.metrics.budget.used) ?? "")}</>, v1: <>{String((p.metrics.budget.total) ?? "")}</> }} /></dd></div>
              <div><dt>{t("context.candidate_tokens")}</dt><dd><Trans i18nKey="context.candidates_selected_omitted" components={{ v0: <>{String((p.metrics.candidateTokens) ?? "")}</>, v1: <>{String((p.metrics.candidates) ?? "")}</>, v2: <>{String((p.metrics.selected) ?? "")}</>, v3: <>{String((p.metrics.omitted) ?? "")}</> }} /></dd></div>
              {c?.metrics === undefined ? null : <div><dt>{t("context.repository_tokens")}</dt><dd><Trans i18nKey="context.in_files" components={{ v0: <>{String((c.metrics.repository.tokens) ?? "")}</>, v1: <>{String((c.metrics.repository.files) ?? "")}</> }} /></dd></div>}
              <div><dt>{t("context.llm_calls")}</dt><dd>{p.metrics.llmCalls}</dd></div>
            </dl>
          </Section>
          <Section title={t("context.seeds")} count={p.seeds.length}><ul>{p.seeds.map((s) => <li key={s.id}><Link to={entityPath(s.ref)}>{s.ref}</Link> <span className="muted">({s.match})</span></li>)}</ul></Section>
          <Section title={t("context.confirmed_intent")} count={p.intent.requirements.length + p.intent.constraints.length}><Items items={[...p.intent.requirements, ...p.intent.constraints]} /></Section>
          <Section title={t("context.active_decisions")} count={p.decisions.active.length}><Items items={p.decisions.active} /></Section>
          <Section title={t("context.relevant_code")} count={p.code.length}><Items items={p.code} /></Section>
          <Section title={t("context.tests")} count={p.tests.length}><Items items={p.tests} /></Section>
          <Section title={t("context.pending_human_decisions_not_confirmed")} count={p.pendingDecisions.length}>
            {p.pendingDecisions.length === 0 ? <Empty>{t("context.none")}</Empty> : <ul>{p.pendingDecisions.map((d) => <li key={d.id}><Label text="PENDING / NOT CONFIRMED" tone="info" /> {d.id} {d.title}</li>)}</ul>}
          </Section>
          <Section title={t("context.knowledge_gaps")} count={gaps?.assessment.gaps.filter((g) => g.action !== "ignore").length ?? 0}>
            {gaps === null || gaps === undefined ? <Empty>{t("context.not_assessed")}</Empty> : <><p className="muted small">{gaps.notice}</p><GapList gaps={gaps.assessment.gaps} /></>}
          </Section>
          <Section title={t("context.evidence")} count={p.evidence.length} open={false}>
            <ul>{p.evidence.map((e) => <li key={e.id}><code>{e.ref}</code>: {e.via.steps.length === 0 ? "seed" : e.via.steps.map((s) => `${s.from} ${s.type} ${s.to}`).join(" → ")}</li>)}</ul>
          </Section>
          <Section title={t("context.limitations")} count={p.limitations.length} open={false}><ul>{p.limitations.map((l) => <li key={l.code}>{l.message}</li>)}</ul></Section>
          <Section title={t("context.omitted_candidates")} count={p.omittedCandidates.length} open={false}>
            {p.omittedCandidates.length === 0 ? <Empty>{t("context.nothing_was_left_out")}</Empty> : <ul>{p.omittedCandidates.map((o) => <li key={o.id}>{o.ref} <span className="muted"><Trans i18nKey="context.rank" components={{ v0: <>{String((o.rank) ?? "")}</>, v1: <>{o.tier}</> }} /></span></li>)}</ul>}
          </Section>
        </>
      )}
    </div>
  );
}
