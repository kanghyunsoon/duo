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

## 구현 (T13)

`packages/director/src/review/`. 흐름은 freshness(읽기 전용) → Git diff → diff seed → Review 맥락(Context Compiler profile `review`, explicit diff seed) → Knowledge Gap 평가 → 결정적 규칙 → Evidence → 선택적 의미 보조 → 집계다. Review는 관찰하고 판단만 하며 코드, Project Truth, Decision을 바꾸거나 commit, 테스트 실행을 하지 않는다.

| 규칙(구현) | 표의 규칙 | 조건 | Alignment | enforced |
|---|---|---|---|---|
| decision-integrity | R-LOCK | diff 이전에 confirmed였던 Decision의 content digest가 바뀜, lock mismatch, confirmed Decision 삭제 | CONFLICT | 예 |
| | | lock 없이 confirmed(수동) | UNKNOWN(drift) | - |
| | | lock 유효(lifecycle만 바뀜, lock과 함께 새로 확정) | ALIGNED | - |
| supersede-integrity | R-LOCK | 새 Decision의 supersedes 대상이 superseded_by로 이어지지 않음 | PARTIAL(아니면 ALIGNED) | - |
| decision-forbids | R-DECISION | 활성 Decision의 `forbids`: 변경 경로가 paths에, 변경 Symbol이 symbols에, package.json에 새로 추가된 dependency가 dependencies에 일치 | CONFLICT | `enforcement: block`이면 예 |
| decision-forbids-import | R-DECISION(H-72, `next`) | 활성 Decision의 `forbids.imported_paths`: diff의 바뀐 new-side 줄에 있는 import·module-reference가 현재 index에서 정확히 한 repository 파일로 해석되고 그 경로가 일치(type-only 포함). "새 import"라고 주장하지 않는다. unresolved·ambiguous·module resolution 없는 언어는 limitation이며 claim이 아니다 | CONFLICT(`forbidden-import`) | `enforcement: block`이면 예(provenance 정책 적용) |
| decision-governance | R-DECISION | 변경 코드가 활성 Decision의 governs 대상(직접 또는 구현한 Requirement)이고 forbids 충돌 없음 | ALIGNED | - |
| declared-reference | (새) | Indexer의 `DECLARED_SYMBOL_UNRESOLVED`(index state에서 읽음)가 Review 맥락의 정의나 변경된 Truth 파일에 있음 | PARTIAL | - |
| requirement-implementation | R-REQ, R-INTENT | 변경 코드가 IMPLEMENTS로 Requirement와 이어짐. 의미 충족은 판단하지 않음 | UNKNOWN(의미 후보), 현재 Milestone 밖이면 PARTIAL | - |
| test-coverage | R-TEST | Requirement와 이어진 변경 코드에 VALIDATED_BY Test가 없음 | PARTIAL(있으면 ALIGNED) | - |
| test-result | R-TEST | 호출자가 준 결과에서 관련 Test 실패(통과는 ALIGNED, skip은 UNKNOWN) | CONFLICT | 그 Test가 검증하는 Requirement를 block Decision이 governs할 때만 |
| constraint-compliance | R-CONSTRAINT | 공통 `matchConstraint`로 변경 코드와 관련된 confirmed Constraint | UNKNOWN(의미 후보) | - |
| scope-relevance | R-SCOPE | task가 있을 때, 변경된 application 코드(테스트·설정·도구·생성물·문서·Truth 제외)가 task 맥락에 없음 | UNKNOWN(drift), 있으면 ALIGNED | - |
| unlinked-addition | R-SCOPE | task가 있을 때, 추가된 application 파일이 task 맥락에 없고 파일·그 Symbol에서 Requirement로 가는 IMPLEMENTS도 없음(T13.1) | UNKNOWN(drift, 의미 후보). `review.warn_on_unlinked_addition: false`면 drift 아님 | 아니오(BLOCK 불가) |
| external-source-drift | R-DRIFT | confirmed Truth 항목의 `{path, hash, section?}`: 기록한 hash와 검토 쪽 문서(파일 전체 또는 heading section)의 canonical text hash가 다름, 또는 section이 없어짐(T13.1) | PARTIAL, 같으면(문서가 diff에 있을 때만) ALIGNED | - |

- **R-CONSTRAINT 해석 변경**(C107, H-33 확정): Constraint의 `match`는 T10.1부터 관련성 범위다("src/auth/**는 이 제약이 다루는 곳"). 그래서 `match` 일치를 위반으로 보지 않고 의미 판정 후보(UNKNOWN)로 둔다. 파일 이름에 단어가 나왔다는 이유로 BLOCK하지 않는다. MVP에서 Constraint는 Context, relevance, 의미 판정의 입력이고, 결정적 차단은 confirmed Decision의 명시적 `forbids` + `enforcement: block`으로만 한다. Constraint schema에 forbids나 enforcement DSL을 두지 않으며, 실제 사용에서 필요가 확인되면 별도 ADR로 확장한다.
- **BLOCK**: `alignment == CONFLICT` AND 규칙이 enforced AND `blockEligible(basis)`(Project Truth + repository·git·test 근거). LLM basis는 관찰 근거를 대신하지 않는다.
- **ASK**: Knowledge Gap 평가의 `requiresHumanInput`만이 근거다(C100). Packet의 `requiresHumanDecision`과 LLM의 제안은 ASK를 만들지 않는다. Claim 수준 `ask` 필드는 두지 않았다(수동 confirm은 UNKNOWN drift, C108).
- **WARN**: PARTIAL, blockEligible이 아닌 CONFLICT, drift인 UNKNOWN, surface gap(C110). 의미 후보 UNKNOWN과 알려진 분석 한계(unresolved call, 삭제된 Symbol)는 WARN을 만들지 않고 limitation으로 남는다.
- **PASS**: 위가 모두 없음. "DUO가 현재 Evidence 범위에서 방향 위반을 찾지 못했다"이며 버그가 없다는 뜻이 아니다.
- **의미 보조**: 결정적 Review가 끝난 뒤에만, 요청이 허용하고 Provider가 configured일 때 한 번의 structured batch로 한다(ADR-008). 결과는 `semanticAssist`에 따로 두며 결정적 claim과 verdict를 바꾸지 않는다. `semanticAssist.verdict`는 PASS를 WARN까지만 올린다(C114). 실행하지 않은 의미 판정은 `skippedChecks`에 남는다(AC-013-03).
- **diff 처리**: 추가 파일은 현재 repository 근거와 추가 hunk, 삭제 파일은 이전 경로·이전 blob·삭제 줄의 Git 근거(`deleted-unresolved` limitation), rename은 oldPath·newPath·similarity 기록이며 이전과 새 Symbol을 같다고 보지 않는다(`rename-heuristic`). `.duo-project/generated|cache|runtime/`은 검토하지 않고, proposal 파일은 Truth 근거가 아니다.
- **R-SCOPE 대상**(T13.1, C121): Analyzer가 언어를 아는 파일 중 test·spec, 설정(`*.config.*`, `.*rc.*`), 도구(scripts/, tools/, .github/ 등), 생성물(dist/, build/, coverage/ 등), 문서(docs/, examples/), 선언(`*.d.ts`), Truth를 뺀 것만 application source로 본다. Requirement와 이어지지 않았다는 이유만으로 이 파일들에 claim을 만들지 않는다.
- **R-DRIFT 범위**(T13.1, C120): Review 맥락의 정의, Truth 파일이 바뀐 정의, 출처 문서가 바뀐 정의만 검사한다. 원격(URL, Jira, GitHub, Linear), 저장소 밖, 비밀 파일, 없는 파일은 추측하지 않고 `external-source-unavailable` limitation으로 남긴다. Truth는 고치지 않는다.
- **Review Record**(T13.1, C118): `recordReview()`(director)가 Human의 명시적 호출일 때만 `reviews/`에 content-addressed record를 쓴다([03](../03-data-model.md#review-record-reviews)).
- 아직 없는 것: R-SCOPE의 exported Symbol, heuristic R-DRIFT(연결이 애매한 done Requirement), 수정 파일 안에서 삭제된 Symbol의 이전 AST(benchmark에서 실제 miss가 확인될 때 검토).

## 결과

- OAuth 예시(지시문은 CONFLICT, 기획서는 WARN)는 Claim이 CONFLICT이고 Verdict는 Constraint의 `enforcement`로 결정된다(conflicts.md C18).
- ALIGNED Claim은 기본 출력에서 개수만 보이고 `--verbose`에서 목록이 보인다.
