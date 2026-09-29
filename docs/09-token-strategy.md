# 09. Token Strategy

상태: Frozen (T00 final, 2026-09-27) · 관련: REQ-TOKEN-001~002, REQ-CONTEXT-003, REQ-LLM-004, [ADR-005](adr/ADR-005-token-measurement.md), [ADR-008](adr/ADR-008-deterministic-first.md)

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
| 공식 지표, benchmark, budget 판정 | tokenizer `o200k_base`(gpt-tokenizer 4.0.0, `packages/director/src/tokens/`) | `o200k_base` |
| 정확한 tokenizer를 적용할 수 없는 대상 모델 | o200k_base 값 | `estimated` |
| UI의 대략 추정(tokenizer 값이 없을 때만) | `ceil(chars/4)` | `approx (chars/4)` |
| Provider와 무관한 비교 | UTF-8 bytes, chars | 별도 열 |
| LLM 사용량 | Provider usage, 없으면 o200k_base | `provider` / `estimated` |

`chars/4`는 공식 benchmark와 budget 판정에 쓰지 않는다.

구현(T10): 공식 값은 `countTokens`/`measureText`(`@duo-director/director`)만 만든다. 라이브러리 import는 `packages/director/src/tokens/`로 제한한다(lint, `scripts/boundaries.json` tokenizer). `<|endoftext|>` 같은 special token 문자열은 일반 텍스트로 센다. DUO는 보낼 텍스트를 세며 control token을 만들지 않는다. tokenizer identity `o200k_base@gpt-tokenizer@4.0.0`은 Packet Dependency Digest와 token 수 cache의 key이므로 라이브러리 version이 바뀌면 둘 다 무효가 된다. `approximateTokens`(`approx (chars/4)`)는 UI 전용이다.

## 지표

| 지표 | 정의 |
|---|---|
| Repository Files | 인덱싱 대상 파일 수(제외 규칙 적용 후) |
| Repository Estimated Tokens | 인덱싱 대상 파일 전체 내용의 토큰 합. T10: index fingerprint 목록의 normalized-text 파일을 canonical text로 센 합이고 raw(binary) 파일은 수만 센다. 파일별 값은 content hash를 key로 `cache/token-counts.json`에 memo할 수 있다(cache 옵션) |
| Repository Bytes / Chars | 같은 파일 집합의 UTF-8 bytes, chars |
| Files Considered | 후보 Subgraph의 Node가 속한 서로 다른 파일 수(정의 파일 포함) |
| Candidate (Raw) Context Tokens | Files Considered 파일 전체 내용의 토큰 합. "관련 파일을 통째로 읽는 Agent"의 비용 근사(`rawCandidateTokens`) |
| Candidate Representation Tokens | 모든 후보를 최대 표현 단계로 넣을 때의 항목 비용 합. frame 제외(`candidateTokens`) |
| Files Loaded | Packet에 L2 이상으로 내용이 들어간 파일 수 |
| Loaded (Compiled) Context Tokens | 렌더링한 Markdown Packet 전체의 토큰 수(`selectedTokens` = `budget.used`) |
| Compiled Context Bytes / Chars | 같은 Packet의 bytes, chars |
| Reduction % | `(1 − Loaded / Repository) × 100`, 소수 둘째 자리. Candidate 대비 값도 함께 기록 |
| LLM Calls | 이 요청에서 DUO가 한 LLM 호출 수 |
| LLM Input / Output Tokens | Provider usage 또는 추정값, 출처 표기 |
| Token Estimator | 측정 방식 이름 |
| Ground-truth Coverage | benchmark 전용. 시나리오의 필수 Node 중 Packet에 L1 이상으로 포함된 비율과 누락 목록 |

Packet 안의 지표와 요청 단위 지표를 나눈다. Repository 합계처럼 관계없는 파일에도 바뀌는 값은 Packet 밖(`ContextResult.metrics`)에 두어 Packet cache를 무효로 만들지 않는다([05 지표](05-context-compiler.md#지표)).

Reduction만으로는 품질을 보장하지 못한다. 아무것도 넣지 않으면 절감률은 100%가 되기 때문이다. 그래서 benchmark는 Coverage를 반드시 함께 보고한다.

## T10 fixture 측정

`fixtures/context/app`(인증, lobby, game 모듈과 문서)에서 `context.demo.e2e.test.ts`가 잰 실제 o200k_base 값이다. budget 6000, cache 사용. 일반화한 절감 주장이 아니며 공식 benchmark는 TASK-019다.

| Task | Repository | Files Considered / Raw | Candidates | Packet | vs Repository | vs Raw |
|---|---|---|---|---|---|---|
| GAME-42 | 5,187 (30 files) | 8 / 1,318 | 9개, 1,144 | 1,364 | 73.70% | −3.49% |
| AUTH-03 | 5,187 | 10 / 1,616 | 16개, 1,819 | 2,039 | 60.69% | −26.18% |
| LOBBY-01 | 5,187 | 9 / 987 | 12개, 1,196 | 1,392 | 73.16% | −41.03% |
| 같은 세 Task, 관계없는 모듈 40개 추가 후 | 17,947 (70 files) | 같음 | 같음 | 같음(cache hit, 같은 digest) | 92.40%, 88.64%, 92.24% | 같음 |

- 이 fixture의 파일은 작아서 Packet이 관련 파일 전체보다 크다(vs Raw 음수). frame(약 290 token), EVIDENCE 줄, Truth 정의 slice가 들어가기 때문이다. 파일이 크고 관련 없는 부분이 많을수록 vs Raw가 양수가 된다. TASK-019에서 실제 저장소로 확인한다.
- Repository가 커져도 Packet은 그대로였다. Packet이 후보 Subgraph에만 의존한다는 성질(Packet Dependency Digest)의 직접 측정이다.

## Benchmark

- 위치 `bench/`, 실행 `pnpm benchmark`(full) 또는 `pnpm benchmark:smoke`(CI 소규모). 방법·한계는 [performance-benchmark.md](performance-benchmark.md).
- 대상: 고정된 `fixtures/context/app`를 바탕으로 만든 100/1,000/5,000 source file repository, `fixtures/review/app` 시나리오, DUO 저장소의 pinned HEAD 복제본. DUO 복제본에는 성능 측정용 Truth overlay를 명시한다.
- 시나리오와 필수 Entity는 `bench/run.mjs`와 `bench/reviews.mjs`에 코드로 고정한다. Generator 버전·seed와 실제 source count를 기록한다.
- 결과: Git ignored `bench/results/local/{smoke,full}.{json,md}`. 측정 원본을 Project Truth로 취급하지 않는다. 추적할 수 있는 작은 요약만 문서에 커밋한다.
- 공식 benchmark는 LLM Provider 없이(`llm.provider: none`, llmCalls 0) 실행한다. 시간과 memory는 환경 의존이므로 동일 DUO 버전·fixture에서도 같지 않다. 결정적 비교 대상은 Graph·Packet·Review 내용, parse/reuse count, expected entity coverage다.
- Context reduction의 공개 기준 denominator는 `src` 안의 source text에 적용한 `o200k_base` 값이다. `ContextResult.metrics.repository.tokens`는 Truth/문서도 포함하므로 별도로 표기하고 공개 절감률 분모로 사용하지 않는다. Candidate representation 대비와 관련 파일 원문(raw candidate) 대비 reduction도 분리한다.

아래는 수치 형식의 설계 예시이며 실측 결과가 아니다. 실측은 [performance-benchmark.md](performance-benchmark.md)를 참조한다.

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
