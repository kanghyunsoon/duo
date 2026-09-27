# ADR-006: .duo 파일 형식과 Git 정책

- 상태: Proposed
- 날짜: 2026-09-27
- 결정권자: Human

## 결정

- Human-owned 데이터: YAML(구조), Markdown(서술 + `duo` fenced block). JSON은 generated 데이터에만 쓴다.
- 모든 파일은 zod 스키마로 검증하고 오류는 파일:줄로 보고한다. `project.yaml`에 `schema_version`을 둔다.
- Git 관리: project.yaml, intent/, specs/, decisions/(proposals 포함), milestones/, integrations/.
- gitignore(.duo/.gitignore로 생성): state/, evidence/, generated/.
- 정의는 [03-data-model.md](../03-data-model.md).

## 결과

- UI나 DB가 Source of Truth가 되지 않는다. graph.db는 언제든 삭제·재생성 가능하다.
- evidence는 로컬 기록이라 clone 간 공유되지 않는다(C13). 공유 요구가 생기면 별도 ADR.
