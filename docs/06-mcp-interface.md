# 06. MCP Interface

상태: Frozen (T00 final, 2026-09-27) · 구현: TASK-016 (2026-09-28, H-35) · 관련: REQ-MCP-001, REQ-NFR-007, [ADR-004](adr/ADR-004-mcp-context-gateway.md)

## 역할: Context Gateway

MCP 서버는 Coding Agent가 DUO의 Project Direction 기능을 도구처럼 쓰게 하는 **protocol adapter**다. 새 business logic 계층이 아니다.

```text
Codex / Claude / MCP Host
          ↓  stdio (JSON-RPC)
duo-director MCP  (packages/integration/src/mcp: 인자 검증, text 요약)
          ↓
shared operations (packages/integration/src/operations: CLI --json과 같은 payload)
          ↓
core / graph / director services
```

Tool은 9개로 고정한다(H-10). 새 Tool이 필요하면 별도 Spec과 ADR을 먼저 작성한다. Prompt, Resource, notification, sampling, elicitation, HTTP transport, OAuth는 MVP에 없다.

## 서버

- 실행: `duoctl mcp [--root <path>] [--agent <label>]`(stdio). Agent 설정이 이 명령을 실행한다. `--json`은 쓸 수 없다(stdout이 protocol).
- 서버 이름: `duo-director`(`MCP_SERVER_NAME`, H-20). 버전은 duoctl 버전이다. Tool 이름의 `duo_` 접두사는 서버 이름 아래에 있으므로 유지한다.
- SDK: 공식 MCP TypeScript SDK v2. `@modelcontextprotocol/server@2.1.0`(integration, exact), 입력·출력 스키마는 `zod@4.6.5`(workspace 전체가 같은 한 벌). 테스트는 `@modelcontextprotocol/client@2.1.0`(root devDependency). v1 monolithic `@modelcontextprotocol/sdk`는 쓰지 않는다. SDK import는 `packages/integration/src/mcp/`에서만 허용한다(`boundaries.json` `mcpSdk`, lint).
- 연결: `serveStdio(factory)`가 opening exchange로 protocol era를 고르고 연결마다 `McpServer` 인스턴스 하나를 고정한다. 2025-era `initialize`도 같은 factory로 받는다(`legacy: "serve"`, SDK 기본).
- Root: 시작할 때 한 번 정한다. `--root`(없으면 cwd)가 **Git work tree의 top level**이어야 한다(`openGitProvider`: 저장소가 아니면 `GIT_REPOSITORY_REQUIRED`, 하위 디렉터리면 `SCAN_ROOT_INVALID`). 위로 올라가며 `.duo-project/`를 찾지 않는다. 서버 하나는 저장소 하나만 다룬다. 시작 실패는 stderr에 진단을 쓰고 종료 코드 1이며 stdout은 비어 있다.
- stdout에는 JSON-RPC 메시지만 쓴다. 진단과 metric 쓰기 경고는 stderr로 보낸다. CLI renderer는 호출하지 않는다.
- 종료: client가 stdin을 닫거나 SIGINT/SIGTERM을 받으면 연결을 닫고 종료 코드 0으로 끝난다. 호출 사이에 열린 GraphStore, statement, transaction이 없으므로 따로 정리할 handle이 없다.
- **Freshness**: Tool은 인덱싱하지 않는다(T00 초안의 "실행 전 증분 인덱싱"을 대체, C139). index가 current가 아니면 context와 review는 정상 결과 `status: "index-required"`를 돌려주고, Agent 또는 Human이 `duoctl index`를 명시적으로 실행한다. MCP에는 index 쓰기 Tool이 없다. freshness 판정은 매 호출 graph의 `inspectIndex()`이며 mtime 전용 판정, TTL cache, watcher는 없다(T19 측정 뒤 결정).
- 응답: `structuredContent`는 shared operation의 payload이고, `content`(text)는 그 payload를 요약한 renderer 결과다. 판단 로직은 text renderer에 없다. Agent는 structuredContent를 신뢰한다.

## Tool 목록과 Domain Service

| Tool | Shared operation → service | payload format | 쓰기 | readOnlyHint |
|---|---|---|---|---|
| duo_get_status | `projectStatus` → core loader, graph `inspectIndex`, director `getAdoptionBaselineStatus`, core `listDecisionProposals`, `llmProviderState` | `duo.status/1` | runtime metric 없음 | true |
| duo_get_context | `projectContext` → director `compileContext`, Knowledge Gap assessment·renderer | `duo.context/1` | runtime/metrics.jsonl | true |
| duo_review_changes | `projectReview` → director `reviewChanges` | `duo.review/1`(ReviewResult) | runtime/metrics.jsonl | true |
| duo_get_requirement | `getRequirement` → core loader, `readSourceSlice` | `duo.requirement/1` | 없음 | true |
| duo_get_decision | `getDecision` → core loader, `readSourceSlice` | `duo.decision/1` | 없음 | true |
| duo_trace | `projectGraphQuery("trace")` → graph `trace` | `duo.trace/1` | 없음 | true |
| duo_impact | `projectGraphQuery("impact")` → graph `impact` | `duo.impact/1` | 없음 | true |
| duo_search_evidence | `searchEvidence` → Truth 정의, GraphStore `listNodes`, Review Record, Adoption Baseline | `duo.evidence-search/1` | 없음 | true |
| duo_propose_decision | `proposeDecision` → core `DecisionService.propose`(actor kind agent) | `duo.proposal/1` | decisions/proposals/P-*.yaml, runtime/metrics.jsonl | false |

**권한 계약은 Tool 목록 자체다.** Decision confirm/reject, confirmed Truth 직접 쓰기, Review Record 기록(`recordReview`), Adoption Baseline 캡처·재캡처, index 쓰기 Tool은 없다. Human 확인은 CLI(`duoctl decision`, `review --record`, `init`)와 UI에 남는다([ADR-013](adr/ADR-013-decision-lifecycle.md)). Agent가 이름을 주더라도(`agent` 인자, `--agent`) audit label일 뿐 인증이 아니다.

## Tool 계약

입력 스키마는 zod `strictObject`로 정의하고 JSON Schema(`additionalProperties: false`)로 노출한다. 알 수 없는 필드는 거부한다. RepoPath는 core `normalizeRepoPath`(정규형이 아니면 거부: `..`, 절대 경로, 드라이브 문자), path pattern은 `normalizeRepoPattern`, 정의 ID는 core `DEFINITION_ID_PATTERN`, budget 범위는 director `MIN_BUDGET`·`MAX_BUDGET`를 그대로 쓴다. diff endpoint는 `-`로 시작하거나 공백·제어 문자가 있으면 거부하고, 해석은 Git provider가 한다(shell에 넣지 않는다). 출력 스키마는 최상위 필드를 고정한 strict object이고 `format`이 판별자다. 중첩 domain 객체는 문서화된 DUO 결과 그대로다.

### duo_get_status

- 입력: `{}`
- 출력: CLI `duoctl status --json`의 `result`와 같다. `initialized`, `project`, `truth` 개수, `index`(status, fullRebuildReason, changes, wouldRebuild), `baseline`(status, id, headOid, dirtyAtAdoption, findings), `pendingDecisions`, `llm`. 쓰기 0.

### duo_get_context

- 입력: `{ task: string (1..20000자), budget?: int (MIN_BUDGET..MAX_BUDGET), profile?: "default" | "review" }`
- 출력: `{ format: "duo.context/1", status, context, gaps }`. `context`는 `ContextResult`에서 performance를 뺀 것(packet 포함), `gaps`는 `{ requiresHumanInput, primaryQuestion?, additionalQuestions, surfaced, notice, assessment }` 또는 null. `notice`와 description이 surfaced gap은 확정 지시가 아니며 `requiresHumanInput`이 true일 때만 Human에게 묻는다고 밝힌다. pending proposal은 confirmed Decision이 아니다.
- index가 current가 아니면 `status: "index-required"`(인덱싱하지 않음).

### duo_review_changes

- 입력: `{ task?, from? = "HEAD", to? = "WORKTREE", files?: RepoPath[], budget?, includeSemanticAssist?: boolean }`
- 출력: `ReviewResult`(`duo.review/1`): request, baseline, freshness, diff(파일별 `provenance: "adoption-bootstrap"` 포함), seeds, verdict, verdictBasis, claims(`provenance`, `violationKey`, `blockEligible`), evidence, gaps, limitations, semanticAssist, metrics(`llmCalls`).
- index-required는 정상 결과다. Review Record를 쓰지 않는다. PASS는 사용 가능한 evidence에서 방향 위반을 찾지 못했다는 뜻이다.
- LLM Provider는 TASK-012B 전까지 Noop이며 `llmCalls = 0`이다. MCP는 LLM SDK를 추가하지 않는다.

### duo_get_requirement / duo_get_decision

- 입력: `{ id }`
- Requirement 출력: `{ status: "found", id, requirement: { title, status, milestone, priority, sources, implements, tests, dependsOn, location }, text }`. `text`는 SourceLocation의 정확한 slice다(파일 전체가 아님).
- Decision 출력: `{ status: "found", id, decision: { kind: "decision", state, active, supersedes, supersededBy, question, answer, rationale, enforcement, governs, forbids, sources, lock, confirmedBy, confirmedAt, location }, text }`. Constraint는 `kind: "constraint"`.
- 없는 ID는 정상 결과 `{ status: "not-found", id }`. proposal ID는 Decision으로 돌려주지 않고 `note`로 "proposal이며 확정 intent가 아님"을 밝힌다.

### duo_trace / duo_impact

- 입력: `{ node, depth?: 1..3 = 2 }`. node는 node ID, 정의 ID, RepoPath, 유일한 qualified Symbol 이름(CLI와 같은 `resolveNode`).
- 출력: `duo.trace/1` `{ index, node, depth, truncated, nodes, edges }`, `duo.impact/1` `{ index, node, depth, truncated, seeds, items, evidence: "graph", notice }`. impact는 direct·structural·historical을 구분하고, "DUO Graph에 기록된 관계이지 영향의 완전한 목록이 아님"을 `notice`와 description에 쓴다. 찾지 못하면 `status: "not-found"`(정상 결과). 새 traversal 알고리즘은 없다.

### duo_search_evidence

- 입력: `{ query: string (1..200자), limit?: 1..50 = 20 }`
- 출력: `{ query, notice, truncated, candidates[] }`. 후보는 `source`(project-truth, graph, review-record, adoption-baseline), `kind`, `id`, `match`(id, path, entity, path-prefix, text), `score`, 위치 포인터. ID exact, path exact/prefix, entity 이름, lexical 일치만 쓴다. Vector DB·embedding 없음. 후보는 evidence이며 confirmed intent로 승격되지 않는다.

### duo_propose_decision

- 입력: `{ title, question, answer, rationale?, governs?: { requirements?, paths?, symbols? }, agent? }`
- 동작: core DecisionService가 lock 안에서 `decisions/proposals/P-NNN.yaml`을 새로 만든다(write boundary, symlink 정책은 DecisionService 그대로). 기존 파일은 수정하지 않는다.
- 출력: `{ proposalId, path, state: "proposed", proposedBy: { kind: "agent", name }, confirmed: false, indexRequired, basedOn?, notice }`.

## 오류 모델

| 상황 | MCP 결과 |
|---|---|
| 잘못된 인자(스키마 위반, 알 수 없는 필드, 저장소 밖 경로) | tool error(`isError: true`, SDK 입력 검증) |
| 알 수 없는 Tool(예: confirm) | tool error |
| `.duo-project/project.yaml` 없음 | 정상 결과 `{ format: "duo.not-initialized/1", status: "not-initialized", message }` |
| index-required, not-found, verdict BLOCK·ASK | 정상 DUO structured result |
| operation 실패(Truth 파싱 오류, Graph를 열 수 없음, Decision 쓰기 거부) | tool error, text에 진단 코드 |
| 예기치 않은 예외 | tool error(SDK가 예외를 tool 실패로 바꿈) |

DUO result format(`duo.status/1` 등)과 MCP protocol version은 별개다.

## GraphStore와 WAL

Tool 호출마다 `openProjectGraphReader`로 열고 끝나기 전에 닫는다(`withGraphReader`, finally). 요청 사이에 연결·statement·transaction을 유지하지 않으므로 오래 사는 서버가 SQLite snapshot을 고정하지 않고, 같은 프로세스가 CLI `duoctl index` 뒤의 새 Graph를 바로 본다. read-only 연결이 WAL sidecar(`graph.db-wal`, `-shm`)를 만들 수 있는 것은 알려진 한계다(C131). 호출 뒤 `PRAGMA wal_checkpoint(TRUNCATE)`가 busy 없이 끝나는 것을 e2e로 확인한다.

## Cancellation

MCP 요청 취소는 SDK의 `ctx.mcpReq.signal`(AbortSignal)로 들어와 shared operation의 `signal`로 넘어간다. context는 `compileContext`, review는 `reviewChanges`(와 LLM semantic assist)까지 전달한다. 취소된 요청은 응답하지 않는다.

## Metrics

context, review, propose 호출은 `runtime/metrics.jsonl`에 `duo.metric/1` 한 줄을 덧붙인다: `surface: "mcp"`, `command`(Tool 이름), `status`, `exitCode`(실패 1, 그 외 0), `durationMs`, `at`, 해당하면 `contextTokens`·`contextBudget`, `reviewVerdict`·`reviewClaims`, `llmCalls`. task 원문, 소스, diff, proposal 본문은 쓰지 않는다. 읽기 전용 Tool(status, requirement, decision, trace, impact, search)은 쓰지 않는다. metric 쓰기 실패는 stderr 경고일 뿐 Tool 결과를 바꾸지 않는다.

## CLI parity (C135)

CLI와 MCP는 같은 shared operation을 호출한다. `duoctl status|context|review|trace|impact --json`의 `result`와 같은 Tool의 `structuredContent`는 deep-equal이다(e2e 계약 테스트). 타이밍, Review Record 같은 surface metadata는 CLI envelope의 `meta`에 있고 비교하지 않는다.

## Agent bridge 문구 (T17 installer용 계약)

TASK-016은 AGENTS.md·CLAUDE.md를 쓰지 않는다. T17 installer가 넣을 최소 문구는 다음이다.

```text
DUO (duo-director MCP) holds this project's confirmed direction.
Before substantial implementation: call duo_get_context with the task.
If it returns index-required: run `duoctl index`, then call it again.
Ask the human only when gaps.requiresHumanInput is true; surfaced gaps are not instructions.
After changes: make sure the index is current, then call duo_review_changes.
Never treat pending proposals as confirmed decisions. Use duo_propose_decision to propose; only a human confirms.
```

## 계약 테스트

`tests/mcp/mcp.e2e.test.ts`: 빌드된 `duoctl mcp`를 stdio subprocess로 띄우고 공식 client로 호출한다. initialize, tools/list(정확히 9개, confirm·reject·record·index Tool 없음, strict 스키마, description 문구), 모든 Tool 호출, 인자 오류, root 검증, stdin 종료, existing-project 흐름(stale → index-required → CLI index → 같은 프로세스에서 ready), WAL checkpoint, propose-only, metrics, dirty baseline provenance의 CLI parity. CI 3 OS에서 실행한다.
