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
// T12A 구현(packages/director/src/llm/contract/types.ts). T00의 judge(SemanticJudgmentRequest) 초안은
// 범용 invoke로 바꿨다. 의미 판정의 입출력 형식(alignment, evidence_ids)은 structured output으로 T13이 정한다(C103).
interface LLMProvider {
  readonly id: string;
  status(): "disabled" | "configured" | "unavailable";
  invoke(request: LLMRequest): Promise<LLMResponse>;
}
interface LLMRequest {
  purpose: "gap-semantic-assist" | "review-semantic-check";
  instructions: string; input: string;
  output: { mode: "text" } | { mode: "structured"; name: string; schema: JsonSchema };
  maxOutputTokens?: number; signal?: AbortSignal;
}
type LLMResponse =
  | { status: "success"; output: { mode: "text"; text } | { mode: "structured"; text; value }; usage: LLMUsage }
  | { status: "failed"; failure: { category, message, retryable }; usage?: LLMUsage };
LLMUsage = { provider; model?; inputTokens?; outputTokens?; cachedInputTokens?; latencyMs? }   // provider가 보고한 값만
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

## 구현 (T12A)

**Deterministic First, LLM Optional.** Index, Graph, Context Compiler, Knowledge Gap 평가, Decision 생명주기는 Provider 없이 완전히 동작하고 Provider를 받지 않는다. Provider 미설정은 application failure가 아니다.

- **계약**(`llm/contract/types.ts`): vendor API를 복사하지 않는다. message 목록과 role이 없고 instruction 텍스트와 input 텍스트 하나씩, text 또는 structured(표준 JSON Schema) 출력, 용도(`purpose`), `AbortSignal`만 있다. 요청에 credential을 넣지 않는다. credential은 adapter와 설정 계층의 몫이다.
- **호출**(`invokeLLM`): DUO 코드가 Provider를 부르는 유일한 경로다. 던지지 않는다. status(disabled → `not-configured`, unavailable → `unavailable`)와 취소를 먼저 보고 호출하지 않으며, 호출 중 reject는 `provider-error`, 모양이 틀린 응답·출력 mode 불일치·structured 검증 실패·보내지 않은 Evidence ID 인용은 `invalid-response`, 취소는 `cancelled`다(AC-012A-02). failure message의 비밀은 `[REDACTED]`로 바꾼다.
- **failure 분류**: `not-configured`, `unavailable`, `timeout`, `cancelled`, `authentication`, `rate-limit`, `invalid-response`, `provider-error`와 `retryable`. 실제 오류 대응(`timeout`, `authentication`, `rate-limit`)은 adapter가 만든다(T12B).
- **Noop provider**(`createNoopLLMProvider`, T00의 NoneProvider): id `noop`, status `disabled`, 모든 호출에 `not-configured`. 네트워크, 환경 변수, 파일을 읽지 않는다(AC-012A-01, C105).
- **상태**: `llmProviderState(config.llm, provider?)`는 `llm.provider: none`이면 disabled, Provider를 요구하지만 주입되지 않았으면 unavailable, 아니면 Provider의 status다. config schema는 바꾸지 않았다.
- **usage**(`llmUsageRecord`, AC-012A-03): `runtime/metrics.jsonl` 한 줄 형식. token 값은 Provider가 보고한 것만 두고 `tokenSource`는 provider 또는 none이다. 추정값을 usage에 넣지 않는다(chars/4 금지). DUO가 보낸 텍스트를 o200k_base로 잰 값은 따로 `requestEstimate`에 둔다(C104). 기록 쓰기는 호출자(C83).
- **보조 구조**(`assistDeterministic`): 결정적 결과 → 선택적 의미 보조 → 추가 해석. 결정적 결과는 Provider 결과와 관계없이 그대로 돌려준다.
- **패키지 경계**: 계약은 director 소유다. adapter는 `packages/integration/src/llm/`에서 director의 `LLMProvider`를 구현한다(integration → director). vendor SDK(openai, @anthropic-ai/sdk, @google/genai 등)는 그 디렉터리 밖에서 import할 수 없다(lint, `scripts/boundaries.json` llmVendorSdk). T12A는 외부 dependency를 추가하지 않았다.
- 하지 않은 것: 실제 API 호출, API key 읽기, 의미 판정, retry·backoff, model routing, Provider registry·fallback chain.

## 결과

- 추가 Adapter는 REQ-POST-004로 다룬다. 추가할 때 `LLMProvider` 계약은 바뀌지 않아야 한다.
