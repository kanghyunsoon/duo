/**
 * T34.2 / H-36 boundary: informed confirm does not widen what an agent may propose. The MCP proposal
 * input stays title, question, answer, rationale, governs (and the agent label); forbids, enforcement
 * and supersedes are not agent-facing even though the core ProposalInput has them.
 */
import { describe, expect, it } from "vitest";
import { INPUT } from "./tools.js";

describe("duo_propose_decision input contract (H-36, unchanged by T34.2)", () => {
  it("accepts only the documented fields and rejects forbids, enforcement and supersedes", () => {
    const schema = INPUT.duo_propose_decision;
    expect(Object.keys(schema.shape).sort()).toEqual(["agent", "answer", "governs", "question", "rationale", "title"]);
    const base = { title: "t", question: "q", answer: "a" };
    expect(schema.safeParse(base).success).toBe(true);
    for (const extra of [{ forbids: { symbols: ["*X*"] } }, { enforcement: "block" }, { supersedes: "D-001" }]) expect(schema.safeParse({ ...base, ...extra }).success).toBe(false);
  });
});
