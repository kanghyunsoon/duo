# 07. CLI Interface

상태: Frozen (T00 final, 2026-09-27) · 구현: T15 (2026-09-28, H-34) · 관련: REQ-CLI-001, REQ-DECISION-002, REQ-NFR-006

CLI(`apps/cli`)는 얇은 orchestration 계층이다. 인자 파싱, 질문, 출력 renderer, 종료 코드만 담당하고 모든 동작은 core, analyzer, graph, director 서비스를 호출한다. CLI는 파일·프로세스 I/O를 직접 하지 않는다(`node:fs`, `node:child_process` import 금지, [ADR-010](adr/ADR-010-package-structure.md) lint). Requirement, Decision YAML, Index DB, Graph Edge, Proposal 상태를 직접 고치지 않는다.

## 공통 옵션

`--root <path>`(기본 현재 디렉터리), `--json`, `--locale en|ko`(또는 `DUO_LOCALE`, 기본 en, 추측하지 않음), `--non-interactive`, `--verbose`, `--no-color`, `--version`, `--help`

## 명령

| 명령 | 설명 | 주요 옵션 | 서비스 | 쓰기 |
|---|---|---|---|---|
| `duoctl init` | 기존 저장소 adoption: plan → Truth → Index → Baseline | `--yes`, `--non-interactive`, `--answers -`, `--baseline-policy head\|abort`, `--repair` | director InitService, graph Indexer, director Adoption | Truth, generated, reviews/adoption-* |
| `duoctl status` | 초기화 여부, Truth 개수, index freshness(변경 파일, 분석 stale, module resolution, call 재계산 후보, full rebuild 이유), adoption baseline, pending decision, LLM 상태 | | core loader, graph inspectIndex, director baseline status, core listDecisionProposals | 없음 |
| `duoctl index` | Indexer 실행 | `--full`(저장된 state를 쓰지 않는 clean rebuild) | graph indexRepository | generated, cache |
| `duoctl context <task>` | Context Packet(기본 Markdown, `--json`은 ContextResult) | `--budget <n>`, `--refresh` | director compileContext | 없음(`--refresh`만 index) |
| `duoctl review` | 변경 검수 | `--staged`, `--from <ref>`, `--to <ref>`, `--files a,b`, `--task`, `--budget`, `--record`, `--refresh`, `--fail-on block\|ask\|warn`, `--strict` | director reviewChanges, recordReview | 없음(`--record`만 reviews/) |
| `duoctl trace <node>` | 추적 관계 | `--depth <1-3>` | graph trace | 없음 |
| `duoctl impact <node>` | Graph에 기록된 영향 | `--depth <1-3>` | graph impact | 없음 |
| `duoctl decision list\|confirm <id>\|reject <id>` | proposal 목록, 확정, 거절 | `--reason <text>`(reject) | core DecisionService, listDecisionProposals | decisions/ |
| `duoctl stats` | runtime/metrics.jsonl 요약 | `--last <n>` | director readRuntimeMetrics | 없음 |
| `duoctl ui`, `install`, `mcp` | TASK-018, 017, 016 | | | 아직 구현하지 않음(종료 코드 1) |

- `<node>`는 node ID(`sym:src/a.ts#A.b`), 정의 ID(`AUTH-03`), RepoPath, 유일한 qualified Symbol 이름을 받는다.
- `review` 기본 diff는 HEAD → WORKTREE, `--staged`는 HEAD → INDEX다. `--from`/`--to`는 `HEAD`, `INDEX`, `WORKTREE` 또는 commit·branch 이름이며 해석은 Git provider가 한다. CLI는 diff parser를 갖지 않는다.
- `--run-tests`와 `--no-llm`(T00 초안)은 구현하지 않았다: 테스트 실행은 CLI가 프로세스를 띄워야 하고, LLM Provider(TASK-012B)가 아직 없어 기본이 LLM 0회다(C134).
- `init --reindex`(T00 초안)는 두지 않는다. Index는 `duoctl index`, clean rebuild는 `duoctl index --full`이다(C133).

## 출력과 JSON

- 기본 출력은 사람이 읽는 짧은 text이며 renderer가 locale(en, ko)별 문구로 만든다. Knowledge Gap 질문은 director renderer, Review claim은 rule·subject·reason 코드로 보인다.
- `--json`은 stdout에 envelope 하나를 출력한다: `{ format: "duo.cli.<command>/1", command, ok, exitCode, result, diagnostics }`. `result`는 domain 결과 그대로다(status: 조합 객체, context: `ContextResult`, review: `{ review: ReviewResult, performance, record? }`, index: `{ mode, fullRebuildReason, metrics, graphRevision }`, init: `{ steps, plan, apply?, index?, baseline? }`). Agent는 문장을 parsing하지 않는다.
- 질문과 확인 prompt는 stderr로 나가므로 `--json` stdout은 항상 JSON이다.
- MCP structuredContent(TASK-016)는 같은 domain 결과를 쓴다(AC-015-03은 T16에서 대조, C135).

## 종료 코드

Operational failure와 Review verdict를 섞지 않는다. Verdict는 `--fail-on`(또는 `--strict` = `--fail-on warn`)을 줄 때만 종료 코드가 된다.

| 코드 | 의미 |
|---|---|
| 0 | 성공. review는 verdict와 상관없이 0 |
| 1 | 실행 오류, 잘못된 사용, 터미널이 필요한 명령을 비대화형으로 실행 |
| 2 | review WARN 이상이고 `--fail-on warn` |
| 3 | review ASK 이상이고 `--fail-on ask\|warn` |
| 4 | review BLOCK이고 `--fail-on block\|ask\|warn` |
| 5 | .duo-project 없음(NOT_INITIALIZED) |
| 6 | 조치 필요: index-required(context, review), adoption policy 필요, ABORT_AND_CLEAN, partial의 repair |

## Existing Project Adoption

DUO는 처음부터 DUO로 만든 프로젝트만이 아니라 이미 개발 중인 Git 저장소에도 중간 설치된다. 두 경우 모두 같은 Runtime 구조로 수렴한다.

```text
Existing Repository → Install DUO → Observe Repository → Bootstrap Minimal Truth → Initial Index
  → Capture Adoption Baseline → Normal DUO workflow (Incremental Index + Context + Review)
```

- Truth는 sparse여도 정상이다: Requirement·Decision·Constraint 0개, Milestone 없음이 init 실패가 아니다(Code Graph는 풍부, Intent Graph는 희소). Human Truth는 사용하면서 쌓이고, 부족한 intent는 Knowledge Gap과 Review가 필요한 때 surface/ask한다. 가짜 Requirement·Decision·Milestone을 만들지 않는다.
- Adoption Baseline은 "DUO 도입 전부터 있던 상태 vs 도입 뒤 변화"를 가르는 provenance다. 기존 코드가 옳다거나 기술 부채를 승인한다는 뜻이 아니다([03 Adoption Baseline](03-data-model.md#adoption-baseline-t141)).

## duoctl init

```text
$ duoctl init
Repository ok · orbit-tasks · typescript · 36 files · branch develop
Working tree has existing changes: staged 0 · unstaged 1 · untracked 1
Import candidates found: 3 (not imported; review them yourself)
Truth      ok · 4 files
Index      ok · full (no-state) · 40 files
Adoption baseline: [1] use HEAD as the baseline (current changes stay changes to review)  [2] abort and clean the repository first
> 1
Baseline   ok · 2f3355d5f46b · dirty at adoption (HEAD_BASELINE) · 0 pre-existing findings
DUO is set up. Next: duoctl status · duoctl context <task> · duoctl review
```

- 단계 Repository(`planInit`), Truth(`applyInitPlan`), Index(`indexRepository`), Baseline(`captureAdoptionBaseline`)를 각각 보고한다. 한 단계가 실패하면 init은 성공이 아니며, 다시 실행하면 첫 미완료 단계부터 잇는다(기존 Truth는 `INIT_ALREADY_INITIALIZED`로 건드리지 않음, index가 current면 건너뜀, baseline이 있으면 건너뜀).
- 질문(InitService의 `InitQuestion`)은 TTY에서만 묻는다: 프로젝트 Goal(README 첫 문단 또는 package.json description 제안, 받아들이면 README provenance), 현재 Milestone 또는 MVP 범위(제목, ID는 plan이 배정), Critical Constraint(';'로 구분, confirmed·warn). 관찰로 알 수 있는 것은 묻지 않는다. 답하지 않은 질문은 vision.md의 `UNKNOWN(<id>)` 줄이 되고 JSON `result.plan.questions`로 ASK 목록이 된다(AC-014-04).
- 비대화형(`--non-interactive` 또는 TTY 없음)의 Human 답은 `--answers -`로 stdin JSON(`InitAnswer[]` 또는 `{ "answers": [...] }`)을 준다.
- **`--yes`는 Human Intent를 만들어내는 옵션이 아니다.** 파일 생성 확인, partial repair 같은 operational 확인만 승인한다. README 제안 vision, 추론한 milestone, 제안 constraint, import 후보를 확정하지 않고, dirty adoption policy도 고르지 않는다.
- Dirty working tree(staged, unstaged, untracked, conflicted; .duo-project와 secret 파일 제외)는 init 실패가 아니다. baseline에는 정책이 필요하다: `--baseline-policy head`(HEAD_BASELINE: baseline commit = HEAD, 현재 변경은 adoption 이후 Review 대상으로 남음) 또는 `abort`(ABORT_AND_CLEAN: baseline을 만들지 않고 종료 코드 6, 정리 후 다시 실행). TTY면 둘 중 하나를 묻고, 비대화형에서 정책이 없으면 Truth와 Index까지 하고 종료 코드 6이다. dirty working tree 전체를 snapshot으로 삼는 정책은 MVP에 없다.
- Import 후보는 개수만 보이고 가져오지 않는다(Human 확인 import 흐름은 후속).
- baseline 기록자 이름은 Git `user.name`이다(없으면 "human").

## duoctl status

```text
$ duoctl status
Project orbit-tasks · goal confirmed · milestone -
Truth: 0 requirements · 0 decisions · 0 constraints · 2 declared gaps
Index: stale
Changed since index: 1 files · analysis stale 1 · module resolution 5 · calls may be recomputed 5
Adoption baseline: current · 2f3355d5f46b · 0 findings
Pending decisions: 0
LLM: disabled
```

쓰기 0이다. Graph는 read-only로 연다(`openProjectGraphReader`: graph.db가 없으면 아무것도 만들지 않고 빈 in-memory graph로 missing을 보고). SQLite는 WAL 데이터베이스의 read-only 연결에 `graph.db-wal`/`graph.db-shm` sidecar를 만들 수 있으며 이는 regenerable 영역의 SQLite 관리 파일이고 graph.db 내용은 바뀌지 않는다(C131). baseline status는 missing, current, advanced, repository-diverged, incompatible이다.

## duoctl index, context, review

- `index`는 결과 mode와 full rebuild 이유를 보인다: `incremental`, `full because no-state`, `full because requested`(`--full`) 등.
- `context`와 `review`는 index가 current가 아니면 자동으로 index하지 않고 `INDEX_REQUIRED`(종료 코드 6)를 보인다. `--refresh`를 줄 때만 index → compile/review를 명시적으로 이어서 한다. Review 도메인 계약(읽기 전용)은 그대로다.
- `review` 출력은 verdict 줄, ALIGNED가 아닌 claim(규칙, subject, reason, blocking·provenance·drift 표시, Evidence pointer 최대 3개), ALIGNED 개수(`--verbose`면 목록), Knowledge Gap, limitation, baseline이 없을 때의 안내, PASS의 의미("현재 Evidence 범위에서 프로젝트 방향 위반을 찾지 못함, 버그 없음이 아님")다. Adoption Baseline이 있으면 `introduced`, `pre-existing`, `pre-existing-touched`를 표시해 기존 기술 부채와 새 위반을 구분한다.
- `review --record`만 `recordReview()`(Human 명시 행동)로 `reviews/review-*.json`을 쓴다. 기본 review는 기록하지 않는다.

```text
$ duoctl review
WARN  2 claims · 3 files · llm_calls 0
  CONFLICT  decision-forbids           D-004 · forbidden-symbol [pre-existing-touched]
            evidence: .duo-project/decisions/D-004.yaml:1-19, src/auth/legacy-session-store.ts:5-7
  UNKNOWN   unlinked-addition          src/net/rate-limiter.ts · added-file-unlinked [drift]
            evidence: src/net/rate-limiter.ts, src/net/rate-limiter.ts:1-6
Limitations:
  calls-exact-only
```

## duoctl trace, impact

Graph primitive를 그대로 보인다. depth(1-3)와 node 한도로 bounded이고 `truncated`를 표시한다. impact는 "DUO Graph에 기록된 영향이며 영향받는 모든 코드가 아님"을 함께 출력한다. index가 current가 아니면 그 사실을 먼저 알린다.

## duoctl decision

- `list`는 core `listDecisionProposals()` read model의 pending proposal과 proposed Decision을 보인다(commit됐거나 rejected인 proposal은 pending이 아님). 파일을 직접 scan하지 않는다.
- `confirm`·`reject`는 TTY가 아니거나 `--non-interactive`면 거부하고(`CLI_TTY_REQUIRED`, 종료 코드 1, AC-015-04), 내용을 보여 준 뒤 ID를 다시 입력받는다. Agent의 무인 실행을 막는 장치이며 보안 인증이 아니다([10-security.md](10-security.md)). actor는 `{ kind: "human", name: <Git user.name> }`이고 검사, ID 할당, lock, supersede, stale 판단은 core `DecisionService`가 한다([ADR-013](adr/ADR-013-decision-lifecycle.md)).

```text
$ duoctl decision confirm P-007
P-007  "Refresh token rotation"
  question  refresh_token_policy
  answer    rotate_on_use
  governs   AUTH-03
Type the ID to confirm: P-007
confirmed as D-005 · .duo-project/decisions/D-005.yaml
```

## runtime/metrics.jsonl

`init`, `index`, `context`, `review`, `decision`은 명령이 끝난 뒤 `.duo-project/runtime/metrics.jsonl`에 한 줄(`duo.metric/1`)을 덧붙인다: command, status, exitCode, durationMs, at, 그리고 해당하는 것만 indexMode, fullRebuildReason, contextStatus, contextTokens, contextBudget, reviewVerdict, reviewClaims, llmCalls. secret, 소스·diff 본문, task 원문은 기록하지 않는다. `status`, `trace`, `impact`, `stats`는 쓰기 0이라 기록하지 않는다. writer는 stdout renderer와 분리되어 있고, 쓰기 실패는 경고(`METRICS_WRITE_FAILED`)로 보이며 명령 결과를 바꾸지 않는다. write boundary 위반은 조용히 넘기지 않고 오류로 보인다. 초기화되지 않은 저장소에는 쓰지 않는다. 이 파일은 Git이 무시하는 로컬 관찰이며 Review Record가 아니다(C83).

```text
$ duoctl stats --last 20
context  20 requests · avg loaded 4,310 · estimator o200k_base
review   6 runs · PASS 2 · WARN 3 · BLOCK 1 · ASK 0
llm      calls 0
```
