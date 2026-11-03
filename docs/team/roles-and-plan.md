# DUO 팀 역할, Issue 분담, 첫 2주 계획(T82, T86 팀 구성 변경 반영)

[README.md](README.md)의 협업 규칙을 전제로 한다. 작업을 똑같이 나누지 않고, 각자 다른 사람을 기다리지 않고 시작할 수 있는 첫 작업을 먼저 정했다.

## 1. 역할

6명이 백엔드 1명(BE-1), 프론트엔드 1명(FE-1), AI 4명(AI-1~AI-4)으로 일한다. 이전의 FS-1·FS-2 구분은 쓰지 않는다. BE-1은 kanghyunsoon으로 확정했다. 나머지 다섯 명은 각자 맡을 역할과 첫 Issue를 직접 고른다. maintainer가 GitHub 활동 내역으로 역할을 추정해 배정하지 않는다.

- 고르는 방법: 아래 §2 표에서 역할과 첫 Issue를 고르고, 그 Issue에 "AI-2로 맡겠습니다"처럼 역할과 접근 방법을 댓글로 남긴다.
- Assignee: 댓글을 확인한 maintainer가 GitHub Assignee와 Jira 담당자를 함께 지정한다. 댓글이 없는 Issue는 Unassigned로 둔다.
- 같은 역할을 두 사람이 고르면 Issue 댓글에서 나눈다. 역할은 첫 작업의 출발점일 뿐이고, 다른 영역 Issue에도 기여할 수 있다.

| 역할 | 영역 | 담당 |
|---|---|---|
| BE-1 | Backend · PM · Architecture: core, Project Truth, CLI, UI 서버 API, Graph, release, 우선순위와 merge | kanghyunsoon |
| FE-1 | Frontend · UI · UX: `packages/ui` 화면, 상태 처리, 접근성, 사람용 CLI 문구와 온보딩 UX | 본인 선택(Issue 댓글) |
| AI-1 | Decision Compliance · Context: review 판정, Context Packet, Knowledge Gap, analyzer, 오탐·미탐 | 본인 선택(Issue 댓글) |
| AI-2 | MCP · Agent Integration: MCP server, Codex·Claude Code 연동과 설정 보존, LLM provider | 본인 선택(Issue 댓글) |
| AI-3 | AI Evaluation · Benchmark: 측정 방법, A/B/C 실험, 성능·MCP benchmark, External Validation | 본인 선택(Issue 댓글) |
| AI-4 | Multi-Agent · Reliability: 동시 실행 일관성, 세션 간 연속성, freshness, CI 안정성 | 본인 선택(Issue 댓글) |

Jira(S15P31A106)에서는 모든 Story·Task·Bug·Sub-task에 `owner-be1`, `owner-fe1`, `owner-ai1`~`owner-ai4` 중 하나가 붙는다. 여러 직군이 함께 만드는 Story는 BE·FE·AI Sub-task로 나뉘고 부모 Story에 `has-subtasks`가 붙는다. 역할별 목록은 저장된 필터 "DUO · BE-1 …"~"DUO · AI-4 …"에 있고, 역할별 미완료 업무와 SP는 S15P31A106-329에 평일 09:00마다 자동 집계된다. 과거 완료 이슈의 owner 레이블은 그 영역을 지금 책임지는 역할을 뜻하며, 과거 수행자를 뜻하지 않는다.

## 2. 첫 작업과 후속 작업

| 역할 | 첫 작업 | 후속 후보 | 기다릴 것 |
|---|---|---|---|
| BE-1 | #25 Decision 확정 권한 설계(RBAC, 조사·설계만) | #26 승인 기록 gap 분석, PR #24 merge 판단, #3 setup 명령 흐름 | 없음 |
| FE-1 | #2 일반 workflow의 UX 목표와 측정 방법 | Decision 승인·이력 화면(#25·#26 결정 뒤), #3 setup 안내 문구 | 없음 |
| AI-1 | #30 알려진 오탐·미탐 원인 분석 | #7 README drift(0.4 정책), #5 WARN noise | 없음 |
| AI-2 | #27 설치·업데이트·제거 설정 보존 회귀 테스트 | #31 Claude Code 연동 검증, #3 agent 설치 단계 | 없음 |
| AI-3 | #28 토큰·시간 측정 방법 검증 | #32 MCP 시작·tool benchmark, #29 A/B/C pilot, #35 External Validation 02 | #28은 PR #24 branch에서 시작 가능 |
| AI-4 | #34 동시 agent 실행 일관성 | #33 세션·agent 간 Decision 연속성, #4 자동 복구의 안전 조건, #37 Windows CI | 없음 |

## 3. Issue 분담표

| Issue | 내용 | 역할 | 우선순위 | Milestone |
|---|---|---|---|---|
| #2 | Epic: 일반 workflow에서 DUO가 거의 보이지 않게 | FE-1(UX 목표), BE-1 관리 | P1 | v0.4.0 |
| #3 | 기존 저장소에 한 명령으로 설정 | BE-1(명령 흐름) · AI-2(agent 설치) · FE-1(안내 문구) | P2 | v0.4.0 |
| #4 | 안전할 때 stale index 자동 복구 | AI-4(안전 조건·테스트) · BE-1(재색인 lock) · AI-2(MCP 연결) | P2 | v0.4.0 |
| #5 | 일반 milestone·task 작업의 WARN noise | AI-1 | P2 | v0.4.0 |
| #7 | 설정 뒤 README를 고치면 모든 review가 WARN | AI-1(판정) · BE-1(Truth 형식) · FE-1(UI 표시) | P1 | v0.4.0 |
| #8 | Agent가 DUO MCP tool을 자주 못 찾음 | AI-2, 실측은 AI-3 | P1 | v0.4.0 |
| #25 | [GOV-01] Decision 확정 권한 설계 | BE-1 | P1 | v0.4.0 |
| #26 | [GOV-02] 승인 기록 gap 분석 | BE-1 | P2 | v0.4.0 |
| #27 | [UX-01] 설정 보존 회귀 테스트(#2 하위) | AI-2 | P1 | v0.4.0 |
| #28 | [VAL-01] 토큰·시간 측정 방법 | AI-3 | P1 | Product Value Validation |
| #29 | [VAL-02] A/B/C pilot | AI-3 | P1 | Product Value Validation |
| #30 | [VAL-03] 오탐·미탐 원인 | AI-1 | P1 | v0.4.0 |
| #31 | [MCP-01] Claude Code 연동 end to end | AI-2 | P1 | v0.4.0 |
| #32 | [MCP-02] MCP 시작·tool benchmark | AI-3 | P2 | v0.4.0 |
| #33 | [AGT-01] 세션·agent 간 Decision 연속성 | AI-4 | P2 | Product Value Validation |
| #34 | [AGT-02] 동시 agent 실행 일관성 | AI-4 | P1 | v0.4.0 |
| #35 | [EV-02] External Validation 02 | AI-3 | P1 | External Validation 02 |
| #37 | [CI-01] Windows CI의 project-local npm 설치 간헐적 600초 시간 초과 | AI-4(+BE-1) | P1 | 없음(모든 PR의 Windows CI에 영향) |

#37은 문서만 바꾼 PR도 Windows CI에서 막을 수 있다. 해결 전에는 이 테스트 하나만 실패한 경우 maintainer가 로그를 확인하고 재실행한다. 테스트를 건너뛰게 하지 않는다.

RBAC 이후의 구현(#25·#26 결정 뒤)은 Jira에서 BE(권한 검사, 이력 API), FE(승인·거절 버튼, 권한 오류 상태, 이력 화면), AI-1(Agent 우회 방지 테스트), AI-4(병렬 승인 일관성 테스트) Sub-task로 나뉘어 있다. FE 화면 작업은 BE API Sub-task에 Blocks 링크로 묶여 있다.

## 4. 같이 만지는 곳(병렬 작업 충돌)

| 영역 | 겹치는 Issue | 조율 방법 |
|---|---|---|
| `packages/integration/src/agents/*` | #27, #3, #31, #8 | #27(AI-2, 테스트만)을 먼저 merge하고, #3·#8의 동작 변경은 그 위에서 한다 |
| `packages/director/src/review/*` | #30, #5, #7 | #30은 분석·재현 테스트만. #5·#7 정책 변경은 maintainer 승인 뒤 한 PR씩 |
| Index freshness | #4, #34 | #34의 동시 실행 결과를 #4의 "안전" 정의에 반영 |
| Decision service | #25, #26, #34 | #25·#26은 설계 문서만. 구현은 maintainer 결정 뒤 |
| `bench/value-validation/` | #28, #29, #33 | PR #24 merge 전에는 그 branch에서 갈라지고, 파일을 나눠 맡는다 |

## 5. 첫 2주 일정

| 기간 | BE-1 | FE-1 | AI-1 | AI-2 | AI-3 | AI-4 |
|---|---|---|---|---|---|---|
| 10/19~10/20 | 역할 선택 댓글 확인·Assignee 지정, #37 Draft PR 검토 | 역할·Issue 선택, 환경 구성, #2 현재 workflow 관찰 | 역할·Issue 선택, #30 재현 | 역할·Issue 선택, #27 fixture 설계 | 역할·Issue 선택, PR #24 review | 역할·Issue 선택, #34 시나리오 |
| 10/21~10/23 | #25 선택지 비교 | #2 UX 목표·측정 지표 초안 | #30 원인 추적 | #27 Draft PR | #28 측정표, #32 script 골격 | #34 stress script |
| 10/26~10/28 | #25 결정 제안, PR #24 판단 | UI 정보 구조·상태 안내 검토 | #30 분류·후속 Issue | #27 review 반영, #31 절차 | #29 dry run, #32 측정 | #34 결과표, #33 시나리오 |
| 10/29~10/30 | 2주 회고, 다음 우선순위 | #2 결과 정리, 승인 UI 설계 준비 | #7·#5 접근안 | #27 merge 목표, #31 결과 | #29 pilot 승인 요청, #8 측정 승인 요청 | #4 안전 조건 초안 |

매주 금요일에 각자 Issue에 진행 상황을 한 댓글로 남긴다. 일정은 목표이며, 늦어지면 이유를 Issue에 남기고 범위를 줄인다.

## 6. 권한과 저장소 설정 제안(적용하지 않음)

권한 상태: owner `kanghyunsoon`만 admin, 다른 collaborator는 write, 한 명은 초대 수락 대기. CODEOWNERS 없음. Branch·tag ruleset 정의와 사전 검증, release 절차 대조는 [branch-protection.md](branch-protection.md)에 있다.

CODEOWNERS 초안(ruleset의 code owner review와 함께 켤 때만 의미가 있다):

```text
# Decision authority, Project Truth, release: maintainer review required
/packages/core/src/decisions/   @kanghyunsoon
/packages/core/src/schema/      @kanghyunsoon
/packages/core/src/loader/      @kanghyunsoon
/docs/conflicts.md              @kanghyunsoon
/docs/release/                  @kanghyunsoon
/scripts/release/               @kanghyunsoon
/scripts/release-lock.mjs       @kanghyunsoon
/.github/                       @kanghyunsoon
```

경로는 적용 전에 실제 디렉터리와 맞는지 다시 확인한다. 팀원 계정이 확정되면 영역별 공동 owner를 더한다.

