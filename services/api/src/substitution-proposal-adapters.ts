// OB-687 · FUL-14 · M19-FR-02 — head office's wiring for a substitute the customer answers (services/fulfilment/src/
// substitution-proposals.ts). Every register is append-only on its own stream (hard rules #2 #6): a proposal is kept once on
// the ORDER's register and the WAVE's register in one write (keyed on the proposal); a settlement once (keyed on the
// proposal); the owner's wait as a new version each time. The yes / no is FUL-14's consent register (substitutionTruth), the
// order's swap goes through the one substitution path (`recordSubstitutionDecision`). Nothing here edits or deletes a record.

import { createHash } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { recordSubstitutionDecision, type OrdersDeps } from '../../orders/src/index';
import type { SubstitutionProposal, ProposalSettlement, SubstitutionWaitChange, SubstitutionProposalDeps } from '../../fulfilment/src/substitution-proposals';
import { STREAM, streamName, permissionsHeldBy } from './adapters';

const S = {
  ofOrder: (orderId: string) => streamName(STREAM.orders, 'substitution-proposals', orderId),
  ofWave: (waveId: string) => streamName(STREAM.delivery, 'wave-proposals', waveId),
  wait: streamName(STREAM.delivery, 'substitution-wait'),
};
const digest = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 24);
const payloads = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);

/** OB-687: the registers and the ports the proposals module needs, over the shop's event store and FUL-14's stored truth. */
export function substitutionProposalAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  /** The orders composition — its substitution truth (prices, attributes, rules, consents) and the one substitution path. */
  readonly orders: OrdersDeps & { readonly placedOrder: (tenantId: string, orderId: string) => Promise<{ readonly lines: readonly { readonly productId: string; readonly quantityMinor: number }[]; readonly state: string } | undefined> | { readonly lines: readonly { readonly productId: string; readonly quantityMinor: number }[]; readonly state: string } | undefined };
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}): SubstitutionProposalDeps {
  const { store } = input;
  const truth = input.orders.substitutionTruth;
  if (truth === undefined) throw new Error('OB-687: the substitution proposals need FUL-14\'s stored truth (substitutionTruth) in the orders composition.');
  return {
    now: input.now,
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
    permissionsOfUser: (tenantId, userId) => permissionsHeldBy(store, tenantId, userId),
    proposalsOfOrder: (tenantId, orderId) => payloads<SubstitutionProposal>(store, tenantId, S.ofOrder(orderId), 'SubstitutionProposalRecorded'),
    proposalsOfWave: (tenantId, waveId) => payloads<SubstitutionProposal>(store, tenantId, S.ofWave(waveId), 'SubstitutionProposalRecorded'),
    recordProposal: async (tenantId, p) => {
      const d = digest(p.proposalId);
      const event = (stream: string) => ({ stream, event: makeEvent({
        id: `sub-proposal-${stream === S.ofWave(p.waveId) ? 'w' : 'o'}-${d}`, type: 'SubstitutionProposalRecorded', occurredAt: p.receivedAt,
        idempotencyKey: `sub-proposal-${tenantId}-${stream === S.ofWave(p.waveId) ? 'w' : 'o'}-${d}`, source: 'api/fulfilment', payload: p as unknown as Record<string, unknown>,
      }) });
      await store.appendBatch(tenantId, [event(S.ofOrder(p.orderId)), event(S.ofWave(p.waveId))]);
    },
    settlements: (tenantId, orderId) => payloads<ProposalSettlement>(store, tenantId, S.ofOrder(orderId), 'SubstitutionProposalSettled'),
    recordSettlement: async (tenantId, st) => {
      const d = digest(st.proposalId);
      await store.append(tenantId, S.ofOrder(st.orderId), makeEvent({
        id: `sub-proposal-settled-${d}`, type: 'SubstitutionProposalSettled', occurredAt: st.at,
        idempotencyKey: `sub-proposal-settled-${tenantId}-${d}`, source: 'api/fulfilment', payload: st as unknown as Record<string, unknown>,
      }));
    },
    waitHistory: (tenantId) => payloads<SubstitutionWaitChange>(store, tenantId, S.wait, 'SubstitutionWaitSet'),
    recordWait: async (tenantId, c) => {
      await store.append(tenantId, S.wait, makeEvent({
        id: `sub-wait-${c.version}`, type: 'SubstitutionWaitSet', occurredAt: c.setAt,
        idempotencyKey: `sub-wait-${tenantId}-${c.version}`, source: 'api/fulfilment', payload: c as unknown as Record<string, unknown>,
      }));
    },
    order: async (tenantId, orderId) => {
      const placed = await input.orders.placedOrder(tenantId, orderId);
      if (placed === undefined) return undefined;
      const state = await input.orders.orderState(tenantId, orderId);
      return { lines: placed.lines, state: state?.state ?? placed.state };
    },
    product: (tenantId, productId) => truth.product(tenantId, productId),
    rulesFor: (tenantId, orderId) => truth.rulesFor(tenantId, orderId),
    consents: (tenantId, orderId) => truth.consents(tenantId, orderId),
    recordConsent: (tenantId, c) => truth.recordConsent(tenantId, c),
    // The ONE substitution path — exactly what `POST /v1/orders/:orderId/substitute` runs (OB-687).
    applyDecision: (tenantId, i) => recordSubstitutionDecision(input.orders, { tenantId, userId: i.userId, orderId: i.orderId, offer: i.offer, decision: i.decision, body: {} }),
  };
}

/** A composition with no store (the bare surface): the routes exist and hold nothing — every read is empty, nothing is kept. */
export function bareProposalDeps(now: () => string): SubstitutionProposalDeps {
  const none = async () => [] as never[];
  return {
    now, permissionsOfUser: async () => undefined, proposalsOfOrder: none, proposalsOfWave: none, recordProposal: async () => {},
    settlements: none, recordSettlement: async () => {}, waitHistory: none, recordWait: async () => {},
    order: async () => undefined, product: async () => undefined, rulesFor: async () => undefined, consents: none, recordConsent: async () => {},
    applyDecision: async () => { throw new Error('no orders composition'); },
  };
}
