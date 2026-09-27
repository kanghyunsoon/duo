/**
 * Question wording for Knowledge Gaps (TASK-011). Formatting only: the assessment decided what to
 * ask and in which order; this turns a gap into a sentence with a fixed template. Pending
 * proposals are named as unconfirmed; their proposed answer is never stated as intent.
 */
import type { KnowledgeGap, KnowledgeGapAssessment } from "./types.js";

function refText(gap: KnowledgeGap): string {
  const a = gap.anchors[0];
  if (a === undefined || a.type === "project") return "프로젝트";
  if (a.type === "file") return a.path;
  if (a.type === "symbol") return `${a.path}#${a.symbol}`;
  if (a.type === "test") return `${a.path}#${a.name}`;
  return a.id;
}

export function renderGapQuestion(gap: KnowledgeGap): string {
  switch (gap.kind) {
    case "ambiguous-target":
      return `"${gap.term ?? ""}"가 여러 대상과 일치합니다: ${(gap.options ?? []).map((o) => o.ref).join(", ")}. 어느 대상을 뜻하는지 선택해 주세요.`;
    case "unresolved-target":
      return `${gap.target ?? ""}가 현재 Project Truth에 없습니다. 어떤 Requirement/Issue를 의미하는지 확인이 필요합니다.`;
    case "pending-decision": {
      const p = gap.pending;
      const on = p === undefined || p.relatesTo.length === 0 ? "" : `(${p.relatesTo.join(", ")})`;
      return `${p?.id ?? ""} "${p?.title ?? ""}"는 아직 확정되지 않은 제안입니다. 이 작업${on}은 이 결정에 의존하므로 확정 또는 거절이 필요합니다.`;
    }
    case "declared":
      return `${refText(gap)}의 미확정 사항: "${gap.text}". 이 작업에 영향을 주므로 값을 정해 주세요.`;
    case "missing-intent":
      return "이 작업과 연결된 확정 Requirement/Decision이 없습니다.";
  }
}

export interface RenderedGapQuestions {
  readonly primaryQuestion?: string;
  readonly additionalQuestions: readonly { readonly id: string; readonly question: string }[];
  /** Surfaced gaps as one-line notes (not questions). */
  readonly notes: readonly { readonly id: string; readonly note: string }[];
}

export function renderGapQuestions(assessment: KnowledgeGapAssessment): RenderedGapQuestions {
  const byId = new Map(assessment.gaps.map((g) => [g.id, g] as const));
  const primary = assessment.primary === undefined ? undefined : byId.get(assessment.primary);
  return {
    ...(primary === undefined ? {} : { primaryQuestion: renderGapQuestion(primary) }),
    additionalQuestions: assessment.additional.flatMap((id) => {
      const g = byId.get(id);
      return g === undefined ? [] : [{ id, question: renderGapQuestion(g) }];
    }),
    notes: assessment.gaps.filter((g) => g.action === "surface").map((g) => ({ id: g.id, note: g.kind === "declared" ? `${refText(g)}: UNKNOWN ${g.text}` : g.text })),
  };
}
