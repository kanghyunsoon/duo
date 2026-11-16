/** Small, regenerable projection for the local work map. Source text stays in DUO. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { definitionRef, fileRef, guardWrite, nodeId, parseNodeId, STATE_DIR_NAME, symlinkOnPath, type RepoPath } from "@duo-director/core";
import { redactSecrets } from "@duo-director/director";
import { GRAPH_REVISION_KEY, inspectIndex, traverse } from "@duo-director/graph";
import { projectContext } from "../operations/context.js";
import { withGraphReader, type OperationOptions } from "../operations/common.js";

const TASKS = `${STATE_DIR_NAME}/runtime/work-tasks.json`;
const TASK_LOCK = `${STATE_DIR_NAME}/runtime/work-tasks.lock`;
const MAP = `${STATE_DIR_NAME}/cache/work-map.json`;
const MAX_TASK_BYTES = 128 * 1024;
const MAX_NODES = 120;
const MAX_TASK_NODES = 60;
const EXPANSION_NODE_LIMITS = { 1: 8, 2: 16, 3: 24 } as const;
const indexStatusCache = new Map<string, { key: string; status: string }>();

/**
 * #84: task names and agent labels are display text. Known credential formats (the Context Packet redaction set) are
 * replaced before they reach work-tasks.json, the work-map cache or the UI. The MCP task key is still the hash of the
 * unredacted task text, so session matching does not change.
 */
const redactLabel = (text: string): string => redactSecrets(text).text;

/** True when a stored task file still needs a rewrite: a v1 array, or a name or agent label that redaction would change. */
function needsRewrite(raw: unknown): boolean {
  if (Array.isArray(raw)) return true;
  const rows = typeof raw === "object" && raw !== null && "tasks" in raw && Array.isArray(raw.tasks) ? raw.tasks as unknown[] : [];
  return rows.some((row) => typeof row === "object" && row !== null && (["name", "agent"] as const).some((field) => {
    const value = (row as Record<string, unknown>)[field];
    return typeof value === "string" && redactLabel(value) !== value;
  }));
}

/** Small freshness token: task data, indexed graph revision and working-tree file metadata. */
async function workMapRevisions(root: string): Promise<{ revision: string; sourceRevision: string }> {
  const hash = createHash("sha256");
  const graphRevision = await withGraphReader(root, async (graph) => graph.readMeta(GRAPH_REVISION_KEY) ?? "missing");
  hash.update(`\0graph:${graphRevision}`);
  // Truth files can be ignored by Git; cover missed watcher events without reading their contents.
  const truthRoot = path.join(root, STATE_DIR_NAME);
  if (fs.existsSync(truthRoot) && symlinkOnPath(root, STATE_DIR_NAME) === undefined) {
    const visit = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (dir === truthRoot && ["cache", "runtime", "generated"].includes(entry.name)) continue;
        const absolute = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) visit(absolute);
        else if (entry.isFile()) {
          const stat = fs.statSync(absolute);
          hash.update(`${path.relative(truthRoot, absolute)}:${stat.size}:${stat.mtimeMs}\0`);
        }
      }
    };
    visit(truthRoot);
  }
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
    hash.update(git("rev-parse", "HEAD"));
    hash.update(git("branch", "--show-current"));
    const changed = git("status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".", `:(exclude)${STATE_DIR_NAME}`);
    hash.update(changed);
    // A dirty path stays in git status across edits; its metadata detects subsequent saves.
    for (const entry of changed.toString("utf8").split("\0")) {
      if (entry.length < 4) continue;
      const relative = entry.slice(3);
      const target = path.resolve(root, relative);
      if (!target.startsWith(`${root}${path.sep}`)) continue;
      try {
        const stat = fs.lstatSync(target);
        hash.update(`${relative}:${stat.size}:${stat.mtimeMs}`);
      } catch { hash.update(`${relative}:missing`); }
    }
  } catch { hash.update("\0git-unavailable"); }
  const sourceRevision = hash.digest("hex").slice(0, 24);
  const taskHash = createHash("sha256").update(sourceRevision);
  const taskFile = path.join(root, TASKS);
  if (fs.existsSync(taskFile) && symlinkOnPath(root, TASKS) === undefined) taskHash.update(fs.readFileSync(taskFile));
  return { revision: taskHash.digest("hex").slice(0, 24), sourceRevision };
}

export async function workMapRevision(root: string): Promise<string> { return (await workMapRevisions(root)).revision; }

export interface WorkTask {
  readonly id: string;
  readonly agent: string;
  readonly name: string;
  readonly issueId?: string;
  readonly targetRef?: string;
  readonly duoSessionId?: string;
  /** Hash of the full task text; distinguishes tasks with the same display name. */
  readonly taskKey?: string;
  readonly worktreeId?: string;
  readonly identitySource?: "duo" | "manual" | "legacy";
  readonly startedAt?: string;
  readonly review?: { readonly digest: string; readonly verdict?: string; readonly claimCount: number; readonly observedAt: string };
  readonly updatedAt: string;
  readonly status: "active" | "disconnected" | "completed";
}

export interface WorkMapNode {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly ref?: string;
  readonly updatedAt?: string;
  readonly status?: WorkTask["status"];
  readonly worktreeId?: string;
  readonly branch?: string;
  readonly targetRef?: string;
  readonly review?: WorkTask["review"];
  readonly source?: { readonly path: string; readonly startLine?: number };
}

export interface WorkMapEdge {
  readonly from: string;
  readonly to: string;
  readonly type: string;
  readonly source: "duo" | "issue" | "context" | "git" | "review";
}

function readJson(root: string, file: string): unknown {
  const target = path.join(root, file);
  if (!fs.existsSync(target)) return undefined;
  if (symlinkOnPath(root, file) !== undefined) throw new Error(`Refusing symlink ${file}`);
  if (fs.statSync(target).size > 128 * 1024) throw new Error(`Work data exceeds 128 KiB: ${file}`);
  return JSON.parse(fs.readFileSync(target, "utf8")) as unknown;
}

function writeJson(root: string, file: string, value: unknown): void {
  const guarded = guardWrite(root, file, "regenerable");
  if (guarded.value === undefined) throw new Error(guarded.diagnostics.map((d) => d.message).join("; "));
  const target = guarded.value.absolute;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value), "utf8");
    fs.renameSync(temp, target);
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }
}

/** A short cross-process lock prevents parallel MCP connections from overwriting each other. */
function withTaskLock<T>(root: string, operation: () => T, maxWaitMs = 5000): T {
  const guarded = guardWrite(root, TASK_LOCK, "regenerable");
  if (guarded.value === undefined) throw new Error(guarded.diagnostics.map((d) => d.message).join("; "));
  const target = guarded.value.absolute;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const started = Date.now();
  let descriptor: number | undefined;
  while (descriptor === undefined) {
    try { descriptor = fs.openSync(target, "wx"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stat: fs.Stats;
      try { stat = fs.lstatSync(target); }
      catch (race) { if ((race as NodeJS.ErrnoException).code === "ENOENT") continue; throw race; }
      if (stat.isSymbolicLink()) throw new Error("Refusing symlink work task lock", { cause: error });
      if (Date.now() - stat.mtimeMs > 30_000) { fs.rmSync(target); continue; }
      const remaining = maxWaitMs - (Date.now() - started);
      if (remaining <= 0) throw new Error(`Timed out waiting for work task lock after ${Date.now() - started} ms (limit ${maxWaitMs} ms)`, { cause: error });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(20, remaining));
    }
  }
  try { return operation(); }
  finally { fs.closeSync(descriptor); fs.rmSync(target, { force: true }); }
}

function readTasks(root: string): WorkTask[] {
  const raw = readJson(root, TASKS);
  const rows = Array.isArray(raw) ? raw : typeof raw === "object" && raw !== null && "tasks" in raw && Array.isArray(raw.tasks) ? raw.tasks : [];
  const tasks = rows.filter((x): x is WorkTask => typeof x === "object" && x !== null &&
    typeof x.id === "string" && typeof x.agent === "string" && typeof x.name === "string" &&
    typeof x.updatedAt === "string" && (x.status === "active" || x.status === "disconnected" || x.status === "completed"))
    .map((task) => ({ ...task, agent: redactLabel(task.agent), name: redactLabel(task.name), identitySource: task.identitySource ?? "legacy" }));
  return tasks;
}

/**
 * Tasks for the map. A v1 array is migrated, and a file written before #84 that still holds a credential in a name or
 * agent label is rewritten with the redacted labels, under the task lock. IDs, task keys and status are kept.
 */
export function listWorkTasks(root: string): WorkTask[] {
  const raw = readJson(root, TASKS);
  if (!needsRewrite(raw)) return readTasks(root);
  return withTaskLock(root, () => {
    const latest = readJson(root, TASKS);
    const tasks = readTasks(root);
    if (needsRewrite(latest)) saveTasks(root, tasks);
    return tasks;
  });
}

export function worktreeId(root: string): string { return createHash("sha256").update(fs.realpathSync(root)).digest("hex").slice(0, 16); }

function changedWorkFiles(root: string): string[] {
  try {
    const raw = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".", `:(exclude)${STATE_DIR_NAME}`],
      { cwd: root, windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 }).toString("utf8");
    return [...new Set(raw.split("\0").filter((entry) => entry.length >= 4).map((entry) => entry.slice(3)))]
      .filter((p) => !p.startsWith("../") && !path.isAbsolute(p)).slice(0, 20);
  } catch { return []; }
}

function branchName(root: string): string {
  try { return execFileSync("git", ["branch", "--show-current"], { cwd: root, windowsHide: true, timeout: 5000 }).toString("utf8").trim() || "detached"; }
  catch { return "unknown"; }
}

function saveTasks(root: string, tasks: WorkTask[]): void {
  const retained = [...tasks];
  const size = () => Buffer.byteLength(JSON.stringify({ format: "duo.work-tasks/2", tasks: retained }));
  while (size() > MAX_TASK_BYTES) {
    const oldest = (status: WorkTask["status"]) => retained.reduce((index, task, i) => task.status === status &&
      (index < 0 || task.updatedAt < (retained[index] as WorkTask).updatedAt) ? i : index, -1);
    const complete = oldest("completed");
    const remove = complete >= 0 ? complete : oldest("disconnected");
    if (remove < 0) throw new Error("Active work exceeds the 128 KiB local task limit");
    retained.splice(remove, 1);
  }
  writeJson(root, TASKS, { format: "duo.work-tasks/2", tasks: retained });
}

export function addWorkTask(root: string, input: { agent: string; name: string; issueId?: string }, now: Date): WorkTask {
  return withTaskLock(root, () => {
    const tasks = readTasks(root);
    const task: WorkTask = { id: randomUUID(), agent: redactLabel(input.agent), name: redactLabel(input.name),
      ...(input.issueId === undefined ? {} : { issueId: input.issueId, targetRef: nodeId(definitionRef("issue", input.issueId)) }),
      identitySource: "manual", worktreeId: worktreeId(root), startedAt: now.toISOString(), updatedAt: now.toISOString(), status: "active" };
    saveTasks(root, [...tasks, task]);
    return task;
  });
}

/** Existing MCP calls surface work without another agent tool call. */
export function touchWorkTask(root: string, agent: string, taskText: string, now: Date,
  identity?: { readonly duoSessionId: string; readonly targetRef?: string }, lockWaitMs = 5000): WorkTask | undefined {
  const normalizedTask = taskText.replace(/\r\n?/gu, "\n").trim();
  // Redact the whole first line before cutting it to 200 characters, so a credential across the cut is not left partly visible.
  const firstLine = normalizedTask.split("\n")[0]?.trim();
  const name = firstLine === undefined ? undefined : redactLabel(firstLine).slice(0, 200);
  if (name === undefined || name === "") return undefined;
  const safeAgent = redactLabel(agent.trim()).slice(0, 80) || "Agent";
  return withTaskLock(root, () => {
    const tasks = readTasks(root);
    const taskKey = identity === undefined ? undefined
      : createHash("sha256").update(`${identity.duoSessionId}\0${normalizedTask}`).digest("hex");
    const matching = identity === undefined ? tasks.filter((t) => t.status === "active" && t.agent === safeAgent && t.name === name)
      : tasks.filter((t) => t.status === "active" && t.duoSessionId === identity.duoSessionId && t.taskKey === taskKey);
    if (matching.length > 1) throw new Error("Multiple active work tasks share the same session and task identity");
    const current = matching[0];
    if (current === undefined) {
      const task: WorkTask = { id: randomUUID(), agent: safeAgent, name,
        ...(identity === undefined ? { identitySource: "legacy" as const } : { identitySource: "duo" as const, duoSessionId: identity.duoSessionId,
          ...(taskKey === undefined ? {} : { taskKey }), ...(identity.targetRef === undefined ? {} : { targetRef: identity.targetRef }) }),
        worktreeId: worktreeId(root), startedAt: now.toISOString(), updatedAt: now.toISOString(), status: "active" };
      saveTasks(root, [...tasks, task]);
      return task;
    }
    const updated: WorkTask = { ...current, name, ...(taskKey === undefined ? {} : { taskKey }),
      ...(identity?.targetRef === undefined ? {} : { targetRef: identity.targetRef }),
      updatedAt: now.toISOString(), status: "active" };
    saveTasks(root, tasks.map((t) => t.id === current.id ? updated : t));
    return updated;
  }, lockWaitMs);
}

export function recordWorkReview(root: string, duoSessionId: string, taskId: string,
  review: { readonly digest: string; readonly verdict?: string; readonly claimCount: number }, now: Date, lockWaitMs = 5000): void {
  withTaskLock(root, () => {
    const tasks = readTasks(root);
    const current = tasks.find((t) => t.id === taskId && t.duoSessionId === duoSessionId && t.status === "active");
    if (current === undefined) return;
    saveTasks(root, tasks.map((t) => t.id === current.id ? { ...t,
      review: { ...review, observedAt: now.toISOString() }, updatedAt: now.toISOString() } : t));
  }, lockWaitMs);
}

export function disconnectWorkSession(root: string, duoSessionId: string, now: Date, lockWaitMs = 5000): void {
  withTaskLock(root, () => {
    const tasks = readTasks(root);
    if (!tasks.some((t) => t.duoSessionId === duoSessionId && t.status === "active")) return;
    saveTasks(root, tasks.map((t) => t.duoSessionId === duoSessionId && t.status === "active"
      ? { ...t, status: "disconnected", updatedAt: now.toISOString() } : t));
  }, lockWaitMs);
}

export function completeWorkTask(root: string, id: string, now: Date): WorkTask | undefined {
  return withTaskLock(root, () => {
    const tasks = readTasks(root);
    const current = tasks.find((t) => t.id === id);
    if (current === undefined) return undefined;
    const completed: WorkTask = { ...current, status: "completed", updatedAt: now.toISOString() };
    saveTasks(root, tasks.map((t) => t.id === id ? completed : t));
    return completed;
  });
}

export async function projectWorkMap(root: string, selectedId: string | undefined, options: OperationOptions = {}) {
  // Never pair a newer revision with nodes read before a concurrent task write.
  const { revision, sourceRevision } = await workMapRevisions(root);
  const tasks = listWorkTasks(root);
  const open = tasks.filter((t) => t.status !== "completed");
  const selected = open.find((t) => t.id === selectedId) ?? open.map((task, index) => ({ task, index })).sort((a, b) =>
    Number(b.task.status === "active") - Number(a.task.status === "active") ||
    b.task.updatedAt.localeCompare(a.task.updatedAt) || b.index - a.index)[0]?.task;
  const currentWorktree = worktreeId(root);
  const branch = branchName(root);
  const shown = [...open].sort((a, b) => Number(b.status === "active") - Number(a.status === "active") ||
    b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_TASK_NODES);
  if (selected !== undefined && !shown.some((t) => t.id === selected.id)) shown[shown.length - 1] = selected;
  const nodes: WorkMapNode[] = shown.map((t) => ({ id: `task:${t.id}`, type: "task", label: `[${t.agent}] ${t.name}`,
    ref: t.id, updatedAt: t.updatedAt, status: t.status, branch,
    ...(t.worktreeId === undefined ? {} : { worktreeId: t.worktreeId }),
    ...(t.targetRef === undefined ? {} : { targetRef: t.targetRef }),
    ...(t.review === undefined ? {} : { review: t.review }) }));
  const worktreeNode = `worktree:${currentWorktree}`;
  nodes.push({ id: worktreeNode, type: "worktree", label: `Worktree · ${branch}`, ref: currentWorktree, worktreeId: currentWorktree, branch });
  const edges: WorkMapEdge[] = shown.map((t) => ({ from: `task:${t.id}`, to: worktreeNode, type: "IN_WORKTREE", source: "git" }));
  let truncated = open.length > shown.length;
  for (const changed of changedWorkFiles(root)) {
    if (nodes.length >= MAX_NODES) { truncated = true; break; }
    const id = nodeId(fileRef(changed as RepoPath));
    if (!nodes.some((n) => n.id === id)) nodes.push({ id, type: "file", label: changed, ref: id,
      source: { path: changed } });
    edges.push({ from: worktreeNode, to: id, type: "CHANGED", source: "git" });
  }
  if (selected?.review !== undefined && nodes.length < MAX_NODES) {
    const reviewId = `review:${selected.review.digest}`;
    nodes.push({ id: reviewId, type: "review", label: `Review · ${selected.review.verdict ?? "unrated"}`,
      review: selected.review, updatedAt: selected.review.observedAt });
    edges.push({ from: `task:${selected.id}`, to: reviewId, type: "REVIEWED", source: "review" });
  }
  let graphRevision = "missing";
  let indexStatus = "unknown";
  if (selected !== undefined) {
    await withGraphReader(root, async (graph) => {
      graphRevision = graph.readMeta(GRAPH_REVISION_KEY) ?? "missing";
      if (options.registry !== undefined) {
        const key = `${sourceRevision}:${options.registry.digest()}`;
        const cached = indexStatusCache.get(root);
        if (cached?.key === key) indexStatus = cached.status;
        else {
          indexStatus = (await inspectIndex(root, { graph, registry: options.registry })).value?.status ?? "unknown";
          indexStatusCache.set(root, { key, status: indexStatus });
          if (indexStatusCache.size > 32) indexStatusCache.delete(indexStatusCache.keys().next().value as string);
        }
      }
      const seeds = [];
      if (selected.targetRef !== undefined) {
        const target = parseNodeId(selected.targetRef);
        if (target !== undefined) seeds.push(target);
      } else if (selected.issueId !== undefined) seeds.push(definitionRef("issue", selected.issueId));
      else {
        const op = await projectContext(root, { task: selected.name, budget: 2000 }, options);
        if (op.kind === "ok") for (const s of (op.payload.context.resolution?.seeds ?? []).slice(0, 3)) {
          const ref = parseNodeId(s.id);
          if (ref !== undefined) seeds.push(ref);
        }
      }
      const used = new Set(nodes.map((n) => n.id));
      for (const seed of seeds) {
        if (nodes.length >= MAX_NODES) { truncated = true; break; }
        const result = traverse(graph, [seed], { maxDepth: 1, nodeLimit: MAX_NODES - nodes.length,
          direction: "both", edgeTypes: ["REQUIRES", "IMPLEMENTS", "GOVERNS", "TRACKED_BY", "VALIDATED_BY", "SUPERSEDES", "IMPORTS", "CALLS", "CONTAINS"] });
        truncated ||= result.truncated;
        for (const { node } of result.nodes) {
          if (used.has(node.id)) continue;
          used.add(node.id);
          const payload = node.payload;
          const label = String(payload.title ?? payload.qualifiedName ?? payload.fullName ?? payload.path ?? node.id);
          nodes.push({ id: node.id, type: node.type, label, ref: node.id,
            ...(node.source === undefined ? {} : { source: { path: node.source.path,
              ...(node.source.startLine === undefined ? {} : { startLine: node.source.startLine }) } }) });
        }
        const seedNode = graph.getNode(seed);
        if (seedNode !== undefined && used.has(seedNode.id)) edges.push({ from: `task:${selected.id}`, to: seedNode.id,
          type: selected.targetRef === undefined && selected.issueId === undefined ? "RELATED" : "TARGETS",
          source: selected.issueId === undefined ? "context" : "issue" });
        for (const edge of result.edges) if (used.has(edge.from) && used.has(edge.to)) {
          edges.push({ from: edge.from, to: edge.to, type: edge.type, source: "duo" });
        }
      }
    });
  }
  const map = { format: "duo.work-map/1", revision, graphRevision, indexStatus, selectedTaskId: selected?.id ?? null,
    nodes, edges, truncated };
  writeJson(root, MAP, map);
  return map;
}

/** On-demand expansion stays in browser memory and never enlarges the persisted base map. */
export async function expandWorkNode(root: string, id: string, depth: number) {
  const ref = parseNodeId(id);
  if (ref === undefined) return { nodes: [] as WorkMapNode[], edges: [] as WorkMapEdge[], truncated: false };
  const nodeLimit = EXPANSION_NODE_LIMITS[depth as keyof typeof EXPANSION_NODE_LIMITS] ?? EXPANSION_NODE_LIMITS[3];
  return withGraphReader(root, async (graph) => {
    const result = traverse(graph, [ref], { maxDepth: depth, nodeLimit,
      direction: "both", edgeTypes: ["REQUIRES", "IMPLEMENTS", "GOVERNS", "TRACKED_BY", "VALIDATED_BY", "SUPERSEDES", "IMPORTS", "CALLS", "CONTAINS"] });
    // The project root is a graph boundary, not a useful neighbour. CONTAINS links
    // otherwise pull the root (often labelled "DUO") into every expanded file.
    const nodes = result.nodes.filter(({ node }) => node.type !== "project");
    const visibleIds = new Set(nodes.map(({ node }) => node.id));
    return { nodes: nodes.map(({ node }) => ({ id: node.id, type: node.type,
      label: String(node.payload.title ?? node.payload.qualifiedName ?? node.payload.fullName ?? node.payload.path ?? node.id), ref: node.id,
      ...(node.source === undefined ? {} : { source: { path: node.source.path,
        ...(node.source.startLine === undefined ? {} : { startLine: node.source.startLine }) } }) })),
      edges: result.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to))
        .map((edge) => ({ from: edge.from, to: edge.to, type: edge.type, source: "duo" as const })),
      truncated: result.truncated };
  });
}
