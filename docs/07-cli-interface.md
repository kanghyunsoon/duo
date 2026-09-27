# 07. CLI Interface

상태: Draft

CLI는 Human과 Agent가 함께 쓴다. 기본 출력은 짧은 text, `--json`은 MCP structuredContent와 같은 스키마를 쓴다.

## 공통 옵션

`--root <path>`(기본: 위로 올라가며 .duo 탐색), `--json`, `--verbose`, `--no-color`, `--version`, `--help`.

## 명령

| 명령 | 설명 | 주요 옵션 |
|---|---|---|
| `duo init` | 최초 분석과 .duo 생성 | `--yes`(질문 생략, 초안만), `--non-interactive`, `--reindex`(generated/state 재생성, Human 파일 불변) |
| `duo status` | Goal, Milestone, 진행 현황(개수), 대기 결정, open gap, 최근 변경, 구조적 Drift | |
| `duo context <task>` | Director Context Packet 출력 | `--budget <n>`, `--no-diff` |
| `duo review` | 변경 검수 | `--base <ref>`, `--staged`, `--run-tests`(test_command 설정 시), `--strict` |
| `duo trace <node>` | Node 연결 추적 | `--depth <1-3>` |
| `duo impact <symbol>` | 영향 범위 | `--depth <1-3>` |
| `duo stats` | 누적 Context/Review 지표 | `--last <n>` |
| `duo ui` | 로컬 Web UI | `--port <n>`(기본 7346), `--no-open` |
| `duo install <codex\|claude>` | Agent 연동 | `--dry-run`, `--uninstall` |
| `duo mcp` | MCP stdio 서버(Agent 설정이 호출) | |

`duo install`과 `duo mcp`은 개발 지시문 11절 최소 목록에는 없지만 10절 설치 UX와 9절 MCP를 위해 필요하다([conflicts.md C16](conflicts.md)).

## duo init 대화

TTY이고 `--yes`가 아니면 세 가지만 묻는다. 각 질문은 추론한 기본값을 보여 주고 Enter로 수락할 수 있다.

1. 프로젝트 Goal 한 문장 (기본값: package.json description 또는 README 첫 문단)
2. 이번 MVP에서 하지 않을 것 (쉼표 구분, Constraint 초안으로 저장, `state: draft`)
3. 현재 Milestone 이름 (기본값: M1)

비대화형이면 같은 질문을 ASK 목록으로 출력하고 초안 파일에 `UNKNOWN:` 줄로 남긴다. Agent는 이 목록을 사용자에게 전달한다.

## 종료 코드

| 코드 | 의미 |
|---|---|
| 0 | 성공, review PASS 또는 WARN(`--strict`이면 WARN은 2) |
| 1 | 실행 오류 |
| 2 | review WARN(`--strict`) |
| 3 | review ASK |
| 4 | review BLOCK |
| 5 | .duo 없음(NOT_INITIALIZED) |

## 출력 예

~~~text
$ duo review
BLOCK  2 claims · 3 files · llm_calls 0
  CONFLICT  R-LOCK        D-004 confirmed decision modified in working tree
            evidence: .duo/decisions/D-004.yaml (HEAD 대비 answer 변경)
  PARTIAL   R-TEST        AuthService.refresh changed without related test changes
            evidence: src/auth/AuthService.ts:40-71, test AuthService > refresh
saved .duo/evidence/reviews/R-20260927-153012-91aca1.json
~~~
