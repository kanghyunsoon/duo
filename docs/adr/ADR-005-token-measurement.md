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
- o200k_base를 공식 지표의 기준으로 삼는 결정은 유지한다. 구현 라이브러리는 TASK-010(Context Compiler) 착수 전에 크기, 속도, 정확도(참조 구현과의 일치)를 비교해 고르고 이 ADR에 기록한다. TASK-004에는 tokenizer 의존성을 두지 않는다(H-21).
- 파일별 토큰 값의 계산 시점과 캐시 위치도 TASK-010에서 정한다. TASK-004의 fingerprint에는 canonical bytes 길이(`size`)만 있다.

## 구현 선택 (T10)

라이브러리: **gpt-tokenizer 4.0.0**(MIT, 순수 JavaScript, 의존성 없음, package.json에 정확한 version 고정). `packages/director/src/tokens/`에서만 import한다.

| 기준 | gpt-tokenizer 4.0.0 | js-tiktoken 1.0.21 |
|---|---|---|
| o200k_base | 있음(`gpt-tokenizer/encoding/o200k_base`) | 있음(`js-tiktoken/ranks/o200k_base`) |
| 네이티브 build | 없음 | 없음 |
| 설치 크기(unpacked) | 27.2 MB(모든 encoding 포함) | 22.4 MB |
| 정확도 | 이 저장소 파일 266개(1,229,738자, 356,843 token)에서 두 라이브러리의 파일별 token 수가 모두 같음 | 기준으로 비교 |
| 로드 | 107 ms | 402 ms |
| 인코딩(위 266개 파일) | 217 ms | 522 ms |
| 병적 입력(같은 문자 20,000개, emoji 5,000개, 공백 20,000개) | 각각 약 0.6초 | 각각 20초 안에 끝나지 않음 |
| 결정성 | 같은 입력 두 번 같은 값 | - |

측정: Windows, Node 24.18, 2026-09-27. js-tiktoken은 긴 반복 입력에서 초선형으로 느려져 minified 파일이나 생성 코드 한 개가 Compiler를 멈출 수 있어 제외했다. special token 문자열은 `disallowedSpecial`을 비워 일반 텍스트로 센다. tokenizer identity(`o200k_base@gpt-tokenizer@4.0.0`)는 Packet Dependency Digest와 파일별 token 수 cache(`.duo-project/cache/token-counts.json`, content hash key)의 key다. 파일별 값은 요청 시점에 계산하고, cache 옵션이 켜지면 이 파일에 memo한다.

## 결과

- Context Compiler의 packing은 공식 측정 방식으로 budget을 지킨다(REQ-CONTEXT-002).
- 1만 파일에서 계산 시간이 REQ-NFR-004를 위협하면 캐시를 우선 적용한다. 공식 지표는 추정 방식으로 바꾸지 않는다.
