import { Command, Empty, ErrorBox, Label, Level, Loading, Page, Section, useApi, Verdict } from "../components.js";
import { Link } from "../router.js";
import { isOverview, type Overview, type OverviewResponse } from "../types.js";

export function llmText(s: Overview["status"]): { readonly text: string; readonly tone: "muted" | "ok" | "warn" } {
  if (s.llm === "disabled") return { text: "LLM disabled (default): DUO works without it", tone: "muted" };
  if (s.llm === "configured") return { text: `Semantic assistance available · ${s.llmProvider?.provider ?? ""} ${s.llmProvider?.model ?? ""}`.trim(), tone: "ok" };
  return { text: `Semantic assistance unavailable${s.llmProvider?.reason === undefined ? "" : ` · ${s.llmProvider.reason}`}`, tone: "warn" };
}

export function IndexState(props: { readonly status: string | undefined }) {
  if (props.status === "current") return <Label text="index current" tone="ok" />;
  return (
    <span>
      <Label text={`Index required (${props.status ?? "unknown"})`} tone="warn" /> Run <Command>duoctl index</Command> in the repository, then Refresh.
    </span>
  );
}

export function OverviewPage() {
  const [load, reload] = useApi<OverviewResponse>("/api/overview");
  return (
    <Page title="Overview" onRefresh={reload} durationMs={load.state === "ok" ? load.durationMs : undefined}>
      {load.state === "loading" ? <Loading /> : load.state === "error" ? <ErrorBox error={load.error} /> : !isOverview(load.data)
        ? <Empty>{load.data.message ?? "Not a DUO project yet: run duoctl init."}</Empty>
        : <OverviewBody o={load.data} />}
    </Page>
  );
}

function OverviewBody(props: { readonly o: Overview }) {
  const { o } = props;
  const s = o.status;
  const llm = llmText(s);
  const byStatus = Object.entries(o.requirements.byStatus).map(([k, v]) => `${k} ${v}`).join(" · ");
  return (
    <>
      <dl className="facts">
        <div><dt>Project</dt><dd>{s.project.name} <span className="muted">· vision {s.project.vision}</span></dd></div>
        <div><dt>Current milestone</dt><dd>{o.currentMilestone === null ? <span className="muted">not set</span> : <Link to={`/entity/${encodeURIComponent(o.currentMilestone.id)}`}>{o.currentMilestone.id} {o.currentMilestone.title}</Link>}</dd></div>
        <div><dt>Index</dt><dd><IndexState status={s.index?.status} />{s.index !== null && s.index.status !== "current" ? <span className="muted"> · {s.index.changes.files} changed files</span> : null}</dd></div>
        <div><dt>Adoption baseline</dt><dd>{s.baseline === null ? "—" : <><Label text={s.baseline.status} tone={s.baseline.status === "current" || s.baseline.status === "advanced" ? "ok" : "muted"} />{s.baseline.findings === undefined ? null : <span className="muted"> · {s.baseline.findings} pre-existing findings</span>}</>}</dd></div>
        <div><dt>Requirements</dt><dd>{o.requirements.total}{byStatus === "" ? null : <span className="muted"> · {byStatus}</span>}</dd></div>
        <div><dt>Decisions</dt><dd>{o.decisions.active} active <span className="muted">· {o.decisions.total} total</span></dd></div>
        <div><dt>Pending human decisions</dt><dd>{s.pendingDecisions.length === 0 ? "none" : <Link to="/decisions">{s.pendingDecisions.length} waiting for a human</Link>}</dd></div>
        <div><dt>Declared knowledge gaps</dt><dd>{o.declaredGaps.length}</dd></div>
        <div><dt>Latest recorded review</dt><dd>{o.latestReview === null ? <span className="muted">none recorded (duoctl review --record)</span> : <Link to={`/reviews/${o.latestReview.id}`}><Verdict verdict={o.latestReview.verdict} /> {o.latestReview.id}</Link>}</dd></div>
        <div><dt>LLM</dt><dd><Label text={llm.text} tone={llm.tone} /></dd></div>
      </dl>
      {o.requirements.total === 0 && o.decisions.total === 0 ? (
        <Empty>No confirmed requirements yet. DUO can still analyze repository structure and changes.</Empty>
      ) : null}
      <Section title="Analysis coverage">
        {s.analysis === null ? <Empty>No index yet: run <Command>duoctl index</Command>.</Empty> : (
          <p>
            {s.analysis.languages.map((l) => <span key={l.language} className="chip">{l.language} <Level level={l.level} /> {l.files}</span>)}
            {s.analysis.fileOnly.files > 0 ? <span className="chip">other files <Level level="L0" /> {s.analysis.fileOnly.files}</span> : null}
            {" "}<Link to="/coverage">details</Link>
          </p>
        )}
      </Section>
      <Section title="Declared knowledge gaps" count={o.declaredGaps.length} open={o.declaredGaps.length > 0}>
        {o.declaredGaps.length === 0 ? <Empty>No UNKNOWN lines in Project Truth.</Empty> : (
          <ul>{o.declaredGaps.map((g) => <li key={g.id}><code>{g.owner}</code>{g.key === undefined ? null : <> · <code>{g.key}</code></>} — {g.text}</li>)}</ul>
        )}
      </Section>
    </>
  );
}
