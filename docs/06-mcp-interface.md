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

- 실행: `duoctl mcp [--root <path> | --root-from git-cwd|env:<NAME>] [--agent <label>]`(stdio). Agent 설정이 이 명령을 실행한다. `--json`은 쓸 수 없다(stdout이 protocol).
- 서버 이름: `duo-director`(`MCP_SERVER_NAME`, H-20). 버전은 duoctl 버전이다. Tool 이름의 `duo_` 접두사는 서버 이름 아래에 있으므로 유지한다.
- SDK: 공식 MCP TypeScript SDK v2. `@modelcontextprotocol/server@2.1.0`(integration, exact), 입력·출력 스키마는 `zod@4.6.5`(workspace 전체가 같은 한 벌). 테스트는 `@modelcontextprotocol/client@2.1.0`(root devDependency). v1 monolithic `@modelcontextprotocol/sdk`는 쓰지 않는다. SDK import는 `packages/integration/src/mcp/`에서만 허용한다(`boundaries.json` `mcpSdk`, lint).
- 연결: `serveStdio(factory)`가 opening exchange로 protocol era를 고르고 연결마다 `McpServer` 인스턴스 하나를 고정한다. 2025-era `initialize`도 같은 factory로 받는다(`legacy: "serve"`, SDK 기본).
- Root: 시작할 때 한 번 정한다. `--root`(없으면 cwd), 또는 `--root-from git-cwd`(작업 디렉터리를 포함한 Git work tree의 top level), `--root-from env:<NAME>`(서버 환경 변수의 절대 경로, Claude Code의 `CLAUDE_PROJECT_DIR`). 결과는 **Git work tree의 top level**이어야 한다(`openGitProvider`: 저장소가 아니면 `GIT_REPOSITORY_REQUIRED`, 하위 디렉터리면 `SCAN_ROOT_INVALID`, `--root-from`을 풀 수 없으면 `MCP_ROOT_UNRESOLVED`). 위로 올라가며 `.duo-project/`를 찾지 않는다. 서버 하나는 저장소 하나만 다룬다. 시작 실패는 stderr에 진단을 쓰고 종료 코드 1이며 stdout은 비어 있다.
- stdout에는 JSON-RPC 메시지만 쓴다. 진단과 metric 쓰기 경고는 stderr로 보낸다. CLI renderer는 호출하지 않는다.
- 종료: client가 stdin을 닫거나 SIGINT/SIGTERM을 받으면 연결을 닫고 종료 코드 0으로 끝난다. 호출 사이에 열린 GraphStore, statement, transaction이 없으므로 따로 정리할 handle이 없다.
- **Freshness**: Tool은 인덱싱하지 않는다(T00 초안의 "실행 전 증분 인덱싱"을 대체, C139). index가 current가 아니면 context와 review는 정상 결과 `status: "index-required"`를 돌려주고, Agent 또는 Human이 `duoctl index`를 명시적으로 실행한다. MCP에는 index 쓰기 Tool이 없다. freshness 판정은 매 호출 graph의 `inspectIndex()`이며 mtime 전용 판정, TTL cache, watcher는 없다(T19 측정 뒤 결정).
- 응답: `structuredContent`는 shared operation의 payload이고, `content`(text)는 그 payload를 요약한 renderer 결과다. 판단 로직은 text renderer에 없다. Agent는 structuredContent를 신뢰한다.

## Tool 목록과 Domain Service

| Tool | Shared operation → service | payload format | 쓰기 | readOnlyHint |
|---|---|---|---|---|
| duo_get_status | `projectStatus` → core loader, graph `inspectIndex`, director `getAdoptionBaselineStatus`, core `listDecisionProposals`, integration LLM factory(`LLMProviderPool`, 네트워크 없음) | `duo.status/1` | runtime metric 없음 | true |
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
- 출력: CLI `duoctl status --json`의 `result`와 같다. `initialized`, `project`, `truth` 개수, `index`(status, fullRebuildReason, changes, wouldRebuild), `baseline`(status, id, headOid, dirtyAtAdoption, findings), `pendingDecisions`, `llm`(disabled, configured, unavailable), `llmProvider`(T12B: provider, status, model?, reason?; key는 없음). 쓰기 0, 네트워크 0.

### duo_get_context

- 입력: `{ task: string (1..20000자), budget?: int (MIN_BUDGET..MAX_BUDGET), profile?: "default" | "review" }`
- 출력: `{ format: "duo.context/1", status, context, gaps }`. `context`는 `ContextResult`에서 performance를 뺀 것(packet 포함), `gaps`는 `{ requiresHumanInput, primaryQuestion?, additionalQuestions, surfaced, notice, assessment }` 또는 null. `notice`와 description이 surfaced gap은 확정 지시가 아니며 `requiresHumanInput`이 true일 때만 Human에게 묻는다고 밝힌다. pending proposal은 confirmed Decision이 아니다.
- index가 current가 아니면 `status: "index-required"`(인덱싱하지 않음).

### duo_review_changes

- 입력: `{ task?, from? = "HEAD", to? = "WORKTREE", files?: RepoPath[], budget?, includeSemanticAssist?: boolean }`
- 출력: `ReviewResult`(`duo.review/1`): request, baseline, freshness, diff(파일별 `provenance: "adoption-bootstrap"` 포함), seeds, verdict, verdictBasis, claims(`provenance`, `violationKey`, `blockEligible`), evidence, gaps, limitations, semanticAssist, metrics(`llmCalls`).
- index-required는 정상 결과다. Review Record를 쓰지 않는다. PASS는 사용 가능한 evidence에서 방향 위반을 찾지 못했다는 뜻이다.
- **의미 보조(T12B)**: `includeSemanticAssist`의 기본값은 false이고, 켜지 않으면 OpenAI 호출이 없다(`llmCalls = 0`). 켜면 project.yaml의 provider(`openai-responses`)가 configured일 때만 한 번 호출하고, 결과는 `semanticAssist`에 따로 둔다. 결정적 claims·verdict는 바뀌지 않고 LLM만의 결과는 BLOCK·ASK를 만들지 않는다(최대 PASS → WARN). CLI `duoctl review --semantic --json`과 같은 shared operation이다. MCP 서버는 시작할 때 환경(API key)을 snapshot하고 provider를 서버 수명 동안 재사용한다: key를 바꾸면 서버를 다시 시작한다(C192). SDK는 integration의 llm 계층에만 있고 mcp 계층은 import하지 않는다. summary 텍스트에 의미 보조 상태와 LLM claim이 따로 붙는다.

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
| 예기치 않은 예외 | 서버 callback이 잡아 해당 호출만 tool error(`MCP_INTERNAL_ERROR`, stderr에 `INTERNAL <tool>`)로 돌려준다. 서버는 계속 동작한다(T16.1) |

DUO result format(`duo.status/1` 등)과 MCP protocol version은 별개다.

## GraphStore와 WAL

Tool 호출마다 `openProjectGraphReader`로 열고 끝나기 전에 닫는다(`withGraphReader`, finally). 요청 사이에 연결·statement·transaction을 유지하지 않으므로 오래 사는 서버가 SQLite snapshot을 고정하지 않고, 같은 프로세스가 CLI `duoctl index` 뒤의 새 Graph를 바로 본다. read-only 연결이 WAL sidecar(`graph.db-wal`, `-shm`)를 만들 수 있는 것은 알려진 한계다(C131). 호출 뒤 `PRAGMA wal_checkpoint(TRUNCATE)`가 busy 없이 끝나는 것을 e2e로 확인한다.

## Cancellation

MCP 요청 취소(client의 `notifications/cancelled`)는 SDK의 `ctx.mcpReq.signal`(AbortSignal)로 들어와 shared operation의 `signal`로 넘어간다. context는 `compileContext`, review는 `reviewChanges`(와 LLM semantic assist)까지 전달한다. 취소된 요청은 응답하지 않고 서버는 다음 요청을 계속 받는다(T16.1 wire test).

## Metrics

context, review, propose 호출은 `runtime/metrics.jsonl`에 `duo.metric/1` 한 줄을 덧붙인다: `surface: "mcp"`, `command`(Tool 이름), `status`, `exitCode`(실패 1, 그 외 0), `durationMs`, `at`, 해당하면 `contextTokens`·`contextBudget`, `reviewVerdict`·`reviewClaims`, `llmCalls`, 의미 보조를 요청했으면 `llmCacheHits`·`semanticStatus`·`llmProvider`·`llmModel`·Provider가 보고한 `llmInputTokens`·`llmOutputTokens`·`llmCachedInputTokens`(비용 계산 없음). task 원문, 소스, diff, proposal 본문은 쓰지 않는다. 읽기 전용 Tool(status, requirement, decision, trace, impact, search)은 쓰지 않는다. metric 쓰기 실패는 stderr 경고일 뿐 Tool 결과를 바꾸지 않는다.

## CLI parity (C135)

CLI와 MCP는 같은 shared operation을 호출한다. `duoctl status|context|review|trace|impact --json`의 `result`와 같은 Tool의 `structuredContent`는 deep-equal이다(e2e 계약 테스트). 타이밍, Review Record 같은 surface metadata는 CLI envelope의 `meta`에 있고 비교하지 않는다.

## Server instructions

초기화 응답의 `instructions`(`MCP_INSTRUCTIONS`)에는 서버 전체 원칙 다섯 문장만 둔다: DUO가 confirmed direction을 가짐, 구현 전 `duo_get_context`와 변경 후 `duo_review_changes`, Tool은 인덱싱하지 않으니 index-required면 `duoctl index`, pending proposal과 surfaced gap은 확정이 아님, Agent는 제안만 가능. Codex는 이 필드를 서버 전체 guidance로 읽는다(처음 512자가 자기완결). 작업 순서는 bridge(AGENTS.md·CLAUDE.md)에 두고 중복하지 않는다.

## Agent integration (duoctl install)

TASK-017. `duoctl install codex|claude-code`가 기존 CLI·MCP 기능을 Agent의 project 설정에 연결한다. Project Direction 로직은 없다.

```text
inspectAgentIntegration → planAgentIntegration(쓰기 0) → IntegrationPlan → 확인(TTY 또는 --yes) → applyAgentIntegration → verifyAgentIntegration
```

| | Codex | Claude Code |
|---|---|---|
| MCP 설정 | `.codex/config.toml`(project, trusted project에서만 로드) | `.mcp.json`(project, 저장소로 공유) |
| 기록 방식 | 파일 끝에 DUO 관리 블록(`# duo-director:begin` … `# duo-director:end`) 추가. 블록 밖 TOML과 주석은 byte 그대로(재직렬화 없음, smol-toml은 검증에만) | JSON을 읽어 `mcpServers["duo-director"]`만 설정하고 파일의 들여쓰기·줄바꿈으로 다시 쓴다 |
| 항목 | `command = "duoctl"`, `args = ["mcp", "--root-from", "git-cwd", "--agent", "codex"]`, cwd 없음 | `{"type": "stdio", "command": "duoctl", "args": ["mcp", "--root-from", "env:CLAUDE_PROJECT_DIR", "--agent", "claude-code"]}` |
| Root | Codex는 project stdio 서버를 세션 작업 디렉터리에서 띄우고 상대 `cwd`도 그 기준으로 푼다(codex-cli 0.147.0에서 확인). 그래서 duoctl이 세션 위치의 Git top level을 쓴다 | Claude Code가 서버 환경에 넣는 `CLAUDE_PROJECT_DIR`(공식)을 duoctl이 읽는다. `${...}` 확장은 쓰지 않는다 |
| Bridge | `AGENTS.md` | `CLAUDE.md` |
| 사람 확인 | `requiresProjectTrust`: Codex에서 project를 trust해야 한다(DUO는 trust를 바꾸지 않음) | `approvalRequired`: Claude Code가 project 서버 승인을 묻는다(`claude mcp get`의 Pending approval, DUO는 승인하지 않음) |

- `duoctl mcp --root-from git-cwd | env:<NAME>`: 이 두 형식만 받는다. 결과는 다시 Git top level로 검증한다(`MCP_ROOT_UNRESOLVED`, `SCAN_ROOT_INVALID`). `--root`와 함께 쓸 수 없다. 설정에 절대 경로가 없으므로 clone·이동 뒤에도 같은 설정이 새 위치의 저장소를 연다.
- Launcher(`DuoLauncher { kind, command, argsPrefix }`): 기본 `path` = PATH의 `duoctl`(설치된 실행 파일), `--launcher npx` = `npx --no-install duoctl`(project에 `@duo-director/cli`가 설치되어 `node_modules/.bin/duoctl`이 있을 때만. 내려받지 않는다, C162). verify는 launcher provenance(kind, resolved, localBin, 응답한 version)를 보인다. 설정에 개발자의 소스 경로를 쓰지 않는다. 설치 시 Agent가 찾을 수 있는지 확인하고 못 찾으면 `AGENT_LAUNCHER_UNAVAILABLE`로 막는다. 상대 경로 command는 거부, 절대 경로는 API로만 가능하며 이식성 경고를 낸다. 저장소 root에 `duoctl`, `duoctl.cmd` 같은 파일이 있으면(Windows의 process 검색이 작업 디렉터리를 볼 수 있음) conflict다. Windows에서 Codex가 `duoctl.cmd` shim을 `command = "duoctl"`로 실행하는 것을 확인했다.
- 기존 항목: not-configured(추가), already-configured(unchanged), drifted(DUO 블록이 다름: 갱신), compatible-different-format(다른 모양의 DUO launch: JSON은 확인 후 교체, TOML 블록 밖이면 사람이 지우도록 conflict), conflict(같은 이름의 다른 command, 읽을 수 없는 파일, 깨진 marker, symlink). conflict는 `--yes`로도 덮어쓰지 않는다.
- Bridge: `<!-- duo-director:begin -->` … `<!-- duo-director:end -->` 블록. 없으면 한 줄 띄우고 추가, 있으면 블록만 갱신, marker가 깨졌으면 conflict. 블록 밖 사람 글은 바꾸지 않는다. 내용(10줄 이하, 저장소 정보 없음):

```markdown
<!-- duo-director:begin -->
## DUO (project direction, duo-director MCP server)
- Before substantial work: call duo_get_status; if the index is stale, run `duoctl index`; then call duo_get_context for the task.
- Pending proposals are not confirmed project decisions.
- After meaningful code changes: run `duoctl index`, then call duo_review_changes.
- If the review returns ASK, show the human its question. Never bypass BLOCK by editing Project Truth (.duo-project/).
- To change a decision, call duo_propose_decision. You cannot confirm or reject decisions; a human does.
<!-- duo-director:end -->
```

- Plan: agent, repositoryRoot, launcher, mcp(status, target, current?, planned, action), bridge(target, status, plannedBlock, action), requirements(duoctlAvailable, projectTrustRequired, approvalRequired), willCreate, willModify, willDelete, unchanged, conflicts, warnings, blockers, files(파일 hash). apply는 hash가 바뀌었으면 `AGENT_PLAN_STALE`, 수정 전 원본을 `.duo-project/runtime/backup/agent-<agent>-<time>/`에 두고, 두 번째 파일 쓰기가 실패하면 앞의 파일을 되돌린다.
- Verify: 설정 parse, 계획한 항목, bridge 블록, launcher 접근, 그리고 설정의 command·args를 Agent와 같은 방식(Codex: 세션 cwd, Claude: `CLAUDE_PROJECT_DIR`)으로 직접 spawn해 initialize → tools/list → `duo_get_status`. tools/list는 이 build의 tool table(`MCP_TOOLS`, 현재 9개)과 이름이 정확히 같아야 한다(C234). launch 실패 detail(서버 stderr 마지막 두 줄)은 `redactSecrets`를 거친다. index가 current가 아니면 `nextActions`에 `duoctl index`(install 자체는 실패하지 않음). `duoctl doctor`는 같은 verify를 `callStatus: false`로 불러 tools/list에서 멈춘다(index는 doctor가 한 번 검사한다).
- Remove: `duoctl install remove <agent>`는 DUO 항목과 DUO 블록만 지운다. DUO 내용만 남은 파일은 삭제하고 빈 `.codex/`도 지운다. `.duo-project`, 사람 글, 다른 MCP 서버는 그대로다. Truth Layer 제거 기능은 없다.
- init 전이면 `AGENT_NOT_INITIALIZED`(종료 코드 5)이며 아무것도 쓰지 않는다. install은 init·index·git add·commit을 하지 않는다. Agent 설정 파일 네 개는 Project Graph 스캔에서 빠진다(duo-agent-integration).
 `tests/mcp/isolation.e2e.test.ts`(T16.1): 테스트 주입(`toolOverrides`, Tool 목록 불변)으로 client 취소 → server AbortSignal → 요청 종료 → 같은 연결의 `duo_get_status` 성공, operation 예외 → 해당 호출만 tool error → 바로 다음 status 성공, raw stdout의 모든 줄이 JSON-RPC frame. `tests/install/install.e2e.test.ts`(T17): 생성된 설정의 command로 실제 DUO stdio 서버를 띄운다.
`tests/mcp/mcp.e2e.test.ts`: 빌드된 `duoctl mcp`를 stdio subprocess로 띄우고 공식 client로 호출한다. initialize, tools/list(정확히 9개, confirm·reject·record·index Tool 없음, strict 스키마, description 문구), 모든 Tool 호출, 인자 오류, root 검증, stdin 종료, existing-project 흐름(stale → index-required → CLI index → 같은 프로세스에서 ready), WAL checkpoint, propose-only, metrics, dirty baseline provenance의 CLI parity. CI 3 OS에서 실행한다.
