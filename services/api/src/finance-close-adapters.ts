// Round 9 (Batch 3) finance registers — each append-only on its own stream (hard rules #2, #6):
//   • OB-55: the card/UPI payments a store's day close carried forward to head office, their one resolution, conflicts;
// Reads fold the streams; nothing here edits a record.

import { createHash } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { DayCloseRecord, CarriedPaymentIn } from '../../pos/src/day-close';
import type { PaymentException, PaymentExceptionResolution, PaymentExceptionConflict, PaymentExceptionDeps } from '../../finance/src/payment-exceptions';
import { STREAM, streamName } from './adapters';

const digest = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 16);
const all = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);

// ── OB-55: payment exceptions carried forward from a store day close ─────────────────────────────────────────────

// Resolved at call time: this module and adapters.ts import each other (through the report producers).
const paymentExceptionsStream = (): string => streamName(STREAM.finance, 'payment-exceptions');

/** Each carried payment becomes ONE exception, keyed on its attempt id — a re-sent close carries nothing twice. */
export async function carryPaymentExceptionsIn(store: EventStore, tenantId: string, close: DayCloseRecord, payments: readonly CarriedPaymentIn[], at: string): Promise<void> {
  const cf = close.carriedForward;
  if (cf === undefined || payments.length === 0) return;
  await store.appendBatch(tenantId, payments.map((p) => {
    const e: PaymentException = {
      ...p, storeId: close.storeId, dayCloseId: close.dayCloseId, closedBy: close.closedBy, approvedBy: cf.approvedBy,
      approvalId: cf.approvalId, reason: cf.reason, carriedAt: at, governanceFlags: cf.flags,
    };
    return {
      stream: paymentExceptionsStream(),
      event: makeEvent({
        id: `payment-exception-${digest(p.attemptId)}`, type: 'PaymentExceptionCarried', occurredAt: at,
        idempotencyKey: `payment-exception-carried-${tenantId}-${p.attemptId}`, source: 'api/finance', payload: e,
      }),
    };
  }));
}

export function paymentExceptionsAdapter(input: { readonly store: EventStore; readonly now: () => string }): PaymentExceptionDeps {
  return {
    now: input.now,
    exceptions: async (tenantId) => {
      const seen = new Set<string>();
      return (await all<PaymentException>(input.store, tenantId, paymentExceptionsStream(), 'PaymentExceptionCarried')).filter((e) => (seen.has(e.attemptId) ? false : (seen.add(e.attemptId), true)));
    },
    resolutions: (tenantId) => all<PaymentExceptionResolution>(input.store, tenantId, paymentExceptionsStream(), 'PaymentExceptionResolved'),
    conflicts: (tenantId) => all<PaymentExceptionConflict>(input.store, tenantId, paymentExceptionsStream(), 'PaymentExceptionResolutionConflict'),
    recordResolution: async (tenantId, r) => {
      await input.store.append(tenantId, paymentExceptionsStream(), makeEvent({
        id: `payment-exception-resolved-${digest(r.attemptId)}`, type: 'PaymentExceptionResolved', occurredAt: r.resolvedAt,
        // ONE resolution per payment: a second arrival collapses here even if two raced past the route's check.
        idempotencyKey: `payment-exception-resolved-${tenantId}-${r.attemptId}`, source: 'api/finance', payload: r,
      }));
    },
    recordConflict: async (tenantId, c) => {
      const d = digest(`${c.attemptId}|${JSON.stringify(c.offered)}`);
      await input.store.append(tenantId, paymentExceptionsStream(), makeEvent({
        id: `payment-exception-conflict-${d}`, type: 'PaymentExceptionResolutionConflict', occurredAt: c.at,
        idempotencyKey: `payment-exception-conflict-${tenantId}-${d}`, source: 'api/finance', payload: c,
      }));
    },
  };
}
