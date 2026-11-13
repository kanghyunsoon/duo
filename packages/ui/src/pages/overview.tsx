import { t } from "../i18n.js";
import { Trans } from "react-i18next";
import { Command, Empty, ErrorBox, Label, Loading, Page, Section, useApi, Verdict } from "../components.js";
import { CoverageTable } from "./coverage.js";
import { Link } from "../router.js";
import { isOverview, type Overview, type OverviewResponse } from "../types.js";

export function llmText(s: Overview["status"]): { readonly text: string; readonly tone: "muted" | "ok" | "warn" } {
  if (s.llm === "disabled") return { text: t("text.LLM disabled (default): DUO works without it"), tone: "muted" };
  if (s.llm === "configured") return { text: t("overview.llm_available", { provider: s.llmProvider?.provider ?? "", model: s.llmProvider?.model ?? "" }).trim(), tone: "ok" };
  return { text: t("overview.llm_unavailable", { reason: s.llmProvider?.reason === undefined ? "" : ` · ${s.llmProvider.reason}` }), tone: "warn" };
}

export function IndexState(props: { readonly status: string | undefined }) {
  if (props.status === "current") return <Label text="index current" tone="ok" />;
  return (
    <span><Trans i18nKey="overview.run_duoctl_index_in_the_repository_then" components={{ c0: <Label text={t("overview.index_required", { status: props.status ?? "unknown" })} tone="warn" />, c1: <Command children="" /> }} /></span>
  );
}

export function OverviewPage() {
  const [load, reload] = useApi<OverviewResponse>("/api/overview");
  return (
    <Page title={t("overview.overview")} onRefresh={reload} durationMs={load.state === "ok" ? load.durationMs : undefined}>
      {load.state === "loading" ? <Loading /> : load.state === "error" ? <ErrorBox error={load.error} /> : !isOverview(load.data)
        ? <Empty>{load.data.message ?? t("text.Not a DUO project yet: run duoctl init.")}</Empty>
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
    <div className="overview-dashboard">
      <p className="page-caption">{t("design.overview_caption")}</p>
      <dl className="facts">
        <div><dt>{t("overview.project")}</dt><dd>{s.project.name} <span className="muted"><Trans i18nKey="overview.vision" components={{ v0: <>{String((s.project.vision) ?? "")}</> }} /></span></dd></div>
        <div><dt>{t("overview.current_milestone")}</dt><dd>{o.currentMilestone === null ? <span className="muted">{t("overview.not_set")}</span> : <Link to={`/entity/${encodeURIComponent(o.currentMilestone.id)}`}>{o.currentMilestone.id} {o.currentMilestone.title}</Link>}</dd></div>
        <div><dt>{t("overview.index")}</dt><dd><IndexState status={s.index?.status} />{s.index !== null && s.index.status !== "current" ? <span className="muted"><Trans i18nKey="overview.changed_files" components={{ v0: <>{String((s.index.changes.files) ?? "")}</> }} /></span> : null}</dd></div>
        <div><dt>{t("overview.adoption_baseline")}</dt><dd>{s.baseline === null ? "—" : <><Label text={s.baseline.status} tone={s.baseline.status === "current" || s.baseline.status === "advanced" ? "ok" : "muted"} />{s.baseline.findings === undefined ? null : <span className="muted"><Trans i18nKey="overview.pre_existing_findings" components={{ v0: <>{String((s.baseline.findings) ?? "")}</> }} /></span>}</>}</dd></div>
        <div><dt>{t("overview.requirements")}</dt><dd>{o.requirements.total}{byStatus === "" ? null : <span className="muted"> · {byStatus}</span>}</dd></div>
        <div><dt>{t("overview.decisions")}</dt><dd><Trans i18nKey="overview.active_total" components={{ v0: <>{String((o.decisions.active) ?? "")}</>, c1: <span className="muted" />, v2: <>{String((o.decisions.total) ?? "")}</> }} /></dd></div>
        <div><dt>{t("overview.pending_human_decisions")}</dt><dd>{s.pendingDecisions.length === 0 ? t("text.none") : <Link to="/decisions"><Trans i18nKey="overview.waiting_for_a_human" components={{ v0: <>{String((s.pendingDecisions.length) ?? "")}</> }} /></Link>}</dd></div>
        <div><dt>{t("overview.declared_knowledge_gaps")}</dt><dd>{o.declaredGaps.length}</dd></div>
        <div><dt>{t("overview.latest_recorded_review")}</dt><dd>{o.latestReview === null ? <span className="muted">{t("overview.none_recorded_duoctl_review_record")}</span> : <Link to={`/reviews/${o.latestReview.id}`}><Verdict verdict={o.latestReview.verdict} /> {o.latestReview.id}</Link>}</dd></div>
        <div><dt>{t("overview.llm")}</dt><dd><Label text={llm.text} tone={llm.tone} /></dd></div>
      </dl>
      {o.requirements.total === 0 && o.decisions.total === 0 ? (
        <Empty>{t("overview.no_confirmed_requirements_yet_duo_can_still")}</Empty>
      ) : null}
      <div className="analysis-summary"><IndexState status={s.index?.status}/><span>{t("integrated.analysis_files", {count:s.analysis?.files.total ?? 0})}</span></div>
      <Section title={t("overview.analysis_coverage")} open={false}>
        {s.analysis === null ? <Empty><Trans i18nKey="overview.no_index_yet_run_duoctl_index" components={{ c0: <Command children="" /> }} /></Empty> : <div className="analysis-table"><CoverageTable analysis={s.analysis}/></div>}
      </Section>
      <Section title={t("overview.declared_knowledge_gaps")} count={o.declaredGaps.length} open={o.declaredGaps.length > 0}>
        {o.declaredGaps.length === 0 ? <Empty>{t("overview.no_unknown_lines_in_project_truth")}</Empty> : (
          <ul>{o.declaredGaps.map((g) => <li key={g.id}><code>{g.owner}</code>{g.key === undefined ? null : <> · <code>{g.key}</code></>} — {g.text}</li>)}</ul>
        )}
      </Section>
    </div>
  );
}
