# External Validation 01: Participant Guide

[English](#english) · [한국어](#한국어)

## English

Thank you for considering this. You are helping test whether DUO is worth keeping in a real repository. A negative answer is as useful as a positive one. The full protocol (criteria fixed in advance) is in [README.md](README.md).

### What DUO is

DUO keeps engineering Decisions that a person has confirmed in your repository (`.duo-project/`) and reviews changes made by coding agents against them, with file and line evidence and without an LLM. It is open source (Apache-2.0) and published as `@duo-director/cli` on npm.

### Why we are asking

In two public benchmarks, a 54–73-line custom script and Codex reading hand-written docs reached the same decisions as DUO ([Benchmark 1](../../benchmarks/decision-compliance-01.md), [Benchmark 2](../../benchmarks/decision-compliance-02.md)). What remains open is whether DUO's extra steps and the work of keeping its Decisions up to date pay off in real, ongoing development compared with what you would do anyway. Only real use can answer that.

### Who can take part

- You maintain or are responsible for development of a real Git repository (public or private), not one made for this test, and you will make real changes in it during the next two weeks.
- You already use at least one coding agent (Codex, Claude Code or another agent that uses MCP) in that repository. DUO sets up and checks Codex and Claude Code; you do not need both.
- You can commit the files DUO adds (`.duo-project/` and the agent configuration).
- You have not contributed to DUO, designed it, or worked on its benchmarks.
- Your work in the next two weeks will plausibly involve at least three real engineering decisions (for example "no direct database access from the UI layer", "do not add dependency X", "new code uses module Y"). Please do not invent decisions for the test.

### What you will do

1. **Before installing**: write down how you would handle this without DUO (your *alternative*: `AGENTS.md`/`CLAUDE.md`, ADRs or docs, a linter, a CI script, PR review, agent memory, nothing, anything else). Use Part A of [day-0.md](day-0.md) and send it privately before your first DUO command; it is not edited afterwards.
2. **Install on your own** from the public README: `npm install -g @duo-director/cli`, then in your repository `duoctl init`, `duoctl install codex` or `duoctl install claude-code`, `duoctl doctor`. Requires Node.js 24.15 or later. If you get stuck, ask; every bit of help is recorded so that "worked without help" is not overstated.
3. **Use it for 14 consecutive days** starting the day after `duoctl init` first succeeds, in your normal work, counted in the time zone you give on day 0. Before day 1, `duoctl --version` and the DUO your agent starts must both be 0.2.1. During days 1–14 (Decisions made during setup do not count): at least three confirmed Decisions that reflect real choices, at least one Decision added or superseded, reviews of real changes, and a look at the state of `.duo-project/` at the end. Details: [protocol §27](README.md#27-pre-participant-clarifications-h-69).
4. **Note events when they happen** in [event-log.md](event-log.md) (no daily diary): Decisions proposed, confirmed, rejected or superseded, reviews, findings you acted on, findings that were noise, knowledge gaps, context use, switching agents, time spent maintaining Decisions, skipping DUO, using your alternative instead, stopping.
5. **Answer the exit questions** in [exit-interview.md](exit-interview.md) after day 14, within 7 days of being asked, including a direct comparison with the alternative you wrote down on day 0.

Expected effort (estimate, not a promise): about an hour on day 0, a few minutes per noted event, about 30 minutes for the exit questions.

### What counts

- **Useful finding**: something DUO showed (a review claim, a knowledge gap, evidence) made you fix code, revise or re-confirm a Decision, stop a change, investigate a problem, or write down missing intent. "Sounds right" does not count.
- **Noise**: a finding, WARN or gap that had no action value for your task. Your judgment is recorded as is.

### Your data

- No telemetry. DUO sends nothing anywhere because of this test; with the default configuration it makes no network calls.
- We never ask for source code, API keys, tokens, credentials, personal email, customer data or full proprietary requirements. You may anonymize the repository name, summarize Decisions and redact paths. If something cannot be checked after redaction, it is recorded as unverifiable.
- Reports are Markdown files you fill in and send privately. Published results use P1, P2, P3. Your name or GitHub ID is published only if you explicitly agree.

### Your rights

- You may stop at any time; please tell us why if you can. Stopping is a result, not a failure.
- Your feedback does not have to be positive.
- During the test DUO stays at version 0.2.1. Security or correctness fixes may be released; feature requests are recorded but not built during the test.

## 한국어

검토해 주셔서 감사합니다. 이 시험은 실제 repository에서 DUO를 계속 쓸 가치가 있는지 확인합니다. 부정적인 결과도 긍정적인 결과만큼 유용합니다. 미리 고정한 기준을 포함한 전체 protocol은 [README.md](README.md)에 있습니다.

### DUO란

사람이 확정한 engineering Decision을 repository(`.duo-project/`)에 두고, coding agent의 변경을 그 Decision과 대조해 파일·line evidence와 함께 LLM 없이 review하는 도구입니다. 오픈소스(Apache-2.0)이며 npm `@duo-director/cli`로 배포됩니다.

### 왜 요청하는가

공개 benchmark 두 개에서 54~73줄 custom script와, 사람이 쓴 문서를 읽은 Codex가 DUO와 같은 판정을 냈습니다([Benchmark 1](../../benchmarks/decision-compliance-01.md), [Benchmark 2](../../benchmarks/decision-compliance-02.md)). 남은 질문은 DUO의 추가 절차와 Decision 유지 노력이, 원래 쓰실 방법과 비교해 실제 개발에서 값을 하느냐입니다. 이것은 실제 사용으로만 답할 수 있습니다.

### 참여 조건

- 이 시험을 위해 만든 것이 아닌 실제 Git repository(공개·비공개 무관)를 유지하거나 개발 책임이 있고, 앞으로 2주 동안 실제 변경을 할 예정입니다.
- 그 repository에서 이미 coding agent를 하나 이상 씁니다(Codex, Claude Code, 또는 MCP를 쓰는 다른 agent). DUO가 설정·검증하는 것은 Codex와 Claude Code이며 둘 다 쓸 필요는 없습니다.
- DUO가 추가하는 파일(`.duo-project/`, agent 설정)을 commit할 수 있습니다.
- DUO에 기여하거나 설계하거나 benchmark 작업에 참여한 적이 없습니다.
- 2주 동안 실제 engineering decision이 적어도 세 개 생길 만한 작업입니다(예: "UI 계층에서 DB 직접 접근 금지", "dependency X 추가 금지", "새 코드는 module Y 사용"). 시험을 위해 결정을 지어내지 말아 주세요.

### 하실 일

1. **설치 전에**: DUO가 없다면 이 문제를 어떻게 다룰지 적습니다(대안: `AGENTS.md`/`CLAUDE.md`, ADR·문서, linter, CI script, PR review, agent memory, 아무것도 안 함, 기타). [day-0.md](day-0.md)의 Part A를 쓰고, 첫 DUO command 전에 비공개로 보내 주세요. 보낸 뒤에는 고치지 않습니다.
2. **직접 설치**: 공개 README대로 `npm install -g @duo-director/cli`, repository에서 `duoctl init`, `duoctl install codex` 또는 `duoctl install claude-code`, `duoctl doctor`. Node.js 24.15 이상이 필요합니다. 막히면 물어보세요. 모든 도움은 기록되어 "도움 없이 썼다"가 과장되지 않게 합니다.
3. **14일 연속 사용**: `duoctl init`이 처음 성공한 다음 날부터 평소 작업에서 씁니다. 날짜는 Day 0에 적은 time zone으로 셉니다. Day 1 전에 `duoctl --version`과 agent가 실행하는 DUO가 모두 0.2.1이어야 합니다. Day 1~14 동안(설정 중 만든 Decision은 세지 않습니다) 실제 선택을 반영한 확정 Decision 세 개 이상, Decision 추가나 supersede 한 번 이상, 실제 변경의 review, 마지막 날 `.duo-project/` 상태 확인이 필요합니다. 자세한 규칙: [protocol §27](README.md#27-pre-participant-clarifications-h-69).
4. **일이 생길 때만 기록**([event-log.md](event-log.md), 매일 쓰지 않아도 됩니다): Decision 제안·확정·거절·supersede, review, 행동으로 이어진 finding, noise였던 finding, knowledge gap, context 사용, agent 전환, Decision 유지에 쓴 시간, DUO를 건너뜀, 대안을 대신 씀, 중단.
5. **14일 뒤 종료 질문**([exit-interview.md](exit-interview.md))에 요청받은 뒤 7일 안에 답합니다. Day 0에 적은 대안과 직접 비교하는 질문이 있습니다.

예상 노력(추정이며 약속이 아닙니다): Day 0 약 1시간, 기록할 일마다 몇 분, 종료 질문 약 30분.

### 무엇을 세는가

- **Useful finding**: DUO가 보여 준 것(review claim, knowledge gap, evidence) 때문에 실제로 code를 고쳤거나, Decision을 수정·재확인했거나, 변경을 멈췄거나, 문제를 조사했거나, 빠진 의도를 적은 경우. "맞는 말 같다"는 포함하지 않습니다.
- **Noise**: 지금 작업에서 행동할 가치가 없었던 finding, WARN, gap. 판단은 참여자의 것을 그대로 기록합니다.

### 데이터

- telemetry가 없습니다. 이 시험 때문에 DUO가 어디로도 데이터를 보내지 않으며, 기본 설정에서는 network 호출을 하지 않습니다.
- source code, API key, token, credential, 개인 email, 고객 데이터, proprietary requirement 전문을 요청하지 않습니다. repository 이름 익명화, Decision 요약, 경로 가림을 하셔도 됩니다. 가린 뒤 확인할 수 없는 항목은 확인 불가로 기록합니다.
- report는 직접 채운 Markdown 파일을 개인적으로 보내 주시면 됩니다. 공개 결과에는 P1, P2, P3만 씁니다. 이름이나 GitHub ID는 명시적으로 동의하신 경우에만 공개합니다.

### 참여자의 권리

- 언제든 그만두실 수 있습니다. 가능하면 이유를 알려 주세요. 그만두는 것도 결과입니다.
- 의견이 긍정적일 필요가 없습니다.
- 시험 동안 DUO는 0.2.1로 유지됩니다. security·correctness 수정은 나올 수 있지만 기능 요청은 기록만 하고 기간 중 만들지 않습니다.

