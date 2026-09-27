# 07. CLI Interface

상태: Frozen (T00 final, 2026-09-27) · 관련: REQ-CLI-001, REQ-DECISION-002, REQ-NFR-006

CLI(`apps/cli`)는 얇은 진입점이다. 인자 파싱, 대화형 입력, 출력 형식, 종료 코드만 담당하고 모든 동작은 packages의 서비스를 호출한다. Human과 Agent가 함께 쓰며, 기본 출력은 짧은 text이고 `--json`은 MCP structuredContent와 같은 스키마를 쓴다.

## 공통 옵션

`--root <path>`, `--json`, `--verbose`, `--no-color`, `--version`, `--help`

## 명령

| 명령 | 설명 | 주요 옵션 | 서비스 |
|---|---|---|---|
| `duoctl init` | 최초 분석과 .duo-project 생성 | `--yes`(질문 생략, 초안만), `--non-interactive`, `--reindex`(generated 재생성, 정의 파일 불변) | director InitService |
| `duoctl status` | Goal, Milestone, 진행 현황(개수), pending decision, open gap, 최근 변경, 구조적 Drift, LLM 상태 | | director |
| `duoctl context <task>` | Director Context Packet | `--budget <n>`, `--no-diff` | director ContextCompiler |
| `duoctl review` | 변경 검수 | `--base <ref>`, `--staged`, `--run-tests`, `--strict`, `--record`, `--no-llm` | director Review |
| `duoctl decision confirm <id>` | proposal 또는 proposed Decision 확정 | (TTY 전용, `--yes` 없음) | core DecisionService |
| `duoctl decision reject <id>` | proposal 거절 | `--reason <text>`(TTY 전용) | core DecisionService |
| `duoctl trace <node>` | 연결 추적 | `--depth <1-3>` | graph |
| `duoctl impact <symbol>` | 영향 범위 | `--depth <1-3>` | graph |
| `duoctl stats` | 누적 Context, Review, LLM 지표 | `--last <n>` | director |
| `duoctl ui` | 로컬 Web UI | `--port <n>`(기본 7346), `--no-open` | integration http |
| `duoctl install <codex\|claude>` | Agent 연동 | `--dry-run`, `--uninstall` | integration agents |
| `duoctl mcp` | MCP stdio 서버(Agent 설정이 호출) | | integration mcp |

지시문 D§11의 최소 목록에 없는 `decision`(H-1), `install`(D§10), `mcp`(D§9)은 다른 요구를 위해 추가했다([conflicts.md C16](conflicts.md)). `duoctl review --record`는 그 Review를 Human이 보존할 기록으로 `.duo-project/reviews/`에 남긴다([ADR-006](adr/ADR-006-duo-layout-git-policy.md)). MCP로는 Record를 만들 수 없다.

## duoctl decision

- TTY가 아니면 거부하고 종료 코드 1을 반환한다. Agent가 비대화형으로 실행하는 것을 막기 위한 장치이며 보안 경계는 아니다([10-security.md](10-security.md)).
- confirm은 Decision 내용과 supersede 대상을 보여 준 뒤 ID를 다시 입력받는다.
- 동작은 [ADR-013](adr/ADR-013-decision-lifecycle.md)을 따른다.

```text
$ duoctl decision confirm P-20260927-k3f9qa
Proposal P-20260927-k3f9qa  "Refresh token rotation"
  question  refresh_token_policy
  answer    rotate_on_use
  governs   AUTH-03
  proposed  claude-code · 2026-09-27
Type the proposal ID to confirm: P-20260927-k3f9qa
confirmed as D-005 · lock sha256:9b2e… · .duo-project/decisions/D-005.yaml
```

## duoctl init 대화

TTY이고 `--yes`가 아니면 세 가지만 묻는다. 각 질문은 추론한 기본값을 보여 주며 Enter로 받아들일 수 있다.

1. 프로젝트 Goal 한 문장(기본값: package.json description 또는 README 첫 문단)
2. 이번 MVP에서 하지 않을 것(쉼표로 구분, Constraint 초안 `state: draft`로 저장)
3. 현재 Milestone 이름(기본값: M1)

비대화형이면 같은 질문을 ASK 목록으로 출력하고 초안 파일에 `UNKNOWN:` 줄로 남긴다. Agent는 이 목록을 사용자에게 전달한다.

## duoctl stats

```text
$ duoctl stats --last 20
context  20 requests · avg loaded 4,310 · avg reduction 97.12% · estimator o200k_base
review   6 runs · PASS 2 · WARN 3 · BLOCK 1 · ASK 0
llm      provider openai-responses · calls 4 · input 11,820 · output 1,044 (provider usage)
```

## 종료 코드

| 코드 | 의미 |
|---|---|
| 0 | 성공, review PASS 또는 WARN(`--strict`이면 WARN은 2) |
| 1 | 실행 오류, TTY가 필요한 명령을 비TTY에서 실행 |
| 2 | review WARN(`--strict`) |
| 3 | review ASK |
| 4 | review BLOCK |
| 5 | .duo-project 없음(NOT_INITIALIZED) |

## 출력 예

```text
$ duoctl review
BLOCK  3 claims · 3 files · llm_calls 0 · skipped R-INTENT (llm_unavailable)
  CONFLICT  R-LOCK     D-004 confirmed decision modified (lock digest mismatch)
            evidence: .duo-project/decisions/D-004.yaml, lock sha256:3f1c…
  PARTIAL   R-TEST     AuthService.refresh changed without related test changes
            evidence: src/auth/AuthService.ts:40-71, test AuthService > refresh
  UNKNOWN   R-SCOPE    RateLimiter is not linked to any requirement (semantic check unavailable)
            evidence: src/net/RateLimiter.ts (added)
saved .duo-project/runtime/reviews/R-20260927-153012-91aca1.json
```
