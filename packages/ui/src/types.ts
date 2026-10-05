/** Shapes of the local API data the UI reads (the backend validates and owns them). */
export interface Location { readonly path: string; readonly startLine?: number; readonly endLine?: number }
export interface Diag { readonly code: string; readonly message: string }

export interface AnalysisLanguage {
  readonly language: string; readonly files: number; readonly analyzer: string; readonly level: string;
  readonly symbols: string; readonly tests: string; readonly imports: string; readonly calls: string; readonly typeResolution: string;
}
export interface StatusPayload {
  readonly project: { readonly name: string; readonly vision: string; readonly currentMilestone: string | null };
  readonly truth: { readonly requirements: number; readonly decisions: number; readonly constraints: number; readonly declaredGaps: number };
  readonly index: { readonly status: string; readonly fullRebuildReason: string | null; readonly changes: { readonly files: number; readonly analysisStale: number } } | null;
  readonly analysis: {
    readonly analyzerRegistryDigest: string;
    readonly files: { readonly total: number; readonly structural: number; readonly fileOnly: number };
    readonly languages: readonly AnalysisLanguage[];
    readonly fileOnly: { readonly level: string; readonly files: number; readonly extensions: readonly { readonly extension: string; readonly files: number }[] };
  } | null;
  readonly baseline: { readonly status: string; readonly id?: string; readonly headOid?: string; readonly dirtyAtAdoption?: boolean; readonly findings?: number } | null;
  readonly pendingDecisions: readonly { readonly id: string; readonly title: string }[];
  readonly llm: string;
  readonly llmProvider?: { readonly provider: string; readonly status: string; readonly model?: string; readonly reason?: string };
}
/** not-initialized / failed arrive as a status string instead of the overview. */
export interface NotReady { readonly status: string; readonly message?: string; readonly diagnostics?: readonly Diag[] }
export interface Overview {
  readonly status: StatusPayload;
  readonly currentMilestone: { readonly id: string; readonly title: string } | null;
  readonly requirements: { readonly total: number; readonly byStatus: Readonly<Record<string, number>> };
  readonly decisions: { readonly active: number; readonly total: number };
  readonly declaredGaps: readonly { readonly id: string; readonly owner: string; readonly key?: string; readonly text: string; readonly location: Location }[];
  readonly latestReview: { readonly id: string; readonly verdict: string | null; readonly recordedAt: string | null } | null;
}
export type OverviewResponse = Overview | NotReady;
export const isOverview = (x: OverviewResponse): x is Overview => typeof x.status === "object" && x.status !== null;
export interface DecisionItem {
  readonly id: string; readonly title: string; readonly label: "CONFIRMED" | "PROPOSED" | "SUPERSEDED" | "REJECTED"; readonly state: string;
  readonly question: string; readonly answer: string; readonly enforcement: string | null;
  readonly governs: { readonly requirements: readonly string[]; readonly paths: readonly string[]; readonly symbols: readonly string[] };
  readonly supersedes: string | null; readonly supersededBy: string | null; readonly locked: boolean; readonly location: Location;
}
export interface ProposalItem {
  readonly id: string; readonly status: "pending" | "committed" | "rejected"; readonly title: string; readonly question: string; readonly answer: string;
  readonly rationale: string | null; readonly supersedes: string | null;
  readonly governs: { readonly requirements: readonly string[]; readonly paths: readonly string[]; readonly symbols: readonly string[] };
  readonly proposedBy: string; readonly proposedAt: string | null; readonly decisionId?: string; readonly reason?: string; readonly location: Location;
}
export interface Direction {
  readonly vision: { readonly status: string; readonly body: string; readonly location: Location } | null;
  readonly milestones: readonly { readonly id: string; readonly title: string; readonly state: string; readonly current: boolean; readonly location: Location }[];
  readonly requirements: readonly { readonly id: string; readonly title: string; readonly status: string; readonly milestone: string | null; readonly priority: string | null; readonly location: Location }[];
  readonly constraints: readonly { readonly id: string; readonly statement: string; readonly state: string; readonly enforcement: string; readonly location: Location }[];
  readonly decisions: readonly DecisionItem[];
  readonly proposals: readonly ProposalItem[];
}
/** DecisionService.previewConfirm as the server returns it (T18.1, T34.2). candidate: the file's content fields; an absent key is not set. */
export interface Preview {
  readonly proposalId?: string; readonly nextDecisionId?: string; readonly expectedDecisionId?: string;
  readonly sourceId?: string; readonly sourceKind?: "proposal" | "decision"; readonly sourcePath?: string; readonly action?: "create" | "confirm-in-place" | "add-lock";
  readonly candidate?: Readonly<Record<string, unknown>>;
  readonly proposedBy?: string; readonly proposedByKind?: string;
  readonly digest?: string;
  readonly stale?: { readonly truthChanged: boolean; readonly changedRefs: readonly string[] };
  readonly supersedes?: { readonly id: string; readonly title: string; readonly state: string; readonly path: string };
  readonly error?: readonly string[];
}
export interface GraphPayload {
  readonly status: string; readonly index?: string; readonly node?: unknown; readonly truncated?: boolean;
  readonly nodes?: readonly { readonly id: string; readonly type: string; readonly depth: number }[];
  readonly edges?: readonly { readonly from: string; readonly type: string; readonly to: string }[];
  readonly items?: readonly { readonly id: string; readonly depth: number; readonly relation: string; readonly via: { readonly edge: string; readonly from: string } }[];
  readonly notice?: string;
  readonly limitations?: readonly { readonly code: string; readonly message: string }[];
}
export interface Evidence {
  readonly id: string; readonly basis: string; readonly kind: string; readonly summary?: string;
  readonly pointer?: { readonly path?: string; readonly lines?: readonly [number, number]; readonly commit?: string; readonly id?: string; readonly kind?: string };
}
export interface Claim {
  readonly id: string; readonly rule: string; readonly subject: { readonly kind: string; readonly id: string }; readonly alignment: string;
  readonly reason: string; readonly expected?: string; readonly observed?: string; readonly evidenceIds: readonly string[]; readonly basis: readonly string[];
  readonly blockEligible: boolean; readonly drift: boolean; readonly provenance?: string;
}
export interface SemanticAssist {
  readonly status: string; readonly failure?: string; readonly provider?: { readonly id: string; readonly model?: string };
  readonly claims: readonly { readonly claimId: string; readonly alignment: string; readonly reason?: string; readonly evidenceIds: readonly string[] }[];
  readonly verdict?: string; readonly calls: number; readonly cacheHits: number;
  readonly skippedChecks: readonly { readonly claimId: string; readonly rule: string; readonly reason: string }[];
}
export interface ReviewResult {
  readonly status: string;
  readonly verdict?: string;
  readonly freshness?: { readonly status: string };
  readonly baseline: { readonly status: string; readonly id?: string };
  readonly diff?: { readonly identity: string; readonly from: string; readonly to: string; readonly files: readonly { readonly path: string; readonly kind: string; readonly provenance?: string }[] };
  readonly claims: readonly Claim[];
  readonly evidence: readonly Evidence[];
  readonly gaps?: { readonly requiresHumanInput: boolean; readonly primary?: string; readonly gaps: readonly Gap[] };
  readonly limitations: readonly { readonly code: string; readonly message: string }[];
  readonly semanticAssist: SemanticAssist;
  readonly metrics: { readonly llmCalls: number };
}
export interface Gap { readonly id: string; readonly kind: string; readonly action: string; readonly relevance: string; readonly text?: string; readonly key?: string }
export interface PacketItem { readonly id: string; readonly ref: string; readonly kind: string; readonly rank: number; readonly level: string; readonly text: string; readonly tokens: number }
export interface Packet {
  readonly seeds: readonly { readonly id: string; readonly ref: string; readonly match: string }[];
  readonly intent: { readonly requirements: readonly PacketItem[]; readonly constraints: readonly PacketItem[] };
  readonly decisions: { readonly active: readonly PacketItem[]; readonly history: readonly { readonly id: string; readonly title: string }[] };
  readonly code: readonly PacketItem[];
  readonly tests: readonly PacketItem[];
  readonly issues: readonly PacketItem[];
  readonly pendingDecisions: readonly { readonly id: string; readonly title: string; readonly text: string; readonly requiresHumanDecision: boolean }[];
  readonly evidence: readonly { readonly id: string; readonly ref: string; readonly via: { readonly seed: string; readonly steps: readonly { readonly from: string; readonly type: string; readonly to: string }[] } }[];
  readonly limitations: readonly { readonly code: string; readonly message: string }[];
  readonly omittedCandidates: readonly { readonly id: string; readonly ref: string; readonly rank: number; readonly tier: string }[];
  readonly metrics: { readonly budget: { readonly total: number; readonly used: number; readonly remaining: number }; readonly candidates: number; readonly selected: number; readonly omitted: number; readonly candidateTokens: number; readonly llmCalls: number };
}
export interface ContextData {
  readonly status: string;
  readonly context?: { readonly status: string; readonly packet?: Packet; readonly metrics?: { readonly repository: { readonly tokens: number; readonly files: number }; readonly rawCandidateTokens: number; readonly candidateTokens: number; readonly selectedTokens: number }; readonly resolution?: { readonly ambiguities: readonly { readonly term: string; readonly options: readonly { readonly ref: string }[] }[] } };
  readonly gaps?: { readonly requiresHumanInput: boolean; readonly primaryQuestion?: { readonly id: string; readonly question: string }; readonly additionalQuestions: readonly { readonly id: string; readonly question: string }[]; readonly surfaced: readonly { readonly id: string; readonly note: string }[]; readonly notice: string; readonly assessment: { readonly gaps: readonly Gap[] } } | null;
  readonly diagnostics?: readonly Diag[];
}
