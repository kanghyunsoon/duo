import { t } from "../i18n.js";
import { Trans } from "react-i18next";
import { Command, Empty, ErrorBox, Level, Loading, Page, TableScroll, useApi } from "../components.js";
import { isOverview, type Overview, type OverviewResponse } from "../types.js";

/** Analysis coverage (T18.0 facts): L0 is the normal file-level fallback, never shown as an error. */
export function CoveragePage() {
  const [load, reload] = useApi<OverviewResponse>("/api/overview");
  return (
    <Page title={t("coverage.analysis_coverage")} onRefresh={reload} durationMs={load.state === "ok" ? load.durationMs : undefined}>
      <p className="muted">{t("coverage.every_file_in_the_git_repository_gets")}</p>
      {load.state === "loading" ? <Loading /> : load.state === "error" ? <ErrorBox error={load.error} /> : !isOverview(load.data) || load.data.status.analysis === null
        ? <Empty><Trans i18nKey="coverage.no_index_yet_run_duoctl_index" components={{ c0: <Command children="" /> }} /></Empty> : <CoverageTable analysis={load.data.status.analysis} />}
    </Page>
  );
}

export function CoverageTable(props: { readonly analysis: NonNullable<Overview["status"]["analysis"]> }) {
  const a = props.analysis;
  return (
    <>
      <p><Trans i18nKey="coverage.indexed_files_with_structural_analysis_file_level" components={{ v0: <>{String((a.files.total) ?? "")}</>, v1: <>{String((a.files.structural) ?? "")}</>, v2: <>{String((a.files.fileOnly) ?? "")}</> }} /></p>
      <TableScroll label="Analysis coverage"><table>
        <thead><tr>{[t("text.Language"), t("text.Level"), t("text.Files"), t("text.Analyzer"), t("text.Symbols"), t("text.Tests"), t("text.Imports"), t("text.Calls"), t("text.Type resolution")].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
        <tbody>
          {a.languages.map((l) => (
            <tr key={l.language}><th scope="row">{l.language}</th><td><Level level={l.level} /></td><td>{l.files}</td><td>{l.analyzer}</td><td>{l.symbols}</td><td>{l.tests}</td><td>{l.imports}</td><td>{l.calls}</td><td>{l.typeResolution}</td></tr>
          ))}
          {a.fileOnly.files === 0 ? null : (
            <tr><th scope="row">{t("coverage.other_files")}</th><td><Level level="L0" /></td><td>{a.fileOnly.files}</td><td>—</td><td colSpan={5}><Trans i18nKey="coverage.file_level_analysis_path_fingerprint_git_history" components={{ v0: <>{a.fileOnly.extensions.map((e) => `${e.extension === "" ? t("text.(no extension)") : `.${e.extension}`} ${e.files}`).join(" · ")}</> }} /></td></tr>
          )}
        </tbody>
      </table></TableScroll>
      <p className="muted small">{t("coverage.limitations_follow_from_these_values_syntactic_imports")}</p>
    </>
  );
}
