import { createDiagnostic, type Diagnostic } from "@duo-director/core";
import { describe, expect, it } from "vitest";
import { decisionGuidance } from "./decision-guidance.js";

const diagnostic = (code: Diagnostic["code"]) => createDiagnostic(code, "test diagnostic");
const context = { action: "confirm" as const, id: "P-001", isTTY: true, nonInteractive: false };

describe("Decision command guidance", () => {
  it("distinguishes missing TTY and non-interactive mode in both locales", () => {
    expect(decisionGuidance("en", [diagnostic("CLI_TTY_REQUIRED")], { ...context, isTTY: false }))
      .toEqual(["Run this command from an interactive terminal."]);
    expect(decisionGuidance("ko", [diagnostic("CLI_TTY_REQUIRED")], { ...context, nonInteractive: true }))
      .toEqual(["--non-interactive 옵션을 제거하고 다시 실행하세요."]);
    expect(decisionGuidance("en", [diagnostic("CLI_TTY_REQUIRED")], { ...context, isTTY: false, nonInteractive: true }))
      .toHaveLength(2);
  });

  it("gives valid commands only for IDs accepted by each action", () => {
    expect(decisionGuidance("en", [diagnostic("DECISION_ACTOR_FORBIDDEN")], context).at(-1))
      .toBe("Run the appropriate command from an interactive terminal: duoctl decision confirm P-001");
    expect(decisionGuidance("en", [diagnostic("DECISION_ACTOR_FORBIDDEN")], { ...context, action: "confirm", id: "D-001" }).at(-1))
      .toContain("duoctl decision confirm D-001");
    expect(decisionGuidance("en", [diagnostic("DECISION_ACTOR_FORBIDDEN")], { ...context, action: "reject", id: "D-001" }).at(-1))
      .toBe("Check the target ID and use the matching Decision command.");
    expect(decisionGuidance("ko", [diagnostic("DECISION_ACTOR_FORBIDDEN")], { action: "review-pending", isTTY: true, nonInteractive: false }).at(-1))
      .toContain("duoctl decision review-pending");
  });

  it("does not add permission guidance for other failures", () => {
    expect(decisionGuidance("en", [diagnostic("DECISION_LOCKED")], context)).toEqual([]);
  });
});
