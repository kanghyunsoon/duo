# 09. Token Strategy

상태: Draft

토큰 최적화는 DUO의 핵심 기능이다. 절감 주장은 이 문서의 정의와 재현 가능한 benchmark로만 한다.

## 우선순위

1. LLM을 호출하지 않는다.
2. 전체 Repository를 읽지 않는다(증분 인덱싱).
3. 관련 파일만 찾는다(Seed + Graph).
4. 관련 Symbol만 읽는다(Symbol 단위 로드, L1/L2/L3).
5. 관련 Subgraph만 전달한다(depth, nodeLimit).
6. 필요하면 작은 모델을 쓴다(Post-MVP, LLMProvider 라우팅).
7. 반복 Context를 caching 가능하게 만든다(고정 Section 순서, 불변 항목 앞 배치, 결정적 출력).
8. 출력은 기본적으로 간결하다.

## LLM을 쓰지 않는 작업

파일 변경 여부, Git diff, 테스트 성공 여부(test_command 종료 코드), dependency 존재, Issue 상태, Symbol 추출, import/call 관계, fingerprint 비교, Constraint/Decision 패턴 매칭, Knowledge Gap 관련성 판단. v0.1은 **모든 작업에서 LLM 호출 0회**다([ADR-008](adr/ADR-008-llm-policy.md)).

## 지표 정의

모든 토큰 값은 같은 TokenEstimator([ADR-005](adr/ADR-005-token-estimation.md))로 계산하고 추정기 이름을 함께 기록한다.

| 지표 | 정의 |
|---|---|
| Repository Files | 인덱싱 대상 파일 수(제외 규칙 적용 후) |
| Repository Estimated Tokens | 인덱싱 대상 파일 전체 내용의 토큰 합. fingerprint 단계에서 파일별로 계산해 저장한다 |
| Files Considered | 후보 Subgraph의 Node가 속한 서로 다른 파일 수(.duo 파일 포함) |
| Candidate (Raw) Context Tokens | Files Considered 파일 전체 내용의 토큰 합. "관련 파일을 통째로 읽는 Agent"의 비용 근사 |
| Files Loaded | Packet에 L2 이상으로 내용이 들어간 파일 수 |
| Loaded (Compiled) Context Tokens | 출력된 Packet text의 토큰 수 |
| Reduction % | `(1 − Loaded / Repository) × 100`, 소수 첫째 자리. Candidate 대비 값도 함께 기록 |
| LLM Calls | 이 요청에서 DUO가 한 LLM 호출 수 |
| Ground-truth Coverage | benchmark 전용. 시나리오에 정의된 필수 Node 중 Packet에 L1 이상으로 포함된 비율과 누락 목록 |

Reduction만으로는 품질을 보장하지 못한다. 아무것도 넣지 않으면 절감률은 100%가 되기 때문이다. 그래서 benchmark는 Coverage를 반드시 함께 보고한다.

## Benchmark

- 위치: `bench/`. 실행: `pnpm bench`.
- 대상: `fixtures/`의 repository와, 고정 commit으로 pin한 공개 오픈소스 repository 1~2개(선정은 T16).
- 시나리오 파일(`bench/scenarios/*.yaml`): repository, commit, task, budget, 필수 Node 목록, 적용할 diff(선택), 기대 Review verdict(선택).
- 출력: `bench/results/<date>-<git-sha>.md`와 `.json`. 표 열은 Repository Files, Repository Estimated Tokens, Files Considered, Files Loaded, Raw Context Tokens, Compiled Context Tokens, Reduction %, LLM Calls, Coverage, Review Result, Estimator.
- 재현성: 같은 DUO 버전, 같은 commit, 같은 시나리오는 같은 결과를 내야 한다. CI에서 fixture 시나리오를 실행하고 결과 변화를 diff로 보여 준다.
