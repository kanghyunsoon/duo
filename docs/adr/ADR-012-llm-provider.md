---
id: ADR-012
type: decision
title: MVP LLM Provider 선택
state: proposed
owner: human
question: mvp_llm_provider
answer: "one OpenAI-compatible Chat Completions provider (OpenAI and local servers)"
governs:
  requirements: [REQ-LLM-002, REQ-LLM-004, REQ-NFR-002]
supersedes: null
proposed_by: codex (TASK-000)
proposed_at: 2026-09-27
---

# ADR-012: MVP LLM Provider 선택

상태: **Proposed** (Human 검토 대기)

## 배경

H-3은 MVP에 실제로 동작하는 Provider 1개를 요구한다. 동시에 D§15는 특정 Provider에 종속되지 않고 향후 OpenAI, Anthropic, Local을 연결할 수 있어야 한다고 한다.

## 선택지

| 후보 | 장점 | 단점 |
|---|---|---|
| OpenAI 호환 Chat Completions API 1종(`base_url` 설정) | 구현 하나로 OpenAI와 로컬 서버(OpenAI 호환 endpoint를 제공하는 서버)를 함께 지원 | Provider별 고급 기능을 쓰지 못함, 호환 서버마다 구조화 출력 지원이 다름 |
| OpenAI Responses API 전용 | OpenAI의 최신 기능 | 로컬 서버 호환성이 낮음 |
| Anthropic Messages API 전용 | Claude 모델 | 로컬 모델 지원 없음 |

## 결정(제안)

`OpenAICompatibleProvider` 하나를 구현한다.

```yaml
# .duo/project.yaml
llm:
  provider: none                 # none | openai-compatible
  base_url: https://api.openai.com/v1
  model: null                    # 사용자가 지정, 기본값 없음
  api_key_env: OPENAI_API_KEY    # 키는 환경 변수에서만 읽는다
  max_calls_per_review: 3
  max_input_tokens: 4000
  timeout_ms: 30000
```

- 기본값은 `none`이다. 사용자가 명시적으로 켜야 네트워크 호출이 생긴다(REQ-NFR-002).
- 구조화 출력을 요청하되, 서버가 지원하지 않으면 JSON 파싱과 zod 검증으로 처리한다. 검증에 실패하면 UNKNOWN으로 둔다.
- 응답의 usage 값으로 토큰을 기록하고, 없으면 o200k_base로 추정해 `estimated`로 표시한다.
- 모델 이름은 코드에 넣지 않는다. 호출 가능한 모델과 파라미터는 TASK-012 착수 시 공식 문서로 확인한다.

## 결과

- Anthropic 등 다른 Provider는 REQ-POST-004로 추가한다. `LLMProvider` 인터페이스는 바뀌지 않아야 한다.
