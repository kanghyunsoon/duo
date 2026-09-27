# 05. Context Compiler

상태: Frozen (T00 final, 2026-09-27) · 관련: REQ-CONTEXT-001~003, REQ-GAP-001, REQ-NFR-005, [ADR-005](adr/ADR-005-token-measurement.md), [ADR-008](adr/ADR-008-deterministic-first.md)

Context Compiler는 Task 하나에 대해 token budget 이하의 **Director Context Packet**을 결정적으로 만든다. LLM을 호출하지 않는다. MCP의 `duo_get_context`가 이 기능의 주 사용자다(Context Gateway, [ADR-004](adr/ADR-004-mcp-context-gateway.md)).

## 입력

| 입력 | 출처 | 필수 |
|---|---|---|
| task | 자유 텍스트 또는 ID(예: `"GAME-42 refresh token 만료 처리"`) | 예 |
| budget_tokens | 인자, 없으면 `context.default_budget_tokens`(기본 6000) | 아니오 |
| include_diff | 현재 working tree diff를 seed에 포함할지 | 아니오(기본 true) |
| Graph, .duo-project, Git | 자동 | - |

## 단계

```text
1 Seed 해석 → 2 Subgraph 확장 → 3 필수 항목 → 4 후보 표현 → 5 Packing → 6 출력 + 지표
```

### 1. Seed 해석

| 방법 | 초기 값 |
|---|---|
| Task 안의 ID(Requirement, Decision, Constraint, Issue, Milestone) 정확 일치 | 1.0 |
| Task 안의 파일 경로 또는 `Class.method` 형태 Symbol 정확 일치 | 1.0 |
| 현재 diff의 변경 Symbol(include_diff) | 0.9 |
| 키워드: Task를 토큰화(camelCase/snake_case 분해, 소문자, 불용어 제거, 한글은 공백 단위)해 Requirement 제목과 본문, Decision 제목과 answer, Symbol 이름, 파일 경로에 BM25를 계산하고 상위 8개를 최고값으로 정규화 × 0.6 | ≤ 0.6 |

Seed가 하나도 없으면 Packet에 `ASK: Task와 연결되는 Requirement나 코드를 찾지 못했다`를 넣고 Project 요약만 반환한다.

### 2. Subgraph 확장

[04-project-graph.md](04-project-graph.md#탐색)의 traverse를 `maxDepth = context.max_depth(기본 2)`, `nodeLimit = 200`으로 호출한다. 결과가 후보 집합이다.

### 3. 필수 항목

budget과 관계없이 먼저 넣는다.

1. Task 원문(최대 200 토큰)
2. 후보와 GOVERNS로 연결된 **confirmed** Decision과 Constraint(Lock 대상은 요약하지 않고, 많으면 statement 한 줄 형식)
3. 후보 Subgraph에 anchor가 있는 open Knowledge Gap → **ASK** 항목

필수 항목만으로 budget을 넘으면 Decision을 한 줄 형식으로 바꾸고, 그래도 넘으면 ID만 남긴 뒤 `truncated`를 표시한다.

anchor 없이 키워드만 겹치는 Gap은 Packet의 ASK로 넣지 않는다. 이름만 `POSSIBLY RELATED UNKNOWNS` 줄에 두고 개수를 지표에 남긴다. 중요도 판단이 필요하면 Review의 R-GAP 의미 판정이 맡는다([ADR-008](adr/ADR-008-deterministic-first.md)). Subgraph와 무관한 Gap은 넣지 않고 `gaps_suppressed`만 늘린다.

### 4. 후보 표현 단계

| Node | L3(전체) | L2(요약) | L1(이름) |
|---|---|---|---|
| Requirement | 본문 전체 | 제목 + 첫 문단 + status | ID + 제목 |
| Decision(proposed) | 전체 필드 | question/answer | ID + 제목 |
| Symbol | 코드 본문(start~end line) | signature + 주석 첫 줄 | 정규 이름 + 경로:줄 |
| Test | 테스트 본문 | 테스트 이름 + 경로:줄 | 이름 |
| Issue | 제목 + status + AC + 관련 커밋 3개 | 제목 + status | 키 |
| File | 사용하지 않음(Symbol 단위로만 로드) | import 목록 | 경로 |

### 5. Packing

1. 모든 후보를 L1로 넣을 수 있는지 확인한다. 불가하면 순위 순으로 L1을 넣다가 멈춘다.
2. 남은 budget으로 순위 내림차순(동점은 id 오름차순)에 따라 L1 → L2, 그다음 L2 → L3 승격을 탐욕적으로 시도한다. 승격 비용이 남은 budget보다 크면 건너뛴다.
3. 최종 텍스트를 공식 측정 방식([ADR-005](adr/ADR-005-token-measurement.md))으로 다시 재서 budget 이하임을 확인한다(섹션 구분자 포함). 넘으면 가장 낮은 순위 항목을 한 단계씩 강등한다.

### 6. 출력

Section 순서는 고정한다. 앞쪽에 잘 변하지 않는 항목을 두어 Agent 측 prompt caching에 유리하게 한다.

```text
DUO CONTEXT  budget 6000 · used 4921 (o200k_base) · llm_calls 0
TASK         GAME-42 Refresh Token
CONSTRAINT   CON-001 OAuth is outside MVP. [block]
DECISION     D-004 JWT Authentication = jwt [confirmed]
REQUIREMENT  AUTH-03 Refresh Token (planned, M1)
             Access token이 만료되면 refresh token으로 재발급한다.
ISSUE        GAME-42 Refresh token (todo)
SYMBOLS      AuthService.refresh  src/auth/AuthService.ts:40-71
             ...코드...
             JwtProvider.validate  src/auth/JwtProvider.ts:12  (signature)
TESTS        AuthService > refresh  src/auth/AuthService.test.ts:20
ASK          GAP-1a2b3c4d Refresh token 만료 기간이 정의되지 않았다. 이 Task에 영향을 준다.
OMITTED      14 nodes (names only in --json)
```

`--json` 출력은 `{ sections, items: [{ id, level, tokens, rank }], asks, metrics }` 형태다. `rank`는 순서만 나타내며 순위 값은 노출하지 않는다.

## 지표

요청마다 `runtime/metrics.jsonl`에 기록한다. 정의는 [09-token-strategy.md](09-token-strategy.md#지표).

## 결정성

같은 `meta.graph_revision`, 같은 Task, 같은 budget이면 byte 단위로 같은 Packet이 나와야 한다(REQ-NFR-005). 시각 등 가변 값은 Packet 본문에 넣지 않는다. 같은 입력의 Packet은 `cache/packets/`에 저장해 재사용할 수 있다.

## Review용 소형 Packet

Review의 의미 판정 escalation([ADR-008](adr/ADR-008-deterministic-first.md))은 같은 Compiler로 Claim 전용 Packet을 만든다. seed는 Claim의 Evidence Node, budget은 `llm.max_input_tokens`, 표현은 L2까지다.
