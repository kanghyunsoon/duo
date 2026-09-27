---
id: ADR-012
type: decision
title: MVP LLM Provider
state: confirmed
owner: human
question: mvp_llm_provider
answer: "LLMProvider -> OpenAIResponsesProvider (OpenAI Responses API) only for MVP; other adapters post-MVP"
governs:
  requirements: [REQ-LLM-002, REQ-LLM-004, REQ-NFR-002]
supersedes: null
confirmed_by: human (H-3, H-15)
confirmed_at: 2026-09-27
---

# ADR-012: MVP LLM Provider

상태: **Accepted** (Human 결정 H-3, H-15)

## 배경

H-3은 MVP에 실제로 동작하는 Provider 1개를 요구한다. H-15는 그 Provider를 OpenAI Responses API로 정했다. D§15는 특정 Provider에 종속되지 않는 구조를 요구한다.

## 선택지

| 후보 | 결정 |
|---|---|
| OpenAI Responses API | **MVP 유일한 실제 Provider** |
| OpenAI 호환 Chat Completions(로컬 서버 포함) | Post-MVP Adapter |
| Anthropic Messages API | Post-MVP Adapter |
| Local 모델 | Post-MVP Adapter |

## 결정

```text
LLMProvider                          Provider 비종속 계약 (TASK-012A)
    ├─ NoneProvider                  기본값, 항상 unavailable (TASK-012A)
    ├─ OpenAIResponsesProvider       MVP 실제 Provider (TASK-012B)
    ├─ OpenAICompatibleChatProvider  Post-MVP
    ├─ AnthropicProvider             Post-MVP
    └─ LocalProvider                 Post-MVP
```

계약에는 OpenAI 전용 타입을 넣지 않는다.

```ts
interface LLMProvider {
  readonly id: string;
  status(): "disabled" | "unavailable" | "ready";
  judge(req: SemanticJudgmentRequest): Promise<SemanticJudgmentResult>;
}
interface SemanticJudgmentRequest {
  rule: RuleId; question: string;
  packet: string;                 // Context Compiler가 만든 소형 Packet
  allowedEvidenceIds: string[];   // 인용 가능한 ID
}
interface SemanticJudgmentResult {
  status: "ok" | "unavailable" | "invalid";
  alignment?: Alignment; reason?: string; evidenceIds?: string[];
  usage?: { input: number; output: number; source: "provider" | "estimated" };
}
```

```yaml
# .duo-project/project.yaml
llm:
  provider: none                 # none | openai-responses
  model: null                    # 사용자가 지정, 기본값 없음
  api_key_env: OPENAI_API_KEY    # 키는 환경 변수에서만 읽는다
  base_url: null                 # null이면 OpenAI 기본 endpoint
  max_calls_per_review: 3
  max_input_tokens: 4000
  timeout_ms: 30000
```

- 기본값은 `none`이다. 사용자가 켜야 네트워크 호출이 생긴다(REQ-NFR-002).
- API Key가 없거나 Provider가 꺼져 있어도 Scan, Graph, Context Compiler, Deterministic Review, MCP, UI는 정상 동작한다. 의미 판단이 필요한 항목만 UNKNOWN 또는 ASK로 남는다.
- **TASK-012A**(계약과 no-op)는 기반 단계에서 진행한다. **TASK-012B**(Responses Adapter)는 Context Compiler(TASK-010)와 Review(TASK-013)의 입출력 계약이 안정된 뒤 구현한다. 조기 Provider 구현으로 인한 재작업을 피하기 위해서다.
- TASK-012B 착수 시 Responses API 공식 문서로 요청/응답 형식, 구조화 출력, usage 필드, 모델 이름을 확인하고 이 ADR에 기록한다. 모델 이름은 코드에 넣지 않는다.

## 결과

- 추가 Adapter는 REQ-POST-004로 다룬다. 추가할 때 `LLMProvider` 계약은 바뀌지 않아야 한다.
