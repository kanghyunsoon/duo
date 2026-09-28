/** duoctl trace <node> / duoctl impact <node> (T15): the shared Graph operations, rendered. Read-only. */
import { projectGraphQuery } from "@duo-director/integration";
import { t } from "../messages.js";
import { EXIT, failed, type Outcome } from "../output.js";
import { operationFailure, usage, type Env } from "./shared.js";

interface GraphPayload {
  status: "found" | "not-found";
  index: string;
  truncated?: boolean;
  nodes?: { id: string; depth: number }[];
  edges?: { from: string; type: string; to: string }[];
  items?: { id: string; depth: number; relation: string; via: { edge: string } }[];
}

export async function graphCommand(env: Env, kind: "trace" | "impact", node: string, depthArg: string | undefined): Promise<Outcome> {
  const depth = depthArg === undefined ? 2 : Number(depthArg);
  if (!Number.isInteger(depth) || depth < 1 || depth > 3) return usage(kind, "--depth must be 1, 2 or 3");
  const op = await projectGraphQuery(env.root, kind, node, depth);
  if (op.kind !== "ok") return operationFailure(env, kind, op);
  const p = op.payload as unknown as GraphPayload;
  if (p.status === "not-found") return failed(kind, EXIT.ERROR, [], [t(env.locale, "graph.not-found", { node })], op.payload);
  const human: string[] = [];
  if (p.index !== "current") human.push(t(env.locale, "index.required", { status: p.index }));
  if (kind === "trace") human.push(...(p.nodes ?? []).map((n) => `${"  ".repeat(n.depth)}${n.id}`), ...(p.edges ?? []).map((e) => `  ${e.from} -${e.type}-> ${e.to}`));
  else human.push(...(p.items ?? []).map((i) => `  ${i.relation.padEnd(10)} d${i.depth}  ${i.id}  (via ${i.via.edge})`), t(env.locale, "graph.impact-note"));
  if (p.truncated === true) human.push(t(env.locale, "graph.truncated"));
  return { command: kind, exitCode: EXIT.OK, diagnostics: [], human, result: op.payload };
}
