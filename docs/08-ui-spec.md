# 08. UI Spec

상태: Draft · 관련: REQ-UI-001, REQ-UI-002, REQ-REVIEW-004, [ADR-009](adr/ADR-009-ui-stack.md), [ADR-013](adr/ADR-013-decision-lifecycle.md)

## 원칙

- `duo ui`가 `127.0.0.1:7346`에 HTTP 서버(integration/http)를 띄우고 React 앱을 서빙한다. 외부 인터페이스에는 bind하지 않는다.
- **읽기 중심**이다. 허용되는 쓰기는 Decisions 화면의 **Confirm**과 **Reject** 두 동작뿐이다(H-4).
- Confirm/Reject는 core의 `DecisionService`를 호출해 Source of Truth인 `.duo/decisions/`를 직접 바꾼다. UI 전용 상태, DB, 로컬 저장소를 만들지 않는다.
- Intent 대규모 수정, Spec Editor, Milestone Editor, Jira 수정, Source 수정은 구현하지 않는다.
- 화면은 5개다. 각 화면은 데이터의 원본 파일 경로를 보여 준다.

## API

| Method | Endpoint | 내용 |
|---|---|---|
| GET | `/api/overview` | duo_get_status와 같은 데이터 + 최근 커밋 10개 |
| GET | `/api/graph?seed=&depth=&types=` | Subgraph(Node/Edge). seed가 없으면 Project → Milestone → Requirement 계층만 |
| GET | `/api/decisions` | confirmed / pending(proposals 포함) / superseded / rejected |
| GET | `/api/drift` | 최신 Review Claim + 구조적 Drift |
| GET | `/api/context?last=20` | metrics.jsonl 최근 항목과 누적(LLM 사용량 포함) |
| GET | `/api/reviews/:id` | Review 전체 JSON(runtime 또는 Record) |
| GET | `/api/source?path=&start=&end=` | Evidence 확인용 소스 줄(인덱싱 대상 파일만, 200줄 상한) |
| POST | `/api/decisions/:id/confirm` | DecisionService.confirm. 본문 `{ confirm_id }`(사용자가 다시 입력한 ID) |
| POST | `/api/decisions/:id/reject` | DecisionService.reject. 본문 `{ reason? }` |

## 화면

### Overview

Project Goal, 현재 Milestone, 진행 현황(Requirement status별 개수로 표시하며 퍼센트를 쓰지 않는다. 예: "done 3 · in_progress 2 · planned 7"), Blocking Decisions(ASK나 BLOCK을 만든 proposal과 gap), 최근 변경(커밋 10개, 마지막 Review verdict), LLM Provider 상태.

### Graph

검색창(ID, 경로, Symbol) → seed 선택 → depth 1~3 Subgraph를 표시한다. Node type별 색, Edge type 필터, provenance 표시(heuristic은 점선)를 둔다. Node를 클릭하면 오른쪽 패널에 속성, 소스 위치, 연결 목록이 나온다. 전체 Graph를 한 번에 그리지 않는다(300 Node 상한).

### Decisions

탭: **Confirmed / Pending / Superseded**(Rejected는 Superseded 탭 아래에 접힌 목록으로 둔다). 각 항목에 question, answer, governs 대상, evidence, 파일 경로, lock 상태를 보여 준다.

Pending 항목에만 버튼 두 개가 있다.

- **Confirm**: 확인 대화상자에 기록될 내용(새 D-### ID, supersede 대상, lock)을 보여 주고, 사용자가 proposal ID를 다시 입력해야 실행된다. 성공하면 새 파일 경로를 표시한다.
- **Reject**: 사유(선택)를 입력받아 실행한다.

실행 결과는 파일에서 다시 읽어 표시한다. 낙관적 UI 상태를 두지 않는다.

### Drift

| 그룹 | 구조적 Drift(Review 없이 계산) | Review 기반 |
|---|---|---|
| Spec ↔ Code | status done인데 IMPLEMENTS 없음 / IMPLEMENTS가 있는데 planned / Requirement에 연결되지 않은 exported Symbol 수 | R-SCOPE, R-TEST, R-REQ, R-INTENT, R-DRIFT |
| Decision ↔ Code | forbids 패턴과 일치하는 기존 코드나 dependency / lock digest 불일치 | R-DECISION, R-CONSTRAINT, R-LOCK |
| Issue ↔ Code | Issue done인데 연결 Requirement에 IMPLEMENTS 없음 / Issue todo인데 해당 키를 언급한 커밋 있음 | - |

각 항목은 Claim / Expected / Observed / Evidence 형식으로 보여 주고, Evidence는 파일:줄, 커밋, ID 링크를 가진다. Claim의 `basis`(rule, static, git, test, graph, heuristic, llm)를 배지로 표시한다.

### Context

최근 요청 목록(시각, task, budget, loaded, reduction, llm_calls)과, 선택한 요청의 막대 비교를 보여 준다.

```text
Token Estimator                 o200k_base
Repository Estimated Context   182,400 tokens
Candidate Context               17,800 tokens
Loaded Context                   4,920 tokens
Reduction                          97.30%
LLM Calls                              0
```

값은 [09-token-strategy.md](09-token-strategy.md)의 정의를 따른다. tokenizer 값이 아직 없는 항목은 `approx (chars/4)` 배지를 붙여 구분한다. LLM 사용량(호출 수, 입력/출력 토큰, 출처 provider/estimated)도 함께 보여 준다.

## 보안

쓰기 endpoint가 있으므로 [10-security.md](10-security.md#로컬-http-api)의 방어(127.0.0.1 bind, Host/Origin 검사, 실행별 token, JSON content-type 강제)를 모두 적용한다.
