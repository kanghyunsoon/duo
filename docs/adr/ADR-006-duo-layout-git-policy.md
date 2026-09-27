---
id: ADR-006
type: decision
title: .duo 디렉터리 구조와 Git 정책
state: proposed
owner: human
question: duo_layout
answer: "tracked definitions + optional tracked reviews/; ignored generated/, cache/, runtime/"
governs:
  requirements: [REQ-TRUTH-001, REQ-TRUTH-002, REQ-EVIDENCE-001]
supersedes: null
proposed_by: codex (TASK-000)
proposed_at: 2026-09-27
---

# ADR-006: .duo 디렉터리 구조와 Git 정책

상태: **Proposed** (Human 검토 대기)

## 배경

지시문 D§2는 `state/`, `evidence/`, `generated/`를 모두 자동 생성 데이터로 묶었다. Human 결정 H-7은 이를 다시 설계하되, 장기간 추적해야 하는 근거(Human이 승인한 Review와 Decision의 근거)와 언제든 재생성 가능한 runtime evidence를 구분하라고 요구했다.

## 분류 기준

데이터를 두 가지 질문으로 나눈다. 첫째, **Human이 승인하거나 기록한 것인가?** 둘째, **삭제해도 같은 입력으로 다시 만들 수 있는가?**

| 분류 | 예 | Human 승인 | 재생성 | Git |
|---|---|---|---|---|
| 정의(Definition) | project.yaml, intent, specs, decisions, milestones, integrations | 예 | 아니오 | 추적 |
| Review Record | Human이 `duo review --record`로 남긴 Review | 예(기록 행위) | 아니오 | 선택적 추적(기본 추적) |
| Derived | graph.db, fingerprints, gaps, inferred state, index 상태 | 아니오 | 예(결정적) | ignore |
| Cache | tokenizer 결과, Packet cache, LLM 응답 cache | 아니오 | 예(성능 목적) | ignore |
| Runtime | 매 실행의 Review 결과, metrics.jsonl, install 백업 | 아니오 | 부분적(같은 commit에서 결정적 규칙은 재실행하면 같음, LLM과 시계열은 아님) | ignore |

## 결정(제안)

```text
.duo/
├─ project.yaml                 tracked
├─ intent/ specs/ milestones/ integrations/   tracked
├─ decisions/ (+ proposals/)    tracked
├─ reviews/                     tracked(기본) · project.yaml에서 ignore로 전환 가능
├─ generated/                   ignored · Derived
├─ cache/                       ignored · Cache
└─ runtime/                     ignored · Runtime
```

- `state/`와 `evidence/`는 쓰지 않는다. 기존 state는 성격에 따라 generated(gaps, inferred, index)와 runtime(metrics)으로, evidence는 runtime(매 실행)과 reviews(Human 기록)로 나눈다.
- **Decision의 근거**는 별도 디렉터리 없이 Decision 파일의 `evidence` 필드에 참조로 들어간다. confirm 시 proposal의 evidence가 그대로 옮겨진다. 따라서 Decision을 추적하면 근거도 함께 추적된다.
- **Review Record**는 코드 본문을 담지 않고 참조(파일:줄, commit SHA, ID)만 담는다. 비밀 정보와 대용량 diff가 Git에 들어가지 않고, commit SHA로 당시 코드를 복원할 수 있다.
- `generated/`는 삭제해도 `duo init --reindex`로 같은 결과가 나와야 한다(AC-014-03). 재생성할 수 없는 데이터는 generated에 두지 않는다.
- `.duo/.gitignore`는 init이 만든다. `project.yaml`의 `reviews.git: tracked | ignored` 설정에 따라 reviews/ 줄을 포함한다.

## 결과

- 지시문 D§2의 디렉터리 목록과 달라진다. 이 차이는 [conflicts.md C19](../conflicts.md)에 기록한다.
- `generated/`의 의미가 "삭제해도 안전"으로 명확해진다.
- 팀이 Review Record를 공유하지 않기로 하면 설정 하나로 끌 수 있다.
