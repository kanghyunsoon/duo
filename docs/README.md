# DUO 문서 지도

DUO는 SDD(Specification-Driven Development)로 개발한다. 구현은 이 문서들에 정의된 범위 안에서만 진행하고, 문서와 구현이 어긋나면 한쪽을 임의로 고치지 않고 [conflicts.md](conflicts.md)에 기록한다.

**T00 동결(2026-09-27)**: Requirement 52, ADR 14, Task 22, Milestone 5, AC 93. 새 Requirement와 ADR은 구현 중 필요가 발견될 때만 추가한다. 추적성은 `node scripts/validate-docs.mjs`로 검증한다.

| 문서 | 내용 |
|---|---|
| [00-product-vision.md](00-product-vision.md) | 문제, 역할 분리, 포지셔닝, 성공 기준 |
| [01-requirements.md](01-requirements.md) | Requirement(REQ-*), MVP 경계, 추적 표 |
| [02-system-architecture.md](02-system-architecture.md) | 패키지, 의존 방향, 데이터 흐름, 확장 지점 |
| [03-data-model.md](03-data-model.md) | `.duo-project` 구조, 파일 스키마, Markdown 정의 형식, SQLite 스키마 |
| [04-project-graph.md](04-project-graph.md) | Node/Edge 의미, SourceAnalysis, 탐색, 증분 갱신 |
| [05-context-compiler.md](05-context-compiler.md) | Director Context Packet 생성 알고리즘 |
| [06-mcp-interface.md](06-mcp-interface.md) | MCP Context Gateway Tool 계약 |
| [07-cli-interface.md](07-cli-interface.md) | CLI 명령, 출력, 종료 코드 |
| [08-ui-spec.md](08-ui-spec.md) | Local Project Direction Console과 Decision Confirm/Reject |
| [09-token-strategy.md](09-token-strategy.md) | 토큰 최적화 원칙, 측정 방식, benchmark |
| [10-security.md](10-security.md) | 신뢰 모델, 위협, 대응 |
| [11-testing-strategy.md](11-testing-strategy.md) | 테스트 계층, fixture, 필수 검증, E2E |
| [12-roadmap.md](12-roadmap.md) | Milestone(M0~M4)과 MVP 이후 |
| [language-support.md](language-support.md) | Analysis Level(L0~L3), AnalyzerCapabilities, 언어별 지원·한계, stack·build output 판별, grammar (T18.0) |
| [performance-benchmark.md](performance-benchmark.md) | TASK-019 benchmark 방법, 기준 환경, index·Context·Review·MCP·UI 측정, C145 원인, 적용한 최적화 |
| [conflicts.md](conflicts.md) | 원본 충돌, Human 결정 기록(H-*), 미결 사항 |
| [adr/](adr/README.md) | ADR-001~014 |
| [tasks/TASKS.md](tasks/TASKS.md) | TASK-000~020(TASK-012A/012B 포함), 의존성, E2E 매핑 |

## 추적성

`REQ-*` → `ADR-*` → `TASK-*` → `AC-*` 관계는 문서 안의 `duo` block과 ADR frontmatter에 선언되어 있다([ADR-014](adr/ADR-014-traceability-ids.md)). 이 문서들은 DUO가 그대로 인덱싱할 수 있는 형식이며, DUO 자체의 Project Graph fixture로 쓰인다.

## 문서 우선순위

문서끼리 충돌하면 다음 순서로 해석하고 충돌 자체를 [conflicts.md](conflicts.md)에 기록한다.

1. Human 결정: [conflicts.md의 Human 결정 기록](conflicts.md#human-결정-기록)(H-*)과 Accepted ADR
2. [01-requirements.md](01-requirements.md)
3. 세부 설계 문서(02~12), Proposed ADR
4. 원본 입력: [개발 지시문](references/development-directive.md), [기획서](../Duo%20기획서.md). 두 원본이 충돌하면 더 구체적이고 나중에 작성된 개발 지시문을 기본 해석으로 삼는다.
