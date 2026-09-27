# Architecture Decision Records

ADR은 DUO의 Decision 형식(Markdown + YAML frontmatter)을 따른다. `state: confirmed`는 Accepted(Human 결정), `proposed`는 Human 검토 대기를 뜻한다. frontmatter의 `governs.requirements`는 ADR → Requirement 연결의 정규 원본이다([ADR-014](ADR-014-traceability-ids.md)).

T00 final(2026-09-27) 기준 ADR-011만 Proposed이며, Agent 설정 형식은 TASK-017 착수 직전에 공식 문서로 확인한다.

| ADR | 제목 | 상태 | 핵심 결정 | Governs |
|---|---|---|---|---|
| [ADR-001](ADR-001-language-runtime.md) | 언어와 런타임 | Accepted | TypeScript (strict, ESM) on Node.js >=24.15.0 with pnpm workspace; CI baseline Node 24 | REQ-NFR-001, REQ-NFR-003, REQ-CLI-001 |
| [ADR-002](ADR-002-graph-storage.md) | Graph 저장소 | Accepted | GraphStore interface -> NodeSqliteGraphStore -> node:sqlite; node:sqlite only inside graph package; graph_schema_version | REQ-GRAPH-001, REQ-INDEX-002 |
| [ADR-003](ADR-003-language-analysis.md) | 언어 분석 구조 | Accepted | LanguageAnalyzer interface; TypeScript/JavaScript analyzers on web-tree-sitter for MVP | REQ-INDEX-001, REQ-INDEX-003, REQ-GRAPH-001 |
| [ADR-004](ADR-004-mcp-context-gateway.md) | MCP SDK와 Context Gateway | Accepted | MCP TypeScript SDK v2 server over stdio, 9 tools, re-verify official docs before TASK-016 | REQ-MCP-001, REQ-NFR-007, REQ-CONTEXT-001 |
| [ADR-005](ADR-005-token-measurement.md) | 토큰 측정 방식 | Accepted | o200k_base tokenizer for official metrics; chars/4 only as UI approximate fallback; method always recorded | REQ-TOKEN-001, REQ-TOKEN-002, REQ-CONTEXT-001, REQ-CONTEXT-002, REQ-CONTEXT-003 |
| [ADR-006](ADR-006-duo-layout-git-policy.md) | .duo-project 디렉터리 구조와 Git 정책 | Accepted | tracked: Project Truth + Human-approved reviews/; ignored: generated/, cache/, runtime/ | REQ-TRUTH-001, REQ-TRUTH-002, REQ-EVIDENCE-001 |
| [ADR-007](ADR-007-verdict-model.md) | 두 수준 Verdict 모델과 Review 규칙 | Accepted | Claim alignment ALIGNED/PARTIAL/CONFLICT/UNKNOWN; review verdict PASS/WARN/BLOCK/ASK; no numeric score | REQ-REVIEW-001, REQ-REVIEW-002, REQ-REVIEW-003, REQ-EVIDENCE-001 |
| [ADR-008](ADR-008-deterministic-first.md) | Deterministic First와 LLM 사용 범위 | Accepted | deterministic first; LLM only for listed semantic judgments; unavailable LLM yields UNKNOWN/ASK | REQ-LLM-001, REQ-LLM-003, REQ-INIT-001, REQ-REVIEW-003, REQ-GAP-001, REQ-CONTEXT-001 |
| [ADR-009](ADR-009-ui-stack.md) | UI 스택과 Human Action | Accepted | React + Vite static bundle served locally; read-centric; only Decision Confirm/Reject writes | REQ-UI-001, REQ-UI-002 |
| [ADR-010](ADR-010-package-structure.md) | 패키지 구조와 배포 | Accepted | 6 packages (core, analyzer, graph, director, integration, ui) + thin apps/cli; single npm package | REQ-CLI-001, REQ-NFR-003, REQ-SAFETY-001 |
| [ADR-011](ADR-011-agent-integration.md) | Codex / Claude Code 연동 | Proposed | AgentAdapter per agent; prefer agent CLI mcp add; short marked instruction block | REQ-AGENT-001, REQ-MCP-001 |
| [ADR-012](ADR-012-llm-provider.md) | MVP LLM Provider | Accepted | LLMProvider -> OpenAIResponsesProvider (OpenAI Responses API) only for MVP; other adapters post-MVP | REQ-LLM-002, REQ-LLM-004, REQ-NFR-002 |
| [ADR-013](ADR-013-decision-lifecycle.md) | Decision 생명주기와 Lock | Accepted | propose -> human confirm/reject (CLI or UI) -> confirmed lock; manual YAML edit is fallback | REQ-DECISION-001, REQ-DECISION-002, REQ-DECISION-003, REQ-UI-002 |
| [ADR-014](ADR-014-traceability-ids.md) | ID 체계와 추적성 | Accepted | global unique IDs; .duo-project is the only Project Truth; sources.markdown is External Evidence/Input Source | REQ-TRACE-001, REQ-TRUTH-003 |
