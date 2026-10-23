// Till bill and GST package (audit-1 P5 · audit-2 P3) — the small durable stores head office keeps for it, on the shared
// append-only event store (hard rule #2). Self-contained: it imports nothing from `adapters.ts`, so `adapters.ts` can
// import it (one registration line each) without an import cycle. The stream names use the same unit separator as
// `adapters.ts` `streamName`.

import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import { readCessRate, type CessRate, type CessRatePeriod } from '../../../packages/finance/src/cess';
import type { CessRateDeps } from '../../catalogue/src/cess-rates';

const PART = '\u001f';
const stream = (...parts: readonly string[]): string => {
  for (const p of parts) if (p.includes(PART)) throw new RangeError('a stream name part may not contain the unit separator');
  return parts.join(PART);
};

/**
 * A7: the compensation cess a banked sale line was charged under (frozen from the lane's signed pack), for the GST return's
 * fold — `{}` when the line carries none, so a line without cess reads exactly as before.
 */
export function frozenCessOf(line: unknown): { readonly cess?: CessRate } {
  const c = line !== null && typeof line === 'object' ? readCessRate((line as Record<string, unknown>)['cess']) : undefined;
  return c === undefined ? {} : { cess: c };
}

/** Every payload of one event type on a stream, in append order. */
async function payloads<T>(store: EventStore, tenantId: string, name: string, type: string): Promise<T[]> {
  return (await store.readStream(tenantId, name, { type })).map((e) => e.event.payload as T);
}

/**
 * A7: the compensation-cess schedule per HSN — a `CessRateSet` period per change on `catalogue␟cess-rates␟<hsn>`.
 * Read by the cess routes and by the catalogue pack assembly (`cataloguePreviewAdapter.cessSchedule`).
 */
export function cessRateStore(input: { readonly store: EventStore; readonly now: () => string }): CessRateDeps {
  const forHsn = (hsn: string): string => stream('catalogue', 'cess-rates', hsn);
  return {
    setCess: async (tenantId, hsnCode, period, key) => {
      await input.store.append(tenantId, forHsn(hsnCode), makeEvent({
        id: `cess-rate-${hsnCode}-${period.effectiveFrom}-${key}`,
        type: 'CessRateSet',
        occurredAt: input.now(),
        idempotencyKey: `cess-rate-${tenantId}-${hsnCode}-${period.effectiveFrom}-${key}`,
        source: 'api/catalogue',
        payload: period,
      }));
    },
    schedule: (tenantId, hsnCode) => payloads<CessRatePeriod>(input.store, tenantId, forHsn(hsnCode), 'CessRateSet'),
  };
}
