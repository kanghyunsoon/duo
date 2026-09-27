---
id: ADR-005
type: decision
title: 토큰 측정 방식
state: confirmed
owner: human
question: token_measurement
answer: "o200k_base tokenizer for official metrics; chars/4 only as UI approximate fallback; method always recorded"
governs:
  requirements: [REQ-TOKEN-001, REQ-TOKEN-002, REQ-CONTEXT-001, REQ-CONTEXT-002, REQ-CONTEXT-003]
supersedes: null
confirmed_by: human (H-5)
confirmed_at: 2026-09-27
---

# ADR-005: 토큰 측정 방식

상태: **Accepted** (Human 결정 H-5)

## 결정

| 용도 | 측정 방식 | 표기 |
|---|---|---|
| 공식 지표(Context metrics, Benchmark, budget 판정) | tokenizer 기반 `o200k_base`(순수 JS 구현, 네이티브 없음) | `estimator: o200k_base` |
| 정확한 tokenizer를 적용할 수 없는 대상 모델(예: Anthropic, 로컬 모델)에 대한 값 | 같은 o200k_base 값 | `estimated` 표시 |
| UI의 대략 추정(tokenizer 값이 아직 없을 때만) | `ceil(chars / 4)` | `approx (chars/4)` |
| Provider와 무관한 일반 비교 | bytes(UTF-8), chars | 별도 열 |
| LLM 사용량 | Provider 응답의 usage 값, 없으면 o200k_base 추정 | `provider` 또는 `estimated` |

- 모든 결과에 측정 방식을 기록한다. 예: `Token Estimator o200k_base · Repository Tokens 184,312 · Compiled Context 4,921 · Reduction 97.33%`
- `chars/4` 값은 공식 benchmark와 budget 판정에 쓰지 않는다.
- Reduction은 소수 둘째 자리까지 표시한다.
- 파일별 토큰, bytes, chars는 fingerprint 단계에서 한 번 계산해 저장한다(TASK-004).
- JS tokenizer 라이브러리는 TASK-004에서 크기, 속도, 정확도(참조 구현과의 일치)를 비교해 고르고 이 ADR에 기록한다.

## 결과

- Context Compiler의 packing은 공식 측정 방식으로 budget을 지킨다(REQ-CONTEXT-002).
- 1만 파일에서 계산 시간이 REQ-NFR-004를 위협하면 캐시를 우선 적용한다. 공식 지표는 추정 방식으로 바꾸지 않는다.
