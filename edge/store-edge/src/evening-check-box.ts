// OB-263 (owner, 21 Oct 2026, "Item-wise + bill-wise") — the evening check, kept and judged on the store computer (MG-10 ·
// OB-259 · OB-264 · P-01 · P-08 · hard rules #1, #2, #6, #10).
//
// The migration screen's "Running both" tab hands this box the old ERP's two reports for a day; this box reads them through
// the mapping it holds, compares them with its OWN mirror sales and refunds (`packages/migration/src/evening-check.ts`),
// and keeps the result. All of it works with no internet: the box needs nothing from head office to load, explain or sign
// a day, and it relays each decision to head office the way a parallel-run day already goes (`MigrationParallelDayEntered`,
// `MigrationParallelDaySigned`), sealed for the person it verified.
//
// What it keeps — in ONE append-only, fsync'd log (`evening-check.log`), folded at start, never rewritten (hard rule #2):
//   • `mapping_set`   — which old-ERP column holds each of our fields, per report, who set it and when. A change is a new
//                       record; the earlier ones stay as the history of who changed it.
//   • `day_loaded`    — the figures loaded for a day (our fields only — never a raw file, never a column that is not mapped,
//                       so no customer name or phone number), the comparison and its differences. A reload is a new record:
//                       it REPLACES the day's figures visibly, the earlier load stays in the history, and a signature over
//                       the old figures no longer applies (`signatureStillApplies` — the existing rule).
//   • `reasons_given` — a reason on one or more differences of the day's current figures (bound by their digest).
//   • `day_signed`    — the named reconciler's signature over the day as it stood (`signParallelDay`).
//
// Who may: only the person named to reconcile daily (R-05 — the owner for the first two weeks, OB-254), signed in with
// their own PIN on the office screens (OB-259). The screen socket checks the sign-in; this decides the rest.

import { readLog, openFileLog, type OpenFileLog } from './file-log';
import { makeEvent, type DomainEvent } from '../../../packages/contracts/src/event';
import {
  OLD_ERP_REPORT_KINDS, judgeMapping, readBillWiseReport, readItemWiseReport,
  type ColumnMapping, type OldErpReportKind, type ReadSummary, type ReportRefusal,
} from '../../../packages/migration/src/old-erp-reports';
import { eveningCheck, type CheckProduct, type CheckRefund, type CheckSale, type EveningCheck } from '../../../packages/migration/src/evening-check';
import { compareParallelDay, differencePrefixFor, ownDifference, type DayComparison, type ParallelDifference } from '../../../packages/migration/src/cutover';
import { dayDigestOf, signParallelDay, unexplainedDifferences, type ParallelDaySignature } from '../../../packages/migration/src/parallel-day-sign';
import { looksLikeNoReason } from '../../../packages/migration/src/verification-report';
import { isOldErpBillNumber } from '../../../packages/tender/src/old-erp-bill-number';

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined);
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const SIDES = ['legacy', 'new', 'both', 'neither'] as const;
type Side = (typeof SIDES)[number];

export interface MappingRecord {
  readonly kind: 'mapping_set';
  readonly report: OldErpReportKind;
  readonly mapping: ColumnMapping;
  readonly setBy: string;
  readonly setAt: string;
}

export interface FileSummary extends ReadSummary {
  /** The mapping the file was read through, as it was then. */
  readonly mappingSetAt: string;
}

export interface LoadRecord {
  readonly kind: 'day_loaded';
  readonly businessDate: string;
  readonly loadId: string;
  readonly loadedBy: string;
  readonly loadedAt: string;
  readonly files: { readonly itemWise: FileSummary; readonly billWise: FileSummary & { readonly withLines: boolean } };
  readonly check: EveningCheck;
  readonly comparisons: readonly DayComparison[];
  readonly dayDigest: string;
  readonly differences: readonly ParallelDifference[];
  /** A short fingerprint of the new till's sales and refunds for the day as loaded — to say when they changed since. */
  readonly newSideFingerprint: string;
}

export interface ReasonsRecord {
  readonly kind: 'reasons_given';
  readonly businessDate: string;
  readonly dayDigest: string;
  readonly by: string;
  readonly at: string;
  readonly reasons: readonly { readonly differenceId: string; readonly explanation: string; readonly wrongSide?: Side }[];
}

export interface SignedRecord {
  readonly kind: 'day_signed';
  readonly businessDate: string;
  readonly signature: ParallelDaySignature;
}

type Rec = MappingRecord | LoadRecord | ReasonsRecord | SignedRecord;

/** A day as the screen draws it. */
export interface EveningDayView {
  readonly businessDate: string;
  readonly current?: Omit<LoadRecord, 'kind' | 'differences'>;
  readonly differences: readonly ParallelDifference[];
  readonly unexplained: readonly ParallelDifference[];
  readonly signature?: ParallelDaySignature;
  /** Every load of the day, oldest first: who, when, the figures' digest, and whether it is the current one. */
  readonly history: readonly { readonly loadId: string; readonly loadedBy: string; readonly loadedAt: string; readonly dayDigest: string; readonly current: boolean; readonly signedBy?: string }[];
  /** Signatures over figures since replaced — kept, and said. */
  readonly voidedSignatures: readonly ParallelDaySignature[];
  /** The new till's sales or refunds for the day changed after the files were loaded (load again to compare them). */
  readonly newTillChangedSinceLoad?: boolean;
}

export type EveningRefusal =
  | 'not_the_named_reconciler' | 'nobody_named_to_reconcile' | 'not_readable' | 'mapping_refused' | 'no_mapping'
  | ReportRefusal | 'no_pilot_department' | 'no_catalogue' | 'code_looks_personal' | 'quantity_not_whole' | 'too_many_differences'
  | 'day_not_loaded' | 'unknown_difference' | 'reason_says_nothing' | 'reason_refused' | 'already_signed'
  | 'unexplained_material_difference' | 'statement_says_nothing' | 'nobody_named' | 'day_not_recorded' | 'could_not_write_durably';

export type EveningOutcome<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly refusedBecause: EveningRefusal; readonly detail: string; readonly problems?: readonly string[] };

/** What the box gives this module, read when needed (never on the sale path). */
export interface EveningSources {
  readonly tenantId: string;
  /** The cutover these days belong to (the pack's migration terms). */
  readonly cutoverId: () => string | undefined;
  readonly reconcilerUserId: () => string | undefined;
  readonly department: () => { readonly categoryId: string; readonly name: string } | undefined;
  readonly catalogue: () => readonly CheckProduct[] | undefined;
  /** The box's own sale and refund records, read from its disk. */
  readonly records: () => Promise<{ readonly sales: readonly unknown[]; readonly refunds: readonly unknown[] }>;
  /** The shop's trading day of a moment, by its own clock and cut-off — how a refund record (which carries none) is dated. */
  readonly tradingDayOf: (iso: string) => string;
  /** Hand a decision to head office: sealed for `by`, written to the box's relay log and queued (as the device relay does). */
  readonly relay: (event: DomainEvent, by: string, via?: string) => Promise<{ readonly queued: boolean; readonly detail?: string }>;
}

/** A sale record off the box's disk, read defensively, as the evening check needs it. */
export function checkSaleOf(raw: unknown): CheckSale | undefined {
  if (!isObj(raw)) return undefined;
  const saleId = str(raw['id']) ?? str(raw['saleId']);
  const tradingDay = str(raw['tradingDay']);
  if (saleId === undefined || tradingDay === undefined) return undefined;
  const lines = Array.isArray(raw['lines']) ? (raw['lines'] as unknown[]).flatMap((l) => {
    if (!isObj(l) || str(l['productId']) === undefined || int(l['quantityMinor']) === undefined || int(l['lineTotalMinor']) === undefined) return [];
    return [{
      productId: l['productId'] as string, quantityMinor: l['quantityMinor'] as number, lineTotalMinor: l['lineTotalMinor'] as number,
      ...(str(l['uom']) === undefined ? {} : { uom: l['uom'] as string }),
      ...(int(l['taxRateBps']) === undefined ? {} : { taxRateBps: l['taxRateBps'] as number }),
    }];
  }) : [];
  const old = raw['oldErpBillNumber'];
  return { saleId, number: str(raw['receiptNumber']) ?? str(raw['number']) ?? saleId, tradingDay, lines, ...(isOldErpBillNumber(old) ? { oldErpBillNumber: old } : {}) };
}

/**
 * A refund record off the box's disk, read defensively. The till writes no trading day on a refund — only when it was
 * processed — so it is dated by the shop's own day rule (`tradingDayOf`), as the till dates a sale.
 */
export function checkRefundOf(raw: unknown, tradingDayOf: (iso: string) => string): CheckRefund | undefined {
  if (!isObj(raw)) return undefined;
  const returnId = str(raw['returnId']) ?? str(raw['id']);
  const at = str(raw['processedAt']) ?? str(raw['storeComputerTakenAt']);
  const tradingDay = str(raw['tradingDay']) ?? (at !== undefined && !Number.isNaN(Date.parse(at)) ? tradingDayOf(at) : undefined);
  const refundMinor = int(raw['refundMinor']);
  if (returnId === undefined || tradingDay === undefined || refundMinor === undefined) return undefined;
  const lines = Array.isArray(raw['lines']) ? (raw['lines'] as unknown[]).flatMap((l) =>
    (isObj(l) && str(l['productId']) !== undefined && int(l['quantityMinor']) !== undefined ? [{ productId: l['productId'] as string, quantityMinor: l['quantityMinor'] as number }] : [])) : [];
  return { returnId, tradingDay, refundMinor, lines, ...(str(raw['originalSaleId']) === undefined ? {} : { originalSaleId: raw['originalSaleId'] as string }) };
}

const fingerprint = (text: string): string => {
  let h1 = 0x811c9dc5; let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
};

function newSideFingerprintOf(day: string, sales: readonly CheckSale[], refunds: readonly CheckRefund[]): string {
  return fingerprint(JSON.stringify([
    sales.filter((s) => s.tradingDay === day).map((s) => [s.saleId, s.oldErpBillNumber ?? '', s.lines.map((l) => [l.productId, l.quantityMinor, l.lineTotalMinor])]).sort(),
    refunds.filter((r) => r.tradingDay === day).map((r) => [r.returnId, r.refundMinor, r.lines.map((l) => [l.productId, l.quantityMinor])]).sort(),
  ]));
}

export interface EveningCheckBox {
  /** The mapping in force for each report, and every change to it (oldest first). */
  mappings(): { readonly current: Partial<Record<OldErpReportKind, MappingRecord>>; readonly history: readonly MappingRecord[] };
  setMapping(input: { readonly report: unknown; readonly mapping: unknown; readonly header?: unknown; readonly by: string; readonly via?: string; readonly at: string }): Promise<EveningOutcome<{ readonly mapping: MappingRecord }>>;
  load(input: { readonly businessDate: unknown; readonly itemWise: unknown; readonly billWise: unknown; readonly tolerance: unknown; readonly by: string; readonly via?: string; readonly at: string }): Promise<EveningOutcome<{ readonly day: EveningDayView; readonly relayed: boolean }>>;
  explain(input: { readonly businessDate: unknown; readonly reasons: unknown; readonly by: string; readonly via?: string; readonly at: string }): Promise<EveningOutcome<{ readonly day: EveningDayView; readonly relayed: boolean }>>;
  sign(input: { readonly businessDate: unknown; readonly statement: unknown; readonly by: string; readonly via?: string; readonly at: string }): Promise<EveningOutcome<{ readonly day: EveningDayView; readonly signature: ParallelDaySignature; readonly relayed: boolean }>>;
  day(businessDate: string): Promise<EveningDayView>;
  /** Every day loaded: its date, whether signed, how many differences still need a reason. */
  days(): readonly { readonly businessDate: string; readonly loadedAt: string; readonly differences: number; readonly unexplained: number; readonly signedBy?: string }[];
  /** Records in the log that could not be read whole — kept, never repaired (hard rule #6). */
  readonly unreadableRecords: number;
  close(): Promise<void>;
}

export async function openEveningCheckBox(input: { readonly dataDir: string; readonly capacityBytes: number; readonly sources: EveningSources }): Promise<EveningCheckBox> {
  const log: OpenFileLog = await openFileLog({ dataDir: input.dataDir, capacityBytes: input.capacityBytes, fileName: 'evening-check.log' });
  const records: Rec[] = [];
  let unreadable = 0;
  for (const v of await readLog(log.path)) {
    if (!v.ok) { unreadable += 1; continue; }
    try {
      const r = JSON.parse(v.record) as Rec;
      if (isObj(r) && typeof (r as { kind?: unknown }).kind === 'string') records.push(r); else unreadable += 1;
    } catch { unreadable += 1; }
  }
  const src = input.sources;
  let chain: Promise<unknown> = Promise.resolve();
  /** One write at a time, so two tabs cannot both pass a check before either is on the disk. */
  const serial = <T>(work: () => Promise<T>): Promise<T> => { const run = chain.then(work, work); chain = run.catch(() => undefined); return run; };
  const write = async (r: Rec): Promise<boolean> => {
    try { await log.append(JSON.stringify(r)); records.push(r); return true; } catch { return false; }
  };
  const refuse = (refusedBecause: EveningRefusal, detail: string, problems?: readonly string[]): { readonly ok: false; readonly refusedBecause: EveningRefusal; readonly detail: string; readonly problems?: readonly string[] } =>
    ({ ok: false, refusedBecause, detail, ...(problems === undefined ? {} : { problems }) });
  const authority = (by: string): ReturnType<typeof refuse> | undefined => {
    const named = src.reconcilerUserId();
    if (named === undefined) return refuse('nobody_named_to_reconcile', 'The owner has not named the person who reconciles the parallel run every day (owner guide Part 23), so no day can be loaded here. Nothing was saved.');
    if (by !== named) return refuse('not_the_named_reconciler', `${named} is the person named to reconcile every day; ${by} is not. Nothing was saved.`);
    return undefined;
  };

  const mappingsNow = (): { current: Partial<Record<OldErpReportKind, MappingRecord>>; history: MappingRecord[] } => {
    const history = records.filter((r): r is MappingRecord => r.kind === 'mapping_set');
    const current: Partial<Record<OldErpReportKind, MappingRecord>> = {};
    for (const m of history) current[m.report] = m;
    return { current, history };
  };
  const loadsOf = (date: string): LoadRecord[] => records.filter((r): r is LoadRecord => r.kind === 'day_loaded' && r.businessDate === date);
  const differencesOf = (load: LoadRecord): ParallelDifference[] => {
    let diffs: ParallelDifference[] = [...load.differences];
    for (const r of records) {
      if (r.kind !== 'reasons_given' || r.businessDate !== load.businessDate || r.dayDigest !== load.dayDigest) continue;
      for (const reason of r.reasons) {
        const out = ownDifference({ differences: diffs, differenceId: reason.differenceId, ownerUserId: r.by, explanation: reason.explanation, ...(reason.wrongSide === undefined ? {} : { wrongSide: reason.wrongSide }) });
        if (out.ok) diffs = [...out.differences];
      }
    }
    return diffs;
  };
  const signaturesOf = (date: string): ParallelDaySignature[] => records.filter((r): r is SignedRecord => r.kind === 'day_signed' && r.businessDate === date).map((r) => r.signature);

  const viewOf = (date: string, newFingerprint?: string): EveningDayView => {
    const loads = loadsOf(date);
    const current = loads.at(-1);
    const sigs = signaturesOf(date);
    if (current === undefined) return { businessDate: date, differences: [], unexplained: [], history: [], voidedSignatures: sigs };
    const differences = differencesOf(current);
    const signature = sigs.filter((s) => s.dayDigest === current.dayDigest).at(0);
    const rest: Omit<LoadRecord, 'kind' | 'differences'> = {
      businessDate: current.businessDate, loadId: current.loadId, loadedBy: current.loadedBy, loadedAt: current.loadedAt, files: current.files,
      check: current.check, comparisons: current.comparisons, dayDigest: current.dayDigest, newSideFingerprint: current.newSideFingerprint,
    };
    return {
      businessDate: date, current: rest, differences, unexplained: unexplainedDifferences(date, differences),
      ...(signature === undefined ? {} : { signature }),
      history: loads.map((l, i) => ({
        loadId: l.loadId, loadedBy: l.loadedBy, loadedAt: l.loadedAt, dayDigest: l.dayDigest, current: i === loads.length - 1,
        ...(() => { const s = sigs.find((x) => x.dayDigest === l.dayDigest); return s === undefined ? {} : { signedBy: s.signedBy }; })(),
      })),
      voidedSignatures: sigs.filter((s) => s.dayDigest !== current.dayDigest),
      ...(newFingerprint === undefined ? {} : { newTillChangedSinceLoad: newFingerprint !== current.newSideFingerprint }),
    };
  };

  const newSide = async (): Promise<{ sales: CheckSale[]; refunds: CheckRefund[] }> => {
    const raw = await src.records();
    return {
      sales: raw.sales.flatMap((s) => { const c = checkSaleOf(s); return c === undefined ? [] : [c]; }),
      refunds: raw.refunds.flatMap((r) => { const c = checkRefundOf(r, src.tradingDayOf); return c === undefined ? [] : [c]; }),
    };
  };

  /** The MG-10 day as head office receives it: the figures, and every reason given on them so far. */
  const dayEvent = (load: LoadRecord, differences: readonly ParallelDifference[], by: string, at: string): DomainEvent => {
    const explanations = differences.filter((d) => d.status === 'resolved' && d.explanation !== undefined).map((d) => ({
      area: d.area, ...(d.subject === undefined ? {} : { subject: d.subject }), explanation: d.explanation!, ...(d.wrongSide === undefined ? {} : { wrongSide: d.wrongSide }),
    }));
    const subject = `${load.businessDate}:${load.dayDigest}:${explanations.length}`;
    return makeEvent({
      id: `MigrationParallelDayEntered-${subject}`, type: 'MigrationParallelDayEntered', occurredAt: at,
      idempotencyKey: `${src.tenantId}:MigrationParallelDayEntered:${subject}`, source: 'store-computer:evening-check',
      payload: { tenantId: src.tenantId, cutoverId: src.cutoverId() ?? '', businessDate: load.businessDate, enteredBy: by, comparisons: load.comparisons, explanations, enteredAt: load.loadedAt },
    });
  };
  const readDate = (v: unknown): string | undefined => (isDate(v) ? v : undefined);

  return {
    mappings: () => mappingsNow(),

    setMapping: (i) => serial(async () => {
      const stop = authority(i.by);
      if (stop !== undefined) return stop;
      if (!(OLD_ERP_REPORT_KINDS as readonly unknown[]).includes(i.report)) return refuse('not_readable', 'Say which report this mapping is for: the item-wise report or the bill-wise list. Nothing was saved.');
      const header = Array.isArray(i.header) && i.header.every((h) => typeof h === 'string') ? i.header as string[] : undefined;
      const judged = judgeMapping(i.report as OldErpReportKind, i.mapping, header);
      if (!judged.ok) return refuse('mapping_refused', 'The mapping was not saved:', judged.problems);
      const rec: MappingRecord = { kind: 'mapping_set', report: i.report as OldErpReportKind, mapping: judged.mapping, setBy: i.by, setAt: i.at };
      if (!await write(rec)) return refuse('could_not_write_durably', 'This store computer could not write the mapping to its disk. Nothing was saved — try again, and if it says this again, send a photo.');
      return { ok: true, mapping: rec };
    }),

    load: (i) => serial(async () => {
      const stop = authority(i.by);
      if (stop !== undefined) return stop;
      const date = readDate(i.businessDate);
      if (date === undefined || typeof i.itemWise !== 'string' || typeof i.billWise !== 'string') {
        return refuse('not_readable', 'Loading a day needs the day (YYYY-MM-DD) and both files: the item-wise report and the bill-wise list. Nothing was saved.');
      }
      const tol = isObj(i.tolerance) ? i.tolerance : {};
      const valueTol = int(tol['valueMinor']) ?? 0;
      const taxTol = int(tol['taxMinor']) ?? 0;
      if (valueTol < 0 || taxTol < 0 || (tol['valueMinor'] !== undefined && int(tol['valueMinor']) === undefined) || (tol['taxMinor'] !== undefined && int(tol['taxMinor']) === undefined)) {
        return refuse('not_readable', 'The allowed difference must be 0 or more rupees. Nothing was saved.');
      }
      const { current } = mappingsNow();
      const missing = OLD_ERP_REPORT_KINDS.filter((k) => current[k] === undefined);
      if (missing.length > 0) {
        return refuse('no_mapping', `Map the columns first — once — for ${missing.map((k) => (k === 'item_wise' ? 'the item-wise report' : 'the bill-wise list')).join(' and ')}. Nothing was saved.`);
      }
      const item = readItemWiseReport({ text: i.itemWise, mapping: current.item_wise!.mapping, day: date });
      if (!item.ok) return refuse(item.refusedBecause, 'The item-wise report was not loaded:', item.problems);
      const bill = readBillWiseReport({ text: i.billWise, mapping: current.bill_wise!.mapping, day: date });
      if (!bill.ok) return refuse(bill.refusedBecause, 'The bill-wise list was not loaded:', bill.problems);
      const { sales, refunds } = await newSide();
      const result = eveningCheck({
        businessDate: date, department: src.department(), catalogue: src.catalogue(),
        itemWise: item.rows, billWise: { bills: bill.bills, withLines: bill.withLines }, sales, refunds,
        tolerance: { valueMinor: valueTol, taxMinor: taxTol },
      });
      if (!result.ok) return refuse(result.refusedBecause, result.detail);
      const comparisons = result.check.comparisons;
      const dayDigest = dayDigestOf(comparisons);
      const held = loadsOf(date);
      // The same figures again is the same day: kept as a load in the history, its reasons and signature stand. Other
      // figures are a new fact about the day: numbered apart, so they need their reasons afresh (MG-10).
      const sameAsBefore = held.find((l) => l.dayDigest === dayDigest);
      const differences = sameAsBefore !== undefined ? sameAsBefore.differences : compareParallelDay({
        tenantId: src.tenantId, businessDate: date, comparisons, idPrefix: differencePrefixFor(held.length > 0, dayDigest),
      }).differences;
      const rec: LoadRecord = {
        kind: 'day_loaded', businessDate: date, loadId: `${date}-${held.length + 1}`, loadedBy: i.by, loadedAt: i.at,
        files: {
          itemWise: { ...item.summary, mappingSetAt: current.item_wise!.setAt },
          billWise: { ...bill.summary, withLines: bill.withLines, mappingSetAt: current.bill_wise!.setAt },
        },
        check: result.check, comparisons, dayDigest, differences, newSideFingerprint: newSideFingerprintOf(date, sales, refunds),
      };
      if (!await write(rec)) return refuse('could_not_write_durably', 'This store computer could not write the day to its disk. Nothing was saved — try again.');
      const relayed = await src.relay(dayEvent(rec, differencesOf(rec), i.by, i.at), i.by, i.via);
      return { ok: true, day: viewOf(date, rec.newSideFingerprint), relayed: relayed.queued };
    }),

    explain: (i) => serial(async () => {
      const stop = authority(i.by);
      if (stop !== undefined) return stop;
      const date = readDate(i.businessDate);
      if (date === undefined || !Array.isArray(i.reasons) || i.reasons.length === 0) return refuse('not_readable', 'Giving reasons needs the day and at least one reason. Nothing was saved.');
      const current = loadsOf(date).at(-1);
      if (current === undefined) return refuse('day_not_loaded', `No files have been loaded for ${date}. Nothing was saved.`);
      let diffs = differencesOf(current);
      const taken: { differenceId: string; explanation: string; wrongSide?: Side }[] = [];
      const problems: string[] = [];
      for (const raw of i.reasons as unknown[]) {
        if (!isObj(raw) || str(raw['differenceId']) === undefined || typeof raw['explanation'] !== 'string') { problems.push('a reason needs the difference it is for and the words'); continue; }
        const differenceId = raw['differenceId'] as string;
        const explanation = (raw['explanation'] as string).trim();
        const wrongSide = (SIDES as readonly unknown[]).includes(raw['wrongSide']) ? raw['wrongSide'] as Side : undefined;
        if (explanation === '') continue;
        if (!diffs.some((d) => d.differenceId === differenceId)) { problems.push(`${differenceId} is not a difference of ${date} as it now stands`); continue; }
        if (looksLikeNoReason(explanation)) { problems.push(`${differenceId}: say what really happened, in at least 20 characters — "ok" or "checked" is not a reason anybody can read a year from now`); continue; }
        const out = ownDifference({ differences: diffs, differenceId, ownerUserId: i.by, explanation, ...(wrongSide === undefined ? {} : { wrongSide }) });
        if (!out.ok) { problems.push(`${differenceId}: ${out.detail}`); continue; }
        diffs = [...out.differences];
        taken.push({ differenceId, explanation, ...(wrongSide === undefined ? {} : { wrongSide }) });
      }
      if (problems.length > 0) return refuse(problems.some((p) => p.includes('20 characters')) ? 'reason_says_nothing' : 'reason_refused', 'No reason was saved:', problems);
      if (taken.length === 0) return refuse('not_readable', 'Write a reason beside at least one difference. Nothing was saved.');
      const rec: ReasonsRecord = { kind: 'reasons_given', businessDate: date, dayDigest: current.dayDigest, by: i.by, at: i.at, reasons: taken };
      if (!await write(rec)) return refuse('could_not_write_durably', 'This store computer could not write the reasons to its disk. Nothing was saved — try again.');
      const relayed = await src.relay(dayEvent(current, differencesOf(current), i.by, i.at), i.by, i.via);
      return { ok: true, day: viewOf(date), relayed: relayed.queued };
    }),

    sign: (i) => serial(async () => {
      const stop = authority(i.by);
      if (stop !== undefined) return stop;
      const date = readDate(i.businessDate);
      if (date === undefined || typeof i.statement !== 'string') return refuse('not_readable', 'Signing needs the day and what you checked, in your own words. Nothing was signed.');
      const current = loadsOf(date).at(-1);
      if (current === undefined) return refuse('day_not_loaded', `No files have been loaded for ${date}, so there is nothing to sign.`);
      const held = signaturesOf(date).find((s) => s.dayDigest === current.dayDigest);
      if (held !== undefined) return refuse('already_signed', `${date} is already signed by ${held.signedBy} at ${held.signedAt}, over these figures.`);
      const result = signParallelDay({
        businessDate: date, comparisons: current.comparisons, differences: differencesOf(current), signedBy: i.by, statement: i.statement,
        now: i.at, reconcilerUserId: src.reconcilerUserId()!, ownerUserId: undefined,
      });
      if (!result.ok) {
        return refuse(result.refusedBecause as EveningRefusal, result.detail, result.unexplained.map((d) => `${d.differenceId} · ${d.area.replace(/_/g, ' ')}${d.subject === undefined ? '' : ` · ${d.subject}`}`));
      }
      if (!await write({ kind: 'day_signed', businessDate: date, signature: result.signature })) return refuse('could_not_write_durably', 'This store computer could not write the signature to its disk. Nothing was signed — try again.');
      const s = result.signature;
      const relayed = await src.relay(makeEvent({
        id: `MigrationParallelDaySigned-${date}:${s.dayDigest}`, type: 'MigrationParallelDaySigned', occurredAt: i.at,
        idempotencyKey: `${src.tenantId}:MigrationParallelDaySigned:${date}:${s.dayDigest}`, source: 'store-computer:evening-check',
        payload: { tenantId: src.tenantId, cutoverId: src.cutoverId() ?? '', businessDate: date, signedBy: i.by, statement: s.statement, dayDigest: s.dayDigest, signedAt: i.at },
      }), i.by, i.via);
      return { ok: true, day: viewOf(date), signature: s, relayed: relayed.queued };
    }),

    day: async (businessDate) => {
      if (loadsOf(businessDate).length === 0) return viewOf(businessDate);
      const { sales, refunds } = await newSide();
      return viewOf(businessDate, newSideFingerprintOf(businessDate, sales, refunds));
    },

    days: () => [...new Set(records.filter((r): r is LoadRecord => r.kind === 'day_loaded').map((r) => r.businessDate))].sort().reverse().map((date) => {
      const v = viewOf(date);
      return {
        businessDate: date, loadedAt: v.current!.loadedAt, differences: v.differences.length, unexplained: v.unexplained.length,
        ...(v.signature === undefined ? {} : { signedBy: v.signature.signedBy }),
      };
    }),

    get unreadableRecords() { return unreadable; },
    close: () => log.close(),
  };
}
