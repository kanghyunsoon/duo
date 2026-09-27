# ADR-009: UI 스택

- 상태: Proposed
- 날짜: 2026-09-27
- 결정권자: Human

## 결정

- React + Vite로 정적 번들을 만들고 `cli` 패키지의 Node 내장 `http` 서버가 서빙한다. 웹 프레임워크 서버 의존성을 두지 않는다.
- Graph 시각화 라이브러리는 T15에서 Cytoscape.js와 React Flow를 비교해 고른다(기준: 번들 크기, 300 Node 성능, 레이아웃 품질).
- 상태 관리는 React 기본 기능과 fetch만 쓴다.
- 읽기 전용(C4).

## 결과

UI 번들은 배포 패키지에 포함되고 런타임에 빌드하지 않는다.
