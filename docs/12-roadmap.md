# 12. Roadmap

상태: Draft

## v0.1 (MVP)

| Milestone | Task | 완료 조건 |
|---|---|---|
| M0 설계 | T00 | SDD, ADR, TASKS 작성, Human 검토 |
| M1 Knowledge Core | T01–T07 | fixture 인덱싱, Graph 불변식, 증분 == 전체 |
| M2 Direction | T08–T11 | init, Decision Lock, Context Packet, Review verdict |
| M3 Interfaces | T12–T15 | CLI, MCP, install, UI |
| M4 Validation | T16–T17 | benchmark 보고서, 3 OS E2E 통과 |

M4가 끝나기 전에는 새 기능을 추가하지 않는다.

## v0.1 이후 (별도 Spec 작성 후 착수)

| 버전 후보 | 내용 | 착수 조건 |
|---|---|---|
| v0.2 | Jira Read-only Provider(`.duo/integrations/jira.yaml`, JQL), GitHub Issues Provider | v0.1 E2E를 실제 프로젝트 2개 이상에서 사용 |
| v0.3 | LLMProvider 구현(OpenAI 호환 API 1종으로 OpenAI와 로컬 서버 모두 지원), 의미 판정 규칙 | benchmark에서 규칙 기반 판정의 누락 사례가 기록된 후 |
| v0.4 | 언어 Adapter 추가(Python, Java 등), 테스트 결과 수집 | 사용자 요청 기준 |
| 이후 | 단일 binary 배포, UI 편집, Linear/GitLab | 각각 Spec 필요 |
