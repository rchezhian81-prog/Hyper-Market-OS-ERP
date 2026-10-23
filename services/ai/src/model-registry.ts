// The approved-model register (OB-288 lane 4 · P1 · AI-NFR-01 "central model gateway and approved-model registry").
//
// A model is reached only through the governed call, and from now on only a model ON THIS REGISTER: the gateway asks
// which approved model serves the admitted tier and refuses — before any reservation or transport — when there is none.
//
// An entry names the provider ADAPTER (never a key — secrets stay in the vault, hard rule #4), the model, the tier it
// serves, where the provider keeps the data (India residency is recorded, never assumed), who approved it and when, and
// the EVALUATION RUN it passed. That run is required and must be complete, fit to face people and free of unsafe cases:
// the roadmap's rule that the same evaluation set runs against a provider BEFORE it is enabled (liveProviderGate), and
// D3's "the smallest model that passes the approved evaluation". Withdrawing an entry is its own fact with a reason; an
// entry is never edited or deleted (hard rules #2, #6).
//
// OB-296: no live provider is contracted and there is no AI cost — the register is empty in production, so every model
// call is refused at the gateway. Tests approve a stand-in model against the simulator.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { ModelTier } from '../../../packages/ai/src/index';
import type { EvaluationRunRecord } from './evaluations';

export type DataResidency = 'india' | 'outside_india';

export interface ApprovedModel {
  readonly modelId: string;
  /** The provider adapter's identifier (e.g. "simulator"). Never a key or a URL with credentials. */
  readonly adapterId: string;
  readonly tier: ModelTier;
  readonly dataResidency: DataResidency;
  readonly approvedBy: string;
  readonly approvedAt: string;
  /** The evaluation run it passed — complete, fit to face people, nothing unsafe. */
  readonly evaluationRunId: string;
  readonly evaluation: { readonly agent: string; readonly passed: number; readonly total: number; readonly scoreBps: number };
}
export interface ModelWithdrawal { readonly modelId: string; readonly by: string; readonly at: string; readonly reason: string }

export interface RegisteredModel extends ApprovedModel {
  readonly state: 'approved' | 'withdrawn';
  readonly withdrawnBy?: string;
  readonly withdrawnAt?: string;
  readonly withdrawnReason?: string;
}

export interface ModelRegistryStore {
  readonly approvals: (tenantId: string) => Promise<readonly ApprovedModel[]> | readonly ApprovedModel[];
  readonly withdrawals: (tenantId: string) => Promise<readonly ModelWithdrawal[]> | readonly ModelWithdrawal[];
  readonly approve: (tenantId: string, model: ApprovedModel) => Promise<void> | void;
  readonly withdraw: (tenantId: string, w: ModelWithdrawal) => Promise<void> | void;
}

const TIERS: readonly ModelTier[] = ['small', 'standard', 'complex'];
const RESIDENCIES: readonly DataResidency[] = ['india', 'outside_india'];
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

export function foldModels(approvals: readonly ApprovedModel[], withdrawals: readonly ModelWithdrawal[]): readonly RegisteredModel[] {
  const byId = new Map<string, ApprovedModel>();
  for (const a of approvals) if (!byId.has(a.modelId)) byId.set(a.modelId, a); // the first approval of an id stands
  return [...byId.values()].map((m) => {
    const w = withdrawals.find((x) => x.modelId === m.modelId);
    return w === undefined
      ? { ...m, state: 'approved' as const }
      : { ...m, state: 'withdrawn' as const, withdrawnBy: w.by, withdrawnAt: w.at, withdrawnReason: w.reason };
  });
}

export async function registeredModels(store: ModelRegistryStore, tenantId: string): Promise<readonly RegisteredModel[]> {
  return foldModels(await store.approvals(tenantId), await store.withdrawals(tenantId));
}

/** The approved model serving a tier now — the newest approval not withdrawn — or undefined (the gateway refuses). */
export async function approvedModelFor(store: ModelRegistryStore, tenantId: string, tier: ModelTier): Promise<RegisteredModel | undefined> {
  const live = (await registeredModels(store, tenantId)).filter((m) => m.state === 'approved' && m.tier === tier);
  return [...live].sort((a, b) => (a.approvedAt < b.approvedAt ? 1 : -1))[0];
}

function refuse(status: number, code: string, whatHappened: string, nextSafeAction: string): never {
  throw apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });
}
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export function modelRegistryRoutes(deps: {
  readonly registry: ModelRegistryStore;
  readonly evaluationRuns: (tenantId: string) => Promise<readonly EvaluationRunRecord[]> | readonly EvaluationRunRecord[];
  readonly now: () => string;
}): readonly Route[] {
  return [
    {
      api: 'API-13', method: 'GET', path: '/v1/ai/models',
      permission: 'ai.proposal.read',
      handler: async (ctx) => {
        const models = await registeredModels(deps.registry, ctx.tenantId);
        return {
          status: 200,
          body: {
            models, approvedCount: models.filter((m) => m.state === 'approved').length,
            said: models.some((m) => m.state === 'approved')
              ? 'Only these models may be called, and only through the governed call.'
              : 'No model is approved, so no model can be called at all (OB-296: the agents work on rules; no live provider, no AI cost).',
            asAt: deps.now(),
          },
        };
      },
    },
    {
      // Approve a model for a tier. Body: { modelId, adapterId, tier, dataResidency, evaluationRunId }.
      api: 'API-13', method: 'POST', path: '/v1/ai/models',
      permission: 'ai.model.approve', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['modelId']) || !ID.test(b['modelId'] as string) || !isStr(b['adapterId']) || !ID.test(b['adapterId'] as string)
          || !TIERS.includes(b['tier'] as ModelTier) || !RESIDENCIES.includes(b['dataResidency'] as DataResidency) || !isStr(b['evaluationRunId'])) {
          refuse(400, 'not_readable_as_a_model_approval', 'A model approval needs { modelId, adapterId (no keys, no URLs), tier: small | standard | complex, dataResidency: india | outside_india, evaluationRunId }.', 'Nothing was approved.');
        }
        const modelId = (b['modelId'] as string).trim();
        if ((await registeredModels(deps.registry, ctx.tenantId)).some((m) => m.modelId === modelId)) {
          refuse(409, 'model_already_on_the_register', `${modelId} is already on the register; a withdrawn model is not re-approved under the same id.`, 'Use a new model id for a new version. Nothing was changed.');
        }
        const run = (await deps.evaluationRuns(ctx.tenantId)).find((r) => r.runId === b['evaluationRunId']);
        if (run === undefined) refuse(404, 'no_such_evaluation_run', `There is no evaluation run "${String(b['evaluationRunId'])}".`, 'Run the evaluation first (POST /v1/ai/evaluations/:agent) against this model. Nothing was approved.');
        if (!run.complete || run.unsafe > 0 || !run.fitToFacePeople) {
          refuse(409, 'evaluation_not_passed', `Run ${run.runId} (${run.agent}) is not a pass: ${run.complete ? '' : 'not every case reached the model; '}${run.unsafe} unsafe case(s); ${run.passed}/${run.total} passed — ${run.detail}`, 'Only a model that passed the whole evaluation, with nothing unsafe, can be approved. Nothing was approved.');
        }
        const model: ApprovedModel = {
          modelId, adapterId: (b['adapterId'] as string).trim(), tier: b['tier'] as ModelTier, dataResidency: b['dataResidency'] as DataResidency,
          approvedBy: ctx.userId, approvedAt: deps.now(), evaluationRunId: run.runId,
          evaluation: { agent: run.agent, passed: run.passed, total: run.total, scoreBps: run.scoreBps },
        };
        await deps.registry.approve(ctx.tenantId, model);
        return { status: 201, body: { model: { ...model, state: 'approved' } } };
      },
    },
    {
      // Withdraw an approval — the gateway refuses that model from the next call. Body: { reason }.
      api: 'API-13', method: 'POST', path: '/v1/ai/models/:modelId/withdraw',
      permission: 'ai.model.approve', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['reason'])) refuse(400, 'withdrawal_needs_a_reason', 'Withdrawing a model needs a reason.', 'Nothing was changed.');
        const modelId = ctx.params['modelId'] ?? '';
        const m = (await registeredModels(deps.registry, ctx.tenantId)).find((x) => x.modelId === modelId);
        if (m === undefined) refuse(404, 'no_such_model', `${modelId} is not on the register.`, 'Nothing was changed.');
        if (m.state === 'withdrawn') refuse(409, 'model_already_withdrawn', `${modelId} was withdrawn by ${m.withdrawnBy ?? ''} at ${m.withdrawnAt ?? ''}.`, 'Nothing was changed.');
        const w: ModelWithdrawal = { modelId, by: ctx.userId, at: deps.now(), reason: (b['reason'] as string).trim() };
        await deps.registry.withdraw(ctx.tenantId, w);
        return { status: 200, body: { ...w, state: 'withdrawn' } };
      },
    },
  ];
}
