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
| [performance-benchmark.md](performance-benchmark.md) | TASK-019 benchmark 방법, 기준 환경, index·Context·Review·MCP·UI 측정, C145 원인, 적용한 최적화, T23 real-world baseline(고정 SHA 5개 저장소, A/B 비교, 3 OS 수동 workflow) |
| [release/checklist.md](release/checklist.md) | release 명령, 0.1.1 준비와 0.1.0 상태, 사람이 확인할 항목, publish 명령(실행하지 않음), limitation |
| [release/notes-0.1.1.md](release/notes-0.1.1.md) | 0.1.1 release notes 초안 |
| [release/notes-0.1.2.md](release/notes-0.1.2.md) | 0.1.2 release notes 초안 |
| [release/decision-packets.md](release/decision-packets.md) | 사람 결정 요청: REQ-NFR-004, DUO LICENSE, npm scope·공개 저장소, 실제 OpenAI smoke |
| [release/compatibility.md](release/compatibility.md) | 0.1.0 format freeze와 breaking change 정책 |
| [release/product-contract.md](release/product-contract.md) | 0.1.0 제품 계약 15개와 검증 위치(RC artifact / workspace) |
| [roadmap/0.1.1-hardening.md](roadmap/0.1.1-hardening.md) | T21 Post-release Hardening: Windows UI E2E 원인과 수정, publish 후 검증, freshness profile, Node 22 실험, UX gap, 다음 버전 후보 |
| [roadmap/0.2.0-audit.md](roadmap/0.2.0-audit.md) | T22 0.2.0 Audit: 0.1.2 security 해결 기록, real-world 성능 5개 저장소, freshness 결론, L1 correctness issue, Context 품질, analyzer matrix, Node 22, onboarding, provider 결정점, 0.2.0 milestone 제안, T23 spec |
| [roadmap/0.2.0-t24-python-roots.md](roadmap/0.2.0-t24-python-roots.md) | T24.2 Python source-root discovery(C219)와 T24.1 잔여 감사(Python 재정의, Evidence pointer·hash, 여러 범위 표기): 이전 pipeline, 발견 규칙, metadata 범위, invalidation, 검증 |
| [roadmap/0.2.0-t24-overloads.md](roadmap/0.2.0-t24-overloads.md) | T24.1 overload evidence completeness(C217): Symbol identity lifecycle, repository evolution 실험, 설계안 A·B·C·D 비교, 위치 규칙, migration gate, 검증, signature 조사, T24.2 제안 |
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
