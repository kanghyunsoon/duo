# 12. Roadmap

상태: Frozen (T00 final, 2026-09-27)

Milestone은 DUO의 Markdown 정의 형식(`type: milestone`)으로 선언한다. Requirement와 Task는 자신의 `milestone` 필드로 여기에 연결된다([ADR-014](adr/ADR-014-traceability-ids.md)).

## v0.1 (MVP)

### M0 설계

```duo
type: milestone
title: 설계
state: done
```

- 완료 조건: SDD, ADR, TASKS 작성과 Human 검토
- Task: TASK-000
- Requirement: -

### M1 Knowledge Core

```duo
type: milestone
title: Knowledge Core
state: active
```

- 완료 조건: fixture 인덱싱, Graph 불변식, 증분 == 전체, self fixture 파싱
- Task: TASK-001, TASK-002, TASK-003, TASK-004, TASK-005, TASK-006, TASK-007, TASK-008
- Requirement: REQ-TRUTH-001, REQ-TRUTH-002, REQ-TRUTH-003, REQ-TRACE-001, REQ-INDEX-001, REQ-INDEX-002, REQ-INDEX-003, REQ-GRAPH-001, REQ-GRAPH-002, REQ-GRAPH-003, REQ-PROVIDER-001, REQ-SAFETY-001, REQ-NFR-001, REQ-NFR-002, REQ-NFR-003

### M2 Direction

```duo
type: milestone
title: Direction
state: planned
```

- 완료 조건: Decision 생명주기, Context Packet, Gap, LLM Provider, Review Verdict, init
- Task: TASK-009, TASK-010, TASK-011, TASK-012A, TASK-012B, TASK-013, TASK-014
- Requirement: REQ-INIT-001, REQ-INIT-002, REQ-INIT-003, REQ-CONTEXT-001, REQ-CONTEXT-002, REQ-CONTEXT-003, REQ-TOKEN-001, REQ-REVIEW-001, REQ-REVIEW-002, REQ-REVIEW-003, REQ-REVIEW-004, REQ-EVIDENCE-001, REQ-DECISION-001, REQ-DECISION-002, REQ-DECISION-003, REQ-GAP-001, REQ-LLM-001, REQ-LLM-002, REQ-LLM-003, REQ-LLM-004, REQ-NFR-005

### M3 Interfaces

```duo
type: milestone
title: Interfaces
state: planned
```

- 완료 조건: CLI, MCP Context Gateway, install, UI(Confirm/Reject 포함)
- Task: TASK-015, TASK-016, TASK-017, TASK-018
- Requirement: REQ-MCP-001, REQ-AGENT-001, REQ-CLI-001, REQ-UI-001, REQ-UI-002, REQ-NFR-006, REQ-NFR-007

### M4 Validation

```duo
type: milestone
title: Validation
state: planned
```

- 완료 조건: benchmark 보고서, 3 OS E2E 통과, 문서-구현 대조
- Task: TASK-019, TASK-020
- Requirement: REQ-TOKEN-002, REQ-NFR-004

M4가 끝나기 전에는 새 기능을 추가하지 않는다.

## v0.1 이후 (별도 Spec 작성 후 착수)

| 후보 | 내용 | Requirement | 착수 조건 |
|---|---|---|---|
| v0.2 | Jira Read-only Provider(`.duo-project/integrations/jira.yaml`, JQL), GitHub Issues Provider | REQ-POST-001, REQ-POST-002 | v0.1 E2E를 실제 프로젝트 2개 이상에서 사용 |
| v0.3 | 추가 LLM Provider(OpenAICompatibleChat, Anthropic, Local), 테스트 결과 보고서 수집 | REQ-POST-004, REQ-POST-006 | MVP Provider와 escalation이 benchmark에서 안정 |
| v0.4 | PythonAnalyzer(Stretch) 등 언어 추가 | REQ-POST-003 | 사용자 요청 기준 |
| 이후 | 단일 binary, UI 편집 확장 | REQ-POST-007, REQ-POST-005 | 각각 Spec 필요 |

이 표는 T00 때의 후보다. 0.2.0 계획은 [0.2.0 audit §13](roadmap/0.2.0-audit.md#13-020-milestones)을 따른다(C220, H-48).
