---
id: ADR-014
type: decision
title: ID 체계와 추적성
state: proposed
owner: human
question: traceability
answer: "global unique IDs; Markdown duo blocks and frontmatter; docs/ doubles as DUO self fixture"
governs:
  requirements: [REQ-TRACE-001, REQ-TRUTH-003]
supersedes: null
proposed_by: codex (TASK-000)
proposed_at: 2026-09-27
---

# ADR-014: ID 체계와 추적성

상태: **Proposed** (Human 검토 대기)

## 배경

H-11은 Requirement ID, ADR ID, Task ID를 서로 추적 가능하게 연결하고, 이 관계가 향후 DUO 자체의 Project Graph fixture 역할을 하도록 설계하라고 요구했다.

## 결정(제안)

### ID

| 대상 | 형식 | 예 | Graph Node |
|---|---|---|---|
| Requirement | `REQ-<AREA>-NNN` (사용자 프로젝트는 `AUTH-03` 같은 자유 형식도 허용) | REQ-CONTEXT-001 | Requirement |
| ADR | `ADR-NNN` | ADR-005 | Decision |
| Task | `TASK-NNN` | TASK-010 | Issue |
| Acceptance Criteria | `AC-NNN-NN`(Task 번호와 순번) | AC-010-02 | Issue 속성 |
| Milestone | `M<n>` | M2 | Milestone |

- 모든 ID는 종류와 관계없이 전역에서 유일하다. Node 종류는 ID 접두사가 아니라 정의 위치와 `type`으로 정해진다.
- 공통 ID 정규식: `^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+|M\d+)$`

### 연결의 정규 원본

한 관계는 한 곳에서만 선언한다. 다른 곳의 링크는 생성된 읽기용 사본이다.

| 관계 | 선언 위치 | Edge |
|---|---|---|
| ADR → Requirement | ADR frontmatter `governs.requirements` | Decision GOVERNS Requirement |
| Task → Requirement | Task block `requirements` | Requirement TRACKED_BY Issue |
| Task → ADR | Task block `decisions` | Decision GOVERNS Issue |
| Task → Task | Task block `depends_on` | Issue REQUIRES Issue |
| Requirement → Milestone | Requirement block `milestone` | Milestone REQUIRES Requirement |
| Acceptance Criteria | Task 섹션의 `**AC-NNN-NN**` 목록 | Issue `attrs.acceptance` |
| Test → Requirement/AC | 테스트 이름에 ID 포함(예: `it("AC-010-02 budget never exceeded")`) | Requirement VALIDATED_BY Test |

추적 예:

```text
REQ-CONTEXT-001 ◀─GOVERNS─ ADR-005 ─GOVERNS─▶ TASK-010 ─attrs─▶ AC-010-01..05
       │                                          ▲
       └──────────────TRACKED_BY──────────────────┘
```

### Self fixture

이 저장소의 `docs/01-requirements.md`, `docs/adr/*.md`, `docs/tasks/TASKS.md`, `docs/12-roadmap.md`는 [03-data-model.md](../03-data-model.md#markdown-정의-형식)의 Markdown 정의 형식을 따른다. 이후 DUO 저장소에 `.duo/project.yaml`을 두고 `sources`로 이 문서들을 지정하면 DUO가 자기 자신을 인덱싱한다.

- TASK-002: 파싱과 참조 해석 검증(AC-002-03)
- TASK-007: Graph 경로 검증(AC-007-03)
- TASK-020: `duo trace REQ-CONTEXT-001` E2E(AC-020-02)

## 결과

- 원래 기획서 예시 ID(AUTH-03, D-004, GAME-42)도 같은 정규식으로 처리된다.
- `.duo` 밖 문서를 정의 소스로 읽는 것은 "Source of Truth는 .duo"라는 원칙과 긴장이 있다. 이 긴장은 conflicts.md C21에 기록한다.
