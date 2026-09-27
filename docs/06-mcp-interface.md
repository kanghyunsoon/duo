# 06. MCP Interface

상태: Frozen (T00 final, 2026-09-27) · 관련: REQ-MCP-001, REQ-NFR-007, [ADR-004](adr/ADR-004-mcp-context-gateway.md)

## 역할: Context Gateway

MCP 서버는 Agent가 `.duo-project` 전체를 읽지 않도록 만드는 **Context Gateway**다. 핵심 흐름은 하나다.

```text
Codex / Claude
      ↓
duo_get_context(task)
      ↓
Project Graph traversal
      ↓
Context Compiler
      ↓
Token Budget
      ↓
minimal context
```

나머지 Tool은 이 흐름을 보조한다. Tool은 9개로 고정하고 늘리지 않는다(H-10). 새 Tool이 필요하면 별도 Spec과 ADR을 먼저 작성한다.

## 서버

- 실행: `duoctl mcp`(stdio). Agent 설정이 이 명령을 실행한다.
- 서버 이름: `duo-director`(`MCP_SERVER_NAME`, H-20). Tool 이름의 `duo_` 접두사는 서버 이름 아래에 있으므로 유지한다.
- SDK: MCP TypeScript SDK v2 서버 패키지. **TASK-016 착수 직전에 공식 문서를 다시 확인한다**(AC-016-01).
- Root: cwd에서 위로 올라가며 `.duo-project/`를 찾는다. `--root <path>`로 지정할 수 있다.
- stdout에는 JSON-RPC 메시지만 쓰고 로그는 stderr로 보낸다.
- 모든 Tool은 실행 전 증분 인덱싱으로 freshness를 보장한다.
- 응답은 compact text(`content`)와 `structuredContent`를 함께 준다. Agent는 대부분 text만 읽으면 된다.

## Tool 목록

| Tool | 역할 | 쓰기 | readOnlyHint |
|---|---|---|---|
| duo_get_context | **Context Gateway 본체** | runtime/metrics.jsonl | true |
| duo_review_changes | 변경 검수 | runtime/reviews/ | true(프로젝트 정의 불변) |
| duo_get_status | 프로젝트 상태 요약 | 없음 | true |
| duo_get_requirement | Requirement 하나 조회 | 없음 | true |
| duo_get_decision | Decision 하나 조회 | 없음 | true |
| duo_trace | 연결 추적 | 없음 | true |
| duo_impact | 영향 범위 | 없음 | true |
| duo_search_evidence | 과거 Review와 proposal 검색 | 없음 | true |
| duo_propose_decision | Decision 제안(새 파일) | decisions/proposals/ | false |

Decision confirm/reject는 Human Action이라 MCP로 노출하지 않는다([ADR-013](adr/ADR-013-decision-lifecycle.md)). Review Record(`--record`)도 Human 명령이라 노출하지 않는다.

## 계약

입력 스키마는 zod로 정의하고 JSON Schema로 노출한다.

### duo_get_context

- 입력: `{ task: string (1..2000자), budget_tokens?: int (500..50000), include_diff?: boolean = true }`
- 출력: Packet text([05 Markdown 출력](05-context-compiler.md#markdown-출력)), structured `ContextPacket`([05 Packet 모델](05-context-compiler.md#packet-모델))과 요청 지표(T10 구현, 전송 형식은 TASK-016)
- 사용 시점: 작업 시작 시 한 번, 범위가 바뀔 때.

### duo_review_changes

- 입력: `{ base?: string = "HEAD", staged_only?: boolean = false }`
- 출력: `VERDICT` 한 줄과 Claim 목록(alignment, claim, evidence 참조), `skipped_checks`. structured는 [03의 Review 결과](03-data-model.md#review-결과-runtimereviews-reviews) 스키마.
- LLM Provider가 설정되어 있으면 의미 판정 escalation을 포함한다. 없으면 결정적 결과만 반환한다.

### duo_get_status

- 입력: `{}`
- 출력: Goal 한 줄, 현재 Milestone, Requirement status별 개수, pending proposal 수, open gap 수, 마지막 Review verdict, 인덱스 freshness, LLM Provider 상태(none, configured, unavailable). 인덱스 freshness는 graph 패키지의 `inspectIndex()` 결과(status, wouldRebuild)를 그대로 쓰며 별도 판정 로직을 두지 않는다(T08.1).

### duo_get_requirement / duo_get_decision

- 입력: `{ id: string }`
- 출력: 정의 전체와 연결 대상 이름 목록. 없으면 `isError: true`, `NOT_FOUND`.

### duo_trace

- 입력: `{ node: string, depth?: int (1..3) = 2 }`. node는 ID, 파일 경로, Symbol 이름 중 하나. 여러 Node와 일치하면 후보 목록만 반환한다(`AMBIGUOUS`).

### duo_impact

- 입력: `{ symbol: string, depth?: int (1..3) = 2 }`
- 출력: 호출자, 관련 Test, 관련 Requirement/Decision, CHANGED_WITH 파일.

### duo_search_evidence

- 입력: `{ query?: string, node?: string, verdict?: "PASS"|"WARN"|"BLOCK"|"ASK", limit?: int (1..50) = 10 }`
- 출력: runtime/reviews와 reviews/의 Claim 중 일치 항목(최신순)과 proposal 목록.

### duo_propose_decision

- 입력: `{ title, question, answer, rationale: string, supersedes?: string, governs?: { requirements?, paths?, symbols? }, forbids?: {...}, evidence?: string[] }`
- 동작: `decisions/proposals/P-YYYYMMDD-xxxxxx.yaml`을 새로 만든다. 기존 파일은 수정하지 않는다. `supersedes`가 confirmed Decision이 아니면 거부한다.
- 출력: proposal ID와 "Human 승인 필요: duoctl decision confirm <id> 또는 UI" 한 줄.

## 오류 코드

`structuredContent.error.code`: `NOT_INITIALIZED`, `NOT_FOUND`, `AMBIGUOUS`, `INVALID_INPUT`, `INDEX_BUSY`(잠금 대기 초과. 마지막 commit 상태를 freshness `unknown`으로 반환할 때는 오류가 아님), `GIT_ERROR`, `INTERNAL`. LLM 오류는 오류 코드로 내지 않고 `skipped_checks`에 남긴다.

## 계약 테스트

SDK Client로 서버를 stdio로 띄운 뒤 다음을 확인한다: `tools/list` 스냅샷(이름, 입력 스키마), fixture에서 각 Tool을 호출했을 때의 structured 출력 스키마, stdout에 JSON-RPC가 아닌 바이트가 없는지, confirm/reject Tool이 없는지.
