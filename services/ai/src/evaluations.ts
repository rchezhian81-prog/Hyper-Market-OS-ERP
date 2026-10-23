// The evaluation route (OB-288 lane 4 · P1 · AI-NFR-09 · QG-11 · API-13 "evaluation").
//
// `POST /v1/ai/evaluations/:agent` runs that agent's cases of the FIXED, versioned evaluation set through the SAME
// governed call every model call takes (admission, metering, hash-chained audit, minimisation, the gateway's tool and
// citation checks), scores them with the tested engine (`runEvalSuite`), compares the result with the agent's previous
// run (`compareToBaseline`) and records it — append-only, one record per run.
//
//   • A run is COMPLETE only when every case actually reached a model. With no provider (OB-296: none is contracted) a
//     run is recorded as NOT COMPLETE and proves nothing — a case that was refused at the door is never counted as a
//     model correctly saying "I do not know".
//   • An UNSAFE case, or an unsafe regression, raises an AI incident for a named person. It blocks: the model it ran
//     against cannot be approved (model-registry.ts), and the release gate (tests/guardrails) fails on it.
//   • It commits nothing. The cases' evidence is synthetic; nothing a case proposes reaches anybody.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  AGENTS, runEvalSuite, compareToBaseline,
  type AgentId, type CaseResult, type EvalSuiteResult, type ModelResponse, type RegressionVerdict,
} from '../../../packages/ai/src/index';
import { governedModelCall, type ModelGatewayDeps } from './model-gateway';
import { EVALUATION_EVIDENCE, EVALUATION_SET, EVALUATION_SET_VERSION } from './evaluation-set';

export interface EvaluationRunRecord {
  readonly runId: string;
  readonly agent: AgentId;
  readonly setVersion: number;
  readonly by: string;
  readonly at: string;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly unsafe: number;
  readonly scoreBps: number;
  readonly fitToFacePeople: boolean;
  /** True only when every case reached a model. An incomplete run proves nothing about a model. */
  readonly complete: boolean;
  readonly reachedModel: number;
  readonly results: readonly CaseResult[];
  readonly regression: { readonly verdict: RegressionVerdict; readonly againstRunId: string; readonly newlyFailing: readonly string[]; readonly newlyUnsafe: readonly string[]; readonly releasable: boolean; readonly detail: string } | null;
  readonly callIds: readonly string[];
  readonly costMinor: number;
  readonly detail: string;
  readonly committedAnything: false;
}

export interface EvaluationStore {
  readonly runs: (tenantId: string) => Promise<readonly EvaluationRunRecord[]> | readonly EvaluationRunRecord[];
  readonly record: (tenantId: string, run: EvaluationRunRecord) => Promise<void> | void;
}

/** The agents the fixed set has cases for. */
export function agentsInTheSet(): readonly AgentId[] {
  return [...new Set(EVALUATION_SET.map((c) => c.agentId))].sort();
}

const suiteOf = (r: EvaluationRunRecord): EvalSuiteResult => ({
  agentId: r.agent, total: r.total, passed: r.passed, failed: r.failed, unsafe: r.unsafe, scoreBps: r.scoreBps,
  fitToFacePeople: r.fitToFacePeople, results: r.results, detail: r.detail,
});

/** Run one agent's cases through the governed call and score them. Pure apart from the gateway's own writes. */
export async function runAgentEvaluation(gateway: ModelGatewayDeps, input: {
  readonly tenantId: string; readonly agent: AgentId; readonly by: string; readonly runId: string;
  readonly previous?: EvaluationRunRecord;
}): Promise<EvaluationRunRecord> {
  const cases = EVALUATION_SET.filter((c) => c.agentId === input.agent);
  const responses: Record<string, ModelResponse> = {};
  const callIds: string[] = [];
  let reachedModel = 0;
  let costMinor = 0;
  for (const c of cases) {
    const callId = `eval-${input.runId}-${c.caseId}`;
    const { response, audit } = await governedModelCall(gateway, {
      tenantId: input.tenantId, agent: input.agent, requestedBy: input.by, callId, instruction: c.instruction,
      evidence: EVALUATION_EVIDENCE[c.caseId] ?? [], evidenceFrom: `evaluation_set_v${EVALUATION_SET_VERSION}`,
      tier: 'small', maxOutputTokens: 1_200, timeoutMs: 4_000, evaluation: true,
    });
    callIds.push(callId);
    responses[c.caseId] = response;
    if (audit.calledAModel) reachedModel += 1;
    costMinor += audit.actualCostMinor;
  }
  const suite = runEvalSuite({ agentId: input.agent, cases, responses });
  const complete = cases.length > 0 && reachedModel === cases.length;
  const regression = complete && input.previous !== undefined && input.previous.complete
    ? (() => {
      const r = compareToBaseline({ agentId: input.agent, current: suite, baseline: suiteOf(input.previous) });
      return { verdict: r.verdict, againstRunId: input.previous.runId, newlyFailing: r.newlyFailing, newlyUnsafe: r.newlyUnsafe, releasable: r.releasable, detail: r.detail };
    })()
    : null;
  const at = gateway.now();
  return {
    runId: input.runId, agent: input.agent, setVersion: EVALUATION_SET_VERSION, by: input.by, at,
    total: suite.total, passed: suite.passed, failed: suite.failed, unsafe: suite.unsafe, scoreBps: suite.scoreBps,
    fitToFacePeople: complete && suite.fitToFacePeople, complete, reachedModel, results: suite.results, regression,
    callIds, costMinor,
    detail: !complete
      ? `${cases.length - reachedModel} of ${cases.length} case(s) never reached a model (no provider, not admitted, or stopped) — this run proves nothing about a model and is not a pass`
      : regression !== null && !regression.releasable ? `${suite.detail}; against the previous run: ${regression.detail}` : suite.detail,
    committedAnything: false,
  };
}

function refuse(status: number, code: string, whatHappened: string, nextSafeAction: string): never {
  throw apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });
}

export function evaluationRoutes(deps: {
  readonly gateway: ModelGatewayDeps;
  readonly evaluations: EvaluationStore;
  readonly now: () => string;
}): readonly Route[] {
  return [
    {
      api: 'API-13', method: 'POST', path: '/v1/ai/evaluations/:agent',
      permission: 'ai.evaluation.run', idempotent: true,
      handler: async (ctx) => {
        const agent = ctx.params['agent'] ?? '';
        if (!(agent in AGENTS)) refuse(400, 'unknown_agent', `${agent} is not an agent in the authority catalogue (A01…A10).`, 'Nothing was run.');
        if (!agentsInTheSet().includes(agent as AgentId)) {
          refuse(404, 'no_evaluation_cases', `Evaluation set v${EVALUATION_SET_VERSION} has no cases for ${agent}.`, 'Nothing was run.');
        }
        const previous = [...(await deps.evaluations.runs(ctx.tenantId))].reverse().find((r) => r.agent === agent && r.complete);
        const runId = `evr-${agent}-${ctx.idempotencyKey ?? deps.now()}`;
        if ((await deps.evaluations.runs(ctx.tenantId)).some((r) => r.runId === runId)) {
          const same = (await deps.evaluations.runs(ctx.tenantId)).find((r) => r.runId === runId)!;
          return { status: 200, body: { run: same, replayed: true } };
        }
        const run = await runAgentEvaluation(deps.gateway, {
          tenantId: ctx.tenantId, agent: agent as AgentId, by: ctx.userId, runId,
          ...(previous === undefined ? {} : { previous }),
        });
        await deps.evaluations.record(ctx.tenantId, run);
        if (run.unsafe > 0 || run.regression?.verdict === 'unsafe_regression') {
          const unsafeCases = run.results.filter((r) => r.verdict === 'unsafe').map((r) => r.caseId);
          await deps.gateway.raiseIncident?.(ctx.tenantId, {
            incidentId: `aii-eval-${runId}`, kind: 'unsafe_evaluation', agent: agent as AgentId,
            summary: `${AGENTS[agent as AgentId].name} failed safety in evaluation run ${runId}: ${unsafeCases.join(', ')}. It must not face anybody until this is fixed.`,
            raisedBy: 'evaluation', raisedAt: run.at, evidence: { runId, cases: unsafeCases },
          });
        }
        return { status: 201, body: { run } };
      },
    },
    {
      // Every run, and the latest per agent — what the AI control screen's "checked …/… passed" reads.
      api: 'API-13', method: 'GET', path: '/v1/ai/evaluations',
      permission: 'ai.proposal.read',
      handler: async (ctx) => {
        const runs = await deps.evaluations.runs(ctx.tenantId);
        const latestByAgent: Record<string, EvaluationRunRecord> = {};
        for (const r of runs) latestByAgent[r.agent] = r;
        return {
          status: 200,
          body: {
            setVersion: EVALUATION_SET_VERSION, agentsWithCases: agentsInTheSet(),
            casesByAgent: Object.fromEntries(agentsInTheSet().map((a) => [a, EVALUATION_SET.filter((c) => c.agentId === a).length])),
            runs, latestByAgent, asAt: deps.now(),
          },
        };
      },
    },
  ];
}
