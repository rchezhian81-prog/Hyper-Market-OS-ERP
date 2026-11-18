// Batch 15 (owner's gap audit, 18 Nov 2026): what the store computer REMEMBERS for the Today page (P-08 · hard rule #2).
//
// Two things head office's pack cannot tell the box after the fact:
//
//   • a DAILY FIGURE — how many purchase orders were open, how many items were at or below their reorder point — as this
//     box saw it on each trading day, so Today's cards compare with yesterday instead of saying "no previous figure". A
//     figure is written when it is first seen on a trading day and again only when it changes that day: an append-only
//     log, never a rewritten count. "Yesterday" is the last figure recorded on the most recent EARLIER trading day this box
//     holds — a day it never saw is never invented, and with none the card says so.
//   • a PRICE CHANGE — an item whose price on the signed catalogue pack differs from the pack this box held before it —
//     stamped when the new pack reached this box (the moment the tills started charging it). Today's Recent activity lists it.
//
// Both are kept in one durable, fsync'd, length-framed log on the box's own disk (`file-log.ts`); a record that cannot be
// read whole is counted and kept, never repaired or dropped (hard rule #6).

import { openFileLog, readLog, type OpenFileLog } from './file-log';

export type DailyFigureName = 'purchaseOrdersOpen' | 'lowStock';

export interface DailyFigureRecord {
  readonly kind: 'daily_figure';
  readonly figure: DailyFigureName;
  readonly tradingDay: string;
  readonly value: number;
  readonly at: string;
}

export interface PriceChangeRecord {
  readonly kind: 'price_change';
  readonly productId: string;
  readonly name?: string;
  readonly fromMinor: number;
  readonly toMinor: number;
  /** The catalogue pack version that carried the new price. */
  readonly packVersion: number;
  /** When the new pack reached this box. */
  readonly at: string;
}

export type TodayHistoryRecord = DailyFigureRecord | PriceChangeRecord;

const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isMoney = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/** One record as it was written, or undefined when it is not one this module wrote (it is then counted as unreadable). */
export function readHistoryRecord(raw: unknown): TodayHistoryRecord | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r['kind'] === 'daily_figure' && (r['figure'] === 'purchaseOrdersOpen' || r['figure'] === 'lowStock') && isDay(r['tradingDay'])
    && isCount(r['value']) && typeof r['at'] === 'string') {
    return { kind: 'daily_figure', figure: r['figure'], tradingDay: r['tradingDay'], value: r['value'], at: r['at'] };
  }
  if (r['kind'] === 'price_change' && typeof r['productId'] === 'string' && r['productId'] !== '' && isMoney(r['fromMinor'])
    && isMoney(r['toMinor']) && typeof r['packVersion'] === 'number' && typeof r['at'] === 'string') {
    return {
      kind: 'price_change', productId: r['productId'], fromMinor: r['fromMinor'], toMinor: r['toMinor'], packVersion: r['packVersion'], at: r['at'],
      ...(typeof r['name'] === 'string' && r['name'].trim() !== '' ? { name: r['name'] } : {}),
    };
  }
  return undefined;
}

/** The figure's last value recorded on `tradingDay`, or undefined when none was. */
export function figureOnDay(records: readonly TodayHistoryRecord[], figure: DailyFigureName, tradingDay: string): number | undefined {
  let value: number | undefined;
  for (const r of records) if (r.kind === 'daily_figure' && r.figure === figure && r.tradingDay === tradingDay) value = r.value;
  return value;
}

/** The figure at the end of the most recent trading day BEFORE `tradingDay` that this box recorded it on — or null. */
export function previousFigure(records: readonly TodayHistoryRecord[], figure: DailyFigureName, tradingDay: string): { readonly tradingDay: string; readonly value: number } | null {
  let best: { tradingDay: string; value: number } | null = null;
  for (const r of records) {
    if (r.kind !== 'daily_figure' || r.figure !== figure || r.tradingDay >= tradingDay) continue;
    // Records are in the order written: a later one on the same day is that day's newer figure.
    if (best === null || r.tradingDay >= best.tradingDay) best = { tradingDay: r.tradingDay, value: r.value };
  }
  return best;
}

/** The records to write for today's figures: only a figure not yet seen today, or one that changed since. */
export function figuresToRecord(
  records: readonly TodayHistoryRecord[], tradingDay: string, figures: Partial<Record<DailyFigureName, number>>, at: string,
): readonly DailyFigureRecord[] {
  const out: DailyFigureRecord[] = [];
  for (const figure of ['purchaseOrdersOpen', 'lowStock'] as const) {
    const value = figures[figure];
    if (!isCount(value) || !isDay(tradingDay)) continue;
    if (figureOnDay(records, figure, tradingDay) === value) continue;
    out.push({ kind: 'daily_figure', figure, tradingDay, value, at });
  }
  return out;
}

/** The items whose price on the new catalogue differs from the one this box held before it — none when there was no earlier one. */
export function priceChangesBetween(
  before: readonly { readonly productId: string; readonly unitPriceMinor: number; readonly name?: string }[] | undefined,
  after: { readonly version: number; readonly products: readonly { readonly productId: string; readonly unitPriceMinor: number; readonly name?: string }[] },
  at: string,
): readonly PriceChangeRecord[] {
  if (before === undefined) return [];
  const was = new Map(before.map((p) => [p.productId, p.unitPriceMinor] as const));
  const out: PriceChangeRecord[] = [];
  for (const p of after.products) {
    const from = was.get(p.productId);
    if (from === undefined || from === p.unitPriceMinor || !isMoney(p.unitPriceMinor) || !isMoney(from)) continue;
    out.push({
      kind: 'price_change', productId: p.productId, fromMinor: from, toMinor: p.unitPriceMinor, packVersion: after.version, at,
      ...(typeof p.name === 'string' && p.name.trim() !== '' ? { name: p.name } : {}),
    });
  }
  return out.sort((a, b) => a.productId.localeCompare(b.productId));
}

export interface TodayHistory {
  /** Every record read whole, in the order written. */
  records(): readonly TodayHistoryRecord[];
  /** Records on the disk that could not be read whole — kept, counted, never repaired. */
  unreadable(): number;
  /** Write today's figures that are new or changed (durably, before they count). */
  observe(tradingDay: string, figures: Partial<Record<DailyFigureName, number>>, at: string): Promise<void>;
  /** Write the price changes a newly adopted catalogue pack brought. */
  notePriceChanges(changes: readonly PriceChangeRecord[]): Promise<void>;
}

/** Open (or create) the box's Today history log and read what it holds. */
export async function openTodayHistory(options: { readonly dataDir: string; readonly capacityBytes: number; readonly fileName?: string }): Promise<TodayHistory & { readonly log: OpenFileLog }> {
  const log = await openFileLog({ dataDir: options.dataDir, capacityBytes: options.capacityBytes, fileName: options.fileName ?? 'today-history.log' });
  const held: TodayHistoryRecord[] = [];
  let unreadable = 0;
  for (const entry of await readLog(log.path)) {
    if (!entry.ok) { unreadable += 1; continue; }
    let parsed: unknown;
    try { parsed = JSON.parse(entry.record); } catch { unreadable += 1; continue; }
    const r = readHistoryRecord(parsed);
    if (r === undefined) unreadable += 1; else held.push(r);
  }
  // One write at a time, so two screens opening together cannot both write the same day's figure.
  let chain: Promise<void> = Promise.resolve();
  const append = (records: readonly TodayHistoryRecord[]): Promise<void> => {
    chain = chain.then(async () => {
      for (const r of records) {
        await log.append(JSON.stringify(r));
        held.push(r);
      }
    });
    return chain;
  };
  return {
    log,
    records: () => held,
    unreadable: () => unreadable,
    observe: (tradingDay, figures, at) => {
      chain = chain.then(async () => {
        for (const r of figuresToRecord(held, tradingDay, figures, at)) {
          await log.append(JSON.stringify(r));
          held.push(r);
        }
      });
      return chain;
    },
    notePriceChanges: (changes) => append(changes),
  };
}
