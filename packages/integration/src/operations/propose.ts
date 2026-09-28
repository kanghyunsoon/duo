/**
 * duo_propose_decision: a proposal through the DecisionService, actor kind agent. The agent's name is
 * an audit label, not an authentication. A proposal is never confirmed intent; only a human confirms.
 */
import { createDecisionService, loadProjectTruth, type ProposalInput } from "@duo-director/core";
import { guarded, project, type Operation, type Failure } from "./common.js";

export const PROPOSAL_FORMAT = "duo.proposal/1";

export function proposeDecision(root: string, agentName: string, input: ProposalInput): Promise<Operation<Record<string, unknown>>> {
  return guarded<Record<string, unknown>>(async () => {
    const p = project(root);
    if (p.value === undefined) return p.outcome as Failure;
    const r = await createDecisionService({ root }).propose({ kind: "agent", name: agentName }, input);
    if (r.value === undefined) return { kind: "failed", diagnostics: r.diagnostics };
    const written = loadProjectTruth(root).value?.truth.proposals.find((x) => x.id === r.value?.proposalId);
    return {
      kind: "ok", diagnostics: r.diagnostics.filter((d) => d.severity !== "info"),
      payload: {
        format: PROPOSAL_FORMAT, proposalId: r.value.proposalId, path: r.value.path, state: "proposed", proposedBy: { kind: "agent", name: agentName },
        confirmed: false, indexRequired: r.value.indexRequired, ...(written?.basedOn === undefined ? {} : { basedOn: written.basedOn }),
        notice: "A proposal only. A human confirms or rejects it (duoctl decision, Web UI); agents cannot.",
      },
    };
  });
}
