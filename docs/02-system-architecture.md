# 02. System Architecture

상태: Draft · 관련: [ADR-010](adr/ADR-010-package-structure.md), [ADR-008](adr/ADR-008-deterministic-first.md)

## 패키지와 의존 방향

```mermaid
flowchart TD
  cli["apps/cli<br/>(thin entry)"] --> integration & director & graph & analyzer & core
  integration["integration<br/>MCP · agents · http"] --> director & graph & core
  director["director<br/>context · review · gap · llm · init"] --> graph & analyzer & core
  graph["graph<br/>store · build · traverse · incremental"] --> analyzer & core
  analyzer["analyzer<br/>scan · fingerprint · language · git"] --> core
  core["core<br/>schema · decisions · verdict · tokens · fs-guard"]
  ui["ui<br/>React"] -. "type-only" .-> core
  ui -. "HTTP API" .-> integration
```

의존은 위에서 아래로만 흐른다. 역방향 import는 lint로 막는다(AC-001-02). CLI는 인자 파싱, 대화형 입력, 출력 형식, 종료 코드만 담당하고 domain 로직을 갖지 않는다(REQ-CLI-001).

| 패키지 | 책임 | Lane Task |
|---|---|---|
| core | .duo 스키마, loader, Markdown 정의 파서, ID와 추적성 검사, DecisionService, state 경로, Claim/Evidence/Verdict 타입, TokenEstimator, fs-guard | TASK-002, 009 |
| analyzer | 파일 스캔, fingerprint, LanguageAnalyzer(TS/JS), GitEvidenceProvider | TASK-004, 005, 006 |
| graph | GraphStore(node:sqlite), builder, traversal, incremental, trace, impact, check | TASK-003, 007, 008 |
| director | Context Compiler, Evidence, Review, Knowledge Gap, token budget, LLMProvider, InitService | TASK-010~014 |
| integration | MCP 서버, Codex/Claude Adapter, 로컬 HTTP API, (향후) 외부 EvidenceProvider | TASK-016, 017, 018 |
| ui | React 앱(5개 화면) | TASK-018 |
| apps/cli | `duo` 명령 | TASK-015 |

## 확장 지점

| Interface | 위치 | MVP 구현 | 향후 |
|---|---|---|---|
| `LanguageAnalyzer` | analyzer | TypeScriptAnalyzer, JavaScriptAnalyzer | PythonAnalyzer |
| `EvidenceProvider` | core(인터페이스) | GitEvidenceProvider(analyzer) | Jira, GitHub Issues(integration) |
| `LLMProvider` | director | NoneProvider, OpenAICompatibleProvider | Anthropic 등 |
| `TokenEstimator` | core | o200k_base, chars4(approx) | - |
| `GraphStore` | graph | node:sqlite | better-sqlite3 |
| `AgentAdapter` | integration | codex, claude | 기타 MCP Agent |

## 판단 순서 (Deterministic First)

```text
Rule → Static Analysis → Git → Test → Project Graph → Evidence Retrieval → LLM(의미 판단만)
```

LLM을 쓸 수 없으면 의미 판단은 UNKNOWN이나 ASK로 남고 나머지 기능은 그대로 동작한다([ADR-008](adr/ADR-008-deterministic-first.md)).

## 주요 흐름

### duo init (REQ-INIT-001~003)

```text
Git root 확인 ─▶ 스캔(.gitignore, 기본 제외, 비밀 파일 제외) ─▶ manifest / README / docs / 기획 문서 탐지
  ─▶ Git metadata(branch, HEAD, 최근 커밋) ─▶ LanguageAnalyzer로 Symbol·Import·Call·Test 추출
  ─▶ 초안: project.yaml, intent/vision.md(status: draft), intent/constraints.yaml, .duo/.gitignore
  ─▶ 구현 상태 추론(generated/inferred.json) · Knowledge Gap(generated/gaps.json)
  ─▶ Human 확인(TTY 대화형 또는 ASK 목록) ─▶ Graph 구축(generated/graph.db) ─▶ 요약 출력
```

LLM을 호출하지 않는다. 기존 기획 문서에 Requirement ID 형식이 있으면 가져오고, 없으면 Requirement를 만들지 않고 Knowledge Gap("Requirement 없음")으로 기록한다.

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
  ─▶ runtime/reviews/<id>.json (항상) · reviews/<id>.json (--record 시)
```

규칙과 집계는 [ADR-007](adr/ADR-007-verdict-model.md).

### Decision (REQ-DECISION-001~003)

```text
duo_propose_decision ─▶ decisions/proposals/P-*.yaml
Human: duo decision confirm|reject <id>  또는  UI Confirm/Reject ─▶ core DecisionService ─▶ .duo/decisions/
```

상세는 [ADR-013](adr/ADR-013-decision-lifecycle.md).

## Freshness

CLI 명령과 MCP Tool은 실행 전 증분 인덱싱을 한 번 한다. 변경 탐지는 `git status --porcelain`, 마지막 인덱싱 commit 이후 `git diff --name-status`, 파일 stat(size, mtime), 필요할 때만 hash 비교 순서로 한다. 변경이 없으면 parse하지 않는다(REQ-INDEX-002).

## 실행 형태와 동시성

| 프로세스 | 수명 | 쓰기 |
|---|---|---|
| CLI | 명령 1회 | generated/, cache/, runtime/, reviews/(--record), decisions/(confirm/reject) |
| MCP 서버 | Agent 세션 동안 | generated/, cache/, runtime/, decisions/proposals/(새 파일) |
| UI 서버 | 사용자가 종료할 때까지 | decisions/(Confirm/Reject만) |

SQLite는 WAL 모드로 연다. Graph 쓰기는 `generated/.lock` 파일 잠금으로 한 프로세스만 하고, 잠금을 얻지 못한 프로세스는 마지막 인덱스를 읽기만 하며 출력에 `stale`을 표시한다. Decision 파일 쓰기는 임시 파일에 쓴 뒤 rename하는 원자적 교체로 한다.

## 오류 처리

- `.duo` 파일 파싱 오류는 파일 경로와 줄 번호를 보고하고, 해당 파일만 제외한 채 계속 동작한다. 제외 사실은 Knowledge Gap으로 기록한다.
- 파싱할 수 없는 소스 파일은 File Node와 diagnostics만 남긴다.
- v0.1은 Git Repository만 지원한다. Git이 없으면 init을 거부한다.
- LLM 오류는 NoneProvider와 같은 결과(UNKNOWN)로 처리하고 Review를 실패시키지 않는다.
