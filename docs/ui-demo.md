# UI mock demo

Build the UI with `node packages/ui/build.mjs`, then run `node scripts/ui-demo.mjs`.
Open the localhost address printed by the server. Optional: set `DUO_DEMO_PORT` to choose the port.

All seven navigation screens and entity/review details have mock API data. Direction includes requirements, milestones, constraints and every decision state. Proposals include pending, committed and rejected states. Review history shows PASS, WARN, BLOCK and ASK.

Session files includes a collapsed, recorded provided-context section. Analysis coverage is a collapsed Overview detail. In Review, run the review to show claims, provenance, evidence and semantic assistance. Search for `로그인`, `REQ` or `session`. Work map supports selection, expansion, task creation and completion. Proposal confirmation and rejection update only the running demo's memory.

The persistent MOCK DEMO badge distinguishes this server from a real project. No external AI calls are made. Restart the server to reset all simulated changes.
