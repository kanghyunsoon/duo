# DUO 문서 지도

DUO는 SDD(Specification-Driven Development) 방식으로 개발합니다. 구현은 이 문서들에 정의된 범위 안에서만 진행하며, 문서와 구현이 어긋나면 한쪽을 임의로 고치지 않고 [conflicts.md](conflicts.md)에 기록합니다.

| 문서 | 내용 |
|---|---|
| [00-product-vision.md](00-product-vision.md) | 문제, 역할 분리, 포지셔닝, 성공 기준 |
| [01-requirements.md](01-requirements.md) | 기능/비기능 요구사항, MVP 경계 |
| [02-system-architecture.md](02-system-architecture.md) | 계층, 패키지, 데이터 흐름, 확장 지점 |
| [03-data-model.md](03-data-model.md) | `.duo` 디렉터리와 파일 스키마, SQLite 스키마 |
| [04-project-graph.md](04-project-graph.md) | Node/Edge 의미, 탐색, 증분 갱신 |
| [05-context-compiler.md](05-context-compiler.md) | Director Context Packet 생성 알고리즘 |
| [06-mcp-interface.md](06-mcp-interface.md) | MCP Tool 계약 |
| [07-cli-interface.md](07-cli-interface.md) | CLI 명령, 출력, 종료 코드 |
| [08-ui-spec.md](08-ui-spec.md) | 로컬 Web UI 5개 화면 |
| [09-token-strategy.md](09-token-strategy.md) | 토큰 최적화 원칙과 지표 정의 |
| [10-security.md](10-security.md) | 신뢰 모델, 위협, 대응 |
| [11-testing-strategy.md](11-testing-strategy.md) | 테스트 계층, fixture, 필수 검증 항목 |
| [12-roadmap.md](12-roadmap.md) | Milestone과 MVP 이후 계획 |
| [conflicts.md](conflicts.md) | 원본 문서 간 충돌, 해석, Human 결정 대기 항목 |
| [adr/](adr/README.md) | 기술 결정 기록 |
| [tasks/TASKS.md](tasks/TASKS.md) | 구현 Task와 의존성 |

## 문서 우선순위

문서끼리 충돌하면 다음 순서로 해석하고, 충돌 자체는 [conflicts.md](conflicts.md)에 기록합니다.

1. Human이 확정한 항목(`Accepted` ADR, conflicts.md의 `Resolved` 항목)
2. [01-requirements.md](01-requirements.md)
3. 세부 설계 문서(02~12)
4. 원본 입력: [개발 지시문](references/development-directive.md), [기획서](../Duo%20기획서.md). 두 원본이 충돌하면 더 구체적이고 나중에 작성된 개발 지시문을 기본 해석으로 삼습니다.

## 상태 표기

- **Draft**: 작성됨, Human 검토 전
- **Proposed**: 검토 요청됨
- **Accepted**: Human 승인
- **Superseded**: 다른 결정으로 대체됨

현재 모든 문서와 ADR은 **Draft/Proposed** 상태입니다.
