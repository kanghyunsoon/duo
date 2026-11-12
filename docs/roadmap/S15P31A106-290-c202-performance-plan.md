# S15P31A106-290 C202 성능 개선 후보 작업 계획

Status: In Progress. Date: 2026-11-11. Owner: 김가현. Jira: [S15P31A106-290](https://ssafy.atlassian.net/browse/S15P31A106-290).

C202는 TASK-019에서 적용하지 않고 남긴 성능 후보를 다시 측정하고, 효과와 안전성이 확인된 후보만 적용하는 작업이다. 과거 측정값은 참고하되 이후 `typescript`, `gpt-tokenizer`, YAML·Markdown parser 등의 first-use load가 이미 도입됐으므로 최신 `next`와 패키징된 CLI를 기준으로 다시 판단한다.

## 목표

- 최신 `next`에서 CLI 시작 비용과 module load 구성을 재현 가능하게 측정한다.
- 후보별 성능 효과, correctness 영향, 보안 영향을 구분한다.
- 실행 편차보다 큰 사용자 체감 개선이 확인된 후보만 최소 범위로 구현한다.
- 변경 전후의 CLI 출력·exit code·JSON contract와 결정적 결과가 같은지 검증한다.
- 구현 또는 조사 결과를 저장소와 Jira에 남긴다.

## 현재 후보와 기본 판단

| 후보 | 기존 관찰 | 기본 판단 |
|---|---|---|
| CLI command별 module import 지연 | 약 0.9초 후보였으나 #8의 heavy library first-use load 이후 재측정되지 않음 | 우선 재측정. 효과가 재현되면 구현 후보 |
| 실제 사용하는 문법만 lazy load | 최대 약 50ms | 전체 문법 load 시간이 50ms 하한을 넘지 않으면 제외 |
| cache 경로 symlink 검사를 operation당 한 번으로 축소 | synthetic large에서 약 0.3초 | 보안 검사 범위가 바뀌므로 maintainer 승인 없이는 구현하지 않음 |
| freshness의 cache 확인 경량화 | 손상 cache를 current로 오판할 수 있음 | correctness 계약 위반이므로 제외 |

### CLI import 지연의 기대 효과 상한

과거 0.9초는 #8 이전 값이다. `origin/next` 소스 기준으로 `typescript`, `gpt-tokenizer`, `yaml`, Markdown parser, MCP client는 이미 first-use load이고, 정적으로 남은 외부 module은 `zod`와 `@modelcontextprotocol/server` 정도다. `zod`는 core의 Truth schema 검증이 쓰므로 `status`처럼 Truth를 읽는 command에서는 뺄 수 없다. 따라서 현실적인 이득은 `--version`·`--help`의 시작 비용과, MCP·HTTP를 쓰지 않는 command에서 server 코드를 빼는 정도로 예상한다. 0.9초가 재현될 가능성은 낮다고 보고 시작한다. 이 예상은 소스와 esbuild 설정(`splitting: true`, 패키지에 `sideEffects` 선언 없음)을 읽고 추론한 것이며, 1단계에서 packed bundle의 chunk 구조로 확인한다.

T25.1에서 적용된 analysis cache bounded concurrency와 freshness operation 안의 `git rev-parse --show-prefix` 공유는 완료된 작업이므로 중복 구현하지 않는다.

## 작업 범위

1. 최신 `next`의 clean worktree와 패키징된 CLI로 기준선을 측정한다.
2. `--version`, `--help`, `status`, MCP initialize의 wall time과 module load를 기록한다.
3. 후보를 하나씩 적용한 실험 빌드를 기준 빌드와 교차 실행한다.
4. 효과가 확인된 후보만 production code와 회귀 테스트에 반영한다.
5. Windows에서 성능을 측정하고 Windows·Ubuntu·macOS에서 기능 회귀를 검증한다.
6. 측정값, 제외 근거, 최종 판단을 문서와 Jira에 기록한다.

다음 항목은 범위 밖이다.

- mtime-only, TTL, watcher 또는 stale Graph 허용
- cache 손상 검증, symlink 검사 또는 trust boundary 약화
- Decision 권한, Project Truth 형식, verdict 의미 변경
- 새 dependency, `duoctl` CLI option, public schema 추가(`bench/` script의 측정용 인자는 제품 interface가 아니므로 해당하지 않는다)
- release, publish 또는 성능 목표 수치 변경

## 실행 계획

### 0. 작업 기준 준비

- `git fetch origin next` 뒤 최신 `origin/next`에서 C202 전용 브랜치와 clean worktree를 만든다. 로컬 `next`는 뒤처져 있을 수 있으므로 기준으로 쓰지 않는다.
- 이 계획 문서도 C202 브랜치로 옮겨 함께 commit한다.
- clean worktree에서 의존성을 설치하고 packed CLI 산출물을 만든다.

  ```sh
  pnpm install --frozen-lockfile
  pnpm build
  pnpm pack:cli
  ```

  `pnpm pack:cli`이 만든 `.dist/pack.json`, tarball, `.dist/cli-package/dist/duoctl.js`를 이후 기준선과 A/B 측정에 사용한다.
- 기준 commit, Node 버전, OS, CPU, 메모리, package version을 결과에 기록한다.
- 현재 작업 중인 다른 브랜치와 미커밋 파일은 측정 및 변경 대상에서 제외한다.

### 1. 기준선 측정

기존 script를 재사용하되 현재 한계를 먼저 메운다.

- `bench/experiments/first-run-modules.mjs`는 `status` 하나를 새 prefix에 설치해 2회만 실행한다. command 목록(`--version`, `--help`, `status`)과 반복 횟수를 받도록 확장하고 median과 범위를 계산한다.
- 이 script의 load hook은 module source를 읽는 시간만 잰다. 평가 시간은 포함하지 않으므로 package별 시간은 구성 파악용으로만 쓰고, 판단은 command wall time으로 한다.
- MCP initialize는 stdio client가 필요하므로 `bench/mcp.mjs`를 재사용한다. 이 script는 workspace의 `apps/cli/dist/main.js`(bundle 아님)를 띄우므로, 설치된 packed `duoctl.js`를 대상으로 지정할 수 있게 한다.
- packed bundle의 entry chunk와 각 chunk의 정적 import 목록을 함께 기록해 위 "기대 효과 상한"의 추론을 확인한다.

다음 값을 JSON으로 저장한다.

- command별 wall time
- 로드한 module 수와 주요 package별 시간·파일 수·byte
- 첫 실행과 같은 설치본의 두 번째 실행
- exit code와 stdout/stderr parse 성공 여부

측정 대상은 다음과 같다.

```sh
duoctl --version
duoctl --help
duoctl status --root <fixture> --json
node bench/mcp.mjs --scenario single-cold --iterations 5 --cli <packed-duoctl.js>
```

`duoctl mcp`는 client 연결이나 stdin 종료를 기다리므로 직접 실행하지 않는다. `bench/mcp.mjs`에 `--cli`를 추가해 설치된 packed entry를 server로 실행하고, harness가 initialize 뒤 transport를 닫게 한다. `--cli`를 주면 fixture 준비 단계의 `index`도 같은 packed entry로 실행해, 측정 대상과 준비 단계의 build가 섞이지 않게 한다.

위 `--iterations 5`는 기준선 기록용이다. 선택 gate에서는 다른 command와 같은 규칙을 따라 paired round마다 build별로 `--iterations 3`을 실행하고 그 중앙값을 round 값으로 쓴다.

각 대상은 같은 fixture에서 반복하고 median과 범위를 기록한다. 새로 설치한 파일의 첫 open 비용과 일반적인 warm 실행은 다음처럼 분리한다.

- cold 관찰: fresh prefix에 설치한 뒤 같은 command의 첫 번째와 두 번째 실행을 기록한다. 설치 직후 17~18초까지 늘어난 외부 startup 비용이 섞일 수 있으므로 후보 선택 gate에는 쓰지 않는다([performance-benchmark](../performance-benchmark.md#설치-직후-첫-실행-release-hardening)).
- warm 선택 gate: A와 B를 각각 설치하고, 측정할 command와 같은 command를 한 번 미측정 실행한다. 그다음 5개 paired round에서 A와 B를 각각 3회 실행해 round별 중앙값을 구한다. 설치 파일 전체 읽기 같은 다른 warm-up은 섞지 않는다.

round 실행 순서는 홀수 round에서 A → B, 짝수 round에서 B → A로 바꿔 시간 경과에 따른 환경 편향을 줄인다. 실험 빌드를 새로 설치할 때마다 같은 절차를 반복한다.

### 2. 후보 실험과 선택 gate

CLI import 후보는 먼저 `apps/cli/src/cli.ts`의 command 정적 import를 command dispatch 시점의 동적 import로 바꾼 실험 빌드로 측정한다. 공용 helper의 정적 import가 같은 module graph를 다시 불러오면 `apps/cli/src/commands/shared.ts`의 analyzer·graph helper만 first-use load로 좁힌다.

`cli.ts`는 command 외에도 다섯 workspace package의 barrel을 정적으로 import한다(`packageInfo`, `GRAPH_SCHEMA_VERSION`, `SUPPORTED_SCHEMA_VERSIONS`, `appendRuntimeMetric`, `AGENT_IDS` 등). 패키지에 `sideEffects` 선언이 없어 command만 옮겨서는 entry chunk가 내부 module graph를 계속 불러올 수 있다. 실험 빌드의 chunk 구조에서 이것이 확인되면 이 barrel import도 실험 대상에 넣는다. `--version --json`은 모든 package 정보를 출력하므로 그 경로에서는 load가 남는 것이 정상이다.

"실제 사용하는 문법만 lazy load" 후보는 기존 관찰이 최대 약 50ms로 아래 절대 하한과 같은 수준이다. JavaScript module load hook은 WASM 읽기와 `Language.load` 평가 시간을 포함하지 않으므로 이 후보의 판단에 쓰지 않는다. 기존 `bench/worker.mjs grammars-all` 또는 `bench/realworld.mjs`의 `grammarLoadMs`처럼 `createDefaultAnalyzerRegistry` 자체를 재는 값이 50ms 하한을 넘지 않으면 실험 빌드 없이 그 값을 근거로 제외한다.

후보는 다음 조건을 모두 만족할 때만 유지한다. 수치 기준은 측정 전에 고정하며, 결과를 본 뒤 바꾸지 않는다.

- 같은 환경에서 A와 B를 번갈아 실행한 5개 paired round 중 4개 이상에서 B가 빠르다.
- 각 paired round의 `A median − B median`을 구하고, 그 차이의 중앙값이 50ms 이상이다.
- 대상 command의 출력, exit code, JSON contract가 같다.
- 비용을 다른 필수 command로 옮긴 경우 그 trade-off가 측정 결과에 드러난다.
- 코드 복잡도와 새 failure path가 효과에 비해 과하지 않다.

gate를 통과하는 후보가 없으면 production code를 변경하지 않고 조사 결과만 기록한다.

### 3. 최소 구현

CLI import 지연이 gate를 통과하면 다음 범위만 변경한다.

- `apps/cli/src/cli.ts`: 선택된 command module을 dispatch 시점에 불러온다. 실험에서 필요하다고 확인된 경우에만 workspace package barrel의 정적 import도 사용하는 경로로 옮긴다.
- `apps/cli/src/commands/shared.ts`: 일부 command만 쓰는 analyzer·graph 구현을 helper 호출 시 불러온다.
- `apps/cli/src/cli.test.ts`: help, version, unknown command, JSON usage 오류 계약을 유지한다.
- `tests/distribution/dist.e2e.test.ts`: entry chunk(`duoctl.js`)에서 정적 import로 도달하는 chunk들이 `@modelcontextprotocol/server`를 불러오지 않는지 확인한다. barrel import까지 옮긴 경우에는 `zod`도 대상에 넣는다. 기존 #8 테스트는 모든 chunk를 통틀어 `zod`와 MCP server의 정적 import가 있음을 기대하므로 그대로 두고, 새 검사는 entry에서 도달하는 범위로 한정한다.
- `bench/experiments/first-run-modules.mjs`, `bench/mcp.mjs`: 재현 명령과 before/after 결과를 남긴다.

`bin.ts`가 모든 runtime dependency를 시작 전에 resolve해 불완전한 설치를 알려 주는 동작은 유지한다. 새 wrapper, config 또는 dependency는 만들지 않는다.

### 4. 검증

변경이 있으면 먼저 다음 focused gate를 실행한다.

```sh
pnpm exec vitest run apps/cli/src/cli.test.ts
pnpm build
pnpm test:dist
git diff --check
```

그다음 전체 회귀를 확인한다.

```sh
pnpm verify
```

before/after는 같은 session에서 5개 paired round를 실행하고, 홀수 round는 A → B, 짝수 round는 B → A 순서로 측정한다. 각 build를 3회 실행한 warm sample의 중앙값으로 round를 비교하고, 단일 `max − min` 값은 후보 선택에 쓰지 않는다. 성능값은 CI gate로 쓰지 않는다. 후보 유지 여부는 2절의 선택 gate로, 기능 회귀는 기존 테스트와 결정적 출력 비교로 판단한다.

PR에서는 Windows·Ubuntu·macOS `verify`를 모두 통과해야 한다. Windows에서만 측정된 개선을 다른 OS의 보장으로 표현하지 않는다.

### 5. 결과 기록과 종료 판단

- `docs/performance-benchmark.md`에 환경, 명령, 반복 수, raw result 위치, median·범위, 판단을 기록한다.
- `docs/conflicts.md`의 C202 상태는 후보 전체가 끝났을 때만 갱신한다. 일부 후보가 남으면 Deferred를 유지하고 해결된 범위만 기록한다.
- 구현했다면 비작성자 승인과 3 OS `verify`를 통과한 PR을 `next`에 병합한다.
- 구현하지 않았다면 후보별 제외 근거와 측정값을 Jira에 기록한다.

## 진행 현황 (2026-11-11)

- 기준: 최신 `origin/next` commit `117de18`, branch `codex/S15P31A106-290-c202`, packed `@duo-director/cli` 0.4.0-rc.2.
- CLI import 후보: command 및 core·integration barrel을 first-use/subpath로 분리했다. warm paired gate에서 `--version` 5/5·중앙 208.2 ms, `--help` 5/5·247.4 ms로 통과했다.
- `status`: 첫 측정 5/5·50.6 ms였지만 재측정 중앙 46.7 ms라 성능 개선으로 주장하지 않는다. 두 실행 모두 악화는 없었다.
- MCP initialize: A/B 각각 1회 예열, 5 paired round, build별 3회에서 B가 5/5 빨랐지만 차이 중앙 36.6 ms라 50 ms gate 미달이다. tool contract는 같고 tool 오류는 0이었다.
- lazy grammar: 전체 중앙 53.5 ms, fixture가 쓰는 TypeScript·TSX·JavaScript 중앙 27.6 ms로 제거 가능분 약 25.9 ms라 제외했다.
- freshness cache 경량화는 correctness 위험으로 기각했다. symlink 검사 축소는 보안 경계 변경이므로 maintainer 결정 전까지 보류했다.
- 로컬 Windows에서 focused CLI test, MCP benchmark smoke, `pnpm test:dist` 23개, `pnpm verify` 1,861개, 문서 검증이 통과했다.
- 남은 종료 조건: 변경 commit, Windows·Ubuntu·macOS CI, 비작성자 승인, `next` 병합, Jira 결과 기록. C202는 symlink 검사 후보의 maintainer 결정이 남아 `Deferred` 상태다.

## 완료 기준

- [x] 최신 `next`의 패키징된 CLI로 기준선과 module load 구성을 측정했다.
- [x] C202 후보마다 구현, 제외 또는 별도 maintainer 결정 필요 상태를 기록했다.
- [x] 구현 후보는 before/after 교차 측정에서 2절의 선택 gate(5개 paired round 중 4개 이상 개선, round별 차이 중앙값 50ms 이상)를 통과했다. (`--version`, `--help`; `status`와 MCP는 개선 주장 제외)
- [x] CLI stdout/stderr, exit code, JSON `/1` contract와 command 결과가 바뀌지 않았다.
- [x] 누락된 runtime dependency가 시작 전에 명확한 설치 오류로 보고된다.
- [ ] 변경이 있으면 focused gate, `pnpm verify`, Windows·Ubuntu·macOS CI가 통과했다. (로컬 Windows focused gate와 `pnpm verify` 통과, 3 OS CI 대기)
- [x] 재현 script 또는 raw 측정값이 저장소나 Jira에 첨부됐다. (`bench/experiments/*-ab.mjs`, raw는 `bench/results/local/`)
- [ ] PR 병합 또는 조사 결과 기록 중 하나로 Jira 수용 기준을 충족했다. (PR·Jira 기록 대기)

## 위험과 대응

| 위험 | 대응 |
|---|---|
| #8 이후 과거 0.9초 추정이 더 이상 유효하지 않음 | 최신 `next`의 패키징된 CLI를 다시 측정한 뒤 구현 여부를 결정한다. |
| command만 동적 import로 바꿔도 `cli.ts`의 barrel import 때문에 entry chunk가 그대로임 | 실험 빌드의 chunk 구조를 먼저 확인하고, 필요하면 barrel import를 실험 범위에 넣는다. |
| dynamic import가 비용을 없애지 않고 첫 command 실행으로 옮김 | command별 cold·warm 시간을 모두 기록하고 trade-off를 숨기지 않는다. |
| 동적 chunk 누락이 설치 후에만 발견됨 | 배포본 E2E에서 모든 command와 불완전한 설치 오류를 확인한다. |
| 성능 편차를 개선으로 오판함 | 같은 session에서 A/B를 순서를 바꿔 가며 paired round로 실행하고, 측정 전에 고정한 선택 gate로만 판단한다. |
| symlink 검사 축소로 보안 경계가 약해짐 | maintainer의 명시적 결정 없이는 해당 후보를 구현하지 않는다. |
| 최적화를 위해 public contract가 바뀜 | 기존 `/1` schema, exit code, Truth와 verdict 의미를 회귀 기준으로 고정한다. |

효과가 확인되지 않으면 코드를 추가하지 않는다. C202의 완료는 모든 후보를 구현하는 것이 아니라, 재현 가능한 근거로 각 후보의 최종 판단을 남기는 것이다.
