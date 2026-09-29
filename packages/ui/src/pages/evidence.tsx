/** Evidence viewer: the pointer, and only the pointed-at lines (no file browser, no editor). */
import { useState } from "react";
import { api, q } from "../api.js";
import { Label } from "../components.js";
import type { Evidence } from "../types.js";

const BASIS: Readonly<Record<string, string>> = { "project-truth": "Project Truth", repository: "Repository", git: "Git", test: "Test", llm: "LLM" };

export function EvidenceList(props: { readonly ids: readonly string[]; readonly evidence: readonly Evidence[] }) {
  const byId = new Map(props.evidence.map((e) => [e.id, e] as const));
  return <ul className="evidence">{props.ids.map((id) => <EvidenceRow key={id} id={id} e={byId.get(id)} />)}</ul>;
}

function EvidenceRow(props: { readonly id: string; readonly e: Evidence | undefined }) {
  const { e } = props;
  const [slice, setSlice] = useState<{ readonly start: number; readonly lines: readonly string[]; readonly truncated: boolean } | string | undefined>();
  const p = e?.pointer;
  const lines = p?.lines;
  const show = async () => {
    if (p?.path === undefined || lines === undefined) return;
    try {
      const r = await api.get<{ start: number; lines: string[]; truncated: boolean }>(`/api/source?${q({ path: p.path, start: lines[0], end: lines[1] })}`);
      setSlice(r.data);
    } catch (error) {
      setSlice(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <li>
      <Label text={BASIS[e?.basis ?? ""] ?? e?.basis ?? "?"} tone={e?.basis === "llm" ? "warn" : "info"} /> <code>{props.id}</code> {e?.summary ?? ""}
      {p?.path === undefined ? null : <> · <code className="loc">{p.path}{lines === undefined ? "" : `:${lines[0]}-${lines[1]}`}</code></>}
      {p?.commit === undefined ? null : <> · commit <code>{p.commit.slice(0, 12)}</code></>}
      {p?.path !== undefined && lines !== undefined && slice === undefined ? <> <button type="button" className="link" onClick={() => void show()}>Show lines</button></> : null}
      {typeof slice === "string" ? <p className="muted">{slice}</p> : slice === undefined ? null : (
        <pre className="slice">{slice.lines.map((l, i) => `${String(slice.start + i).padStart(5)}  ${l}`).join("\n")}{slice.truncated ? "\n…" : ""}</pre>
      )}
    </li>
  );
}
