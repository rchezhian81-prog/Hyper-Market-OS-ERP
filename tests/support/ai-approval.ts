// Test support (OB-288 lane 4 · P1 · AI-NFR-01): put a stand-in model on the approved-model register the way the owner
// would — run the fixed evaluation set against it through the real evaluation route, then approve it citing that run.
//
// The evaluation runs on its OWN harness over the SAME store, with the deterministic evaluation simulator as the provider
// (the stand-in the set is scripted for), so a test whose own stand-in is scripted for something else (a drafting leg)
// can still reach the governed call. Synthetic only: no provider is contracted (OB-296).

import { apiHarness, type ApiHarness } from './api-harness';
import { simulatedTransport, type AgentId, type ModelTier, type TierPricing } from '../../packages/ai/src/index';
import { EVALUATION_SIMULATOR } from '../../services/ai/src/evaluation-set';

export interface ApprovedStandIn { readonly runId: string; readonly modelId: string; readonly spentMinor: number }

export async function approveStandInModel(h: ApiHarness, input: {
  readonly tenantId: string;
  readonly userId: string;
  readonly pricing: Readonly<Record<ModelTier, TierPricing>>;
  /** An agent the tenant has enabled, whose cases the evaluation runs. Default A01. */
  readonly agent?: AgentId;
  readonly modelId?: string;
  readonly tier?: ModelTier;
  readonly key?: string;
}): Promise<ApprovedStandIn> {
  const agent = input.agent ?? 'A01';
  const key = input.key ?? 'stand-in';
  const evaluator = apiHarness({ store: h.store, modelTransport: simulatedTransport(EVALUATION_SIMULATOR), modelPricing: input.pricing });
  const run = await evaluator.request({ method: 'POST', path: `/v1/ai/evaluations/${agent}`, userId: input.userId, tenantId: input.tenantId, idempotencyKey: `eval-${key}` });
  if (run.status !== 201) throw new Error(`the stand-in's evaluation did not run: ${run.status} ${JSON.stringify(run.body)}`);
  const runId = (run.body as { run: { runId: string } }).run.runId;
  const modelId = input.modelId ?? `stand-in-${input.tier ?? 'small'}`;
  const approved = await h.request({
    method: 'POST', path: '/v1/ai/models', userId: input.userId, tenantId: input.tenantId, idempotencyKey: `approve-${key}`,
    body: { modelId, adapterId: 'simulator', tier: input.tier ?? 'small', dataResidency: 'india', evaluationRunId: runId },
  });
  if (approved.status !== 201) throw new Error(`the stand-in was not approved: ${approved.status} ${JSON.stringify(approved.body)}`);
  const budget = await h.request({ method: 'GET', path: '/v1/ai/budget', userId: input.userId, tenantId: input.tenantId });
  return { runId, modelId, spentMinor: (budget.body as { spentMinor: number }).spentMinor };
}
