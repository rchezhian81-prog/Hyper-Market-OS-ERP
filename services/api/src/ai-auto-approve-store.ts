// The store behind the owner-set auto-approve limits (CR-01 OI-12). Append-only on its own stream under the AI stream
// (hard rules 2, 6): a request, a confirmation, a refusal, a stop and a rule decision are each a NEW fact; nothing is ever
// edited or deleted. An auto-approval is written onto the proposal-decision register under the SAME idempotency key a
// person's decision uses (ai-governance-stores.ts), so a draft is decided once — by a person or by a rule, never both
// (hard rule 10: the second collapses on the first and the register shows which).
//
// Stream names are computed inside functions, never at module load (adapters.ts is still loading when this is imported).

import { createHash, randomUUID } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore, PersistedEvent } from '../../../packages/persistence/src/event-store';
import type { AgentId, AutoApproveDecision, AutoApproveRequest, AutoApproveConfirmation, AutoApproveStop } from '../../../packages/ai/src/index';
import { STREAM, streamName } from './adapters';
import { aiGovernanceStore } from './ai-governance-stores';
import type { AutoApproveStore, AutoApproveDeps, OpenDraft } from '../../ai/src/auto-approve';

const payloadOf = <T>(e: PersistedEvent): T => e.event.payload as T;
const all = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<readonly T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => payloadOf<T>(e));
const digest = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 24);

const streams = () => ({
  rules: streamName(STREAM.ai, 'auto-approve'),
  outcomes: streamName(STREAM.ai, 'proposal-outcomes'),
  holds: streamName(STREAM.ai, 'auto-approve-holds'),
});

async function append(store: EventStore, tenantId: string, stream: string, type: string, key: string, at: string, payload: unknown): Promise<void> {
  const d = digest(`${tenantId}-${type}-${key}`);
  await store.append(tenantId, stream, makeEvent({ id: `${type}-${d}`, type, occurredAt: at, idempotencyKey: `${type}-${tenantId}-${d}`, source: 'api/ai', payload }));
}

export function autoApproveStore(input: { readonly store: EventStore }): AutoApproveStore {
  const { store } = input;
  return {
    requests: (t) => all<AutoApproveRequest>(store, t, streams().rules, 'AiAutoApproveRequested'),
    confirmations: async (t) => [
      ...await all<AutoApproveConfirmation>(store, t, streams().rules, 'AiAutoApproveConfirmed'),
      ...await all<AutoApproveConfirmation>(store, t, streams().rules, 'AiAutoApproveRefused'),
    ],
    stops: (t) => all<AutoApproveStop>(store, t, streams().rules, 'AiAutoApproveStopped'),
    recordRequest: (t, r) => append(store, t, streams().rules, 'AiAutoApproveRequested', r.requestId, r.requestedAt, r),
    // ONE key per request for either decision, so two people deciding at once cannot both land.
    recordConfirmation: async (t, c) => {
      const d = digest(`${t}-aa-decision-${c.requestId}`);
      const type = c.decision === 'confirmed' ? 'AiAutoApproveConfirmed' : 'AiAutoApproveRefused';
      await store.append(t, streams().rules, makeEvent({ id: `aa-decision-${d}`, type, occurredAt: c.at, idempotencyKey: `aa-decision-${t}-${d}`, source: 'api/ai', payload: c }));
    },
    recordStop: (t, s) => append(store, t, streams().rules, 'AiAutoApproveStopped', s.stopId, s.at, s),
    decisions: async (t) => [
      ...await all<AutoApproveDecision>(store, t, streams().outcomes, 'AIDraftAutoApproved'),
      ...await all<AutoApproveDecision>(store, t, streams().holds, 'AIDraftHeldForAPerson'),
    ],
    recordDecision: async (t, dec) => {
      if (dec.outcome === 'auto_approved') {
        // The same key as a person's decision on this proposal (ai-governance-stores.ts recordProposalOutcome).
        const d = digest(`${t}-outcome-${dec.proposalId}`);
        await store.append(t, streams().outcomes, makeEvent({ id: `ai-outcome-${d}`, type: 'AIDraftAutoApproved', occurredAt: dec.at, idempotencyKey: `ai-outcome-${t}-${d}`, source: 'api/ai', payload: dec }));
        return;
      }
      await append(store, t, streams().holds, 'AIDraftHeldForAPerson', `${dec.proposalId}-${dec.because}`, dec.at, dec);
    },
  };
}

/** Everything the auto-approve routes and the run route's after-step need, over one event store. */
export function autoApproveDeps(input: {
  readonly store: EventStore;
  readonly now: () => string;
  readonly openProposals: (tenantId: string) => Promise<readonly OpenDraft[]> | readonly OpenDraft[];
  readonly aiStopped: (tenantId: string, agent: AgentId) => Promise<boolean> | boolean;
  /** CR-01 step 6b (OB-760 A): the placer (services/api/src/ai-auto-approve-executor.ts). Absent → the approval is only recorded. */
  readonly place?: AutoApproveDeps['place'];
}): AutoApproveDeps {
  const store = autoApproveStore({ store: input.store });
  return {
    store,
    openProposals: input.openProposals,
    decidedProposalIds: async (t) => {
      const people = await aiGovernanceStore({ store: input.store, now: input.now }).proposalOutcomes(t);
      // A draft the rule approved — and one whose route REFUSED the rule's placing (step 6b): that one now waits for a person
      // and the rule never tries it again (never retried silently).
      const rules = (await store.decisions(t)).filter((d) => d.outcome === 'auto_approved' || d.because === 'refused_by_route');
      return new Set([...people.map((o) => o.proposalId), ...rules.map((d) => d.proposalId)]);
    },
    aiStopped: input.aiStopped,
    ...(input.place === undefined ? {} : { place: input.place }),
    now: input.now,
    newId: () => randomUUID(),
  };
}
