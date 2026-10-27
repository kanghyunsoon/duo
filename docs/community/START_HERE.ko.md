# DUO 첫 기여 안내

DUO는 사람이 확정한 엔지니어링 Decision과 실제 코드 변경을 대조하는 로컬 CLI·MCP 서버입니다. 코드를 생성하지 않으며, 보안 sandbox나 인증된 팀 권한 시스템도 아닙니다.

모든 패키지를 이해하지 않아도 기여할 수 있습니다. 문서, 재현 가능한 버그 보고, 테스트, 작은 UX 개선 모두 도움이 됩니다. 이 문서는 쓰기 권한 없이 fork에서 작업하는 외부 기여자를 위한 안내입니다.

## 1. 작업 고르기

1. [CONTRIBUTING.md](../../CONTRIBUTING.md)를 읽고 [열린 이슈](https://github.com/kanghyunsoon/duo/issues)를 봅니다. [`good first issue`](https://github.com/kanghyunsoon/duo/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)는 작고 따로 리뷰할 수 있는 작업입니다. [`help wanted`](https://github.com/kanghyunsoon/duo/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22)는 누구나 맡을 수 있지만 맥락이 더 필요할 수 있습니다.
2. 무엇을 바꿀지 이슈에 댓글로 남겨 주세요. 같은 작업이 겹치지 않게 maintainer가 답하고 배정합니다.
3. 맞는 이슈가 없으면 [Discussions](https://github.com/kanghyunsoon/duo/discussions)에 제안해 주세요.

## 2. Fork 준비

Git, Node.js 24.15 이상, pnpm 11이 필요합니다.

```bash
# 먼저 GitHub에서 kanghyunsoon/duo를 fork한 다음:
git clone https://github.com/YOUR-GITHUB-USERNAME/duo.git
cd duo
git remote add upstream https://github.com/kanghyunsoon/duo.git
git fetch upstream next
git switch -c docs/my-first-fix upstream/next
pnpm install
```

작업 branch는 `next`에서 만듭니다. `main`은 release만 받습니다.

## 3. 변경 확인

- 문서만 바꾼 경우: `pnpm docs:validate`
- 코드를 바꾼 경우: 바꾼 코드 옆의 테스트(`pnpm exec vitest run <테스트 경로>`), 그다음 `pnpm verify`

CI는 Windows, Ubuntu, macOS에서 돕니다. Windows job이 가장 느립니다([#37](https://github.com/kanghyunsoon/duo/issues/37)).

| 영역 | 코드 | 처음 하기 좋은 기여 |
|---|---|---|
| CLI | `apps/cli/` | 실제 출력을 담은 도움말·문서 개선 |
| Decision, Project Truth | `packages/core/` | 기존 동작 테스트. Decision 확정 권한을 바꾸려면 먼저 논의 |
| Analyzer, graph | `packages/analyzer/`, `packages/graph/` | 버그를 재현하는 fixture |
| Review, context | `packages/director/` | 오탐·미탐 재현 |
| MCP, agent 설정 | `packages/integration/` | 설정·문제 해결 문서 |
| 로컬 UI | `packages/ui/` | 접근성을 확인한 작은 화면 상태 |

## 4. Pull request 열기

```bash
git push origin docs/my-first-fix
```

fork에서 **`kanghyunsoon/duo`의 `next`** 로 pull request를 엽니다. 템플릿에 연결 이슈, 바꾼 내용, 테스트 방법, 사용자에게 보이는 변화를 적어 주세요.

- 한 PR에는 한 문제만 담습니다.
- 작성자가 아닌 리뷰어가 승인하고 세 OS의 CI가 통과하면 maintainer가 병합합니다. 수정 요청은 같은 branch에 push하면 됩니다.
- Agent는 Decision을 제안만 하고 확정은 사람이 합니다. PASS를 얻으려고 Decision이나 테스트 기대값을 약하게 바꾸지 마세요.
- 자격 증명, 토큰, 비공개 프로젝트 파일은 올리지 마세요. 보안 취약점은 [SECURITY.md](../../SECURITY.md)대로 비공개로 알려 주세요.

## 함께 일하는 방식

- 작업을 시작하기 전에 이슈에 무엇을 바꿀지 댓글로 남기고, maintainer가 배정할 때까지 기다려 주세요. 두 사람이 같은 일을 하지 않도록 하기 위해서입니다.
- 질문은 한국어나 영어 모두 괜찮습니다. 이슈와 PR의 제목·설명, 코드 주석은 영어로 써 주세요. 완벽한 영어가 아니어도 됩니다.
- AI 코딩 도구를 써도 됩니다. 제출한 변경은 직접 이해하고, 검사를 직접 돌리고, 리뷰 질문에 답할 수 있어야 합니다. PR 템플릿의 AI assistance 줄을 채워 주세요.
- 팀 밖 기여자의 CI는 maintainer가 변경을 읽고 실행을 승인한 뒤 시작하며, 새로 push할 때마다 다시 승인합니다. 수정 요청(Changes requested)은 정상적인 과정이니 같은 branch에 고쳐서 push하면 됩니다.
- 민감한 파일을 바꾸는 PR은 더 엄격하게 리뷰합니다. 예를 들어 workflow, `package.json`, lockfile, `scripts/`, CLI, agent·MCP 연동이며 전체 목록은 CONTRIBUTING에 있습니다. 왜 필요한 변경인지 설명해 주세요.
- 일주일이 지나도 답이 없으면 같은 이슈나 PR에 댓글을 한 번 남겨 주세요. 중복 이슈는 만들지 마세요.
- 병합은 보장되지 않습니다. release를 준비하는 동안에는 승인된 PR도 출시 뒤로 미뤄질 수 있습니다.
- 병합된 기여는 공개 GitHub 기록이라 포트폴리오에 쓸 수 있습니다. Star는 기여 조건이 아닙니다.

자세한 정책은 [CONTRIBUTING.md](../../CONTRIBUTING.md#how-we-work-with-contributors)에 있습니다.

## 먼저 써 보기

[0.3.3 walkthrough](../examples/decision-review-0.3.3.md)에 실제 금지 import BLOCK과 수정 뒤 PASS가 있고, 어느 단계를 사람이 해야 하는지도 적혀 있습니다(영어).

DUO가 도움이 되지 않았다는 보고도 성공 사례만큼 쓸모 있습니다. 들인 시간, 헷갈린 단계, 오류, 놓친 사례, 오탐을 비공개 코드 없는 재현과 함께 알려 주세요.

[English](START_HERE.md)

