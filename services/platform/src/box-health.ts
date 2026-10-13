// Store computer and till health reach head office (M35-FR-03 · D04-FR-05 · OB-54 · P-08 · §31).
//
// Head office could judge the sync clock and the queues from the box's watermark reports, but three things only the box
// knows stayed `unknown` at head office: whether its disk still has room to record a sale, what the tills' own devices
// last said (scanner, printer, scale, drawer, card machine — D04-FR-05, kept on the box for the manager's Today screen),
// and how deep its own queue is right now. After each sync pass the box now says so (POST below), and head office's
// observed health judges them:
//   • disk — `down` when the box itself would refuse the next sale (its sales log, plus the reserve the box keeps, no
//     longer fits its capacity, or the filesystem has less free than that reserve). That is the box's own rule
//     (edge/store-edge/src/durability.ts `commitLocally`), not a new one; otherwise `ok`, with the free bytes and the
//     headroom shown (M35-FR-04 "capacity headroom is reported");
//   • till devices — `degraded` when any device failed or is not working properly, each named (a device failing never
//     stops a sale, so it is never `down`); `unknown` when no till has reported, never "all fine";
//   • the box's queue — judged on the shop's own queue and dead-letter thresholds (the same ones the cloud queue uses).
// A report older than the shop's sync-lag warning threshold (§32, 15 minutes by default — the alert rules' own setting)
// is STALE: the last values are shown, said to be stale and how old, and the component is `unknown` — never `ok` on old
// news (P-08). While a box is cut off it cannot report, so its report ages into stale by itself.
//
// Store-locked (OB-54): the report names no store; head office stamps the store the box's SIGNED credential names
// (`STORE_STAMP_FIELD`), and only that store's own computer may report it. A report that names another store is refused
// at the door and kept as a refusal. Append-only: every report is kept; the latest per store is read.

import type { Route } from '../../kernel/src/index';
import { apiError, scopeOf } from '../../kernel/src/index';
import type { ComponentHealth, HealthStatus, HealthThresholds } from '../../../packages/ops/src/index';
import { STORE_COMPUTER_REPORT, assertStoreComputerOf, type StoreComputerScopeOf } from './store-computer-identity';

export const BOX_HEALTH_PATH = '/v1/store-computers/health-reports';

/** The till device kinds and states the box keeps (mirrors edge/store-edge/src/peripheral-health.ts). */
export const TILL_DEVICE_KINDS = ['scanner', 'printer', 'scale', 'cash_drawer', 'card_terminal'] as const;
export const TILL_DEVICE_STATES = ['ok', 'degraded', 'failed'] as const;

export interface BoxDisk {
  /** Free bytes on the filesystem that holds the box's data folder. */
  readonly freeBytes: number;
  readonly totalBytes: number;
  /** The sales log's size and the capacity the box was given for it, and the reserve below which it refuses a sale. */
  readonly salesLogUsedBytes: number;
  readonly salesLogCapacityBytes: number;
  readonly reserveBytes: number;
}

export interface TillDeviceReport {
  readonly laneId: string;
  readonly reportedAt: string;
  readonly devices: readonly { readonly kind: string; readonly state: string; readonly detail?: string }[];
  /**
   * P-08: is somebody signed in at that till now, by the store computer's own sessions? A signed-in till re-sends its
   * devices every 5 minutes (apps/pos/src/device-heartbeat.ts); an unattended one stops, so its lane goes stale — expected
   * when nobody is there, a till to check when somebody is. Absent from a box that does not say.
   */
  readonly attended?: boolean;
  /**
   * Round 15 (verifier LOW · P-08): when the till's device ADAPTER says it last observed the devices — its own clock. The
   * till re-sends the adapter's last answer every few minutes, so `reportedAt` stays fresh even when the adapter has hung;
   * when the adapter gives its time, head office ages the lane by THAT (never later than `reportedAt`), so a hung adapter
   * reads stale. Absent → the lane is aged by `reportedAt`, as before.
   */
  readonly adapterObservedAt?: string;
}

/** One report, as head office keeps it. */
export interface BoxHealthRecord {
  readonly storeId: string;
  /** The box's clock at the report (cut back to `receivedAt` when it was ahead). */
  readonly observedAt: string;
  readonly receivedAt: string;
  readonly reportedBy: string;
  readonly disk: BoxDisk;
  readonly queue: { readonly unsent: number; readonly deadLettered: number };
  readonly tills: readonly TillDeviceReport[];
  readonly clockAheadCorrected: boolean;
  /**
   * Verifier r18 (item 6 · OB-85/87): the highest bill-number count the box has GIVEN under each prefix — used on a bill or
   * not (a voided or abandoned bill keeps its number). Head office folds it into `bankedThrough`, so a replaced box never
   * re-gives a number a customer saw on a voided bill. Absent on a box that predates it.
   */
  readonly receiptNumbersIssued?: readonly IssuedReport[];
  /**
   * Verifier r19 BOX-1: what head office REFUSED to fold into `bankedThrough` from this report, and why — a prefix issued to
   * another store's till, or a count beyond a plausible advance over what head office banked. Kept as evidence and shown
   * to the owner as a finding; never folded, so a report alone can never lock a till.
   */
  readonly receiptNumbersRefused?: readonly RefusedIssued[];
  /** Verifier r19 BOX-1: prefixes reported that head office never issued (the box's own store-coded fallback): not folded, no finding. */
  readonly receiptNumbersNotFolded?: readonly { readonly prefix: string; readonly through: number }[];
  /** Verifier r19 OB87-1/OB87-2: the box's own check of its bill-number witness, and any held restore. */
  readonly billNumbering?: BillNumberingState;
  /**
   * Verifier r21 UNSENT-CEILING (a): the report's per-prefix bills still to send (or given up on) add up to MORE than its own
   * whole queue holds — the box contradicts itself. Said here in words; head office then believes none of its per-prefix
   * lists (`believedRecord`), so a number it does not hold can still be named "never received".
   */
  readonly queueContradiction?: string;
}

/**
 * Verifier r20 LOST-1 / r21: bills under one prefix in one of the box's queues — how many, the lowest and highest count among
 * them (`count: 0`: none), and (r21 UNSENT-CEILING b) when the OLDEST of them was made (its sale's own time), so head office
 * can say how long they have waited on the store computer.
 */
export interface QueuedBillNumbers { readonly count: number; readonly from?: number; readonly to?: number; readonly oldestAt?: string }

/** One prefix the box says it has given numbers under (verifier r18 item 6; r19 adds what it cannot vouch for). */
export interface IssuedReport {
  readonly prefix: string;
  readonly through: number;
  /** The highest count put on a bill on the box, or that it cannot vouch for (absent on an older box: `through` stands in). */
  readonly soldThrough?: number;
  /** Numbers the box cannot vouch for — given after the backup it was restored from — as [from, to] ranges. */
  readonly atRisk?: readonly (readonly [number, number])[];
  /**
   * Verifier r20 LOST-1: the bills under this prefix still waiting in the box's own queues when it reported — how many, and
   * the lowest and highest count among them (`count: 0`: none). Absent on an older box: its whole queue stands in.
   */
  readonly unsent?: QueuedBillNumbers;
  /**
   * Verifier r21 DEAD-LETTER-AS-LOST: the bills under this prefix the box GAVE UP sending (its dead letters) — on the box,
   * waiting for a person, never "lost". Absent on an older box.
   */
  readonly deadLettered?: QueuedBillNumbers;
}

/** Verifier r19 BOX-1: a reported count head office would not fold, and why. */
export interface RefusedIssued {
  readonly prefix: string;
  readonly through: number;
  readonly because: 'prefix_of_another_store' | 'beyond_plausible_advance';
  /** What head office holds banked (sales and refunds) under the prefix when the report arrived. */
  readonly bankedThrough: number;
  /** The most it would accept: banked + PLAUSIBLE_ISSUED_AHEAD (for `beyond_plausible_advance`). */
  readonly plausibleThrough?: number;
}

/** Verifier r19 OB87-1/OB87-2: the box's witness check, as head office keeps it. */
export interface BillNumberingState {
  readonly witness: 'kept' | 'unavailable' | 'none';
  readonly fault?: string;
  readonly restoreHeld: boolean;
  readonly restoreBecause?: string;
  readonly restoreSince?: string;
  readonly sharedWith: readonly { readonly box: string; readonly lastWrittenAt: string }[];
}

/**
 * Verifier r19 BOX-1 — THE BOUND (stated, so a person can check it): head office folds a box's reported count under a prefix
 * only up to what it has banked under that prefix (sales and refunds) PLUS this many numbers. A box reports on every sync
 * pass; a busy hypermarket lane rings well under 1,500 bills a day, so 10,000 numbers is about a week of one lane's bills
 * given and not yet banked (offline, voided, abandoned). A count beyond it is refused for the high-water and shown to the
 * owner as a finding — it never moves `bankedThrough`, so a till can never be locked by a report alone.
 */
export const PLAUSIBLE_ISSUED_AHEAD = 10_000;
/**
 * Verifier r19 (sales lost by a restore · P-08): numbers a box put on bills (or cannot vouch for after a restore) that head
 * office has still not received this long after the box first reported them are named as "bills issued but never received".
 * The box drains its queue before it reports, so 30 minutes is many sync passes.
 */
export const UNRECEIVED_GRACE_MINUTES = 30;
/** At most this many numbers per prefix are checked one by one for "never received" (the rest are said to be unchecked). */
export const UNRECEIVED_CHECK_CAP = 500;

/** Verifier r19: a bill-number finding on one store computer, for the owner (P-03: only what needs a person). */
export interface BillNumberFinding {
  /**
   * r19: `issued_never_received`, `report_refused`. r21: `bills_waiting_on_box` (bills the box has held unsent past the
   * owner's line), `bills_dead_lettered_on_box` (bills the box gave up sending — needs a person, never re-entered from
   * paper), `report_contradicts_its_queue` (the per-prefix lists do not fit the box's own queue: not believed).
   * r23 NEW-1 · OB-89: `report_contradicts_earlier_report` (the latest list claims bills an earlier report said the box no
   * longer held, and head office never received: not believed — they are named as never received).
   */
  readonly kind: 'issued_never_received' | 'report_refused' | 'bills_waiting_on_box' | 'bills_dead_lettered_on_box' | 'report_contradicts_its_queue'
    | 'report_contradicts_earlier_report';
  readonly prefix: string;
  /** The numbers concerned, as [from, to] count ranges (issued_never_received), or the refused count (report_refused). */
  readonly ranges?: readonly (readonly [number, number])[];
  readonly through?: number;
  /** r21: how many bills (waiting / given up on). */
  readonly count?: number;
  readonly since: string;
  readonly detail: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isIso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) && !Number.isNaN(Date.parse(v));
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isWord = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max;
const earlier = (a: string, b: string): string => (Date.parse(a) <= Date.parse(b) ? a : b);

/** Read a box's report (the store is the stamped one, read by the route). `problems` when it is not one. */
export function readBoxHealthReport(body: unknown, receivedAt: string):
  {
    observedAt: string; disk: BoxDisk; queue: { unsent: number; deadLettered: number }; tills: TillDeviceReport[]; clockAheadCorrected: boolean;
    receiptNumbersIssued?: IssuedReport[]; billNumbering?: BillNumberingState;
  } | { problems: string[] } {
  const b = isObj(body) ? body : {};
  const problems: string[] = [];
  if (!isIso(b['observedAt'])) problems.push('observedAt must be an ISO-8601 UTC time');
  const d = isObj(b['disk']) ? b['disk'] : undefined;
  const diskKeys = ['freeBytes', 'totalBytes', 'salesLogUsedBytes', 'salesLogCapacityBytes', 'reserveBytes'] as const;
  if (d === undefined || !diskKeys.every((k) => isCount(d[k]))) problems.push(`disk needs whole-number ${diskKeys.join(', ')}`);
  else if ((d['freeBytes'] as number) > (d['totalBytes'] as number)) problems.push('disk.freeBytes cannot exceed disk.totalBytes');
  const q = isObj(b['queue']) ? b['queue'] : undefined;
  if (q === undefined || !isCount(q['unsent']) || !isCount(q['deadLettered'])) problems.push('queue needs whole-number unsent and deadLettered');
  const rawTills = b['tills'];
  const tills: TillDeviceReport[] = [];
  let corrected = false;
  if (!Array.isArray(rawTills) || rawTills.length > 50) problems.push('tills must be a list (at most 50) of { laneId, reportedAt, devices }');
  else {
    rawTills.forEach((t: unknown, i) => {
      if (!isObj(t) || typeof t['laneId'] !== 'string' || t['laneId'].trim() === '' || !isIso(t['reportedAt']) || !Array.isArray(t['devices']) || t['devices'].length === 0 || t['devices'].length > 20) {
        problems.push(`tills[${i}] needs laneId, reportedAt (ISO-8601 UTC) and 1–20 devices`); return;
      }
      const devices: { kind: string; state: string; detail?: string }[] = [];
      for (const x of t['devices'] as unknown[]) {
        if (!isObj(x) || !(TILL_DEVICE_KINDS as readonly string[]).includes(x['kind'] as string) || !(TILL_DEVICE_STATES as readonly string[]).includes(x['state'] as string)) {
          problems.push(`tills[${i}] names a device or state head office does not know (kinds: ${TILL_DEVICE_KINDS.join(', ')}; states: ${TILL_DEVICE_STATES.join(', ')})`); return;
        }
        const detail = typeof x['detail'] === 'string' && x['detail'].trim() !== '' ? x['detail'].trim().slice(0, 120) : undefined;
        devices.push({ kind: x['kind'] as string, state: x['state'] as string, ...(detail === undefined ? {} : { detail }) });
      }
      if (t['attended'] !== undefined && typeof t['attended'] !== 'boolean') { problems.push(`tills[${i}].attended must be true or false when given`); return; }
      if (t['adapterObservedAt'] !== undefined && !isIso(t['adapterObservedAt'])) { problems.push(`tills[${i}].adapterObservedAt must be an ISO-8601 UTC time when given`); return; }
      let reportedAt = t['reportedAt'] as string;
      if (Date.parse(reportedAt) > Date.parse(receivedAt)) { reportedAt = receivedAt; corrected = true; }
      // The adapter cannot have observed the devices after the till reported them: a later time (a clock ahead) is cut back.
      let adapterObservedAt = t['adapterObservedAt'] as string | undefined;
      if (adapterObservedAt !== undefined && Date.parse(adapterObservedAt) > Date.parse(reportedAt)) { adapterObservedAt = reportedAt; corrected = true; }
      tills.push({
        laneId: (t['laneId'] as string).trim(), reportedAt, devices, ...(typeof t['attended'] === 'boolean' ? { attended: t['attended'] } : {}),
        ...(adapterObservedAt === undefined ? {} : { adapterObservedAt }),
      });
    });
  }
  // Verifier r18 item 6: the box's highest GIVEN count per bill-number prefix (optional). A prefix is at most 10 characters
  // and a count 1…999 999 (packages/contracts/src/receipt-number.ts) — anything else is refused, never guessed.
  const rawIssued = b['receiptNumbersIssued'];
  const receiptNumbersIssued: IssuedReport[] = [];
  if (rawIssued !== undefined) {
    if (!Array.isArray(rawIssued) || rawIssued.length > 200) problems.push('receiptNumbersIssued must be a list (at most 200) of { prefix, through }');
    else {
      rawIssued.forEach((x: unknown, i) => {
        if (!isObj(x) || typeof x['prefix'] !== 'string' || x['prefix'] === '' || x['prefix'].length > 10 || x['prefix'] !== x['prefix'].trim()
          || !isCount(x['through']) || (x['through'] as number) < 1 || (x['through'] as number) > 999_999) {
          problems.push(`receiptNumbersIssued[${i}] needs a prefix (1–10 characters) and a whole count from 1 to 999999`); return;
        }
        const through = x['through'] as number;
        // Verifier r19: what the box put on bills or cannot vouch for — optional; never above what it gave.
        if (x['soldThrough'] !== undefined && (!isCount(x['soldThrough']) || (x['soldThrough'] as number) > through)) {
          problems.push(`receiptNumbersIssued[${i}].soldThrough must be a whole count from 0 to its through`); return;
        }
        const rawRisk = x['atRisk'];
        if (rawRisk !== undefined && (!Array.isArray(rawRisk) || rawRisk.length > 50 || !rawRisk.every((r: unknown) => Array.isArray(r) && r.length === 2
          && isCount(r[0]) && isCount(r[1]) && (r[0] as number) >= 1 && (r[0] as number) <= (r[1] as number) && (r[1] as number) <= through))) {
          problems.push(`receiptNumbersIssued[${i}].atRisk must be at most 50 [from, to] ranges of counts from 1 to its through`); return;
        }
        // Verifier r20 LOST-1: the bills under this prefix still waiting in the box's queues (optional; an older box does not say).
        // Verifier r21: and the ones it gave up sending (`deadLettered`), each with when its oldest bill was made (`oldestAt`).
        const queued = (field: 'unsent' | 'deadLettered'): QueuedBillNumbers | undefined | 'bad' => {
          const raw = x[field];
          if (raw === undefined) return undefined;
          const u = isObj(raw) ? raw : {};
          const count = u['count'];
          const ok = isCount(count) && (count === 0
            ? u['from'] === undefined && u['to'] === undefined && u['oldestAt'] === undefined
            : isCount(u['from']) && isCount(u['to']) && (u['from'] as number) >= 1 && (u['from'] as number) <= (u['to'] as number) && (u['to'] as number) <= through
              && count <= (u['to'] as number) - (u['from'] as number) + 1 && (u['oldestAt'] === undefined || isIso(u['oldestAt'])));
          if (!ok) {
            problems.push(`receiptNumbersIssued[${i}].${field} must be { count: 0 }, or { count, from, to } with 1 <= from <= to <= its through and count at most to - from + 1 (and optionally oldestAt, an ISO-8601 UTC time)`);
            return 'bad';
          }
          if (count === 0) return { count: 0 };
          // The box's clock cannot have made a bill after head office received the report: a later time is cut back.
          const oldestAt = u['oldestAt'] === undefined ? undefined : earlier(u['oldestAt'] as string, receivedAt);
          return { count: count as number, from: u['from'] as number, to: u['to'] as number, ...(oldestAt === undefined ? {} : { oldestAt }) };
        };
        const unsent = queued('unsent');
        const deadLettered = queued('deadLettered');
        if (unsent === 'bad' || deadLettered === 'bad') return;
        receiptNumbersIssued.push({
          prefix: x['prefix'], through,
          ...(unsent === undefined ? {} : { unsent }),
          ...(deadLettered === undefined ? {} : { deadLettered }),
          ...(x['soldThrough'] === undefined ? {} : { soldThrough: x['soldThrough'] as number }),
          ...(rawRisk === undefined ? {} : { atRisk: (rawRisk as [number, number][]).map(([a, z]) => [a, z] as const) }),
        });
      });
    }
  }
  // Verifier r19 OB87-1/OB87-2: the box's witness check (optional — an older box does not say).
  const rawBn = b['billNumbering'];
  let billNumbering: BillNumberingState | undefined;
  if (rawBn !== undefined) {
    const n = isObj(rawBn) ? rawBn : {};
    const shared = n['sharedWith'];
    if (!['kept', 'unavailable', 'none'].includes(n['witness'] as string) || typeof n['restoreHeld'] !== 'boolean'
      || (n['fault'] !== undefined && !isWord(n['fault'], 400)) || (n['restoreBecause'] !== undefined && !isWord(n['restoreBecause'], 60))
      || (n['restoreSince'] !== undefined && !isIso(n['restoreSince']))
      || !Array.isArray(shared) || shared.length > 20 || !shared.every((x: unknown) => isObj(x) && isWord(x['box'], 40) && isIso(x['lastWrittenAt']))) {
      problems.push('billNumbering needs witness (kept, unavailable or none), restoreHeld (true/false), sharedWith (at most 20 { box, lastWrittenAt }), and optionally fault, restoreBecause, restoreSince');
    } else {
      billNumbering = {
        witness: n['witness'] as BillNumberingState['witness'], restoreHeld: n['restoreHeld'] as boolean,
        ...(n['fault'] === undefined ? {} : { fault: n['fault'] as string }),
        ...(n['restoreBecause'] === undefined ? {} : { restoreBecause: n['restoreBecause'] as string }),
        ...(n['restoreSince'] === undefined ? {} : { restoreSince: n['restoreSince'] as string }),
        sharedWith: (shared as Record<string, unknown>[]).map((x) => ({ box: x['box'] as string, lastWrittenAt: x['lastWrittenAt'] as string })),
      };
    }
  }
  if (problems.length > 0) return { problems };
  const observedRaw = b['observedAt'] as string;
  const observedAt = earlier(observedRaw, receivedAt);
  if (observedAt !== observedRaw) corrected = true;
  const disk = d!;
  return {
    observedAt,
    disk: {
      freeBytes: disk['freeBytes'] as number, totalBytes: disk['totalBytes'] as number, salesLogUsedBytes: disk['salesLogUsedBytes'] as number,
      salesLogCapacityBytes: disk['salesLogCapacityBytes'] as number, reserveBytes: disk['reserveBytes'] as number,
    },
    queue: { unsent: q!['unsent'] as number, deadLettered: q!['deadLettered'] as number },
    tills, clockAheadCorrected: corrected,
    ...(rawIssued === undefined ? {} : { receiptNumbersIssued }),
    ...(billNumbering === undefined ? {} : { billNumbering }),
  };
}

/**
 * Verifier r19 BOX-1: judge a box's reported counts against what head office issued and banked. Folded (`accepted`) only
 * for a prefix issued to a till of THIS store (any version), or this store's own `R-<lane>-` numbering, and only up to
 * banked + PLAUSIBLE_ISSUED_AHEAD. A prefix issued to another store's till, or a count beyond the bound, is `refused` (kept,
 * shown to the owner); a prefix head office never issued (the box's store-coded `ZZ` fallback) is `notFolded` — head office
 * keeps no count for it and raises nothing.
 */
export function judgeReportedIssued(input: {
  readonly storeId: string;
  readonly issued: readonly IssuedReport[];
  /** Every prefix head office ever issued to a till, with the store it was issued to. */
  readonly issuedPrefixes: ReadonlyMap<string, ReadonlySet<string>>;
  /** What head office holds banked under each prefix from sales and refunds (not from any box's report). */
  readonly banked: ReadonlyMap<string, number>;
}): { accepted: IssuedReport[]; refused: RefusedIssued[]; notFolded: { prefix: string; through: number }[] } {
  const accepted: IssuedReport[] = [];
  const refused: RefusedIssued[] = [];
  const notFolded: { prefix: string; through: number }[] = [];
  for (const r of input.issued) {
    const stores = input.issuedPrefixes.get(r.prefix);
    const ownBoxSeries = r.prefix.startsWith('R-') && r.prefix.endsWith('-') && r.prefix.length > 3;
    const banked = input.banked.get(r.prefix) ?? 0;
    if (stores === undefined && !ownBoxSeries) { notFolded.push({ prefix: r.prefix, through: r.through }); continue; }
    if (stores !== undefined && !stores.has(input.storeId)) {
      refused.push({ prefix: r.prefix, through: r.through, because: 'prefix_of_another_store', bankedThrough: banked });
      continue;
    }
    const plausibleThrough = banked + PLAUSIBLE_ISSUED_AHEAD;
    if (r.through > plausibleThrough) {
      refused.push({ prefix: r.prefix, through: r.through, because: 'beyond_plausible_advance', bankedThrough: banked, plausibleThrough });
      continue;
    }
    accepted.push(r);
  }
  return { accepted, refused, notFolded };
}

/**
 * Verifier r20 LOST-1: does this report say count `n` under this prefix is still waiting in the box's own queues? By the
 * prefix's `unsent` range when the box gives one (a count inside [from, to] is waiting — never assumed sent); from an older
 * box that gives none, its WHOLE queue stands in (`wholeQueueStandsIn`): anything unsent means the number may still be on
 * its way — but only up to the owner's line (verifier r22 D3 · OB-89, see `unreceivedCandidates`).
 *
 * Verifier r22 D5 — THE SPARSE-RANGE RULE (stated, so a person can check it by hand): a box's claim to hold `count` bills
 * can account for at most `count + slack` numbers, where slack = max(N, ⌈P% × count⌉) — OB-90 "C" (owner, 13 Oct 2026, in
 * writing): N and P are the owner's store-setup settings platform.box_claim_slack_numbers (default 5, 0–100) and
 * platform.box_claim_slack_percent (default 5, 0–50), so by default 5, or 5% of the count, whichever is more: room for
 * numbers given and voided (or abandoned) while the bills around them were still queued, which keep their numbers but are
 * never sent. The owner may tighten it (0 and 0: a claim accounts for exactly its own count).
 *   • A range whose span (to - from + 1) is within count + slack is believed whole: every number in it is on the box.
 *   • A WIDER range says the box holds `count` of the numbers in its span, not which — so it covers none of them here.
 *     Head office checks the span against what it banked (`weighSparseClaim`, after the ledger check): when the numbers it
 *     has not received in the span are no more than count + slack, the box's word accounts for them and nothing is named;
 *     when there are MORE, at least the difference cannot be on the box, so all of them are named, saying that up to
 *     `count` of them may be on it (do NOT re-enter until a person has checked the store computer).
 * An honest box with one old and one new dead letter ({2, 101, 600}, the bills between them received) is therefore never
 * called lost, while a claim of 2 bills over 500 missing numbers no longer hides 498 of them for as long as it is repeated.
 */
export function stillOnTheBox(
  r: Pick<BoxHealthRecord, 'queue'>, x: Pick<IssuedReport, 'unsent' | 'deadLettered'>, n: number,
  wholeQueueStandsIn: boolean = r.queue.unsent > 0, slack: ClaimSlack = DEFAULT_CLAIM_SLACK,
): boolean {
  // Verifier r21 DEAD-LETTER-AS-LOST: a bill the box gave up sending is ON the box (waiting for a person), never lost.
  if (coversEvery(x.deadLettered, n, slack)) return true;
  if (x.unsent !== undefined) return coversEvery(x.unsent, n, slack);
  return wholeQueueStandsIn;
}

/** A range that names at least one bill. */
const names = (q: QueuedBillNumbers | undefined): q is QueuedBillNumbers & { from: number; to: number } =>
  q !== undefined && q.count > 0 && q.from !== undefined && q.to !== undefined;
/** Verifier r22 D5: the slack a claim of `count` bills is allowed (voided numbers among them) — see THE SPARSE-RANGE RULE. */
export interface ClaimSlack {
  /** At least this many extra numbers (platform.box_claim_slack_numbers, 0–100). */
  readonly numbers: number;
  /** Or this percentage of the claimed count, rounded up, when more (platform.box_claim_slack_percent, 0–50). */
  readonly percent: number;
}
/** OB-90: the default — 5 numbers or 5%, whichever is more (the rule as built in round 23, decision A's values). */
export const DEFAULT_CLAIM_SLACK: ClaimSlack = { numbers: 5, percent: 5 };
/** max(numbers, ⌈percent% × count⌉), in whole-number arithmetic (no floating-point rounding). */
export const sparseSlack = (count: number, slack: ClaimSlack = DEFAULT_CLAIM_SLACK): number =>
  Math.max(slack.numbers, Math.floor((count * slack.percent + 99) / 100));
/** Verifier r22 D5: a range believed WHOLE — its span is within its count plus the slack. */
export const believedWhole = (q: QueuedBillNumbers | undefined, slack: ClaimSlack = DEFAULT_CLAIM_SLACK): boolean =>
  names(q) && q.to - q.from + 1 <= q.count + sparseSlack(q.count, slack);
/** Count `n` lies in a range believed whole (a wider, sparse range vouches for no particular number). */
const coversEvery = (q: QueuedBillNumbers | undefined, n: number, slack: ClaimSlack): boolean => names(q) && believedWhole(q, slack) && n >= q.from && n <= q.to;

/** Verifier r22 D5: the SPARSE ranges of one prefix's report — how many bills they say the box holds, and over which spans. */
export function sparseHolding(x: Pick<IssuedReport, 'unsent' | 'deadLettered'>, slack: ClaimSlack = DEFAULT_CLAIM_SLACK): { count: number; spans: [number, number][] } | undefined {
  const sparse = [x.unsent, x.deadLettered].filter((q): q is QueuedBillNumbers & { from: number; to: number } => names(q) && !believedWhole(q, slack));
  return sparse.length === 0 ? undefined : { count: sparse.reduce((a, q) => a + q.count, 0), spans: sparse.map((q) => [q.from, q.to]) };
}

/**
 * Verifier r21 UNSENT-CEILING (a): does a report's per-prefix list fit the box's OWN queue? The bills still to send under all
 * its prefixes are some of the items in its queues, so their counts cannot add up to more than `queue.unsent`; the same for
 * the ones it gave up on and `queue.deadLettered`. Returns the contradiction in words, or undefined.
 */
export function queueContradiction(queue: BoxHealthRecord['queue'], issued: readonly IssuedReport[]): string | undefined {
  const unsent = issued.reduce((n, x) => n + (x.unsent?.count ?? 0), 0);
  const dead = issued.reduce((n, x) => n + (x.deadLettered?.count ?? 0), 0);
  const parts: string[] = [];
  if (unsent > queue.unsent) parts.push(`its bills still to send under each prefix add up to ${unsent}, more than the ${queue.unsent} item(s) its whole queue holds`);
  if (dead > queue.deadLettered) parts.push(`its bills given up on under each prefix add up to ${dead}, more than the ${queue.deadLettered} item(s) it says it gave up on`);
  return parts.length === 0 ? undefined : parts.join('; ');
}

/**
 * Verifier r21 UNSENT-CEILING (a): the report as head office BELIEVES it. A report that contradicts its own queue is kept as
 * evidence, but none of its per-prefix lists is believed: every prefix reads "holds none" — so a number head office never
 * received can be named after the grace, rather than hidden for ever behind a claim the box's own queue does not support.
 */
export function believedRecord(r: BoxHealthRecord): BoxHealthRecord {
  const issued = r.receiptNumbersIssued;
  if (issued === undefined) return r;
  const contradiction = r.queueContradiction ?? queueContradiction(r.queue, issued);
  if (contradiction === undefined) return r;
  return {
    ...r, queueContradiction: contradiction,
    receiptNumbersIssued: issued.map((x) => { const { deadLettered: _d, ...rest } = x; void _d; return { ...rest, unsent: { count: 0 } }; }),
  };
}

/** The owner's default line (verifier r21 UNSENT-CEILING b): warn when bills have waited on a store computer this many hours. */
export const DEFAULT_BOX_UNSENT_WARN_HOURS = 2;

/**
 * Verifier r21 UNSENT-CEILING (b) — bills waiting on a store computer past the owner's line. For each prefix whose LATEST
 * believed report says bills are still to send, they have been waiting since the earlier of:
 *   • head office's own observation — verifier r22 D4, r23 NEW-1 · OB-89: the FIRST report, of all head office holds,
 *     whose list of bills still to send reached any number of the latest list. The age belongs to the NUMBERS head office
 *     saw waiting — never to the box's `from` (lowering it by one each report restarts nothing), and never to a run of
 *     reports (an "empty queue" report, or a list elsewhere, sent in between restarts nothing either);
 *   • the box's own word — when that oldest bill was made (`oldestAt`), when it gives one.
 * Verifier r22 D3 · OB-89: a report that does NOT say which bills it holds (an older or altered box: no per-prefix
 * `unsent`) while its whole queue holds something is aged the same way — from head office's first sight of an unbroken
 * run of such reports — so dropping the field never hides bills past the line.
 * Past `warnHours` it is a finding: "bills waiting on the store computer for N hours". A box drains its queue before it
 * reports, so an honest box's waiting bills change pass by pass; numbers that stay put for hours are stuck (or claimed).
 */
export function billsWaitingOnTheBox(input: {
  readonly records: readonly BoxHealthRecord[];
  readonly storeId: string;
  readonly at: string;
  readonly warnHours?: number;
}): BillNumberFinding[] {
  const warnHours = input.warnHours ?? DEFAULT_BOX_UNSENT_WARN_HOURS;
  const atMs = Date.parse(input.at);
  const mine = input.records.filter((r) => r.storeId === input.storeId && Date.parse(r.receivedAt) <= atMs)
    .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt)).map(believedRecord);
  const latest = new Map<string, { r: BoxHealthRecord; x: IssuedReport }>();
  // r23 NEW-1: every span head office has been told is waiting, per prefix, in the order it was told.
  const waitingSpans = new Map<string, { at: string; from: number; to: number }[]>();
  for (const r of mine) {
    for (const x of r.receiptNumbersIssued ?? []) {
      latest.set(x.prefix, { r, x });
      const w = x.unsent;
      if (names(w)) {
        const spans = waitingSpans.get(x.prefix);
        if (spans === undefined) waitingSpans.set(x.prefix, [{ at: r.receivedAt, from: w.from, to: w.to }]);
        else spans.push({ at: r.receivedAt, from: w.from, to: w.to });
      }
    }
  }
  const out: BillNumberFinding[] = [];
  for (const [prefix, { r: last, x }] of [...latest].sort((a, b) => a[0].localeCompare(b[0]))) {
    const u = x.unsent;
    if (u === undefined) {
      // r22 D3: the box does not say which bills — its whole queue stands in, but only until the owner's line.
      if (last.queue.unsent === 0) continue;
      const since = wholeQueueRunSince(mine, prefix, last.receivedAt);
      const hours = (atMs - Date.parse(since)) / 3_600_000;
      if (hours < warnHours) continue;
      out.push({
        kind: 'bills_waiting_on_box', prefix, count: last.queue.unsent, since,
        detail: `bills may be waiting on the store computer for ${Math.floor(hours)} hours: store ${input.storeId}'s computer has said since ${since} that its queue holds item(s) still to send (${last.queue.unsent} now), and it does not say which bills under ${prefix} they are (an older or altered store computer) — longer than the ${warnHours}-hour line. Head office no longer takes that as a reason to hold back: any bill under ${prefix} it has not received is checked as never received. Check that store computer's connection and its "waiting to send" count, and call support. Do NOT re-enter bills from paper until support has checked the store computer`,
      });
      continue;
    }
    if (u.count === 0 || u.from === undefined || u.to === undefined) continue;
    // r23 NEW-1 · OB-89: the clock belongs to each NUMBER — from head office's first sight of any number of the latest list
    // said to be waiting, in ANY earlier report. Never per run of reports: an "empty queue" (or any other) report in between
    // restarts nothing. A list's span only reaches a number once it is sold, and an honest box keeps its oldest waiting bill
    // in every list until head office takes it, so for an honest box this is when its oldest waiting bill was first seen.
    const { from, to } = u;
    const first = (waitingSpans.get(prefix) ?? []).find((e) => e.from <= to && e.to >= from) ?? { at: last.receivedAt, from, to };
    const observedSince = first.at;
    const lo = Math.max(u.from, first.from);
    const hi = Math.min(u.to, first.to);
    const since = u.oldestAt !== undefined && Date.parse(u.oldestAt) < Date.parse(observedSince) ? u.oldestAt : observedSince;
    const hours = (atMs - Date.parse(since)) / 3_600_000;
    if (hours < warnHours) continue;
    out.push({
      kind: 'bills_waiting_on_box', prefix, ranges: [[u.from, u.to]], count: u.count, since,
      detail: `bills waiting on the store computer for ${Math.floor(hours)} hours: store ${input.storeId}'s computer has held ${u.count} bill(s) under ${prefix} (between ${rangeWords(prefix, [[u.from, u.to]])}) unsent since ${since}; head office first saw ${rangeWords(prefix, [[lo, hi]])} said to be waiting at ${observedSince}, and they are still said to be waiting — longer than the ${warnHours}-hour line. Head office has not received them. Check that store computer's connection and its "waiting to send" count; if the count is not going down, call support. Do NOT re-enter these bills from paper until support has checked the store computer`,
    });
  }
  return out;
}

/**
 * Verifier r22 D3: when head office first saw the unbroken run, up to `until`, of reports naming `prefix` WITHOUT a per-prefix
 * `unsent` list while the box's whole queue held something — head office's own observation, never the box's word.
 */
export function wholeQueueRunSince(ordered: readonly BoxHealthRecord[], prefix: string, until: string): string {
  let since = until;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const r = ordered[i]!;
    if (Date.parse(r.receivedAt) > Date.parse(until)) continue;
    const y = (r.receiptNumbersIssued ?? []).find((z) => z.prefix === prefix);
    if (y === undefined) continue;
    if (y.unsent !== undefined || r.queue.unsent === 0) break;
    since = r.receivedAt;
  }
  return since;
}

/** Verifier r22 D3/D5: one prefix's never-received candidates, and what the box's latest report still claims about them. */
export interface UnreceivedCandidate {
  readonly storeId: string;
  readonly prefix: string;
  readonly numbers: number[];
  readonly since: string;
  readonly capped: boolean;
  /** r22 D5: the latest report's SPARSE ranges — it says it holds `count` bills somewhere in these spans, not which. */
  readonly sparse?: { readonly count: number; readonly spans: readonly (readonly [number, number])[] };
  /** r22 D3: the latest report gives no per-prefix list; its whole queue held `items` since `since` — past the owner's line. */
  readonly wholeQueue?: { readonly items: number; readonly since: string };
  /**
   * Verifier r23 NEW-1 · OB-89: numbers (among `numbers`) that an earlier report SAID were not on the box — and that the
   * latest report claims again (`byList`: by naming them in its list's span; otherwise its whole queue stands in). A bill
   * the box has let go never honestly comes back into its queue, so the claim no longer holds them back. `saidGoneAt` is
   * the earliest time a report said one of them was gone.
   */
  readonly reclaimed?: { readonly numbers: readonly number[]; readonly saidGoneAt: string; readonly byList: boolean };
}

/**
 * Verifier r23 NEW-1: does a report, by its OWN word, say it may still hold count `n` — inside one of its lists' spans
 * (sparse or whole: 'list'), or, when it gives no list, inside its whole queue (or its given-up queue when it gives no list
 * of those: 'queue')? `undefined`: the report says the box does not hold `n`.
 */
export function saysItMayHold(r: Pick<BoxHealthRecord, 'queue'>, x: Pick<IssuedReport, 'unsent' | 'deadLettered'>, n: number): 'list' | 'queue' | undefined {
  const inSpan = (q: QueuedBillNumbers | undefined): boolean => names(q) && n >= q.from && n <= q.to;
  if (inSpan(x.unsent) || inSpan(x.deadLettered)) return 'list';
  if (x.unsent === undefined && r.queue.unsent > 0) return 'queue';
  // An older box that does not list the bills it gave up on, but says it holds some: they may be among them (never "gone").
  if (x.deadLettered === undefined && r.queue.deadLettered > 0) return 'queue';
  return undefined;
}

/** r23 NEW-2: everything in one prefix's report that decides which of its numbers are noted, and which are said gone. */
function saidWords(r: Pick<BoxHealthRecord, 'queue'>, x: IssuedReport): string {
  const q = (y: QueuedBillNumbers | undefined): string => (y === undefined ? '-' : `${y.count},${y.from ?? ''},${y.to ?? ''}`);
  return `${x.soldThrough ?? ''}|${x.through}|${q(x.unsent)}|${q(x.deadLettered)}|${r.queue.unsent > 0 ? 1 : 0}${r.queue.deadLettered > 0 ? 1 : 0}|${(x.atRisk ?? []).join(';')}`;
}

/**
 * Verifier r19 (sales lost by a restore · P-08), r20 LOST-1 (P-03): the numbers each store's box put on bills, or cannot
 * vouch for, that head office should hold by now. A number is a candidate when it is above what head office has banked
 * under its prefix up to the reported `soldThrough` (`through` from an older box), or in the `atRisk` list — AND:
 *   • the box has said it no longer holds it: a report whose queue for that prefix is empty or does not cover the number
 *     (`stillOnTheBox`); the grace (UNRECEIVED_GRACE_MINUTES) runs from the FIRST such report, never from when the number
 *     was first reported sold — so a long catch-up after an outage, with the bills still queued, raises nothing;
 *   • the box's LATEST report naming the prefix does not say it holds it again — unless (verifier r23 NEW-1 · OB-89) an
 *     earlier report already said, by its own word, that the box did NOT hold it (`saysItMayHold`: its queue empty, its
 *     lists not reaching it) at least the grace ago. A box keeps a bill in its queue until head office takes it (then head
 *     office has banked it), and a bill it gave up on stays in its given-up list — so a bill it has let go never honestly
 *     comes back: the later claim is a contradiction (`reclaimed`) and holds nothing back. Sending an "empty queue" report
 *     before each "still waiting" one therefore hides nothing.
 * Verifier r22 D3 · OB-89: a report with NO per-prefix list (an older or altered box) lets its whole queue stand in only
 * until the owner's line (`warnHours`, platform.box_unsent_warn_hours, default 2) counted from head office's FIRST sight of
 * an unbroken run of such reports; from then on its numbers are candidates like any other (the grace runs from the line).
 * Verifier r22 D5: a SPARSE range covers no particular number (see `stillOnTheBox`); the caller weighs it against the ledger.
 * Per store and prefix, at most UNRECEIVED_CHECK_CAP numbers (the newest), with the time of the first report that said the
 * box no longer held them. The caller checks the ones at or below banked against the ledger; those above it are unbanked
 * by definition (banked is the highest count head office holds).
 *
 * Verifier r23 NEW-2 (cost): every time is parsed ONCE per report and compared as milliseconds; a number already noted at or
 * before this report's time (and already said gone) is skipped without a look; and a report that repeats the previous one
 * for its prefix word for word (the box saying the same thing every 15 seconds) changes nothing and is skipped whole. The
 * fold is synchronous (every health read, every alert pass), so it must stay cheap — see the performance suite.
 */
export function unreceivedCandidates(input: {
  readonly records: readonly BoxHealthRecord[];
  readonly at: string;
  readonly banked: ReadonlyMap<string, number>;
  readonly warnHours?: number;
  /** OB-90: the owner's claim slack (store setup); absent, the default 5 / 5%. */
  readonly slack?: ClaimSlack;
}): UnreceivedCandidate[] {
  const slack = input.slack ?? DEFAULT_CLAIM_SLACK;
  const atMs = Date.parse(input.at);
  const cutoff = atMs - UNRECEIVED_GRACE_MINUTES * 60_000;
  const lineMs = (input.warnHours ?? DEFAULT_BOX_UNSENT_WARN_HOURS) * 3_600_000;
  /** Per number: when it was first noted (ms, and the time as said), and when a report first said it was gone (∞: never). */
  interface Noted { noted: number; notedAt: string; gone: number }
  interface PerPrefix {
    readonly storeId: string; readonly prefix: string; readonly numbers: Map<number, Noted>;
    latest: { r: BoxHealthRecord; x: IssuedReport };
    wholeQueueSince: string | undefined; wholeQueueSinceMs: number;
    /** The previous report's words for this prefix, and the time its numbers were noted at (the repeat skip). */
    said: string | undefined; saidNoted: number;
    /**
     * r23 NEW-2: a run of counts every one of which is noted (no later than `noted`) and already said gone — nothing a later
     * report noted no earlier can teach about them, so they are skipped without a look.
     */
    settled: { lo: number; hi: number; noted: number } | undefined;
    /** r23 NEW-2: a run of counts every one of which is noted no later than `noted` (said gone or not). */
    noted: { lo: number; hi: number; noted: number } | undefined;
  }
  const by = new Map<string, PerPrefix>();
  const ordered = input.records.map((r) => ({ r, ms: Date.parse(r.receivedAt) })).filter((o) => o.ms <= atMs).sort((a, b) => a.ms - b.ms);
  for (const { r: raw, ms } of ordered) {
    const r = believedRecord(raw);
    for (const x of r.receiptNumbersIssued ?? []) {
      const key = `${r.storeId}\u0000${x.prefix}`;
      let cur = by.get(key);
      if (cur === undefined) {
        cur = { storeId: r.storeId, prefix: x.prefix, numbers: new Map(), latest: { r, x }, wholeQueueSince: undefined, wholeQueueSinceMs: NaN, said: undefined, saidNoted: Infinity, settled: undefined, noted: undefined };
        by.set(key, cur);
      }
      cur.latest = { r, x };
      // r22 D3: head office's own first sight of the unbroken run of reports that say no list but hold something.
      const wholeQueue = x.unsent === undefined && r.queue.unsent > 0;
      if (!wholeQueue) cur.wholeQueueSince = undefined;
      else if (cur.wholeQueueSince === undefined) { cur.wholeQueueSince = r.receivedAt; cur.wholeQueueSinceMs = ms; }
      const lineAt = cur.wholeQueueSince === undefined ? undefined : cur.wholeQueueSinceMs + lineMs;
      // Not on the box by its list: noted from this report — or, while its whole queue stands in, from the owner's line.
      const notedMs = lineAt === undefined || ms >= lineAt ? ms : lineAt;
      // r23 NEW-2: the same words as the previous report for this prefix, noted no earlier — nothing can change.
      const words = saidWords(r, x);
      if (words === cur.said && notedMs >= cur.saidNoted) continue;
      cur.said = words;
      cur.saidNoted = notedMs;
      const notedAt = notedMs === ms ? r.receivedAt : new Date(notedMs).toISOString();
      const banked = input.banked.get(x.prefix) ?? 0;
      const sold = x.soldThrough ?? x.through;
      const numbers = cur.numbers;
      // r23 NEW-2: this report's words, worked out once — `stillOnTheBox(r, x, n, false)` and `saysItMayHold(r, x, n)` per
      // number are then two or three comparisons (no closure, no slack sum per number).
      const u = x.unsent;
      const d = x.deadLettered;
      const uLo = names(u) ? u.from : Infinity;
      const uHi = names(u) ? u.to : -Infinity;
      const dLo = names(d) ? d.from : Infinity;
      const dHi = names(d) ? d.to : -Infinity;
      const uWhole = believedWhole(u, slack);
      const dWhole = believedWhole(d, slack);
      const queueMayHold = (u === undefined && r.queue.unsent > 0) || (d === undefined && r.queue.deadLettered > 0);
      /** Notes `n`: 2 when it is now noted (no later than `notedMs`) and said gone; 1 noted, not gone; 0 neither. */
      const note = (n: number): 0 | 1 | 2 => {
        let e = numbers.get(n);
        if (e !== undefined && e.noted <= notedMs && e.gone !== Infinity) return 2; // r23 NEW-2: nothing left to learn
        const inU = n >= uLo && n <= uHi;
        const inD = n >= dLo && n <= dHi;
        if (e === undefined || notedMs < e.noted) {
          if ((dWhole && inD) || (uWhole && inU)) return 0; // stillOnTheBox(r, x, n, false, slack)
          if (e === undefined) { e = { noted: notedMs, notedAt, gone: Infinity }; numbers.set(n, e); } else { e.noted = notedMs; e.notedAt = notedAt; }
        }
        // r23 NEW-1: the first report that said, by its own word, that the box did not hold it (saysItMayHold: undefined).
        if (e.gone === Infinity && !inU && !inD && !queueMayHold) e.gone = ms;
        return e.gone !== Infinity ? 2 : 1;
      };
      /** [lo, hi] spans of this report, as pairs (only the ones it names). */
      const spans: [number, number][] = [];
      if (uLo <= uHi) spans.push([uLo, uHi]);
      if (dLo <= dHi) spans.push([dLo, dHi]);
      const wholes: [number, number][] = [];
      if (uWhole) wholes.push([uLo, uHi]);
      if (dWhole) wholes.push([dLo, dHi]);
      /**
       * Notes every count in [a, b]. r23 NEW-2: whole runs are passed over without a look when nothing in them can change —
       *   • the SETTLED run (every number noted no later than this report and already said gone);
       *   • a span this report holds WHOLE (it says it holds every number there: none is noted, none said gone);
       *   • the NOTED run (every number noted no later than this report) where this report may hold them (its spans, or
       *     everything while its whole queue stands in): nothing to note, and nothing it can say gone.
       * The longest settled and noted runs seen here (joined to the old ones when they touch) are kept for the next report.
       */
      const noteRun = (a: number, b: number): void => {
        if (a > b) return;
        const oldS = cur.settled;
        const oldN = cur.noted;
        const settledSkip = oldS !== undefined && notedMs >= oldS.noted ? oldS : undefined;
        const notedSkip = oldN !== undefined && notedMs >= oldN.noted ? oldN : undefined;
        const cuts = new Set<number>([a, b + 1]);
        for (const [lo, hi] of [...spans, ...(settledSkip === undefined ? [] : [[settledSkip.lo, settledSkip.hi] as [number, number]]), ...(notedSkip === undefined ? [] : [[notedSkip.lo, notedSkip.hi] as [number, number]])]) {
          if (lo > a && lo <= b) cuts.add(lo);
          if (hi + 1 > a && hi + 1 <= b) cuts.add(hi + 1);
        }
        const points = [...cuts].sort((p, q) => p - q);
        const runs = { s: NaN, n: NaN, bestS: undefined as { lo: number; hi: number } | undefined, bestN: undefined as { lo: number; hi: number } | undefined };
        const closeS = (hi: number): void => {
          if (Number.isNaN(runs.s)) return;
          if (runs.bestS === undefined || hi - runs.s > runs.bestS.hi - runs.bestS.lo) runs.bestS = { lo: runs.s, hi };
          runs.s = NaN;
        };
        const closeN = (hi: number): void => {
          if (Number.isNaN(runs.n)) return;
          if (runs.bestN === undefined || hi - runs.n > runs.bestN.hi - runs.bestN.lo) runs.bestN = { lo: runs.n, hi };
          runs.n = NaN;
        };
        const within = (iv: { lo: number; hi: number } | readonly [number, number] | undefined, p: number): boolean =>
          iv !== undefined && ('lo' in iv ? p >= iv.lo && p <= iv.hi : p >= iv[0] && p <= iv[1]);
        for (let i = 0; i + 1 < points.length; i += 1) {
          const p = points[i]!;
          const q = points[i + 1]! - 1;
          if (within(settledSkip, p)) {
            if (Number.isNaN(runs.s)) runs.s = p;
            if (Number.isNaN(runs.n)) runs.n = p;
            continue;
          }
          if (wholes.some((w) => within(w, p))) { closeS(p - 1); closeN(p - 1); continue; }
          if (within(notedSkip, p) && (queueMayHold || spans.some((w) => within(w, p)))) {
            closeS(p - 1);
            if (Number.isNaN(runs.n)) runs.n = p;
            continue;
          }
          for (let n = p; n <= q; n += 1) {
            const k = note(n);
            if (k === 2) { if (Number.isNaN(runs.s)) runs.s = n; } else closeS(n - 1);
            if (k >= 1) { if (Number.isNaN(runs.n)) runs.n = n; } else closeN(n - 1);
          }
        }
        closeS(b);
        closeN(b);
        const keep = (old: { lo: number; hi: number; noted: number } | undefined, best: { lo: number; hi: number } | undefined): { lo: number; hi: number; noted: number } | undefined => {
          if (best === undefined) return old;
          if (old !== undefined && old.lo <= best.hi + 1 && old.hi >= best.lo - 1) return { lo: Math.min(old.lo, best.lo), hi: Math.max(old.hi, best.hi), noted: Math.max(old.noted, notedMs) };
          return old === undefined || best.hi - best.lo >= old.hi - old.lo ? { lo: best.lo, hi: best.hi, noted: notedMs } : old;
        };
        cur.settled = keep(oldS, runs.bestS);
        cur.noted = keep(oldN, runs.bestN);
      };
      noteRun(Math.max(banked + 1, sold - UNRECEIVED_CHECK_CAP + 1), sold);
      for (const [from, to] of x.atRisk ?? []) noteRun(Math.max(from, to - UNRECEIVED_CHECK_CAP + 1), to);
    }
  }
  const out: UnreceivedCandidate[] = [];
  for (const v of by.values()) {
    const { r, x } = v.latest;
    const standsIn = v.wholeQueueSince !== undefined && atMs < v.wholeQueueSinceMs + lineMs;
    const all: number[] = [];
    const reclaimed = new Map<number, 'list' | 'queue'>();
    for (const [n, e] of v.numbers) {
      if (e.noted > cutoff) continue;
      const claim = e.gone <= cutoff ? saysItMayHold(r, x, n) : undefined;
      // r23 NEW-1: said gone at least the grace ago — the latest claim to hold it again holds nothing back.
      if (claim !== undefined) reclaimed.set(n, claim);
      else if (stillOnTheBox(r, x, n, standsIn, slack)) continue;
      all.push(n);
    }
    if (all.length === 0) continue;
    all.sort((a, b) => a - b);
    const numbers = all.slice(-UNRECEIVED_CHECK_CAP);
    const since = numbers.map((n) => v.numbers.get(n)!.notedAt).sort()[0]!;
    const back = numbers.filter((n) => reclaimed.has(n));
    const sparse = sparseHolding(x, slack);
    out.push({
      storeId: v.storeId, prefix: v.prefix, numbers, since, capped: all.length > numbers.length,
      ...(sparse === undefined ? {} : { sparse }),
      ...(v.wholeQueueSince === undefined ? {} : { wholeQueue: { items: r.queue.unsent, since: v.wholeQueueSince } }),
      ...(back.length === 0 ? {} : {
        reclaimed: {
          numbers: back, saidGoneAt: new Date(Math.min(...back.map((n) => v.numbers.get(n)!.gone))).toISOString(),
          byList: back.some((n) => reclaimed.get(n) === 'list'),
        },
      }),
    });
  }
  return out;
}

/**
 * Verifier r22 D5 — THE SPARSE-RANGE RULE, applied after the ledger check: the numbers head office has NOT received inside
 * the latest report's sparse spans are all accounted for by the box's word when there are no more of them than the bills it
 * says it holds there plus the owner's slack (count + max(N, P%), OB-90; 5 / 5% by default) — none is named; when there are more, all of them are named
 * (which ones are on the box cannot be told). Returns the numbers still to name, and whether the sparse claim was outnumbered.
 */
export function weighSparseClaim(missing: readonly number[], sparse: UnreceivedCandidate['sparse'], slack: ClaimSlack = DEFAULT_CLAIM_SLACK): { numbers: number[]; outnumbered: boolean } {
  if (sparse === undefined) return { numbers: [...missing], outnumbered: false };
  const inSpan = (n: number): boolean => sparse.spans.some(([a, z]) => n >= a && n <= z);
  const within = missing.filter(inSpan);
  if (within.length === 0) return { numbers: [...missing], outnumbered: false };
  if (within.length <= sparse.count + sparseSlack(sparse.count, slack)) return { numbers: missing.filter((n) => !inSpan(n)), outnumbered: false };
  return { numbers: [...missing], outnumbered: true };
}

/** [from, to] ranges of sorted counts. */
export function countRanges(numbers: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const n of [...new Set(numbers)].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last !== undefined && n === last[1] + 1) last[1] = n; else out.push([n, n]);
  }
  return out;
}

const pad6 = (n: number): string => String(n).padStart(6, '0');
const rangeWords = (prefix: string, ranges: readonly (readonly [number, number])[]): string =>
  ranges.map(([a, z]) => (a === z ? `${prefix}${pad6(a)}` : `${prefix}${pad6(a)} to ${prefix}${pad6(z)}`)).join(', ');

/** Verifier r22 D3/D5: never-received numbers for one prefix, after the ledger check, with what the box still claims. */
export interface UnreceivedNumbers {
  readonly prefix: string;
  readonly numbers: readonly number[];
  readonly since: string;
  readonly capped: boolean;
  /** r22 D5: the latest report's sparse claim was OUTNUMBERED by the numbers head office has not received in its spans. */
  readonly sparse?: { readonly count: number; readonly spans: readonly (readonly [number, number])[] };
  /** r22 D3: the latest report gives no per-prefix list, and its whole queue has held something since `since` (past the line). */
  readonly wholeQueue?: { readonly items: number; readonly since: string };
  /** r23 NEW-1 · OB-89: among `numbers`, the ones an earlier report said were gone and the latest claims again (see `UnreceivedCandidate`). */
  readonly reclaimed?: { readonly numbers: readonly number[]; readonly saidGoneAt: string; readonly byList: boolean };
}

/** Verifier r19: the owner's words for a store's bill-number findings (refused reports, never-received bills). */
export function billNumberFindingsFor(input: {
  readonly storeId: string;
  readonly records: readonly BoxHealthRecord[];
  readonly at: string;
  /** The never-received numbers, after the ledger check (from `unreceivedCandidates`). */
  readonly unreceived: readonly UnreceivedNumbers[];
  /**
   * Verifier r20 BOX-2: what head office holds banked per prefix (sales and refunds). With it, a refused report stops being
   * a finding once head office's own banked count has caught up to the refused claim.
   */
  readonly banked?: ReadonlyMap<string, number>;
  /** Verifier r21 BOX-2 / r22 D2: refusals acknowledged by a person with all-stores authority (`POST …/bill-number-refusals/acknowledgements`). */
  readonly acknowledged?: readonly RefusalAcknowledgement[];
}): BillNumberFinding[] {
  const out: BillNumberFinding[] = [];
  const mine = input.records.filter((r) => r.storeId === input.storeId && Date.parse(r.receivedAt) <= Date.parse(input.at))
    .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  const latestRecord = mine[mine.length - 1];
  const latestOf = (prefix: string): IssuedReport | undefined => {
    let found: IssuedReport | undefined;
    for (const r of mine) found = r.receiptNumbersIssued?.find((x) => x.prefix === prefix) ?? found;
    return found;
  };
  for (const u of input.unreceived) {
    if (u.numbers.length === 0) continue;
    const ranges = countRanges(u.numbers);
    const them = u.numbers.length === 1 ? 'it' : 'them';
    // Verifier r21 DEAD-LETTER-AS-LOST: an OLDER box that does not list the bills it gave up on, but says it holds some — they
    // may be these. Never "enter the paper bills" while that is possible: a person checks the store computer first.
    const maybeGivenUp = latestRecord !== undefined && latestRecord.queue.deadLettered > 0 && latestOf(u.prefix)?.deadLettered === undefined;
    // Verifier r22 D3/D5: the box's word was not taken (no list past the owner's line, or a sparse list outnumbered) —
    // these numbers MAY still be on it, so the advice is to check it, never to enter paper bills.
    const notTaken = u.reclaimed === undefined && (u.sparse !== undefined || u.wholeQueue !== undefined);
    // Verifier r23 NEW-1 · OB-89: some of them the box said it no longer held, and now claims again — never "enter the paper
    // bills" while the box claims them: a person checks the store computer first.
    const back = u.reclaimed === undefined || u.reclaimed.numbers.length === 0 ? undefined : { ...u.reclaimed, ranges: countRanges(u.reclaimed.numbers) };
    out.push({
      kind: 'issued_never_received', prefix: u.prefix, ranges, since: u.since,
      detail: `bills issued but never received: store ${input.storeId}'s computer gave ${rangeWords(u.prefix, ranges)} (on a bill, or after the backup it was restored from) and head office has not received ${them} ${UNRECEIVED_GRACE_MINUTES} minutes or more after ${notTaken ? `it stopped taking the store computer's word that it still held ${them}` : `the store computer said it no longer held ${them} to send`} (${u.since})${u.capped ? `; only the newest ${UNRECEIVED_CHECK_CAP} were checked` : ''}. `
        + (back !== undefined
          ? `The store computer said at ${back.saidGoneAt} that it no longer held ${rangeWords(u.prefix, back.ranges)}, and its latest report says ${back.byList ? 'they are in its list of bills still to send or given up on' : 'its queue holds item(s) still to send, without saying which'} again. A store computer keeps a bill until head office takes it and never takes back one it has let go, so head office no longer waits on that word. Do NOT re-enter any of them from paper until a person has checked the store computer's "waiting to send" and "gave up sending" lists`
          : u.sparse !== undefined
          ? `The store computer says it still holds ${u.sparse.count} bill(s) somewhere between ${rangeWords(u.prefix, u.sparse.spans)} (to send, or given up on) — fewer than the ${u.numbers.length} head office has not received there, so at least ${u.numbers.length - u.sparse.count} of them are not on it, and which ones cannot be told. Do NOT re-enter any of them from paper until a person has checked the store computer's "waiting to send" and "gave up sending" lists`
          : u.wholeQueue !== undefined
          ? `The store computer still says its queue holds ${u.wholeQueue.items} item(s) to send, as it has since ${u.wholeQueue.since}, but not which bills — past the owner's line head office no longer waits on that. These may be among them: do NOT re-enter them from paper until a person has checked the store computer's "waiting to send" count`
          : maybeGivenUp
          ? `The store computer also says it holds ${latestRecord.queue.deadLettered} item(s) it gave up sending, and does not say which bills they are — these may be among them: do NOT re-enter them from paper until a person has checked the store computer's "gave up sending" list`
          : 'If the store computer was restored from a backup, these sales are lost from head office\'s books: find the paper bills and enter them, or write them off with the reason'),
    });
    if (back !== undefined && back.byList) {
      out.push({
        kind: 'report_contradicts_earlier_report', prefix: u.prefix, ranges: back.ranges, since: back.saidGoneAt,
        detail: `store ${input.storeId}'s computer contradicts its own earlier report: at ${back.saidGoneAt} it said it no longer held ${rangeWords(u.prefix, back.ranges)} (head office has not received ${back.numbers.length === 1 ? 'it' : 'them'}), and its latest report${latestRecord === undefined ? '' : ` (${latestRecord.receivedAt})`} lists ${back.numbers.length === 1 ? 'it' : 'them'} as still on it. A store computer keeps a bill until head office takes it and never takes back one it has let go, so head office does not believe the later list for ${back.numbers.length === 1 ? 'it' : 'them'}: ${back.numbers.length === 1 ? 'it is' : 'they are'} named as never received. Check that store computer (its software may be faulty or altered) and call support. Do NOT re-enter any of them from paper until a person has checked the store computer's "waiting to send" and "gave up sending" lists`,
      });
    }
  }
  // Verifier r21 DEAD-LETTER-AS-LOST: bills the store computer GAVE UP sending — on the box, waiting for a person. Never
  // "never received", never "enter the paper bills": once a person resolves the dead letter, the box sends them.
  const lastByPrefix = new Map<string, { x: IssuedReport; r: BoxHealthRecord }>();
  for (const r of mine.map(believedRecord)) for (const x of r.receiptNumbersIssued ?? []) lastByPrefix.set(x.prefix, { x, r });
  for (const [prefix, { x, r }] of [...lastByPrefix].sort((a, b) => a[0].localeCompare(b[0]))) {
    const d = x.deadLettered;
    if (d === undefined || d.count === 0 || d.from === undefined || d.to === undefined) continue;
    out.push({
      kind: 'bills_dead_lettered_on_box', prefix, ranges: [[d.from, d.to]], count: d.count, since: d.oldestAt ?? r.receivedAt,
      detail: `needs a person (the store computer gave up sending; do NOT re-enter from paper): store ${input.storeId}'s computer holds ${d.count} bill(s) under ${prefix} (between ${rangeWords(prefix, [[d.from, d.to]])}) that it stopped trying to send to head office. They are on the store computer, not lost. Support checks why head office did not take them and releases them from the store computer's "gave up sending" list; entering them from paper as well would book them twice`,
    });
  }
  // Verifier r21 UNSENT-CEILING (a): the latest report's per-prefix lists do not fit its own queue — said, and not believed.
  const contradiction = latestRecord === undefined || latestRecord.receiptNumbersIssued === undefined ? undefined
    : latestRecord.queueContradiction ?? queueContradiction(latestRecord.queue, latestRecord.receiptNumbersIssued);
  if (latestRecord !== undefined && contradiction !== undefined) {
    out.push({
      kind: 'report_contradicts_its_queue', prefix: '', since: latestRecord.receivedAt,
      detail: `store ${input.storeId}'s computer's report contradicts itself — ${contradiction}. Head office does not believe its list of bills still to send: any bill it has not received is named as never received after ${UNRECEIVED_GRACE_MINUTES} minutes. Check that store computer (its software may be faulty or altered)`,
    });
  }
  out.push(...refusedReportFindings(input.storeId, mine, input.banked, input.acknowledged ?? []));
  return out;
}

/**
 * Verifier r21 BOX-2 / r22 D2 · OB-88 — THE RULE (stated, so a person can check it by hand). Every refused report is its own
 * claim (store, prefix, count). It stops being a finding ONLY when:
 *   (1) head office's own banked count under the prefix (sales and refunds, never a box's word) has caught up to its count —
 *       the claim turned out true; or
 *   (2) a person with ALL-STORES authority (the owner or head office business staff — never one store's manager, never the IT/platform administrator, OB-91) acknowledged THAT
 *       count for that store and prefix, and the acknowledgement still stands for this report:
 *         • the report came no later than the acknowledgement (the person saw it), or
 *         • the box was reporting that same count when it was acknowledged, and every report naming the prefix since then,
 *           up to this one, said that same count — the box repeating itself on every sync pass never brings it back.
 *       Once the box reports a DIFFERENT count for the prefix, the acknowledgement ends: any later refused report — a new
 *       count, or the acknowledged one again — needs a new acknowledgement. Each acknowledgement is kept on its own.
 * A later report from the box — lower, plausible, anything — never clears a refusal, and every unresolved claim stays in
 * view: per prefix the HIGHEST unresolved count is the finding, naming the others (a lower refused report never hides a
 * higher earlier one, r22 D2 c).
 */
function refusedReportFindings(
  storeId: string, mine: readonly BoxHealthRecord[], banked: ReadonlyMap<string, number> | undefined, acknowledged: readonly RefusalAcknowledgement[],
): BillNumberFinding[] {
  interface Said { readonly at: string; readonly through: number; readonly refused?: RefusedIssued; readonly by: string }
  const timeline = new Map<string, Said[]>();
  for (const rec of mine) {
    const said = new Map<string, Said>();
    for (const x of rec.receiptNumbersIssued ?? []) said.set(x.prefix, { at: rec.receivedAt, through: x.through, by: rec.reportedBy });
    for (const x of rec.receiptNumbersNotFolded ?? []) said.set(x.prefix, { at: rec.receivedAt, through: x.through, by: rec.reportedBy });
    for (const r of rec.receiptNumbersRefused ?? []) said.set(r.prefix, { at: rec.receivedAt, through: r.through, refused: r, by: rec.reportedBy });
    for (const [prefix, x] of said) timeline.set(prefix, [...(timeline.get(prefix) ?? []), x]);
  }
  const out: BillNumberFinding[] = [];
  for (const [prefix, said] of [...timeline].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!said.some((x) => x.refused !== undefined)) continue;
    // Only an acknowledgement given with all-stores authority counts (one kept before r22 D2 carries none, and is not honoured).
    const acks = acknowledged.filter((a) => a.storeId === storeId && a.prefix === prefix && a.authority === 'all_stores')
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const seenUpTo = new Map<number, number>(); // count → the latest acknowledgement time (covers every report of it until then)
    for (const a of acks) seenUpTo.set(a.through, Math.max(seenUpTo.get(a.through) ?? 0, Date.parse(a.at)));
    // One pass in time order: an acknowledgement given while the box was reporting its count STANDS until a different count.
    let standing: number | undefined;
    let last: Said | undefined;
    let k = 0;
    const open = new Map<number, { first: string; latest: Said }>();
    for (const x of said) {
      for (; k < acks.length && Date.parse(acks[k]!.at) < Date.parse(x.at); k += 1) if (last?.through === acks[k]!.through) standing = acks[k]!.through;
      if (standing !== undefined && x.through !== standing) standing = undefined;
      last = x;
      const r = x.refused;
      if (r === undefined) continue;
      const resolved = (banked !== undefined && (banked.get(prefix) ?? 0) >= r.through)
        || Date.parse(x.at) <= (seenUpTo.get(r.through) ?? -Infinity) || standing === r.through;
      if (resolved) continue;
      const cur = open.get(r.through);
      open.set(r.through, { first: cur?.first ?? x.at, latest: x });
    }
    if (open.size === 0) continue;
    const counts = [...open.keys()].sort((a, b) => b - a);
    const top = open.get(counts[0]!)!;
    const r = top.latest.refused!;
    const others = counts.slice(1);
    out.push({
      kind: 'report_refused', prefix, through: r.through, since: top.first,
      detail: (r.because === 'prefix_of_another_store'
        ? `store ${storeId}'s computer (${top.latest.by}) reported giving bill numbers under ${prefix} through ${r.through}, but head office issued ${prefix} to a till of ANOTHER store — not counted, so no till is affected; check that store computer`
        : `store ${storeId}'s computer (${top.latest.by}) reported giving bill numbers under ${prefix} through ${r.through}, far beyond the ${r.bankedThrough} head office holds banked (at most ${r.plausibleThrough ?? r.bankedThrough + PLAUSIBLE_ISSUED_AHEAD} is believed, ${PLAUSIBLE_ISSUED_AHEAD} ahead) — not counted, so the till keeps selling; check that store computer's bill numbers`)
        + (others.length === 0 ? '' : `. It also reported ${others.length === 1 ? 'another count' : 'other counts'} head office refused under ${prefix}, still to be looked at: ${others.slice(0, 5).join(', ')}${others.length > 5 ? ` and ${others.length - 5} more` : ''}`)
        + `. ${REFUSAL_STAYS_WORDS}`,
    });
  }
  return out;
}

/** Verifier r22 D2 · OB-88: what the owner reads about how a refused report stops being a warning (the health page's words). */
export const REFUSAL_STAYS_WORDS = 'This stays until head office has banked that many, or the owner or head office staff (all-stores authority — a store\'s own manager cannot, and neither can the IT/platform administrator) acknowledge this count with a reason. The acknowledgement holds while the store computer keeps reporting this same count; a different count needs a new acknowledgement';

/** Verifier r21 BOX-2 / r22 D2: a person's acknowledgement of a refused report (kept append-only; each one: who, when, why). */
export interface RefusalAcknowledgement {
  readonly storeId: string;
  readonly prefix: string;
  /** The refused count acknowledged — exactly (a different count, higher or lower, is a new finding). */
  readonly through: number;
  readonly reason: string;
  readonly by: string;
  readonly at: string;
  /** r22 D2 · OB-88: the authority it was given with — only an all-stores acknowledgement (owner / head office) is honoured. */
  readonly authority?: 'all_stores';
}

/** The latest report per store (by the box's own time, then by arrival). */
export function latestBoxReports(records: readonly BoxHealthRecord[]): ReadonlyMap<string, BoxHealthRecord> {
  const out = new Map<string, BoxHealthRecord>();
  for (const r of records) {
    const cur = out.get(r.storeId);
    if (cur === undefined || Date.parse(r.observedAt) > Date.parse(cur.observedAt)
      || (r.observedAt === cur.observedAt && Date.parse(r.receivedAt) >= Date.parse(cur.receivedAt))) out.set(r.storeId, r);
  }
  return out;
}

/**
 * OB-78 "A" (owner, 12 Oct 2026, in writing, "Warn at hours of trading left") · M35-FR-03 · M35-FR-04 · P-08 — how many
 * TRADING hours a store computer's disk has left before it would refuse a sale, estimated from its own reports.
 *
 * THE METHOD (stated, so a person can check it by hand):
 *   1. Take this store's reports from the last 7 days up to the latest one, oldest first. If the sales log ever got
 *      SMALLER between two reports (a new log, a clean-up), only the reports after that are used — older growth says
 *      nothing about the log the box writes now.
 *   2. Between each pair of consecutive reports, if the sales log GREW and the two reports are at most
 *      DISK_ESTIMATE_MAX_GAP_MINUTES (60) apart, that gap counts as trading time: its growth and its minutes are added up.
 *      The box reports on every sync pass (well under a minute apart while it runs), so a gap longer than an hour means
 *      it was off or cut off — the shop shut overnight, a power cut — and how much of that gap was trading cannot be
 *      told. Round 14 (verifier G8): such a gap is left out WHOLE (its growth and its minutes), never counted as trading
 *      time just because the log grew at all — counting a 12-hour night that ends with the first quarter-hour of sales
 *      as 12 hours of trading made the rate look ~4x slower and the hours left look far longer than they were. A gap in
 *      which the log did not grow (a quiet hour) is left out too, so the rate is never diluted — the estimate is in
 *      hours of TRADING, never clock hours, and errs towards warning early, never late.
 *   3. The growth rate is (bytes added) / (trading hours counted).
 *   4. The room left is the smaller of: the sales-log room above the box's reserve (capacity - log - reserve), and the
 *      disk's free space above that reserve (free - reserve) — the box's own refusal rule (`boxCanRecordSales`).
 *   5. Hours of trading left = room left / growth rate, rounded DOWN to one decimal place (never rounded up into comfort).
 *
 * TOO LITTLE HISTORY gives "not yet known", never a guess: fewer than 2 growing gaps, or less than 60 minutes of trading
 * counted, gives `known: false` with the reason; so does a log that has not grown at all in the window. Round 14: the
 * disk component then reads `unknown` with that reason (P-08) — never a plain "ok" — without raising the warning.
 */
export const DISK_ESTIMATE_MAX_GAP_MINUTES = 60;
export const DISK_ESTIMATE_LOOKBACK_HOURS = 7 * 24;
export const DISK_ESTIMATE_MIN_GROWING_GAPS = 2;
export const DISK_ESTIMATE_MIN_TRADING_MINUTES = 60;

export type TradingHoursEstimate =
  | { readonly known: true; readonly hoursLeft: number; readonly bytesPerTradingHour: number; readonly roomLeftBytes: number; readonly tradingMinutesCounted: number; readonly growingGaps: number; readonly from: string; readonly to: string }
  | { readonly known: false; readonly why: string; readonly tradingMinutesCounted: number; readonly growingGaps: number };

export function estimateTradingHoursLeft(storeRecords: readonly BoxHealthRecord[], latest: BoxHealthRecord): TradingHoursEstimate {
  const since = Date.parse(latest.observedAt) - DISK_ESTIMATE_LOOKBACK_HOURS * 3_600_000;
  const ordered = [...storeRecords]
    .filter((r) => r.storeId === latest.storeId && Date.parse(r.observedAt) >= since && Date.parse(r.observedAt) <= Date.parse(latest.observedAt))
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  // Only the run since the log last got smaller (step 1).
  let start = 0;
  for (let i = 1; i < ordered.length; i += 1) if (ordered[i]!.disk.salesLogUsedBytes < ordered[i - 1]!.disk.salesLogUsedBytes) start = i;
  const run = ordered.slice(start);
  let bytes = 0;
  let minutes = 0;
  let gaps = 0;
  for (let i = 1; i < run.length; i += 1) {
    const grew = run[i]!.disk.salesLogUsedBytes - run[i - 1]!.disk.salesLogUsedBytes;
    const gapMinutes = (Date.parse(run[i]!.observedAt) - Date.parse(run[i - 1]!.observedAt)) / 60_000;
    if (grew > 0 && gapMinutes > 0 && gapMinutes <= DISK_ESTIMATE_MAX_GAP_MINUTES) { bytes += grew; minutes += gapMinutes; gaps += 1; }
  }
  const tradingMinutesCounted = Math.floor(minutes);
  if (gaps < DISK_ESTIMATE_MIN_GROWING_GAPS || minutes < DISK_ESTIMATE_MIN_TRADING_MINUTES) {
    return {
      known: false, tradingMinutesCounted, growingGaps: gaps,
      why: `hours of trading left: not yet known — the store computer's reports show the sales log growing over ${gaps} gap(s) of at most ${DISK_ESTIMATE_MAX_GAP_MINUTES} minutes and ${tradingMinutesCounted} minute(s) of trading; at least ${DISK_ESTIMATE_MIN_GROWING_GAPS} gaps and ${DISK_ESTIMATE_MIN_TRADING_MINUTES} minutes are needed before it can be estimated (never guessed)`,
    };
  }
  const bytesPerTradingHour = bytes / (minutes / 60);
  const d = latest.disk;
  const roomLeftBytes = Math.max(0, Math.min(d.salesLogCapacityBytes - d.salesLogUsedBytes - d.reserveBytes, d.freeBytes - d.reserveBytes));
  // room / (bytes / hours), in whole numbers first so a round answer stays round (9, never 8.9 by a floating hair).
  const hoursLeft = Math.floor((roomLeftBytes * minutes * 10) / (bytes * 60)) / 10;
  return { known: true, hoursLeft, bytesPerTradingHour: Math.round(bytesPerTradingHour), roomLeftBytes, tradingMinutesCounted, growingGaps: gaps, from: run[0]!.observedAt, to: latest.observedAt };
}

/** The owner's default early-warning line (OB-78): warn when fewer than this many hours of trading are left. */
export const DEFAULT_BOX_DISK_WARN_HOURS = 48;

/** One store computer as head office's health read shows it. */
export interface BoxHealthView {
  readonly storeId: string;
  readonly state: 'reported' | 'never_reported';
  readonly lastReportAt: string | null;
  readonly ageSeconds: number | null;
  readonly stale: boolean;
  /** The box would still record a sale on its last report (null: never reported). */
  readonly canRecordSales: boolean | null;
  readonly disk: BoxDisk | null;
  readonly queue: { readonly unsent: number; readonly deadLettered: number } | null;
  readonly tills: readonly TillDeviceReport[];
  /** OB-78: hours of trading the disk has left by the stated method — null when not yet known (or never reported). */
  readonly tradingHoursLeft: number | null;
  /** OB-78: how that was worked out, or why it is not yet known, in words. */
  readonly tradingHoursLeftSays: string | null;
  /** Verifier r19 OB87-1: the box's latest witness check (null when never reported or an older box). */
  readonly billNumbering?: BillNumberingState | null;
  /** Verifier r19: bills issued but never received, and reports head office refused to count. */
  readonly billNumberFindings?: readonly BillNumberFinding[];
}

const mb = (bytes: number): string => `${Math.floor(bytes / 1_048_576)} MB`;
const ago = (s: number): string => (s < 3_600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3_600)}h ${Math.floor((s % 3_600) / 60)}m`);

/** The box's own rule (commitLocally): the next sale fits only when the log plus the reserve fits, and the disk has the reserve free. */
export const boxCanRecordSales = (d: BoxDisk): boolean =>
  d.salesLogUsedBytes + d.reserveBytes < d.salesLogCapacityBytes && d.freeBytes > d.reserveBytes;

/**
 * Judge every store computer's latest report against now. Stores head office knows that never reported are listed
 * (never_reported) with no component — their absence is named in `notObserved` by the caller, never read as healthy.
 */
export function judgeBoxes(input: {
  readonly records: readonly BoxHealthRecord[];
  readonly knownStores?: readonly string[];
  readonly at: string;
  readonly thresholds: HealthThresholds;
  /** OB-78: warn (`degraded`) when fewer than this many hours of trading are left — the owner's tenant setting (default 48). */
  readonly diskWarnHours?: number;
  /** Verifier r19: each store's bill-number findings (`billNumberFindingsFor`), judged by the caller with the ledger. */
  readonly billNumberFindings?: ReadonlyMap<string, readonly BillNumberFinding[]>;
  /** Verifier r21 UNSENT-CEILING: warn when bills have waited on a store computer this many hours (tenant setting, default 2). */
  readonly unsentWarnHours?: number;
}): { readonly boxes: readonly BoxHealthView[]; readonly components: readonly ComponentHealth[]; readonly localStoreWritable: boolean | undefined } {
  const warnHours = input.diskWarnHours ?? DEFAULT_BOX_DISK_WARN_HOURS;
  const latest = latestBoxReports(input.records);
  const ids = [...new Set([...(input.knownStores ?? []), ...latest.keys()])].sort();
  const boxes: BoxHealthView[] = [];
  const components: ComponentHealth[] = [];
  let anyFreshCannot = false;
  let allFreshCan = latest.size > 0;
  for (const storeId of ids) {
    const r = latest.get(storeId);
    if (r === undefined) {
      allFreshCan = false;
      boxes.push({ storeId, state: 'never_reported', lastReportAt: null, ageSeconds: null, stale: true, canRecordSales: null, disk: null, queue: null, tills: [], tradingHoursLeft: null, tradingHoursLeftSays: null });
      continue;
    }
    const ageSeconds = Math.max(0, Math.floor((Date.parse(input.at) - Date.parse(r.observedAt)) / 1000));
    const stale = ageSeconds >= input.thresholds.syncLagWarnSeconds;
    const can = boxCanRecordSales(r.disk);
    if (stale) allFreshCan = false; else if (!can) { anyFreshCannot = true; allFreshCan = false; }
    const estimate = estimateTradingHoursLeft(input.records, r);
    const estimateSays = estimate.known
      ? `about ${estimate.hoursLeft} hours of trading left before it would refuse a sale (the sales log grew ${mb(estimate.bytesPerTradingHour)} per trading hour over ${estimate.tradingMinutesCounted} minutes of trading in its reports since ${estimate.from}; ${mb(estimate.roomLeftBytes)} of room left above the reserve)`
      : estimate.why;
    const runningOut = can && estimate.known && estimate.hoursLeft < warnHours;
    const staleNote = `STALE — store ${storeId}'s computer last reported ${ago(ageSeconds)} ago (${r.observedAt}); it has not been heard from since, so this is old news, not the state now`;
    // Verifier r21 UNSENT-CEILING (b): bills held on the box past the owner's line are a finding of their own.
    const waiting = billsWaitingOnTheBox({ records: input.records, storeId, at: input.at, ...(input.unsentWarnHours === undefined ? {} : { warnHours: input.unsentWarnHours }) });
    const findings = [...(input.billNumberFindings?.get(storeId) ?? []), ...waiting];
    boxes.push({
      storeId, state: 'reported', lastReportAt: r.observedAt, ageSeconds, stale, canRecordSales: can, disk: r.disk, queue: r.queue, tills: r.tills,
      tradingHoursLeft: estimate.known ? estimate.hoursLeft : null, tradingHoursLeftSays: estimateSays,
      billNumbering: r.billNumbering ?? null, billNumberFindings: findings,
    });
    // Verifier r19 OB87-1 / BOX-1 / lost sales: the store computer's bill numbering, as the owner must see it (P-08, P-03).
    // `degraded` when the witness is unavailable (every start a possible restore, a new prefix each boot), when it shares a
    // witness folder, when bills were issued and never received, or when a report was refused; a held restore is said too.
    if (r.billNumbering !== undefined || findings.length > 0) {
      const bn = r.billNumbering;
      const parts: string[] = [];
      if (bn?.witness === 'unavailable') parts.push(`store ${storeId}'s computer CANNOT keep its bill-number witness (${bn.fault ?? 'the witness folder could not be opened'}), so it treats every restart as a possible restore and numbers under a brand-new prefix until head office answers — no bill number is ever repeated, but fix its witness folder (EDGE_WITNESS_DIR)`);
      if (bn !== undefined && bn.sharedWith.length > 0) parts.push(`store ${storeId}'s computer shares its witness folder with ${bn.sharedWith.length} other store computer(s) (${bn.sharedWith.map((x) => `${x.box}, last written ${x.lastWrittenAt}`).join('; ')}) — give each its own`);
      if (bn?.restoreHeld === true) parts.push(`store ${storeId}'s computer is numbering under a brand-new prefix since ${bn.restoreSince ?? '?'} because it may have been restored from a backup (${bn.restoreBecause ?? 'possible restore'}), until head office's setup reaches it`);
      for (const f of findings) parts.push(f.detail);
      const bad = bn?.witness === 'unavailable' || (bn?.sharedWith.length ?? 0) > 0 || findings.length > 0;
      const bnSays = parts.length > 0 ? parts.join('. ') : `store ${storeId}'s computer keeps its bill-number witness; nothing to look at`;
      components.push({
        name: `box_bill_numbers:${storeId}`,
        // A stale report never clears a finding: findings stand on head office's own ledger; the witness state is old news.
        status: bad ? 'degraded' : stale ? 'unknown' : bn?.restoreHeld === true ? 'degraded' : 'ok',
        detail: stale && findings.length === 0 ? `${staleNote}. Then: ${bnSays}` : bnSays,
        evidence: {
          witness: bn?.witness ?? 'not said', restoreHeld: String(bn?.restoreHeld ?? false), sharedWitnessFolder: bn?.sharedWith.length ?? 0,
          neverReceived: findings.filter((f) => f.kind === 'issued_never_received').map((f) => `${f.prefix}:${(f.ranges ?? []).map(([a, z]) => `${a}-${z}`).join('/')}`).join(','),
          reportsRefused: findings.filter((f) => f.kind === 'report_refused').map((f) => `${f.prefix}@${f.through ?? ''}`).join(','),
          reportedAt: r.observedAt, ageSeconds,
        },
      });
    }
    const headroom = Math.max(0, r.disk.salesLogCapacityBytes - r.disk.salesLogUsedBytes - r.disk.reserveBytes);
    const diskEvidence = {
      freeBytes: r.disk.freeBytes, totalBytes: r.disk.totalBytes, salesLogHeadroomBytes: headroom, reportedAt: r.observedAt, ageSeconds,
      tradingHoursLeft: estimate.known ? estimate.hoursLeft : 'not yet known', warnBelowTradingHours: warnHours,
    };
    const diskSays = runningOut
      ? `store ${storeId}'s computer will run out of room for sales soon — ${estimateSays}, below the owner's warning line of ${warnHours} hours. Make room on it (or give it a bigger disk) before the tills have to refuse sales`
      : can
      ? `store ${storeId}'s computer can record sales: ${mb(r.disk.freeBytes)} free of ${mb(r.disk.totalBytes)}, ${mb(headroom)} of sales-log room left above the reserve; ${estimateSays}`
      : `store ${storeId}'s computer CANNOT record another sale — its disk is full (${mb(r.disk.freeBytes)} free; sales log ${mb(r.disk.salesLogUsedBytes)} of ${mb(r.disk.salesLogCapacityBytes)} with a ${mb(r.disk.reserveBytes)} reserve). Its tills refuse sales until room is made`;
    components.push({
      // OB-78: a fresh report whose hours of trading left are under the owner's line is `degraded` (the early warning); a
      // stale report stays `unknown` (old news never raises or clears the warning); a full disk is `down` as before.
      // Round 14 (verifier G8 · P-08): a disk that can record sales but whose hours left are not yet known reads `unknown`
      // with the reason — not a plain "ok", and not the warning either.
      name: `box_disk:${storeId}`, status: stale ? 'unknown' : !can ? 'down' : runningOut ? 'degraded' : estimate.known ? 'ok' : 'unknown',
      detail: stale ? `${staleNote}. Then: ${diskSays}` : diskSays, evidence: diskEvidence,
    });

    const q = r.queue;
    // Verifier r21 UNSENT-CEILING: the box's per-prefix lists count too — a report whose lists say bills are waiting never
    // reads "has sent everything", and one that contradicts its own queue, or holds bills past the owner's line, is a warning.
    const issued = r.receiptNumbersIssued ?? [];
    const billsWaiting = issued.reduce((n, x) => n + (x.unsent?.count ?? 0), 0);
    const billsGivenUp = issued.reduce((n, x) => n + (x.deadLettered?.count ?? 0), 0);
    const contradiction = r.queueContradiction ?? (r.receiptNumbersIssued === undefined ? undefined : queueContradiction(q, r.receiptNumbersIssued));
    const qStatus: HealthStatus = q.deadLettered >= input.thresholds.deadLetterCritical && q.deadLettered > 0 ? 'down'
      : q.unsent >= input.thresholds.queueDepthCritical ? 'down'
        : q.unsent >= input.thresholds.queueDepthWarn || q.deadLettered > 0 || waiting.length > 0 || contradiction !== undefined ? 'degraded' : 'ok';
    const waitingSays = waiting.map((f) => f.detail).join('. ');
    const qSays = contradiction !== undefined
      ? `store ${storeId}'s computer's report contradicts itself — ${contradiction}; head office does not believe its list of bills still to send`
      : q.unsent === 0 && q.deadLettered === 0 && billsWaiting === 0 && billsGivenUp === 0 ? `store ${storeId}'s computer has sent everything`
        : `store ${storeId}'s computer holds ${q.unsent} item(s) still to send${billsWaiting > 0 ? ` (${billsWaiting} of them bills)` : ''}${q.deadLettered > 0 ? ` and ${q.deadLettered} item(s) it gave up sending, waiting for a person (do NOT re-enter those bills from paper)` : ''}${waitingSays === '' ? '' : `. ${waitingSays}`}`;
    components.push({
      name: `box_queue:${storeId}`, status: stale ? (waiting.length > 0 || contradiction !== undefined ? 'degraded' : 'unknown') : qStatus,
      detail: stale ? `${staleNote}. Then: ${qSays}` : qSays,
      evidence: { unsent: q.unsent, deadLettered: q.deadLettered, billsWaiting, billsGivenUp, waitingPastLine: waiting.length, contradicts: contradiction ?? '', reportedAt: r.observedAt, ageSeconds },
    });

    if (r.tills.length === 0) {
      components.push({ name: `till_devices:${storeId}`, status: 'unknown', detail: `no till at store ${storeId} has reported its scanner, printer, scale, drawer or card machine yet — not known, never "all fine"` });
    } else {
      // Round 13 (verifier B5, probe P3 · P-08): each till is judged by ITS OWN report time, not the box's. The box relays
      // each till's LAST report; a till that stopped reporting (switched off, cable out) keeps its last "ok" on the box, so
      // a till report older than the threshold is STALE — that lane is old news, never "ok".
      // Round 15: aged by the device ADAPTER's own observation time when the till sent one (a hung adapter reads stale even
      // while the till keeps re-sending its last answer), else by the till's report time.
      const lanes = r.tills.map((t) => {
        const judgedAt = t.adapterObservedAt ?? t.reportedAt;
        const laneAge = Math.max(0, Math.floor((Date.parse(input.at) - Date.parse(judgedAt)) / 1000));
        const tillAge = Math.max(0, Math.floor((Date.parse(input.at) - Date.parse(t.reportedAt)) / 1000));
        const bad = t.devices.filter((d) => d.state !== 'ok')
          .map((d) => `${t.laneId}: ${d.kind.replace('_', ' ')} ${d.state === 'failed' ? 'has failed' : 'is not working properly'}${d.detail === undefined ? '' : ` — ${d.detail}`}`);
        const stale = laneAge >= input.thresholds.syncLagWarnSeconds;
        // The till is fresh but its adapter's own observation is old: the adapter has stopped looking — say so.
        const adapterQuiet = stale && t.adapterObservedAt !== undefined && tillAge < input.thresholds.syncLagWarnSeconds;
        return { laneId: t.laneId, reportedAt: judgedAt, ageSeconds: laneAge, stale, bad, attended: t.attended, adapterQuiet };
      });
      const freshBad = lanes.filter((l) => !l.stale).flatMap((l) => l.bad);
      const staleLanes = lanes.filter((l) => l.stale);
      const oldest = r.tills.map((t) => t.adapterObservedAt ?? t.reportedAt).sort()[0]!;
      // P-08: say WHY a lane may be quiet, from the box's own sessions — never a reason to read it ok.
      const whyQuiet = (l: (typeof lanes)[number]): string => (l.adapterQuiet
        ? ' — the till is still re-sending, but its device adapter has not observed the devices since then: the adapter may have hung, check that till'
        : l.attended === false
        ? ' — nobody is signed in at that till, so it has stopped re-sending (expected when it is closed or unattended)'
        : l.attended === true ? ' — a cashier IS signed in there, so it should still be re-sending every few minutes: check that till' : '');
      const staleSays = staleLanes.length === 0 ? '' : `STALE — ${staleLanes.map((l) => `till ${l.laneId} last ${l.adapterQuiet ? 'had its devices observed by its device adapter' : 'reported its devices'} ${ago(l.ageSeconds)} ago (${l.reportedAt})${l.bad.length === 0 ? '' : `, then saying ${l.bad.join('; ')}`}${whyQuiet(l)}`).join('; ')}: not heard from since, so its devices are not known now`;
      const freshSays = freshBad.length > 0 ? `store ${storeId}: ${freshBad.join('; ')} — the till still sells; a person should fix it`
        : staleLanes.length === lanes.length ? '' : `every till device at store ${storeId} that reported recently said it was working`;
      const says = [freshSays, staleSays].filter((x) => x !== '').join('. ');
      // A fresh failure is known now (degraded); a stale lane with nothing failing fresh is unknown — never ok.
      const tillStatus: HealthStatus = freshBad.length > 0 ? 'degraded' : staleLanes.length > 0 ? 'unknown' : 'ok';
      components.push({
        name: `till_devices:${storeId}`, status: stale ? 'unknown' : tillStatus,
        detail: stale ? `${staleNote}. Then: ${says}` : says,
        evidence: {
          notWorking: freshBad.length, tills: r.tills.length, staleTills: staleLanes.length, oldestTillReportAt: oldest, ageSeconds,
          staleLanes: staleLanes.map((l) => `${l.laneId}@${l.reportedAt}`).join(','),
        },
      });
    }
  }
  return { boxes, components, localStoreWritable: anyFreshCannot ? false : allFreshCan ? true : undefined };
}

export interface BoxHealthDeps {
  readonly now: () => string;
  readonly storeComputerScopeOf?: StoreComputerScopeOf;
  /** Records the report; answers the record head office KEEPS (the first, when this is a re-send of the same report). */
  readonly record: (tenantId: string, r: BoxHealthRecord) => Promise<void | BoxHealthRecord>;
  /**
   * Verifier r19 BOX-1: what head office issued and banked, to judge the box's reported counts (`judgeReportedIssued`).
   * Absent: nothing reported is folded (fail closed — a count is never believed blindly).
   */
  readonly issuedAndBanked?: (tenantId: string) => Promise<{ readonly issuedPrefixes: ReadonlyMap<string, ReadonlySet<string>>; readonly banked: ReadonlyMap<string, number> }>;
  /** Verifier r21 BOX-2: every report kept (to find the refusal a person acknowledges) and the acknowledgements. */
  readonly records?: (tenantId: string) => Promise<readonly BoxHealthRecord[]>;
  /**
   * Keeps one acknowledgement. r22 D2: each is its own record — `requestKey` (the request's Idempotency-Key) tells a re-sent
   * request (answered with the first) from a person acknowledging again (kept separately, with its own who, why and when).
   */
  readonly acknowledge?: (tenantId: string, a: RefusalAcknowledgement, requestKey: string) => Promise<RefusalAcknowledgement>;
  /**
   * Verifier r23 NEW-3 · OB-91: each grant through which this person holds `platform.alert.manage` — its role, whether it
   * covers ALL stores, and whether that role is the platform/IT administration function (held apart from running the shop).
   * Absent: nothing can be acknowledged here (fail closed).
   */
  readonly alertAuthorityOf?: (tenantId: string, userId: string) => Promise<readonly AlertAuthorityGrant[]>;
}

/** Verifier r23 NEW-3 · OB-91: one grant through which a person may manage alerts (see `BoxHealthDeps.alertAuthorityOf`). */
export interface AlertAuthorityGrant {
  readonly roleId: string;
  readonly allStores: boolean;
  /** The platform/IT administration function (the platform administrator, or a role whose whole grant is `platform.*`). */
  readonly platformAdministration: boolean;
}

export const REFUSAL_ACKNOWLEDGEMENTS_PATH = '/v1/store-computers/bill-number-refusals/acknowledgements';

export function boxHealthRoutes(deps: BoxHealthDeps): readonly Route[] {
  return [{
    // The store computer says how its disk, its queue and its tills' devices are. Its own store only (stamped, OB-54).
    api: 'API-11', method: 'POST', path: BOX_HEALTH_PATH,
    permission: STORE_COMPUTER_REPORT, idempotent: true,
    handler: async (ctx) => {
      const b = isObj(ctx.body) ? ctx.body : {};
      // Head office stamped the box credential's store here; a person's request carries none and is refused below.
      const storeId = typeof b['storeId'] === 'string' ? b['storeId'] : '';
      await assertStoreComputerOf(deps.storeComputerScopeOf, ctx, storeId, 'how its disk, queue and till devices are');
      const receivedAt = deps.now();
      const read = readBoxHealthReport(ctx.body, receivedAt);
      if ('problems' in read) {
        throw apiError(400, {
          code: 'not_readable_as_box_health',
          whatHappened: `The store computer's health report could not be read: ${read.problems.join('; ')}.`,
          wasItSaved: 'not_saved',
          nextSafeAction: 'Send { observedAt, disk: { freeBytes, totalBytes, salesLogUsedBytes, salesLogCapacityBytes, reserveBytes }, queue: { unsent, deadLettered }, tills: [...] }. Nothing was recorded.',
        });
      }
      // Verifier r19 BOX-1: only counts under this store's own prefixes, and only a plausible advance, are folded; the rest
      // are kept on the record (refused → a finding for the owner), never folded — a report alone never locks a till.
      const judged = read.receiptNumbersIssued === undefined ? undefined
        : deps.issuedAndBanked === undefined
          ? { accepted: [] as IssuedReport[], refused: [] as RefusedIssued[], notFolded: read.receiptNumbersIssued.map((x) => ({ prefix: x.prefix, through: x.through })) }
          : judgeReportedIssued({ storeId, issued: read.receiptNumbersIssued, ...(await deps.issuedAndBanked(ctx.tenantId)) });
      // Verifier r21 UNSENT-CEILING (a): per-prefix lists that do not fit the box's own queue are kept as evidence and SAID —
      // never believed (`believedRecord`).
      const contradiction = read.receiptNumbersIssued === undefined ? undefined : queueContradiction(read.queue, read.receiptNumbersIssued);
      const r: BoxHealthRecord = {
        storeId, observedAt: read.observedAt, receivedAt, reportedBy: ctx.userId, disk: read.disk, queue: read.queue, tills: read.tills, clockAheadCorrected: read.clockAheadCorrected,
        ...(contradiction === undefined ? {} : { queueContradiction: contradiction }),
        ...(judged === undefined ? {} : { receiptNumbersIssued: judged.accepted }),
        ...(judged === undefined || judged.refused.length === 0 ? {} : { receiptNumbersRefused: judged.refused }),
        ...(judged === undefined || judged.notFolded.length === 0 ? {} : { receiptNumbersNotFolded: judged.notFolded }),
        ...(read.billNumbering === undefined ? {} : { billNumbering: read.billNumbering }),
      };
      // The reply is what head office KEPT (a re-send answers the first record, never an unsaved copy).
      const kept = (await deps.record(ctx.tenantId, r)) ?? r;
      return { status: 200, body: { recorded: kept, canRecordSales: boxCanRecordSales(kept.disk) } };
    },
  }, {
    // Verifier r21 BOX-2: a person acknowledges a refused report — the only way, besides head office banking that many, for
    // the warning to stop. Who, when and why are kept (append-only, and on the audit trail like every request).
    // Verifier r22 D2 · OB-88 (owner, 13 Oct 2026, "Owner/head office only"): only a person whose authority covers ALL
    // stores may acknowledge. A store-scoped manager — of this store or another — is refused by name (the refusal is on the
    // audit trail like every request): a suspicious bill count is a fraud signal, never cleared from inside one store.
    // Verifier r23 NEW-3 · OB-91 (owner, 13 Oct 2026, "A — Owner + HO business only"): and only through a BUSINESS role (the
    // owner, or head office staff given all stores). The platform/IT administrator — who looks after the store computers —
    // is refused by name whatever their scope (403 acknowledgement_refused_to_platform_administrator, on the audit trail).
    api: 'API-11', method: 'POST', path: REFUSAL_ACKNOWLEDGEMENTS_PATH,
    permission: 'platform.alert.manage', idempotent: true,
    handler: async (ctx) => {
      if (scopeOf(ctx) !== 'all') {
        throw apiError(403, {
          code: 'acknowledgement_needs_all_stores_authority',
          whatHappened: 'Only the owner or head office staff — a person whose authority covers ALL stores — may acknowledge a store computer\'s refused bill-number report. This account\'s authority covers only some stores, so nothing was acknowledged and the warning stays.',
          wasItSaved: 'not_saved',
          nextSafeAction: 'Ask the owner or head office to look at the store computer and acknowledge it, with the reason. Nothing was recorded.',
        });
      }
      // OB-91: the all-stores authority must come from a business role — never from the platform/IT administration function.
      const grants = deps.alertAuthorityOf === undefined ? [] : await deps.alertAuthorityOf(ctx.tenantId, ctx.userId);
      if (!grants.some((g) => g.allStores && !g.platformAdministration)) {
        const it = grants.some((g) => g.platformAdministration);
        throw apiError(403, it ? {
          code: 'acknowledgement_refused_to_platform_administrator',
          whatHappened: 'The platform (IT) administrator looks after the store computers, so may never clear a store computer\'s suspicious bill-number report (owner decision OB-91) — whatever stores the account covers. Nothing was acknowledged and the warning stays.',
          wasItSaved: 'not_saved',
          nextSafeAction: 'Ask the owner or head office business staff to look at the store computer and acknowledge it, with the reason. Nothing was recorded.',
        } : {
          code: 'acknowledgement_needs_all_stores_authority',
          whatHappened: 'Only the owner or head office staff — a person whose business authority covers ALL stores — may acknowledge a store computer\'s refused bill-number report. This account holds no such authority, so nothing was acknowledged and the warning stays.',
          wasItSaved: 'not_saved',
          nextSafeAction: 'Ask the owner or head office to look at the store computer and acknowledge it, with the reason. Nothing was recorded.',
        });
      }
      const b = isObj(ctx.body) ? ctx.body : {};
      const storeId = b['storeId'];
      const prefix = b['prefix'];
      const through = b['through'];
      const reason = typeof b['reason'] === 'string' ? b['reason'].trim() : '';
      if (!isWord(storeId, 60) || !isWord(prefix, 10) || !isCount(through) || through < 1 || reason.length < 5 || reason.length > 300) {
        throw apiError(400, {
          code: 'not_readable_as_acknowledgement',
          whatHappened: 'An acknowledgement needs the store, the bill-number prefix, the refused count (through) and a reason of 5 to 300 characters.',
          wasItSaved: 'not_saved',
          nextSafeAction: 'Send { storeId, prefix, through, reason } as shown on the health page. Nothing was recorded.',
        });
      }
      if (deps.records === undefined || deps.acknowledge === undefined) {
        throw apiError(503, { code: 'acknowledgements_not_kept_here', whatHappened: 'This head office keeps no store computer reports, so there is nothing to acknowledge.', wasItSaved: 'not_saved', nextSafeAction: 'Use the head office that keeps the store computers\' reports. Nothing was recorded.' });
      }
      const refusedAt = (await deps.records(ctx.tenantId)).filter((rec) => rec.storeId === storeId)
        .flatMap((rec) => (rec.receiptNumbersRefused ?? []).filter((x) => x.prefix === prefix && x.through === through).map(() => rec.receivedAt));
      if (refusedAt.length === 0) {
        throw apiError(404, {
          code: 'no_such_refused_report',
          whatHappened: `Head office holds no refused report from store ${storeId}'s computer under ${prefix} through ${through}.`,
          wasItSaved: 'not_saved',
          nextSafeAction: 'Copy the store, prefix and count exactly as the health page shows the refused report. Nothing was recorded.',
        });
      }
      // The pipeline guarantees a write carries its Idempotency-Key; without one (a handler called outside it) the moment stands in.
      const at = deps.now();
      const kept = await deps.acknowledge(ctx.tenantId, { storeId, prefix, through, reason, by: ctx.userId, at, authority: 'all_stores' }, ctx.idempotencyKey ?? `${ctx.userId}@${at}`);
      return { status: 201, body: { acknowledged: kept } };
    },
  }];
}
