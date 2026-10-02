/**
 * Ambiguity remediation (T26.2): which handle in a task tells the candidates of one ambiguity apart, judged with the
 * seed resolver's own token rules (seeds.ts), so a surface only suggests what resolveSeeds accepts. Structure only:
 * the CLI and the MCP text render it in their own words. The resolver, the candidates and the payload are unchanged.
 *
 * - path: every candidate is in a different file and each path is one path token (a /, no leading ./).
 * - qualified-name: every candidate has a different qualified name that is one name token.
 * - definition-id: Requirements that tie on keywords; each ID is an exact seed.
 * - none of them: no single handle tells the candidates apart; the human has to say which one is meant.
 * An existing Requirement or Decision ID in the task is an exact seed as well (any ambiguity then stops blocking),
 * so a symbol ambiguity that has a handle also mentions it. It is never suggested as the way to tell symbols apart.
 */
import { isDefinitionId } from "@duo-director/core";
import { isNameSignal, isPathSignal } from "./seeds.js";
import type { SeedAmbiguity } from "./types.js";

export type AmbiguityHandle = "path" | "qualified-name" | "definition-id";

export interface AmbiguityRemediation {
  readonly term: string;
  readonly reason: SeedAmbiguity["reason"];
  /** Handles that tell every candidate apart and that the resolver accepts in a task; empty when none does. */
  readonly handles: readonly AmbiguityHandle[];
  /** A Requirement or Decision ID the task is about is an exact starting point too (symbol ambiguities with a handle). */
  readonly definitionIdAlso: boolean;
}

const distinct = (xs: readonly string[]) => new Set(xs).size === xs.length;

export function ambiguityRemediation(a: SeedAmbiguity): AmbiguityRemediation {
  if (a.reason === "keyword-tie") {
    const ids = a.options.map((o) => o.ref);
    const ok = ids.length > 1 && distinct(ids) && ids.every((id) => isDefinitionId(id));
    return { term: a.term, reason: a.reason, handles: ok ? ["definition-id"] : [], definitionIdAlso: false };
  }
  const parts = a.options.map((o) => {
    const at = o.ref.indexOf("#");
    return at < 0 ? undefined : { path: o.ref.slice(0, at), name: o.title ?? o.ref.slice(at + 1) };
  });
  const handles: AmbiguityHandle[] = [];
  if (parts.length > 1 && parts.every((p) => p !== undefined)) {
    const paths = parts.map((p) => p.path);
    const names = parts.map((p) => p.name);
    if (distinct(paths) && paths.every(isPathSignal)) handles.push("path");
    if (distinct(names) && names.every(isNameSignal)) handles.push("qualified-name");
  }
  return { term: a.term, reason: a.reason, handles, definitionIdAlso: handles.length > 0 };
}
