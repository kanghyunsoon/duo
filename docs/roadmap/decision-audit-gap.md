# Decision 감사 이력 Gap 분석(#26, T87)

[Issue #26](https://github.com/kanghyunsoon/duo/issues/26)의 범위대로 공개 `@duo-director/cli@0.3.3`을 임시 저장소에 설치해 propose → preview → confirm → reject → supersede → lock 검사 → 중단된 confirm 복구를 실제로 돌리고, 단계마다 남는 파일과 필드를 기록했다. 제품 코드와 실제 사용자 Decision은 바꾸지 않았다. 권한 설계는 [decision-rbac-design.md](decision-rbac-design.md)에 있다.

## 1. 결론

여러 사람이 쓰는 팀에서 "누가, 무엇을 보고, 왜 승인했는가"는 지금 DUO 파일만으로 답할 수 없다. 시각과 승인된 내용은 남지만, 승인자 이름은 Git `user.name`에서 온 표시값이라 다른 사람이 바꿀 수 있다. 승인 사유, 승인자가 본 preview digest, 제안 뒤 내용을 누가 고쳤는지, 중단된 confirm의 복구 이력은 기록되지 않는다. 또 lock 없이 직접 쓴 Decision 파일이 확정 Decision으로 인정되므로, 파일 기록만으로는 그 Decision이 DUO 생명주기를 거쳤는지도 확신할 수 없다.

## 2. 재현 환경

- 패키지: npm `@duo-director/cli@0.3.3`(프로젝트 로컬 설치, 전역 변경 없음), Node v24.18.0, Windows 11, 2026-10-19
- 저장소: 새 Git 저장소(`src/api/users.ts`, `README.md`), `duoctl init --yes --non-interactive`
- 표면: 제안은 MCP stdio(`duoctl mcp --agent <label>`, `duo_propose_decision`), 확정·거절은 로컬 UI API(세션 쿠키, CSRF, `previewDigest`)와 PTY의 CLI
- 각 단계 뒤에 사람이 하듯 `git commit`을 했다. DUO 자체는 commit하지 않는다.
- 스크립트와 명령은 [부록](#부록-재현-스크립트)에 있다.

## 3. 단계별 관찰

| 단계 | 한 일 | 결과 | 남은 기록 |
|---|---|---|---|
| S1 | MCP로 P-001 제안(agent label `codex-agent`) | `P-001.yaml` 생성 | `proposed_by: codex-agent`, `proposed_by_kind: agent`, `proposed_at`, `based_on.truth_digest` |
| S2 | preview를 본 뒤 P-001의 answer를 손으로 `GraphQL`로 바꾸고, 옛 digest로 UI confirm | `DECISION_CONFIRM_PREVIEW_CHANGED`, 아무것도 쓰지 않음 | 실패는 `runtime/metrics.jsonl`에 `{"surface":"ui","command":"decision","status":"failed"}`만 남음(ID·actor 없음, gitignored) |
| S2 | 새 digest로 다시 confirm | D-001 생성, P-001 삭제 | `D-001.yaml`: `proposal: P-001`, `proposed_by: codex-agent`(내용은 사람이 고친 것), `confirmed_by: ui:Alice Maintainer`, `confirmed_at`, `lock.digest`. `based_on`, 본 digest, 승인 사유는 없음 |
| S3 | MCP로 P-002 제안, UI에서 사유와 함께 reject | P-002 파일 유지 | `state: rejected`, `rejected_at`, `rejected_by: ui:Alice Maintainer`, `reason: Too early; one service only` |
| S4 | MCP로 P-003 제안(`supersedes: D-001`, label `claude-agent`), TTY 없는 CLI confirm | `duoctl decision needs an interactive terminal (a guard against unattended runs, not an authentication).` | 없음 |
| S4 | 셸 도구가 PTY를 열어 CLI confirm 실행, ID 입력 | D-002 생성, D-001은 `state: superseded`, `superseded_by: D-002` | `D-002.yaml`: `supersedes: D-001`, `confirmed_by: Alice Maintainer`(CLI는 `ui:` 같은 표시 없음). D-001에는 언제 누가 대체했는지 없음 |
| S5 | D-002의 answer를 손으로 수정 | status·doctor 모두 `DECISION_INTEGRITY_INVALID`(doctor 종료 코드 6), 되돌리면 사라짐 | 변조는 감지되지만 누가 언제 바꿨는지는 Git에만 있음 |
| S6 | P-004 확정(D-003) 뒤 P-004 파일을 되살려 "정리 전 중단"을 흉내 | `decision list`는 P-004를 대기로 보지 않음(read model이 committed로 판단) | 다음 조작(MCP propose P-005)이 P-004를 조용히 삭제. MCP 응답에 `repaired`가 없고, 파일 어디에도 복구 기록이 없음 |
| S7a | MCP agent label을 `Alice Maintainer`로 제안 | P-006 생성 | `proposed_by: Alice Maintainer`, `proposed_by_kind: agent`. preview에도 `(agent)`로 보임 |
| S7b | `git config user.name Mallory` 뒤 UI로 P-006 confirm, commit | D-004 생성 | `confirmed_by: ui:Mallory`, Git commit 작성자도 `Mallory`. 이름은 누구나 설정할 수 있음 |
| S7c | 파일 쓰기 권한으로 `D-005.yaml`(state confirmed, lock·proposal 없음, `confirmed_by: Alice Maintainer`)을 직접 작성 | status 오류 0건, Decision 5개로 집계 | ADR-013 수동 fallback이라 확정 Decision으로 인정됨 |
| S7d | `proposed_by_kind: human`이라고 적은 proposal 파일을 직접 작성 | UI preview가 `Alice Maintainer (human)`으로 표시 | kind도 파일이 주장하는 값 |

S2·S4·S7b는 이 문서 작성자(Codex 세션의 에이전트)가 직접 셸로 수행했다. "사람만 확정한다"는 규칙은 서비스 수준에서는 지켜지지만, 사람용 표면(PTY의 CLI, 로컬 UI API)은 같은 OS 사용자로 도는 에이전트가 조작할 수 있다는 뜻이다.

## 4. 기록되는 필드

| 항목 | 기록 여부 | 위치 | 쓰는 코드 | 메모 |
|---|---|---|---|---|
| Decision ID | 있음 | `D-###.yaml` `id` | `service.ts` `createWithNewId` | lock 안에서 할당, 독점 생성 |
| Proposal ID | 있음 | proposal `id`, Decision `proposal` | 같음 | 확정 뒤 proposal 파일은 삭제되고 `proposal` 필드만 남음 |
| 제안자 | 표시값 | `proposed_by` | `propose` | MCP 인자 또는 `--agent`. 인증 아님 |
| 제안자 종류 | 표시값 | `proposed_by_kind` | `propose` | 서비스는 호출 표면에 따라 쓰지만 파일을 직접 쓰면 무엇이든 가능 |
| 승인자 | 표시값 | `confirmed_by` | `confirmProposal`, `confirmDecision` | CLI: Git `user.name`, UI: `ui:` + Git `user.name` |
| 승인자 종류 | 없음 | 없음(`owner: human` 고정) | | actor kind는 저장하지 않음 |
| 승인 표면 | 일부 | `ui:` 접두사, metrics `surface` | | CLI 확정은 표시 없음 |
| 거절자 | 표시값 | `rejected_by` | `reject` | |
| 시각 | 있음 | `proposed_at`, `confirmed_at`, `rejected_at` | 서비스 clock | 로컬 시계. 대체 시각(`superseded_at`)은 없음 |
| 변경 사유 | 일부 | `rationale`(선택) | | 제안 사유일 뿐 |
| 승인 사유 | 없음 | | | confirm에는 사유 입력이 없음 |
| 거절 사유 | 있음(선택) | `reason` | `reject` | |
| 변경 전후 내용 | 일부 | 대체된 Decision과 새 Decision 파일이 모두 남음 | | 제안 뒤 사람의 수정은 남지 않음(S2) |
| Candidate digest | 없음 | | `candidateDigest`는 비교에만 쓰고 저장하지 않음 | 승인자가 본 것을 나중에 증명할 수 없음 |
| Lock digest | 있음 | `lock.digest` | `decisionLockDigest` | 실수 감지용. 누구나 다시 계산 가능 |
| 기반 Truth | 일부 | proposal `based_on` | `propose` | Decision으로 옮겨지지 않고 proposal과 함께 삭제됨. stale로 확정했는지도 남지 않음 |
| Supersedes 관계 | 있음 | `supersedes`, `superseded_by` | 확정 후 단계·repair | 양쪽 일관성은 `integrity.ts`가 검사 |
| Git commit 연결 | 없음 | | | DUO는 commit하지 않음. 사용자가 commit할 때만, 작성자도 `user.name` |
| 거절 기록 지속성 | 일부 | 거절된 proposal 파일 | | 파일 삭제를 막는 장치가 없음. commit했을 때만 Git에 남음 |
| 중단·복구 이력 | 없음 | 결과값 `repaired[]`만 | `repairWith` | 파일과 metrics 어디에도 남지 않음 |
| 실패한 시도 | 일부 | `runtime/metrics.jsonl` | UI·MCP·CLI meter | 상태와 시각만. ID·actor 없음, Git 미추적 |

## 5. 감사 질문별 판정

판정: **ANSWERABLE**(DUO 파일만으로 답할 수 있음), **PARTIAL**(일부만, 또는 사용자의 Git 습관에 기댐), **NOT RECORDED**(기록 없음), **NOT TRUSTWORTHY**(기록은 있지만 호출자가 정하거나 누구나 고칠 수 있는 값).

| # | 감사 질문 | 판정 | 근거 |
|---|---|---|---|
| Q1 | 이 proposal은 누가 만들었나 | NOT TRUSTWORTHY | `proposed_by`는 MCP 인자·`--agent`·직접 쓴 파일이 정한다(S7a, S7d). `operations/propose.ts` |
| Q2 | 언제 제안·확정·거절됐나 | ANSWERABLE | `proposed_at`·`confirmed_at`·`rejected_at`(서비스 clock). 파일 편집으로 바꿀 수 있어 Git 이력과 함께 봐야 한다 |
| Q3 | 이 Decision은 누가 승인했나 | NOT TRUSTWORTHY | `confirmed_by: ui:Mallory`(S7b). `http/server.ts` `actor`, `apps/cli/src/commands/shared.ts` `humanActor` |
| Q4 | 승인한 것이 사람인가 에이전트인가 | NOT TRUSTWORTHY | kind는 저장하지 않고 `owner: human`이 고정. PTY로 CLI를, 셸로 UI API를 에이전트가 조작할 수 있음(S2, S4) |
| Q5 | 어느 표면에서 승인했나 | PARTIAL | UI만 `ui:` 접두사. CLI는 표시 없음 |
| Q6 | 왜 승인했나 | NOT RECORDED | confirm에 사유 입력 없음 |
| Q7 | 왜 제안했나 | PARTIAL | `rationale`은 선택. 없는 Decision이 많음 |
| Q8 | 승인자가 정확히 무엇을 보고 승인했나 | NOT RECORDED | preview digest는 confirm 시 비교만 하고 저장하지 않음(`service.ts` `confirm`) |
| Q9 | 제안 뒤 누가 내용을 바꿨나 | NOT RECORDED | D-001의 `proposed_by: codex-agent`인데 answer는 사람이 고친 `GraphQL`(S2). 원래 제안은 사용자가 commit했을 때만 Git에 있음 |
| Q10 | 대체 전후 내용은 무엇인가 | ANSWERABLE | D-001과 D-002 파일이 둘 다 남고 `supersedes`/`superseded_by`로 연결 |
| Q11 | 누가 언제 대체했나 | PARTIAL | 새 Decision의 `confirmed_by/at`으로 추론. 대상에는 `superseded_at` 없음. 승인자는 Q3과 같은 한계 |
| Q12 | 확정 뒤 내용이 바뀌지 않았나 | PARTIAL | 실수는 `DECISION_INTEGRITY_INVALID`로 감지(S5). 의도적 변경은 digest 재계산으로 숨길 수 있음(`digest.ts`) |
| Q13 | 어느 proposal이 이 Decision이 됐나 | PARTIAL | `proposal` 필드는 남지만 proposal 파일과 `based_on`은 삭제됨 |
| Q14 | 이 Decision이 DUO 생명주기를 거쳤나 | NOT TRUSTWORTHY | lock·proposal 없는 직접 작성 Decision도 인정(S7c). lock과 `proposal` 필드도 손으로 쓸 수 있음 |
| Q15 | 거절된 제안은 누가 언제 왜 거절했나 | PARTIAL | `rejected_by/at`·`reason`은 남지만 거절자는 Q3과 같은 표시값이고, 파일 삭제를 막지 못함 |
| Q16 | 실패하거나 막힌 승인 시도가 있었나 | NOT RECORDED | Truth에는 없음. `metrics.jsonl`에 상태만(ID·actor 없음, gitignored) |
| Q17 | 중단된 confirm이 있었고 언제 복구됐나 | NOT RECORDED | repair는 조용히 마무리(S6). `service.ts` `repairWith` |
| Q18 | 이 Decision은 어느 Git commit에 들어갔나 | NOT RECORDED | DUO는 commit하지 않음. 사용자가 commit해도 작성자는 `user.name`(S7b) |
| Q19 | 어떤 Truth 상태를 기준으로 제안됐고, stale인 채 확정됐나 | PARTIAL | `based_on`은 proposal에만 있고 확정 시 삭제. `PROPOSAL_STALE`은 warning으로만 반환 |

## 6. Gap(여러 사람이 쓰는 팀 기준 영향 순)

| 순위 | Gap | 영향 | 관련 질문 | 후속(백로그) |
|---|---|---|---|---|
| CRITICAL | 승인자 신원이 인증되지 않고, 사람용 표면을 에이전트가 조작할 수 있음 | 에이전트나 다른 팀원의 승인을 maintainer 승인으로 오인 | Q3, Q4 | BE-GOV([decision-rbac-design.md](decision-rbac-design.md)) |
| CRITICAL | lock 없는 직접 작성 Decision이 확정 권한을 가짐 | 생명주기와 승인 기록을 건너뛴 규칙이 Review·Context의 권한이 됨 | Q14 | BE-GOV-07(Team Mode fail-closed) |
| HIGH | 승인 사유와 승인자가 본 preview digest가 남지 않음 | 승인 근거와 대상 내용을 나중에 증명할 수 없음 | Q6, Q8 | BE-AUD-02·03 |
| HIGH | 제안 뒤 수정이 귀속되지 않음 | 에이전트 제안으로 기록되지만 내용은 다른 사람의 것 | Q9 | BE-AUD-02(proposal 스냅샷 digest 기록) |
| HIGH | 지속 이벤트 기록이 없음(복구, 실패, 거절 파일 삭제) | 팀 감사가 사용자의 commit 습관에 기댐 | Q15, Q16, Q17 | BE-AUD-01·02·04 |
| HIGH | Git commit·PR과 연결되지 않음 | 승인과 실제 병합(팀의 신뢰 경계)을 잇지 못함 | Q18 | BE-GOV-08(CI 검증) |
| MEDIUM | 승인자 종류·표면이 남지 않음 | CLI·UI·자동화 구분 불가 | Q4, Q5 | BE-AUD-03 |
| MEDIUM | `superseded_at`이 없고 대체 주체가 대상 파일에 없음 | 대체 이력을 새 Decision에서 추론해야 함 | Q11 | BE-AUD-02(이벤트로 기록, 파일 형식 유지) |
| MEDIUM | `based_on`·stale 여부가 Decision으로 옮겨지지 않음 | 낡은 기준으로 승인됐는지 모름 | Q13, Q19 | BE-AUD-03 |
| LOW | metrics에 ID·actor가 없음 | 개인정보를 줄이려는 의도된 설계. 감사용으로 쓰지 않음 | Q16 | 바꾸지 않음(이벤트 로그로 대체) |

## 7. 한계

- 단일 Windows 환경, 단일 사용자 계정에서 재현했다. 다른 OS의 PTY 동작은 확인하지 않았다.
- 동시 confirm, 동시 index는 #34(AI-4) 범위라 여기서는 다루지 않았다.
- GitHub PR·branch protection과의 연결은 DUO 밖이라 재현 범위가 아니다. 설계 문서에서 다룬다.

## 부록: 재현 스크립트

임시 디렉터리에서 실행한다. `R` 경로만 바꾸면 된다. 사용자 저장소와 전역 npm은 건드리지 않는다.

준비(PowerShell):

```powershell
$R='C:/path/to/scratch'
New-Item -ItemType Directory -Force "$R/tool","$R/repo/src/api" | Out-Null
Push-Location "$R/tool"; npm init -y; npm install @duo-director/cli@0.3.3; Pop-Location
Set-Location "$R/repo"; git init -b main
git config user.name 'Alice Maintainer'; git config user.email 'alice@example.invalid'
'export function listUsers() { return [] }' | Set-Content src/api/users.ts
'# Repro app' | Set-Content README.md
git add -A; git commit -m initial
node "$R/tool/node_modules/@duo-director/cli/dist/duoctl.js" init --yes --non-interactive
```

1부(S0–S4 제안, preview 변경, UI confirm·reject):

```js
// T87 #26 reproduction driver for public DUO 0.3.3 (MCP propose + UI confirm/reject + file snapshots).
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const R = "C:/path/to/scratch";
const REPO = R + "/repo";
const DUO = R + "/tool/node_modules/@duo-director/cli/dist/duoctl.js";
const EV = R + "/evidence";
fs.mkdirSync(EV, { recursive: true });
const log = [];
const note = (s) => { log.push(s); console.log(s); };
const git = (...a) => execFileSync("git", a, { cwd: REPO, encoding: "utf8" }).trim();
const duo = (...a) => { try { return execFileSync(process.execPath, [DUO, ...a], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return (e.stdout ?? "") + (e.stderr ?? ""); } };

function snapshot(step) {
  const dir = REPO + "/.duo-project/decisions";
  const out = {};
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else out[path.relative(REPO, p).replace(/\\/g, "/")] = fs.readFileSync(p, "utf8"); } };
  if (fs.existsSync(dir)) walk(dir);
  fs.writeFileSync(EV + "/" + step + ".json", JSON.stringify({ step, files: out, gitLog: git("log", "--format=%h %an <%ae> %s", "-12"), gitStatus: git("status", "--short") }, null, 2));
  note("SNAPSHOT " + step + ": " + Object.keys(out).join(", "));
}
const commit = (msg) => { git("add", "-A"); try { git("commit", "-q", "-m", msg); } catch {} note("COMMIT " + git("log", "-1", "--format=%h %an %s")); };

async function mcpPropose(agent, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [DUO, "mcp", "--root", REPO, "--agent", agent], { cwd: REPO });
    let buf = ""; let done = false;
    const send = (m) => p.stdin.write(JSON.stringify(m) + "\n");
    p.stdout.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        if (m.id === 1) { send({ jsonrpc: "2.0", method: "notifications/initialized" }); send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "duo_propose_decision", arguments: args } }); }
        if (m.id === 2) { done = true; p.kill(); resolve(m.result?.structuredContent ?? m.result ?? m.error); }
      }
    });
    p.on("error", reject);
    setTimeout(() => { if (!done) { p.kill(); reject(new Error("mcp timeout")); } }, 30000);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t87-repro", version: "1" } } });
  });
}

async function withUi(fn) {
  const p = spawn(process.execPath, [DUO, "ui", "--port", "0"], { cwd: REPO });
  const url = await new Promise((resolve, reject) => {
    let out = ""; p.stdout.on("data", (d) => { out += d; const m = /(http:\/\/127\.0\.0\.1:\d+\/\?session=[A-Za-z0-9_-]+)/.exec(out); if (m) resolve(m[1]); });
    setTimeout(() => reject(new Error("ui start timeout: " + out)), 30000);
  });
  const origin = new URL(url).origin;
  const r0 = await fetch(url, { redirect: "manual" });
  const cookie = (r0.headers.get("set-cookie") ?? "").split(";")[0];
  const get = async (p) => (await fetch(origin + p, { headers: { cookie, host: new URL(origin).host } })).json();
  const csrf = (await get("/api/session")).data.csrf;
  const post = async (p, body) => (await fetch(origin + p, { method: "POST", headers: { cookie, origin, "content-type": "application/json", "x-duo-csrf": csrf }, body: JSON.stringify(body) })).json();
  try { return await fn({ get, post }); } finally { p.kill(); }
}
const short = (o) => JSON.stringify(o).slice(0, 600);

note("== S0 init committed"); commit("chore: duoctl init"); snapshot("S0-init");

note("== S1 propose P-001 via MCP (agent label codex-agent)");
note(short(await mcpPropose("codex-agent", { title: "Public API style", question: "api_style", answer: "REST over JSON", rationale: "Clients already speak REST", governs: { paths: ["src/api/**"] } })));
snapshot("S1-proposed"); commit("decision: propose P-001");

note("== S2 change proposal content after preview, then confirm via UI (bound to preview digest)");
const d1 = await withUi(async ({ get }) => (await get("/api/proposals")).data.previews["P-001"].digest);
const pf = REPO + "/.duo-project/decisions/proposals/P-001.yaml";
fs.writeFileSync(pf, fs.readFileSync(pf, "utf8").replace("answer: REST over JSON", "answer: GraphQL"));
note("edited P-001 answer to GraphQL after the preview digest " + d1);
await withUi(async ({ get, post }) => {
  const stale = await post("/api/proposals/P-001/confirm", { confirmId: "P-001", previewDigest: d1 });
  note("confirm with OLD digest: " + short(stale.data));
  const d2 = (await get("/api/proposals")).data.previews["P-001"].digest;
  const ok = await post("/api/proposals/P-001/confirm", { confirmId: "P-001", previewDigest: d2 });
  note("confirm with NEW digest " + d2 + ": " + short(ok.data));
});
snapshot("S2-confirmed"); commit("decision: confirm P-001");

note("== S3 propose P-002 via MCP and reject via UI with a reason");
note(short(await mcpPropose("codex-agent", { title: "Use gRPC internally", question: "internal_rpc", answer: "gRPC" })));
commit("decision: propose P-002");
await withUi(async ({ post }) => note("reject: " + short((await post("/api/proposals/P-002/reject", { reason: "Too early; one service only" })).data)));
snapshot("S3-rejected"); commit("decision: reject P-002");

note("== S4 propose P-003 superseding D-001 via MCP (agent label claude-agent); confirm by CLI TTY runs separately");
note(short(await mcpPropose("claude-agent", { title: "Public API style v2", question: "api_style", answer: "REST over JSON with OpenAPI", supersedes: "D-001", governs: { paths: ["src/api/**"] } })));
snapshot("S4-proposed-supersede"); commit("decision: propose P-003 superseding D-001");
note("CLI confirm without TTY: " + duo("decision", "confirm", "P-003").trim().slice(0, 300));
fs.writeFileSync(EV + "/log-part1.txt", log.join("\n"));
```

S4 CLI 확정(PTY가 있는 터미널에서): `node $R/tool/node_modules/@duo-director/cli/dist/duoctl.js decision confirm P-003` 후 `P-003` 입력.

2부(S4b–S8, 1부의 helper 아래에 이어 붙여 실행):

```js
const statusCodes = () => { const out = duo("status", "--json"); try { const j = JSON.parse(out); return JSON.stringify((j.diagnostics ?? []).map((d) => d.code + ": " + d.message.slice(0, 160))).slice(0, 900) + " | result.decisions=" + JSON.stringify(j.result?.decisions ?? j.result?.truth ?? null).slice(0, 300); } catch { return out.slice(0, 600); } };

note("== S4b CLI confirm of P-003 (TTY, Git user Alice Maintainer) done outside this script");
snapshot("S4-confirmed-supersede"); commit("decision: confirm P-003 (CLI, supersedes D-001)");

note("== S5 Decision Lock: edit D-002 content by hand, then check status and doctor");
const d2 = REPO + "/.duo-project/decisions/D-002.yaml";
const orig = fs.readFileSync(d2, "utf8");
fs.writeFileSync(d2, orig.replace("answer: REST over JSON with OpenAPI", "answer: SOAP"));
note("status after tamper: " + statusCodes());
note("doctor after tamper: " + duo("doctor", "--json").slice(0, 700).replace(/\s+/g, " "));
fs.writeFileSync(d2, orig);
note("restored D-002; status: " + statusCodes());

note("== S6 interrupted confirm: P-004 confirmed via UI, then the proposal file comes back (crash before cleanup)");
note(short(await mcpPropose("codex-agent", { title: "Error format", question: "error_format", answer: "RFC 9457 problem+json" })));
commit("decision: propose P-004");
const p4 = REPO + "/.duo-project/decisions/proposals/P-004.yaml";
const p4text = fs.readFileSync(p4, "utf8");
await withUi(async ({ get, post }) => {
  const dg = (await get("/api/proposals")).data.previews["P-004"].digest;
  note("confirm P-004: " + short((await post("/api/proposals/P-004/confirm", { confirmId: "P-004", previewDigest: dg })).data));
});
fs.writeFileSync(p4, p4text);
note("simulated: P-004.yaml restored after D-003 was written");
note("decision list --json: " + duo("decision", "list", "--json").slice(0, 700).replace(/\s+/g, " "));
snapshot("S6-interrupted");
note("next operation = MCP propose P-005 (repairs first): " + short(await mcpPropose("codex-agent", { title: "Pagination", question: "pagination", answer: "cursor based" })));
note("P-004.yaml exists after repair: " + fs.existsSync(p4));
snapshot("S6-repaired"); commit("decision: confirm P-004, repair, propose P-005");

note("== S7a agent label that looks like the maintainer");
note(short(await mcpPropose("Alice Maintainer", { title: "Logging", question: "logging", answer: "structured JSON logs" })));
note("== S7b another person sets Git user.name and confirms through the UI");
git("config", "user.name", "Mallory");
await withUi(async ({ get, post }) => {
  const pv = (await get("/api/proposals")).data.previews["P-006"];
  note("preview proposedBy=" + pv.proposedBy + " kind=" + pv.proposedByKind);
  note("confirm P-006 as Git user Mallory: " + short((await post("/api/proposals/P-006/confirm", { confirmId: "P-006", previewDigest: pv.digest })).data));
});
snapshot("S7b-mallory"); commit("decision: confirm P-006 (Git user Mallory)");
git("config", "user.name", "Alice Maintainer");

note("== S7c an agent with file system access writes a confirmed Decision file directly (no lock, no proposal)");
const forged = REPO + "/.duo-project/decisions/D-005.yaml";
fs.writeFileSync(forged, ["id: D-005", "title: Database", "state: confirmed", "owner: human", "question: database", "answer: MongoDB", "confirmed_by: Alice Maintainer", "confirmed_at: 2026-10-19T00:00:00Z", ""].join("\n"));
note("status with forged D-005: " + statusCodes());
note("decision list: " + duo("decision", "list").slice(0, 400).replace(/\s+/g, " "));
note("review --json verdict with forged D-005: " + (() => { const o = duo("review", "--json"); try { const j = JSON.parse(o); return (j.result?.status ?? "") + " " + (j.result?.verdict ?? "") + " " + JSON.stringify((j.diagnostics ?? []).map((d) => d.code)).slice(0, 300); } catch { return o.slice(0, 400); } })());
snapshot("S7c-forged");
fs.rmSync(forged);
note("removed forged D-005");

note("== S7d a proposal file written by hand that claims proposed_by_kind human");
fs.writeFileSync(REPO + "/.duo-project/decisions/proposals/P-099.yaml", ["id: P-099", "title: Cache", "state: proposed", "question: cache", "answer: Redis", "proposed_by: Alice Maintainer", "proposed_by_kind: human", ""].join("\n"));
await withUi(async ({ get }) => { const pv = (await get("/api/proposals")).data.previews["P-099"]; note("preview of hand-written P-099: proposedBy=" + pv?.proposedBy + " kind=" + pv?.proposedByKind); });
fs.rmSync(REPO + "/.duo-project/decisions/proposals/P-099.yaml");
snapshot("S8-final");
note("final git log: " + git("log", "--format=%h %an %s", "-20").replace(/\n/g, " | "));
fs.writeFileSync(EV + "/log-part2.txt", log.join("\n"));
```

