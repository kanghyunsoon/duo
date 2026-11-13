/** Entity detail: a Truth definition (exact source slice) or a graph node, with its direct relations. */
import { t } from "../i18n.js";
import { Trans } from "react-i18next";
import { Empty, ErrorBox, Label, Loading, Loc, Page, Section, useApi } from "../components.js";
import type { GraphPayload, Location } from "../types.js";
import { DecisionLabel } from "./direction.js";

interface EntityData {
  readonly status: string; readonly id: string; readonly type?: string; readonly text?: string; readonly trace?: GraphPayload;
  readonly definition?: { readonly id: string; readonly title?: string; readonly statement?: string; readonly status?: string; readonly state?: string; readonly label?: "CONFIRMED" | "PROPOSED" | "SUPERSEDED" | "REJECTED"; readonly location?: Location; readonly question?: string; readonly answer?: string };
}

export function EntityPage(props: { readonly id: string }) {
  const [load, reload] = useApi<EntityData>(`/api/entity/${encodeURIComponent(props.id)}`);
  return (
    <Page title={props.id} onRefresh={reload} durationMs={load.state === "ok" ? load.durationMs : undefined}>
      {load.state === "loading" ? <Loading /> : load.state === "error" ? <ErrorBox error={load.error} /> : load.data.status !== "found" ? <Empty><Trans i18nKey="entity.is_not_a_truth_definition_or_graph" components={{ v0: <>{props.id}</> }} /></Empty> : <Body e={load.data} />}
    </Page>
  );
}

function Body(props: { readonly e: EntityData }) {
  const { e } = props;
  const d = e.definition;
  return (
    <>
      <p><Label text={e.type ?? "node"} tone="muted" /> {d?.label === undefined ? null : <DecisionLabel label={d.label} />} {d?.status === undefined ? null : <Label text={d.status} tone="info" />}
        {e.type === "proposal" ? <Label text="PROPOSED · not confirmed intent" tone="info" /> : null} {d?.title ?? d?.statement ?? ""} <Loc location={d?.location} /></p>
      {d?.question === undefined ? null : <p><code>{d.question}</code> = {d.answer}</p>}
      {e.text === undefined ? null : <Section title={t("entity.definition_source")}><pre className="truth">{e.text}</pre></Section>}
      {e.trace?.nodes === undefined ? null : (
        <Section title={t("entity.direct_relations")} count={e.trace.edges?.length ?? 0}>
          {(e.trace.edges ?? []).length === 0 ? <Empty>{t("entity.no_recorded_relation")}</Empty> : (
            <ul>{e.trace.edges?.map((x) => <li key={`${x.from}${x.type}${x.to}`}><code>{x.from}</code> {x.type} <code>{x.to}</code></li>)}</ul>
          )}
        </Section>
      )}
    </>
  );
}
