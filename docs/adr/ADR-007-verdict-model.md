# ADR-007: Claim/Alignment/Verdict 모델과 Review 규칙

- 상태: Proposed
- 날짜: 2026-09-27
- 결정권자: Human

## 결정

Review는 규칙마다 Claim을 만든다. Claim = `{ rule, claim, alignment, expected?, observed?, evidence[≥1] }`. Alignment는 ALIGNED / PARTIAL / CONFLICT / UNKNOWN, Review 전체 Verdict는 PASS / WARN / BLOCK / ASK. 수치 점수는 없다.

### 규칙 (v0.1)

| 규칙 | 조건 | Alignment | Verdict 기여 |
|---|---|---|---|
| R-LOCK | HEAD 기준 confirmed Decision/Constraint 내용 변경 | CONFLICT | BLOCK |
| R-LOCK | proposed → confirmed 전환, 또는 올바른 supersede | UNKNOWN | ASK |
| R-LOCK | 그 외 Human-owned 파일(vision, specs, milestones) 변경 | PARTIAL | WARN("Human 변경이면 무시") |
| R-CONSTRAINT | 추가·수정된 Symbol 이름, 새 파일 경로, 새 dependency가 confirmed Constraint `match`와 일치 | CONFLICT | enforcement에 따라 BLOCK 또는 WARN |
| R-CONSTRAINT | draft Constraint와 일치 | PARTIAL | WARN |
| R-DECISION | 변경이 confirmed Decision의 `forbids`와 일치 | CONFLICT | BLOCK |
| R-DECISION | 변경 위치가 Decision의 governs 대상 | ALIGNED | 없음(근거 제공) |
| R-SCOPE | 새 파일 또는 새 exported Symbol(테스트 제외)이 declared/static/git 경로로 어떤 Requirement에도 연결되지 않음 | PARTIAL | WARN(`warn_on_unlinked_addition`) |
| R-REQ | 변경 Symbol이 현재 Milestone 밖의 Requirement를 구현 | PARTIAL | WARN |
| R-REQ | 변경 Symbol이 현재 Milestone Requirement를 구현 | ALIGNED | 없음 |
| R-TEST | 수정·추가 Symbol에 관련 Test가 없거나 관련 Test가 바뀌지 않음 | PARTIAL | WARN(`warn_on_untested_change`) |
| R-TEST | `--run-tests` 실행 결과 실패 | CONFLICT | BLOCK |
| R-GAP | 영향 Subgraph에 anchor가 있는 open Knowledge Gap | UNKNOWN | ASK |

### 집계

1. BLOCK 기여 Claim이 하나라도 있으면 **BLOCK**
2. 아니면 ASK 기여가 있으면 **ASK**
3. 아니면 WARN 기여가 있으면 **WARN**
4. 아니면 **PASS**

### 제한

- heuristic provenance Edge만을 근거로 한 Claim은 BLOCK에 기여할 수 없고 WARN으로 낮춘다.
- Evidence가 없는 Claim은 만들 수 없다(타입 수준에서 강제).
- ALIGNED Claim은 기본 출력에서 개수만 보이고 `--verbose`에서 목록을 보인다.

## 결과

- OAuth 예시(C7)는 Constraint의 `enforcement`로 WARN/BLOCK이 정해진다.
- 규칙이 판단하지 못하는 의미 문제(예: 구현이 Requirement를 실제로 만족하는가)는 v0.1에서 판정하지 않는다. v0.3 LLMProvider의 대상이다.
