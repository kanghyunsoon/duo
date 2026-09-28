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
  max_calls_per_review: 1
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
- **T13 추가**: 선택 메서드 `cacheIdentity?(): string | undefined`(secret 없음, 없으면 cache 안 함)와 `invokeLLM` 옵션 `timeoutMs`(wrapper가 강제, `AbortSignal.any`로 호출자 signal과 결합), `cache: { root }`(`.duo-project/cache/llm/`, 성공만, 읽을 때 재검증). usage 기록에 `cached`가 붙는다. Packet cache(`cache/packets/`)와 섞지 않는다.

## 구현 (T12B)

`OpenAIResponsesProvider`(`packages/integration/src/llm/openai/responses.ts`)와 factory(`llm/factory.ts`). 공식 문서로 확인한 요청·응답 형식을 따른다([Create a model response](https://developers.openai.com/api/reference/cli/resources/responses/methods/create), [Structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [Data controls](https://developers.openai.com/api/docs/guides/your-data)).

- **SDK**: `openai` 7.23.0(exact, Apache-2.0, 의존성 없음). integration의 llm 계층에서만 import하고, 처음 호출할 때 dynamic import한다(`--version`, init, index, status는 SDK를 불러오지 않는다). 공개 package의 일반 runtime dependency이며 bundle하지 않는다(C193).
- **공식 endpoint 전용**: client는 `baseURL: https://api.openai.com/v1`, `maxRetries: 0`, `logLevel: "off"`, `organization/project/adminAPIKey/webhookSecret: null`로 만든다. SDK가 환경 변수에서 읽는 값(`OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`, `OPENAI_LOG` 등)을 쓰지 않는다. `llm.base_url`이나 `OPENAI_BASE_URL`이 공식 endpoint가 아니거나 `OPENAI_CUSTOM_HEADERS`가 있으면 provider는 `unavailable`이고 요청하지 않는다(무시하고 공식 API로 보내지 않음). 호환·사용자 endpoint는 별도 Provider다(C189).
- **활성화**: `llm.provider: openai-responses`와 비어 있지 않은 `llm.model`이 둘 다 있어야 한다. model은 문자열이며 DUO는 catalog를 갖지 않고 `/models`를 호출하지 않는다. key는 `llm.api_key_env`(기본 `OPENAI_API_KEY`)에서만 읽고 provider 안에만 둔다. 환경에 key가 있어도 `provider: none`이면 disabled다.
- **요청**: `responses.create({ model, instructions, input, max_output_tokens, store: false, text? })`. structured는 `text.format = { type: "json_schema", name, strict: true, schema }`이고 strict가 받지 않는 `maxLength`/`minLength`만 뺀다(DUO validator는 그대로 검사). tools, `previous_response_id`, conversation, background, stream은 쓰지 않는다. 한 요청은 독립이다.
- **응답**: `status`가 completed가 아니면(incomplete 등), refusal, 빈 출력, JSON이 아닌 structured 출력은 `invalid-response`. 그 뒤 schema와 Evidence ID 검증은 `invokeLLM`과 호출자(T13 `validateAnswer`)가 한다. model text는 failure message에 넣지 않는다.
- **failure**: 401·403 → `authentication`, 429 → `rate-limit`(retryable), 400·404·422 → `provider-error`(retryable 아님: 요청·model·schema 불일치), 408·409·5xx·연결 실패 → `unavailable`(retryable), 연결 timeout → `timeout`, 사용자 abort → `cancelled`. message는 DUO가 status와 분류로 만든다. SDK message, header, 요청은 복사하지 않는다(C191).
- **timeout·retry**: DUO 수준 retry 없음. SDK retry는 끈다(기본 2회는 429·5xx를 반복해 설정한 시간보다 길어진다). 시간 제한은 `invokeLLM`의 `llm.timeout_ms`와 호출자 signal이고 SDK의 시도당 timeout은 그보다 크게 둔다(C190).
- **usage**: `usage.input_tokens`, `output_tokens`, `input_tokens_details.cached_tokens`와 응답의 `model`(요청 model보다 우선). 추정하지 않고 비용을 계산하지 않는다.
- **cache identity**: `openai-responses;endpoint=responses;base=official;adapter=1;structured=strict-1;model=<model>`. key 없음. model이 바뀌면 miss. local 검증 cache(`llm.cache`, 기본 true)는 OpenAI 서버 저장(`store: false`)과 별개다.
- **factory**(`createConfiguredLLMProvider`, `LLMProviderPool`): 설정 + 환경 → `{ provider, status, kind, model?, reason? }`. CLI는 호출마다 환경을 읽고, MCP 서버는 시작할 때 환경을 snapshot하고 provider를 서버 수명 동안 재사용한다(새 key는 재시작, C192). provider는 review나 대화 상태를 쌓지 않는다.
- **연결**: production 경로는 Review의 `review-semantic-check` 하나다(`duoctl review --semantic`, MCP `duo_review_changes`의 `includeSemanticAssist`). `gap-semantic-assist`는 연결하지 않았다.

## 결과

- 추가 Adapter는 REQ-POST-004로 다룬다. 추가할 때 `LLMProvider` 계약은 바뀌지 않아야 한다.
