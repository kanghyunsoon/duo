# 09. Token Strategy

상태: Draft · 관련: REQ-TOKEN-001~002, REQ-CONTEXT-003, REQ-LLM-004, [ADR-005](adr/ADR-005-token-measurement.md), [ADR-008](adr/ADR-008-deterministic-first.md)

토큰 최적화는 DUO의 핵심 기능이다. 절감 주장은 이 문서의 정의와 측정 방식이 명시된 재현 가능한 benchmark로만 한다.

## 우선순위

1. LLM을 호출하지 않아도 되는 판단은 호출하지 않는다(Deterministic First).
2. 전체 Repository를 읽지 않는다(증분 인덱싱).
3. 관련 파일만 찾는다(Seed + Graph).
4. 관련 Symbol만 읽는다(Symbol 단위 로드, L1/L2/L3).
5. 관련 Subgraph만 전달한다(depth, nodeLimit).
6. LLM이 필요하면 작은 Packet만 보낸다(`llm.max_input_tokens`, 호출 수 상한).
7. 반복 Context는 caching 가능하게 구성한다(고정 Section 순서, 불변 항목 앞 배치, 결정적 출력, LLM 응답 cache).
8. 출력은 기본적으로 간결하게 유지한다.

## LLM 사용 범위

LLM을 호출하지 않는 작업과 LLM을 쓸 수 있는 의미 판단 목록은 [ADR-008](adr/ADR-008-deterministic-first.md)에 있다. Context Packet 생성 자체는 LLM을 쓰지 않으므로 `duo_get_context`의 `llm_calls`는 항상 0이다. LLM 호출은 Review의 의미 판정에서만 생긴다.

## 측정 방식

| 용도 | 방식 | 표기 |
|---|---|---|
| 공식 지표, benchmark, budget 판정 | tokenizer `o200k_base` | `o200k_base` |
| 정확한 tokenizer를 적용할 수 없는 대상 모델 | o200k_base 값 | `estimated` |
| UI의 대략 추정(tokenizer 값이 없을 때만) | `ceil(chars/4)` | `approx (chars/4)` |
| Provider와 무관한 비교 | UTF-8 bytes, chars | 별도 열 |
| LLM 사용량 | Provider usage, 없으면 o200k_base | `provider` / `estimated` |

`chars/4`는 공식 benchmark와 budget 판정에 쓰지 않는다.

## 지표

| 지표 | 정의 |
|---|---|
| Repository Files | 인덱싱 대상 파일 수(제외 규칙 적용 후) |
| Repository Estimated Tokens | 인덱싱 대상 파일 전체 내용의 토큰 합. fingerprint 단계에서 파일별로 저장 |
| Repository Bytes / Chars | 같은 파일 집합의 UTF-8 bytes, chars |
| Files Considered | 후보 Subgraph의 Node가 속한 서로 다른 파일 수(정의 파일 포함) |
| Candidate (Raw) Context Tokens | Files Considered 파일 전체 내용의 토큰 합. "관련 파일을 통째로 읽는 Agent"의 비용 근사 |
| Files Loaded | Packet에 L2 이상으로 내용이 들어간 파일 수 |
| Loaded (Compiled) Context Tokens | 출력된 Packet text의 토큰 수 |
| Compiled Context Bytes / Chars | 같은 Packet의 bytes, chars |
| Reduction % | `(1 − Loaded / Repository) × 100`, 소수 둘째 자리. Candidate 대비 값도 함께 기록 |
| LLM Calls | 이 요청에서 DUO가 한 LLM 호출 수 |
| LLM Input / Output Tokens | Provider usage 또는 추정값, 출처 표기 |
| Token Estimator | 측정 방식 이름 |
| Ground-truth Coverage | benchmark 전용. 시나리오의 필수 Node 중 Packet에 L1 이상으로 포함된 비율과 누락 목록 |

Reduction만으로는 품질을 보장하지 못한다. 아무것도 넣지 않으면 절감률은 100%가 되기 때문이다. 그래서 benchmark는 Coverage를 반드시 함께 보고한다.

## Benchmark

- 위치 `bench/`, 실행 `pnpm bench`(TASK-019).
- 대상: `fixtures/`의 repository와 고정 commit으로 pin한 공개 오픈소스 repository 1~2개, 그리고 이 저장소 자체(self fixture).
- 시나리오(`bench/scenarios/*.yaml`): repository, commit, task, budget, 필수 Node 목록, 적용할 diff(선택), 기대 Review verdict(선택).
- 결과: `bench/results/<date>-<git-sha>.md`와 `.json`. 열은 Repository Files, Repository Estimated Tokens, Files Considered, Files Loaded, Raw Context Tokens, Compiled Context Tokens, Reduction %, LLM Calls, Coverage, Review Result, Token Estimator, Bytes/Chars.
- 공식 benchmark는 LLM Provider 없이(`llm.provider: none`) 실행한다. 의미 판정을 포함한 측정은 별도 열(`with_llm`)로 분리하고 Provider와 모델을 기록한다.
- 재현성: 같은 DUO 버전, commit, 시나리오는 같은 결과를 낸다(LLM 열 제외). CI는 fixture 시나리오를 실행해 결과 변화를 diff로 보여 준다.

결과 예:

```text
Token Estimator     o200k_base
Repository Files    1,284
Repository Tokens   184,312
Files Considered    23 / Files Loaded 7
Raw Context         17,806
Compiled Context    4,921
Reduction           97.33% (vs raw 72.36%)
LLM Calls           0
Coverage            12/12
Review Result       WARN (expected WARN)
```
