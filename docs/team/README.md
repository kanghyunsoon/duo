# DUO 팀 온보딩과 협업 규칙

DUO 6인 팀(T82)이 처음 기여를 시작할 때 읽는 문서다. 역할과 첫 작업, 2주 일정은 [roles-and-plan.md](roles-and-plan.md)에 있다. 외부 기여자 규칙은 [CONTRIBUTING.md](../../CONTRIBUTING.md)가 기준이고, 이 문서는 팀 운영에 필요한 내용을 더한다.

> **2026-11-19부터는 maintainer 한 명이 운영한다(H-107).** 팀 개발 기간이 끝나 DUO는 maintainer kanghyunsoon이 혼자 개발한다. 리뷰와 병합은 §3a를 따르며, 작성자가 아닌 사람의 승인(독립 리뷰)은 병합 조건이 아니다. 팀 역할, 첫 작업, 일정은 팀 기간의 기록으로 남겨 둔다.

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
6. 준비되면 Draft를 "Ready for review"로 바꾼다. 외부 기여자의 PR은 maintainer가 리뷰한다(§3a).
7. Maintainer가 §3a 절차대로 squash merge한다. Maintainer가 쓴 PR에도 독립 승인은 필요 없다(H-107).

막히면(blocked) Issue에 무엇을 시도했고 무엇이 막혔는지 적고 `help wanted`를 요청한다. 하루 넘게 혼자 붙잡지 않는다. 질문은 Issue 댓글이나 [Discussions](https://github.com/kanghyunsoon/duo/discussions)에 남긴다. 보안 취약점은 공개 Issue가 아니라 [SECURITY.md](../../SECURITY.md)의 비공개 신고를 쓴다.

## 3a. 리뷰와 병합(maintainer 1인 운영, H-107)

2026-11-19부터 DUO는 maintainer kanghyunsoon 한 명이 개발한다. 작성자가 아닌 사람의 승인(독립 리뷰)은 병합 조건이 아니다. 대신 3개 OS CI와 maintainer의 자기 검토 기록으로 품질을 지킨다. 팀 개발 기간(T178~2026-11-18)에 쓰던 영역 책임자, 독립 리뷰, 48시간 재배정 규칙은 더 이상 적용하지 않으며, 그 내용은 이 문서의 git 기록에 남아 있다.

### Maintainer가 쓴 PR

1. `next`에서 branch를 만들어 PR로 올린다. `next`에 직접 push하지 않는다.
2. 현재 HEAD에서 CI `verify`가 Windows·Ubuntu·macOS 모두 통과해야 한다. 로그 근거 없이 실패를 flaky로 치지 않는다.
3. 병합 전에 PR 댓글로 자기 검토 기록을 남긴다. 검토한 HEAD SHA, 바뀐 범위, 직접 실행한 테스트와 CI 결과, 남은 항목(없으면 "없음")을 적는다. 보안, 동시성(lock, 여러 process), 파일 쓰기·삭제·경로, Decision·verdict 의미를 바꾸는 PR은 수정 전후 동작을 직접 재현해 결과를 함께 적는다.
4. 리뷰 스레드를 모두 resolve한다.
5. 기록한 HEAD 그대로 병합한다: `gh pr merge <번호> --squash --match-head-commit <HEAD SHA>`.
6. 병합 직후 그 squash commit에서 `next` CI 3 OS가 통과했는지 확인하고 나서 다음 PR을 병합한다. 실패하면 다음 병합을 멈추고 그 실패부터 고친다.

### 외부 기여자와 이전 팀원의 PR

- Maintainer가 리뷰하고 Approve 또는 Request changes를 남긴다. 리뷰 본문에는 검토한 HEAD SHA, 확인한 범위, 직접 실행한 테스트를 적는다.
- [CONTRIBUTING.md](../../CONTRIBUTING.md)의 민감한 파일은 한 줄씩 읽는다. 외부 기여자의 workflow 실행은 변경을 읽은 뒤에 승인한다.
- 병합 조건은 위의 2, 4, 5, 6과 같다.
- 작성자의 branch는 maintainer가 고치지 않는다. 작성자가 더 이상 진행하지 않으면 maintainer branch에서 이어 작업하고, 원래 PR을 링크하고 원 작성자를 `Co-authored-by`로 남긴다.

### 팀 기간에 남은 리뷰

팀 기간에 남은 Request changes 때문에 PR을 병합할 수 없으면, maintainer가 지적한 항목이 현재 HEAD에 모두 반영됐는지 확인한다. 반영된 것이 확인되면 그 근거를 PR에 적고, 사유를 붙여 GitHub의 dismiss로 정리한다. 반영되지 않은 지적은 dismiss하지 않고 먼저 고친다.

### Maintainer가 결정할 변경(§5)

§5의 변경도 독립 승인 없이 maintainer가 결정한다. 정책이 바뀌면 [docs/conflicts.md](../conflicts.md)에 Human Decision을 먼저 기록하고 구현을 병합한다. Release, npm publish, tag, GitHub Release는 [docs/release/checklist.md](../release/checklist.md)와 release 스크립트(`release:preflight`, `release:authorization`)를 지금 그대로 따른다.

### Agent

Maintainer 계정으로 일하는 coding agent는 maintainer가 지시한 작업에 한해 같은 절차로 PR을 병합할 수 있다. 이때 자기 검토 기록에 agent가 작성했다는 사실을 적는다. 유료 agent 실행, release, publish, ruleset 변경에는 작업마다 maintainer의 명시적 지시가 있어야 한다.

### GitHub가 강제하는 것과 운영 규칙

| 항목 | ruleset이 강제 | 운영 규칙 |
|---|---|---|
| 승인 | 요구하지 않는다(`next-integration`의 `required_approving_review_count: 0`) | 병합 전에 자기 검토 기록을 남긴다(외부 PR은 maintainer 리뷰) |
| CI | `verify` Windows·Ubuntu·macOS 필수 | 병합한 squash commit의 `next` CI를 확인한 뒤 다음 병합 |
| 리뷰 스레드 | 모두 resolve | |
| Merge | squash만 | `--match-head-commit`으로 검토한 HEAD만 병합 |
| 삭제·force push | `branches-immutable`이 `main`·`next`에서 막는다 | |
| `main` | `main-stable`이 모든 갱신을 막는다. admin bypass로만 옮길 수 있다 | release 때만 fast-forward로 옮긴다. 그 release의 Human Decision을 기록한 뒤 |
| Release tag | `release-tags-create`, `release-tags-immutable` | release 절차대로 |
| `next`에서 admin bypass | admin은 가능 | 쓰지 않는다(필수 CI를 건너뛰므로) |

이전 팀원의 write 권한은 열린 PR을 정리한 뒤 triage로 낮춘다(H-107). 그 전에도 팀원은 위 절차를 따르고, 병합은 maintainer가 한다.

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

아래는 CI 통과만으로 merge하지 않는다. Maintainer가 결정하고, 정책이 바뀌면 [docs/conflicts.md](../conflicts.md)에 Human Decision을 먼저 기록한다(§3a).

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

