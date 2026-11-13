/** Session files: only recorded changes and references, without inferred graph relations. */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Background, Controls, Position, ReactFlow, type Node, type Edge } from "@xyflow/react";
import { api, q } from "../api.js";
import { t } from "../i18n.js";
import { Empty, ErrorBox, Label, Loading, Page, Section, type Load } from "../components.js";
import { Link, entityPath } from "../router.js";
interface ProvidedContext { readonly recordedAt: string; readonly items: readonly {readonly ref: string; readonly kind: string; readonly text: string}[] }
interface Session { readonly providedContext?: ProvidedContext; readonly id: string; readonly type: string; readonly label: string; readonly status?: string; readonly updatedAt?: string; readonly changedFiles?: readonly string[]; readonly referencedFiles?: readonly string[] }
interface WorkMap { readonly revision: string; readonly selectedTaskId: string | null; readonly nodes: readonly Session[]; readonly truncated: boolean }
function SessionGraph({session}: {readonly session: Session}) {
  const changed = [...new Set(session.changedFiles ?? [])].sort();
  const referenced = [...new Set(session.referencedFiles ?? [])].sort();
  const nodes: Node[] = [{id:"session",position:{x:340,y:150},data:{label:<div className="session-graph-root"><span>{t("session.sessions")}</span><strong>{session.label}</strong><Label text={session.status ?? "active"} tone="ok"/></div>},sourcePosition:Position.Right,targetPosition:Position.Left,className:"session-root-node",style:{width:240}}];
  const edges: Edge[] = [];
  for (const [kind, files, x, title, empty] of [
    ["referenced", referenced, 0, t("session.referenced"), t("session.no_references")],
    ["changed", changed, 700, t("session.changed"), t("session.no_changes")],
  ] as const) {
    nodes.push({id:`heading:${kind}`,position:{x,y:0},data:{label:<strong>{title} <span className="count">{files.length}</span></strong>},className:"session-graph-heading",draggable:false,selectable:false,style:{width:260}});
    if (!files.length) nodes.push({id:`empty:${kind}`,position:{x,y:80},data:{label:empty},className:"session-graph-empty",style:{width:260}});
    files.forEach((path,index)=>{
      const id=`${kind}:${path}`;
      nodes.push({id,position:{x,y:76+index*100},data:{label:<Link to={entityPath(path)} className="session-graph-file"><strong>{path.split("/").at(-1)}</strong><span>{path}</span></Link>},sourcePosition:Position.Right,targetPosition:Position.Left,className:`session-file-node session-file-node--${kind}`,style:{width:260}});
      edges.push({id:`edge:${id}`,source:kind==="changed"?"session":id,target:kind==="changed"?id:"session",type:"smoothstep",style:{stroke:kind==="changed"?"#34a264":"#4285df",strokeWidth:2}});
    });
  }
  const graphKey=JSON.stringify([session.id,session.status,changed,referenced,t("session.changed")]);
  return <div className="session-simple-graph" role="region" aria-label={t("session.graph")}>
    <ReactFlow key={graphKey} defaultNodes={nodes} defaultEdges={edges} fitView fitViewOptions={{padding:0.18,maxZoom:0.95}} minZoom={0.15} nodesConnectable={false} zoomOnScroll={false} preventScrolling={false}
      ariaLabelConfig={{"controls.ariaLabel":t("flow.controls"),"controls.zoomIn.ariaLabel":t("flow.zoom_in"),"controls.zoomOut.ariaLabel":t("flow.zoom_out"),"controls.fitView.ariaLabel":t("flow.fit_view")}}>
      <Background gap={24} size={1}/><Controls showInteractive={false}/>
    </ReactFlow>
  </div>;
}
export function WorkPage() {
  const [selectedTask, setSelectedTask] = useState<string | undefined>();
  const [agent, setAgent] = useState("Codex");
  const [name, setName] = useState("");
  const [reconnecting, setReconnecting] = useState(false);
  const [verificationFailed, setVerificationFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [load, setLoad] = useState<Load<WorkMap>>({state:"loading"});
  const selectedTaskRef = useRef(selectedTask);
  selectedTaskRef.current = selectedTask;
  const fetching = useRef(false);
  const queued = useRef(false);
  const reload = useCallback(() => {
    if (fetching.current) { queued.current = true; return; }
    fetching.current = true;
    const requestedSelection = selectedTaskRef.current;
    void api.get<WorkMap>(`/api/work-map?${q({ selected: requestedSelection })}`).then((result) => {
      if (requestedSelection === selectedTaskRef.current) { setLoad({ state: "ok", data: result.data }); setVerificationFailed(false); }
      else queued.current = true;
    }).catch((error: unknown) => {
      if (requestedSelection === selectedTaskRef.current) setLoad({ state: "error", error: error instanceof Error ? error : new Error(String(error)) });
      else queued.current = true;
    }).finally(() => {
      fetching.current = false;
      if (queued.current) { queued.current = false; reload(); }
    });
  }, []);
  useEffect(() => { reload(); }, [selectedTask, reload]);
  const revision = useRef<string | undefined>(undefined);
  const checkRevision = useRef<() => void>(() => {});
  useEffect(() => {
    if (load.state === "ok") {
      revision.current = load.data.revision;
      checkRevision.current(); // Catch changes that arrived while this map request was in flight.
    }
  }, [load]);
  useEffect(() => {
    const stream = new EventSource("/api/work-events", { withCredentials: true });
    let live = true;
    let checking = false;
    let queued = false;
    let lastCheck = 0;
    let scheduled: number | undefined;
    let retry: number | undefined;
    let failures = 0;
    const check = () => {
      if (revision.current === undefined) return; // The initial map request is already in flight.
      if (checking) { queued = true; return; }
      if (scheduled !== undefined) return;
      const wait = Math.max(0, 1500 - (Date.now() - lastCheck));
      if (wait > 0) {
        if (scheduled === undefined) scheduled = window.setTimeout(() => { scheduled = undefined; check(); }, wait);
        return;
      }
      checking = true;
      lastCheck = Date.now();
      void api.get<{ revision: string }>("/api/work-revision").then((result) => {
        if (!live) return;
        if (typeof result.data.revision !== "string") throw new Error("Invalid revision response");
        failures = 0;
        if (retry !== undefined) { window.clearTimeout(retry); retry = undefined; }
        if (result.data.revision !== revision.current) reload();
        else setVerificationFailed(false);
      }).catch(() => {
        if (!live) return;
        failures += 1;
        if (failures >= 2) setVerificationFailed(true);
        if (retry === undefined) retry = window.setTimeout(() => { retry = undefined; check(); }, 5000);
      }).finally(() => {
        checking = false;
        if (queued && live) { queued = false; check(); }
      });
    };
    checkRevision.current = check;
    stream.onerror = () => { if (live) { setReconnecting(true); check(); } };
    stream.onmessage = (event) => {
      let kind: string;
      try { kind = (JSON.parse(event.data) as { kind: string }).kind; } catch { return; }
      if (kind === "connected") setReconnecting(false);
      if (kind === "connected" || kind === "tasks-changed" || kind === "graph-changed" || kind === "repository-changed") check();
    };
    const visible = () => { if (document.visibilityState === "visible") check(); };
    const offline = () => { setReconnecting(true); check(); };
    const online = () => { if (stream.readyState === EventSource.OPEN) setReconnecting(false); check(); };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") check(); }, 60_000);
    return () => { live = false; checkRevision.current = () => {}; stream.close(); window.clearInterval(timer);
      if (retry !== undefined) window.clearTimeout(retry);
      if (scheduled !== undefined) window.clearTimeout(scheduled); document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("offline", offline); window.removeEventListener("online", online); };
  }, [reload]);
  const map = load.state === "ok" ? load.data : undefined;
  const sessions = map?.nodes.filter(node => node.type === "task") ?? [];
  const selected = sessions.find(node => node.id === `task:${selectedTask ?? map?.selectedTaskId}`) ?? sessions[0];
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!name.trim()) return;
    setSaving(true); setSaveError(undefined);
    try { const result = await api.post<{task:{id:string}}>("/api/work-tasks",{agent:agent.trim(),name:name.trim()}); setSelectedTask(result.data.task.id); setName(""); reload(); }
    catch(error) { setSaveError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }
  async function complete() {
    if (!selected) return;
    setSaving(true); setSaveError(undefined);
    try { await api.post("/api/work-task-complete",{id:selected.id.slice(5)}); reload(); }
    catch(error) { setSaveError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }
  return <div className="work-page"><Page title={t("session.title")} onRefresh={reload}>
    <p className="page-caption">{t("session.caption")}</p>
    {verificationFailed ? <p role="status" className="box box-warn">{t("text.Unable to check for updates. The displayed information may be out of date. Use Refresh to try again.")}</p>
      : reconnecting ? <p role="status" className="box box-warn">{t("text.Live connection interrupted. Reconnecting; updates are still checked periodically.")}</p> : null}
    <details className="session-add"><summary>{t("work.add_work")}</summary>
      <form className="form" onSubmit={event=>{void add(event);}}>
        <label>{t("form.agent")}<input value={agent} onChange={event=>setAgent(event.target.value)} required maxLength={80}/></label>
        <label>{t("form.work_name")}<input value={name} onChange={event=>setName(event.target.value)} required maxLength={200}/></label>
        <button disabled={saving}>{t("work.add_work")}</button>
      </form>
    </details>
    {saveError ? <p className="box box-error" role="alert">{saveError}</p> : null}
    {load.state === "loading" ? <Loading/> : load.state === "error" ? <ErrorBox error={load.error}/> : sessions.length === 0 ? <Empty>{t("session.no_sessions")}</Empty> :
      <div className="session-layout">
        <aside className="session-picker" aria-label={t("session.choose")}>
          <h2>{t("session.sessions")} <span className="count">{sessions.length}</span></h2>
          {sessions.map(session=><button type="button" key={session.id} aria-pressed={session.id===selected?.id} onClick={()=>setSelectedTask(session.id.slice(5))}>
            <strong>{session.label}</strong><Label text={session.status ?? "active"} tone={session.status === "active" ? "ok" : "muted"}/>
          </button>)}
        </aside>
        {selected ? <section className="session-content" aria-label={selected.label}>
          <div className="session-heading"><div><h2>{selected.label}</h2>{selected.updatedAt ? <p className="muted small">{new Date(selected.updatedAt).toLocaleString()}</p> : null}</div>
            {selected.status === "completed" ? null : <button className="secondary" disabled={saving} onClick={()=>{void complete();}}>{t("work.mark_completed")}</button>}
          </div>
          <SessionGraph session={selected}/>
          <Section title={t("integrated.provided_context")} count={selected.providedContext?.items.length ?? 0} open={false}>
            <p className="muted small">{t("integrated.context_notice")}</p>
            {selected.providedContext === undefined ? <Empty>{t("integrated.no_context")}</Empty> : <>
              <p className="muted small">{t("integrated.recorded_at", {at:new Date(selected.providedContext.recordedAt).toLocaleString()})}</p>
              <ul className="provided-context">{selected.providedContext.items.map((item,index)=><li key={`${item.ref}:${index}`}>
                <Label text={item.kind} tone="muted"/><Link to={entityPath(item.ref)}>{item.ref}</Link><p>{item.text}</p>
              </li>)}</ul>
            </>}
          </Section>
          {map?.truncated ? <p role="status" className="muted small">{t("session.partial")}</p> : null}
        </section> : null}
      </div>}
  </Page></div>;
}
