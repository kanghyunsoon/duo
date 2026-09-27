# 08. UI Spec

상태: Draft

## 원칙

- `duo ui`가 `127.0.0.1:7346`에 HTTP 서버를 띄우고 React 앱을 서빙한다. 외부 인터페이스에 bind하지 않는다.
- **읽기 전용**이다. 편집은 사람이 `.duo` 파일을 직접 수정한다([conflicts.md C4](conflicts.md)). 각 화면은 해당 파일 경로를 보여 준다.
- 화면은 5개만 만든다. 데이터는 아래 JSON API로만 가져온다.

## API

| Endpoint | 내용 |
|---|---|
| `GET /api/overview` | duo_get_status와 같은 데이터 + 최근 커밋 10개 |
| `GET /api/graph?seed=&depth=&types=` | Subgraph(Node/Edge). seed 없으면 Project → Milestone → Requirement 계층만 |
| `GET /api/decisions` | confirmed / proposed(proposals 포함) / superseded / rejected |
| `GET /api/drift` | 최신 Review Claim + 구조적 Drift |
| `GET /api/context?last=20` | metrics.jsonl 최근 항목과 누적 |
| `GET /api/reviews/:id` | Review 전체 JSON |

## 화면

### Overview

Project Goal, 현재 Milestone, 진행 현황(Requirement status별 개수: 예 "done 3 · in_progress 2 · planned 7", 퍼센트 대신 개수), Blocking Decisions(ASK/BLOCK을 만든 proposal과 gap), 최근 변경(커밋 10개, 마지막 Review verdict).

### Graph

검색창(ID, 경로, Symbol) → seed 선택 → depth 1~3 Subgraph 표시. Node type별 색, Edge type 필터, provenance 표시(heuristic은 점선). Node 클릭 시 오른쪽 패널에 속성, 소스 위치, 연결 목록. 전체 Graph를 한 번에 그리지 않는다(Node 300개 상한).

### Decisions

탭: Confirmed / Pending / Superseded. 각 항목에 question, answer, governs 대상, 파일 경로. Supersede 관계는 화살표로 연결.

### Drift

세 그룹으로 나눈다.

| 그룹 | 구조적 Drift(Review 없이 계산) | Review 기반 |
|---|---|---|
| Spec ↔ Code | status done인데 IMPLEMENTS 없음 / IMPLEMENTS 있는데 planned / Requirement 없는 exported Symbol 수 | R-SCOPE, R-TEST |
| Decision ↔ Code | forbids 패턴과 일치하는 기존 코드/dependency | R-DECISION, R-CONSTRAINT, R-LOCK |
| Issue ↔ Code | Issue done인데 연결 Requirement에 IMPLEMENTS 없음 / Issue open인데 해당 키 커밋 있음 | - |

각 항목은 Claim / Expected / Observed / Evidence 형식으로 보여 주고, Evidence는 파일:줄, 커밋, ID 링크를 가진다.

### Context

최근 요청 목록(시각, task, budget, loaded, reduction, llm_calls)과 선택 요청의 막대 비교:

~~~text
Repository Estimated Context   182,400 tokens
Candidate Context               17,800 tokens
Loaded Context                   4,920 tokens
Reduction                          97.3%
LLM Calls                              0
~~~

값은 모두 [09-token-strategy.md](09-token-strategy.md)의 정의를 따르며 추정기 이름을 함께 표시한다.

## 보안

Host 헤더가 `127.0.0.1:<port>` 또는 `localhost:<port>`가 아니면 거부한다(DNS rebinding 방지). 쓰기 endpoint가 없다. [10-security.md](10-security.md)
