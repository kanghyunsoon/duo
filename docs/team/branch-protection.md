# Branch 보호 설정(T83 제안, T84 검증)

`main`과 `next`에는 보호 규칙이 없었다. write 권한을 가진 팀원 누구나 두 branch에 직접 push하거나 force push할 수 있고, `v*` tag도 만들 수 있었다. 이 문서는 GitHub repository ruleset 다섯 개를 정의한다. 2026-10-16(T84)에 적용했다(§7). 현재 상태는 GitHub Settings → Rules에서 확인한다.

## 1. 원칙

- `main`: stable release 기준선. maintainer가 release gate를 통과한 commit으로 fast-forward할 때만 움직인다. PR merge를 받지 않는다.
- `next`: 개발 통합. 모든 변경은 PR로 들어오고, 작성자가 아닌 1명 이상의 승인과 CI `verify` 3 OS 통과가 필요하다. 일반 PR은 squash merge만 쓴다.
- `v*` tag: maintainer만 만든다. 한 번 만든 tag는 누구도 옮기거나 지우지 못한다.
- force push와 branch 삭제는 maintainer를 포함해 누구도 하지 못한다.
- 기존 release 절차(`next` → `main` fast-forward, release 기록 commit, annotated tag push)는 maintainer의 admin bypass로 그대로 동작한다.
- merge 뒤 branch 자동 삭제는 끈 채로 둔다(`delete_branch_on_merge: false`). 저장소 merge 방식 설정은 바꾸지 않고, `next`의 ruleset이 squash만 허용한다.

## 2. 왜 다섯 개인가

bypass actor는 ruleset 단위로 지정되고, `bypass_mode: always`는 그 ruleset의 모든 규칙을 우회한다. 갱신 제한과 force push·삭제 금지를 한 ruleset에 두면 maintainer는 force push와 삭제도 할 수 있게 된다. 그래서 bypass가 필요한 규칙(갱신 제한, PR·check, tag 생성)과 bypass가 없어야 하는 규칙(force push·삭제, tag 이동·삭제)을 나눴다. Ruleset 하나는 branch나 tag 중 하나만 대상으로 할 수 있다.

| Ruleset | 대상 | 규칙 | Bypass |
|---|---|---|---|
| `next-integration` | `refs/heads/next` | PR(승인 1, stale 승인 해제, 마지막 push는 다른 사람이 승인, 대화 해결, squash만), 3 OS check | admin |
| `main-stable` | `refs/heads/main` | 갱신 제한(`update`) | admin |
| `branches-immutable` | `main`, `next` | 삭제 금지, force push 금지 | 없음 |
| `release-tags-create` | `refs/tags/v*` | 생성 제한 | admin |
| `release-tags-immutable` | `refs/tags/v*` | 이동(`update`)·삭제 금지 | 없음 |

Admin은 Repository admin 역할(`actor_type: RepositoryRole`, `actor_id: 5`)이다. 지금 admin은 owner 한 명뿐이다.

## 3. 사전 검증(T84)

같은 구조의 ruleset 네 개를 임시 branch `t84-probe/main`과 tag `t84probe-v*`에 걸고 admin 계정으로 확인한 뒤, ruleset·branch·tag를 모두 지웠다.

| 시도(admin) | 결과 |
|---|---|
| 새 branch 생성 | 통과 |
| fast-forward push(갱신 제한·PR·check 규칙 있음) | bypass로 통과, `Bypassed rule violations` 표시 |
| force push | 거부(GH013) |
| branch 삭제 | 거부(GH013) |
| tag 생성 | bypass로 통과 |
| tag 이동(force push) | 거부(GH013) |
| tag 삭제 | 거부(GH013) |

GitHub rule insights(`rulesets/rule-suites`)에 각 시도가 `pass`·`bypass`·`fail`과 실행자로 남았다. API는 `allowed_merge_methods`를 받아들였다. write 권한 계정으로 막히는지는 직접 확인하지 못했다. bypass actor가 아니므로 규칙대로 막혀야 하며, 적용 뒤 첫 팀원 push로 확인한다.

## 4. 기존 release 절차와의 대조

| 절차 | 규칙 적용 뒤 |
|---|---|
| 팀원 PR → `next` squash merge | 작성자 아닌 승인 1 + 3 OS check 통과 뒤 가능 |
| 팀원이 `next`·`main`에 직접 push | 막힘 |
| 누구든 force push, `main`·`next` 삭제 | 막힘(maintainer 포함) |
| version commit PR(`release/0.x.y` → `next`) | 팀원 승인을 받아 merge. 급할 때 maintainer bypass merge도 가능하지만 기록을 남긴다 |
| maintainer의 release 기록 commit을 `next`에 직접 push | admin bypass로 가능 |
| `next` → `main` fast-forward(`git push origin <sha>:main`) | admin bypass로 가능 |
| `main` → `next` fast-forward | admin bypass로 가능 |
| annotated `v*` tag 생성·push | maintainer만 가능 |
| 이미 만든 `v*` tag 이동·삭제 | 막힘(maintainer 포함). 꼭 필요하면 ruleset을 잠시 끄고 이유를 기록한다 |
| npm publish, GitHub Release 생성, release 스크립트 | ruleset과 무관(스크립트는 Git을 읽기만 한다) |
| GitLab mirror(`ssafy` remote) push | GitHub ruleset과 무관 |

## 5. 운영 규칙과 남은 위험

- maintainer 자신의 기능·문서 PR도 팀원 review를 받는다. bypass는 release 기록, branch 동기화, 긴급 복구에만 쓰고, 쓴 경우 관련 Issue나 PR에 남긴다.
- `strict_required_status_checks_policy: false`: merge 전에 branch를 최신 `next`로 맞추라고 요구하지 않는다. Windows job이 30~60분이라 strict로 두면 merge마다 CI를 다시 기다려야 한다. 따로는 통과했지만 합쳐서 깨지는 경우는 merge 뒤 `next` push CI에서 잡고, 고치는 PR을 우선한다.
- #37(Windows 로컬 tarball 설치 시간)이 재발하면 required check 때문에 문서 PR도 막힌다. 그 테스트 하나만 시간 초과로 실패하면 로그를 확인하고 재실행한다.
- code owner review는 켜지 않는다. 지금 code owner가 maintainer 한 명뿐이라 maintainer의 Decision·release 경로 PR을 승인할 사람이 없다. 팀원 역할이 정해지면 영역별 공동 owner와 함께 검토한다.

## 6. Ruleset 정의

```json
{ "name": "next-integration", "target": "branch", "enforcement": "active",
  "bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }],
  "conditions": { "ref_name": { "include": ["refs/heads/next"], "exclude": [] } },
  "rules": [
    { "type": "pull_request", "parameters": { "required_approving_review_count": 1, "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false, "require_last_push_approval": true, "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash"] } },
    { "type": "required_status_checks", "parameters": { "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "verify (ubuntu-latest, node 24)", "integration_id": 15368 },
          { "context": "verify (windows-latest, node 24)", "integration_id": 15368 },
          { "context": "verify (macos-latest, node 24)", "integration_id": 15368 } ] } } ] }
```

```json
{ "name": "main-stable", "target": "branch", "enforcement": "active",
  "bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }],
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [{ "type": "update" }] }
```

```json
{ "name": "branches-immutable", "target": "branch", "enforcement": "active", "bypass_actors": [],
  "conditions": { "ref_name": { "include": ["refs/heads/main", "refs/heads/next"], "exclude": [] } },
  "rules": [{ "type": "deletion" }, { "type": "non_fast_forward" }] }
```

```json
{ "name": "release-tags-create", "target": "tag", "enforcement": "active",
  "bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }],
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "rules": [{ "type": "creation" }] }
```

```json
{ "name": "release-tags-immutable", "target": "tag", "enforcement": "active", "bypass_actors": [],
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "rules": [{ "type": "update" }, { "type": "deletion" }] }
```

적용: `gh api -X POST repos/kanghyunsoon/duo/rulesets --input <file>.json`. 해제: `gh api -X DELETE repos/kanghyunsoon/duo/rulesets/<id>`.

## 7. 적용 기록

2026-10-16(T84), #37 Windows 5회 연속 통과를 확인한 뒤 위 정의 그대로 적용했다.

| Ruleset | ID |
|---|---|
| `next-integration` | 25224696 |
| `main-stable` | 25224698 |
| `branches-immutable` | 25224700 |
| `release-tags-create` | 25224701 |
| `release-tags-immutable` | 25224702 |

적용 직후 `rules/branches/next`는 `pull_request`·`required_status_checks`·`deletion`·`non_fast_forward`, `rules/branches/main`은 `update`·`deletion`·`non_fast_forward`를 보고했다. 열린 PR(#24, #36, #38)은 `REVIEW_REQUIRED`로 막혔다. `main`·`next`·`v*` tag는 바뀌지 않았고, 저장소 merge 방식과 `delete_branch_on_merge: false`도 그대로다.

