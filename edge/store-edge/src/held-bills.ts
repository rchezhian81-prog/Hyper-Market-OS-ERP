// HELD BASKETS — parked on this store computer's disk, recalled once (Wave 4 · audit PF-05 · M12-FR-02 · P-01 · hard
// rules #1, #2, #6).
//
// Before this, "Hold" on the served till flipped a flag in the browser: a reload, a closed tab or a power blink and the
// customer's basket was gone, and the cashier rang forty items again from memory. Now the till hands the basket to THIS
// register, which keeps it as serialised state on an fsync'd log before it answers — the rules are the tested ones in
// `packages/suspended-sales` (empty basket refused, a lane's limit, a reason when the shop requires one):
//
//   • a recall is a CLAIM: it succeeds once, and every later attempt is refused naming the lane that has it — two tills
//     recalling one basket is a double charge;
//   • another lane may recall a basket only when the shop's policy says so (the store pack's `suspensionPolicy`; default:
//     only the lane that held it);
//   • a basket parked longer than the shop's price window comes back marked "re-price before taking money";
//   • nothing is ever deleted (hard rule #6) — every hold, recall and abandonment stays on the log.
//
// A held basket holds no stock: it is a note of intent, not a movement.

import type { OpenFileLog } from './file-log';
import { openFileLog, readLog } from './file-log';
import {
  suspendBill, resumeBill, abandonBill, SerialisedSuspendedBillStore,
  type SuspendedBill, type SuspendedLine, type SuspendedAgeAnswer, type SuspensionPolicy,
} from '../../../packages/suspended-sales/src/suspended-bill';

export type HoldOutcome =
  | { readonly held: true; readonly billId: string; readonly lineCount: number; readonly laneMessage: string }
  | { readonly held: false; readonly refusedBecause: string; readonly laneMessage: string };

export type RecallOutcome =
  | { readonly recalled: true; readonly bill: SuspendedBill; readonly repriceRequired: boolean; readonly minutesParked: number; readonly laneMessage: string }
  | { readonly recalled: false; readonly refusedBecause: string; readonly laneMessage: string };

export interface HeldSummary {
  readonly billId: string;
  readonly laneId: string;
  readonly cashierId: string;
  readonly heldAt: string;
  readonly lineCount: number;
  readonly valueMinor: number;
  readonly firstItem: string;
  readonly reason?: string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/** A line the till sent, read strictly — a line the box cannot read is a basket it will not pretend to keep. */
function lineOf(v: unknown): SuspendedLine | undefined {
  if (!isObj(v)) return undefined;
  if (!isStr(v['lineId']) || !isStr(v['productId']) || typeof v['description'] !== 'string' || !int(v['unitPriceMinor'])
    || !int(v['quantityMinor']) || !isStr(v['uom']) || !int(v['taxBps'])) return undefined;
  return {
    lineId: v['lineId'], productId: v['productId'], description: v['description'], unitPriceMinor: v['unitPriceMinor'],
    quantityMinor: v['quantityMinor'], uom: v['uom'], taxBps: v['taxBps'], voided: v['voided'] === true,
    ...(isStr(v['group']) ? { group: v['group'] } : {}),
    ...(isStr(v['hsnCode']) ? { hsnCode: v['hsnCode'] } : {}),
    ...(int(v['minimumAge']) && v['minimumAge'] > 0 ? { minimumAge: v['minimumAge'] } : {}),
    ...(isStr(v['voidReason']) ? { voidReason: v['voidReason'] } : {}),
  };
}
function answerOf(v: unknown): SuspendedAgeAnswer | undefined {
  if (!isObj(v) || !int(v['minimumAge']) || (v['outcome'] !== 'confirmed' && v['outcome'] !== 'refused') || !isStr(v['by']) || !isStr(v['at'])) return undefined;
  return { minimumAge: v['minimumAge'], outcome: v['outcome'], by: v['by'], at: v['at'], ...(isStr(v['productId']) ? { productId: v['productId'] } : {}) };
}

const WORDS: Readonly<Record<string, string>> = {
  empty_basket: 'There is nothing in the basket to hold.',
  reason_required: 'This shop needs a reason to hold a basket. Nothing was held — give a reason.',
  lane_limit_reached: 'This till already holds as many baskets as the shop allows. Recall one before holding another.',
  not_found: 'That held basket is not on this store computer.',
  already_resumed: 'That basket was already recalled — ringing it again would charge the customer twice.',
  abandoned: 'That basket was given up. Start a new sale.',
  other_lane: 'That basket was held on another till, and this shop does not allow recalling it here.',
  other_store: 'That basket belongs to another shop.',
};

export class HeldBills {
  private readonly bills: SerialisedSuspendedBillStore;
  /** One change at a time: two tabs recalling the same basket are answered in turn, so only one gets it. */
  private queue: Promise<unknown> = Promise.resolve();
  readonly unreadableRecords: number;

  private constructor(
    private readonly log: OpenFileLog,
    private readonly deps: {
      readonly policy: () => SuspensionPolicy | null;
      readonly storeId: () => string;
      readonly tenantId: string;
      readonly now: () => string;
    },
    restored: readonly SuspendedBill[],
    unreadable: number,
  ) {
    this.unreadableRecords = unreadable;
    this.bills = new SerialisedSuspendedBillStore();
    // The log holds every state each basket passed through; the latest line per basket is its state now.
    for (const b of restored) this.bills.put(b);
  }

  static async open(input: {
    readonly dataDir: string;
    readonly capacityBytes: number;
    readonly tenantId: string;
    readonly policy: () => SuspensionPolicy | null;
    readonly storeId: () => string;
    readonly now?: () => string;
  }): Promise<HeldBills> {
    const log = await openFileLog({ dataDir: input.dataDir, capacityBytes: input.capacityBytes, fileName: 'held-bills.log' });
    const restored: SuspendedBill[] = [];
    let unreadable = 0;
    for (const v of await readLog(log.path)) {
      if (!v.ok) { unreadable += 1; continue; }
      try {
        const r = JSON.parse(v.record) as unknown;
        if (isObj(r) && isStr(r['billId']) && isStr(r['laneId']) && Array.isArray(r['lines'])) restored.push(r as unknown as SuspendedBill);
        else unreadable += 1;
      } catch { unreadable += 1; }
    }
    return new HeldBills(log, { policy: input.policy, storeId: input.storeId, tenantId: input.tenantId, now: input.now ?? (() => new Date().toISOString()) }, restored, unreadable);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Write the basket's new state to the disk, then make it the state here. A failed write changes nothing. */
  private async persist(bill: SuspendedBill): Promise<void> {
    await this.log.append(JSON.stringify(bill));
    this.bills.put(bill);
  }

  private policy(): SuspensionPolicy {
    return this.deps.policy() ?? {};
  }

  /** Park a basket for this lane, on the disk before the till hears "held". A re-sent hold (lost reply) is the same hold. */
  hold(input: { readonly laneId: string; readonly cashierId: string; readonly billId: unknown; readonly lines: unknown; readonly ageAnswers?: unknown; readonly tradingDay?: unknown; readonly reason?: unknown }): Promise<HoldOutcome> {
    return this.serial(async () => {
      if (!isStr(input.billId)) return { held: false, refusedBecause: 'bill_id_missing', laneMessage: 'The till did not say which basket this is. Nothing was held — try again.' };
      const raw = Array.isArray(input.lines) ? input.lines : [];
      const lines = raw.map(lineOf);
      if (lines.some((l) => l === undefined)) return { held: false, refusedBecause: 'basket_not_readable', laneMessage: 'The store computer could not read this basket. Nothing was held — try again.' };
      const existing = this.bills.get(input.billId);
      if (existing !== undefined && existing.laneId === input.laneId && existing.state === 'suspended') {
        return { held: true, billId: existing.billId, lineCount: existing.lines.length, laneMessage: 'Basket held.' };
      }
      const answers = (Array.isArray(input.ageAnswers) ? input.ageAnswers : []).map(answerOf).filter((a): a is SuspendedAgeAnswer => a !== undefined);
      // Validated against a scratch copy first: the rules decide, the disk is written, and only then is the state here.
      const scratch = SerialisedSuspendedBillStore.hydrate(this.bills.serialise());
      const result = suspendBill({
        billId: input.billId, tenantId: this.deps.tenantId, storeId: this.deps.storeId(), laneId: input.laneId,
        cashierId: input.cashierId, tradingDay: isStr(input.tradingDay) ? input.tradingDay : this.deps.now().slice(0, 10),
        currency: 'INR', lines: lines as SuspendedLine[], at: this.deps.now(),
        ...(isStr(input.reason) ? { reason: input.reason } : {}),
        ...(answers.length === 0 ? {} : { ageAnswers: answers }),
      }, scratch, this.policy());
      if (!result.suspended || result.bill === undefined) {
        return { held: false, refusedBecause: result.outcome, laneMessage: WORDS[result.outcome] ?? result.detail };
      }
      try {
        await this.persist(result.bill);
      } catch (e) {
        return { held: false, refusedBecause: 'could_not_write_durably', laneMessage: `The store computer could not save the basket, so it is still on the till — do not clear it. ${e instanceof Error ? e.message : String(e)}` };
      }
      return { held: true, billId: result.bill.billId, lineCount: result.bill.lines.length, laneMessage: 'Basket held. Recall it from any reload of this till.' };
    });
  }

  /** The baskets this lane may recall — its own, or every lane's when the shop allows recalling another lane's. */
  list(laneId: string): readonly HeldSummary[] {
    const cross = this.policy().allowCrossLaneRecall === true;
    return this.bills.list()
      .filter((b) => b.state === 'suspended' && (cross || b.laneId === laneId))
      .sort((a, b) => (a.suspendedAt < b.suspendedAt ? -1 : 1))
      .map((b) => ({
        billId: b.billId, laneId: b.laneId, cashierId: b.cashierId, heldAt: b.suspendedAt, lineCount: b.lines.length,
        valueMinor: b.lines.reduce((sum, l) => sum + l.unitPriceMinor * l.quantityMinor, 0),
        firstItem: b.lines[0]?.description ?? '',
        ...(b.reason === undefined ? {} : { reason: b.reason }),
      }));
  }

  /** Claim a held basket for this lane — once. The claim is on the disk before the till gets the lines. */
  recall(input: { readonly laneId: string; readonly byUserId: string; readonly billId: unknown }): Promise<RecallOutcome> {
    return this.serial(async () => {
      if (!isStr(input.billId)) return { recalled: false, refusedBecause: 'not_found', laneMessage: WORDS['not_found']! };
      const scratch = SerialisedSuspendedBillStore.hydrate(this.bills.serialise());
      const result = resumeBill({ billId: input.billId, byUserId: input.byUserId, onLaneId: input.laneId, storeId: this.deps.storeId(), at: this.deps.now() }, scratch, this.policy());
      if (!result.resumed || result.bill === undefined) {
        const who = result.outcome === 'already_resumed' && result.bill?.resumedOnLaneId !== undefined ? ` (recalled on ${result.bill.resumedOnLaneId})` : '';
        return { recalled: false, refusedBecause: result.outcome, laneMessage: `${WORDS[result.outcome] ?? result.detail}${who}` };
      }
      try {
        await this.persist(result.bill);
      } catch (e) {
        return { recalled: false, refusedBecause: 'could_not_write_durably', laneMessage: `The store computer could not record the recall, so the basket stays held. ${e instanceof Error ? e.message : String(e)}` };
      }
      const reprice = result.repriceRequired === true;
      return {
        recalled: true, bill: result.bill, repriceRequired: reprice, minutesParked: result.minutesParked ?? 0,
        laneMessage: reprice
          ? `This basket was held ${result.minutesParked ?? 0} minutes — longer than the shop's price window. Check each price against the shelf before taking money.`
          : 'Basket recalled.',
      };
    });
  }

  /** Give a held basket up — kept, with who and why (hard rule #6), never deleted. */
  abandon(input: { readonly laneId: string; readonly byUserId: string; readonly billId: unknown; readonly reason: unknown }): Promise<{ readonly abandoned: boolean; readonly laneMessage: string }> {
    return this.serial(async () => {
      if (!isStr(input.billId)) return { abandoned: false, laneMessage: WORDS['not_found']! };
      const held = this.bills.get(input.billId);
      if (held !== undefined && held.laneId !== input.laneId && this.policy().allowCrossLaneRecall !== true) {
        return { abandoned: false, laneMessage: WORDS['other_lane']! };
      }
      const scratch = SerialisedSuspendedBillStore.hydrate(this.bills.serialise());
      const result = abandonBill({ billId: input.billId, byUserId: input.byUserId, reason: isStr(input.reason) ? input.reason : '', at: this.deps.now() }, scratch);
      if (!result.abandoned || result.bill === undefined) return { abandoned: false, laneMessage: result.detail };
      try {
        await this.persist(result.bill);
      } catch (e) {
        return { abandoned: false, laneMessage: `The store computer could not record it, so the basket stays held. ${e instanceof Error ? e.message : String(e)}` };
      }
      return { abandoned: true, laneMessage: 'Basket given up. It stays on the record.' };
    });
  }

  async close(): Promise<void> {
    await this.log.close();
  }
}
