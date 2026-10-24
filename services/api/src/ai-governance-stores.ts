// The stores behind the AI governance registers (OB-288 lane 4 · P1): scoped kill switches, per-agent limits, the
// free-text setting, people's decisions on proposals, the AI-incident register, blocked tool calls, the approved-model
// register and the evaluation runs. Every one is append-only on its own stream under the AI stream (hard rules #2, #6):
// a lift, a withdrawal, an owner or a close is a NEW fact beside the one it answers, never an edit of it.
//
// Stream names are computed inside functions, never at module load: adapters.ts re-exports the AI adapter, so this file
// is evaluated while adapters.ts is still loading.

import { createHash } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore, PersistedEvent } from '../../../packages/persistence/src/event-store';
import type { AgentId, KillSwitch } from '../../../packages/ai/src/index';
import { STREAM, streamName } from './adapters';
import {
  foldKillSwitches, stoppedByScopedSwitches,
  type AiGovernanceStore, type AgentLimit, type FreeTextSetting, type KillSwitchLift, type ProposalOutcome,
} from '../../ai/src/governance';
import type { AiIncidentStore, AiIncidentRaised, AiIncidentOwned, AiIncidentClosed, AiToolCallBlocked } from '../../ai/src/ai-incidents';
import type { ModelRegistryStore, ApprovedModel, ModelWithdrawal } from '../../ai/src/model-registry';
import type { EvaluationStore, EvaluationRunRecord } from '../../ai/src/evaluations';

const payloadOf = <T>(e: PersistedEvent): T => e.event.payload as T;
const all = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<readonly T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => payloadOf<T>(e));
const digest = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 24);

const streams = () => ({
  kill: streamName(STREAM.ai, 'kill-switches'),
  limits: streamName(STREAM.ai, 'agent-limits'),
  freeText: streamName(STREAM.ai, 'free-text'),
  outcomes: streamName(STREAM.ai, 'proposal-outcomes'),
  incidents: streamName(STREAM.ai, 'incidents'),
  blocked: streamName(STREAM.ai, 'blocked-tool-calls'),
  models: streamName(STREAM.ai, 'approved-models'),
  evaluations: streamName(STREAM.ai, 'evaluations'),
});

async function append(store: EventStore, tenantId: string, stream: string, type: string, key: string, at: string, payload: unknown): Promise<void> {
  const d = digest(`${tenantId}-${type}-${key}`);
  await store.append(tenantId, stream, makeEvent({ id: `${type}-${d}`, type, occurredAt: at, idempotencyKey: `${type}-${tenantId}-${d}`, source: 'api/ai', payload }));
}

/** Which agents the scoped switches stop now (the shop-wide master is read by the AI adapter itself). */
export async function stoppedAgentsNow(store: EventStore, tenantId: string): Promise<readonly AgentId[]> {
  const s = streams();
  const switches = foldKillSwitches(await all<KillSwitch>(store, tenantId, s.kill, 'AIKillSwitchActivated'), await all<KillSwitchLift>(store, tenantId, s.kill, 'AIKillSwitchLifted'));
  return stoppedByScopedSwitches(tenantId, switches);
}

export function aiGovernanceStore(input: { readonly store: EventStore; readonly now: () => string }): AiGovernanceStore {
  const { store } = input;
  return {
    killSwitches: async (tenantId) => {
      const s = streams();
      return foldKillSwitches(await all<KillSwitch>(store, tenantId, s.kill, 'AIKillSwitchActivated'), await all<KillSwitchLift>(store, tenantId, s.kill, 'AIKillSwitchLifted'));
    },
    // §30.2 AIKillSwitchActivated — one fact per switch, keyed on its id (a re-sent pull collapses).
    recordKillSwitch: (tenantId, ks) => append(store, tenantId, streams().kill, 'AIKillSwitchActivated', ks.switchId, ks.activatedAt, ks),
    recordKillSwitchLift: (tenantId, lift) => append(store, tenantId, streams().kill, 'AIKillSwitchLifted', lift.switchId, lift.liftedAt, lift),
    agentLimits: (tenantId) => all<AgentLimit>(store, tenantId, streams().limits, 'AiAgentLimitSet'),
    recordAgentLimit: (tenantId, l) => append(store, tenantId, streams().limits, 'AiAgentLimitSet', `${l.agentId}-${l.setAt}-${l.ceilingMinor}-${l.callsPerHour ?? ''}`, l.setAt, l),
    spendByAgent: async (tenantId) => {
      const out: Partial<Record<AgentId, number>> = {};
      for (const c of await all<{ readonly agent: AgentId; readonly costMinor: number }>(store, tenantId, STREAM.ai, 'AiRunCosted')) {
        out[c.agent] = (out[c.agent] ?? 0) + c.costMinor;
      }
      return out;
    },
    freeText: async (tenantId) => {
      const found = await store.latestOfType(tenantId, streams().freeText, 'AiFreeTextSet');
      // OB-296: nothing ever set → OFF.
      return found === undefined ? { enabled: false } : payloadOf<FreeTextSetting>(found);
    },
    recordFreeText: (tenantId, setting) => append(store, tenantId, streams().freeText, 'AiFreeTextSet', `${setting.at}-${String(setting.enabled)}`, setting.at, setting),
    proposalOutcomes: async (tenantId) => {
      const s = streams();
      const approved = await all<ProposalOutcome>(store, tenantId, s.outcomes, 'AIRecommendationApproved');
      const rejected = await all<ProposalOutcome>(store, tenantId, s.outcomes, 'AIRecommendationRejected');
      const first = new Map<string, ProposalOutcome>();
      for (const o of [...approved, ...rejected].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))) if (!first.has(o.proposalId)) first.set(o.proposalId, o);
      return [...first.values()];
    },
    // AIRecommendationApproved / AIRecommendationRejected — keyed on the proposal, so a second decision cannot land.
    // ONE key for either decision, so two people deciding at once cannot both land: the second collapses on the first.
    recordProposalOutcome: async (tenantId, o) => {
      const d = digest(`${tenantId}-outcome-${o.proposalId}`);
      const type = o.decision === 'approved' ? 'AIRecommendationApproved' : 'AIRecommendationRejected';
      await store.append(tenantId, streams().outcomes, makeEvent({ id: `ai-outcome-${d}`, type, occurredAt: o.at, idempotencyKey: `ai-outcome-${tenantId}-${d}`, source: 'api/ai', payload: o }));
    },
  };
}

export function aiIncidentStore(input: { readonly store: EventStore }): AiIncidentStore & {
  readonly recordBlocked: (tenantId: string, blocked: readonly AiToolCallBlocked[]) => Promise<void>;
  readonly blocked: (tenantId: string) => Promise<readonly AiToolCallBlocked[]>;
} {
  const { store } = input;
  return {
    raised: (tenantId) => all<AiIncidentRaised>(store, tenantId, streams().incidents, 'AiIncidentRaised'),
    owned: (tenantId) => all<AiIncidentOwned>(store, tenantId, streams().incidents, 'AiIncidentOwned'),
    closed: (tenantId) => all<AiIncidentClosed>(store, tenantId, streams().incidents, 'AiIncidentClosed'),
    raise: (tenantId, i) => append(store, tenantId, streams().incidents, 'AiIncidentRaised', i.incidentId, i.raisedAt, i),
    own: (tenantId, o) => append(store, tenantId, streams().incidents, 'AiIncidentOwned', o.incidentId, o.at, o),
    close: (tenantId, c) => append(store, tenantId, streams().incidents, 'AiIncidentClosed', c.incidentId, c.at, c),
    // §30.2 AIToolCallBlocked — one fact per dropped tool per call, in one atomic write.
    recordBlocked: async (tenantId, blocked) => {
      if (blocked.length === 0) return;
      const stream = streams().blocked;
      await store.appendBatch(tenantId, blocked.map((b) => {
        const d = digest(`${tenantId}-${b.callId}-${b.tool}`);
        return { stream, event: makeEvent({ id: `AIToolCallBlocked-${d}`, type: 'AIToolCallBlocked', occurredAt: b.at, idempotencyKey: `AIToolCallBlocked-${tenantId}-${d}`, source: 'api/ai', payload: b }) };
      }));
    },
    blocked: (tenantId) => all<AiToolCallBlocked>(store, tenantId, streams().blocked, 'AIToolCallBlocked'),
  };
}

export function modelRegistryStore(input: { readonly store: EventStore }): ModelRegistryStore {
  const { store } = input;
  return {
    approvals: (tenantId) => all<ApprovedModel>(store, tenantId, streams().models, 'AiModelApproved'),
    withdrawals: (tenantId) => all<ModelWithdrawal>(store, tenantId, streams().models, 'AiModelWithdrawn'),
    approve: (tenantId, m) => append(store, tenantId, streams().models, 'AiModelApproved', m.modelId, m.approvedAt, m),
    withdraw: (tenantId, w) => append(store, tenantId, streams().models, 'AiModelWithdrawn', w.modelId, w.at, w),
  };
}

export function evaluationStore(input: { readonly store: EventStore }): EvaluationStore {
  const { store } = input;
  return {
    runs: (tenantId) => all<EvaluationRunRecord>(store, tenantId, streams().evaluations, 'AiEvaluationRecorded'),
    record: (tenantId, run) => append(store, tenantId, streams().evaluations, 'AiEvaluationRecorded', run.runId, run.at, run),
  };
}
