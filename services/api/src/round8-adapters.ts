// Round 8 registers, each append-only on its own stream (hard rules #2, #6):
//   • the replies a PERSON sent from an approved AI draft, and the root causes recorded on resolved cases (WF-17 · M21);
//   • the A07 anomaly summaries a security officer reads (roadmap §7);
// and the domain readers the A05 / A07 drafting legs ask over (the order a case is about, the shop's service policy, the
// rule breaches the store's rules raised). Reads fold the streams; nothing here edits a record.

import { createHash } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { EvidenceItem } from '../../../packages/ai/src/index';
import type { SentReply, RootCauseRecord } from '../../customer/src/service-cases';
import type { AnomalySummary } from '../../ai/src/drafting-legs';
import type { RaisedException } from '../../pos/src/loss-prevention';
import type { PlacedOrder, OrderTransition } from '../../orders/src/index';
import { STREAM, streamName } from './adapters';

const SENT_REPLIES = streamName(STREAM.service, 'sent-replies');
const ROOT_CAUSES = streamName(STREAM.service, 'root-causes');
const ANOMALY_SUMMARIES = streamName(STREAM.ai, 'anomaly-summaries');

const digest = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 16);
const all = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);

export function serviceDeskExtrasAdapter(input: { readonly store: EventStore; readonly now: () => string }) {
  return {
    sentReplies: async (tenantId: string, caseId: string): Promise<readonly SentReply[]> =>
      (await all<SentReply>(input.store, tenantId, SENT_REPLIES, 'ServiceReplySent')).filter((r) => r.caseId === caseId),
    recordSentReply: async (tenantId: string, rec: SentReply, key: string): Promise<void> => {
      const d = digest(key);
      await input.store.append(tenantId, SENT_REPLIES, makeEvent({
        id: `service-reply-${d}`, type: 'ServiceReplySent', occurredAt: rec.at,
        // One send per draft: the key is the case and the draft, so a re-sent request is the same fact.
        idempotencyKey: `service-reply-${tenantId}-${d}`, source: 'api/customer', payload: rec,
      }));
    },
    rootCauses: (tenantId: string): Promise<readonly RootCauseRecord[]> => all<RootCauseRecord>(input.store, tenantId, ROOT_CAUSES, 'ServiceRootCauseRecorded'),
    recordRootCause: async (tenantId: string, rec: RootCauseRecord, key: string): Promise<void> => {
      const d = digest(key);
      await input.store.append(tenantId, ROOT_CAUSES, makeEvent({
        id: `service-root-cause-${d}`, type: 'ServiceRootCauseRecorded', occurredAt: rec.at,
        idempotencyKey: `service-root-cause-${tenantId}-${d}`, source: 'api/customer', payload: rec,
      }));
    },
  };
}

export function anomalySummaryAdapter(input: { readonly store: EventStore; readonly now: () => string }) {
  return {
    anomalySummaries: (tenantId: string): Promise<readonly AnomalySummary[]> => all<AnomalySummary>(input.store, tenantId, ANOMALY_SUMMARIES, 'AiAnomalySummaryRecorded'),
    recordAnomalySummary: async (tenantId: string, s: AnomalySummary): Promise<void> => {
      await input.store.append(tenantId, ANOMALY_SUMMARIES, makeEvent({
        id: `ai-anomaly-summary-${s.summaryId}`, type: 'AiAnomalySummaryRecorded', occurredAt: s.at,
        idempotencyKey: `ai-anomaly-summary-${tenantId}-${s.summaryId}`, source: 'api/ai', payload: s,
      }));
    },
    /** PF-07: the breaches the store's own rules raised, latest per exception — evidence the A07 summary may cite. */
    raisedExceptionFacts: async (tenantId: string): Promise<readonly EvidenceItem[]> => {
      const latest = new Map<string, RaisedException>();
      for (const r of await all<RaisedException>(input.store, tenantId, streamName(STREAM.lossPrevention, 'raised'), 'LpExceptionRaised')) latest.set(r.exceptionId, r);
      return [...latest.values()].sort((a, b) => a.exceptionId.localeCompare(b.exceptionId)).map((r) => ({
        evidenceId: `lp-raised:${r.exceptionId}`, source: 'loss-prevention rule breaches', untrusted: false,
        content: `${r.exceptionId} on ${r.day}: cashier ${r.cashierId}, ${r.kind} ${r.breach} — ${r.observed} against a limit of ${r.limit} (${r.severity}); linked ${r.linkedTxnIds.join(', ')}`,
      }));
    },
  };
}

/** The order a case is about, in words, from the order register (its placed record and its latest step). */
export async function orderFactsFor(store: EventStore, tenantId: string, orderId: string): Promise<string | undefined> {
  const stream = streamName(STREAM.orders, orderId);
  const placed = (await all<PlacedOrder>(store, tenantId, stream, 'OrderPlaced'))[0];
  if (placed === undefined) return undefined;
  const steps = await all<OrderTransition>(store, tenantId, stream, 'OrderTransitioned');
  const state = steps.at(-1)?.to ?? placed.state;
  return `order ${orderId}: placed ${placed.placedAt} at ${placed.locationId}, ${placed.lines.length} line(s), now ${state}${placed.fulfilment === undefined ? '' : `, for ${placed.fulfilment}`}`;
}
