// QUEUE BASKETS — handed over by a staff handheld in the queue, kept on this store computer's disk, brought up at a till
// once (D04-FR-05 queue-busting · OB-288 · P-01 · hard rules #1, #2, #6, #10).
//
// The handheld scans a customer's basket and hands it to THIS box (over the authenticated device socket, ADR-0019); the
// box writes it to an fsync'd, append-only log BEFORE the handheld is told the code. The customer walks to a till; the
// cashier keys the code; the box records the claim on its disk BEFORE the till gets the lines; the till rings every line
// through its own signed pack. No network beyond the shop's own wifi is involved, so it works with head office down.
//
// The rules are the tested ones in `packages/suspended-sales/src/queue-basket.ts` (one basket per hand-over, claimed once,
// a handheld never recalls, nothing deleted). This file adds only the disk and the order: one change at a time, so two
// tills keying the same code are answered in turn and only one gets it.
//
// A queue basket holds no stock: it is a note of intent, not a movement.

import { randomInt } from 'node:crypto';
import type { OpenFileLog } from './file-log';
import { openFileLog, readLog } from './file-log';
import {
  handOverBasket, recallQueueBasket, giveUpQueueBasket, waitingFrom, QUEUE_BASKET_WORDS,
  type QueueBasket, type QueueBasketLine,
} from '../../../packages/suspended-sales/src/queue-basket';

export type QueueHandOverAnswer =
  | { readonly handedOver: true; readonly code: string; readonly basketId: string; readonly lineCount: number; readonly laneMessage: string; readonly laneMessageTa: string }
  | { readonly handedOver: false; readonly refusedBecause: string; readonly laneMessage: string; readonly laneMessageTa: string };

/** The till's answer — the same shape as a phone basket's (`phone-baskets.ts`), so the till rings it the same way. */
export type QueueRecallAnswer =
  | { readonly recalled: true; readonly code: string; readonly lines: readonly QueueBasketLine[]; readonly handheldTotalMinor: number; readonly handedOverBy: string; readonly laneMessage: string }
  | { readonly recalled: false; readonly refusedBecause: string; readonly laneMessage: string };

export interface QueueWaiting {
  readonly code: string;
  readonly basketId: string;
  readonly handedOverAt: string;
  readonly lineCount: number;
  readonly handheldTotalMinor: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const words = (reason: string): { readonly en: string; readonly ta: string } =>
  QUEUE_BASKET_WORDS[reason] ?? { en: 'The store computer did not take this. Nothing was changed — try again.', ta: 'கடை கணினி இதை ஏற்கவில்லை. மீண்டும் முயலவும்.' };

/** Twelve random four-digit codes to try, in order — drawn here, so the pure rules stay deterministic. */
const drawCodes = (): string[] => Array.from({ length: 12 }, () => String(randomInt(0, 10_000)).padStart(4, '0'));

export class QueueBaskets {
  private readonly baskets = new Map<string, QueueBasket>();
  private queue: Promise<unknown> = Promise.resolve();
  /** Records on the disk that could not be read whole — surfaced, never repaired (hard rule #6). */
  readonly unreadableRecords: number;

  private constructor(
    private readonly log: OpenFileLog,
    private readonly deps: { readonly now: () => string; readonly codes: () => readonly string[] },
    restored: readonly QueueBasket[],
    unreadable: number,
  ) {
    this.unreadableRecords = unreadable;
    // The log holds every state each basket passed through; the latest line per basket is its state now.
    for (const b of restored) this.baskets.set(b.basketId, b);
  }

  static async open(input: {
    readonly dataDir: string;
    readonly capacityBytes: number;
    readonly now?: () => string;
    /** The codes to try for a new hand-over (tests pass a fixed list). Default: drawn at random. */
    readonly codes?: () => readonly string[];
  }): Promise<QueueBaskets> {
    const log = await openFileLog({ dataDir: input.dataDir, capacityBytes: input.capacityBytes, fileName: 'queue-baskets.log' });
    const restored: QueueBasket[] = [];
    let unreadable = 0;
    for (const v of await readLog(log.path)) {
      if (!v.ok) { unreadable += 1; continue; }
      try {
        const r = JSON.parse(v.record) as unknown;
        if (isObj(r) && typeof r['basketId'] === 'string' && typeof r['code'] === 'string' && Array.isArray(r['lines'])) restored.push(r as unknown as QueueBasket);
        else unreadable += 1;
      } catch { unreadable += 1; }
    }
    return new QueueBaskets(log, { now: input.now ?? (() => new Date().toISOString()), codes: input.codes ?? drawCodes }, restored, unreadable);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Write the basket's new state to the disk, then make it the state here. A failed write changes nothing. */
  private async persist(b: QueueBasket): Promise<void> {
    await this.log.append(JSON.stringify(b));
    this.baskets.set(b.basketId, b);
  }

  private all(): readonly QueueBasket[] {
    return [...this.baskets.values()];
  }

  /** The handheld hands a basket over: on the disk before it hears the code. A re-sent hand-over is the same one. */
  handOver(input: { readonly handheldLane: string; readonly by: string; readonly basketId: unknown; readonly lines: unknown; readonly handheldTotalMinor: unknown }): Promise<QueueHandOverAnswer> {
    return this.serial(async () => {
      const out = handOverBasket(this.all(), { ...input, handedOverBy: input.by, at: this.deps.now(), candidates: this.deps.codes() });
      if (!out.handedOver) {
        const w = words(out.refusedBecause);
        return { handedOver: false, refusedBecause: out.refusedBecause, laneMessage: w.en, laneMessageTa: w.ta };
      }
      if (!out.again) {
        try { await this.persist(out.basket); } catch (e) {
          return {
            handedOver: false, refusedBecause: 'could_not_write_durably',
            laneMessage: `The store computer could not save the basket, so it is still on this handheld — do not clear it. ${e instanceof Error ? e.message : String(e)}`,
            laneMessageTa: 'கடை கணினியால் கூடையைச் சேமிக்க முடியவில்லை; அது இந்தக் கருவியிலேயே உள்ளது — அழிக்க வேண்டாம்.',
          };
        }
      }
      const b = out.basket;
      return {
        handedOver: true, code: b.code, basketId: b.basketId, lineCount: b.lines.length,
        laneMessage: `Basket handed over. Tell the customer the code ${b.code} — any till on this store computer brings it up.`,
        laneMessageTa: `கூடை ஒப்படைக்கப்பட்டது. வாடிக்கையாளரிடம் குறியீடு ${b.code} சொல்லவும் — இந்தக் கடை கணினியின் எந்த பில்லிங்கிலும் எடுக்கலாம்.`,
      };
    });
  }

  /** A till brings a basket up by its code — a claim, on the disk before the till gets the lines. */
  recall(input: { readonly code: unknown; readonly laneId: string; readonly cashierId: string }): Promise<QueueRecallAnswer> {
    return this.serial(async () => {
      const out = recallQueueBasket(this.all(), { code: input.code, laneId: input.laneId, by: input.cashierId, at: this.deps.now() });
      if (!out.recalled) {
        const where = out.refusedBecause === 'already_recalled' && out.recalledOnLane !== undefined ? ` (brought up on ${out.recalledOnLane})` : '';
        return { recalled: false, refusedBecause: out.refusedBecause, laneMessage: `${words(out.refusedBecause).en}${where}` };
      }
      try { await this.persist(out.basket); } catch (e) {
        return { recalled: false, refusedBecause: 'could_not_write_durably', laneMessage: `The store computer could not record the recall, so the basket stays waiting. Scan the items. ${e instanceof Error ? e.message : String(e)}` };
      }
      const b = out.basket;
      return {
        recalled: true, code: b.code, lines: b.lines, handheldTotalMinor: b.handheldTotalMinor, handedOverBy: b.handedOverBy,
        laneMessage: `Handheld basket ${b.code}: ${b.lines.length} line(s). The till prices them now.`,
      };
    });
  }

  /** The handheld gives a waiting basket up (the customer left) — kept with who and why. */
  giveUp(input: { readonly handheldLane: string; readonly by: string; readonly code: unknown; readonly reason: unknown }): Promise<{ readonly givenUp: boolean; readonly refusedBecause?: string; readonly laneMessage: string; readonly laneMessageTa: string }> {
    return this.serial(async () => {
      const out = giveUpQueueBasket(this.all(), { ...input, at: this.deps.now() });
      if (!out.givenUp) { const w = words(out.refusedBecause); return { givenUp: false, refusedBecause: out.refusedBecause, laneMessage: w.en, laneMessageTa: w.ta }; }
      try { await this.persist(out.basket); } catch (e) {
        return { givenUp: false, refusedBecause: 'could_not_write_durably', laneMessage: `The store computer could not record it, so the basket stays waiting. ${e instanceof Error ? e.message : String(e)}`, laneMessageTa: 'கடை கணினியால் பதிவு செய்ய முடியவில்லை; கூடை காத்திருக்கிறது.' };
      }
      return { givenUp: true, laneMessage: 'Basket given up. It stays on the record.', laneMessageTa: 'கூடை கைவிடப்பட்டது. அது பதிவில் இருக்கும்.' };
    });
  }

  /** What this handheld handed over that no till has brought up yet. */
  waiting(handheldLane: string): readonly QueueWaiting[] {
    return waitingFrom(this.all(), handheldLane).map((b) => ({ code: b.code, basketId: b.basketId, handedOverAt: b.handedOverAt, lineCount: b.lines.length, handheldTotalMinor: b.handheldTotalMinor }));
  }

  async close(): Promise<void> {
    await this.log.close();
  }
}
