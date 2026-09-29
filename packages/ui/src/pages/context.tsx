/** Context Inspector (T18.1): the Context Compiler through the shared operation. Never indexes. */
import { useState } from "react";
import { api } from "../api.js";
import { Command, Empty, ErrorBox, Label, Page, Section } from "../components.js";
import { entityPath, Link } from "../router.js";
import type { ContextData, Gap, PacketItem } from "../types.js";

function Items(props: { readonly items: readonly PacketItem[] }) {
  if (props.items.length === 0) return <Empty>None.</Empty>;
  return (
    <ol className="packet-items">{props.items.map((i) => (
      <li key={i.id}><div><Link to={entityPath(i.ref)}>{i.ref}</Link> <span className="muted">rank {i.rank} · {i.level} · {i.tokens} tokens</span></div><pre className="slice">{i.text}</pre></li>
    ))}</ol>
  );
}

export function GapList(props: { readonly gaps: readonly Gap[] }) {
  const shown = props.gaps.filter((g) => g.action !== "ignore");
  const ignored = props.gaps.length - shown.length;
  return (
    <>
      {shown.length === 0 ? <Empty>No gap needs attention.</Empty> : (
        <ul>{shown.map((g) => <li key={g.id}><Label text={g.action.toUpperCase()} tone={g.action === "ask" ? "warn" : "info"} /> {g.kind} <span className="muted">({g.relevance})</span>{g.text === undefined ? null : <> — {g.text}</>}</li>)}</ul>
      )}
      {ignored === 0 ? null : <p className="muted small">{ignored} gap(s) judged not relevant (IGNORE) are not listed.</p>}
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
    <Page title="Context Inspector" durationMs={result !== undefined && !(result instanceof Error) ? result.ms : undefined}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (task.trim() !== "") void compile(); }}>
        <label>Task <textarea value={task} onChange={(e) => setTask(e.target.value)} rows={2} placeholder="AUTH-03, a symbol, a path or a sentence" /></label>
        <label>Budget (tokens, optional) <input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="numeric" size={8} /></label>
        <button type="submit" disabled={busy || task.trim() === ""}>{busy ? "Compiling…" : "Compile context"}</button>
      </form>
      {result === undefined ? null : result instanceof Error ? <ErrorBox error={result} /> : <ContextResultView data={result.data} />}
    </Page>
  );
}

export function ContextResultView(props: { readonly data: ContextData }) {
  const { data } = props;
  if (data.status === "index-required") {
    return <p role="status" className="box box-warn"><Label text="index-required" tone="warn" /> The index is not current. Run <Command>duoctl index</Command>, then compile again.</p>;
  }
  if (data.status === "not-initialized" || data.status === "failed") return <p role="alert" className="box box-error">{data.status}: {(data.diagnostics ?? []).map((d) => d.message).join("; ")}</p>;
  const c = data.context;
  const p = c?.packet;
  const gaps = data.gaps;
  return (
    <div aria-live="polite">
      <p><Label text={`status: ${data.status}`} tone={data.status === "ready" ? "ok" : "warn"} /></p>
      {gaps === null || gaps === undefined ? null : gaps.requiresHumanInput && gaps.primaryQuestion !== undefined ? (
        <div role="alert" className="box box-warn"><strong>Question for the human:</strong> {gaps.primaryQuestion.question}
          {gaps.additionalQuestions.length === 0 ? null : <ul>{gaps.additionalQuestions.map((a) => <li key={a.id}>{a.question}</li>)}</ul>}</div>
      ) : null}
      {c?.resolution?.ambiguities.length ? <div className="box box-warn">Ambiguous: {c.resolution.ambiguities.map((a) => `${a.term} → ${a.options.map((o) => o.ref).join(", ")}`).join("; ")}</div> : null}
      {p === undefined ? null : (
        <>
          <Section title="Token metrics">
            <dl className="facts">
              <div><dt>Packet tokens</dt><dd>{p.metrics.budget.used} of {p.metrics.budget.total} (o200k_base)</dd></div>
              <div><dt>Candidate tokens</dt><dd>{p.metrics.candidateTokens} ({p.metrics.candidates} candidates, {p.metrics.selected} selected, {p.metrics.omitted} omitted)</dd></div>
              {c?.metrics === undefined ? null : <div><dt>Repository tokens</dt><dd>{c.metrics.repository.tokens} in {c.metrics.repository.files} files</dd></div>}
              <div><dt>LLM calls</dt><dd>{p.metrics.llmCalls}</dd></div>
            </dl>
          </Section>
          <Section title="Seeds" count={p.seeds.length}><ul>{p.seeds.map((s) => <li key={s.id}><Link to={entityPath(s.ref)}>{s.ref}</Link> <span className="muted">({s.match})</span></li>)}</ul></Section>
          <Section title="Confirmed intent" count={p.intent.requirements.length + p.intent.constraints.length}><Items items={[...p.intent.requirements, ...p.intent.constraints]} /></Section>
          <Section title="Active decisions" count={p.decisions.active.length}><Items items={p.decisions.active} /></Section>
          <Section title="Relevant code" count={p.code.length}><Items items={p.code} /></Section>
          <Section title="Tests" count={p.tests.length}><Items items={p.tests} /></Section>
          <Section title="Pending human decisions (not confirmed)" count={p.pendingDecisions.length}>
            {p.pendingDecisions.length === 0 ? <Empty>None.</Empty> : <ul>{p.pendingDecisions.map((d) => <li key={d.id}><Label text="PENDING / NOT CONFIRMED" tone="info" /> {d.id} {d.title}</li>)}</ul>}
          </Section>
          <Section title="Knowledge gaps" count={gaps?.assessment.gaps.filter((g) => g.action !== "ignore").length ?? 0}>
            {gaps === null || gaps === undefined ? <Empty>Not assessed.</Empty> : <><p className="muted small">{gaps.notice}</p><GapList gaps={gaps.assessment.gaps} /></>}
          </Section>
          <Section title="Evidence" count={p.evidence.length} open={false}>
            <ul>{p.evidence.map((e) => <li key={e.id}><code>{e.ref}</code>: {e.via.steps.length === 0 ? "seed" : e.via.steps.map((s) => `${s.from} ${s.type} ${s.to}`).join(" → ")}</li>)}</ul>
          </Section>
          <Section title="Limitations" count={p.limitations.length} open={false}><ul>{p.limitations.map((l) => <li key={l.code}>{l.message}</li>)}</ul></Section>
          <Section title="Omitted candidates" count={p.omittedCandidates.length} open={false}>
            {p.omittedCandidates.length === 0 ? <Empty>Nothing was left out.</Empty> : <ul>{p.omittedCandidates.map((o) => <li key={o.id}>{o.ref} <span className="muted">rank {o.rank} · {o.tier}</span></li>)}</ul>}
          </Section>
        </>
      )}
    </div>
  );
}
