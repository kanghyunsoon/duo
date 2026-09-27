---
id: ADR-008
type: decision
title: Deterministic First와 LLM 사용 범위
state: confirmed
owner: human
question: llm_policy
answer: "deterministic first; LLM only for listed semantic judgments; unavailable LLM yields UNKNOWN/ASK"
governs:
  requirements: [REQ-LLM-001, REQ-LLM-003, REQ-INIT-001, REQ-REVIEW-003, REQ-GAP-001, REQ-CONTEXT-001]
supersedes: null
confirmed_by: human (H-3)
confirmed_at: 2026-09-27
---

# ADR-008: Deterministic First와 LLM 사용 범위

상태: **Accepted** (Human 결정 H-3)

## 결정

원칙은 **No LLM First가 아니라 Deterministic First**다(H-3).

```text
Rule → Static Analysis → Git → Test → Project Graph → Evidence Retrieval → LLM (의미 판단이 필요할 때만)
```

### LLM을 호출하지 않는 작업

파일 변경 탐지, fingerprint, Git diff, Symbol 추출, import/call 관계, Graph traversal, Test 결과, Decision Lock 위반, 명백한 Constraint 위반, Context Packet 생성, `duoctl init` 분석과 초안.

### LLM을 쓸 수 있는 의미 판단

| 판단 | 규칙 |
|---|---|
| Scope Drift | R-SCOPE |
| Requirement와 구현 의도의 의미적 충돌 | R-INTENT |
| 새 구현이 기존 Goal과 관계있는지 | R-SCOPE |
| 문서와 구현 사이의 애매한 불일치 | R-DRIFT |
| Knowledge Gap의 중요도(anchor 없이 키워드만 겹치는 Gap) | R-GAP, Context의 Gap 선택 |

### Escalation 절차

1. 결정적 단계가 먼저 Claim을 만든다. 의미 판정 대상은 UNKNOWN으로 표시된다.
2. Provider가 사용 가능하고 예산이 남았으면, Context Compiler가 해당 Claim 전용의 작은 Packet(관련 Node L2, 상한 `llm.max_input_tokens`, 기본 4000)을 만든다. Repository 원문을 직접 보내지 않는다.
3. Provider는 JSON 스키마(`alignment`, `reason`, `evidence_ids`)로 답한다. Packet에 없는 ID를 인용하거나 스키마가 맞지 않으면 결과를 버리고 UNKNOWN을 유지한다.
4. LLM 결과로 만든 Claim의 `basis`는 `llm`이며 blocking이 될 수 없다. LLM이 확정 Constraint와의 충돌을 근거와 함께 제시하면 `ask`로 올린다.
5. Review 하나당 호출 수는 `llm.max_calls_per_review`(기본 3)로 제한한다. 초과분은 `skipped_checks`에 남긴다.
6. 결과는 입력 hash 기준으로 `.duo-project/cache/llm/`에 저장해 같은 입력이면 다시 호출하지 않는다(REQ-NFR-005).

### LLM unavailable ≠ DUO unavailable

Provider가 설정되지 않았거나, API Key가 없거나, 네트워크나 응답에 오류가 나면 NoneProvider와 같게 동작한다. 결정적 기능은 모두 그대로 동작한다. 의미 판단은 추측하지 않고 UNKNOWN으로 두거나(ask 조건이면 ASK), 실행하지 않은 검사로 기록한다.

## 결과

- 모든 지표에 `llm_calls`, `llm_input_tokens`, `llm_output_tokens`, `llm_token_source`를 기록하고 `duoctl stats`에 보여 준다(REQ-LLM-004).
- Provider 선택은 [ADR-012](ADR-012-llm-provider.md)에서 한다.
- Intent 초안을 LLM으로 만드는 기능은 의미 판단 목록에 없으므로 MVP에서 하지 않는다(conflicts.md C17).
