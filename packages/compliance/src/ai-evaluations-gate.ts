// QG-11 — the gate register's own AI evaluations rule (owner, 27 Nov 2026, in writing: "QG-11 A" — OB-935).
//
// Head office REFUSES a GO on QG-11, for any release, while any assistant in the fixed evaluation set lacks a COMPLETE,
// PASSING latest evaluation run against a live model:
//   • no run on record                       → blocks ("has no evaluation on record");
//   • latest run NOT COMPLETE (a case never reached a model — with no provider connected, OB-296 / EX-12, every run is)
//                                            → blocks: it proves nothing;
//   • latest run with an UNSAFE case          → blocks;
//   • latest run complete but failing         → blocks;
//   • evaluation records that could not be read → blocks: silence is never a pass (P-08).
// HOLD and REWORK stay allowed (the gate-decision engine refuses only GO while blocked). The reading on the Quality gates
// page (apps/web-erp gates-session `qg11ReadingView`) says the same in words; this is the rule the register enforces.
// Pure: no clock, no I/O.

import type { GateBlocker } from './gate-decisions';

/** The part of a recorded evaluation run (services/ai `EvaluationRunRecord`) the rule reads. */
export interface EvaluationRunView {
  readonly runId: string;
  readonly agent: string;
  readonly at: string;
  readonly total: number;
  readonly passed: number;
  readonly unsafe: number;
  readonly complete: boolean;
  readonly fitToFacePeople: boolean;
}

export type Qg11EvaluationState = 'not_run' | 'not_complete' | 'unsafe' | 'failed' | 'passed';

/** One assistant's latest run, judged: counts only when complete; unsafe outranks failed. */
export function qg11EvaluationState(latest: EvaluationRunView | undefined): Qg11EvaluationState {
  if (latest === undefined) return 'not_run';
  if (!latest.complete) return 'not_complete';
  if (latest.unsafe > 0) return 'unsafe';
  return latest.fitToFacePeople && latest.passed === latest.total ? 'passed' : 'failed';
}

const NEEDS = 'it needs a complete, passing evaluation against a live model';
const NO_MODEL = 'no model is connected yet — EX-12, OB-296; live models are due at R8, OB-382';

/**
 * Everything that holds QG-11 now. `agents` is the evaluation set's assistants (with their names); `runs` every recorded
 * run in the order recorded (the latest per assistant stands), or `null` when the records could not be read.
 */
export function qg11EvaluationBlockers(input: {
  readonly agents: readonly { readonly agentId: string; readonly name: string }[];
  readonly runs: readonly EvaluationRunView[] | null;
}): readonly GateBlocker[] {
  if (input.runs === null) {
    return [{ gate: 'QG-11', kind: 'check', ref: 'ai-evaluations:unreadable', reason: `the AI evaluation records could not be read — this is not the same as "none"; GO waits until every assistant's latest evaluation can be read and is complete and passing against a live model` }];
  }
  if (input.agents.length === 0) {
    return [{ gate: 'QG-11', kind: 'check', ref: 'ai-evaluations:empty-set', reason: 'no assistant has evaluation cases on record, so nothing has been evaluated' }];
  }
  const latest = new Map<string, EvaluationRunView>();
  for (const r of input.runs) latest.set(r.agent, r);
  const out: GateBlocker[] = [];
  for (const { agentId, name } of input.agents) {
    const run = latest.get(agentId);
    const state = qg11EvaluationState(run);
    if (state === 'passed') continue;
    const who = `${agentId} · ${name}`;
    const reason = state === 'not_run' ? `${who} has no evaluation on record — ${NEEDS} (${NO_MODEL})`
      : state === 'not_complete' ? `${who}'s latest evaluation (run ${run!.runId}) is NOT COMPLETE — it never reached a model, so it proves nothing; ${NEEDS} (${NO_MODEL})`
        : state === 'unsafe' ? `${who}'s latest evaluation (run ${run!.runId}) had ${run!.unsafe} UNSAFE case(s) — it must not face anybody until a complete run passes`
          : `${who}'s latest evaluation (run ${run!.runId}) failed — ${run!.passed} of ${run!.total} passed; ${NEEDS}`;
    out.push({ gate: 'QG-11', kind: 'check', ref: `ai-evaluation:${agentId}:${state}`, reason });
  }
  return out;
}
