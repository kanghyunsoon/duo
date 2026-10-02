# DUO 0.1.0 제품 계약 (TASK-020)

0.1.0이 공개적으로 약속하는 동작과 그 검증 위치다. **RC**는 `pnpm test:conformance`가 packed tarball을 격리된 npm prefix에 설치한 뒤 설치된 `duoctl`로 실행하는 검증이다. **WS**는 workspace build나 내부 API로만 할 수 있는 검증이다. 설치된 bundle은 같은 source를 bundle한 것이다. 형식의 호환성 규칙은 [compatibility.md](compatibility.md)에 있다.

| # | 계약 | 핵심 약속 | 검증 |
|---|---|---|---|
| 1 | Existing-project adoption | 기존 Git 저장소에서 `duoctl init`: 관찰 → 최소 질문 → 최소 Truth → 첫 index → Adoption Baseline. 처음부터 DUO로 만든 프로젝트일 필요가 없다 | RC: `tests/cli/existing-project`, `tests/distribution`, C209 반복(`scripts/release/init-repro.mjs`) |
| 2 | Sparse Truth | Requirement·Decision·Constraint가 0개여도 index, status, context, review, trace, impact, UI가 정상이다 | RC: existing-project(init), `tests/conformance` sparse Truth |
| 3 | Dirty-worktree policy | 작업 중 변경이 있으면 정책 없이는 영구 쓰기 0. `--baseline-policy head`는 HEAD 기준으로 채택하고 dirty 변경은 다음 Review에 보인다. `--yes`는 정책을 대신하지 않는다 | RC: existing-project dirty 절. WS: `tests/cli/cli.tty`(대화형 질문) |
| 4 | Adoption provenance | HEAD에 있던 위반은 pre-existing, 그것을 고치면 pre-existing-touched(WARN), 새 위반은 introduced(BLOCK). 채택 시 분석할 수 없던 언어의 기존 Symbol은 나중에 분석돼도 unverified-at-adoption(최대 WARN). init이 만든 Truth는 커밋 전까지 adoption-bootstrap이며 판정 대상이 아니다 | RC: `tests/mcp` provenance(CLI·MCP 동일), existing-project bootstrap. WS: `adoption.e2e` unverified-at-adoption(C181) |
| 5 | Cross-language | 모든 Git 저장소 L0, TypeScript/JavaScript L2, Java/C#/C++/Python L1, 그 밖의 언어는 파일 수준 L0. Analyzer가 없다는 이유만으로 WARN·BLOCK이 생기지 않는다(C180) | RC: `tests/cli/languages`, conformance(README 표 = status), `tests/distribution` polyglot |
| 6 | Context Compiler | 결정적 seed와 graph traversal, 기대 Entity 포함, 요청 budget 이하, 중복 이름은 임의로 고르지 않고 ambiguous, 자동 index 없음(index-required). ambiguous이면 CLI와 MCP 문구가 후보를 실제로 구분하는 handle(경로, qualified name, Requirement ID)만 안내한다(T26.2) | RC: conformance(기대 Entity, budget, ambiguous), existing-project(index-required), `tests/mcp/ambiguity`(A~E handle, 재시도 결과, structuredContent = CLI JSON, process 종료). WS: context e2e, benchmark |
| 7 | Deterministic Review | PASS/WARN/BLOCK/ASK는 claim·Evidence·Gap에 근거한다. PASS는 “가진 Evidence에서 Project Direction 위반을 찾지 못함”이며 버그 없음이 아니다. verdict는 `--fail-on` 없이는 종료 코드가 아니다(WARN 2, ASK 3, BLOCK 4). `review`는 쓰지 않고 `--record`만 Review Record를 쓴다 | RC: conformance review matrix, existing-project(`--fail-on`, `--record`) |
| 8 | Decision Lock | Agent(MCP)는 제안만 한다. confirm·reject·Truth 직접 쓰기 Tool은 없다. 확정은 사람이 CLI(터미널, ID 재입력)나 UI에서 한다. 이미 처리된 proposal을 다시 확정하면 거절한다 | RC: `tests/mcp`(9 tools, propose), conformance(UI confirm, 두 번째 confirm 거절). WS: cli.tty(confirm) |
| 9 | Optional LLM | 기본 provider none: API key와 무관하게 LLM 호출 0, network 0. provider를 설정했지만 key가 없으면 LLM만 unavailable이고 나머지는 정상. semantic assist는 결정적 결과를 바꾸지 않고 별도로 붙으며 PASS를 WARN까지만 올리고 BLOCK·ASK를 만들지 않는다. 0.2.0(T27.1): 공식 `openai-responses`와 별도로 명시 설정한 `openai-compatible` endpoint(Responses 또는 Chat Completions transport)를 쓸 수 있다. 설정한 transport·structured_output 하나로 한 번 요청하고 fallback·retry·redirect 추적이 없으며, 같은 redaction 경계와 DUO 최종 검증을 지난다. 호환성은 endpoint가 그 transport와 mode를 지원하는 범위다 | RC: `tests/cli/semantic`, `tests/cli/compatible`(loopback endpoint, 두 transport, prompt-only, redaction, fallback 없음, redirect, cache, MCP, doctor·status), conformance(key canary). WS: director·integration semantic e2e(fake provider), `llm/compatible` 단위(6조합, 오류 분류, timeout), `test:openai-smoke`·`test:compatible-smoke`(실제 endpoint, opt-in) |
| 10 | CLI | 명령과 옵션은 `duoctl --help`, README, 07이 같다. `--json`은 `duo.cli.<command>/1` envelope 하나. 성공(exit 0)이면 stdout에 결과가 반드시 있다. 종료 코드 0/1/2/3/4/5/6 | RC: conformance(형식, 종료 코드), 모든 subprocess helper의 성공 계약, 문서·help 대조 |
| 11 | MCP | `duo-director` 서버, Tool 9개, structuredContent = CLI JSON result, index하지 않음, stdout은 protocol만 | RC: `tests/mcp` |
| 12 | Codex integration | project `.codex/config.toml`만 구조적으로 수정(global 설정 미수정, trust 필요), 짧은 AGENTS.md 블록, 설정한 명령으로 MCP가 실제로 뜬다, clone 이동 가능 | RC: `tests/install`, `tests/distribution` |
| 13 | Claude Code integration | project `.mcp.json`, CLAUDE.md 블록, 서버 승인은 사용자가 한다(approvalRequired), 생성된 명령으로 MCP가 뜬다 | RC: `tests/install`, `tests/distribution` |
| 14 | Local UI | `127.0.0.1` loopback 로컬 도구. Host·Origin·session·CSRF 검사, GET으로 쓰기 불가, 외부 origin 자원 없음(CSP), 판단 logic 없이 CLI·MCP와 같은 operation 결과를 보여 준다 | RC: `tests/cli/ui`, conformance(parity, 보안, CSP, Decision Lock). WS: `tests/ui` browser |
| 15 | Distribution | `@duo-director/cli` 하나, Node 24.15+, native build·install script 없음, `npm-shrinkwrap.json`으로 고정된 트리, 제3자 고지, 설치본은 workspace를 보지 못한다 | RC: `tests/distribution`, conformance runner(shrinkwrap 트리, notices), `release:preflight` |
| 16 | Doctor (0.2.0, T26.1) | `duoctl doctor`는 읽기 전용(Truth·source·index·Agent 설정 byte 불변)이다. 선행 조건이 실패하면 뒤 check를 건너뛰고, 다음 행동을 Git → Truth → index → Agent 순서로 1~3개 보인다. 연결하지 않은 Agent와 꺼진 LLM은 정상이고, Codex와 Claude Code 중 기본 추천이 없다. 분석 수준은 L0/L1/L2 그대로이고 secret은 나오지 않는다. error check가 있을 때만 종료 코드 6 | RC: `tests/cli/doctor`(A~R lifecycle, 실제 MCP launch, no-mutation, secret canary, en/ko). WS: renderer 문구 전체(`apps/cli/src/doctor.test.ts`) |

## RC에서 검증하지 않는 것과 이유

- 대화형 터미널 흐름(질문, confirm의 ID 재입력): 가짜 TTY를 쓰는 `tests/cli/cli.tty`가 workspace에서 검증한다.
- fake provider를 쓰는 semantic assist: 설치본은 공식 endpoint만 쓰고 provider 주입이 없다(C189). workspace e2e와 opt-in 실제 smoke가 검증한다.
- analyzer upgrade 뒤 adoption provenance(C181): 더 적은 분석 언어로 기록된 baseline이 필요하다. 설치본에서는 기록된 baseline을 조작하지 않고 그런 상태를 만들 수 없다.
- 실제 브라우저 렌더링: `tests/ui` browser E2E가 workspace 서버로 검증한다. RC에서는 API, 보안, 정적 asset을 검증한다.
