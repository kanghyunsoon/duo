# External Validation 01: 모집 문구(한국어)

모집은 2026-10-04T09:37:54Z에 아래 community 게시글의 영어판을 [GitHub Discussion #1](https://github.com/kanghyunsoon/duo/discussions/1)로 게시하면서 시작했고 2026-11-01T09:37:54Z에 끝난다(상태는 [README.md](README.md)). 직접 요청은 아래 짧은 버전을 쓰고 `<이름>`만 사람마다 채운다. 규칙: star 요청, "Codex보다 낫다"나 benchmark 승자 표현, launch campaign·유료 홍보 금지([protocol §23](README.md#23-recruitment-copy)).

## 직접 요청(짧은 버전)

> 안녕하세요 <이름>님. 사람이 확정한 engineering decision을 repository에 두고 coding agent의 변경을 그것과 대조하는 오픈소스 CLI DUO를 만들고 있습니다. 공개한 benchmark 두 개에서 짧은 custom script와, 사람이 쓴 문서를 읽은 Codex가 DUO와 같은 결과를 냈습니다. 그래서 실제로 계속되는 개발에서 DUO가 추가 절차만큼 값을 하는지, 아닌지를 확인하려고 합니다.
>
> 이미 실제 repository에서 coding agent(Codex, Claude Code 등)를 쓰시는 maintainer 세 분께 14일 동안 DUO를 써 보시고, 원래 쓰실 방법과 비교해 솔직하게 알려 주시길 부탁드리고 있습니다. source code나 개인정보는 받지 않고, telemetry가 없으며, 언제든 그만두실 수 있고, 부정적인 의견도 똑같이 유용합니다. 자세한 내용: https://github.com/kanghyunsoon/duo/blob/main/docs/validation/external-validation-01/participant-guide.md#한국어. 관심 있으실까요?

## Community 게시글

**오픈소스 coding-agent 도구의 2주 검증에 참여할 maintainer 3명을 찾습니다(부정적 결과 환영)**

DUO(`@duo-director/cli`, Apache-2.0)는 사람이 확정한 engineering Decision을 repository에 두고, coding agent의 변경을 그 Decision과 대조해 파일·line evidence와 함께 LLM 없이 review합니다.

이 시험을 하는 이유: 공개 benchmark 두 개에서 54~73줄 custom script와, 사람이 쓴 문서를 읽은 Codex가 DUO와 같은 판정을 냈습니다([Benchmark 1](../../benchmarks/decision-compliance-01.md), [Benchmark 2](../../benchmarks/decision-compliance-02.md)). 남은 질문은 DUO의 추가 절차와 Decision 유지 노력이, 원래 쓰실 방법과 비교해 실제 개발에서 값을 하느냐입니다. DUO가 떨어질 수 있게 설계했고 기준은 미리 고정했습니다([protocol](README.md)).

- **모집 기간**: 2026-10-04 → 2026-11-01(이 글 공개일부터 28일). 연장하지 않습니다.
- **참여 기간**: 각자 onboarding을 마친 날부터 14일.
- **필요한 것**: 직접 유지하는 실제 Git repository(공개·비공개 무관)와 앞으로 2주의 실제 변경 계획, 그 repository에서 이미 쓰는 coding agent(Codex, Claude Code, 또는 다른 MCP client). Node.js 24.15 이상.
- **14일 동안**: 실제 engineering 선택을 반영한 확정 Decision 3개 이상, Decision 추가나 supersede 1회 이상, 실제 변경의 review.
- **예상 노력(추정)**: Day 0 약 1시간, 일이 생길 때 몇 분, 마지막에 약 30분.
- **개인정보**: source code, key, 개인정보를 받지 않습니다. telemetry가 없습니다. 동의하지 않으시면 결과는 P1~P3으로만 공개합니다.
- **언제든 그만두실 수 있습니다.** 의견이 긍정적일 필요가 없습니다.
- 참여 불가: DUO 기여자, 설계나 benchmark에 관여한 분.

안내: [participant-guide.md](participant-guide.md#한국어). 지원: [Discussion #1](https://github.com/kanghyunsoon/duo/discussions/1).

## Eligibility 확인 질문(Day 0 전에)

1. 어떤 repository를 쓰시겠습니까(이름 대신 설명해도 됩니다)? 얼마나 됐고 대략 몇 명이 작업합니까?
2. 그곳에서 maintainer 권한이나 개발 책임이 있고, DUO가 추가하는 파일을 commit할 수 있습니까?
3. 앞으로 14일 동안 실제 변경을 하실 예정입니까?
4. 그 repository에서 이미 어떤 coding agent를 얼마나 쓰셨습니까?
5. 그 작업에서 중요해질 실제 engineering decision이 떠오르십니까(2주 동안 세 개 이상)?
6. DUO에 기여했거나, 설계·benchmark에 참여했거나, 내부 구조·benchmark 해답을 설명받은 적이 있습니까?
7. Node.js 24.15 이상을 쓸 수 있습니까?

