/** Review screen (T18.1): the Review service as it is. Never indexes, never records. */
import { useState } from "react";
import { api } from "../api.js";
import { Command, Empty, ErrorBox, Label, Page, Provenance, Section, Verdict } from "../components.js";
import { GapList } from "./context.js";
import { EvidenceList } from "./evidence.js";
import type { Claim, Evidence, ReviewResult, SemanticAssist } from "../types.js";

export const PASS_MEANING = "PASS means no Project Direction violation was found in the available evidence. It does not mean the tests pass or the code is bug-free.";

export function ClaimTable(props: { readonly claims: readonly Claim[]; readonly evidence: readonly Evidence[] }) {
  const [open, setOpen] = useState<string | undefined>();
  if (props.claims.length === 0) return <Empty>No claims.</Empty>;
  return (
    <table>
      <thead><tr><th scope="col">Alignment</th><th scope="col">Rule</th><th scope="col">Subject</th><th scope="col">Reason</th><th scope="col">Provenance</th><th scope="col">Evidence</th></tr></thead>
      <tbody>{props.claims.map((c) => (
        <tr key={c.id}>
          <td><Label text={c.alignment} tone={c.alignment === "ALIGNED" ? "ok" : c.alignment === "CONFLICT" ? (c.blockEligible ? "block" : "warn") : "info"} />{c.blockEligible ? <Label text="blocking" tone="block" /> : null}{c.drift ? <Label text="drift" tone="warn" /> : null}</td>
          <td>{c.rule}</td><td><code>{c.subject.id}</code></td>
          <td>{c.reason}{c.observed === undefined ? null : <div className="muted small">{c.observed}</div>}</td>
          <td><Provenance value={c.provenance} /></td>
          <td>
            <button type="button" className="link" aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? undefined : c.id)}>{c.evidenceIds.length} item(s)</button>
            {open === c.id ? <EvidenceList ids={c.evidenceIds} evidence={props.evidence} /> : null}
          </td>
        </tr>
      ))}</tbody>
    </table>
  );
}

export function SemanticSection(props: { readonly a: SemanticAssist; readonly evidence: readonly Evidence[] }) {
  const { a } = props;
  if (a.status === "not-requested") return null;
  return (
    <Section title="Semantic assistance (supplemental, never blocks)">
      <p><Label text={a.status} tone={a.status === "success" ? "ok" : "muted"} />{a.failure === undefined ? null : <span className="muted"> · {a.failure}</span>}{a.provider === undefined ? null : <span className="muted"> · {a.provider.id} {a.provider.model ?? ""}</span>}{a.cacheHits > 0 ? <span className="muted"> · cached</span> : null}</p>
      <p className="muted small">LLM answers are kept apart from the deterministic claims above; they never change them. At most they raise PASS to WARN.</p>
      {a.claims.length === 0 ? null : <ul>{a.claims.map((c) => <li key={c.claimId}><Label text={c.alignment} tone="info" /> <code>{c.claimId}</code> {c.reason ?? ""}</li>)}</ul>}
      {a.verdict === undefined ? null : <p>With semantic assistance: <Verdict verdict={a.verdict} /></p>}
    </Section>
  );
}

export function ReviewView(props: { readonly r: ReviewResult }) {
  const { r } = props;
  if (r.status === "index-required") {
    return <p role="status" className="box box-warn"><Label text="index-required" tone="warn" /> The index is {r.freshness?.status ?? "not current"}. Run <Command>duoctl index</Command>, then review again.</p>;
  }
  if (r.status === "failed") {
    // T40 (N1): a review DUO could not run, e.g. Project Truth it could read only in part. No verdict is shown.
    return (
      <div role="alert" className="box box-error">
        <strong>Review not run: no verdict</strong>
        <ul>{(r.diagnostics ?? []).map((d, i) => <li key={i}><code>{d.code}</code> {d.message}</li>)}</ul>
      </div>
    );
  }
  if (r.status !== "ready") return <p role="alert" className="box box-error">{r.status}</p>;
  const bootstrap = r.diff?.files.filter((f) => f.provenance === "adoption-bootstrap") ?? [];
  return (
    <div aria-live="polite">
      <h2 className="verdict-line">Deterministic review: <Verdict verdict={r.verdict} /></h2>
      {r.verdict === "PASS" ? <p className="muted">{PASS_MEANING}</p> : null}
      <p className="muted small">Diff {r.diff?.from} → {r.diff?.to} · {r.diff?.files.length ?? 0} files · baseline {r.baseline.status} · llm calls {r.metrics.llmCalls}</p>
      {bootstrap.length === 0 ? null : <p><Provenance value="adoption-bootstrap" /> {bootstrap.length} Truth file(s) exactly as init wrote them are not reviewed until changed.</p>}
      <Section title="Claims" count={r.claims.length}><ClaimTable claims={r.claims} evidence={r.evidence} /></Section>
      <Section title="Knowledge gaps" count={r.gaps?.gaps.filter((g) => g.action !== "ignore").length ?? 0}>{r.gaps === undefined ? <Empty>Not assessed.</Empty> : <GapList gaps={r.gaps.gaps} />}</Section>
      <Section title="Limitations" count={r.limitations.length} open={false}><ul>{r.limitations.map((l) => <li key={l.code}><code>{l.code}</code> {l.message}</li>)}</ul></Section>
      <SemanticSection a={r.semanticAssist} evidence={r.evidence} />
      <p className="muted small">This review is not recorded. To keep it as history, run <Command>duoctl review --record</Command>.</p>
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
    <Page title="Review" durationMs={result !== undefined && !(result instanceof Error) ? result.ms : undefined}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <label>From <input value={from} onChange={(e) => setFrom(e.target.value)} size={12} /></label>
        <label>To <input value={to} onChange={(e) => setTo(e.target.value)} size={12} /></label>
        <label>Task (optional) <input value={task} onChange={(e) => setTask(e.target.value)} size={30} /></label>
        <label className="check"><input type="checkbox" checked={semantic} onChange={(e) => setSemantic(e.target.checked)} /> Use semantic assistance</label>
        <button type="submit" disabled={busy}>{busy ? "Reviewing…" : "Review changes"}</button>
      </form>
      {semantic ? <p className="box box-warn small">Selected evidence slices will be sent to the configured OpenAI provider.</p> : null}
      {result === undefined ? null : result instanceof Error ? <ErrorBox error={result} /> : <ReviewView r={result.r} />}
    </Page>
  );
}
