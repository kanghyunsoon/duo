/**
 * Question wording for Knowledge Gaps (TASK-011, T11.1). Formatting only: the assessment decided
 * what to ask, in which order and why; this turns gaps into sentences with fixed templates for a
 * locale the caller chooses (default "en"; no language guessing). Same assessment + locale →
 * same bytes. Pending proposals are named as unconfirmed; their proposed answer is never stated.
 */
import type { KnowledgeGap, KnowledgeGapAssessment } from "./types.js";

export type GapLocale = "en" | "ko";

export interface RenderGapOptions {
  readonly locale?: GapLocale;
}

function ownerText(gap: KnowledgeGap, locale: GapLocale): string {
  const a = gap.anchors[0];
  if (a === undefined || a.type === "project") return locale === "ko" ? "프로젝트" : "project";
  if (a.type === "file") return a.path;
  if (a.type === "symbol") return `${a.path}#${a.symbol}`;
  if (a.type === "test") return `${a.path}#${a.name}`;
  return a.id;
}

interface Templates {
  ambiguous(term: string, options: string): string;
  unresolved(id: string): string;
  pending(id: string, title: string, on: string): string;
  declared(owner: string, text: string): string;
  missingIntent(): string;
  note(owner: string, text: string): string;
  pendingNote(id: string, title: string): string;
}

const TEMPLATES: Readonly<Record<GapLocale, Templates>> = {
  en: {
    ambiguous: (term, options) => `"${term}" matches several targets: ${options}. Which one do you mean?`,
    unresolved: (id) => `${id} is not in the Project Truth. Which Requirement or Issue do you mean?`,
    pending: (id, title, on) => `${id} "${title}" is an unconfirmed proposal. This task${on} depends on it; please confirm or reject it.`,
    declared: (owner, text) => `Open question in ${owner}: "${text}". It affects this task; please decide it.`,
    // C258 (T59): the signal is about the assembled context (Context packet intent tier), not about the task or the
    // Project Truth as a whole; a review may have no task and its rules may still apply a confirmed Decision.
    missingIntent: () => "The context DUO assembled contains no confirmed Requirement or Decision intent.",
    note: (owner, text) => `${owner}: UNKNOWN ${text}`,
    pendingNote: (id, title) => `${id} "${title}" is PENDING / NOT CONFIRMED`,
  },
  ko: {
    ambiguous: (term, options) => `"${term}"가 여러 대상과 일치합니다: ${options}. 어느 대상을 뜻하는지 선택해 주세요.`,
    unresolved: (id) => `${id}가 현재 Project Truth에 없습니다. 어떤 Requirement/Issue를 의미하는지 확인이 필요합니다.`,
    pending: (id, title, on) => `${id} "${title}"는 아직 확정되지 않은 제안입니다. 이 작업${on}은 이 결정에 의존하므로 확정 또는 거절이 필요합니다.`,
    declared: (owner, text) => `${owner}의 미확정 사항: "${text}". 이 작업에 영향을 주므로 값을 정해 주세요.`,
    missingIntent: () => "DUO가 구성한 Context에 확정된 Requirement/Decision intent가 없습니다.",
    note: (owner, text) => `${owner}: UNKNOWN ${text}`,
    pendingNote: (id, title) => `${id} "${title}"는 확정되지 않은 제안입니다(PENDING / NOT CONFIRMED)`,
  },
};

export function renderGapQuestion(gap: KnowledgeGap, options: RenderGapOptions = {}): string {
  const locale = options.locale ?? "en";
  const t = TEMPLATES[locale];
  switch (gap.kind) {
    case "ambiguous-target": return t.ambiguous(gap.term ?? "", (gap.options ?? []).map((o) => o.ref).join(", "));
    case "unresolved-target": return t.unresolved(gap.target ?? "");
    case "pending-decision": {
      const p = gap.pending;
      return t.pending(p?.id ?? "", p?.title ?? "", p === undefined || p.relatesTo.length === 0 ? "" : ` (${p.relatesTo.join(", ")})`);
    }
    case "declared": return t.declared(ownerText(gap, locale), gap.text ?? "");
    case "missing-intent": return t.missingIntent();
  }
}

function renderNote(gap: KnowledgeGap, locale: GapLocale): string {
  const t = TEMPLATES[locale];
  if (gap.kind === "declared") return t.note(ownerText(gap, locale), gap.text ?? "");
  if (gap.kind === "pending-decision") return t.pendingNote(gap.pending?.id ?? "", gap.pending?.title ?? "");
  return renderGapQuestion(gap, { locale });
}

export interface RenderedGapQuestions {
  readonly locale: GapLocale;
  readonly primaryQuestion?: string;
  readonly additionalQuestions: readonly { readonly id: string; readonly question: string }[];
  /** Surfaced gaps as one-line notes (not questions). */
  readonly notes: readonly { readonly id: string; readonly note: string }[];
}

export function renderGapQuestions(assessment: KnowledgeGapAssessment, options: RenderGapOptions = {}): RenderedGapQuestions {
  const locale = options.locale ?? "en";
  const byId = new Map(assessment.gaps.map((g) => [g.id, g] as const));
  const primary = assessment.primary === undefined ? undefined : byId.get(assessment.primary);
  return {
    locale,
    ...(primary === undefined ? {} : { primaryQuestion: renderGapQuestion(primary, { locale }) }),
    additionalQuestions: assessment.additional.flatMap((id) => {
      const g = byId.get(id);
      return g === undefined ? [] : [{ id, question: renderGapQuestion(g, { locale }) }];
    }),
    notes: assessment.gaps.filter((g) => g.action === "surface").map((g) => ({ id: g.id, note: renderNote(g, locale) })),
  };
}
