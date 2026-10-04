# External Validation 01: Recruitment copy (English)

Prepared in T33; nothing has been sent or posted. Fill the placeholders at launch (T33.1): `<YYYY-MM-DD>` dates from `recruitment_opened_at` and `recruitment_deadline` in [README.md](README.md), `<contact>` = the application channel chosen at launch. Rules: no star requests, no "better than Codex" or benchmark-winner wording, no launch campaign or paid promotion ([protocol §23](README.md#23-recruitment-copy)).

## Direct request (short)

> Hi <name>, I maintain DUO, an open-source CLI that keeps human-confirmed engineering decisions in a repository and checks coding-agent changes against them. In my two public benchmarks, a short custom script and Codex reading hand-written docs reached the same results as DUO, so I want to find out whether DUO is worth its extra steps in real, ongoing work, or not.
>
> I am looking for 3 maintainers who already use a coding agent (Codex, Claude Code or similar) on a real repository to use DUO for 14 days and tell me honestly how it compared with what they would do otherwise. No source code or personal data is collected, there is no telemetry, you can stop at any time, and negative feedback is just as useful. Details: <link to participant-guide.md>. Would you be interested?

## Community post

**Looking for 3 maintainers for a 2-week validation of an open-source coding-agent tool (negative results welcome)**

DUO (`@duo-director/cli`, Apache-2.0) keeps engineering Decisions that a person has confirmed in your repository and reviews coding-agent changes against them, with file and line evidence and without an LLM.

Why this test: in two public benchmarks, a 54–73-line custom script and Codex reading hand-written docs reached the same decisions as DUO ([Benchmark 1](../../benchmarks/decision-compliance-01.md), [Benchmark 2](../../benchmarks/decision-compliance-02.md)). The open question is whether DUO's extra ceremony and the work of keeping its Decisions current pay off in real development, compared with what you would do anyway. This study is set up so that DUO can fail it; the criteria are fixed in advance ([protocol](README.md)).

- **Recruitment**: <YYYY-MM-DD> → <YYYY-MM-DD> (28 days from this post). No extension.
- **Participant study**: 14 days from your own onboarding.
- **You need**: a real Git repository you maintain (public or private) with real changes planned in the next two weeks, and a coding agent you already use there (Codex, Claude Code or another MCP client). Node.js 24.15+.
- **During the 14 days**: at least 3 confirmed Decisions that reflect real engineering choices, at least one Decision added or superseded, reviews of real changes.
- **Effort (estimate)**: about an hour on day 0, a few minutes when something happens, about 30 minutes at the end.
- **Privacy**: no source code, keys or personal data are collected; no telemetry; results are published as P1–P3 unless you agree otherwise.
- **You can stop at any time.** Your feedback does not need to be positive.
- Not eligible: past DUO contributors or anyone involved in its design or benchmarks.

Guide: [participant-guide.md](participant-guide.md). Apply: <contact>.

## Eligibility questions (asked before Day 0)

1. Which repository would you use (you may describe it instead of naming it), how long has it existed, and roughly how many people work on it?
2. Do you have maintainer rights or development responsibility there, and can you commit files DUO adds?
3. Will you make real changes in it during the next 14 days?
4. Which coding agent(s) do you already use in it, and for how long?
5. Can you think of real engineering decisions that will matter in that work (at least three over two weeks)?
6. Have you contributed to DUO, taken part in its design or benchmarks, or been walked through its internals or benchmark answers?
7. Do you have Node.js 24.15 or later available?

