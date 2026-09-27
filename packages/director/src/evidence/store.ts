/**
 * Evidence collection for Review (TASK-013). The neutral data contract (Evidence, basis, id) is in
 * core; this is the orchestration side: one store per review that deduplicates by ID (the same slice
 * or hunk is stored once and claims point at it), keeps a text excerpt for optional semantic
 * assistance (never part of the result), and lists evidence in ID order.
 *
 * External sources (a future Jira or GitHub Issues adapter) implement EvidenceProvider; T13 wires
 * none. Built-in sources are the functions in sources.ts: Project Truth, repository, Git, test runs.
 */
import { compareUtf8, type EntityRef, type Evidence } from "@duo-director/core";

export interface EvidenceQuery {
  readonly entities: readonly EntityRef[];
  readonly signal?: AbortSignal;
}

/** Boundary for evidence from outside the repository (integration adapters). Not wired in T13. */
export interface EvidenceProvider {
  readonly id: string;
  collect(query: EvidenceQuery): Promise<readonly Evidence[]>;
}

export class EvidenceStore {
  private readonly items = new Map<string, Evidence>();
  private readonly excerpts = new Map<string, string>();

  add(evidence: Evidence, excerpt?: string): string {
    if (!this.items.has(evidence.id)) this.items.set(evidence.id, evidence);
    if (excerpt !== undefined && !this.excerpts.has(evidence.id)) this.excerpts.set(evidence.id, excerpt);
    return evidence.id;
  }

  get(id: string): Evidence | undefined {
    return this.items.get(id);
  }

  excerpt(id: string): string | undefined {
    return this.excerpts.get(id);
  }

  list(): Evidence[] {
    return [...this.items.values()].sort((a, b) => compareUtf8(a.id, b.id));
  }
}
