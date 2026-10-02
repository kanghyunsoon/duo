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
| `duoctl doctor` | 설정 전체 진단(T26.1): runtime, Git(저장소, 최상위, 첫 commit, 작업 트리), Project Truth, adoption baseline, index freshness, 분석 수준, Agent 연결(설정, launcher, MCP launch, tool 목록), 선택 LLM. 다음 행동 1~3개 | | integration `projectDoctor`(openGitProvider, loadProjectTruth, inspectStateDirectory, getAdoptionBaselineStatus, inspectIndex, inspectAgentIntegration, verifyAgentIntegration, LLMProviderPool) | 없음 |
| `duoctl index` | Indexer 실행 | `--full`(저장된 state를 쓰지 않는 clean rebuild) | graph indexRepository | generated, cache |
| `duoctl context <task>` | Context Packet(기본 Markdown, `--json`은 ContextResult) | `--budget <n>`, `--refresh` | director compileContext | 없음(`--refresh`만 index) |
| `duoctl review` | 변경 검수 | `--staged`, `--from <ref>`, `--to <ref>`, `--files a,b`, `--task`, `--budget`, `--record`, `--refresh`, `--fail-on block\|ask\|warn`, `--strict`, `--semantic` | director reviewChanges, recordReview, integration LLM factory(`--semantic`만) | 없음(`--record`만 reviews/) |
| `duoctl trace <node>` | 추적 관계 | `--depth <1-3>` | graph trace | 없음 |
| `duoctl impact <node>` | Graph에 기록된 영향 | `--depth <1-3>` | graph impact | 없음 |
| `duoctl decision list\|confirm <id>\|reject <id>` | proposal 목록, 확정, 거절 | `--reason <text>`(reject) | core DecisionService, listDecisionProposals | decisions/ |
| `duoctl stats` | runtime/metrics.jsonl 요약 | `--last <n>` | director readRuntimeMetrics | 없음 |
| `duoctl mcp` | duo-director MCP 서버를 stdio로 실행(한 저장소, [06](06-mcp-interface.md)) | `--root <path>` 또는 `--root-from git-cwd\|env:<NAME>`(결과는 Git top level이어야 함), `--agent <label>` | integration `resolveMcpRoot`, `serveDuoMcp` | Tool이 쓰는 것만(metrics, proposals) |
| `duoctl install <codex\|claude-code>` | Agent 연결: plan → 확인 → apply → verify([06 Agent integration](06-mcp-interface.md#agent-integration-duoctl-install)) | `--launcher path\|npx`, `--yes`, `--non-interactive`, `--json` | integration `planAgentIntegration`, `applyAgentIntegration`, `verifyAgentIntegration` | `.codex/config.toml`+`AGENTS.md` 또는 `.mcp.json`+`CLAUDE.md`, 백업(runtime/backup) |
| `duoctl install status [agent]` | Agent별 not-configured / configured / drifted / conflict | | integration `inspectAgentIntegration` | 없음 |
| `duoctl install remove <agent>` | DUO MCP 항목과 DUO bridge 블록만 제거 | `--yes` | integration `planAgentRemoval`, `applyAgentIntegration` | 같은 파일들 |
| `duoctl ui [--port N] [--open]` | TASK-018 | | | 127.0.0.1에서 번들 UI와 versioned API 실행, 실제 URL 출력. `--open`은 선택 사항 |

- `<node>`는 node ID(`sym:src/a.ts#A.b`), 정의 ID(`AUTH-03`), RepoPath, 유일한 qualified Symbol 이름을 받는다.
- `review` 기본 diff는 HEAD → WORKTREE, `--staged`는 HEAD → INDEX다. `--from`/`--to`는 `HEAD`, `INDEX`, `WORKTREE` 또는 commit·branch 이름이며 해석은 Git provider가 한다. CLI는 diff parser를 갖지 않는다.
- `--run-tests`와 `--no-llm`(T00 초안)은 구현하지 않았다: 테스트 실행은 CLI가 프로세스를 띄워야 하고(C134), LLM은 기본이 꺼져 있어 `--no-llm`이 필요 없다. 반대로 `duoctl review --semantic`(T12B)이 선택적 의미 보조를 명시적으로 켠다. `duoctl review`는 계속 결정적 판정만 한다.
- `init --reindex`(T00 초안)는 두지 않는다. Index는 `duoctl index`, clean rebuild는 `duoctl index --full`이다(C133).

## 출력과 JSON

- 기본 출력은 사람이 읽는 짧은 text이며 renderer가 locale(en, ko)별 문구로 만든다. Knowledge Gap 질문은 director renderer, Review claim은 rule·subject·reason 코드로 보인다.
- `--json`은 stdout에 envelope 하나를 출력한다: `{ format: "duo.cli.<command>/1", command, ok, exitCode, result, meta?, diagnostics }`. `result`는 integration shared operation의 semantic payload다(TASK-016, C135): status `duo.status/1`, doctor `duo.doctor/1`, context `duo.context/1` `{ status, context: ContextResult(performance 제외), gaps }`, review `ReviewResult`(`duo.review/1`), trace `duo.trace/1`, impact `duo.impact/1`. `meta`는 surface metadata(`performance`, review `--record`의 `record`)이며 비교 대상이 아니다. index는 `{ mode, fullRebuildReason, metrics, graphRevision }`, init은 `{ steps, plan, apply?, index?, baseline? }`. Agent는 문장을 parsing하지 않는다.
- 질문과 확인 prompt는 stderr로 나가므로 `--json` stdout은 항상 JSON이다.
- MCP structuredContent는 같은 shared operation의 payload다. `status|context|review|trace|impact --json`의 `result`와 해당 Tool의 structuredContent가 deep-equal임을 e2e로 확인한다(AC-015-03, C135 해결). T15의 review `result.review`·`result.record`는 `result`·`meta.record`로, context `result.packet`은 `result.context.packet`으로 옮겼다. 종료 코드는 그대로다.

## 종료 코드

Operational failure와 Review verdict를 섞지 않는다. Verdict는 `--fail-on`(또는 `--strict` = `--fail-on warn`)을 줄 때만 종료 코드가 된다.

| 코드 | 의미 |
|---|---|
| 0 | 성공. review는 verdict와 상관없이 0. doctor는 error check가 없을 때(warning, 연결하지 않은 Agent, 꺼진 LLM이 있어도 0) |
| 1 | 실행 오류, 잘못된 사용, 터미널이 필요한 명령을 비대화형으로 실행 |
| 2 | review WARN 이상이고 `--fail-on warn` |
| 3 | review ASK 이상이고 `--fail-on ask\|warn` |
| 4 | review BLOCK이고 `--fail-on block\|ask\|warn` |
| 5 | .duo-project 없음(NOT_INITIALIZED) |
| 6 | 조치 필요: index-required(context, review), adoption policy 필요, ABORT_AND_CLEAN, partial의 repair, install의 conflict·launcher 없음·확인 필요(비대화형에서 `--yes` 없음), doctor의 error check(초기화 전 포함: doctor는 5를 쓰지 않는다) |

install은 init 전이면 5(`AGENT_NOT_INITIALIZED`), verify 실패면 1이다.

## Agent 연결 (install)

```text
Existing project → duoctl 설치(PATH) → duoctl init → duoctl install codex|claude-code
```

- plan을 먼저 보인다(willCreate, willModify, conflicts, trust·approval 안내). TTY면 확인을 묻고, 비대화형은 `--yes`가 있어야 적용한다(없으면 종료 코드 6, `status: "confirmation-required"`, 쓰기 0).
- `--yes`는 계획한 파일 변경만 승인한다. 같은 이름의 다른 MCP 서버, 읽을 수 없는 설정, 깨진 bridge marker, launcher 가로채기 파일, Codex trust, Claude Code approval은 넘어가지 않는다.
- apply 뒤 verify가 생성된 설정의 command로 DUO 서버를 직접 띄워 확인한다. index가 stale이면 install은 성공하고 다음 조치로 `duoctl index`를 보인다.
- 두 번 실행하면 `unchanged`. install은 init, index, git add, commit을 하지 않는다. 바뀐 파일을 알려줄 뿐이다.
- metrics: `{ command: "install", status, agent }`(경로와 설정 내용 없음).

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
DUO is set up: Truth, index and adoption baseline are ready. Next:
  1. Connect a coding agent (either one): duoctl install codex · duoctl install claude-code
  2. Check the whole setup: duoctl doctor
  Optional: duoctl ui opens a local console to look around
```

- 단계 Repository(`planInit`), Truth(`applyInitPlan`), Index(`indexRepository`), Baseline(`captureAdoptionBaseline`)를 각각 보고한다. 한 단계가 실패하면 init은 성공이 아니며, 다시 실행하면 첫 미완료 단계부터 잇는다(기존 Truth는 `INIT_ALREADY_INITIALIZED`로 건드리지 않음, index가 current면 건너뜀, baseline이 있으면 건너뜀).
- 성공한 init의 다음 단계(T26.1)는 Agent 연결(두 Agent를 같은 줄에, 기본 추천 없음)과 `duoctl doctor`다. init이 이미 index와 baseline을 만들었으므로 `duoctl index`를 다시 안내하지 않는다. UI는 선택으로 표시한다. 사람이 읽는 문구이며 `--json` 결과는 그대로다.
- 질문(InitService의 `InitQuestion`)은 TTY에서만 묻는다: 프로젝트 Goal(README 첫 문단 또는 package.json description 제안, 받아들이면 README provenance), 현재 Milestone 또는 MVP 범위(제목, ID는 plan이 배정), Critical Constraint(';'로 구분, confirmed·warn). 관찰로 알 수 있는 것은 묻지 않는다. 답하지 않은 질문은 vision.md의 `UNKNOWN(<id>)` 줄이 되고 JSON `result.plan.questions`로 ASK 목록이 된다(AC-014-04).
- 비대화형(`--non-interactive` 또는 TTY 없음)의 Human 답은 `--answers -`로 stdin JSON(`InitAnswer[]` 또는 `{ "answers": [...] }`)을 준다.
- **`--yes`는 Human Intent를 만들어내는 옵션이 아니다.** 파일 생성 확인, partial repair 같은 operational 확인만 승인한다. README 제안 vision, 추론한 milestone, 제안 constraint, import 후보를 확정하지 않고, dirty adoption policy도 고르지 않는다.
- Dirty working tree(staged, unstaged, untracked, conflicted; .duo-project와 secret 파일 제외)는 init 실패가 아니다. baseline에는 정책이 필요하다: `--baseline-policy head`(HEAD_BASELINE: baseline commit = HEAD, finding은 HEAD tree로 계산, 현재 변경은 adoption 이후 Review 대상으로 남음) 또는 `abort`(ABORT_AND_CLEAN: 종료 코드 6, 정리 후 다시 실행). **정책은 어떤 persistent write보다 먼저 정한다**(T15.1): baseline이 없는 dirty 저장소에서 정책이 없거나 `abort`면 `.duo-project`, graph.db, index-state.json, baseline, metrics를 하나도 만들지 않고 종료 코드 6(`ADOPTION_DIRTY_POLICY_REQUIRED` 또는 `aborted`, steps의 truth·index는 `skipped`)이다. TTY면 둘 중 하나를 stderr로 묻는다. 이미 초기화되어 baseline만 없는 project도 같은 순서다. dirty working tree 전체를 snapshot으로 삼는 정책은 MVP에 없다.
- init이 만든 Truth 파일은 commit 전까지 HEAD→WORKTREE diff에 보이지만, baseline의 `bootstrapTruth`와 내용이 같으면 Review가 `adoption-bootstrap`으로 분류하고 WARN·BLOCK·ASK를 만들지 않는다. Human이 고친 Truth는 일반 Truth 변경이다(C138, [03](03-data-model.md#adoption-baseline-t141)).
- Import 후보는 개수만 보이고 가져오지 않는다(Human 확인 import 흐름은 후속).
- baseline 기록자 이름은 Git `user.name`이다(없으면 "human").

## duoctl status

```text
$ duoctl status
Project orbit-tasks · goal confirmed · milestone -
Truth: 0 requirements · 0 decisions · 0 constraints · 2 declared gaps
Index: stale
Changed since index: 1 files · analysis stale 1 · module resolution 5 · calls may be recomputed 5
Analysis: typescript L2 (34) · file-only L0 (6: .json, .md)
Adoption baseline: current · 2f3355d5f46b · 0 findings
Pending decisions: 0
LLM: disabled
```

`LLM` 줄은 disabled, configured, unavailable과 provider·model, unavailable이면 이유(예: `LLM: unavailable · openai-responses gpt-… · OPENAI_API_KEY is not set`)를 보인다. `openai-compatible`은 transport와 endpoint의 origin(`scheme://host[:port]`, path 없음)을 더한다(예: `LLM: configured · openai-compatible m-1 · chat-completions · https://gateway.example`, T27.1, 사람 출력만). 설정과 환경만 보고 네트워크를 쓰지 않는다. key 값은 보이지 않는다.

쓰기 0이다. Graph는 read-only로 연다(`openProjectGraphReader`: graph.db가 없으면 아무것도 만들지 않고 빈 in-memory graph로 missing을 보고). SQLite는 WAL 데이터베이스의 read-only 연결에 `graph.db-wal`/`graph.db-shm` sidecar를 만들 수 있으며 이는 regenerable 영역의 SQLite 관리 파일이고 graph.db 내용은 바뀌지 않는다(C131). baseline status는 missing, current, advanced, repository-diverged, incompatible이다.

`Analysis` 줄과 JSON `result.analysis`(T18.0, `duo.status/1`에 더한 필드, MCP `duo_get_status`와 같음)는 분석 coverage 사실이다: `analyzerRegistryDigest`, `files` {total, structural, fileOnly}, 언어별 {language, files, analyzer, level, symbols, tests, imports, calls, typeResolution}, `fileOnly` {level: "L0", files, extensions}. 점수가 아니다. level과 capability의 뜻은 [language-support.md](language-support.md). `duoctl impact`와 `duo_impact`는 관련 파일 언어의 limitation을 `limitations`로 더한다.

## duoctl doctor

T26.1(Milestone D). 처음 설치했거나 무언가 안 될 때 여러 명령과 문서를 오가지 않고 현재 상태와 다음 행동을 한 번에 본다. 읽기 전용이다: init, index, install, commit, 설정 수정, cache 삭제, LLM 호출, network, package update를 하지 않고 metric도 쓰지 않는다.

```text
$ duoctl doctor
DUO Doctor · ready

Runtime
  ok       duoctl 0.1.2 · Node.js v24.18.0 (supported: >=24.15.0)

Git
  ok       Git repository: /work/poly
  ok       Initial commit present · branch main
  info     Working tree clean

Project Truth
  ok       poly · 0 requirements · 0 decisions · 0 constraints
  ok       Adoption baseline 88a0145ad766

Index
  ok       Index current

Analysis
  info     cpp L1 (2) · csharp L1 (1) · java L1 (1) · python L1 (2) · typescript L2 (2) · other files L0 (5: .json, .md, .toml, .xml)
           L0 every file: Git history, diff and Truth references · L1 symbols and structure · L2 resolved imports and calls (docs/language-support.md)

Coding agents (optional, either one)
  ok       Codex: connected, the MCP server starts (duoctl · 9 tools)
           Codex loads .codex/config.toml only in a project you trust (DUO does not change trust).
  info     Claude Code: not connected
           → Run duoctl install claude-code

LLM (optional)
  info     Disabled (llm.provider: none). DUO works fully without an LLM.

Next
  Nothing to do.
```

- Check(순서 = 의존 순서): `runtime.node`, `git.repository`, `git.initial_commit`, `git.working_tree`, `truth.project`, `truth.baseline`, `index.freshness`, `analysis.coverage`, `agent.codex`, `agent.claude_code`, `llm.configuration`. 선행 check가 정상이 아니면 뒤 check는 `skipped`(`requires`)이고 사람 출력에서는 한 줄로 모인다. 예: Git 저장소가 아니면 Truth·index·Agent는 확인하지 않는다.
- 상태: `ok`, `info`(사실이나 꺼 둔 선택 기능, 문제 아님), `warning`(동작하지만 볼 것이 있음), `error`(조치 전에는 핵심 경로가 동작하지 않음), `skipped`. Review verdict(PASS/WARN/BLOCK/ASK)와 다른 어휘다. 전체: `ready`(error·warning 없음), `warnings`, `action-required`(error 하나 이상). 점수는 없다.
- 종료 코드: error check가 없으면 0, 있으면 6(`ACTION_REQUIRED`), doctor 자체의 예기치 않은 실패는 1. 연결하지 않은 Agent, `llm.provider: none`, stale index(warning)는 0이다.
- Index: stale은 warning(context·review가 `index-required`를 반환), missing·incompatible은 error. 셋 다 다음 행동은 `duoctl index`. index 검사(`inspectIndex`)는 한 번이고 분석 수준은 그 결과의 coverage다(index가 missing이어도 보인다).
- 작업 트리 변경은 오류가 아니다. adoption 전이면 init이 `--baseline-policy head|abort`를 묻는다고, adoption 뒤면 review가 HEAD와 비교한다고 설명한다. 첫 commit이 없으면 commit 다음에 init을 안내한다.
- Agent: 연결하지 않은 Agent는 `info`이고, 둘 다 연결하지 않았으면 다음 행동 하나에 두 명령을 함께 보인다(기본 추천 없음). 연결된 Agent는 install verify와 같은 방식으로 설정 parse, 계획한 항목, bridge 블록, launcher를 확인하고 설정의 command로 MCP 서버를 띄워 initialize → tools/list까지 확인한 뒤 닫는다(`duo_get_status`는 부르지 않음). 기대 tool은 이 build의 `MCP_TOOLS` 이름 목록이다. drifted는 warning(`duoctl install <agent>`, npx launcher면 `--launcher npx`), conflict·launcher 없음·launch 실패·tool 불일치는 error다. Codex trust와 Claude Code 승인은 DUO가 확인할 수 없으므로 안내만 한다.
- LLM: `none`은 정상(info)이고 key 안내를 하지 않는다. provider를 설정했을 때만 설정과 credential 환경 변수의 존재를 본다(`configured` 또는 warning: `credential-missing`, `model-missing`, `base-url-unsupported`, `base-url-env`, `custom-headers-env`). 값, 환경 변수 목록, provider 호출은 없다. LLM 행동은 다음 행동 목록에 넣지 않는다.
- 다음 행동: error·warning check의 행동을 check 순서(Git → Truth → baseline → index → Agent)로 모으고, init이 있으면 index를 뺀다(init이 index한다). 최대 3개.
- Secret: facts와 params의 모든 문자열(Agent 설정 파일의 parse 오류, MCP 서버 stderr 마지막 두 줄 포함)은 Context와 같은 `redactSecrets`를 거친다.
- `--json`: `duo.cli.doctor/1` envelope의 `result`가 `duo.doctor/1` `{ format, overall, checks: [{ id, group, status, reason, requires?, facts, actions: [{ id, commands, params? }] }], next }`다. check ID·reason·action ID는 locale과 무관한 계약이고 사람 문구는 계약이 아니다. MCP tool은 없다.
- Ambiguous context: `duoctl context`가 `ambiguous`이면 사람 출력에 후보를 실제로 구분하는 handle만 안내한다(T26.2, MCP `duo_get_context` summary와 같은 `ambiguityRemediation`): 다른 파일의 후보는 저장소 상대 경로(`/` 포함, 앞에 `./` 없이), 같은 파일의 후보는 qualified name, keyword가 같은 Requirement는 ID, 구분할 handle이 없으면 어느 대상인지 정하라는 안내. 경로나 이름이 있으면 Requirement·Decision ID도 정확한 시작점이라고 덧붙인다. resolver·ranking·JSON은 그대로다(T26.1의 고정 문구를 대체).

## duoctl index, context, review

- `index`는 결과 mode와 full rebuild 이유를 보인다: `incremental`, `full because no-state`, `full because requested`(`--full`) 등.
- `context`와 `review`는 index가 current가 아니면 자동으로 index하지 않고 `INDEX_REQUIRED`(종료 코드 6)를 보인다. `--refresh`를 줄 때만 index → compile/review를 명시적으로 이어서 한다. Review 도메인 계약(읽기 전용)은 그대로다.
- `review` 출력은 verdict 줄, ALIGNED가 아닌 claim(규칙, subject, reason, blocking·provenance·drift 표시, Evidence pointer 최대 3개), ALIGNED 개수(`--verbose`면 목록), Knowledge Gap, limitation, baseline이 없을 때의 안내, PASS의 의미("현재 Evidence 범위에서 프로젝트 방향 위반을 찾지 못함, 버그 없음이 아님")다. Adoption Baseline이 있으면 `introduced`, `pre-existing`, `pre-existing-touched`를 표시해 기존 기술 부채와 새 위반을 구분한다.
- `review --record`만 `recordReview()`(Human 명시 행동)로 `reviews/review-*.json`을 쓴다. 기본 review는 기록하지 않는다. 의미 보조가 성공한 review는 같은 결정적 record(같은 ID)에 별도 supplement `review-<id>.assist-<id>.json`을 더한다: claim ID, alignment, Evidence ID, provider(id, model, cache identity)뿐이고 LLM 문장, 소스, prompt는 없다.
- **`--semantic`(T12B)**: `project.yaml`의 `llm.provider: openai-responses`와 `llm.model`, 환경의 API key(`llm.api_key_env`, 기본 `OPENAI_API_KEY`)가 있을 때만 의미 후보 claim을 한 번의 structured 요청으로 확인한다. 선택한 Evidence 발췌(Truth slice, 바뀐 코드 slice, diff hunk)가 OpenAI API로 전송되며 `store: false`로 보낸다. `llm.provider: openai-compatible`(T27.1)이면 같은 발췌가 project.yaml의 `base_url`로, 설정한 `transport`와 `structured_output` 하나로 전송된다(Responses transport는 `store: false`, fallback 없음). 결과는 사람 출력의 별도 절("Semantic assistance …")과 JSON `result.semanticAssist`에 있고 결정적 claim과 verdict는 그대로다. 같은 요청은 로컬 cache(`.duo-project/cache/llm/`, `llm.cache: false`로 끔)로 다시 호출하지 않는다. Provider가 disabled, unavailable, 실패여도 review는 결정적 결과로 끝나고 종료 코드도 결정적 verdict를 따른다.

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

`init`, `index`, `context`, `review`, `decision`은 명령이 끝난 뒤 `.duo-project/runtime/metrics.jsonl`에 한 줄(`duo.metric/1`)을 덧붙인다: command, status, exitCode, durationMs, at, 그리고 해당하는 것만 indexMode, fullRebuildReason, contextStatus, contextTokens, contextBudget, reviewVerdict, reviewClaims, llmCalls, llmCacheHits, 그리고 `--semantic`이면 semanticStatus, llmProvider, llmModel, Provider가 보고한 llmInputTokens·llmOutputTokens·llmCachedInputTokens(달러 비용은 계산·기록하지 않음). secret, 소스·diff 본문, task 원문은 기록하지 않는다. `status`, `trace`, `impact`, `stats`는 쓰기 0이라 기록하지 않는다. writer는 stdout renderer와 분리되어 있고, 쓰기 실패는 경고(`METRICS_WRITE_FAILED`)로 보이며 명령 결과를 바꾸지 않는다. write boundary 위반은 조용히 넘기지 않고 오류로 보인다. 초기화되지 않은 저장소에는 쓰지 않는다. 이 파일은 Git이 무시하는 로컬 관찰이며 Review Record가 아니다(C83).

```text
$ duoctl stats --last 20
context  20 requests · avg loaded 4,310 · estimator o200k_base
review   6 runs · PASS 2 · WARN 3 · BLOCK 1 · ASK 0
llm      calls 0
```

## 배포 (T17.1)

DUO 실행 파일 설치, 저장소 초기화, Agent 연결은 서로 다른 단계다.

```text
1. duoctl 실행 파일 설치      npm install -g @duo-director/cli   (source에서는 pnpm pack:cli로 만든 tarball)
2. 저장소에 DUO 초기화        duoctl init
3. Coding Agent 연결          duoctl install codex | claude-code
```

- **공개 package**: `@duo-director/cli` 하나, bin `duoctl`. 내부 package(`@duo-director/core`, analyzer, graph, director, integration)는 esbuild로 bundle되어 사용자가 따로 설치하지 않는다(C158). 외부 runtime 의존성은 exact version: `@modelcontextprotocol/client`·`server` 2.1.0, `gpt-tokenizer` 4.0.0, `mdast-util-from-markdown` 2.0.3, `mdast-util-frontmatter` 2.0.1, `micromark-extension-frontmatter` 2.0.0, `openai` 7.23.0(T12B, bundle하지 않고 `--semantic`의 첫 호출에서만 불러옴, C193), `smol-toml` 1.9.0, `typescript` 6.0.3, `web-tree-sitter` 0.27.0, `yaml` 2.9.1, `zod` 4.6.5.
- **포함**: `dist/duoctl.js`(Node 확인 후 CLI를 부르는 실행 파일, shebang), `dist/cli-*.js`(bundle), `dist/grammars/` WASM 일곱 개(typescript, tsx, javascript, java, c_sharp, cpp, python)와 grammar package별 MIT license, `grammars.json`(package, version, repository, license, sha256, bytes, ABI; grammar npm package는 native install script 때문에 의존성이 아님, C159, T18.0), README, package.json. grammar 목록은 analyzer의 `GRAMMAR_FILES` 하나에서 온다. `files` allowlist이며 테스트가 금지 경로(`.env`, credentials, key, `.worklog`, fixtures, `.duo-project`, metrics, coverage, source map)를 검사한다.
- **요구 사항**: Node.js `>=24.15.0`(package.json `engines`, 실행 파일이 먼저 확인). native build, install script, postinstall, 실행 중 network 없음. pnpm은 개발에만 쓴다.
- **version**: `apps/cli/package.json` 하나(현재 0.1.2). `duoctl --version`은 같은 값, `--version --json`은 graph·project schema version과 Node version도 보인다.
- **launcher**: global 설치면 Agent 설정은 `duoctl`. project에 `npm install -D`로 설치했으면 `--launcher npx`가 `npx --no-install duoctl`을 기록하며, `node_modules/.bin/duoctl`이 없으면 installer가 unavailable로 막는다(download하지 않음, C162). `duoctl install`의 verify는 `launcher: {kind, resolved, localBin, version}`을 보인다.
- **실패 메시지**: Node가 낮음(요구 범위와 현재 version), 설치가 불완전함(빠진 모듈, 재설치 안내), grammar 자산 없음·로드 실패(`ANALYZER_INIT_FAILED`, 자산 이름), launcher 없음(`AGENT_LAUNCHER_UNAVAILABLE`), project schema 불일치(`UNSUPPORTED_SCHEMA_VERSION`, migration 없음). monorepo build를 안내하지 않는다.
- **만들기와 검증**: `pnpm build` 뒤 `pnpm pack:cli`가 `.dist/cli-package/`와 `.dist/duo-director-cli-<version>.tgz`, `.dist/pack.json`을 만든다. `pnpm test:dist`는 그 tarball을 임시 npm prefix(global)와 임시 project(`npm install -D`)에 설치하고, 저장소와 workspace가 보이지 않는 환경에서 init → index → status → context → review → install codex·claude-code → 생성된 설정으로 MCP 서버 실행, clone 이동, 실패 메시지를 확인한다. 3 OS CI에서 실행한다.

| 크기(0.1.0) | T17.1 | T18.0 |
|---|---|---|
| tarball | 500,057 B | 1,247,988 B |
| unpacked | 3,930,557 B(WASM 약 3.27 MB, bundle 약 652 KB) | 13,676,280 B(WASM 12,929,293 B, bundle 약 734 KB, 19 files) |
| global 설치 | package 70개, 약 83.8 MB(대부분 `typescript`, `gpt-tokenizer`) | package 70개, 약 93.6 MB; T12B: 71개, 약 113.5 MB(`openai` 7.23.0 약 20 MB, tarball 1,250,899 B) |
