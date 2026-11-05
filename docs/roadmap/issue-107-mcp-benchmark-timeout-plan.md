# Issue #107 MCP benchmark timeout verification plan

Status: PR CI Passed, Merge Pending. Date: 2026-10-29. Last verified: 2026-11-02. Owner: 김가현. Jira: [S15P31A106-268](https://ssafy.atlassian.net/browse/S15P31A106-268).

GitHub [#107](https://github.com/kanghyunsoon/duo/issues/107)은 응답하지 않는 MCP server 또는 tool 때문에 reliability benchmark가 끝나지 않는 문제다. [PR #95](https://github.com/kanghyunsoon/duo/pull/95)가 `87fe174`로 `next`에 병합되면서 단계별 timeout과 회귀 테스트가 들어왔다. `main`에는 아직 반영되지 않았다. 이 작업은 새 기능을 추가하지 않고, 최종 검증에서 드러난 실패를 고친 뒤 수용 기준을 다시 검증한다.

[#126](https://github.com/kanghyunsoon/duo/issues/126)의 수정 PR [#127](https://github.com/kanghyunsoon/duo/pull/127)은 `5fc9882`로 `next`에 병합되었다. 이 PR은 test runner 안정화뿐 아니라 timeout 뒤 server process 정리 방식과 exit code도 바꿨다. 2026-11-02 최신 `next`에서 최종 검증한 결과 cleanup과 bounded timeout은 동작했지만, timeout test의 stage 선점 flake와 MCP benchmark schema contract 불일치가 확인되어 #107 종료를 보류한다.

## 목표

- initialization, `tools/list`, 각 tool call이 설정 가능한 시간 안에 종료되는지 확인한다.
- timeout 결과가 정확한 stage와 `kind: "timeout"`을 포함한 JSON으로 남는지 확인한다.
- timeout 뒤 transport와 child process가 정리되고 benchmark가 exit code 1로 종료되는지 확인한다.
- Windows, Ubuntu, macOS 근거를 모아 #107과 Jira에 기록한다.
- 수용 기준을 모두 충족하면 #107 종료를 제안하고 Jira를 Done으로 전환한다.

## 2026-11-02 최종 검증 결과

검증은 GitHub #107의 수용 조건과 최신 원격 `origin/next` `bb7167a`를 기준으로 별도 detached worktree에서 실행했다. 로컬 `codex/issue-32-mcp-benchmark`의 사용자 변경은 건드리지 않았다.

| 확인 항목 | 결과 | 근거 |
|---|---|---|
| PR #127 병합 | 통과 | `5fc9882`가 `origin/next`의 ancestor |
| PR #127 병합 CI | 통과 1회 | [run 40984243566](https://github.com/kanghyunsoon/duo/actions/runs/40984243566), Windows·Ubuntu·macOS 성공. 동일 commit 전체 재실행은 없음 |
| 최신 `next` CI | 통과 1회 | [run 41365095310](https://github.com/kanghyunsoon/duo/actions/runs/41365095310), Windows·Ubuntu·macOS 성공 |
| timeout 회귀 테스트 | 실패 | `pnpm exec vitest run tests/mcp-benchmark-timeout.test.ts` 4회 중 2회 통과. `tools/list`와 `tools/call` case가 의도한 stage 전에 `initialize` 500 ms timeout으로 실패 |
| timeout 실패 형식 | 부분 통과 | 실패 run도 외부 15초 제한 전에 exit 1, `signal: null`, 파싱 가능한 `kind: "timeout"` JSON을 생성. 다만 stage가 기대와 다름 |
| 정상 MCP benchmark test | 실패 | `pnpm test:mcp-benchmark`가 `duo_propose_decision.forbids nested schema differs`로 실패 |
| 정상 MCP smoke | 실패 | `node bench/mcp.mjs --smoke`의 4개 scenario가 모두 같은 `session / process-error`를 기록하고 exit 1 |

종료 판단은 **보류**다. timeout 구현이 무한 대기를 막는 것은 확인했지만, 정확한 stage 회귀가 불안정하고 정상 benchmark 경로가 현재 `next`에서 실패한다.

같은 `bb7167a`에서 다음을 추가로 확인했다.

- `bench/mcp-contract.mjs`에 `importer_paths`만 메모리에서 추가하면 smoke는 exit 0이고 네 scenario 모두 `errorCount: 0`이다. 다른 contract 불일치는 없다.
- 이미 test를 실행한 worktree에서는 timeout test의 실패가 재현되지 않았다. 순차 6회와 4개 병렬 2회, 총 14회 실행에서 7개 case가 모두 통과했다.
- 같은 조건의 SDK import는 idle 상태에서 117–201 ms, 8개 병렬에서 166–231 ms로 500 ms에 못 미쳤다.

원인은 이후 새 worktree 첫 실행 비교로 확인했다. 결과는 `2026-11-02 로컬 구현 결과`에 있다. 4회 중 2회 실패했던 원래 run의 실행 조건은 기록되어 있지 않다.

## 수정 작업 계획

작업 브랜치는 `origin/next` `bb7167a`에서 만든 `codex/issue-107-final-verification-fix`를 사용하고, PR 생성 전 최신 `origin/next` `a6d1e84`로 재기준화한다. 기존 `codex/issue-32-mcp-benchmark`와 이미 병합된 문서 브랜치는 사용하지 않는다. 최종 근거는 수정 PR 병합 commit의 `next` push CI와 동일 commit 전체 재실행에서 모은다.

### 1. MCP benchmark contract 동기화

- `bench/mcp-contract.mjs`의 `duo_propose_decision.forbids` 예상 schema에 `importer_paths: "array"`를 추가한다.
- 실제 MCP schema에는 `ea1a77f`에서 `forbids.importer_paths`가 추가됐지만 benchmark mirror가 갱신되지 않은 것이 현재 smoke 실패의 직접 원인이다.
- 실제 tool schema나 Decision 의미는 바꾸지 않는다. benchmark의 기대값만 현재 contract와 맞춘다.
- 같은 누락이 required CI에서 지나가지 않도록 실제 schema와 benchmark mirror를 비교하는 빠른 contract test를 `tests/mcp/mcp.e2e.test.ts`에 추가한다. 이 파일은 이미 `listTools` 결과를 검사하고 기본 `pnpm test`에 포함된다. `tests/bench/**`는 기본 test에서 제외되므로 그 아래에 두지 않는다.
- `bench/mcp.mjs`는 import하면 benchmark가 실행되므로 `verifyTools`를 `bench/mcp-contract.mjs`로 옮겨 export하고, `bench/mcp.mjs`와 contract test가 같은 함수를 쓴다. 비교 대상 tool 이름은 `expectedSchemas`의 key를 기준으로 한다.

### 2. timeout stage 선점 flake 대응

`tests/bench/fixtures/unresponsive-mcp.mjs`는 `tools/list`와 `tools/call` mode에서 MCP SDK를 dynamic import한 뒤 initialize에 응답한다. 새 worktree 첫 실행에서는 이 지연이 500 ms를 넘어 target stage 전에 `initialize` timeout이 난다. 이 원인은 수정 전후 비교로 확인했다.

수정 전 commit에서 먼저 실패를 재현한다. 방금 만든 worktree의 첫 실행처럼 원래 실패 run과 비슷한 조건으로 반복하고, 실행 조건과 stage별 결과를 기록한다. 재현되지 않으면 그 사실을 기록하고, 수정 후 통과를 flake 해결의 증거로 쓰지 않는다.

fixture는 Node 표준 입출력만 사용하는 최소 JSON-RPC test server로 바꾼다. SDK import를 없애는 비용이 작고, 가설이 틀려도 test server가 단순해진다. `packages/integration/src/mcp/probe.test.ts`의 server가 선례다. 새 fixture는 다음을 지킨다.

- mode별 동작
  - `initialize`: initialize 요청에 응답하지 않는다.
  - `tools/list`: initialize에는 즉시 응답하고 `tools/list`에 응답하지 않는다.
  - `tools/call`: initialize와 `tools/list`에는 즉시 응답하고 `duo_get_context` 호출에만 응답하지 않는다. 나머지 tool은 `content`와 `structuredContent: { format: "fake" }`로 응답한다.
- 공통 동작
  - 줄 단위 JSON-RPC로 통신하고, initialize 응답에는 요청의 `protocolVersion`을 그대로 돌려준다. `id`가 없는 notification은 무시한다.
  - 입력 전에 PID를 `DUO_MCP_BENCHMARK_SERVER_PID_FILE || DUO_MCP_BENCHMARK_PID_FILE`에 기록한다.
  - 모든 mode에서 stdin 종료를 무시하고 `setInterval`로 살아 있는다. 스스로 종료하면 cleanup assertion이 harness의 정리를 검증하지 못한다.
- `tools/list` 응답 schema는 지금처럼 `bench/mcp-contract.mjs`에서 생성해 production contract와 별도 복사본이 생기지 않게 한다.
- `tools/call` test에 `duo_get_context` 외 tool의 latency가 report에 남는지 확인하는 assertion을 추가해 timeout 뒤 나머지 tool을 계속 호출하는 동작을 고정한다.
- product의 500 ms test timeout, 15초 outer limit, cleanup assertion, exit code assertion은 완화하지 않는다.

### 3. 로컬 검증

코드를 바꾸기 전에 다음을 정적으로 확인한다.

- `open`, `prime`, `measure`의 모든 MCP request에 같은 `timeoutMs`가 전달된다.
- initialization 실패, warmup, 측정 session 종료 경로가 모두 `closeServer`를 거친다.
- handshake가 실패해도 client가 PID를 기록하고, `closeServer`가 그 PID의 종료를 기다린다.
- `HarnessError`가 `warmup`, `initialize`, `session` stage error로 바뀌어 기록되지 않는다.
- timeout과 일반 client error가 구분되고 JSON contract `duo.mcp-benchmark/1`이 바뀌지 않는다. `--scenario`를 지정했을 때만 `configuration.scenario`가 추가된다.
- tool call 하나가 timeout되어도 session을 끝내지 않고 나머지 tool을 계속 호출한다. #107의 기대 동작 "completes the remaining report when possible"과 일치하고, 각 tool의 latency와 error가 독립적으로 남아야 benchmark 결과를 해석할 수 있기 때문이다. 정리는 session 종료 시 한 번 한다.

수정 뒤에는 다음 명령을 실행한다.

```sh
pnpm exec vitest run tests/mcp-benchmark-timeout.test.ts
pnpm test:mcp-benchmark
pnpm benchmark:mcp:smoke
pnpm verify
git diff --check
```

`pnpm test:mcp-benchmark`는 `tests/bench/mcp-benchmark.test.ts`만 실행하므로 정상 경로 근거이고, timeout 근거는 기본 `pnpm test`에 포함된 `tests/mcp-benchmark-timeout.test.ts`다.

- Windows에서 timeout test를 10회 연속 실행해 세 mode가 매번 의도한 stage를 기록하는지 확인한다. 이 결과는 2단계 재현과 비교할 때만 개선 근거가 된다.
- 각 timeout run은 exit 1, `signal: null`, 파싱 가능한 JSON, 정확한 `{ stage, kind: "timeout" }`, client와 server의 PID 이중 기록, 생존 PID 없음이어야 한다. process는 외부 제한 15초 전에 끝나야 한다. `closeServer`가 최대 3초 기다릴 수 있으므로 wall time은 500 ms보다 길 수 있다.
- 인자 오류, 값 없는 `--scenario`, initialize와 `tools/list` 모드의 PID 기록 실패 case는 exit 2, 빈 stdout, 생존 PID 없음이어야 한다.
- 정상 smoke의 네 scenario는 모두 `errorCount: 0`이고 tool contract 검증을 통과해야 한다.

exit code 2는 harness 실패 신호다. temp 삭제 실패는 server process가 working directory를 잡고 있다는 뜻일 수 있으므로, timeout 검증 중 exit code 2가 나오면 cleanup 실패 후보로 보고 stderr를 기록한다.

### 4. PR과 운영체제 검증

- 수정 PR의 base는 `next`, head는 `codex/issue-107-final-verification-fix`로 한다.
- PR CI에서 Windows, Ubuntu, macOS `pnpm test`가 모두 통과해야 한다. `ci.yml`의 이 job이 세 timeout mode, JSON, exit code 1, PID 정리, temp 삭제 성공과 contract test의 3 OS 근거다.
- 병합 commit의 `next` push CI 최초 실행과 전체 job 재실행이 같은 commit에서 3 OS 모두 연속 통과해야 한다.
- `mcp-benchmark.yml`은 근거로 쓰지 않는다. 이 workflow는 `workflow_dispatch` 전용인데 기본 브랜치 `main`에 없어 수동 실행할 수 없고, #107의 수용 기준도 아니다. `main` 반영은 이 작업의 범위 밖이다. 따라서 네 scenario 실행 근거는 로컬 Windows 결과뿐이고, Ubuntu와 macOS에서는 contract test만 정상 경로를 확인한다.

Windows에서는 signal 처리 방식이 POSIX와 다르므로 어떤 signal 분기가 실행됐는지 추정하지 않고, 최종적으로 PID가 남지 않는지 기록한다. 외부 15초 제한을 넘긴 실패는 product timeout 실패와 구분해 기록한다. runner 문제를 숨기기 위해 per-stage timeout을 늘리거나 cleanup assertion을 제거하지 않는다.

### 5. 기록과 종료

- GitHub #107 댓글에 수정 commit, 재현 시도와 로컬 반복 결과, 두 CI run, OS별 job 링크, JSON stage와 cleanup 결과를 기록한다. flake 원인을 확인하지 못했다면 그 사실도 함께 기록한다.
- Jira S15P31A106-268에 같은 근거와 후속 이슈를 기록한다.
- product 동작의 실제 gap이 나오면 가장 좁은 위치를 수정하고 같은 fake server test로 회귀를 고정한다.
- 모든 완료 기준을 충족한 뒤에만 #107을 Close하고 Jira를 Done으로 전환한다.

## 2026-11-02 로컬 구현 결과

- `bench/mcp-contract.mjs`에 `forbids.importer_paths`를 반영하고 `verifyTools`를 공용 contract 검사로 옮겼다.
- `bench/mcp.mjs`와 기본 `tests/mcp/mcp.e2e.test.ts`가 같은 `verifyTools`를 사용한다.
- `tests/bench/fixtures/unresponsive-mcp.mjs`를 SDK cold import가 없는 최소 JSON-RPC server로 바꿨다.
- `tests/mcp-benchmark-timeout.test.ts`가 `tools/call` timeout 뒤 나머지 tool 호출의 latency도 남는지 확인한다.

| 검증 | 결과 |
|---|---|
| timeout test 단일 실행 | 7/7 통과 |
| timeout test Windows 반복 | 10/10 run, 70/70 case 통과 |
| timeout test Windows 병렬 | 4개 병렬 × 2회, 8/8 run, 56/56 case 통과 |
| 실제 MCP `tools/list` contract test | 통과 |
| `pnpm test:mcp-benchmark` | 통과 |
| `pnpm benchmark:mcp:smoke` | 네 scenario 모두 `errorCount: 0`, exit 0 |
| `pnpm typecheck` | 통과 |
| `pnpm verify` 첫 실행 | **미통과**. boundaries, lint, typecheck, build는 통과했다. 기본 test는 157 files 중 156 files 통과했고, `tests/ui/ui.browser.e2e.test.ts` live-update case 1건이 node 표시 30초 timeout으로 실패했다. test 실패로 chain이 멈춰 `docs:validate`는 `verify` 안에서 실행되지 않았다 |
| 실패한 UI case 단독 재실행 | 통과 |
| `verify` 단계별 재실행 | boundaries, lint, typecheck, build, docs 통과. 기본 test 157/157 files, 1596 passed, 7 skipped, 9 todo. 한 번의 `pnpm verify` chain이 아니라 단계별로 실행했다. UI 실패는 재현되지 않았고 원인은 확인하지 못했다 |

### 새 worktree 첫 실행 비교

수정 전 `a6d1e84`와 수정 후 `d43ecda`를 번갈아 새 worktree로 만들고 `pnpm install --frozen-lockfile` 직후 timeout test를 한 번씩 실행했다. Windows 로컬 결과다.

| 대상 | 결과 |
|---|---|
| 수정 전, 새 worktree 첫 실행 | 4회 중 4회 실패. 모두 `tools/list` case가 `initialize` timeout으로 실패 |
| 수정 전, 같은 worktree 2–6회차 | 5회 모두 7/7 통과 |
| 수정 후, 새 worktree 첫 실행 | 3회 모두 7/7 통과 |
| 수정 전 fixture의 SDK import, 새 worktree 첫 실행 | 2351 ms, 2593 ms |

원인은 새 worktree에서 처음 읽는 SDK import가 2초 넘게 걸려 500 ms stage timeout을 먼저 소진하는 것이다. 첫 case가 파일을 읽고 나면 다음 case는 빨라지므로 `tools/list`만 실패한다. 이미 실행한 worktree에서 재현되지 않던 이유도 같다. fixture 교체로 이 원인이 제거됐다. 새 worktree의 import가 느린 이유 자체는 조사하지 않았다.

### PR CI

[PR #156](https://github.com/kanghyunsoon/duo/pull/156)의 [run 41391611033](https://github.com/kanghyunsoon/duo/actions/runs/41391611033)은 `d43ecda` 기준 attempt 1에서 Windows, Ubuntu, macOS 전체 job이 성공했다. 세 job 모두 `pnpm test`, benchmark smoke, 문서 검증, built CLI smoke, distribution E2E, release conformance를 통과했다. 이 결과는 PR 근거이고, 최종 근거는 병합 commit CI에서 모은다.

남은 작업은 다음과 같다. 세 운영체제 근거가 모이기 전에는 #107과 Jira를 종료하지 않는다.

- PR 병합 뒤 병합 commit CI 최초 실행과 전체 재실행의 3 OS 결과를 모은다.
- 근거를 GitHub #107과 Jira에 기록한다.

## 검증 기준 commit

| 대상 | commit | 용도 |
|---|---|---|
| `origin/next` 1차 snapshot | `a189090` | 2026-10-29 기준. #95의 `87fe174`를 포함한 병합 전 대조 |
| PR #127 head | `dda86cd` | spawn 시점 PID 확보, `closeServer`, `HarnessError`, exit code 2, `--scenario` 포함 |
| PR #127 merge | `5fc9882` | #126 수정이 포함된 `next` 기준. [CI run 40984243566](https://github.com/kanghyunsoon/duo/actions/runs/40984243566) 3 OS 성공 |
| `origin/next` 최종 검증 snapshot | `bb7167a` | 2026-11-02 기준. [CI run 41365095310](https://github.com/kanghyunsoon/duo/actions/runs/41365095310) 3 OS 성공, 로컬 종료 검증 기준 |
| 수정 PR base | `a6d1e84` | 2026-11-02 PR 생성 전 최신 `origin/next` |

로컬 `codex/issue-32-mcp-benchmark`(`8c1a90d`)는 #95 병합 전 브랜치이므로 검증 기준으로 쓰지 않는다.

## 현재 구현 기준

아래 위치는 PR #127 merge `5fc9882`를 포함한 `origin/next` `bb7167a` 기준이다.

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
| temp 정리 | `bench/mcp.mjs` 끝부분 | `fs.promises.rm` retry로 삭제. #126 cleanup 수정 이후에는 측정이 끝났으면 삭제가 실패해도 JSON을 stdout에 쓰고, 남은 경로와 오류를 stderr에 쓴다. |
| 종료 코드 | `bench/mcp.mjs` | 0: 모든 stage 응답, 1: report에 stage error 있음, 2: 인자 오류, 내부 오류, PID 기록 실패, temp 삭제 실패. 2가 1보다 우선한다. report 완성 전 실패는 stdout이 비고, temp 삭제만 실패하면 stdout에 JSON이 있다 |
| scenario 선택 | `bench/mcp.mjs`의 `--scenario` | 회귀 테스트는 `single-cold` 하나만 실행. 알 수 없는 이름이나 값 없는 `--scenario`는 exit code 2 |
| 회귀 테스트 | `tests/mcp-benchmark-timeout.test.ts` | initialize, `tools/list`, `tools/call` timeout의 JSON, exit code 1, PID 정리. client와 fake server의 PID 이중 기록. 잘못된 `--scenario`와 값 없는 `--scenario`의 exit code 2. initialize, `tools/list` 모드의 PID 파일 기록 실패 시 exit code 2와 server 정리. temp 삭제 실패 주입 시 JSON 보존과 exit code 2, 주입 없는 정상 응답의 exit code 0 (#126) |
| fake server | `tests/bench/fixtures/unresponsive-mcp.mjs` | 로컬에서 의도한 stage만 무응답, LLM·유료 호출 없음 |

## 작업 범위

1. `bench/mcp-contract.mjs`를 현재 MCP tool schema와 동기화하고 `verifyTools`를 이 파일로 옮긴다.
2. 실제 schema와 contract를 비교하는 test를 `tests/mcp/mcp.e2e.test.ts`에 추가한다.
3. timeout 실패 재현을 시도하고, local fake server를 SDK 없는 최소 JSON-RPC server로 바꾼다.
4. 생성된 JSON에서 stage, kind, exit code를 확인한다.
5. timeout 뒤 기록된 PID가 남지 않는지 확인한다.
6. 로컬 정상 MCP benchmark와 `ci.yml`의 Windows, Ubuntu, macOS 결과를 확인하고 근거 링크를 기록한다.
7. 검증 결과를 GitHub #107과 Jira S15P31A106-268에 남긴다.

다음 항목은 범위 밖이다.

- PR #127의 추가 변경. 병합된 cleanup과 exit contract는 유지한다.
- MCP startup 성능 개선 또는 새로운 benchmark scenario
- 실제 MCP tool schema, Project Truth, Decision 권한, verdict 의미 변경
- LLM 또는 유료 API를 사용하는 검증
- release 또는 publish 결정. `next`에서 `main`으로의 반영 시점도 포함한다.

## 완료 기준

- [x] PR #127의 #126 수정이 `next`에 병합되었고, 검증은 그 commit 이후를 기준으로 한다.
- [x] initialization, `tools/list`, 각 tool call timeout이 설정 가능하고 실제로 bounded다.
- [x] 로컬 timeout JSON이 정확한 stage와 `kind: "timeout"`을 포함한다.
- [ ] timeout 뒤 transport와 child process가 세 운영체제에서 정리된다. handshake 실패 경로도 포함한다.
- [x] 로컬에서 stage timeout은 exit code 1, 인자 오류, 내부 오류, PID 기록 실패, temp 삭제 실패는 exit code 2로 구분된다.
- [x] 로컬 timeout 검증에서 exit code 2가 stage 결과로 숨겨지지 않는다.
- [x] 회귀 테스트가 local fake server만 사용하고 LLM·유료 호출을 하지 않는다.
- [x] `pnpm test:mcp-benchmark`와 `pnpm benchmark:mcp:smoke`가 로컬 Windows에서 정상 MCP schema contract로 통과한다.
- [ ] 실제 MCP schema와 `bench/mcp-contract.mjs`를 비교하는 test가 기본 `pnpm test`에서 3 OS 모두 통과한다.
- [x] timeout test의 수정 후 Windows 10회 연속 통과 결과를 문서에 기록했다.
- [x] 수정 전 코드의 새 worktree 첫 실행 재현과 수정 후 비교 결과를 문서에 기록했다.
- [ ] 재현과 수정 후 비교 결과가 GitHub #107과 Jira에 남는다.
- [ ] 수정 PR 병합 commit의 `ci.yml` 최초 실행과 전체 job 재실행이 Windows, Ubuntu, macOS에서 연속 통과하고, 그 근거가 GitHub #107과 Jira에 기록된다.
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
| CI 한 번만 통과해 flake를 놓침 | 수정 PR 병합 commit에서 최초 실행과 전체 job 재실행을 모두 통과시키고, 실패 이력도 함께 기록한다. |
| fixture 교체 뒤에도 다른 원인으로 stage flake가 남음 | 새 worktree 첫 실행 비교로 SDK import 원인은 확인했다. CI 최초 실행과 재실행에서 다시 실패하면 #107을 열어 두고 실패 조건을 조사한다. product timeout은 늘리지 않는다. |
| 최소 fake server가 stdin 종료로 스스로 끝나 cleanup 검증이 약해짐 | 모든 mode에서 stdin 종료를 무시하고 살아 있게 해 harness의 정리로만 끝나게 한다. |
| MCP tool schema가 바뀌고 benchmark mirror가 갱신되지 않음 | 실제 schema와 `bench/mcp-contract.mjs`를 기본 test에서 비교해 required CI가 drift를 차단한다. |

새 product schema나 dependency는 추가하지 않는다. 변경은 benchmark contract mirror와 `verifyTools` 이동, test fixture, 해당 회귀 test와 문서에 한정한다.
