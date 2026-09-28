/**
 * Human wording of the CLI (T15), en and ko. The CLI's own labels only: domain results keep their
 * structured fields, Knowledge Gap questions come from the director renderer, and Review claim
 * reasons are shown by code. No language guessing: --locale or DUO_LOCALE, default en.
 */
export type Locale = "en" | "ko";

const EN = {
  "init.repository": "Repository", "init.truth": "Truth", "init.index": "Index", "init.baseline": "Baseline",
  "step.ok": "ok", "step.existing": "already done", "step.failed": "failed", "step.action-required": "action required", "step.skipped": "skipped", "step.aborted": "aborted",
  "init.observed": "{name} · {languages} · {files} files · branch {branch}",
  "init.dirty": "Working tree has existing changes: staged {staged} · unstaged {unstaged} · untracked {untracked}",
  "init.dirty.choose": "Adoption baseline: [1] use HEAD as the baseline (current changes stay changes to review)  [2] abort and clean the repository first",
  "init.dirty.policy-required": "The working tree is dirty. Choose --baseline-policy head (HEAD as baseline) or abort (clean first). --yes does not choose it.",
  "init.dirty.aborted": "Baseline not captured. Commit or stash your changes, then run duoctl init again (Truth and index are kept).",
  "init.imports": "Import candidates found: {n} (not imported; review them yourself)",
  "init.documents": "Candidate documents: {list}",
  "init.question.project_goal": "Project goal (one sentence)",
  "init.question.current_milestone": "Current milestone or MVP scope (title, empty to skip)",
  "init.question.critical_constraints": "Critical constraints, separated by ';' (empty to skip)",
  "init.suggested": "Suggested from {source}: {value}",
  "init.accept": "Use the suggestion? [y/N]",
  "init.apply": "Create {n} files in .duo-project? [Y/n]",
  "init.repair": ".duo-project exists without project.yaml. Add only the missing files? [y/N]",
  "init.repair-required": ".duo-project exists without project.yaml; rerun with --repair to add only the missing files.",
  "init.open": "Open questions (UNKNOWN lines in intent/vision.md): {list}",
  "init.done": "DUO is set up. Next: duoctl status · duoctl context <task> · duoctl review",
  "init.cancelled": "Cancelled; nothing written.",
  "status.project": "Project {name} · goal {goal} · milestone {milestone}",
  "status.truth": "Truth: {requirements} requirements · {decisions} decisions · {constraints} constraints · {gaps} declared gaps",
  "status.index": "Index: {status}{reason}",
  "status.changes": "Changed since index: {files} files · analysis stale {analysis} · module resolution {modules} · calls may be recomputed {calls}",
  "status.baseline": "Adoption baseline: {status}{detail}",
  "status.pending": "Pending decisions: {n}",
  "status.llm": "LLM: {state}",
  "index.done": "Indexed ({mode}{reason}) · {files} files · {analyzed} parsed · {changed} changed · graph {written}",
  "index.required": "INDEX_REQUIRED: the index is {status}. Run duoctl index (or pass --refresh).",
  "context.status": "Context {status}",
  "review.head": "{verdict}  {claims} claims · {files} files · llm_calls {llm}",
  "review.pass": "PASS means: no project-direction violation found in the available evidence (not: no bugs).",
  "review.aligned": "{n} aligned claims (--verbose to list)",
  "review.bootstrap": "{n} Truth files exactly as init wrote them (adoption-bootstrap, not reviewed until changed)",
  "review.gaps": "Knowledge gaps:",
  "review.limitations": "Limitations:",
  "review.recorded": "Recorded {path} ({status})",
  "review.baseline-missing": "No adoption baseline: violations are not told apart from pre-existing ones (duoctl init captures it).",
  "graph.truncated": "truncated: more nodes than the limit; raise --depth carefully or narrow the node",
  "graph.impact-note": "Impact recorded in the DUO Graph; not every affected line of code.",
  "graph.not-found": "Node not found: {node}",
  "decision.tty": "duoctl decision needs an interactive terminal (a guard against unattended runs, not an authentication).",
  "decision.retype": "Type the ID to {op}: ",
  "decision.mismatch": "The ID does not match; nothing changed.",
  "decision.confirmed": "confirmed as {id} · {path}",
  "decision.rejected": "rejected {id}",
  "decision.none": "No pending decisions.",
  "stats.none": "No metrics yet.",
  "not-initialized": "Not a DUO project (no .duo-project/project.yaml). Run duoctl init.",
  "not-implemented": "'{command}' is not implemented yet ({task}).",
} as const;

export type MessageKey = keyof typeof EN;

const KO: Record<MessageKey, string> = {
  "init.repository": "저장소", "init.truth": "Truth", "init.index": "Index", "init.baseline": "Baseline",
  "step.ok": "완료", "step.existing": "이미 있음", "step.failed": "실패", "step.action-required": "조치 필요", "step.skipped": "건너뜀", "step.aborted": "중단",
  "init.observed": "{name} · {languages} · 파일 {files}개 · branch {branch}",
  "init.dirty": "작업 트리에 변경이 있습니다: staged {staged} · unstaged {unstaged} · untracked {untracked}",
  "init.dirty.choose": "Adoption baseline: [1] HEAD를 baseline으로 사용(현재 변경은 이후 Review 대상)  [2] 중단하고 먼저 저장소 정리",
  "init.dirty.policy-required": "작업 트리가 dirty합니다. --baseline-policy head(HEAD를 baseline) 또는 abort(먼저 정리)를 고르세요. --yes는 이것을 고르지 않습니다.",
  "init.dirty.aborted": "Baseline을 만들지 않았습니다. 변경을 commit하거나 stash한 뒤 duoctl init을 다시 실행하세요(Truth와 index는 유지).",
  "init.imports": "Import 후보 {n}개 발견(가져오지 않음, 직접 검토하세요)",
  "init.documents": "후보 문서: {list}",
  "init.question.project_goal": "프로젝트 Goal(한 문장)",
  "init.question.current_milestone": "현재 Milestone 또는 MVP 범위(제목, 비우면 건너뜀)",
  "init.question.critical_constraints": "Critical constraint, ';'로 구분(비우면 건너뜀)",
  "init.suggested": "{source}에서 제안: {value}",
  "init.accept": "제안을 사용할까요? [y/N]",
  "init.apply": ".duo-project에 파일 {n}개를 만들까요? [Y/n]",
  "init.repair": "project.yaml 없는 .duo-project가 있습니다. 없는 파일만 추가할까요? [y/N]",
  "init.repair-required": "project.yaml 없는 .duo-project가 있습니다. 없는 파일만 추가하려면 --repair로 다시 실행하세요.",
  "init.open": "열린 질문(intent/vision.md의 UNKNOWN 줄): {list}",
  "init.done": "DUO 설정 완료. 다음: duoctl status · duoctl context <task> · duoctl review",
  "init.cancelled": "취소했습니다. 아무것도 쓰지 않았습니다.",
  "status.project": "Project {name} · goal {goal} · milestone {milestone}",
  "status.truth": "Truth: requirement {requirements} · decision {decisions} · constraint {constraints} · declared gap {gaps}",
  "status.index": "Index: {status}{reason}",
  "status.changes": "Index 이후 변경: 파일 {files} · 분석 stale {analysis} · module resolution {modules} · 재계산 가능 call {calls}",
  "status.baseline": "Adoption baseline: {status}{detail}",
  "status.pending": "대기 중 decision: {n}",
  "status.llm": "LLM: {state}",
  "index.done": "Index 완료({mode}{reason}) · 파일 {files} · parse {analyzed} · 변경 {changed} · graph {written}",
  "index.required": "INDEX_REQUIRED: index가 {status}입니다. duoctl index를 실행하세요(또는 --refresh).",
  "context.status": "Context {status}",
  "review.head": "{verdict}  claim {claims} · 파일 {files} · llm_calls {llm}",
  "review.pass": "PASS는 현재 Evidence 범위에서 프로젝트 방향 위반을 찾지 못했다는 뜻입니다(버그 없음이 아님).",
  "review.aligned": "ALIGNED claim {n}개(--verbose로 목록)",
  "review.bootstrap": "init이 만든 그대로의 Truth 파일 {n}개(adoption-bootstrap, 바뀌기 전에는 검수하지 않음)",
  "review.gaps": "Knowledge gap:",
  "review.limitations": "한계:",
  "review.recorded": "기록 {path} ({status})",
  "review.baseline-missing": "Adoption baseline이 없어 기존 위반과 새 위반을 구분하지 않습니다(duoctl init이 만듭니다).",
  "graph.truncated": "truncated: 한도보다 노드가 많습니다. --depth를 줄이거나 노드를 좁히세요",
  "graph.impact-note": "DUO Graph에 기록된 영향입니다. 영향받는 모든 코드가 아닙니다.",
  "graph.not-found": "노드 없음: {node}",
  "decision.tty": "duoctl decision은 대화형 터미널이 필요합니다(무인 실행 방지 장치이며 인증이 아님).",
  "decision.retype": "{op}하려면 ID를 다시 입력하세요: ",
  "decision.mismatch": "ID가 다릅니다. 바꾸지 않았습니다.",
  "decision.confirmed": "{id}로 확정 · {path}",
  "decision.rejected": "{id} 거절",
  "decision.none": "대기 중 decision이 없습니다.",
  "stats.none": "지표가 아직 없습니다.",
  "not-initialized": "DUO project가 아닙니다(.duo-project/project.yaml 없음). duoctl init을 실행하세요.",
  "not-implemented": "'{command}'는 아직 구현되지 않았습니다({task}).",
};

const TABLES: Record<Locale, Record<MessageKey, string>> = { en: EN, ko: KO };

export function t(locale: Locale, key: MessageKey, params: Readonly<Record<string, string | number>> = {}): string {
  return TABLES[locale][key].replace(/\{(\w+)\}/gu, (_, k: string) => String(params[k] ?? ""));
}

export function parseLocale(value: string | undefined): Locale | undefined {
  return value === "en" || value === "ko" ? value : undefined;
}
