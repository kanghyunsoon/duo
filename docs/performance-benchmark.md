# TASK-019 Benchmark와 성능 특성

이 문서는 DUO가 실제 규모의 저장소에서 드는 비용과 Context Compiler의 절감·품질을 재현 가능한 절차로 기록한다. 수치는 모두 아래 기준 환경, fixture, operation에 묶인 측정값이며 SLA나 일반 성능 약속이 아니다.

## 실행

| 명령 | 내용 |
|---|---|
| `pnpm benchmark:smoke` | small fixture와 JSON 계약 검사. CI(Ubuntu, macOS, Windows)에서 build 뒤 실행 |
| `pnpm benchmark` | build 후 100/1,000/5,000 source file 측정, 계약 검사, Context cache 회귀, analyzer upgrade, 증분 시간과 T08 불변식, DUO self, packed 배포본 |
| `node bench/compare.mjs <before.json> <after.json>` | 두 실행의 결정적 결과(Packet digest, 기대 Entity, parse/reuse 수, Review verdict·claim·Evidence ID) 비교. 시간은 비교하지 않음 |
| `node bench/experiments/*.mjs` | 원인 분해용 실험(cache 읽기, import 비용, 장기 실행 상태, CPU profile 요약) |

결과는 Git에서 제외되는 `bench/results/local/`에 JSON과 Markdown으로 쓴다. 생성 fixture, 원본 결과, profile은 Project Truth가 아니며 커밋하지 않는다. generator와 시나리오 코드, 이 요약만 추적한다.

## 기준 환경

Windows 11 x64, Intel Core Ultra 7 155H(22 logical CPU), 메모리 31.5 GiB, Node v24.18.0, Git 2.55.0.windows.3, DUO 0.1.0(commit 886e515 기준 + TASK-019 변경), fixture `duo-bench-fixture/1`, seed 19019, 결과 위치 `bench/results/local`(저장소와 같은 NTFS 볼륨). 모든 결과 JSON에 같은 항목을 기록한다. 실행 시각은 metadata이고 identity가 아니다.

## 측정 방식

- **Fixture**: 고정된 `fixtures/context/app`(Requirement, Decision, Issue, Test, CALLS가 있는 TS 14개 파일과 Truth)에 generator가 파일을 더해 source 100 / 1,000 / 5,000개를 만든다. small은 TS만, medium과 large는 TS, Java, C#, C++, Python, 분석기 없는 `.rs`(L0)를 차례로 섞는다. TS 파일은 chain, fan-out/fan-in hub, import를 만든다. 같은 seed와 설정이면 같은 저장소가 나온다. 파일이 짧은 synthetic 코드라 실제 제품 저장소를 대표하지 않는다.
- **분석 수준**: small 100 structural(L2 TS) + 5 L0, medium 836 structural(TS 179 L2, Java 165·C# 164·C++ 164·Python 164 L1) + 169 L0, large 4,169 structural + 836 L0.
- **Cold**: 새 Node process. worker가 ESM import, 문법 registry 생성, SQLite open, operation, 전체 시간을 따로 기록하고 부모가 spawn부터 출력까지를 잰다. CLI의 실행 모델이다.
- **Warm**: 한 process에서 registry를 재사용하고 operation마다 GraphStore를 연다. MCP와 UI는 각각 별도의 장기 실행 process(stdio MCP 서버, HTTP 서버)로 잰다.
- **단계 시간**: `indexRepository`와 `inspectIndex`의 선택적 observer(Truth, scan, fingerprint, state, registry, analysis/cache, Git, graph plan, write). 결과, index state, digest에는 들어가지 않는다. Review는 `ReviewPerformance`(freshness, diff, context, gap, rules, semantic, total). 둘 다 결정적 결과 본문 밖에 있다.
- **반복**: 빠른 operation은 warmup 1회 뒤 full 5회(smoke 2회), median/min/max. 초기 index와 cold process는 규모별 1회라 특성 기록이고 p95는 쓰지 않는다. RSS/heap은 operation 뒤 값이며 peak가 아니다.
- **LLM**: 모든 측정은 `llm.provider: none`, llmCalls 0. provider none에서 status를 실행해도 OpenAI SDK 모듈은 0개 로드된다(import hook으로 확인). 실제 API latency는 넣지 않는다.
- **Tokenizer**: 모든 token 값은 `o200k_base`(gpt-tokenizer 4.0.0)이다.

### 생성 직후 첫 실행과 정상 상태

이 Windows 환경에서는 방금 만든 파일을 처음 읽는 실행이 크게 느리다. 5,000파일에서 초기 index 직후의 cold no-op index는 12.2초였지만 같은 상태를 다시 실행하면 3.5~3.8초였다. 설치 직후 배포본의 첫 `duoctl status`도 18.3초였고 다음부터 1.4초였다. 새 파일의 첫 접근 비용(실시간 파일 검사 포함으로 추정)이다. 두 값 모두 사용자가 겪을 수 있으므로 둘 다 기록하고, 초기 index처럼 fresh fixture에서만 잴 수 있는 값은 두 번의 full 실행 범위로 적는다.

## Index

| Fixture | 초기 index operation | cold no-op(첫 실행 / 정상) | warm no-op median | 재parse |
|---|---:|---:|---:|---:|
| small (100) | 1.2~1.3 s | 1.7~2.0 s | 0.64~0.72 s | 0 |
| medium (1,000) | 3.3~5.5 s | 3.0~4.6 s | 0.96~1.1 s | 0 |
| large (5,000) | 17.7~20.5 s | 12.2 s / 3.5~3.8 s | 2.4~4.3 s | 0 |
| DUO self (594 indexed, 413 structural) | 8.8~9.8 s | 1.3~4.1 s | - | 0 |

large 초기 index(첫 실행)의 단계: analysis 14.4 s(그중 AST parse 합계 1.5 s, 나머지는 파일 읽기와 파일별 분석 cache 쓰기), graph write 1.0 s, Git 0.8 s, graph plan 0.8 s, scan 0.4 s. 언어별 parse 합계(large): TS 845개 658 ms, C# 831개 241 ms, Java 227 ms, Python 215 ms, C++ 186 ms. DUO self에서는 TS 379개 parse가 2.3 s였다(synthetic 파일보다 길다).

large cold no-op(정상 상태): module import 0.9 s, registry 0.06 s, SQLite open < 10 ms, analysis cache 확인 1.1 s, scan 0.3 s, fingerprint 0.26 s, Git 0.35 s, graph plan 0.25~0.33 s, write/state 0.2 s. CPU profile의 최상위는 파일 읽기 0.94 s와 lstat 0.44 s였다. cache 4,169개(5.7 MB)의 순수 비용은 lstat 경로 검사 0.2 s, 읽기 0.55 s, JSON parse 0.02 s였다.

**증분 index**(장기 실행 / cold 전체):

| Fixture | TS | Java | C# | C++ | Python | 5개 동시 |
|---|---:|---:|---:|---:|---:|---:|
| medium | 1.19 / 2.36 s | 1.10 / 2.12 s | 0.97 / 2.08 s | 0.87 / 2.03 s | 0.87 / 2.00 s | 0.91 s |
| large | 2.51 / 3.59 s | 2.38 / 3.49 s | 2.52 / 3.55 s | 2.45 / 3.45 s | 2.37 / 3.41 s | 2.39 s |

매번 parse 1개(5개 동시는 5개), 바뀐 scope 1개, module resolution 1개, CALLS 재계산 1~2개였고, 모든 편집 뒤 증분 Graph가 clean full rebuild(collect → build → 메모리 적용)와 같았다. medium 강제 full rebuild도 증분 결과와 같았다(2,390 node, 3,271 edge). 시간의 대부분은 변경 파일 수와 무관한 고정 비용(scan, fingerprint, 나머지 파일의 cache 확인, Git)이다.

**Analyzer identity 변경**: medium에서 Java analyzer identity만 바꾸면 Java 165개만 다시 parse하고 TS 179·C# 164·C++ 164·Python 164개는 cache를 재사용했다(parse 0). 전체 무효화는 없었다.

## 문법 load

각 문법을 새 process에서 load한 시간: TS 36 ms, TSX 38 ms, JS 9 ms, Java 32 ms, C# 42 ms, C++ 35 ms, Python 30 ms, 7개 모두(registry) 79 ms. 개별 값에는 web-tree-sitter 초기화가 포함되어 합보다 전체가 작다. 5.35 MB인 C# WASM도 42 ms다. 같은 process의 module import는 0.8~1.0 s라서 문법 load는 cold 시작 비용의 약 5%다. 실제 쓰는 문법만 load하면 최대 약 50 ms를 줄일 수 있다.

## Freshness

`inspectIndex`(status, context, review가 공유)는 정상 상태 large에서 2.1~2.4 s, medium 0.9~1.0 s, small 0.55~0.69 s다. 내용은 scan, fingerprint, 파일별 분석 cache의 존재와 유효성 확인(각 항목을 읽고 parse), Git 상태다. 저장소 크기에 비례하며 mtime, TTL, watcher 없이 contentHash로만 판정한다.

## Context

| Task(large) | status | seed / 후보 | packet | 후보 표현 | 관련 파일 원문 | source corpus | 기대 Entity |
|---|---|---:|---:|---:|---:|---:|---|
| AUTH-03 (Requirement ID) | ready | 1 / 16 | 2,023 | 1,790 | 1,602 | 137,048 | 4/4 |
| AuthService.refresh (Symbol) | ready | 7 / 19 | 2,314 | 2,011 | 1,717 | 137,048 | 2/2 |
| GAME-42 (Issue) | ready | 1 / 9 | 1,348 | 1,115 | 1,304 | 137,048 | 2/2 |
| Refresh Token (자연어) | ready | 8 / 25 | 2,999 | 2,684 | 1,971 | 137,048 | 1/1 |
| fix normalize (중복 Symbol) | ambiguous | - | - | - | - | - | 임의 선택 없음 |
| `.rs` 파일(L0) | ready | 8 / 8 | 803 | 448 | 152 | 137,048 | budget 안 |

- Packet 내용과 dependency digest는 규모와 관계없이 같다(small, medium, large에서 AUTH-03 digest 동일). 관계없는 파일이 늘어도 Packet이 바뀌지 않는다.
- **Source corpus → Packet**: `1 − packet / sourceCorpus`. source corpus는 `src/**`의 `.ts .tsx .js .java .cs .cpp .py .rs` 원문 token 합이며 Truth, 문서, binary, generated, 제외 파일을 넣지 않는다. AUTH-03: small 9,039 → 77.62%, medium 28,959 → 93.01%, large 137,048 → 98.52%.
- **후보 표현 → Packet**: `1 − packet / candidateTokens`. AUTH-03 −13.02%: Packet은 frame, EVIDENCE 줄, pending decision을 더 담아 후보 표현 합보다 크다. **관련 파일 원문 → Packet**은 −26.28%다. fixture의 관련 파일이 짧아서 파일 원문을 통째로 읽는 편이 더 작다. 이 fixture에서는 Context 절감이 “관련 파일만 읽는 Agent” 대비로는 나타나지 않는다.
- `ContextResult.metrics.repository.tokens`(indexedText)는 Truth와 문서도 포함한다(large 138,607). 공개 절감률의 분모로 쓰지 않는다.
- 시간(장기 실행 median, 적용 후): small 0.66~0.73 s, medium 1.0~1.1 s, large 2.2~2.3 s(full 실행) 또는 2.5 s(`projectContext`, 정상 상태). 대부분 freshness다.
- **Cache**: 같은 요청 두 번째 hit, 관계없는 파일 변경 hit(digest 동일), Requirement 본문·선택된 Symbol·budget 변경은 miss(digest 변경). hit가 freshness를 건너뛰지는 않으므로 small에서 miss 614 ms, hit 569 ms 수준이다.

## Review

`fixtures/review/app` 시나리오(장기 실행, 5회 median, 적용 후): PASS 1.61 s, WARN 1.70 s, BLOCK 1.46 s, ASK 1.73 s, 분석기 없는 언어(`.rs` 추가) 1.46 s. 마지막 시나리오의 WARN은 확정 Intent와 이어지지 않은 새 파일의 `missing-intent` gap 때문이다. 같은 파일을 `.ts`로 추가해도 WARN이므로 분석기 부재가 판정을 올리지 않으며, `structural-analysis-unavailable`은 limitation으로만 보고된다. 단계는 freshness와 Truth·baseline 읽기 약 0.55~0.72 s, Git diff 0.65~1.3 s, context 30~60 ms, gap·rules·evidence·aggregate < 12 ms. 이 측정 뒤 `ReviewPerformance`에 freshnessMs와 gapMs를 따로 기록하도록 했다. 같은 요청을 반복하면 결과가 byte 단위로 같았다. baseline provenance(pre-existing-touched는 WARN, introduced는 BLOCK)는 adoption·MCP e2e가 계속 검증한다. large clean Review: 3.9~4.5 s(cold).

## MCP와 UI

small, 같은 process에서 연속 호출(적용 후): MCP connect 0.9~1.3 s, 첫 status 0.65 s, 다음 status 0.53~0.59 s, 첫 context 0.74 s, 같은 context 0.93 s, review 1.24 s. UI 서버 시작 24~28 ms, overview 0.70 s, direction 16~29 ms, graph(trace depth 2) 0.65~0.72 s, context 0.77~0.81 s, review 1.4~1.6 s. 호출 비용은 대부분 freshness다. UI는 polling 없이 Refresh로만 다시 읽는다.

## Graph trace·impact

200 node 상한 유지, 5회 median: trace depth 1은 0.2~0.7 ms, depth 3은 0.6~1.6 ms, impact(depth 3)는 2~5 ms(small, medium, large 모두).

## Memory와 disk

operation 뒤 RSS/heap(benchmark process): small 209~253 / 59~94 MB, medium 375~470 / 82~108 MB, large 484~513 / 154~157 MB. generated 데이터: small 449 KB(graph.db 300 KB, index state 114 KB), cache 351 KB. medium 2.9 MB(graph.db 2.0 MB, state 611 KB), cache 1.3 MB. large 14.1 MB(graph.db 9.7 MB, state 2.9 MB), cache 6.0 MB. Human Truth(`.duo-project`에서 generated·cache 제외)는 4~5 KB. reviews는 제외했다.

## 배포본

packed tarball(1,343,096 B, unpacked 13,999,607 B)을 임시 prefix에 설치해 small fixture에서 status, context, review를 실행했다. 결정적 결과(status 형식·index 상태, Packet digest, Review verdict·claim·Evidence ID)가 workspace build와 같았다. 3회 median: status workspace 1.69 s / packed 1.38 s, context 1.91 / 1.53 s, review 2.73 / 2.35 s. packed는 단일 bundle이라 module 해석이 적다. 설치 직후 첫 status는 18.3 s였다(위 “생성 직후 첫 실행”).

## C145: 호출당 비용의 원인

CI(GitHub hosted runner, commit ac3a902)의 small smoke 한 번: Ubuntu initial 0.31 s / cold no-op 0.67 s / context 0.10 s, macOS 0.22 / 0.57 / 0.08 s, Windows 0.95 / 1.53 / 0.39 s. runner 하드웨어가 달라 직접 비교하지 않지만, 파일 단위 lstat·읽기가 많은 freshness와 index 비용이 Windows에서 특히 크다는 profile 결과와 방향이 같다. 위 표의 수치는 Windows 기준 환경 값이다.

| 구성 요소 | 측정 | 비고 |
|---|---:|---|
| Node process 시작 | 90~97 ms | CLI만 |
| module import(integration까지) | 0.85~0.99 s | CLI만. core 단독 0.3 s, packed bundle은 약 0.3~0.4 s 적음 |
| 문법 7개 WASM load | 79 ms | registry 생성. MCP는 호출마다, UI는 한 번 |
| SQLite open | < 10 ms | |
| freshness(scan, fingerprint, cache 확인, Git) | 0.55 s(small) ~ 2.2 s(large) | 호출마다, 저장소 크기에 비례 |
| Context 저장소 token 지표 | 1.2 s(large, 적용 전) | 컴파일마다, Review는 2회 |

장기 실행 process에서도 호출당 0.5초 이상이 드는 원인은 freshness다. registry를 재사용해도 large status는 2.4초로 차이가 측정되지 않았다. MVP에서는 freshness를 정확성 우선 비용으로 유지한다. mtime, TTL, watcher, 자동 index는 도입하지 않는다.

## 적용한 최적화

**저장소 token 수 memo** 하나만 적용했다. `repositoryTokens`가 caller가 준 in-memory memo(content hash → token·char 수)를 먼저 본다. Review는 한 operation의 두 번 컴파일이 memo 하나를 공유하고, MCP 서버와 UI 서버는 수명 동안 하나를 쓴다. CLI는 호출마다 새로 만든다. 값은 content hash가 정하는 canonical text의 순수 함수이고 Packet 밖 지표라 결과가 바뀌지 않는다. 파일을 쓰지 않으며, 호출마다 현재 파일 항목만 남겨 크기가 저장소 크기로 제한된다. 회귀 테스트가 memo 사용 여부와 관계없이 metrics와 Packet이 byte 단위로 같은지, 파일 변경 뒤 오래된 항목이 없어지는지 확인한다.

| large, 장기 실행, 같은 상태(4회 median) | 적용 전 | 적용 후 |
|---|---:|---:|
| `projectContext` AUTH-03 | 3.90 s (metrics 1,203 ms) | 2.48 s (metrics 15 ms) |
| `projectReview` AUTH-03 | 6.15 s (context 2,798 ms) | 3.86 s (context 276 ms) |
| `projectStatus` | 2.42 s | 2.39~2.51 s(변경 없음) |

최적화 전후 full 실행의 결정적 결과(Packet digest, 후보·seed 수, 기대 Entity, parse/reuse 수, Review verdict·claim·provenance·Evidence ID)는 small, medium, large 모두 같았다(`bench/compare.mjs`). full 실행 사이의 시간 차이는 fixture를 새로 만든 영향이 섞여 최적화 효과로 주장하지 않는다.

**적용하지 않은 후보**

- registry 재사용(MCP): 효과가 측정 오차 안(약 70 ms).
- 실제 쓰는 문법만 lazy load: 최대 약 50 ms, cold 시작의 약 3~5%. 효과가 작다.
- freshness의 cache 확인을 존재 여부 검사로 줄이기: 손상된 cache를 current로 보고해 Indexer 판단과 달라진다(correctness 계약 위반).
- cache 경로의 symlink 검사를 operation당 한 번으로 줄이기: large에서 약 0.3 s. 안전 검사 범위가 바뀌므로 별도 결정 없이 적용하지 않는다.
- module import 지연(CLI): 약 0.9 s로 크지만 command별 import 구조를 바꾸는 일이라 이번 범위 밖이다.

## REQ-NFR-004 초기 목표와 실측

| 초기 목표 | 실측 | 비고 |
|---|---|---|
| source 1만 파일 init 60초 이내 | 5,000 synthetic 파일 초기 index 17.7~20.5 s | 1만 파일은 측정하지 않았다. 짧은 synthetic 파일이다 |
| 변경 20파일 이하 증분 2초 이내 | 5개 변경 medium 0.91 s, large 2.39 s(장기 실행). 1개 변경 cold large 3.4~3.6 s | 고정 freshness 비용이 지배한다 |
| `duoctl context` 1초 이내 | cold CLI small 1.5~1.9 s, 장기 실행 small 0.7 s, medium 1.0~1.1 s, large 2.2~2.5 s | |

위 표는 T19 당시의 기록이다. 초기 목표를 환경 조건 없는 universal 목표로 읽으면 context는 medium 이상, 증분 index는 large에서 NOT MET이었다.

**결정(H-44, Human 승인)**: REQ-NFR-004를 benchmark-scoped target으로 명확히 했다. 목표 수치(context 1초, 증분 2초, 1만 파일 init 60초)는 그대로이고, repository scale(`duo-bench-fixture/1` small·medium·large), operation, warm/cold, 기준 환경을 명시했다. 목표를 낮춘 것이 아니라 검증 가능한 측정 범위를 적은 것이다. 이 조건에서 현재 상태는 context small MET·medium NOT MET·large NOT MET, 증분 index medium MET·large NOT MET, 1만 파일 init 미측정이다([REQ-NFR-004](01-requirements.md#req-nfr-004-성능-목표)). SLA가 아니며 다른 기기에서의 보장이 아니다.

## 공개할 수 있는 주장

- “DUO benchmark fixture `duo-bench-fixture/1`(5,000 synthetic source files, TS/Java/C#/C++/Python/L0)에서 AUTH-03 task의 Packet은 2,023 o200k_base token이며, 137,048 token source corpus 대비 98.52% 작다. 같은 Packet은 100-file fixture에서도 같은 digest로 만들어진다.”
- “같은 fixture에서 Packet은 관련 파일 원문 합(1,602 token)보다 26% 크다.” 절감은 저장소 전체 대비이며 관련 파일만 읽는 경우 대비가 아니다.
- 시간 주장에는 위 기준 환경, fixture, operation을 함께 쓴다.


## 설치 직후 첫 실행 (Release Hardening)

T19에서 본 “설치 직후 첫 `duoctl status` 18.3 s”를 같은 Windows 기준 환경에서 분해했다(`bench/experiments/first-run*.mjs`, 결과는 Git 제외 `bench/results/local/first-run*.json`). packed tarball을 매번 새 npm prefix에 설치하고 3라운드 반복했다.

| 시나리오 | 1회 | 2회 | 3회 |
|---|---:|---:|---:|
| A. 새 package + 기존 initialized project | 17.4~18.6 s | 1.45~1.47 s | 1.45 s |
| B. 새 package + 새 project | 18.4~18.9 s | 1.43~1.49 s | 1.46~1.53 s |
| D. 새 package, 설치 파일을 먼저 한 번 읽음(63~78 s, 7,481 파일 108.5 MB) | 1.38~1.54 s | 1.41~1.48 s | 1.41~1.57 s |

- 프로세스 시작부터 사용자 코드까지 20~36 ms, 프로세스 밖(spawn, 종료) 68~108 ms로 매번 같았다. 차이는 모두 프로세스 안에서 났다.
- 첫 실행 CPU profile(19.2 s): 16.5 s가 Node ESM loader가 모듈 소스 파일을 여는 `openSync` 안이었다. DUO 작업(Truth 로드, scan, freshness, registry와 문법 load, SQLite open, Git)의 CPU 시간은 합쳐 0.4 s 미만이었다. 문법 WASM(12 MB)을 여는 시간은 22 ms였다.
- 모듈별(load hook): 첫 실행은 모듈 310개 로드에 16.9 s, 두 번째는 같은 310개에 0.22 s. typescript(파일 1개, 8.9 MB) 9.6 s → 0.12 s, gpt-tokenizer(2.4 MB) 2.1 s → 0.007 s, zod(0.8 MB) 1.3 s → 0.04 s, DUO bundle(0.76 MB) 1.0 s. 새로 쓰인 JavaScript 파일의 첫 open이 KB당 약 1 ms였다.
- 새 project(B)는 비용을 늘리지 않았다. 설치 파일을 먼저 읽으면(D) 첫 실행도 정상이다.
- 이 PC의 Windows Defender는 실행 중이 아니었고(`AMRunningMode: Not running`), Security Center에는 AhnLab V3 Internet Security가 활성 백신으로 등록되어 있다. 측정 패턴은 스크립트 파일에 대한 on-access 검사와 일치하지만 보안 제품을 끄고 비교하지 않았으므로 원인을 확정하지 않는다. DUO 쪽에서는 **unattributed external startup cost: first open of newly installed JavaScript module files**로 기록한다.

**판단**: 설치 직후 1회만 발생하고, 같은 실행 안의 DUO 작업은 정상이며, 이후 호출은 1.4~1.5 s로 정상이다. release blocker가 아니며 limitation으로 문서화한다. 보안 검사를 우회하거나 끄는 조치는 하지 않는다. CLI가 명령에 필요 없는 큰 모듈(typescript 등)을 처음부터 로드하는 점은 이 비용의 절반 이상을 차지하지만, lazy import는 C202로 계속 보류한다.

## Real-world baseline (T23)

이 절은 위의 TASK-019 synthetic 측정과 별개의 데이터다. T22의 real-world 수치([0.2.0 audit §3](roadmap/0.2.0-audit.md#3-real-world-performance))는 historical observation으로 그대로 두고 덮어쓰지 않는다.

```
pnpm build
pnpm benchmark:realworld                        # 5개 저장소 → bench/results/local/realworld.json
node bench/realworld-suite.mjs --ci             # 3 OS workflow와 같은 작은 저장소 3개
node bench/compare.mjs a.json[,a2.json] b.json[,b2.json]
```

**구조.** 새 framework 없이 기존 `bench/`를 확장했다.

| 파일 | 역할 |
|---|---|
| `bench/realworld-repos.mjs` | manifest: stable ID, URL, 정확한 commit SHA, project type, 기대 analysis level, 1-file 편집 대상, Context 시나리오와 T22 관찰, CI 대상 여부 |
| `bench/realworld-suite.mjs` | SHA 하나만 depth 1로 fetch(branch·tag 없음)해 OS temp에 받고, 매 실행 전 pristine checkout으로 되돌린다(`checkout --force`, `clean -ffdx`). 저장소마다 새 process로 runner를 실행한다. `--duo-root`는 다른 DUO checkout의 build로 같은 저장소를 잰다(A/B). `--keep`이 없으면 clone을 지운다 |
| `bench/realworld.mjs` | 저장소 하나를 측정하고 JSON 하나를 출력한다 |
| `bench/compare.mjs` | 결과 형식으로 분기한다. synthetic 형식은 그대로 두고, real-world 형식은 결정적 필드 전체를 비교하고 시간은 나란히 보여 준다 |
| `.github/workflows/realworld.yml` | 수동 `workflow_dispatch` 3 OS job. push와 PR에서는 실행하지 않는다 |

**측정 순서(runner).**

1. cold process의 CLI `init --baseline-policy head`
2. generated와 cache를 지운 initial index와 Graph capture
3. no-op freshness 3회
4. pristine tree에서 Context 시나리오 실행(시나리오마다 2회)
5. 편집 대상 파일 끝에 새 최상위 선언 하나를 붙인다. 줄 끝은 파일의 기존 EOL을 따른다
6. incremental index와 Graph capture
7. generated와 cache를 다시 지우고 같은 tree를 clean full rebuild한 뒤 Graph capture
8. canonical 비교(`dumpGraph` JSON 동일)
9. Review HEAD → WORKTREE

source 저장소에는 commit하지 않는다.

**결과 형식(internal, 공개 계약 아님).** suite 결과는 `duo.bench-realworld/1`, 저장소별 runner 출력은 `duo.bench-realworld-run/1`이다.

| 구분 | 필드 | 비교 |
|---|---|---|
| deterministic | init exit·baseline, scan(total, Project Truth 파일과 경로, repository 파일 수와 경로 목록 SHA-256, 제외 사유별 수), coverage(files, 언어별 files·level·analyzer, 파일만 확장자), Graph(initial·incremental·clean full의 node·edge 수와 SHA-256, 동일 여부), no-op status·parse 수, 편집(path, EOL, byte, mode, 분석 파일 수), Context 시나리오별(status, 파일, found, missing, dependency digest, omitted, truncated), Review(verdict, claim alignment·rule·subject) | 같아야 한다 |
| build | DUO commit, uncommitted 여부, analyzer registry digest, Node, platform | 보고 |
| environment | Git 버전, `core.symlinks`·`core.autocrlf`, 최대 경로 길이(저장소 기준·절대), 대소문자 충돌 수 | 보고 |
| timings, memory, operations | init, import, grammar load, initial·no-op·incremental·clean full index, Context, Review, peak RSS·heap, no-op과 incremental의 git process·fs 호출 수 | gate 아님 |
| checks | init, initial index, no-op current, scan accounting(repository 파일 = coverage total), 기대 level, 1-file incremental, incremental 뒤 current, incremental = clean full, 편집 감지, 결정적 출력에 절대 경로 없음 | 하나라도 실패하면 DUO correctness failure |

**T22의 "4개 차이"(C221).** scan 수 = repository 파일 + Project Truth 파일 4개(`.duo-project/.gitignore`, `intent/constraints.yaml`, `intent/vision.md`, `project.yaml`)다. scanner는 Truth 변경을 감지하려고 이 파일을 fingerprint하고, coverage와 Graph는 `.duo-project/`를 repository 파일로 세지 않는다(H-24). 5개 저장소 모두 `scan-accounting` check가 통과한다.

**실패 구분.** suite exit code는 다음과 같다.

| exit | 의미 |
|---|---|
| 0 | 정상 |
| 1 | DUO correctness failure(runner check 실패) |
| 2 | network failure(fetch) |
| 3 | harness failure(git 없음, checkout 실패, runner 비정상 종료, build 없음) |

compare exit code는 다음과 같다.

| exit | 의미 |
|---|---|
| 0 | 결정적 필드 동일 |
| 1 | 결정적 필드 차이 |
| 2 | 비교 불가(다른 SHA나 다른 platform) |

네 경우를 모두 직접 발생시켜 확인했다.

- network: 닿지 않는 proxy로 fetch → 2
- harness: 받지 않은 저장소에 `--no-fetch` → 3
- correctness: manifest 기대 level을 틀리게 바꿈 → 1
- 비교: SHA를 바꾼 결과 → 2, 결정적 필드 하나를 바꾼 결과 → 1

**측정(2026-09-30).** Windows 11, Intel Core Ultra 7 155H(22 logical), 32 GB, Node 24.18.0, Git 2.55.0, DUO 0.1.2 제품 코드다. 같은 build로 연속 두 번 실행했고, 결정적 필드는 5개 저장소 모두 같았다. 시간은 두 실행의 범위다.

| 저장소 | SHA | repository 파일 (+Truth) | 구조 분석 / 파일만 | 언어 (level, 파일) | Graph node / edge | CLI init | initial index | no-op freshness | 1-file incremental | clean full | Context | Review | peak RSS |
|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| spring-petclinic | `500158f7` | 132 (+4) | 50 / 82 | java L1 50 | 456 / 652 | 4.6–5.2 s | 0.96–0.99 s | 0.58–0.64 s | 0.55–0.58 s | 0.92 s | 0.70–1.00 s | 1.6–1.8 s | 280–322 MB |
| bulletproof-react | `9506629e` | 528 (+4) | 447 / 81 | typescript L2 422, javascript L2 25 | 1,335 / 2,675 | 8.2–8.4 s | 2.7–4.6 s | 0.80–1.10 s | 0.88–1.33 s | 2.8–4.4 s | 0.77–2.20 s | 2.2–3.3 s | 382–449 MB |
| full-stack-fastapi-template | `cb740b65` | 246 (+4) | 152 / 94 | typescript L2 109, python L1 43 | 955 / 1,484 | 6.3–7.0 s | 1.6–2.8 s | 0.61–0.88 s | 0.66–1.06 s | 1.6–2.6 s | 0.83–1.43 s | 1.8–2.6 s | 358–380 MB |
| ActionRoguelike | `9e4ee5ff` | 1,948 (+4) | 168 / 1,780 | cpp L1 164, csharp L1 4 | 2,780 / 3,256 | 10.3–10.6 s | 2.6–3.4 s | 1.67–1.97 s | 1.44–2.14 s | 2.5–3.6 s | 1.58–2.38 s | 2.9–3.6 s | 389–408 MB |
| EntityComponentSystemSamples | `6786a741` | 8,074 (+4) | 851 / 7,223 | csharp L1 851 | 13,342 / 16,808 | 21.9–22.5 s | 7.1–10.7 s | 2.89–4.10 s | 3.08–5.10 s | 7.2–11.3 s | 3.43–5.76 s | 5.2–7.3 s | 572–586 MB |

- incremental Graph는 5개 저장소 모두 clean full rebuild와 같았다. FastAPI의 편집 대상(`items.py`)은 CRLF 파일이다.
- no-op freshness 한 번에 git process는 모든 저장소에서 8개다. fs 호출 수(`readFileSync` / `lstatSync`)는 spring 54 / 390, react 454 / 2,540, FastAPI 158 / 920, ActionRoguelike 172 / 2,785, ECS 855 / 12,408이다.
- grammar load는 39~94 ms다.
- ECS 저장소의 최대 절대 경로는 253자로 Windows MAX_PATH(260)에 가깝다.

**T22 재현.** SHA, 파일 분류(repository와 Truth, 구조 분석과 파일만), 제외 사유별 수, 알려진 한계, Context 시나리오 8개의 status·found·missing이 T22 관찰과 같다.

- Spring: 2/3, `Owner.java` 누락
- React: 경로 없는 과제 ambiguous, 경로를 쓴 과제 2/2
- FastAPI: 1/3과 3/3
- Unreal: 경로 없는 과제 ambiguous, 경로를 쓴 과제 2/3(`RogueAction.h` 누락)
- Unity: 3/3

같은 PC의 시간은 T22보다 대체로 짧았다(예: ECS no-op 2.9~4.1 s, T22 4.10 s). 절대 시간은 재현 대상이 아니다.

**같은 build의 시간 편차.** 같은 build, 같은 세션의 연속 두 실행에서 B/A 비율이 0.78~2.18로 흩어졌다. 그래서 before/after는 다음 절차로 한다.

1. 두 checkout을 각각 build한다.
2. 같은 세션에서 `--duo-root`로 A, B, A, B 순서로 최소 3 round 실행한다.
3. `compare.mjs a1,a2,a3 b1,b2,b3`로 비교한다. 각 쪽의 결과끼리 같아야 하고 시간은 median이다.

이 편차보다 작은 차이는 개선으로 보지 않는다. "몇 % 빨라졌다"는 같은 세션, 같은 저장소에서만 쓴다.

**변화 감지(AC5).** 임시 worktree에서 Python absolute import root에 `backend/` 한 줄을 더해 build하고 FastAPI를 쟀다(commit하지 않음). compare가 exit 1로 차이를 보고했다: Graph edge 1,484 → 1,559(initial), Graph SHA-256, Context dependency digest, 경로를 쓴 과제의 파일 목록.

**3 OS workflow.** manifest에서 `ci: true`인 작은 저장소 3개(spring-petclinic Java L1, bulletproof-react TypeScript L2, FastAPI template Python L1 + TypeScript polyglot, symlink 포함)를 3 OS에서 두 번씩 재고 같은 build 비교를 한다. Unity와 Unreal 저장소는 크기(indexed 합계 약 1.3 GiB)와 시간 때문에 local/manual 성능 측정으로 둔다. 실패는 step으로 나뉜다: fetch(network), measure(harness 3, correctness 1), compare(결정성), hygiene(DUO checkout에 쓴 것 없음).

**Cross-platform hazard.**

| hazard | 처리 | 확인 |
|---|---|---|
| Windows 경로 길이 | fetch한 저장소에 `core.longpaths=true` | Windows 로컬 ECS, 최대 절대 경로 253자 |
| path separator | 결정적 출력은 `/` repository 경로만. 절대 경로 check는 두 구분자를 모두 본다 | 5개 저장소 check 통과 |
| CRLF/LF | `core.autocrlf=false`로 commit된 byte 그대로. 편집은 파일의 EOL을 따른다 | FastAPI CRLF 파일에서 equivalence 성립 |
| 대소문자 | 대소문자 충돌 수를 기록한다. 결정적 비교는 같은 platform끼리만 한다 | 5개 저장소 모두 0 |
| symlink | scanner는 Git index mode로 판정한다. `core.symlinks` 값을 기록한다 | Windows(`core.symlinks=false`)에서 FastAPI symlink 4개 제외. 3 OS는 workflow |
| 실행 방식 | `process.execPath`와 인자 배열, Git은 `execFileSync`. shell 문자열 없음 | 3 OS workflow |
| temp 정리 | clone은 `--work`(OS temp) 아래에만 둔다. `--keep`이 없으면 지우고, `--cleanup`으로 정리한다 | workflow의 hygiene와 remove step |
| Git 사용 가능 여부 | 시작 시 `git --version`, 없으면 exit 3 | suite 시작 검사 |

저장소 내용은 OS 차이를 없애려고 변형하지 않는다. 외부 저장소는 실행 중에 OS temp로 clone할 뿐 DUO 저장소나 npm package에 넣지 않고, 측정 결과는 Git ignored인 `bench/results/local/`에만 쓴다.

