// A self-checkout basket's evidence, kept on the store computer and carried to head office (R8-3 · R8-7 · M15 · §31 ·
// P-01 · hard rules #1, #2 and #6).
//
// After a customer-operated sale is SAVED (the till's own path, untouched), the lane hands this box one record: the bill,
// its total, every time a colleague was needed and how they settled it, and the basket's risk figure (or "not set"). The
// box judges it strictly, writes it to its device-events log (fsync'd) and only then queues it for head office as
// `SelfCheckoutBasketRecorded` — on the same dedupe set, cursor and dead-letter queue as every relayed record, so a lost
// reply and a retry are one fact. Nothing here is money: refusing it never touches the sale.
//
// It arrives on the till's own till-activity door (`POST /lane/till-activity`, kind `self_checkout_basket`), so it carries
// the session of the colleague signed in at the lane, verified by the box — and the payment the record names must have
// been confirmed by that same colleague, or it is refused by name.

import { makeEvent, type DomainEvent } from '../../../packages/contracts/src/event';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import { readBasketEvidence } from '../../../packages/self-checkout/src/basket-evidence';
import { commitLocally, type DurableLog } from './durability';

/** The event type head office's synced route takes it under. */
export const SELF_CHECKOUT_BASKET_EVENT = 'SelfCheckoutBasketRecorded';

export interface SelfCheckoutBasketDeps {
  readonly tenantId: string;
  /** Every device-event key this box has ever taken (shared with the device relay — one dedupe set). */
  readonly keys: Set<string>;
  readonly log: DurableLog;
  readonly outbox: SyncOutbox;
  readonly now: () => string;
  /** The shop's trading day an instant belongs to (the store pack's cut-off). */
  readonly tradingDayOf: (atIso: string) => string;
}

export type BasketAnswer = { readonly recorded: true; readonly laneMessage: string } | { readonly recorded: false; readonly refusedBecause: string; readonly laneMessage: string };

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= 120;
const whole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** The box's decision for one basket record (the lane's colleague already verified by the till door). */
export function selfCheckoutBasketRecorder(deps: SelfCheckoutBasketDeps): (input: { readonly laneId: string; readonly cashierId: string; readonly via: string; readonly body: Record<string, unknown> }) => Promise<BasketAnswer> {
  return async ({ laneId, cashierId, via, body }) => {
    const evidence = readBasketEvidence(body['selfCheckout']);
    if (!isStr(body['activityId']) || !isStr(body['billRef']) || !whole(body['valueMinor']) || evidence === undefined) {
      return { recorded: false, refusedBecause: 'not_readable', laneMessage: 'The lane did not say which bill, how much and what needed a colleague. The sale stands; tell the manager.' };
    }
    // The payment the basket was paid with was confirmed by the colleague signed in now — or the record is not believed.
    const paidBy = evidence.interventions.filter((i) => i.kind === 'payment' && i.outcome === 'approved').at(-1)?.settledBy;
    if (paidBy !== cashierId) {
      return { recorded: false, refusedBecause: 'payment_not_confirmed_by_this_colleague', laneMessage: 'The basket\'s payment was not confirmed by the colleague signed in at this lane. The sale stands; tell the manager.' };
    }
    const activityId = body['activityId'].trim();
    const key = `sco-basket-${deps.tenantId}-${activityId}`;
    if (deps.keys.has(key)) return { recorded: true, laneMessage: 'Already recorded.' };
    const at = deps.now();
    const event: DomainEvent = makeEvent({
      id: `sco-basket-${activityId}`, type: SELF_CHECKOUT_BASKET_EVENT, occurredAt: at, idempotencyKey: key, source: `store-box/${laneId}`,
      payload: {
        activityId, laneId, cashierId, via, billRef: body['billRef'].trim(), valueMinor: body['valueMinor'], at,
        tradingDay: deps.tradingDayOf(at), selfCheckout: evidence as unknown as Record<string, unknown>,
      },
    });
    deps.keys.add(key);
    const outcome = await commitLocally({ saleId: key, record: JSON.stringify(event), log: deps.log });
    if (!outcome.committed) {
      deps.keys.delete(key);
      return { recorded: false, refusedBecause: outcome.refusedBecause ?? 'could_not_write_durably', laneMessage: 'The store computer could not keep the basket\'s record. The sale stands; tell the manager.' };
    }
    deps.outbox.enqueue(event);
    return { recorded: true, laneMessage: 'Recorded.' };
  };
}
