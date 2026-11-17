/** Bounded work map over DUO's existing graph. The JSON is a projection, never source truth. */
import { i18n, t } from "../i18n.js";
import { Trans, useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Background, BackgroundVariant, BaseEdge, Controls, getBezierPath, MiniMap, Position, ReactFlow, useInternalNode, useReactFlow,
  type Edge, type EdgeProps, type Node } from "@xyflow/react";
import { api, q } from "../api.js";
import { Empty, ErrorBox, Loading, Page, type Load } from "../components.js";
import { Link } from "../router.js";

interface Task { readonly id: string; readonly agent: string; readonly name: string; readonly issueId?: string; readonly updatedAt: string; readonly status: string }
interface WorkNode { readonly id: string; readonly type: string; readonly label: string; readonly ref?: string; readonly updatedAt?: string;
  readonly status?: "active" | "disconnected" | "completed"; readonly worktreeId?: string; readonly branch?: string; readonly targetRef?: string;
  readonly review?: { readonly digest: string; readonly verdict?: string; readonly claimCount: number; readonly observedAt: string };
  readonly source?: { readonly path: string; readonly startLine?: number } }
interface WorkEdge { readonly from: string; readonly to: string; readonly type: string; readonly source: string }
interface WorkMap { readonly format: string; readonly revision: string; readonly graphRevision: string; readonly indexStatus: string; readonly selectedTaskId: string | null;
  readonly nodes: readonly WorkNode[]; readonly edges: readonly WorkEdge[]; readonly truncated: boolean }

const MAX_EXPANDED_NODES = 32;
const MAX_EXPANDED_EDGES = 64;

function intersectionPoint(node: NonNullable<ReturnType<typeof useInternalNode>>, target: NonNullable<ReturnType<typeof useInternalNode>>) {
  const width = node.measured.width ?? node.width ?? 1;
  const height = node.measured.height ?? node.height ?? 1;
  const targetWidth = target.measured.width ?? target.width ?? 1;
  const targetHeight = target.measured.height ?? target.height ?? 1;
  const x2 = node.internals.positionAbsolute.x + width / 2;
  const y2 = node.internals.positionAbsolute.y + height / 2;
  const dx = target.internals.positionAbsolute.x + targetWidth / 2 - x2;
  const dy = target.internals.positionAbsolute.y + targetHeight / 2 - y2;
  const scale = 1 / (2 * Math.max(Math.abs(dx) / width, Math.abs(dy) / height) || 1);
  return { x: x2 + dx * scale, y: y2 + dy * scale };
}

function intersectionSide(node: NonNullable<ReturnType<typeof useInternalNode>>, point: { x: number; y: number }): Position {
  const { x, y } = node.internals.positionAbsolute;
  const width = node.measured.width ?? node.width ?? 1;
  const height = node.measured.height ?? node.height ?? 1;
  const distances = [
    { side: Position.Left, distance: Math.abs(point.x - x) },
    { side: Position.Right, distance: Math.abs(point.x - (x + width)) },
    { side: Position.Top, distance: Math.abs(point.y - y) },
    { side: Position.Bottom, distance: Math.abs(point.y - (y + height)) },
  ];
  return distances.reduce((closest, current) => current.distance < closest.distance ? current : closest).side;
}

function FloatingEdge({ id, source, target, sourceX, sourceY, targetX, targetY, markerEnd, style }: EdgeProps) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (sourceNode === undefined || targetNode === undefined || sourceNode.measured.width === undefined || targetNode.measured.width === undefined) {
    return <BaseEdge id={id} path={getBezierPath({ sourceX, sourceY, targetX, targetY })[0]}
      {...(markerEnd === undefined ? {} : { markerEnd })} style={style} />;
  }
  const sourcePoint = intersectionPoint(sourceNode, targetNode);
  const targetPoint = intersectionPoint(targetNode, sourceNode);
  const path = getBezierPath({ sourceX: sourcePoint.x, sourceY: sourcePoint.y, sourcePosition: intersectionSide(sourceNode, sourcePoint),
    targetX: targetPoint.x, targetY: targetPoint.y, targetPosition: intersectionSide(targetNode, targetPoint) })[0];
  return <BaseEdge id={id} path={path} {...(markerEnd === undefined ? {} : { markerEnd })} style={style} />;
}

const edgeTypes = { floating: FloatingEdge };

function SyncSelectedNodes({ ids }: { readonly ids: readonly string[] }) {
  const flow = useReactFlow();
  const flowRef = useRef(flow);
  flowRef.current = flow;
  useEffect(() => {
    flowRef.current.setNodes((nodes) => {
      let changed = false;
      const selected = new Set(ids);
      const next = nodes.map((node) => {
        const isSelected = selected.has(node.id);
        if (node.selected === isSelected && node.domAttributes?.["aria-pressed"] === isSelected) return node;
        changed = true;
        return { ...node, selected: isSelected, domAttributes: { ...node.domAttributes, "aria-pressed": isSelected } };
      });
      return changed ? next : nodes;
    });
  }, [ids]);
  return null;
}

function nodeKind(n: WorkNode): "task" | "document" | "test" | "file" | "symbol" | "worktree" | "other" {
  if (n.type === "task" || n.type === "worktree" || n.type === "symbol") return n.type;
  const p = n.source?.path ?? (n.type === "file" ? n.label : "");
  if (p.startsWith("specs/") || /(?:^|\/)docs\//u.test(p) || /\.md$/iu.test(p)) return "document";
  if (/(?:__tests__|\.test\.|\.spec\.)/u.test(p)) return "test";
  if (n.type === "file") return "file";
  return "other";
}

function nodeTitle(n: WorkNode): string {
  if (n.type === "task" || n.type === "worktree" || n.type === "symbol") return n.label;
  const path = n.source?.path ?? n.label;
  return path.split("/").at(-1) ?? path;
}

function nodeSubtitle(n: WorkNode): string | undefined {
  if (n.type === "task") return n.status === "disconnected" ? t("text.Session disconnected") : n.status === "completed" ? t("text.Completed") : t("text.Working now");
  if (n.type === "worktree") return n.branch;
  const path = n.source?.path;
  if (path === undefined) return n.type;
  const slash = path.lastIndexOf("/");
  return slash < 0 ? undefined : path.slice(0, slash);
}

function edgeKey(e: WorkEdge): string { return `${e.from}:${e.type}:${e.to}`; }

function placement(nodes: readonly WorkNode[], edges: readonly WorkEdge[], selected: string | null,
  savedPositions: ReadonlyMap<string, { readonly x: number; readonly y: number }>): { nodes: Node[]; treeEdges: ReadonlySet<string> } {
  const focus = `task:${selected}`;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, { id: string; edge: WorkEdge }[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    adjacency.get(edge.from)?.push({ id: edge.to, edge });
    adjacency.get(edge.to)?.push({ id: edge.from, edge });
  }
  const priority = (type: string) => type === "task" ? 0 : type === "worktree" ? 1 : 2;
  for (const neighbours of adjacency.values()) neighbours.sort((a, b) =>
    priority(byId.get(a.id)?.type ?? "") - priority(byId.get(b.id)?.type ?? "") ||
    (byId.get(a.id)?.label ?? a.id).localeCompare(byId.get(b.id)?.label ?? b.id));

  const roots = [focus, ...nodes.filter((node) => node.id !== focus && node.type === "task").map((node) => node.id),
    ...nodes.map((node) => node.id)].filter((id, index, all) => byId.has(id) && all.indexOf(id) === index);
  const depth = new Map<string, number>();
  const children = new Map<string, string[]>();
  const treeEdges = new Set<string>();
  for (const root of roots) {
    if (depth.has(root)) continue;
    depth.set(root, root === focus ? 0 : 0);
    const queue = [root];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const parent = queue[cursor]!;
      for (const neighbour of adjacency.get(parent) ?? []) {
        if (depth.has(neighbour.id)) continue;
        depth.set(neighbour.id, depth.get(parent)! + 1);
        children.set(parent, [...(children.get(parent) ?? []), neighbour.id]);
        treeEdges.add(edgeKey(neighbour.edge));
        queue.push(neighbour.id);
      }
    }
  }

  const positions = new Map<string, { x: number; y: number }>();
  let nextY = 32;
  const place = (id: string): number => {
    const descendants = children.get(id) ?? [];
    const childYs = descendants.map(place);
    const y = childYs.length === 0 ? nextY : childYs.reduce((sum, value) => sum + value, 0) / childYs.length;
    if (childYs.length === 0) nextY += 144;
    positions.set(id, { x: (depth.get(id) ?? 0) * 340 + 32, y });
    return y;
  };
  for (const root of roots) if (!depth.has(root) || (depth.get(root) === 0 && !positions.has(root))) place(root);
  return { nodes: nodes.map((n) => {
    const kind = nodeKind(n);
    const active = n.id === focus;
    const muted = n.type === "task" && !active;
    return {
      id: n.id, position: savedPositions.get(n.id) ?? positions.get(n.id) ?? { x: 32, y: nextY }, draggable: true, selectable: true,
      className: `work-node work-node--${kind}${active ? " work-node--focus" : ""}${muted ? " work-node--muted" : ""}`,
      ariaRole: "button", domAttributes: { "aria-pressed": false },
      style: { width: n.type === "task" ? 270 : 248 },
      data: { label: <div className="work-node-body" title={n.label}>
        <div className="work-node-top"><span className="work-node-dot" /><span>{kind === "task" ? t("text.AGENT WORK") : kind.toUpperCase()}</span>{active ? <span className="work-node-live">{t("work.current")}</span> : null}</div>
        <div className="work-node-title">{nodeTitle(n)}</div>
        {nodeSubtitle(n) === undefined ? null : <div className="work-node-subtitle">{nodeSubtitle(n)}</div>}
      </div> },
    };
  }), treeEdges };
}

export function WorkPage() {
  const { i18n: translation } = useTranslation();
  const language = translation.resolvedLanguage;
  const [selectedTask, setSelectedTask] = useState<string | undefined>();
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectionTouched, setSelectionTouched] = useState(false);
  const lastActivatedNode = useRef<string | undefined>(undefined);
  const draggedPositions = useRef(new Map<string, { x: number; y: number }>());
  const viewport = useRef<{ x: number; y: number; zoom: number } | undefined>(undefined);
  const [agent, setAgent] = useState("Codex");
  const [name, setName] = useState("");
  const [issueId, setIssueId] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [expanded, setExpanded] = useState<{ readonly nodes: readonly WorkNode[]; readonly edges: readonly WorkEdge[]; readonly truncated: boolean }>({ nodes: [], edges: [], truncated: false });
  const [expandDepth, setExpandDepth] = useState(1);
  const [load, setLoad] = useState<Load<WorkMap>>({ state: "loading" });
  const [reconnecting, setReconnecting] = useState(false);
  const [verificationFailed, setVerificationFailed] = useState(false);
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
  const selected = map?.selectedTaskId ?? null;
  const lastFocus = useRef<string | null>(null);
  if (selected !== lastFocus.current) { viewport.current = undefined; lastFocus.current = selected; }
  const visibleNodes = useMemo(() => [...new Map([...(map?.nodes ?? []), ...expanded.nodes].map((n) => [n.id, n])).values()], [map, expanded]);
  const visibleEdges = useMemo(() => [...new Map([...(map?.edges ?? []), ...expanded.edges].map((e) => [`${e.from}:${e.type}:${e.to}`, e])).values()], [map, expanded]);
  const layout = useMemo(() => placement(visibleNodes, visibleEdges, selected, draggedPositions.current), [visibleNodes, visibleEdges, selected, language]);
  const preferredNodeId = lastActivatedNode.current;
  const selectedNodeId = preferredNodeId !== undefined && selectedNodeIds.includes(preferredNodeId)
    ? preferredNodeId
    : [...selectedNodeIds].sort((a, b) => a.localeCompare(b))[0];
  const detail = visibleNodes.find((node) => node.id === selectedNodeId) ??
    (selectionTouched ? undefined : visibleNodes.find((node) => node.id === `task:${selected}`));
  const connections = detail === undefined ? [] : visibleEdges.filter((e) => e.from === detail.id || e.to === detail.id);
  const taskCount = visibleNodes.filter((n) => n.type === "task").length;
  const contextCount = visibleNodes.filter((n) => n.type !== "task" && n.type !== "worktree").length;
  const updateNodeSelection = (ids: string[]) => {
    const normalized = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
    setSelectedNodeIds((current) => current.length === normalized.length && current.every((id) => normalized.includes(id)) ? current : normalized);
  };
  const selectNode = (id: string, extend = false) => {
    const node = visibleNodes.find((candidate) => candidate.id === id);
    if (node === undefined) return;
    const removing = extend && selectedNodeIds.includes(id);
    const nextIds = extend ? removing ? selectedNodeIds.filter((selectedId) => selectedId !== id) : [...selectedNodeIds, id] : [id];
    lastActivatedNode.current = removing ? undefined : id;
    setSelectionTouched(true);
    updateNodeSelection(nextIds);
    if (node.type === "task" && !removing) {
      viewport.current = undefined;
      setSelectedTask(id.slice(5));
      setExpanded({ nodes: [], edges: [], truncated: false });
    }
  };
  const clearNodeSelection = () => {
    lastActivatedNode.current = undefined;
    setSelectionTouched(true);
    updateNodeSelection([]);
  };
  useEffect(() => {
    const available = new Set(visibleNodes.map((node) => node.id));
    const nextIds = selectedNodeIds.filter((id) => available.has(id));
    if (nextIds.length !== selectedNodeIds.length) {
      setSelectedNodeIds(nextIds);
      if (!nextIds.includes(lastActivatedNode.current ?? "")) lastActivatedNode.current = undefined;
    }
  }, [visibleNodes, selectedNodeIds]);
  const focusPosition = layout.nodes.find((node) => node.id === `task:${selected}`)?.position;
  const initialViewport = viewport.current ?? { x: 90 - (focusPosition?.x ?? 32) * 0.7,
    y: 180 - (focusPosition?.y ?? 32) * 0.7, zoom: 0.7 };
  const graphKey = `${language}:${map?.revision ?? "loading"}:${selected ?? ""}:${expanded.nodes.map((n) => n.id).join(",")}:${expanded.edges.map((e) => `${e.from}:${e.type}:${e.to}`).join(",")}`;
  const edges = useMemo<Edge[]>(() => visibleEdges.map((e, i) => {
    const tree = layout.treeEdges.has(edgeKey(e));
    return ({
    id: `${e.from}:${e.type}:${e.to}:${i}`, source: e.from, target: e.to,
    animated: false, type: "floating",
    style: { stroke: tree ? "#777ce5" : "#a6b4c4", strokeWidth: tree ? 2 : 1.25,
      strokeDasharray: tree ? (e.source === "context" ? "5 4" : undefined) : "4 5", opacity: tree ? 0.82 : 0.3 },
  }); }), [visibleEdges, layout]);
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true); setSaveError(undefined);
    try {
      const result = await api.post<{ task: Task }>("/api/work-tasks", { agent: agent.trim(), name: name.trim(), ...(issueId.trim() ? { issueId: issueId.trim() } : {}) });
      setName(""); setIssueId(""); viewport.current = undefined; setSelectedTask(result.data.task.id);
    } catch (error) { setSaveError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }

  return <div className="work-page"><Page title={t("work.work_map")} onRefresh={reload}>
    <p className="work-intro">{t("work.follow_the_work_in_progress_and_the")}</p>
    {verificationFailed ? <p role="status" className="box box-warn">{t("text.Unable to check for updates. The displayed information may be out of date. Use Refresh to try again.")}</p>
      : reconnecting ? <p role="status" className="box box-warn">{t("text.Live connection interrupted. Reconnecting; updates are still checked periodically.")}</p> : null}
    <form className="form work-form" onSubmit={(e) => { void add(e); }}>
      <label>{t("form.agent")} <input value={agent} onChange={(e) => setAgent(e.target.value)} maxLength={80} required /></label>
      <label>{t("form.work_name")} <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required size={30} /></label>
      <label>{t("form.issue_id")} <input value={issueId} onChange={(e) => setIssueId(e.target.value)} placeholder="AUTH-7" size={14} /></label>
      <button type="submit" disabled={saving}>{t("work.add_work")}</button>
    </form>
    {saveError === undefined ? null : <p role="alert" className="box box-error">{saveError}</p>}
    {load.state === "loading" ? <Loading /> : load.state === "error" ? <ErrorBox error={load.error} /> : !map?.nodes.some((n) => n.type === "task")
      ? <Empty>{t("work.add_a_work_item_to_explore_its")}</Empty> : <>
        <div className="work-summary" aria-live="polite">
          <span><Trans i18nKey="work.work_items" components={{ c0: <strong />, v1: <>{String((taskCount) ?? "")}</> }} /></span><span><Trans i18nKey="work.context_nodes" components={{ c0: <strong />, v1: <>{String((contextCount) ?? "")}</> }} /></span><span><Trans i18nKey="work.links" components={{ c0: <strong />, v1: <>{String((visibleEdges.length) ?? "")}</> }} /></span>
          <span className={`work-index ${map?.indexStatus === "current" ? "work-index--current" : ""}`}><Trans i18nKey="work.index" components={{ v0: <>{map?.indexStatus}</> }} /></span>
          {map?.truncated || expanded.truncated ? <span>{t("work.some_relations_omitted")}</span> : null}
        </div>
        {map?.indexStatus === "current" ? null : <p className="box box-warn"><Trans i18nKey="work.stale_hint" components={{ c0: <code /> }} /></p>}
        <div className="work-layout">
          <div className="work-graph-panel">
            <div className="work-graph-head"><div><strong>{t("work.relationship_map")}</strong><p>{t("work.selected_work_is_the_tree_root_drag")}</p></div>
              <div className="work-legend"><span className="work-legend-task">{t("work.work")}</span><span className="work-legend-document">{t("work.document")}</span><span className="work-legend-file">{t("work.code")}</span><span className="work-legend-test">{t("work.test")}</span></div>
            </div>
            <div className="work-canvas" role="region" aria-label={t("work.work_and_duo_relationship_graph")}
              onKeyDownCapture={(event) => {
                const target = event.target;
                const node = target instanceof Element ? target.closest<HTMLElement>(".react-flow__node") : null;
                if (node?.dataset.id === undefined || (event.key !== "Enter" && event.key !== " ")) return;
                event.preventDefault();
                selectNode(node.dataset.id, event.shiftKey || event.ctrlKey || event.metaKey);
              }}>
            <ReactFlow key={graphKey} defaultNodes={layout.nodes} defaultEdges={edges} edgeTypes={edgeTypes}
              ariaLabelConfig={{
                "controls.ariaLabel": t("flow.controls"), "controls.zoomIn.ariaLabel": t("flow.zoom_in"),
                "controls.zoomOut.ariaLabel": t("flow.zoom_out"), "controls.fitView.ariaLabel": t("flow.fit_view"),
                "controls.interactive.ariaLabel": t("flow.interactive"), "minimap.ariaLabel": t("flow.minimap"),
                "handle.ariaLabel": t("flow.handle"), "node.a11yDescription.default": t("flow.node_help"),
                "node.a11yDescription.keyboardDisabled": t("flow.node_keyboard_help"),
                "edge.a11yDescription.default": t("flow.edge_help"),
                "node.a11yDescription.ariaLiveMessage": ({ direction, x, y }) => t("flow.moved", { direction: t(`flow.${direction}`), x, y }),
              }}
              fitView={visibleNodes.length <= 12} defaultViewport={initialViewport}
              fitViewOptions={{ padding: 0.16, maxZoom: 0.9 }} minZoom={0.08} maxZoom={1.5} nodesConnectable={false}
              zoomOnScroll={false} preventScrolling={false}
              onMoveEnd={(_event, next) => { viewport.current = next; }}
              onNodeDragStop={(_event, node) => { draggedPositions.current.set(node.id, node.position); }}
              onNodeClick={(event, node) => selectNode(node.id, event.shiftKey || event.ctrlKey || event.metaKey)}
              onPaneClick={clearNodeSelection}>
              <SyncSelectedNodes ids={selectedNodeIds} />
              <Background variant={BackgroundVariant.Dots} gap={24} size={1} /><Controls showInteractive={false} />
              <MiniMap position="bottom-right" style={{ width: 190, height: 132 }} pannable zoomable
                nodeColor={(n) => n.className?.includes("work-node--focus") ? "#5d63de"
                : n.className?.includes("work-node--document") ? "#d99642" : "#8fa8bf"} />
            </ReactFlow>
            </div>
          </div>
          <aside className="work-detail" aria-label={t("work.selected_node_detail")}>
            {detail === undefined ? <p className="muted">{t("work.select_a_node_to_inspect_its_source")}</p> : <>
              <div className="work-detail-kicker"><Trans i18nKey="work.selected" components={{ v0: <>{nodeKind(detail).toUpperCase()}</> }} /></div>
              <h2>{detail.label}</h2>
              <div className="work-detail-meta">
                {detail.status === undefined ? null : <span>{detail.status}</span>}
                {detail.updatedAt === undefined ? null : <span><Trans i18nKey="work.observed" components={{ v0: <>{new Date(detail.updatedAt).toLocaleString(i18n.resolvedLanguage === "ko" ? "ko-KR" : "en-US")}</> }} /></span>}
                {detail.branch === undefined ? null : <span><Trans i18nKey="work.branch" components={{ v0: <>{detail.branch}</> }} /></span>}
              </div>
              {detail.worktreeId === undefined ? null : <p className="work-detail-path"><Trans i18nKey="work.worktree" components={{ c0: <code />, v1: <>{detail.worktreeId}</> }} /></p>}
              {detail.targetRef === undefined ? null : <p className="work-detail-path"><Trans i18nKey="work.target" components={{ c0: <Link to={`/entity/${encodeURIComponent(detail.targetRef)}`} children={null} />, v1: <>{detail.targetRef}</> }} /></p>}
              {detail.review === undefined ? null : <p className="work-detail-path"><Trans i18nKey="work.review_claims" components={{ v0: <>{detail.review.verdict ?? t("text.unrated")}</>, v1: <>{String((detail.review.claimCount) ?? "")}</>, c2: <code />, v3: <>{detail.review.digest}</> }} /></p>}
              {detail.source === undefined ? null : <p className="work-detail-path"><Trans i18nKey="work.source" components={{ c0: <code />, v1: <>{detail.source.path}</>, v2: <>{detail.source.startLine === undefined ? "" : `:${detail.source.startLine}`}</> }} /></p>}
              {detail.ref === undefined || detail.type === "task" ? null : <p><Link to={`/entity/${encodeURIComponent(detail.ref)}`}>{t("work.open_duo_detail")}</Link></p>}
              <h3><Trans i18nKey="work.connections" components={{ c0: <span />, v1: <>{String((connections.length) ?? "")}</> }} /></h3>
              <ul className="work-connections">{connections.map((e, i) => {
                const other = visibleNodes.find((n) => n.id === (e.from === detail.id ? e.to : e.from));
                return <li key={i}><button className="work-connection" type="button" onClick={() => {
                  if (other === undefined) return;
                  selectNode(other.id);
                }}><span>{e.type}</span><strong>{other?.label ?? t("text.Unknown node")}</strong></button></li>;
              })}</ul>
              {detail.type === "task" ? null : <div className="actions">
                <label><Trans i18nKey="work.depth" components={{ c0: <select value={expandDepth} onChange={(e) => setExpandDepth(Number(e.target.value))} />, v1: <>{[1, 2, 3].map((depth) => <option key={depth} value={depth}>{depth}</option>)}</> }} /></label>
                <button type="button" className="secondary" onClick={() => {
                  void api.get<{ nodes: WorkNode[]; edges: WorkEdge[]; truncated: boolean }>(`/api/work-expand?${q({ node: detail.id, depth: expandDepth })}`)
                    .then((r) => setExpanded((old) => {
                      const baseIds = new Set((map?.nodes ?? []).map((node) => node.id));
                      const knownIds = new Set([...baseIds, ...old.nodes.map((node) => node.id)]);
                      const newNodes = r.data.nodes.filter((node) => !knownIds.has(node.id));
                      const currentExpandedNodes = old.nodes.filter((node) => !baseIds.has(node.id)).length;
                      const acceptedNodes = newNodes.slice(0, Math.max(0, MAX_EXPANDED_NODES - currentExpandedNodes));
                      const visibleIds = new Set([...knownIds, ...acceptedNodes.map((node) => node.id)]);
                      const knownEdges = new Set(old.edges.map((edge) => `${edge.from}:${edge.type}:${edge.to}`));
                      const newEdges = r.data.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to) &&
                        !knownEdges.has(`${edge.from}:${edge.type}:${edge.to}`));
                      const acceptedEdges = newEdges.slice(0, Math.max(0, MAX_EXPANDED_EDGES - old.edges.length));
                      const capped = acceptedNodes.length < newNodes.length || acceptedEdges.length < newEdges.length;
                      return { nodes: [...old.nodes, ...acceptedNodes], edges: [...old.edges, ...acceptedEdges],
                        truncated: old.truncated || r.data.truncated || capped };
                    }))
                    .catch((error: unknown) => setSaveError(error instanceof Error ? error.message : String(error)));
                }}>{t("work.expand_neighbours")}</button>
              </div>}
              {detail.type !== "task" ? null : <button className="secondary" type="button" onClick={() => {
                const id = detail.id.slice(5);
                void api.post("/api/work-task-complete", { id }).then(() => {
                  clearNodeSelection();
                  if (selectedTask === undefined) reload(); else setSelectedTask(undefined);
                });
              }}>{t("work.mark_completed")}</button>}
            </>}
          </aside>
        </div>
      </>}
    </Page></div>;
}
