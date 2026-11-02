# Issue #107 MCP benchmark timeout verification plan

Status: In Progress. Date: 2026-10-29. Owner: 김가현. Jira: [S15P31A106-268](https://ssafy.atlassian.net/browse/S15P31A106-268).

GitHub [#107](https://github.com/kanghyunsoon/duo/issues/107)은 응답하지 않는 MCP server 또는 tool 때문에 reliability benchmark가 끝나지 않는 문제다. [PR #95](https://github.com/kanghyunsoon/duo/pull/95)가 `87fe174`로 `next`에 병합되면서 단계별 timeout과 회귀 테스트가 들어왔다. `main`에는 아직 반영되지 않았다. 이 작업은 새 기능 개발보다 수용 기준 검증과 종료 판단에 집중한다.

[#126](https://github.com/kanghyunsoon/duo/issues/126)의 수정 PR [#127](https://github.com/kanghyunsoon/duo/pull/127)은 아직 열려 있으며, 브랜치 `origin/fix/126-mcp-benchmark-timeout-flake`의 현재 HEAD는 `dda86cd`다. 이 PR은 test runner 안정화뿐 아니라 timeout 뒤 server process 정리 방식과 exit code도 바꾼다. 따라서 #107의 cleanup과 종료 코드 기준은 PR #127 병합 뒤의 `next`에서 최종 판단한다.

## 목표

- initialization, `tools/list`, 각 tool call이 설정 가능한 시간 안에 종료되는지 확인한다.
- timeout 결과가 정확한 stage와 `kind: "timeout"`을 포함한 JSON으로 남는지 확인한다.
- timeout 뒤 transport와 child process가 정리되고 benchmark가 exit code 1로 종료되는지 확인한다.
- Windows, Ubuntu, macOS 근거를 모아 #107과 Jira에 기록한다.
- 수용 기준을 모두 충족하면 #107 종료를 제안하고 Jira를 Done으로 전환한다.

## 검증 기준 commit

| 대상 | commit | 용도 |
|---|---|---|
| `origin/next` | `a189090` | #95의 `87fe174`를 포함한 현재 `next`, 1차 대조 |
| `origin/fix/126-mcp-benchmark-timeout-flake` | `dda86cd` | spawn 시점 PID 확보, `closeServer`, `HarnessError`, exit code 2, `--scenario` 포함. merge-base `14eef0e` |
| PR #127 merge ref | `a5b376` (base `a51071f`) | 현재 `next`보다 8 commits 뒤이므로 최종 통합 근거로 사용하지 않음 |
| PR #127 병합 후 `origin/next` | 실제 병합 commit | #107 최종 검증과 세 운영체제 근거 |

로컬 `codex/issue-32-mcp-benchmark`(`8c1a90d`)는 #95 병합 전 브랜치이므로 검증 기준으로 쓰지 않는다.

## 현재 구현 기준

아래 위치는 PR #127 브랜치 HEAD `dda86cd` 기준이다. 병합 후에는 실제 `next` 병합 commit으로 기준을 갱신한다.

| 항목 | 현재 위치 | 확인할 내용 |
|---|---|---|
| timeout option | `bench/mcp.mjs` | `--timeout-ms` 기본값 30000, 양의 정수가 아니면 `usage()`로 exit code 2 |
| initialization | `bench/mcp.mjs`의 `open` | `client.connect`에 timeout 적용, 실패 시 spawn 시점 PID로 `closeServer` 정리, stage `initialize` |
| tool 목록 | `bench/mcp.mjs`의 `listTools` | cold/warm 경로 모두 timeout 적용, stage `tools/list` 또는 `warmup` |
| tool 호출 | `bench/mcp.mjs`의 `callTool` | 모든 tool에 timeout 적용, tool 이름을 stage로 기록, timeout 뒤에도 나머지 tool 계속 호출 |
| 오류 분류 | `bench/mcp.mjs`의 `errorEntry`, `HarnessError` | MCP SDK timeout만 `kind: "timeout"`, 나머지는 `client-error`. `HarnessError`는 stage error로 기록하지 않고 exit code 2 |
| PID 확보 | `bench/mcp.mjs`의 `open` | `transport.start`를 감싸 process spawn 직후 PID를 잡는다. handshake 실패 시 SDK가 process를 분리해 `transport.pid`가 `null`이 되기 때문이다. |
| process 정리 | `bench/mcp.mjs`의 `closeServer(session)` | session의 PID 사용. 분리된 process는 즉시 `SIGTERM`, 그 뒤 최대 3초 동안 종료를 확인하고 남으면 `SIGKILL` |
| PID 기록 | `bench/mcp.mjs`의 `recordPid` | client 쪽에서 `DUO_MCP_BENCHMARK_PID_FILE`에 기록. 기록 실패는 server 정리 뒤 `HarnessError` |
| 동시 worker | `bench/mcp.mjs`의 `scenario` | `Promise.allSettled`로 모든 worker가 끝난 뒤 실패 처리 |
| temp 정리 | `bench/mcp.mjs` 끝부분 | `fs.promises.rm` retry로 삭제. JSON은 삭제 성공 뒤에만 stdout에 쓴다. |
| 종료 코드 | `bench/mcp.mjs` | 0: 모든 stage 응답, 1: report에 stage error 있음, 2: 인자 오류, 내부 오류, PID 기록 실패, temp 삭제 실패(stdout JSON 없음) |
| scenario 선택 | `bench/mcp.mjs`의 `--scenario` | 회귀 테스트는 `single-cold` 하나만 실행. 알 수 없는 이름이나 값 없는 `--scenario`는 exit code 2 |
| 회귀 테스트 | `tests/mcp-benchmark-timeout.test.ts` | initialize, `tools/list`, `tools/call` timeout의 JSON, exit code 1, PID 정리. client와 fake server의 PID 이중 기록. 잘못된 `--scenario`와 값 없는 `--scenario`의 exit code 2. initialize, `tools/list` 모드의 PID 파일 기록 실패 시 exit code 2와 server 정리 |
| fake server | `tests/bench/fixtures/unresponsive-mcp.mjs` | 로컬에서 의도한 stage만 무응답, LLM·유료 호출 없음 |

## 작업 범위

1. #107 수용 기준과 PR #127 병합 후 `next`의 구현을 항목별로 대조한다.
2. local fake server 기반 timeout 회귀 테스트를 실행한다.
3. 생성된 JSON에서 stage, kind, exit code를 확인한다.
4. timeout 뒤 기록된 PID가 남지 않는지 확인한다.
5. `ci.yml`의 Windows, Ubuntu, macOS `pnpm test` 결과를 확인하고 근거 링크를 기록한다.
6. 검증 결과를 GitHub #107과 Jira S15P31A106-268에 남긴다.

다음 항목은 범위 밖이다.

- PR #127의 구현과 리뷰. #107은 그 병합 결과를 검증 기준으로만 사용한다.
- MCP startup 성능 개선 또는 새로운 benchmark scenario
- MCP tool schema, Project Truth, Decision 권한, verdict 의미 변경
- LLM 또는 유료 API를 사용하는 검증
- release 또는 publish 결정. `next`에서 `main`으로의 반영 시점도 포함한다.

## 실행 계획

### 0. 선행 조건

- PR #127이 `next`에 병합되었는지 확인한다.
- PR #127의 현재 CI [run 40616557131](https://github.com/kanghyunsoon/duo/actions/runs/40616557131)은 base `14eef0e` 기준이므로 사전 근거로만 사용한다. 최신 `next` 통합의 최종 근거는 PR #127 병합 후 `next` push CI에서 모은다.
- 병합 전이면 실행 시점의 PR #127 브랜치 HEAD를 기록해 로컬 사전 검증만 하고, 최종 근거는 병합 후 다시 모은다.

### 1. 정적 검토

- `open`, `prime`, `measure`의 모든 MCP request에 같은 `timeoutMs`가 전달되는지 확인한다.
- initialization 실패, warmup, 측정 session 종료 경로가 모두 `closeServer`를 거치는지 확인한다.
- initialize timeout처럼 handshake가 실패해도 client가 PID를 기록하고, `closeServer`가 그 PID의 종료를 기다리는지 확인한다.
- `HarnessError`가 `warmup`, `initialize`, `session` stage error로 바뀌어 기록되지 않는지 확인한다.
- timeout과 일반 client error가 구분되며, JSON contract `duo.mcp-benchmark/1`을 바꾸지 않는지 확인한다. `--scenario`를 지정했을 때만 `configuration.scenario`가 추가된다.
- tool call 하나가 timeout되어도 session을 끝내지 않고 나머지 tool을 계속 호출하는 것을 기대 동작으로 정한다. #107의 기대 동작 "completes the remaining report when possible"과 일치하고, 각 tool의 latency와 error가 독립적으로 남아야 benchmark 결과를 해석할 수 있기 때문이다. 정리는 session 종료 시 한 번 한다.

### 2. 대상 테스트

timeout 회귀 테스트는 `tests/mcp-benchmark-timeout.test.ts`이며 기본 `pnpm test`에 포함된다. `pnpm test:mcp-benchmark`는 `tests/bench/mcp-benchmark.test.ts`만 실행하므로 timeout 검증 명령이 아니다.

```sh
pnpm exec vitest run tests/mcp-benchmark-timeout.test.ts
```

각 timeout mode에서 다음을 확인한다.

- stage timeout(500 ms)이 발생하고, process가 외부 제한(15초) 전에 끝난다. `closeServer`가 최대 3초 기다릴 수 있으므로 wall time은 500 ms보다 길 수 있다. `signal`이 `null`이다.
- stdout이 파싱 가능한 JSON이다.
- 예상 stage에 `kind: "timeout"`이 있다.
- exit code가 1이다.
- 모든 server PID가 client와 fake server 양쪽에 기록되고, 기록된 PID가 남지 않는다.

harness 실패도 함께 확인한다.

- 알 수 없는 `--scenario`와 값 없는 `--scenario`는 exit code 2이고 stdout이 비어 있다.
- initialize와 `tools/list` 모드에서 PID 파일을 쓸 수 없으면 exit code 2, stdout이 비어 있고, server process가 남지 않는다.

exit code 2는 harness 실패 신호다. 특히 temp 삭제 실패는 server process가 아직 working directory를 잡고 있다는 뜻일 수 있으므로, timeout 검증 중 exit code 2가 나오면 cleanup 실패 후보로 보고 stderr를 기록한다.

정상 경로가 깨지지 않았는지 보려면 다음을 추가로 실행한다. 이 명령은 timeout 근거가 아니다.

```sh
pnpm test:mcp-benchmark
pnpm benchmark:mcp:smoke
```

테스트가 code 또는 fixture 변경을 요구하면 다음 gate도 실행한다.

```sh
pnpm build
pnpm lint
pnpm test
```

문서만 변경되면 다음만 추가로 확인한다.

```sh
pnpm docs:validate
git diff --check
```

### 3. 운영체제 검증

세 운영체제 근거는 `ci.yml`에서 나온다. 이 workflow는 `main`과 `next`의 push와 pull request에서 Windows, Ubuntu, macOS matrix로 `pnpm test`를 실행한다. `mcp-benchmark.yml`은 `workflow_dispatch` 전용이고 timeout 테스트를 실행하지 않으므로 근거로 쓰지 않는다.

| 환경 | 근거 출처 | 필수 근거 |
|---|---|---|
| Windows | `ci.yml` `pnpm test` job | 세 timeout mode, JSON, exit code 1, PID 정리, temp 삭제 성공(exit code 2 없음) |
| Ubuntu | `ci.yml` `pnpm test` job | 같은 timeout 회귀 테스트 |
| macOS | `ci.yml` `pnpm test` job | 같은 timeout 회귀 테스트 |

Windows에서는 signal 처리 방식이 POSIX와 다르므로, 정확히 어떤 signal 분기가 실행됐다고 추정하지 않고 최종적으로 PID가 남지 않는지 따로 기록한다.

외부 15초 제한을 넘긴 실패는 product timeout 실패와 구분해 기록한다. runner 문제를 숨기기 위해 #107의 per-stage timeout을 늘리거나 cleanup assertion을 제거하지 않는다.

#126의 간헐 실패가 재발하지 않는지 확인하기 위해 PR #127 병합 commit의 `next` push CI와 같은 commit의 전체 job 재실행이 Windows, Ubuntu, macOS에서 연속 통과해야 한다.

### 4. 결과 기록과 종료 판단

- GitHub #107 댓글에 commit, 명령, OS별 최초 CI와 재실행 링크, JSON stage, cleanup 결과를 기록한다.
- Jira S15P31A106-268에 같은 근거와 후속 이슈를 기록한다.
- 모든 수용 기준이 충족되면 #107 종료를 제안한다.
- product 동작의 실제 gap이 있으면 가장 좁은 위치를 수정하고 같은 fake server test로 회귀를 고정한다.
- PR #127이 병합되지 않아 최종 검증을 할 수 없으면 #107을 열어 두고 Jira에 차단 요인으로 연결한다.

## 완료 기준

- [ ] PR #127의 #126 수정이 `next`에 병합되었고, 검증은 그 commit 이후를 기준으로 한다.
- [ ] initialization, `tools/list`, 각 tool call timeout이 설정 가능하고 실제로 bounded다.
- [ ] timeout JSON이 정확한 stage와 `kind: "timeout"`을 포함한다.
- [ ] timeout 뒤 transport와 child process가 세 운영체제에서 정리된다. handshake 실패 경로도 포함한다.
- [ ] stage timeout이 하나라도 있으면 exit code 1, 인자 오류, 내부 오류, PID 기록 실패, temp 삭제 실패는 exit code 2로 구분된다.
- [ ] timeout 검증 중 exit code 2가 cleanup 실패 후보로 기록되고, stage 결과로 숨겨지지 않는다.
- [ ] 회귀 테스트가 local fake server만 사용하고 LLM·유료 호출을 하지 않는다.
- [ ] PR #127 병합 commit의 `ci.yml` 최초 실행과 전체 job 재실행이 Windows, Ubuntu, macOS에서 연속 통과하고, 그 근거가 GitHub #107과 Jira에 기록된다.
- [ ] runner 제한 실패가 #107 product 결과와 분리되어 기록된다.

## 위험과 대응

| 위험 | 대응 |
|---|---|
| PR #127 병합 전 코드로 검증해 cleanup 결과가 우연히 통과함 | 최종 근거는 `closeServer`가 포함된 PR #127 병합 후 `next`에서만 모은다. |
| Windows child process 정리가 늦게 관측됨 | `closeServer`가 최대 3초 동안 PID 종료를 확인한 뒤 `SIGKILL`한다. 고정 대기 확대보다 실제 cleanup 신호를 우선한다. |
| handshake 실패 뒤 SDK가 process를 분리해 PID를 잃음 | spawn 직후 잡은 PID로 정리하고, 회귀 테스트의 PID 이중 기록 검사로 고정한다. |
| Windows(Node 24)에서 방금 종료된 server가 cwd를 잡아 `fs.rmSync`가 EPERM으로 즉시 실패함 | `fs.promises.rm` retry로 삭제하고, 그래도 실패하면 exit code 2로 드러낸다. Windows 근거에 temp 삭제 결과를 포함한다. |
| MCP SDK timeout 오류 형태가 버전에 따라 달라짐 | `SdkErrorCode.RequestTimeout` 분류와 실제 JSON을 함께 확인한다. |
| test가 외부 제한을 초과함 | 회귀 테스트는 `--scenario single-cold`로 server 하나만 띄운다. 그래도 초과하면 runner 문제로 분리하고 #107 assertion은 유지한다. |
| CI 한 번만 통과해 flake를 놓침 | PR #127 병합 commit에서 최초 실행과 전체 job 재실행을 모두 통과시키고, 실패 이력도 함께 기록한다. |

새 schema, dependency, abstraction은 추가하지 않는다. 검증에서 실제 gap이 확인되지 않으면 production code를 변경하지 않는다.
