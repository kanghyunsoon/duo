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
        ↓ DecisionService.propose(actor = agent | system | human)
proposed (decisions/proposals/P-###.yaml)          ← Project Truth 아님, Graph Node 아님
        ↓ Human: duoctl decision confirm | reject, UI Confirm | Reject → DecisionService(actor = human)
confirmed (decisions/D-###.yaml, lock 기록)   또는   rejected (proposal에 기록, 파일 유지)
        ↓ 다음 인덱싱
Graph Decision Node (DecisionService는 Graph를 직접 고치지 않는다. 결과에 indexRequired: true)
```

- `.duo-project/decisions/*.yaml`을 직접 수정하는 것도 허용하지만 fallback/manual interface다. DUO는 이후 변경을 관찰하고 Human-owned 수정으로 다룬다(OS 수준 ACL은 없음).
- Confirmed Decision의 내용을 DUO나 Coding Agent가 바꾸는 경로는 없다. 바꾸려면 `supersedes`를 가진 새 proposal을 만들고 Human이 confirm한다.
- confirm/reject는 MCP Tool로 노출하지 않는다.
- CLI(TASK-015)와 UI(TASK-018)는 core `createDecisionService(root)`의 `propose`, `confirm`, `reject`, `repair`, `verifyLock`만 호출한다. business logic을 복제하지 않는다.

### Actor

| actor | propose | confirm | reject |
|---|---|---|---|
| human | O | O | O |
| agent | O | X | X |
| system | O | X | X |

호출 API가 `{ kind, name }`을 받고 LLM이 Human 여부를 추론하지 않는다. 금지된 조작은 `DECISION_ACTOR_FORBIDDEN`이다. agent·system의 쓰기는 write boundary에서 `decisions/proposals/`로 좁혀지고, Decision 파일 쓰기는 human만 통과한다.

### confirm 동작

1. 대상: proposal ID(`P-...`), `state: proposed`인 YAML Decision(같은 ID로 확정), 또는 lock 없이 수동으로 confirmed가 된 YAML Decision(lock 추가). 잠긴 confirmed나 superseded Decision은 `DECISION_LOCKED`, ADR 형식 Markdown Decision은 `DECISION_TARGET_UNSUPPORTED`이다.
2. CLI는 TTY에서만 동작하고 결정 내용을 보여 준 뒤 ID를 다시 입력받는다. `--yes`는 없다(CLI 계층의 장치).
3. 검사: loader와 같은 schema, core 추적성 규칙(자기 대체, 없는 대상, 순환, 중복 ID)을 새 상태에 적용한다. supersede 대상은 confirmed이고 `decisions/D-###.yaml`이어야 한다(`DECISION_SUPERSEDE_TARGET_INVALID`).
4. 다음 번호로 `D-###`을 부여한다(`decisions/`와 로드된 Decision 중 최댓값 + 1). 저장소 lock 안에서 할당하고, 파일은 exclusive하게 만든다(임시 파일 + hard link, 이미 있으면 다음 번호).
5. `state: confirmed`, `owner: human`, `proposal`, `proposed_by(_kind)/at`, `confirmed_at`, `confirmed_by`(actor name. CLI는 Git `user.name`, UI는 `ui:` 접두사), `evidence`(proposal에서 이동), `lock.digest`를 기록한다. 이 파일 생성이 commit 지점이다.
6. `supersedes`가 있으면 기존 Decision의 `state`를 `superseded`로, `superseded_by`를 새 ID로 바꾼다(주석과 나머지 필드 유지). 두 필드는 digest 대상이 아니므로 기존 lock은 유효하다. 그다음 proposal 파일을 지운다.
7. 5 이후가 실패하면 결과는 성공과 warning이다. 다음 조작의 repair가 proposal 제거와 superseded 표시를 마친다. 이 표시는 DecisionService가 만든 Decision(`proposal` 필드가 있음)의 supersede에만 적용한다.
8. Project Truth가 proposal의 `based_on` 이후 바뀌었으면 `PROPOSAL_STALE`(warning)와 `stale` {truthChanged, changedRefs}를 돌려준다. 복잡한 rebase는 하지 않는다.

### reject 동작

proposal 파일에 `state: rejected`, `rejected_at`, `rejected_by`, `reason`(선택)을 기록한다. 파일은 proposals/에 남는다. 이미 거절됐거나 확정된 proposal은 `PROPOSAL_NOT_PENDING`이다.

### 동시성과 원자성

- 모든 쓰기 조작은 저장소 lock `.duo-project/runtime/locks/decisions.lock`(regenerable, exclusive 생성) 안에서 한다. 다른 프로세스가 잡고 있으면 기다리고(기본 5초) 넘으면 `DECISION_LOCK_BUSY`다. 같은 host에서 죽은 프로세스의 lock은 깨고 진행한다.
- 교체 쓰기는 임시 파일 + rename, 새 Decision은 exclusive 생성이다. 파일 이름은 할당한 ID로만 만들고 입력 ID는 정규식으로 검사한 뒤에만 쓴다. 모든 경로는 core write boundary와 symlink 검사를 통과한다.

### Lock

- `lock.digest` = `sha256`(내용 필드를 정규화한 JSON). 내용 필드는 title, kind, question, answer, rationale, governs, forbids, enforcement, supersedes다(Decision schema에 없는 `match`는 빠진다, C70).
- Review의 R-LOCK은 digest 불일치와 HEAD 기준 내용 변경을 모두 검사한다(ADR-007). `verifyLock`은 불일치를 `DECISION_LOCK_MISMATCH`(persistent)로 알린다.
- digest는 **실수 탐지용 무결성 표시이며 보안 서명이 아니다**. 악의적인 Agent는 digest를 다시 계산할 수 있다. 이 한계는 [10-security.md](../10-security.md)에 적는다.
- `.duo-project/decisions/` 안의 Markdown Decision(ADR 형식)은 DecisionService가 쓰지 않으며 HEAD 기준 검사만 받는다. `.duo-project` 밖 문서의 결정 서술은 Decision이 아니라 External Evidence다(ADR-014).
- enforcement는 metadata로 저장하고 Graph payload에 싣는다. 실제 판정은 TASK-013이다.

## 결과

- CLI(TASK-015)와 UI(TASK-018)는 core의 `DecisionService` 하나를 호출한다. confirm 로직이 중복되지 않는다.
- ID가 브랜치 간에 충돌하면 전역 ID 유일성 검사(ADR-014)가 잡는다.
