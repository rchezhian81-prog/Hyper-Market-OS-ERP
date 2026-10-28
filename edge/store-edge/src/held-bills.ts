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
//
// R9-A · OB-533 (owner, 28 Oct 2026): a basket that rang a retail quotation up carries the quotation's number and the bill it
// was rung up on. GIVING IT UP frees the quotation again — the same compensating release as a cancelled bill (OB-523): a
// `QuotationFreedAtTill` record with who gave it up (the person this box verified) and why, on the box's disk, queued for head
// office and sent once (offline it waits). RECALLING it keeps the quotation attached: the till gets it back with the lines.
// A line lowered on the till (a quotation's price or a manager's cut) keeps its price evidence while parked.

import { tradingDayIn } from '../../../packages/calendar/src/trading-day';
import { DEFAULT_SHOP_CALENDAR } from '../../../packages/calendar/src/shop-clock';
import type { OpenFileLog } from './file-log';
import { openFileLog, readLog } from './file-log';
import {
  suspendBill, resumeBill, abandonBill, SerialisedSuspendedBillStore,
  type SuspendedBill, type SuspendedLine, type SuspendedAgeAnswer, type SuspensionPolicy, type HeldQuotation,
} from '../../../packages/suspended-sales/src/suspended-bill';
import { heldQuotationsOf } from './bill-void-at-lane';

/**
 * R9-A · OB-533: free the quotations of a held basket that was given up — the box's release records (bill-void-at-lane.ts),
 * kept on its disk and queued for head office; idempotent on the basket and quotation.
 */
export type FreeHeldQuotations = (input: {
  readonly heldBillId: string; readonly laneId: string; readonly byUserId: string; readonly reason: string; readonly quotations: readonly HeldQuotation[];
}) => Promise<{ readonly kept: true } | { readonly kept: false; readonly refusedBecause: string }>;

/** What the box answers a give-up (OB-533: with the quotations it freed, in English and Tamil). */
export interface AbandonOutcome {
  readonly abandoned: boolean;
  readonly laneMessage: string;
  readonly laneMessageTa?: string;
  readonly quotationsFreed?: readonly string[];
  /** OB-533: the basket was given up but its quotations could not be freed on this box's disk — said, never silent (P-08). */
  readonly quotationsNotFreed?: readonly string[];
}

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
  const po = v['priceOverride'];
  // The price the line was first rung at — above the price now for a cut, below it for a quotation raised to its quoted price.
  const cut = isObj(po) && int(po['fromUnitMinor']) && po['fromUnitMinor'] >= 0 && po['fromUnitMinor'] !== v['unitPriceMinor'] && isStr(po['approvedBy']) && isStr(po['activityId'])
    ? { fromUnitMinor: po['fromUnitMinor'], approvedBy: po['approvedBy'], activityId: po['activityId'], ...(isStr(po['quotationId']) ? { quotationId: po['quotationId'] } : {}) } : undefined;
  // OB-500: a cut line whose cut cannot be read is not kept as an ordinary line (it would lose its first price and approval).
  if (po !== undefined && cut === undefined) return undefined;
  return {
    lineId: v['lineId'], productId: v['productId'], description: v['description'], unitPriceMinor: v['unitPriceMinor'],
    quantityMinor: v['quantityMinor'], uom: v['uom'], taxBps: v['taxBps'], voided: v['voided'] === true,
    ...(isStr(v['group']) ? { group: v['group'] } : {}),
    ...(isStr(v['hsnCode']) ? { hsnCode: v['hsnCode'] } : {}),
    ...(int(v['minimumAge']) && v['minimumAge'] > 0 ? { minimumAge: v['minimumAge'] } : {}),
    ...(isStr(v['voidReason']) ? { voidReason: v['voidReason'] } : {}),
    // D-20: the batch the barcode carried and its use-by date — a recalled perishable that carried its date needs no tap (B8).
    ...(isStr(v['batchId']) ? { batchId: v['batchId'] } : {}),
    ...(isStr(v['batchExpiry']) && /^\d{4}-\d{2}-\d{2}$/.test(v['batchExpiry']) ? { batchExpiry: v['batchExpiry'] } : {}),
    // B8 (OB-298): a perishable line's pack-date check comes back with it, read strictly.
    ...(isObj(v['packDateCheck']) && isStr(v['packDateCheck']['confirmedBy']) && isStr(v['packDateCheck']['confirmedAt'])
      ? { packDateCheck: { confirmedBy: v['packDateCheck']['confirmedBy'], confirmedAt: v['packDateCheck']['confirmedAt'] } } : {}),
    // OB-500: a cut line's first price and approval come back with it, read strictly (the first price above the price now).
    ...(cut === undefined ? {} : { priceOverride: cut }),
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
      readonly tradingDayOf: (iso: string) => string;
      readonly freeQuotations?: FreeHeldQuotations;
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
    /**
     * R1a (M01-FR-02): the shop's trading day of an instant — the box passes its pack's zone and cut-off. Used only when the
     * till sent no trading day. Absent: the shop default calendar (Asia/Kolkata, midnight), never the UTC date.
     */
    readonly tradingDayOf?: (iso: string) => string;
    /** R9-A · OB-533: frees a given-up basket's quotations (the box's release records). Absent → a basket carrying a
     *  quotation cannot be given up here (refused in words — never given up with its quotation silently left used). */
    readonly freeQuotations?: FreeHeldQuotations;
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
    return new HeldBills(log, { policy: input.policy, storeId: input.storeId, tenantId: input.tenantId, now: input.now ?? (() => new Date().toISOString()), tradingDayOf: input.tradingDayOf ?? ((iso) => tradingDayIn(iso, DEFAULT_SHOP_CALENDAR)), ...(input.freeQuotations === undefined ? {} : { freeQuotations: input.freeQuotations }) }, restored, unreadable);
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
  hold(input: { readonly laneId: string; readonly cashierId: string; readonly billId: unknown; readonly lines: unknown; readonly ageAnswers?: unknown; readonly tradingDay?: unknown; readonly reason?: unknown; readonly quotations?: unknown }): Promise<HoldOutcome> {
    return this.serial(async () => {
      if (!isStr(input.billId)) return { held: false, refusedBecause: 'bill_id_missing', laneMessage: 'The till did not say which basket this is. Nothing was held — try again.' };
      const raw = Array.isArray(input.lines) ? input.lines : [];
      const lines = raw.map(lineOf);
      // OB-533: the quotations rung up on the basket travel with it — read strictly; an unreadable one is a basket not kept.
      const quotations = heldQuotationsOf(input.quotations);
      if (lines.some((l) => l === undefined) || quotations === undefined) return { held: false, refusedBecause: 'basket_not_readable', laneMessage: 'The store computer could not read this basket. Nothing was held — try again.' };
      const existing = this.bills.get(input.billId);
      if (existing !== undefined && existing.laneId === input.laneId && existing.state === 'suspended') {
        return { held: true, billId: existing.billId, lineCount: existing.lines.length, laneMessage: 'Basket held.' };
      }
      const answers = (Array.isArray(input.ageAnswers) ? input.ageAnswers : []).map(answerOf).filter((a): a is SuspendedAgeAnswer => a !== undefined);
      // Validated against a scratch copy first: the rules decide, the disk is written, and only then is the state here.
      const scratch = SerialisedSuspendedBillStore.hydrate(this.bills.serialise());
      const result = suspendBill({
        billId: input.billId, tenantId: this.deps.tenantId, storeId: this.deps.storeId(), laneId: input.laneId,
        cashierId: input.cashierId, tradingDay: isStr(input.tradingDay) ? input.tradingDay : this.deps.tradingDayOf(this.deps.now()),
        currency: 'INR', lines: lines as SuspendedLine[], at: this.deps.now(),
        ...(isStr(input.reason) ? { reason: input.reason } : {}),
        ...(answers.length === 0 ? {} : { ageAnswers: answers }),
        ...(quotations.length === 0 ? {} : { quotations }),
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

  /** Give a held basket up — kept, with who and why (hard rule #6), never deleted. OB-533: its quotations are freed again. */
  abandon(input: { readonly laneId: string; readonly byUserId: string; readonly billId: unknown; readonly reason: unknown }): Promise<AbandonOutcome> {
    return this.serial(async () => {
      if (!isStr(input.billId)) return { abandoned: false, laneMessage: WORDS['not_found']! };
      const held = this.bills.get(input.billId);
      if (held !== undefined && held.laneId !== input.laneId && this.policy().allowCrossLaneRecall !== true) {
        return { abandoned: false, laneMessage: WORDS['other_lane']! };
      }
      const quotations = held?.quotations ?? [];
      if (quotations.length > 0 && this.deps.freeQuotations === undefined) {
        return {
          abandoned: false,
          laneMessage: 'This basket carries a quotation, and this store computer cannot free quotations, so the basket stays held. Tell the manager.',
          laneMessageTa: 'இந்தக் கூடையில் ஒரு விலைப்புள்ளி உள்ளது; இந்தக் கடைக் கணினி விலைப்புள்ளிகளை விடுவிக்க முடியாது, எனவே கூடை நிறுத்தி வைக்கப்பட்டபடியே உள்ளது. மேலாளரிடம் சொல்லவும்.',
        };
      }
      // A give-up re-sent after a lost reply (or after a release the disk refused): the basket is already given up — its
      // quotations' releases are made sure of (each is keyed, so nothing is written twice) and said.
      if (held !== undefined && held.state === 'abandoned' && quotations.length > 0) {
        const ensured = await this.freeQuotationsOf(held, input.laneId, held.abandonedBy ?? input.byUserId, held.abandonReason ?? '');
        return { abandoned: true, ...ensured };
      }
      const scratch = SerialisedSuspendedBillStore.hydrate(this.bills.serialise());
      const result = abandonBill({ billId: input.billId, byUserId: input.byUserId, reason: isStr(input.reason) ? input.reason : '', at: this.deps.now() }, scratch);
      if (!result.abandoned || result.bill === undefined) return { abandoned: false, laneMessage: result.detail };
      try {
        await this.persist(result.bill);
      } catch (e) {
        return { abandoned: false, laneMessage: `The store computer could not record it, so the basket stays held. ${e instanceof Error ? e.message : String(e)}` };
      }
      if (quotations.length === 0) return { abandoned: true, laneMessage: 'Basket given up. It stays on the record.' };
      // OB-533: the basket is given up on the disk — now each quotation it carried is released (kept, then queued).
      const freed = await this.freeQuotationsOf(result.bill, input.laneId, input.byUserId, result.bill.abandonReason ?? '');
      return { abandoned: true, ...freed };
    });
  }

  /** OB-533: release a given-up basket's quotations, and say what happened in the cashier's words (English and Tamil). */
  private async freeQuotationsOf(bill: SuspendedBill, laneId: string, byUserId: string, reason: string): Promise<Omit<AbandonOutcome, 'abandoned'>> {
    const quotations = bill.quotations ?? [];
    const ids = quotations.map((q) => q.quotationId);
    const out = await this.deps.freeQuotations!({ heldBillId: bill.billId, laneId, byUserId, reason, quotations });
    if (!out.kept) {
      return {
        quotationsNotFreed: ids,
        laneMessage: `Basket given up, but quotation ${ids.join(', ')} could NOT be freed on this store computer (${out.refusedBecause}) — it stays used. Give the basket up again to retry, or tell the manager.`,
        laneMessageTa: `கூடை கைவிடப்பட்டது, ஆனால் விலைப்புள்ளி ${ids.join(', ')} இந்தக் கடைக் கணினியில் விடுவிக்கப்படவில்லை (${out.refusedBecause}) — அது பயன்படுத்தியதாகவே இருக்கும். மீண்டும் கைவிட்டு முயலவும், அல்லது மேலாளரிடம் சொல்லவும்.`,
      };
    }
    return {
      quotationsFreed: ids,
      laneMessage: `Basket given up. It stays on the record. Quotation ${ids.join(', ')} is freed again — head office is told now, or as soon as its line is back; it can then be rung up on a later bill.`,
      laneMessageTa: `கூடை கைவிடப்பட்டது; பதிவில் இருக்கும். விலைப்புள்ளி ${ids.join(', ')} மீண்டும் விடுவிக்கப்பட்டது — தலைமை அலுவலகத்துக்கு இப்போதே, அல்லது இணைப்பு திரும்பியதும் தெரிவிக்கப்படும்; பிறகு வேறு பில்லில் சேர்க்கலாம்.`,
    };
  }

  async close(): Promise<void> {
    await this.log.close();
  }
}
