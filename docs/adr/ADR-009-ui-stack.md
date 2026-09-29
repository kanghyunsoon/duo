---
id: ADR-009
type: decision
title: UI 스택과 Human Action
state: confirmed
owner: human
question: ui
answer: "React + TypeScript static bundle served locally; read-centric; only Decision Confirm/Reject writes"
governs:
  requirements: [REQ-UI-001, REQ-UI-002]
supersedes: null
confirmed_by: human (H-1, H-4)
confirmed_at: 2026-09-27
---

# ADR-009: UI 스택과 Human Action

상태: **Accepted** (Human 결정 H-1, H-4)

## 결정

- React + TypeScript로 정적 번들을 만들고, integration 패키지의 로컬 HTTP 서버(Node 내장 `http`)가 서빙한다. `duoctl ui`는 사용 가능한 loopback port에서 이 서버를 띄운다. T18.1에서는 작은 단일 번들을 위한 esbuild 0.28.2를 선택했다. React/React DOM 19.3.0은 UI package에만 둔다.
- UI는 **읽기 중심**이다. 쓰기는 Decisions 화면의 **Confirm**과 **Reject** 두 동작만 허용한다(H-4). 이 동작은 CLI와 같은 `DecisionService`(core)를 호출해 `.duo-project/decisions/`를 직접 바꾼다. UI 전용 상태나 저장소를 만들지 않는다.
- Intent 대규모 수정, Spec Editor, Milestone Editor, Jira 수정, Source 수정은 구현하지 않는다.
- Graph는 기존 bounded trace/impact(기본 200 node)를 사용하는 관계 탐색기로 시작한다. 추가 graph 라이브러리 없이 Node, Edge, entity detail을 탐색한다. 큰 Graph 전체를 보내거나 렌더링하지 않는다.
- 상태 관리는 React 기본 기능과 fetch만 쓴다.

## 결과

- 쓰기 endpoint가 생기므로 로컬 요청 위조 방어가 필요하다(Host/Origin 검사, 실행별 token). 자세한 내용은 [10-security.md](../10-security.md)에 있다.
