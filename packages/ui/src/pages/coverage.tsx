import { Command, Empty, ErrorBox, Level, Loading, Page, useApi } from "../components.js";
import { isOverview, type Overview, type OverviewResponse } from "../types.js";

/** Analysis coverage (T18.0 facts): L0 is the normal file-level fallback, never shown as an error. */
export function CoveragePage() {
  const [load, reload] = useApi<OverviewResponse>("/api/overview");
  return (
    <Page title="Analysis coverage" onRefresh={reload} durationMs={load.state === "ok" ? load.durationMs : undefined}>
      <p className="muted">Every file in the Git repository gets file-level analysis (L0). Languages with an analyzer get structure (L1); TypeScript and JavaScript also get resolved imports and calls (L2). A missing analyzer lowers precision; it is not a failure.</p>
      {load.state === "loading" ? <Loading /> : load.state === "error" ? <ErrorBox error={load.error} /> : !isOverview(load.data) || load.data.status.analysis === null
        ? <Empty>No index yet: run <Command>duoctl index</Command>.</Empty> : <CoverageTable analysis={load.data.status.analysis} />}
    </Page>
  );
}

export function CoverageTable(props: { readonly analysis: NonNullable<Overview["status"]["analysis"]> }) {
  const a = props.analysis;
  return (
    <>
      <p>{a.files.total} indexed files · {a.files.structural} with structural analysis · {a.files.fileOnly} file-level only</p>
      <table>
        <thead><tr>{["Language", "Level", "Files", "Analyzer", "Symbols", "Tests", "Imports", "Calls", "Type resolution"].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
        <tbody>
          {a.languages.map((l) => (
            <tr key={l.language}><th scope="row">{l.language}</th><td><Level level={l.level} /></td><td>{l.files}</td><td>{l.analyzer}</td><td>{l.symbols}</td><td>{l.tests}</td><td>{l.imports}</td><td>{l.calls}</td><td>{l.typeResolution}</td></tr>
          ))}
          {a.fileOnly.files === 0 ? null : (
            <tr><th scope="row">other files</th><td><Level level="L0" /></td><td>{a.fileOnly.files}</td><td>—</td><td colSpan={5}>
              File-level analysis: path, fingerprint, Git history and diff, Truth references. {a.fileOnly.extensions.map((e) => `${e.extension === "" ? "(no extension)" : `.${e.extension}`} ${e.files}`).join(" · ")}
            </td></tr>
          )}
        </tbody>
      </table>
      <p className="muted small">Limitations follow from these values: "syntactic" imports do not link files, "syntactic" calls have no CALLS edges, "partial" resolves only what syntax makes certain. A missing edge is not proof that a relation does not exist.</p>
    </>
  );
}
