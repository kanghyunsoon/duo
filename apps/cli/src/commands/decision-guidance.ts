import { PROPOSAL_ID_PATTERN, type Diagnostic } from "@duo-director/core";
import { t, type Locale } from "../messages.js";

export type DecisionAction = "confirm" | "reject" | "review-pending";

export interface DecisionGuidanceContext {
  readonly action: DecisionAction;
  readonly id?: string;
  readonly isTTY: boolean;
  readonly nonInteractive: boolean;
}

const DECISION_ID = /^D-\d+$/u;

/** Human-only next steps derived from stable diagnostic codes and the command context. */
export function decisionGuidance(locale: Locale, diagnostics: readonly Diagnostic[], context: DecisionGuidanceContext): string[] {
  const codes = new Set(diagnostics.map((diagnostic) => diagnostic.code));
  const lines: string[] = [];

  if (codes.has("CLI_TTY_REQUIRED")) {
    if (!context.isTTY) lines.push(t(locale, "decision.guidance.tty"));
    if (context.nonInteractive) lines.push(t(locale, "decision.guidance.non-interactive"));
  }

  if (codes.has("DECISION_ACTOR_FORBIDDEN")) {
    lines.push(t(locale, "decision.guidance.actor"), t(locale, "decision.guidance.identity"));
    if (context.action === "review-pending") {
      lines.push(t(locale, "decision.guidance.command.review-pending"));
    } else {
      const id = context.id;
      const valid = id !== undefined && (context.action === "confirm"
        ? PROPOSAL_ID_PATTERN.test(id) || DECISION_ID.test(id)
        : PROPOSAL_ID_PATTERN.test(id));
      if (valid) lines.push(t(locale, `decision.guidance.command.${context.action}`, { id }));
      else lines.push(t(locale, "decision.guidance.invalid-id"));
    }
  }

  return lines;
}
