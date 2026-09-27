---
id: ADR-014
type: decision
title: ID 체계와 추적성
state: confirmed
owner: human
question: traceability
answer: "global unique IDs; .duo is the only Project Truth; sources.markdown is External Evidence/Input Source"
governs:
  requirements: [REQ-TRACE-001, REQ-TRUTH-003]
supersedes: null
confirmed_by: human (H-11, H-16)
confirmed_at: 2026-09-27
---

# ADR-014: ID 체계와 추적성

상태: **Accepted** (Human 결정 H-11, H-16)

## 배경

H-11은 Requirement, ADR, Task ID를 추적 가능하게 연결하고 DUO 자체의 Project Graph fixture로 쓰라고 했다. H-16은 `.duo`가 유일한 Project Truth Layer라는 원칙을 유지하고 외부 문서를 External Evidence로 정의했다.

## 결정

### ID

| 대상 | 형식 | 예 | Graph Node |
|---|---|---|---|
| Requirement | `REQ-<AREA>-NNN` (사용자 프로젝트는 `AUTH-03` 같은 자유 형식 허용) | REQ-CONTEXT-001 | Requirement |
| ADR | `ADR-NNN` | ADR-005 | Decision |
| Task | `TASK-NNN`, 나뉜 Task는 `TASK-NNNA` | TASK-010, TASK-012A | Issue |
| Acceptance Criteria | `AC-NNN-NN`, `AC-NNNA-NN` | AC-010-02, AC-012A-01 | Issue 속성 |
| Milestone | `M<n>` | M2 | Milestone |

- 모든 ID는 종류와 관계없이 전역에서 유일하다. Node 종류는 ID 접두사가 아니라 정의 위치와 `type`으로 정해진다.
- 공통 ID 정규식: `^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+[A-Z]?|M\d+)$`

### 연결의 정규 원본

한 관계는 한 곳에서만 선언한다. 다른 곳의 링크는 생성된 읽기용 사본이다.

| 관계 | 선언 위치 | Edge |
|---|---|---|
| ADR → Requirement | ADR frontmatter `governs.requirements` | Decision GOVERNS Requirement |
| Task → Requirement | Task block `requirements` | Requirement TRACKED_BY Issue |
| Task → ADR | Task block `decisions` | Decision GOVERNS Issue |
| Task → Task | Task block `depends_on` | Issue REQUIRES Issue |
| Requirement → Milestone | Requirement block `milestone` | Milestone REQUIRES Requirement |
| Acceptance Criteria | Task 섹션의 `**AC-...**` 목록 | Issue `attrs.acceptance` |
| Test → Requirement/AC | 테스트 이름에 ID 포함(예: `it("AC-010-02 budget never exceeded")`) | Requirement VALIDATED_BY Test |

```text
REQ-CONTEXT-001 ◀─GOVERNS─ ADR-005 ─GOVERNS─▶ TASK-010 ─attrs─▶ AC-010-01..05
       │                                          ▲
       └──────────────TRACKED_BY──────────────────┘
```

### Project Truth와 External Source

- **`.duo`만 Project Truth다.**
- `project.yaml`의 `sources.markdown`으로 지정한 `.duo` 밖 문서(README.md, docs/*.md, legacy spec)와 향후 Jira, GitHub Issue는 **External Evidence / Input Source**다. Graph에서 정의 Node가 되지 않고, 일반 File Node와 Evidence(`kind: document`)로만 쓰인다.
- 용도는 네 가지다: `duo init`의 프로젝트 이해, draft 생성 후 Human 확인, Review 근거, Drift 탐지.
- Human이 확인한 결과만 `.duo` Truth가 된다. 외부 문서가 바뀌어도 `.duo`를 자동으로 바꾸지 않는다.

```text
README.md "최대 8인 multiplayer"
    ↓ import / inference (duo init)
DUO draft
    ↓ Human confirm
.duo/intent/constraints.yaml   max_players: 8   source: {path: README.md, hash: abc123}
```

README가 나중에 "최대 16인"으로 바뀌면 DUO는 `.duo`를 바꾸지 않고 다음처럼 보고한다. 변경이 필요하면 Human이 새 Decision으로 바꾼다.

```text
DRIFT DETECTED
External source: README.md (hash abc123 → 9f41de)
Confirmed truth: max_players = 8
Observed:        README describes 16 players.
```

### Provenance

Truth 항목의 `source` 목록에는 인용 라벨(문자열, 예: `D§3`)과 외부 출처 객체 `{path, hash, section?}`를 둘 수 있다. `hash`는 `section`(Heading)이 있으면 그 섹션 텍스트, 없으면 파일 전체의 sha256이다. hash가 바뀌면 R-DRIFT가 결정적으로 PARTIAL Claim을 내고, 충돌 여부는 의미 판정(LLM이 없으면 UNKNOWN)에 맡긴다. 이 이상의 provenance 시스템은 만들지 않는다.

### Self fixture

이 저장소의 `docs/01-requirements.md`, `docs/adr/*.md`, `docs/tasks/TASKS.md`, `docs/12-roadmap.md`는 [03-data-model.md](../03-data-model.md#markdown-정의-형식)의 Markdown 정의 형식을 따른다. 테스트는 이 파일들을 임시 저장소의 `.duo/`(specs/, decisions/, milestones/)로 **복사**해 Truth로 만든 뒤 사용한다. DUO 저장소 자체에서 docs/는 여전히 External Source다.

- TASK-002: 파싱과 참조 해석(AC-002-03)
- TASK-007: Graph 경로(AC-007-03)
- TASK-020: `duo trace REQ-CONTEXT-001` E2E(AC-020-02)

## 결과

- 기획서 예시 ID(AUTH-03, D-004, GAME-42)도 같은 정규식으로 처리된다.
- "Source of Truth는 .duo" 원칙과 외부 문서 사이의 긴장(conflicts.md C21)은 H-16으로 해소되었다.
