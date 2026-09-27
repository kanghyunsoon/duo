# 00. Product Vision

상태: Draft

## 한 문장 정의

DUO는 AI Coding Agent와 Repository 사이에서 프로젝트의 의도(Intent)와 결정(Decision)을 유지하고, 현재 작업에 필요한 Context만 전달하며, 변경 결과를 근거와 함께 검수하는 **Project Direction Layer**다.

~~~text
Human defines intent.
Agent performs implementation.
DUO maintains direction.
~~~

## 해결하려는 문제

| 문제 | 현상 |
|---|---|
| Context 과다 | Agent가 Search → Read를 반복하며 Repository를 매번 다시 읽어 토큰을 소비한다 |
| Context 손실 | 새 Session의 Agent가 이전에 정한 요구사항과 결정을 모른다 |
| Scope Drift | 요청하지 않은 기능이나 과도한 구조가 추가된다 |
| Spec Drift | 코드와 기획 문서가 시간이 지나며 어긋난다 |
| PM Drift | Issue 상태와 실제 구현이 다르다 |
| 검증 비용 | 사람이 Agent의 이해도를 매번 직접 확인해야 한다 |

## 역할 분리

~~~text
Human ──Intent / Decision──▶ DUO ──Context / Review / Evidence──▶ Coding Agent ──Implementation──▶ Repository
                              ▲                                                                     │
                              └────────────────────────── 관찰(Git, 파일) ───────────────────────────┘
~~~

| 주체 | 소유/담당 | 금지 |
|---|---|---|
| Human | Goal, Product Intent, Requirement, Constraint, Confirmed Decision | 없음(최종 결정권) |
| DUO | 관찰, Git 변경 감지, Project Graph, Context 추출, 연결(Requirement/Decision/Issue/Test ↔ Code), Drift·Conflict·Knowledge Gap 감지, Evidence 수집 | Source Code 수정, Human-owned 정보 자동 변경 |
| Coding Agent | 코드 작성, 테스트, 리팩터링, 버그 수정 | `.duo` 내부 상태 임의 수정 |

## 핵심 가치

- **Direction**: 무엇을 구현할 수 있는가보다 무엇을 구현해야 하는가를 유지한다.
- **Evidence**: 모든 주요 판단은 Claim → Evidence → Verdict 구조를 가진다. 근거 없는 점수(예: "Alignment 83%")를 쓰지 않는다.
- **Context Efficiency**: 전체 Repository를 반복 전달하지 않고 Task와 관련된 Subgraph만 전달한다. 절감 효과는 재현 가능한 benchmark로 측정한다.

## 포지셔닝

DUO는 IDE, Jira, Coding Agent, 문서 생성기가 아니다. Agent가 구현에 집중하는 동안 DUO는 "지금 하는 작업이 우리가 만들려던 것인가?"에 근거를 가지고 답한다.

## 성공 기준 (v0.1)

기능 수가 아니라 다음 End-to-End 흐름이 fixture repository와 실제 repository에서 안정적으로 동작하는 것이 v0.1의 유일한 성공 기준이다.

~~~text
Repository → DUO 설치 → duo init → 자동 분석 → 필요한 Human Intent 확인 → .duo 생성
→ Project Graph 생성 → Agent가 MCP로 Context 요청 → 코딩 → Git Diff → duo review
→ PASS / WARN / BLOCK / ASK → UI에서 Evidence와 Drift 확인
~~~

이 흐름이 안정되기 전에는 범위를 확장하지 않는다.
