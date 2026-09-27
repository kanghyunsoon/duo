---
id: ADR-006
type: decision
title: .duo-project 디렉터리 구조와 Git 정책
state: confirmed
owner: human
question: duo_layout
answer: "tracked: Project Truth + Human-approved reviews/; ignored: generated/, cache/, runtime/"
governs:
  requirements: [REQ-TRUTH-001, REQ-TRUTH-002, REQ-EVIDENCE-001]
supersedes: null
confirmed_by: human (H-7, H-14)
confirmed_at: 2026-09-27
---

# ADR-006: .duo-project 디렉터리 구조와 Git 정책

상태: **Accepted** (Human 결정 H-7, H-14)

## 배경

지시문 D§2는 `state/`, `evidence/`, `generated/`를 모두 자동 생성 데이터로 묶었다. H-7은 장기간 추적할 근거와 재생성 가능한 runtime evidence를 구분해 다시 설계하라고 했고, H-14가 아래 세 분류로 확정했다.

## 결정

원칙은 하나다.

```text
Truth / Human Decision  → tracked
Derived / Runtime       → ignored
```

| 분류 | 경로 | Git | 들어가는 것 |
|---|---|---|---|
| Project Truth | `project.yaml`, `intent/`, `specs/`, `decisions/`, `milestones/`, `integrations/` | tracked | Human이 정의하거나 확정한 것 |
| Human-approved History | `reviews/` | tracked | Human이 보존하거나 승인한 Review만 |
| Regenerable / Runtime | `generated/`, `cache/`, `runtime/` | ignored | raw graph, fingerprint, 임시 evidence, token cache, 실행 기록 |

### Review 저장

- 모든 Review 실행 결과는 `runtime/reviews/`에 저장되고 Git에 올라가지 않는다.
- Human이 `duoctl review --record`를 실행했을 때만 그 Review가 `reviews/<id>.json`으로 저장된다. MCP와 Agent는 Record를 만들 수 없다.
- Record는 원본 내용을 복사하지 않고 **Evidence Pointer**만 남긴다.

```yaml
evidence:
  - kind: symbol
    commit: 639aace          # commit SHA
    path: src/auth/GoogleOAuthService.ts
    symbol: GoogleOAuthService
    lines: [1, 42]
    content_hash: sha256:7d9e…   # 해당 범위 내용의 hash
  - kind: requirement
    id: AUTH-03
  - kind: decision
    id: D-004
```

- 나중에 같은 commit의 같은 범위에서 hash를 다시 계산하면 Pointer가 여전히 유효한지 확인할 수 있다.
- Decision의 근거도 Decision 파일의 `evidence` 필드에 같은 Pointer 형식으로 남는다. Decision은 Project Truth이므로 함께 추적된다.

### 디렉터리 구성

| 경로 | 내용 |
|---|---|
| `generated/` | graph.db, fingerprints.json(Repository scan cache, graph.db와 분리), gaps.json, inferred.json, index.json. 삭제 후 `duoctl init --reindex`로 같은 결과가 나와야 한다 |
| `cache/` | tokenizer 결과, Packet cache, LLM 응답 cache. 성능 목적이며 언제 지워도 된다 |
| `runtime/` | reviews/(매 실행), metrics.jsonl, backup/(install). 로컬 기록이며 공유하지 않는다 |

`.duo-project/.gitignore`는 init이 만들며 `generated/`, `cache/`, `runtime/` 세 줄을 담는다.

## 결과

- D§2의 디렉터리 목록(state/, evidence/)과 다르다. 이 차이는 [conflicts.md C19](../conflicts.md)에 기록했고 H-14로 확정되었다.
- `reviews/`를 추적 여부로 바꾸는 설정은 두지 않는다. Record를 만들지 않으면 추적할 것도 없다.
