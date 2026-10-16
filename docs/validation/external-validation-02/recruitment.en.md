# External Validation 02: Recruitment copy (English)

Not published. Posting and contacting start only after a person approves (status in [README.md](README.md)). Rules: no star requests, no "proven" or "faster" claims, no launch campaign or paid promotion, one message per person and no follow-up ([protocol §8](README.md#8-모집-계획실행은-사용자-승인-뒤)).

## Direct request (short)

> Hi <name>, I maintain DUO, an open-source CLI that records engineering decisions a person has confirmed and checks coding-agent changes against them. I don't know yet whether adding it to an existing workflow is worth it. In my own tests a short lint setup caught the same direct violations, and DUO adds setup and upkeep.
>
> I'm looking for developers who already use a coding agent (Codex, Claude Code or similar) to try it on a real repository: a 10–15 minute first-run test, and optionally 7–14 days of real use where you note what helped, what got in the way and how much time it took. Negative results are as useful as positive ones. No source code or personal data is collected, there is no telemetry, and you can stop at any time. Details: <link to the participant guide>. Would you be interested? If not, no reply is needed and I won't follow up.

## Community post

**Looking for developers to test whether an open-source coding-agent check is worth adding to their workflow (negative results welcome)**

DUO (`@duo-director/cli` 0.3.3, Apache-2.0) keeps engineering decisions that a person has confirmed in your repository and reviews coding-agent changes against them, with file and line evidence and without an LLM.

What we don't know: whether this is worth its extra steps. In our internal test on a small fixture, a standard ESLint setup plus a short dependency check blocked the same direct violations; DUO added one case (a `require` the lint rule did not cover) and one false alarm. Earlier benchmarks found that a short custom script matched DUO on fixed rules. This study asks real developers to find out.

- **Stage 1 (10–15 minutes)**: install, connect your agent, run a first review on a real change, and note where you got stuck.
- **Stage 2 (optional, 7–14 days)**: use it on real work; note each time it helped, got in the way or cost time; a 20–30 minute interview at the end.
- **You need**: a Git repository you maintain, a coding agent you already use there, Node.js 24.15+.
- **Privacy**: no source code, keys or personal data; no telemetry; results are published as S1, L1… only.
- **You can stop at any time.** There is no reward; we publish how much time participants spent.
- Not eligible: past DUO contributors or anyone involved in its design or tests.

Criteria for "worth it" are fixed in advance: [protocol](README.md). Apply: <Discussion link>.
