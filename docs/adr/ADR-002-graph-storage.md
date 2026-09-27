---
id: ADR-002
type: decision
title: Graph 저장소
state: proposed
owner: human
question: graph_storage
answer: "node:sqlite behind GraphStore interface"
governs:
  requirements: [REQ-GRAPH-001, REQ-INDEX-002]
supersedes: null
proposed_by: codex (TASK-000)
proposed_at: 2026-09-27
---

# ADR-002: Graph 저장소

상태: **Proposed** (Human 검토 대기)

## 배경

외부 Neo4j를 필수로 만들지 않는다(D§4). 네이티브 모듈 빌드는 Windows 설치 실패의 주된 원인이다(REQ-NFR-003).

## 선택지

| 후보 | 장점 | 단점 |
|---|---|---|
| `node:sqlite`(Node 내장) | 추가 의존성과 네이티브 빌드가 없음. Node 24.15.0 이상에서 플래그 없이 사용 | Stability 1.2(Release Candidate)라 API가 바뀔 수 있음 |
| better-sqlite3 | 성숙하고 빠름 | 네이티브 모듈, prebuild가 없으면 컴파일 필요 |
| sql.js(WASM) | 순수 WASM | 메모리 DB 기반이라 파일 영속화가 번거로움 |
| JSON 파일 | 단순 | 탐색 성능과 동시성 |

## 결정(제안)

`node:sqlite`를 `GraphStore` 인터페이스 뒤에서 사용한다. SQL은 graph 패키지 밖으로 나가지 않는다. BFS는 애플리케이션 코드에서 수행하고 SQLite는 인접 조회만 담당한다.

## 결과

- API가 바뀌면 GraphStore 구현만 고친다. 대체 구현 후보는 better-sqlite3다.
- `generated/graph.db`는 재생성 가능한 데이터라 스키마가 바뀌면 migration 대신 재생성한다.
