---
id: ADR-013
type: decision
title: Decision 생명주기와 Lock
state: confirmed
owner: human
question: decision_lifecycle
answer: "propose -> human confirm/reject (CLI or UI) -> confirmed lock; manual YAML edit is fallback"
governs:
  requirements: [REQ-DECISION-001, REQ-DECISION-002, REQ-DECISION-003, REQ-UI-002]
supersedes: null
confirmed_by: human (H-1)
confirmed_at: 2026-09-27
---

# ADR-013: Decision 생명주기와 Lock

상태: **Accepted** (Human 결정 H-1)

## 결정

### 흐름

```text
DUO가 결정 필요를 감지 또는 Agent가 duo_propose_decision
        ↓
proposed (decisions/proposals/P-YYYYMMDD-xxxxxx.yaml)
        ↓
Human: duo decision confirm <id> | duo decision reject <id> | UI Confirm/Reject
        ↓
confirmed (decisions/D-###.yaml, lock 기록)   또는   rejected (proposal에 기록)
```

- `.duo/decisions/*.yaml`을 직접 수정하는 것도 허용하지만 fallback/manual interface다.
- Confirmed Decision의 내용을 DUO나 Coding Agent가 자동으로 바꾸는 기능은 없다. 바꾸려면 `supersedes`를 가진 새 proposal을 만들고 Human이 confirm한다.
- confirm/reject는 MCP Tool로 노출하지 않는다.

### confirm 동작

1. 대상: proposal ID(P-...), `state: proposed`인 Decision, 또는 lock 없이 수동으로 confirmed가 된 Decision(lock 추가).
2. CLI는 TTY에서만 동작하고, 결정 내용을 보여 준 뒤 ID를 다시 입력받아 확인한다. `--yes`는 없다.
3. 다음 번호로 `D-###`을 부여하고(`decisions/`의 최댓값 + 1), 파일을 `decisions/D-###.yaml`로 옮긴다.
4. `state: confirmed`, `confirmed_at`, `confirmed_by`(Git `user.name`, UI는 `ui:` 접두사), `evidence`(proposal에서 이동), `lock.digest`를 기록한다.
5. `supersedes`가 있으면 기존 Decision의 `state`를 `superseded`로, `superseded_by`를 새 ID로 바꾼다. 두 필드는 digest 대상이 아니므로 기존 lock은 유효하게 남는다.

### reject 동작

proposal 파일에 `state: rejected`, `rejected_at`, `rejected_by`, `reason`(선택)을 기록한다. 파일은 proposals/에 남는다.

### Lock

- `lock.digest` = `sha256`(내용 필드를 정규화한 JSON). 내용 필드는 title, kind, question, answer, rationale, governs, forbids, match, enforcement, supersedes다.
- Review의 R-LOCK은 digest 불일치와 HEAD 기준 내용 변경을 모두 검사한다(ADR-007).
- digest는 **실수 탐지용 무결성 표시이며 보안 서명이 아니다**. 악의적인 Agent는 digest를 다시 계산할 수 있다. 이 한계는 [10-security.md](../10-security.md)에 적는다.
- `sources`로 읽는 외부 Markdown Decision(예: 이 저장소의 docs/adr)은 DUO가 쓰지 않는다. 이들은 HEAD 기준 검사만 받는다.

## 결과

- CLI(TASK-015)와 UI(TASK-018)는 core의 `DecisionService` 하나를 호출한다. confirm 로직이 중복되지 않는다.
- ID가 브랜치 간에 충돌하면 전역 ID 유일성 검사(ADR-014)가 잡는다.
