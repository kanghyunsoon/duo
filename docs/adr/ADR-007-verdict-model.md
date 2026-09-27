---
id: ADR-007
type: decision
title: 두 수준 Verdict 모델과 Review 규칙
state: confirmed
owner: human
question: verdict_model
answer: "Claim alignment ALIGNED/PARTIAL/CONFLICT/UNKNOWN; review verdict PASS/WARN/BLOCK/ASK; no numeric score"
governs:
  requirements: [REQ-REVIEW-001, REQ-REVIEW-002, REQ-REVIEW-003, REQ-EVIDENCE-001]
supersedes: null
confirmed_by: human (H-8)
confirmed_at: 2026-09-27
---

# ADR-007: 두 수준 Verdict 모델과 Review 규칙

상태: **Accepted** (Human 결정 H-8)

## 결정

### 두 수준

| 수준 | 값 | 의미 |
|---|---|---|
| Claim(근거 단위) | ALIGNED | 근거가 의도와 일치 |
| | PARTIAL | 일부만 일치하거나 연결이 부족 |
| | CONFLICT | 근거가 확정된 의도와 충돌 |
| | UNKNOWN | 판단할 근거가 없음(의미 판단 불가 포함) |
| Review(전체) | PASS / WARN / BLOCK / ASK | 집계 결과 |

숫자 점수(예: Alignment 83%)는 쓰지 않는다.

### Claim 구조

```ts
interface Claim {
  id: string; rule: RuleId; claim: string;
  alignment: "ALIGNED" | "PARTIAL" | "CONFLICT" | "UNKNOWN";
  blocking: boolean;   // CONFLICT일 때 BLOCK 기여 여부
  ask: boolean;        // Human 입력이 필요한가
  basis: "rule" | "static" | "git" | "test" | "graph" | "heuristic" | "llm";
  expected?: string; observed?: string;
  evidence: [EvidenceRef, ...EvidenceRef[]];   // 최소 1개(타입 수준 강제)
}
```

### 집계

1. `CONFLICT && blocking`인 Claim이 있으면 **BLOCK**
2. 아니면 `ask`인 Claim이 있으면 **ASK**
3. 아니면 CONFLICT(non-blocking), PARTIAL, UNKNOWN 중 하나라도 있으면 **WARN**
4. 아니면(전부 ALIGNED이거나 Claim 없음) **PASS**

예: Claim A ALIGNED, Claim B CONFLICT(blocking), Claim C UNKNOWN → Review **BLOCK**

`basis`가 `heuristic`이나 `llm`인 Claim은 `blocking`이 될 수 없다.

### 규칙 (v0.1)

| 규칙 | 조건 | Alignment | blocking / ask | 판정 수단 |
|---|---|---|---|---|
| R-LOCK | confirmed Decision의 lock digest 불일치, 또는 HEAD에서 confirmed인 Decision의 내용 변경 | CONFLICT | blocking | rule, git |
| R-LOCK | 검토 범위에서 lock 없이 수동으로 confirmed가 됨 | UNKNOWN | ask(`duoctl decision confirm <id>`로 확정) | rule |
| R-LOCK | `duoctl decision`으로 정상 confirm/supersede됨 | ALIGNED | - | rule |
| R-LOCK | 그 밖의 Human-owned 정의 파일 변경 | PARTIAL | - | git |
| R-CONSTRAINT | 추가/수정 Symbol 이름, 새 파일 경로, 새 dependency가 confirmed Constraint의 `match`와 일치 | CONFLICT | `enforcement: block`이면 blocking, `warn`이면 non-blocking | rule, static |
| R-DECISION | 변경이 confirmed Decision의 `forbids`와 일치 | CONFLICT | blocking | rule, static |
| R-DECISION | 변경 위치가 Decision의 governs 대상 | ALIGNED | - | graph |
| R-TEST | 변경 Symbol에 관련 Test가 없거나 관련 Test가 바뀌지 않음 | PARTIAL | - | graph |
| R-TEST | `--run-tests` 결과 실패 | CONFLICT | blocking | test |
| R-REQ | 변경 Symbol이 현재 Milestone 밖의 Requirement를 구현 | PARTIAL | - | graph |
| R-GAP | 영향 Subgraph에 anchor가 있는 open Knowledge Gap | UNKNOWN | ask | graph |
| R-SCOPE | 새 파일이나 exported Symbol이 어떤 Requirement와도 연결되지 않음 | UNKNOWN → 의미 판정 | LLM 결과에 따름 | graph → llm |
| R-INTENT | 변경이 연결된 Requirement의 의도와 충돌하는지 | 의미 판정 | LLM 결과에 따름 | llm |
| R-DRIFT | 문서와 구현 사이의 애매한 불일치(heuristic 연결만 있는 done Requirement 등) | UNKNOWN → 의미 판정 | LLM 결과에 따름 | heuristic → llm |
| R-DRIFT | Truth 항목의 External Source provenance hash가 바뀜, 또는 외부 문서가 Truth와 같은 ID를 다르게 서술(ADR-014) | PARTIAL → 필요 시 의미 판정 | non-blocking. 의미 판정이 확정 Truth와의 충돌을 근거와 함께 보이면 ask | git, rule → llm |

의미 판정 규칙(R-SCOPE, R-INTENT, R-DRIFT)과 연결이 애매한 Gap의 중요도 판단은 ADR-008의 escalation 절차를 따른다. LLM을 쓸 수 없으면 R-SCOPE와 R-DRIFT는 UNKNOWN(non-ask)으로 남고, R-INTENT는 실행하지 않은 채 `skipped_checks`에 기록된다.

## 결과

- OAuth 예시(지시문은 CONFLICT, 기획서는 WARN)는 Claim이 CONFLICT이고 Verdict는 Constraint의 `enforcement`로 결정된다(conflicts.md C18).
- ALIGNED Claim은 기본 출력에서 개수만 보이고 `--verbose`에서 목록이 보인다.
