export const expectedSchemas = {
  duo_get_status: { required: [], properties: {} },
  duo_get_context: { required: ["task"], properties: { budget: "integer", profile: "string", task: "string" } },
  duo_review_changes: { required: [], properties: { budget: "integer", files: "array", from: "string", includeSemanticAssist: "boolean", task: "string", to: "string" } },
  duo_get_requirement: { required: ["id"], properties: { id: "string" } },
  duo_get_decision: { required: ["id"], properties: { id: "string" } },
  duo_trace: { required: ["node"], properties: { depth: "integer", node: "string" } },
  duo_impact: { required: ["node"], properties: { depth: "integer", node: "string" } },
  duo_search_evidence: { required: ["query"], properties: { limit: "integer", query: "string" } },
  duo_propose_decision: {
    required: ["answer", "question", "title"],
    properties: { agent: "string", answer: "string", enforcement: "string", forbids: "object", governs: "object", question: "string", rationale: "string", supersedes: "string", title: "string" },
    nested: {
      forbids: { dependencies: "array", imported_paths: "array", paths: "array", symbols: "array" },
      governs: { paths: "array", requirements: "array", symbols: "array" },
    },
  },
};

export const expectedOutputProperties = {
  duo_get_status: ["analysis", "baseline", "format", "index", "initialized", "llm", "llmProvider", "message", "pendingDecisions", "project", "status", "truth"],
  duo_get_context: ["context", "format", "gaps", "message", "status"],
  duo_review_changes: ["baseline", "claims", "context", "diagnostics", "diff", "evidence", "format", "freshness", "gaps", "limitations", "message", "metrics", "request", "seeds", "semanticAssist", "status", "verdict", "verdictBasis"],
  duo_get_requirement: ["format", "id", "message", "requirement", "status", "text"],
  duo_get_decision: ["decision", "format", "id", "message", "note", "status", "text"],
  duo_trace: ["depth", "edges", "format", "index", "message", "node", "nodes", "status", "truncated"],
  duo_impact: ["depth", "evidence", "format", "index", "items", "limitations", "message", "node", "notice", "seeds", "status", "truncated"],
  duo_search_evidence: ["candidates", "format", "message", "notice", "query", "status", "truncated"],
  duo_propose_decision: ["basedOn", "confirmed", "format", "indexRequired", "message", "notice", "path", "proposalId", "proposedBy", "state", "status"],
};
