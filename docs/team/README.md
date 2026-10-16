# DUO 팀 온보딩과 협업 규칙

DUO 6인 팀(T82)이 처음 기여를 시작할 때 읽는 문서다. 역할과 첫 작업, 2주 일정은 [roles-and-plan.md](roles-and-plan.md)에 있다. 외부 기여자 규칙은 [CONTRIBUTING.md](../../CONTRIBUTING.md)가 기준이고, 이 문서는 팀 운영에 필요한 내용을 더한다.

## 1. DUO가 하는 일

DUO는 coding agent가 일하는 저장소에 사람이 확정한 설계 결정(Decision)과 Project Truth를 두고, agent에게 필요한 Context를 주고, 코드 변경이 확정된 Decision을 어기는지 review한다. Agent는 Decision을 제안만 하고, 확정·거절·대체는 사람이 한다.

공개 stable 0.3.3에서 실제로 되는 것과 아직 계획인 것을 구분한다.

| 0.3.3에 있음 | 아직 없음(계획·조사 단계) |
|---|---|
| `duoctl init`, `status`, `doctor`, `index`, `context`, `review`, `decision`, `install`, `mcp`, `ui` | 한 명령 설정(#3), 안전한 index 자동 복구(#4) |
| MCP tool 9개, Codex·Claude Code 설치·제거 | 실제 Codex tool 발견률 측정(#8, NOT TESTED) |
| Decision `forbids`(imports, imported_paths)의 결정적 review | init constraint의 결정적 검사(0.3.3은 "검사하지 않음"을 표시만 함, #14) |
| Agent proposal → 사람 confirm(TTY, ID 재입력) | 역할 기반 확정 권한(RBAC, #25). 지금 actor는 기록용 label이며 인증이 아니다([10-security.md](../10-security.md)) |
| Analysis Level: Git 저장소 L0, TS/JS L2, Java·C#·C++·Python L1 | 다른 언어 L2 |

## 2. 개발 환경

- Node.js `>=24.15.0`, pnpm 11
- `pnpm install` → `pnpm verify`(boundaries → lint → typecheck → build → test → docs:validate)
- 테스트 하나: `pnpm exec vitest run <path>`
- 패키지 구조와 의존 방향은 [CONTRIBUTING.md](../../CONTRIBUTING.md)의 표와 [02-system-architecture.md](../02-system-architecture.md)를 본다. 패키지 경계는 `pnpm check:boundaries`와 ESLint가 막는다.

브랜치: 개발은 `next`에서 갈라진다. `main`은 stable release 기준이고 maintainer만 옮긴다. 이름은 `feat|fix|docs|test/issue-<번호>-<짧은-설명>`(예: `test/issue-27-install-roundtrip`).

## 3. Issue에서 merge까지

1. Issue를 고른다. [열린 Issue](https://github.com/kanghyunsoon/duo/issues)를 `area:*`·`priority:*` label이나 milestone(`v0.4.0`, `Product Value Validation`, `External Validation 02`)으로 거른다. 첫 작업은 [roles-and-plan.md](roles-and-plan.md) §2 표에서 고르되, 다른 영역 Issue도 자유롭게 고를 수 있다.
2. Issue에 맡을 역할과 접근 방법을 한두 줄 댓글로 남긴다(예: "AI-3로 맡겠습니다. LLM 없이 MCP client로 initialize와 tools/list 시간을 잽니다"). Maintainer가 Assignee로 지정한다. 같은 파일을 만지는 Issue(roles-and-plan.md §4)는 먼저 댓글로 조율한다.
3. `next`에서 branch를 만들고 하루 이틀 안에 Draft PR을 연다. 일찍 열수록 충돌을 빨리 찾는다.
   ```bash
   git fetch origin
   git switch -c test/issue-27-install-roundtrip origin/next
   # 작업, pnpm verify
   git push -u origin test/issue-27-install-roundtrip
   gh pr create --draft --base next --title "test: ..." --body "Refs #27 ..."
   ```
4. PR template의 항목을 채운다(아래 §4).
5. CI `verify` 3 OS(Windows·Ubuntu·macOS)를 기다린다. Ubuntu·macOS는 10~15분, Windows는 40~60분 걸린다. Windows에서 `project-local install (npx --no-install duoctl)` 테스트 하나만 시간 초과로 실패하면 알려진 문제 #37이다. 로그를 PR에 링크하고 maintainer에게 재실행을 요청한다. 다른 실패는 PR에서 고친다.
6. 준비되면 Draft를 "Ready for review"로 바꾸고, 작성자가 아닌 팀원 1명 이상에게 review를 요청한다. Reviewer는 변경을 직접 실행해 보고 Approve 또는 Request changes를 남긴다.
7. Maintainer가 squash merge한다. 작성자가 자기 PR을 merge하지 않는다.

막히면(blocked) Issue에 무엇을 시도했고 무엇이 막혔는지 적고 `help wanted`를 요청한다. 하루 넘게 혼자 붙잡지 않는다. 질문은 Issue 댓글이나 [Discussions](https://github.com/kanghyunsoon/duo/discussions)에 남긴다. 보안 취약점은 공개 Issue가 아니라 [SECURITY.md](../../SECURITY.md)의 비공개 신고를 쓴다.

## 4. PR에 쓸 것

- 연결한 Issue(`Closes #N` 또는 `Refs #N`)
- 목적과 범위, 일부러 하지 않은 것
- 추가·수정한 테스트와 실행 결과
- 사용자에게 보이는 변화: CLI 출력, 종료 코드, MCP 결과, 생성 파일
- 호환성: 출력 형식, schema, 저장 파일, 공개 `/1` 형식이 바뀌는지
- Project Truth·Decision 영향: Decision 의미, verdict(PASS/WARN/BLOCK/ASK), Decision Lock에 영향이 있는지
- 보안 영향: 새 파일 쓰기, 외부 호출, 인증 정보 접근
- CI 결과

## 5. Maintainer 승인이 필요한 변경

아래는 review 1명과 CI만으로 merge하지 않는다. Issue에서 maintainer의 명시적 승인을 먼저 받는다.

- Decision authority와 RBAC: 누가 Decision을 확정·거절·대체하는지, `DECISION_PERMISSIONS`
- Project Truth 형식, Decision Lock, 공개 `/1` 형식
- Review verdict의 의미와 종료 코드
- Release 정책, version, npm publish, tag, GitHub Release
- 유료 agent 실행(Codex·Claude 사용량)과 외부 참가자 모집·연락
- External Validation 01(0.2.1)은 바꾸지 않는다

## 6. AI가 쓴 코드

Coding agent로 코드를 써도 된다. 책임은 PR을 연 사람에게 있다. 직접 읽고 이해한 코드만 올리고, 테스트를 통과시키려고 fixture의 Truth나 Decision을 고치지 않는다. 실제로 실행하지 않은 검사를 PASS로 쓰지 않는다. 인증 파일, API key, 다른 사람의 저장소 내용을 PR·log·Issue에 넣지 않는다.

## 7. 첫 기여로 좋은 일

- 테스트 추가: #27(설치·제거 round-trip), #30(알려진 오탐·미탐 재현 테스트)
- LLM 없이 하는 측정: #32(MCP 시작·tool 신뢰성), #34(동시 실행 일관성)
- 문서: 직접 설치해 보며 README에서 막힌 곳을 Issue로 남기기
- 다른 팀원의 PR review: 재현해 보고 결과를 댓글로 남기기

