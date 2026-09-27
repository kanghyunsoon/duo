# 02. System Architecture

상태: Frozen (T00 final, 2026-09-27) · 관련: [ADR-010](adr/ADR-010-package-structure.md), [ADR-008](adr/ADR-008-deterministic-first.md)

## 패키지와 의존 방향

```mermaid
flowchart TD
  cli["apps/cli<br/>(thin entry)"] --> integration & director & graph & analyzer & core
  integration["integration<br/>MCP · agents · http"] --> director & graph & core
  director["director<br/>context · review · gap · llm · init"] --> graph & analyzer & core
  graph["graph<br/>store · build · traverse · incremental"] --> analyzer & core
  analyzer["analyzer<br/>scan · fingerprint · language · git"] --> core
  core["core<br/>schema · decisions · verdict · tokens · write boundary"]
  ui["ui<br/>React"] -. "type-only" .-> core
  ui -. "HTTP API" .-> integration
```

의존은 위에서 아래로만 흐른다. 역방향 import는 lint로 막는다(AC-001-02). CLI는 인자 파싱, 대화형 입력, 출력 형식, 종료 코드만 담당하고 domain 로직을 갖지 않는다(REQ-CLI-001).

| 패키지 | 책임 | Lane Task |
|---|---|---|
| core | .duo-project 스키마, loader, Markdown 정의 파서, ID와 추적성 검사, DecisionService, state 경로, Claim/Evidence/Verdict 타입, TokenEstimator, write boundary 정책 | TASK-002, 009 |
| analyzer | 파일 스캔, fingerprint, LanguageAnalyzer(TS/JS), GitProvider | TASK-004, 005, 006 |
| graph | GraphStore(node:sqlite), builder, traversal, incremental, trace, impact, check | TASK-003, 007, 008 |
| director | Context Compiler, Evidence, Review, Knowledge Gap, token budget, LLMProvider, InitService | TASK-010~014 |
| integration | MCP 서버, Codex/Claude Adapter, 로컬 HTTP API, (향후) 외부 EvidenceProvider | TASK-016, 017, 018 |
| ui | React 앱(5개 화면) | TASK-018 |
| apps/cli | `duoctl` 명령 | TASK-015 |

## 확장 지점

| Interface | 위치 | MVP 구현 | 향후 |
|---|---|---|---|
| `LanguageAnalyzer` | analyzer | TypeScriptAnalyzer, JavaScriptAnalyzer | PythonAnalyzer |
| `EvidenceProvider` | Evidence 데이터 계약은 core(`Evidence`, `EvidenceBasis`), 수집 조정과 외부 provider 경계는 director(`evidence/`, T13, C44) | 내장 source: Project Truth, repository(Graph), Git(`GitProvider`), 호출자 테스트 결과, 선택 LLM | Jira, GitHub Issues(integration) |
| `LLMProvider` | director(계약, T12A). adapter는 integration(`packages/integration/src/llm/`) → director 방향. director는 vendor SDK를 import하지 않음(lint) | Noop provider(T12A), OpenAIResponsesProvider(T12B) | OpenAICompatibleChatProvider, AnthropicProvider, LocalProvider |
| `TokenEstimator` | director/tokens(C79) | o200k_base(gpt-tokenizer 4.0.0), chars/4(UI approx) | - |
| `GraphStore` | graph | NodeSqliteGraphStore(`node:sqlite`는 이 구현 안에서만 import) | better-sqlite3 기반 구현 |
| `AgentAdapter` | integration | codex, claude | 기타 MCP Agent |

## 판단 순서 (Deterministic First)

```text
Rule → Static Analysis → Git → Test → Project Graph → Evidence Retrieval → LLM(의미 판단만)
```

LLM을 쓸 수 없으면 의미 판단은 UNKNOWN이나 ASK로 남고 나머지 기능은 그대로 동작한다([ADR-008](adr/ADR-008-deterministic-first.md)).

**Deterministic First, LLM Optional**(T12A): Index, Graph, Context Compiler, Knowledge Gap 평가, Decision 생명주기는 LLMProvider를 받지 않고 호출하지도 않는다(`llmCalls: 0`). Provider가 없거나 꺼져 있거나 실패해도 application 오류가 아니다. LLM 결과는 결정적 결과 옆의 추가 해석일 뿐이며 Project Truth를 고치거나 Decision을 확정하지 않는다([ADR-012](adr/ADR-012-llm-provider.md#구현-t12a)).

## 주요 흐름

### duoctl init (REQ-INIT-001~003)

```text
Git root 확인(work tree 최상위만, nested Truth 금지) ─▶ .duo-project 상태(not-initialized · initialized · partial · incompatible)
  ─▶ 스캔(.gitignore, 기본 제외, 비밀 파일 제외) ─▶ 관찰: manifest, workspace, 언어, source·test root, script 이름, Git branch·HEAD
  ─▶ 후보 문서(경로 순위, 상한) · 기존 DUO 정의의 import 후보 ─▶ InitPlan(질문, willCreate, conflicts; 쓰기 0)
  ─▶ Human 답(TTY 대화형 또는 ASK 목록) ─▶ applyInitPlan: runtime/ staging → core loader 검증 → 배치(project.yaml 마지막), 실패 시 rollback
  ─▶ 호출자(CLI)가 Indexer 실행(generated/graph.db) ─▶ 요약 출력
```

LLM을 호출하지 않는다(TASK-014). 관찰한 사실은 observed, 그로부터 만든 값은 suggestion이고, Human이 답한 것만 confirmed Truth가 된다. 기존 문서의 DUO 정의는 import 후보로만 보이며 Human 확인 없이 Truth가 되지 않는다. Requirement를 지어내지 않고, 답하지 않은 질문은 Truth의 `UNKNOWN(<id>):` 줄(Declared Gap)로 남는다(C123).

### Context 요청 (REQ-CONTEXT-001, REQ-MCP-001)

```text
Agent ─duo_get_context(task)─▶ freshness(증분 인덱싱) ─▶ Seed 해석 ─▶ Subgraph 확장 ─▶ 필수 항목
  ─▶ 후보 표현(L1~L3) ─▶ budget packing ─▶ Packet ─▶ runtime/metrics.jsonl
```

상세는 [05-context-compiler.md](05-context-compiler.md).

### Review (REQ-REVIEW-001)

```text
diff(기본: working tree + index vs HEAD) ─▶ 변경 파일 증분 인덱싱 ─▶ 변경 Symbol ─▶ 영향 Subgraph(depth 2)
  ─▶ 결정적 규칙 ─▶ 의미 판정 escalation(Provider 있을 때만) ─▶ Claim[] ─▶ Verdict
  ─▶ runtime/reviews/<id>.json (호출자, 항상) · reviews/review-<hash>.json (Human이 recordReview를 호출할 때만, T13.1)
```

규칙과 집계는 [ADR-007](adr/ADR-007-verdict-model.md).

### Decision (REQ-DECISION-001~003)

```text
duo_propose_decision ─▶ decisions/proposals/P-*.yaml
Human: duoctl decision confirm|reject <id>  또는  UI Confirm/Reject ─▶ core DecisionService ─▶ .duo-project/decisions/
```

상세는 [ADR-013](adr/ADR-013-decision-lifecycle.md).

## Freshness

CLI 명령과 MCP Tool은 실행 전 증분 인덱싱을 한 번 한다. 변경 탐지는 Scanner의 현재 파일 목록과 `contentHash`를 이전 `generated/index-state.json`의 fingerprint와 비교해서 한다(TASK-004 `compareFingerprints`, TASK-008 Indexer). stat(size, mtime)은 이후 hash 계산을 줄이는 hint로만 쓸 수 있고, 내용이 같은지는 `contentHash`로만 판단한다(C33). 변경이 없으면 parse하지 않는다(REQ-INDEX-002).

## 실행 형태와 동시성

| 프로세스 | 수명 | 쓰기 |
|---|---|---|
| CLI | 명령 1회 | generated/, cache/, runtime/, reviews/(--record), decisions/(confirm/reject) |
| MCP 서버 | Agent 세션 동안 | generated/, cache/, runtime/, decisions/proposals/(새 파일) |
| UI 서버 | 사용자가 종료할 때까지 | decisions/(Confirm/Reject만) |

SQLite는 WAL 모드로 연다. Graph 쓰기는 SQLite writer lock(`BEGIN IMMEDIATE`)으로 한 프로세스만 하고 Indexer는 transaction 안에서 index state token을 다시 확인한다(T08). 잠금을 얻지 못한 프로세스는 마지막 commit 상태를 읽기만 한다(snapshot visibility). 이때 갱신하지 못한 Node의 freshness는 `unknown`으로 표시한다. freshness는 GraphStore가 아니라 Indexer의 비교 결과다(C31). Decision 파일 쓰기는 임시 파일에 쓴 뒤 rename하는 원자적 교체로 한다.

## 오류 처리

- `.duo-project` 파일 파싱 오류는 파일 경로와 줄 번호를 보고하고, 해당 파일만 제외한 채 계속 동작한다. 제외 사실은 Knowledge Gap으로 기록한다.
- 파싱할 수 없는 소스 파일은 File Node와 diagnostics만 남긴다.
- v0.1은 Git Repository만 지원한다. Git이 없으면 init을 거부한다.
- LLM 오류는 분류된 failure(`not-configured`, `unavailable`, `timeout`, `cancelled`, `authentication`, `rate-limit`, `invalid-response`, `provider-error`)로 돌아오며 Noop provider와 같은 결과(UNKNOWN)로 처리하고 Review를 실패시키지 않는다.
