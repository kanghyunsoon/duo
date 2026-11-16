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
      forbids: { dependencies: "array", imported_paths: "array", importer_paths: "array", paths: "array", symbols: "array" },
      governs: { paths: "array", requirements: "array", symbols: "array" },
    },
  },
};

export const expectedOutputProperties = {
  duo_get_status: ["analysis", "baseline", "format", "index", "initialized", "llm", "llmProvider", "message", "pendingDecisions", "project", "status", "truth"],
  duo_get_context: ["context", "format", "gaps", "indexRefresh", "message", "status"],
  duo_review_changes: ["baseline", "claims", "context", "diagnostics", "diff", "evidence", "format", "freshness", "gaps", "indexRefresh", "limitations", "message", "metrics", "request", "seeds", "semanticAssist", "status", "verdict", "verdictBasis"],
  duo_get_requirement: ["format", "id", "message", "requirement", "status", "text"],
  duo_get_decision: ["decision", "format", "id", "message", "note", "status", "text"],
  duo_trace: ["depth", "edges", "format", "index", "message", "node", "nodes", "status", "truncated"],
  duo_impact: ["depth", "evidence", "format", "index", "items", "limitations", "message", "node", "notice", "seeds", "status", "truncated"],
  duo_search_evidence: ["candidates", "format", "message", "notice", "query", "status", "truncated"],
  duo_propose_decision: ["basedOn", "confirmed", "format", "indexRequired", "message", "notice", "path", "proposalId", "proposedBy", "state", "status"],
};

export const expectedNames = Object.keys(expectedSchemas).sort();

export function verifyTools(tools) {
  const names = tools.map((tool) => tool.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) throw new Error(`tool names differ: ${JSON.stringify(names)}`);
  for (const tool of tools) {
    const schema = tool.inputSchema;
    const expected = expectedSchemas[tool.name];
    const properties = Object.keys(schema.properties ?? {}).sort();
    if (schema.type !== "object" || schema.additionalProperties !== false) throw new Error(`${tool.name} input schema is not a strict object`);
    if (JSON.stringify(properties) !== JSON.stringify(Object.keys(expected.properties).sort())) throw new Error(`${tool.name} schema properties differ: ${JSON.stringify(properties)}`);
    if (JSON.stringify([...(schema.required ?? [])].sort()) !== JSON.stringify([...expected.required].sort())) throw new Error(`${tool.name} required properties differ: ${JSON.stringify(schema.required ?? [])}`);
    for (const [name, type] of Object.entries(expected.properties)) {
      if (schema.properties[name]?.type !== type) throw new Error(`${tool.name}.${name} type differs: ${String(schema.properties[name]?.type)}`);
    }
    for (const [name, nested] of Object.entries(expected.nested ?? {})) {
      const child = schema.properties[name];
      if (child.additionalProperties !== false || JSON.stringify(Object.keys(child.properties ?? {}).sort()) !== JSON.stringify(Object.keys(nested).sort())) throw new Error(`${tool.name}.${name} nested schema differs`);
      for (const [childName, type] of Object.entries(nested)) if (child.properties[childName]?.type !== type) throw new Error(`${tool.name}.${name}.${childName} type differs`);
    }
    const output = tool.outputSchema;
    if (output?.type !== "object" || output.additionalProperties !== false) throw new Error(`${tool.name} output schema is not a strict object`);
    if (JSON.stringify(Object.keys(output.properties ?? {}).sort()) !== JSON.stringify(expectedOutputProperties[tool.name])) throw new Error(`${tool.name} output schema properties differ`);
    if (JSON.stringify([...(output.required ?? [])].sort()) !== JSON.stringify(["format"])) throw new Error(`${tool.name} output required properties differ`);
  }
}
