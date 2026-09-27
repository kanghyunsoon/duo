# 06. MCP Interface

상태: Draft

## 서버

- 실행: `duo mcp` (stdio transport). Agent 설정이 이 명령을 실행한다.
- SDK: [ADR-004](adr/ADR-004-mcp-sdk.md)
- 작업 디렉터리: 실행 cwd에서 위로 올라가며 `.duo/`를 찾는다. `--root <path>`로 지정할 수 있다.
- stdout에는 JSON-RPC 메시지만 쓴다. 로그는 stderr로 보낸다(NFR-09).
- 모든 Tool은 실행 전 증분 인덱싱으로 freshness를 보장한다([02](02-system-architecture.md#freshness)).
- 응답은 사람이 읽을 compact text(`content`)와 기계용 `structuredContent`를 함께 준다. text가 기본이며 Agent는 대부분 text만 읽으면 된다.

## Tool 목록

| Tool | 쓰기 | readOnlyHint |
|---|---|---|
| duo_get_context | state/metrics.jsonl | true |
| duo_review_changes | evidence/reviews/ | true(프로젝트 파일 불변) |
| duo_get_status | 없음 | true |
| duo_get_requirement | 없음 | true |
| duo_get_decision | 없음 | true |
| duo_trace | 없음 | true |
| duo_impact | 없음 | true |
| duo_search_evidence | 없음 | true |
| duo_propose_decision | decisions/proposals/ | false |

## 계약

입력 스키마는 zod로 정의하고 JSON Schema로 노출한다. 아래는 요약이다.

### duo_get_context

- 입력: `{ task: string (1..2000자), budget_tokens?: int (500..50000), include_diff?: boolean = true }`
- 출력: Packet text([05](05-context-compiler.md#6-출력)), structured: `{ packet, items, asks, metrics }`
- 사용 시점: 작업 시작 시 한 번, 범위가 바뀔 때.

### duo_review_changes

- 입력: `{ base?: string = "HEAD", staged_only?: boolean = false }`
- 출력: `VERDICT` 한 줄 + Claim 목록(alignment, claim, evidence 참조). structured: review JSON([03](03-data-model.md#evidencereviewsreview-idjson))
- 사용 시점: 작업을 마쳤다고 보고하기 전.

### duo_get_status

- 입력: `{}`
- 출력: Goal 한 줄, 현재 Milestone, Requirement status별 개수, pending proposal 수, open gap 수, 마지막 Review verdict, 인덱스 freshness.

### duo_get_requirement / duo_get_decision

- 입력: `{ id: string }`
- 출력: 해당 항목의 전체 정의와 연결(IMPLEMENTS/GOVERNS/TRACKED_BY/VALIDATED_BY 대상 이름 목록). 없으면 `isError: true`, `NOT_FOUND`.

### duo_trace

- 입력: `{ node: string, depth?: int (1..3) = 2 }`. node는 ID, 파일 경로, Symbol 이름 중 하나. 이름이 여러 Node와 일치하면 후보 목록을 반환하고 추적하지 않는다(`AMBIGUOUS`).
- 출력: 상위(Requirement/Decision/Issue/Milestone)와 하위(Symbol/Test) 경로를 Edge type과 함께.

### duo_impact

- 입력: `{ symbol: string, depth?: int (1..3) = 2 }`
- 출력: 호출자, 관련 Test, 관련 Requirement/Decision, CHANGED_WITH 파일.

### duo_search_evidence

- 입력: `{ query?: string, node?: string, verdict?: "PASS"|"WARN"|"BLOCK"|"ASK", limit?: int (1..50) = 10 }`
- 출력: 과거 Review Claim 중 일치 항목(최신순)과 proposal 목록.

### duo_propose_decision

- 입력: `{ title, question, answer, rationale: string, supersedes?: string, governs?: { requirements?, paths?, symbols? }, evidence?: string[] }`
- 동작: `decisions/proposals/P-YYYYMMDD-xxxxxx.yaml`을 새로 만든다. 기존 파일은 절대 수정하지 않는다. `supersedes`가 confirmed Decision이 아니면 거부한다.
- 출력: proposal ID와 "Human 승인 필요" 안내 한 줄.

## 오류 코드

`structuredContent.error.code`: `NOT_INITIALIZED`, `NOT_FOUND`, `AMBIGUOUS`, `INVALID_INPUT`, `INDEX_BUSY`(쓰기 잠금 대기 초과, stale 결과 반환 시에는 오류 아님), `GIT_ERROR`, `INTERNAL`.

## 계약 테스트

[11-testing-strategy.md](11-testing-strategy.md): SDK Client로 서버를 stdio spawn → `tools/list` 스냅샷 비교(이름, 입력 스키마) → 각 Tool을 fixture에서 호출해 structured 출력 스키마 검증 → stdout에 비 JSON-RPC 바이트가 없는지 검사.
