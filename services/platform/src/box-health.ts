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

import { createHash } from 'node:crypto';
import type { Route } from '../../kernel/src/index';
import { apiError, concurrentChange, scopeOf } from '../../kernel/src/index';
import type { RequestContext } from '../../kernel/src/index';
import { ConcurrencyConflictError } from '../../../packages/persistence/src/event-store';
import { approvalNamedIn, actionDetails, type ApprovalPort } from '../../identity/src/approval-requests';
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
  /**
   * Round 25 · OB-94 "A" (verifier r24 NEW-2): counts this box GAVE under the prefix and never put on a bill — a sale that
   * could not be saved after its number was taken, a bill abandoned at the till — as [from, to] ranges, at most
   * UNUSED_RANGES_MAX ranges and UNRECEIVED_CHECK_CAP numbers (the newest), none above `soldThrough`. No bill carries them,
   * so head office never names them "never received" while the box says so. Absent on an older box (nothing changes).
   */
  readonly unused?: readonly (readonly [number, number])[];
}

/** Round 25 · OB-94: at most this many unused-number ranges per prefix in one report (the at-risk list's own bound). */
export const UNUSED_RANGES_MAX = 50;

/** Verifier r19 BOX-1: a reported count head office would not fold, and why. */
export interface RefusedIssued {
  readonly prefix: string;
  readonly through: number;
  /**
   * r19: `prefix_of_another_store`, `beyond_plausible_advance`. Round 25 · OB-94 "A" (verifier r24 P4):
   * `prefix_of_another_store_computer` — the prefix is bound to the store computer that reported it first (`boundTo`); a
   * second store computer's word about it is kept as evidence and never used.
   */
  readonly because: 'prefix_of_another_store' | 'beyond_plausible_advance' | 'prefix_of_another_store_computer';
  /** OB-94: the store computer (its sign-in) the prefix is bound to, for `prefix_of_another_store_computer`. */
  readonly boundTo?: string;
  /**
   * Round 27 · OB-101 "A" (verifier r26 NEW-2): WHY head office uses `boundTo` — it reported the prefix first
   * (`first_report`), or the owner approved moving the prefix to it (`replacement`, with the act) — and since when. The
   * refusal names both store computers in these words, neutrally.
   */
  readonly boundVia?: 'first_report' | 'replacement';
  readonly boundSince?: string;
  readonly boundReplacementId?: string;
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
   * Round 25 · OB-96: `at_risk_not_checked` (numbers a restored box cannot vouch for beyond the newest 500 checked per report).
   * OB-94: a second store computer reporting a bound prefix is a `report_refused` naming both store computers.
   * Round 27 · OB-100: `unused_number_received` — head office holds a sale or a return under a number the store computer
   * said, AFTER that bill was made, it gave and never used (its list of unused numbers does not fit head office's books).
   */
  readonly kind: 'issued_never_received' | 'report_refused' | 'bills_waiting_on_box' | 'bills_dead_lettered_on_box' | 'report_contradicts_its_queue'
    | 'report_contradicts_earlier_report' | 'at_risk_not_checked' | 'unused_number_received';
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
        // Round 25 · OB-94: numbers given and never put on a bill (optional; bounded: at most 50 ranges and 500 numbers, in
        // order, not overlapping, none above what the box put on a bill).
        const rawUnused = x['unused'];
        if (rawUnused !== undefined) {
          const top = (x['soldThrough'] as number | undefined) ?? through;
          let total = 0;
          let last = 0;
          const ok = Array.isArray(rawUnused) && rawUnused.length <= UNUSED_RANGES_MAX && rawUnused.every((r: unknown) => {
            if (!Array.isArray(r) || r.length !== 2 || !isCount(r[0]) || !isCount(r[1])) return false;
            const [a, z] = r as [number, number];
            if (a < 1 || a > z || z > top || a <= last) return false;
            last = z;
            total += z - a + 1;
            return true;
          }) && total <= UNRECEIVED_CHECK_CAP;
          if (!ok) {
            problems.push(`receiptNumbersIssued[${i}].unused must be at most ${UNUSED_RANGES_MAX} [from, to] ranges in rising order, not overlapping, of at most ${UNRECEIVED_CHECK_CAP} numbers in all, from 1 to its soldThrough`);
            return;
          }
        }
        receiptNumbersIssued.push({
          prefix: x['prefix'], through,
          ...(unsent === undefined ? {} : { unsent }),
          ...(deadLettered === undefined ? {} : { deadLettered }),
          ...(rawUnused === undefined ? {} : { unused: (rawUnused as [number, number][]).map(([a, z]) => [a, z] as const) }),
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
  r: Pick<BoxHealthRecord, 'queue'>, x: Pick<IssuedReport, 'unsent' | 'deadLettered' | 'unused'>, n: number,
  wholeQueueStandsIn: boolean = r.queue.unsent > 0, slack: ClaimSlack = DEFAULT_CLAIM_SLACK,
): boolean {
  // Round 25 · OB-94: a number the box says it gave and never put on a bill — no bill carries it, so none is missing.
  if (inUnused(x, n)) return true;
  // Verifier r21 DEAD-LETTER-AS-LOST: a bill the box gave up sending is ON the box (waiting for a person), never lost.
  if (coversEvery(x.deadLettered, n, slack)) return true;
  if (x.unsent !== undefined) return coversEvery(x.unsent, n, slack);
  return wholeQueueStandsIn;
}

/** Round 25 · OB-94: count `n` is among the numbers this report says were given and never put on a bill. */
export const inUnused = (x: Pick<IssuedReport, 'unused'>, n: number): boolean => (x.unused ?? []).some(([a, z]) => n >= a && n <= z);

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
    receiptNumbersIssued: issued.map((x) => { const { deadLettered: _d, unused: _u, ...rest } = x; void _d; void _u; return { ...rest, unsent: { count: 0 } }; }),
  };
}

/**
 * Round 25 · OB-93 "A" (verifier r24 NEW-1): does this report contradict its own queue? Such a report is not believed to
 * hold anything (`believedRecord`) — and it is not believed to have LET GO of anything either: a box that cannot add up
 * its own queue has not said, by its own word, that a bill is gone. Only an uncontradicted report says "gone".
 */
export const contradictsItself = (r: BoxHealthRecord): boolean =>
  r.queueContradiction !== undefined || (r.receiptNumbersIssued !== undefined && queueContradiction(r.queue, r.receiptNumbersIssued) !== undefined);

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
  /** Round 26 · OB-97: owner-approved "store computer replaced" acts (the binding follows them). */
  readonly replacements?: readonly StoreComputerReplacement[];
  /** Round 28 · OB-104: the store's waiting facts from the saved running result — when given, `records` is not read. */
  readonly facts?: readonly WaitingFacts[];
}): BillNumberFinding[] {
  const warnHours = input.warnHours ?? DEFAULT_BOX_UNSENT_WARN_HOURS;
  const atMs = Date.parse(input.at);
  const out: BillNumberFinding[] = [];
  for (const { prefix, lastReceivedAt, lastQueueUnsent, x, firstWaiting, wholeQueueSince } of input.facts ?? waitingFacts(input)) {
    const last = { receivedAt: lastReceivedAt, queue: { unsent: lastQueueUnsent } };
    const u = x.unsent;
    if (u === undefined) {
      // r22 D3: the box does not say which bills — its whole queue stands in, but only until the owner's line.
      if (last.queue.unsent === 0) continue;
      const since = wholeQueueSince();
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
    const first = firstWaiting(from, to) ?? { at: last.receivedAt, from, to };
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
 * Round 28 · OB-104: what the waiting clock (`billsWaitingOnTheBox`) speaks from for one prefix — from the store's reports
 * here (`waitingFacts`), or kept by the saved running result as it folds (`readBoxHistory`).
 */
export interface WaitingFacts {
  readonly prefix: string;
  /** The latest believed report naming the prefix: when it came, how many items its whole queue held, and its word. */
  readonly lastReceivedAt: string;
  readonly lastQueueUnsent: number;
  readonly x: IssuedReport;
  /** r23 NEW-1: the FIRST span head office was told was waiting (in the order it was told) that reaches [from, to]. */
  readonly firstWaiting: (from: number, to: number) => { readonly at: string; readonly from: number; readonly to: number } | undefined;
  /** r22 D3: when head office first saw the unbroken run, up to the latest report, of reports naming no list (`wholeQueueRunSince`). */
  readonly wholeQueueSince: () => string;
}

/**
 * Round 29 · OB-105 "A" (owner, 14 Oct 2026, in writing, "Trim + alarm before pilot"; verifier r28 NEW-1) — THE WAITING
 * CLOCK'S MEMORY (stated, so a person can check it). The clock (r23 NEW-1 · OB-89) ages each bill NUMBER from head office's
 * first sight of it in any list of bills "waiting to send" — a report in between that does not list it restarts nothing, so
 * a store computer cannot reset the clock by hiding a stuck bill for one report. Before this round every span it had ever
 * been told was kept for ever: an honest busy store (each bill waiting in one report, then sent) added one span per bill,
 * about 19,000 a day, and the saved result grew without end. THE RULE: a span that no report has said is waiting (no list
 * naming any of its numbers) for WAIT_FORGET_HOURS (24 hours, by head office's receipt of the reports) is FORGOTTEN — if a
 * list names its numbers again later, their clock starts again from then. It is checked once per hour of reports per till
 * prefix (each span is forgotten at the first report naming the prefix in a later hour), so it is the same in every
 * reading. A bill that stays stuck is listed in every report, so its span is never forgotten and its clock never restarts;
 * only a number every report has left out for a whole day can start again — and hiding a stuck bill for a day hides
 * nothing the finding would not already have said in that day (it fires at the owner's line, 2 hours by default). The
 * plain reading (`waitingFacts`) and the saved running result (`readBoxHistory`) use this same clock, so they still agree
 * exactly (tests/unit/the-box-history-is-its-full-reading).
 */
export const WAIT_FORGET_HOURS = 24;
const WAIT_SWEEP_MS = 3_600_000;
interface WaitSpan { readonly at: string; readonly atMs: number; readonly from: number; readonly to: number; lastMs: number }
class WaitClock {
  /** The spans that each reached a number no kept span had, in the order head office was told (first sight first). */
  spans: WaitSpan[] = [];
  /** The same spans by their first number (to find the ones a list reaches without looking at all of them). */
  private byFrom: WaitSpan[] = [];
  /** Every number a kept span reaches (joined runs). */
  private union: [number, number][] = [];
  private maxLen = 0;
  sweptHour = -Infinity;

  /** A report naming the prefix arrived at `ms`: once per hour of reports, forget the spans nobody has listed for a day. */
  tick(ms: number): void {
    const hour = Math.floor(ms / WAIT_SWEEP_MS);
    if (!(hour > this.sweptHour)) return;
    this.sweptHour = hour;
    const floor = ms - WAIT_FORGET_HOURS * 3_600_000;
    if (!this.spans.some((s) => s.lastMs < floor)) return;
    this.rebuild(this.spans.filter((s) => s.lastMs >= floor));
  }

  /** A list said [from, to] is waiting, at `ms`: every kept span it reaches was said again; a new number makes a new span. */
  told(at: string, ms: number, from: number, to: number): void {
    // The kept spans that can reach [from, to] start at most `maxLen` below `from` (binary search on their first number).
    let lo = 0; let hi = this.byFrom.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.byFrom[mid]!.from <= to) lo = mid + 1; else hi = mid; }
    for (let i = lo - 1; i >= 0; i -= 1) {
      const s = this.byFrom[i]!;
      if (s.from < from - this.maxLen) break;
      if (s.to >= from && s.lastMs < ms) s.lastMs = ms;
    }
    if (coveredBy(this.union, from, to)) return;
    const s: WaitSpan = { at, atMs: ms, from, to, lastMs: ms };
    this.spans.push(s);
    this.insert(s);
  }

  /** r23 NEW-1: the FIRST kept span (in the order head office was told) that reaches [from, to]. */
  first(from: number, to: number): { readonly at: string; readonly from: number; readonly to: number } | undefined {
    const s = this.spans.find((e) => e.from <= to && e.to >= from);
    return s === undefined ? undefined : { at: s.at, from: s.from, to: s.to };
  }

  private insert(s: WaitSpan): void {
    let lo = 0; let hi = this.byFrom.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.byFrom[mid]!.from <= s.from) lo = mid + 1; else hi = mid; }
    this.byFrom.splice(lo, 0, s);
    addRun(this.union, s.from, s.to);
    this.maxLen = Math.max(this.maxLen, s.to - s.from);
  }

  rebuild(spans: WaitSpan[]): void {
    this.spans = spans;
    this.byFrom = [...spans].sort((a, b) => a.from - b.from);
    this.union = [];
    this.maxLen = 0;
    for (const s of spans) { addRun(this.union, s.from, s.to); this.maxLen = Math.max(this.maxLen, s.to - s.from); }
  }

  /** Plain data (delta-coded, one flat list): [Δ first sight, its time as written or 0, Δ from, to − from, last − first sight]. */
  encode(): unknown[] {
    const out: unknown[] = [fin(this.sweptHour)];
    let pa = 0; let pf = 0;
    for (const s of this.spans) {
      out.push(s.atMs - pa, s.at === new Date(s.atMs).toISOString() ? 0 : s.at, s.from - pf, s.to - s.from, s.lastMs - s.atMs);
      pa = s.atMs; pf = s.from;
    }
    return out;
  }
  static decode(e: readonly unknown[]): WaitClock {
    const c = new WaitClock();
    c.sweptHour = (e[0] as number | null) ?? -Infinity;
    const spans: WaitSpan[] = [];
    let pa = 0; let pf = 0;
    for (let i = 1; i + 4 < e.length; i += 5) {
      const atMs = pa + (e[i] as number);
      const from = pf + (e[i + 2] as number);
      spans.push({ at: e[i + 1] === 0 ? new Date(atMs).toISOString() : e[i + 1] as string, atMs, from, to: from + (e[i + 3] as number), lastMs: atMs + (e[i + 4] as number) });
      pa = atMs; pf = from;
    }
    c.rebuild(spans);
    return c;
  }
}

/** Round 28 · OB-104: one store's `WaitingFacts` per prefix (in order), read from its reports (the plain reading). */
export function waitingFacts(input: {
  readonly records: readonly BoxHealthRecord[]; readonly storeId: string; readonly at: string; readonly replacements?: readonly StoreComputerReplacement[];
}): WaitingFacts[] {
  const atMs = Date.parse(input.at);
  // OB-94: only the bound store computer's word about a prefix counts (`bindPrefixesToComputers`); OB-97: as replaced.
  const mine = bindInOrder(input.records.filter((r) => r.storeId === input.storeId && Date.parse(r.receivedAt) <= atMs), atOrBefore(input.replacements, atMs)).map(believedRecord);
  const latest = new Map<string, { r: BoxHealthRecord; x: IssuedReport }>();
  // r23 NEW-1 · OB-105: every span head office has been told is waiting, per prefix, in the order it was told (`WaitClock`).
  const clocks = new Map<string, WaitClock>();
  for (const r of mine) {
    const ms = Date.parse(r.receivedAt);
    for (const x of r.receiptNumbersIssued ?? []) {
      latest.set(x.prefix, { r, x });
      let c = clocks.get(x.prefix);
      if (c === undefined) { c = new WaitClock(); clocks.set(x.prefix, c); }
      c.tick(ms);
      const w = x.unsent;
      if (names(w)) c.told(r.receivedAt, ms, w.from, w.to);
    }
  }
  return [...latest].sort((a, b) => a[0].localeCompare(b[0])).map(([prefix, { r: last, x }]) => ({
    prefix, lastReceivedAt: last.receivedAt, lastQueueUnsent: last.queue.unsent, x,
    firstWaiting: (from, to) => clocks.get(prefix)?.first(from, to),
    wholeQueueSince: () => wholeQueueRunSince(mine, prefix, last.receivedAt),
  }));
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
export function saysItMayHold(r: Pick<BoxHealthRecord, 'queue'>, x: Pick<IssuedReport, 'unsent' | 'deadLettered' | 'unused'>, n: number): 'list' | 'queue' | undefined {
  const inSpan = (q: QueuedBillNumbers | undefined): boolean => names(q) && n >= q.from && n <= q.to;
  // Round 25 · OB-94: its list of numbers given and never used is its own word about `n` too.
  if (inSpan(x.unsent) || inSpan(x.deadLettered) || inUnused(x, n)) return 'list';
  if (x.unsent === undefined && r.queue.unsent > 0) return 'queue';
  // An older box that does not list the bills it gave up on, but says it holds some: they may be among them (never "gone").
  if (x.deadLettered === undefined && r.queue.deadLettered > 0) return 'queue';
  return undefined;
}

/** r23 NEW-2: everything in one prefix's report that decides which of its numbers are noted, and which are said gone. */
interface SaidWords { readonly r: Pick<BoxHealthRecord, 'queue'>; readonly x: IssuedReport; readonly contradicted: boolean }
/**
 * r23 NEW-2 · round 25 OB-96: two reports say the same words for a prefix — compared field by field, without building a
 * string per report (a report may name 50 at-risk and 50 unused ranges; the fold reads every report of the day).
 */
function sameWords(a: SaidWords | undefined, b: SaidWords): boolean {
  if (a === undefined || a.contradicted !== b.contradicted) return false;
  const p = a.x; const q = b.x;
  const sameQ = (m: QueuedBillNumbers | undefined, n: QueuedBillNumbers | undefined): boolean =>
    m === n || (m !== undefined && n !== undefined && m.count === n.count && m.from === n.from && m.to === n.to);
  const sameRuns = (m: readonly (readonly [number, number])[] | undefined, n: readonly (readonly [number, number])[] | undefined): boolean => {
    if (m === n) return true;
    if (m === undefined || n === undefined || m.length !== n.length) return false;
    for (let i = 0; i < m.length; i += 1) if (m[i]![0] !== n[i]![0] || m[i]![1] !== n[i]![1]) return false;
    return true;
  };
  return p.soldThrough === q.soldThrough && p.through === q.through && sameQ(p.unsent, q.unsent) && sameQ(p.deadLettered, q.deadLettered)
    && (a.r.queue.unsent > 0) === (b.r.queue.unsent > 0) && (a.r.queue.deadLettered > 0) === (b.r.queue.deadLettered > 0)
    && sameRuns(p.atRisk, q.atRisk) && sameRuns(p.unused, q.unused);
}

/** Round 25 · OB-96: a run of counts [lo, hi] and the latest time any of them was noted (see `PerPrefix.settled`). */
export interface CountRun { readonly lo: number; readonly hi: number; readonly noted: number }

/** [from, to] ranges joined where they overlap or touch, in rising order. */
export function joinRuns(ranges: readonly (readonly [number, number])[]): [number, number][] {
  const out: [number, number][] = [];
  // A store computer sends its ranges in rising order: sorted only when they are not (no copy, no sort, per report).
  let rising = true;
  for (let i = 1; i < ranges.length && rising; i += 1) if (ranges[i]![0] < ranges[i - 1]![0]) rising = false;
  for (const [a, z] of rising ? ranges : [...ranges].sort((p, q) => p[0] - q[0])) {
    const lastRun = out[out.length - 1];
    if (lastRun !== undefined && a <= lastRun[1] + 1) lastRun[1] = Math.max(lastRun[1], z); else out.push([a, z]);
  }
  return out;
}

/**
 * Round 25 · OB-96 — THE BOUND (stated, so a person can check it): the at-risk numbers head office checks in ONE report
 * under one prefix are the newest UNRECEIVED_CHECK_CAP (500) across ALL its at-risk ranges (before round 25: the newest
 * 500 of EACH of up to 50 ranges — 25,000 a report, which let an altered store computer slow head office for minutes).
 * The older ones are `unchecked` — said to the owner as a finding (`at_risk_not_checked`), never silently dropped.
 */
export function atRiskExamined(atRisk: readonly (readonly [number, number])[] | undefined): { ranges: [number, number][]; unchecked: number } {
  const joined = joinRuns(atRisk ?? []);
  const ranges: [number, number][] = [];
  let left = UNRECEIVED_CHECK_CAP;
  let unchecked = 0;
  for (let i = joined.length - 1; i >= 0; i -= 1) {
    const [a, z] = joined[i]!;
    const width = z - a + 1;
    if (left === 0) { unchecked += width; continue; }
    const take = Math.min(width, left);
    ranges.push([z - take + 1, z]);
    unchecked += width - take;
    left -= take;
  }
  return { ranges: ranges.reverse(), unchecked };
}

/** OB-96: every count one report is checked over — the newest UNRECEIVED_CHECK_CAP above banked up to sold, and its at-risk ones. */
export function examinedCounts(banked: number, sold: number, atRisk: readonly (readonly [number, number])[] | undefined): [number, number][] {
  const from = Math.max(banked + 1, sold - UNRECEIVED_CHECK_CAP + 1);
  return joinRuns([...(from <= sold ? [[from, sold] as const] : []), ...atRiskExamined(atRisk).ranges]);
}

const NO_RUNS: readonly (readonly [number, number])[] = [];
/** OB-96: each run's two ends (its first count, and the one after its last) onto `out`. */
function pushEnds(out: number[], list: readonly (readonly [number, number])[]): void {
  for (let i = 0; i < list.length; i += 1) { const v = list[i]!; out.push(v[0], v[1] + 1); }
}

/** OB-96: sort a list of counts in place — insertion for the usual handful, the built-in sort beyond that. */
function sortSmall(a: number[]): void {
  if (a.length > 24) { a.sort((p, q) => p - q); return; }
  for (let i = 1; i < a.length; i += 1) {
    const v = a[i]!;
    let j = i - 1;
    while (j >= 0 && a[j]! > v) { a[j + 1] = a[j]!; j -= 1; }
    a[j + 1] = v;
  }
}

/** OB-96: the spans of a report's lists (one or two queue spans and its unused ranges), joined, in rising order. */
function spansOf(a: QueuedBillNumbers | undefined, b: QueuedBillNumbers | undefined, more: readonly (readonly [number, number])[]): readonly (readonly [number, number])[] {
  if (a === undefined && b === undefined) return more.length <= 1 ? more : joinRuns(more);
  const list: (readonly [number, number])[] = [];
  if (a !== undefined) list.push([a.from!, a.to!]);
  if (b !== undefined) list.push([b.from!, b.to!]);
  for (const v of more) list.push(v);
  return list.length === 1 ? list : joinRuns(list);
}

/** OB-96: the index of the first run (of sorted, apart runs) ending at or after `p`, by halving. */
function firstEndingAtOrAfter(list: readonly CountRun[], p: number): number {
  let a = 0;
  let z = list.length;
  while (a < z) { const m = (a + z) >> 1; if (list[m]!.hi < p) a = m + 1; else z = m; }
  return a;
}

/**
 * OB-96: a forward-only walk over sorted, apart runs (`[from, to]` pairs or `CountRun`s): does the run holding `p` exist
 * (and, for runs with a time, was it noted no later than `notedMs`)? Each `p` is asked no lower than the last.
 */
class Walker {
  private list: readonly (CountRun | readonly [number, number])[] = [];
  private i = 0;
  private limit = -Infinity;
  /** The time of the run that last held `p` (`CountRun`s only). */
  noted = -Infinity;
  reset(list: readonly (CountRun | readonly [number, number])[], from: number, notedMs: number): void { this.list = list; this.i = from; this.limit = notedMs; }
  holds(p: number): boolean {
    const list = this.list;
    for (;;) {
      const v = list[this.i];
      if (v === undefined) return false;
      const isRun = !Array.isArray(v);
      const lo = isRun ? (v as CountRun).lo : (v as readonly [number, number])[0];
      const hi = isRun ? (v as CountRun).hi : (v as readonly [number, number])[1];
      if (hi < p) { this.i += 1; continue; }
      if (lo > p) return false;
      if (!isRun) return true;
      this.noted = (v as CountRun).noted;
      return this.noted <= this.limit;
    }
  }
}

/** OB-96: the run (of sorted, apart runs) holding count `p`, by halving. */
function runAt(list: readonly CountRun[], p: number): CountRun | undefined {
  let a = 0;
  let z = list.length;
  while (a < z) { const m = (a + z) >> 1; if (list[m]!.hi < p) a = m + 1; else z = m; }
  const v = list[a];
  return v !== undefined && v.lo <= p ? v : undefined;
}

/** A forward-only look-up over sorted, apart runs: the run holding `p` (each `p` asked no lower than the last). */
function cursor<T extends { readonly lo: number; readonly hi: number }>(list: readonly T[]): (p: number) => T | undefined {
  let i = 0;
  return (p) => {
    while (i < list.length && list[i]!.hi < p) i += 1;
    const v = list[i];
    return v !== undefined && v.lo <= p ? v : undefined;
  };
}

/**
 * OB-96: lay this report's runs over the kept ones. Inside a new run what is known is the new run's time (or the kept one's,
 * when earlier — both hold); outside, the kept runs stay. Runs that touch are joined when the later of their times is no
 * later than this report (`ms`): every later report is noted no earlier, so the joined run stays usable — which keeps the
 * set small for an honest store computer and for one that alternates what it says.
 */
function layRuns(kept: readonly CountRun[], fresh: readonly CountRun[], ms: number): CountRun[] {
  if (fresh.length === 0) return kept as CountRun[];
  const lo = fresh[0]!.lo;
  const hi = fresh[fresh.length - 1]!.hi;
  let i0 = 0;
  while (i0 < kept.length && kept[i0]!.hi < lo - 1) i0 += 1;
  let i1 = i0;
  while (i1 < kept.length && kept[i1]!.lo <= hi + 1) i1 += 1;
  // The usual case, without a copy: one new run over (or beside) at most one kept run, all no later than this report.
  if (fresh.length === 1 && i1 - i0 <= 1) {
    const f = fresh[0]!;
    const o = kept[i0];
    if (i1 === i0) return [...kept.slice(0, i0), f, ...kept.slice(i0)];
    if (o !== undefined && o.lo <= f.lo && o.hi >= f.hi && o.noted <= f.noted) return kept as CountRun[]; // nothing new
    if (o !== undefined && Math.max(o.noted, f.noted) <= ms) {
      const joined: CountRun = { lo: Math.min(o.lo, f.lo), hi: Math.max(o.hi, f.hi), noted: Math.max(o.noted, f.noted) };
      if (kept.length === 1) return [joined];
      return [...kept.slice(0, i0), joined, ...kept.slice(i1)];
    }
  }
  const old = kept.slice(i0, i1);
  const cuts = new Set<number>();
  for (const v of [...old, ...fresh]) { cuts.add(v.lo); cuts.add(v.hi + 1); }
  const points = [...cuts].sort((p, q) => p - q);
  const inOld = cursor(old);
  const inFresh = cursor(fresh);
  const pieces: CountRun[] = [];
  for (let k = 0; k + 1 < points.length; k += 1) {
    const p = points[k]!;
    const q = points[k + 1]! - 1;
    const o = inOld(p);
    const f = inFresh(p);
    if (o === undefined && f === undefined) continue;
    const noted = o === undefined ? f!.noted : f === undefined ? o.noted : Math.min(o.noted, f.noted);
    const prev = pieces[pieces.length - 1];
    if (prev !== undefined && prev.hi + 1 === p && (prev.noted === noted || Math.max(prev.noted, noted) <= ms)) {
      pieces[pieces.length - 1] = { lo: prev.lo, hi: q, noted: Math.max(prev.noted, noted) };
    } else pieces.push({ lo: p, hi: q, noted });
  }
  return [...kept.slice(0, i0), ...pieces, ...kept.slice(i1)];
}

/**
 * Round 25 · OB-94 "A" (verifier r24 P4) — ONE STORE COMPUTER PER BILL-NUMBER PREFIX (stated, so a person can check it):
 * a prefix head office folds from a store computer's report is BOUND to the store computer (its own sign-in, the report's
 * `reportedBy`) whose report first named it, in the order head office received them. Every later report that names the
 * prefix from ANOTHER store computer — a stand-by box, a second box set up with the same till, a copy — is kept as
 * evidence, never believed: its word about that prefix moves to `receiptNumbersRefused` (`prefix_of_another_store_computer`,
 * naming the bound store computer), so it can neither hold a lost bill back nor say a waiting bill is gone. A box restored
 * from a backup (OB-87) keeps its own sign-in, so it is never refused. A prefix is never issued twice (receipt-prefixes.ts),
 * so a binding never moves by itself — except (round 26 · OB-97 "B") by an owner-approved "store computer replaced" act
 * (`StoreComputerReplacement`): from the act's moment on, the prefix is bound to the NEW store computer's sign-in — its
 * reports are used and the old one's are refused by name. Acts are applied in time order before the reports that came after
 * them; the latest one for a (store, prefix) decides. A report that came BEFORE the act keeps the verdict it had.
 */
export function bindPrefixesToComputers(records: readonly BoxHealthRecord[], replacements: readonly StoreComputerReplacement[] = []): BoxHealthRecord[] {
  return foldBindings(records, replacements).out;
}

/** Round 27 (cost): the reports as bound (`bindPrefixesToComputers`), in the order head office received them (each time read once). */
function bindInOrder(records: readonly BoxHealthRecord[], replacements: readonly StoreComputerReplacement[] = []): BoxHealthRecord[] {
  return byReceipt(foldBindings(records, replacements).out);
}
/** Reports in the order head office received them — a stable sort, each time read once (never inside the comparison). */
function byReceipt(records: readonly BoxHealthRecord[]): BoxHealthRecord[] {
  return records.map((r, i) => ({ r, i, ms: Date.parse(r.receivedAt) })).sort((a, b) => a.ms - b.ms || a.i - b.i).map(({ r }) => r);
}

/**
 * Round 26 · OB-97 "B": an owner-approved act moving one (store, bill-number prefix) from the store computer it was bound to
 * (`from`, a sign-in) to its replacement (`to`). Kept append-only; never edited, never removed.
 */
export interface StoreComputerReplacement {
  readonly replacementId: string;
  readonly storeId: string;
  readonly prefix: string;
  /** The store computer (sign-in) the prefix was bound to when the act was done. */
  readonly from: string;
  /** The replacement store computer (sign-in) — a store computer of `storeId`. */
  readonly to: string;
  readonly reason: string;
  /** The head office business person who did the act (the maker). */
  readonly requestedBy: string;
  /** The owner, who approved it on the maker-checker engine (never the maker). */
  readonly approvedBy: string;
  readonly approvalId: string;
  readonly at: string;
}

/** Round 26 · OB-97: who a (store, prefix) is bound to now, and how it came to be. */
export interface PrefixBinding {
  readonly storeId: string;
  readonly prefix: string;
  readonly computer: string;
  readonly since: string;
  /** `first_report`: the store computer whose report named it first (OB-94); `replacement`: an approved act (OB-97). */
  readonly via: 'first_report' | 'replacement';
  readonly replacementId?: string;
}

const bindingKey = (storeId: string, prefix: string): string => `${storeId}\u0000${prefix}`;
/** The acts done by `atMs` (a read "as at" a moment never applies a later act). */
const atOrBefore = (replacements: readonly StoreComputerReplacement[] | undefined, atMs: number): readonly StoreComputerReplacement[] =>
  (replacements ?? []).filter((m) => Date.parse(m.at) <= atMs);

function foldBindings(records: readonly BoxHealthRecord[], replacements: readonly StoreComputerReplacement[], untilMs = Infinity): { out: BoxHealthRecord[]; bound: Map<string, PrefixBinding> } {
  const ordered = records.map((r, i) => ({ r, i, ms: Date.parse(r.receivedAt) })).sort((a, b) => a.ms - b.ms || a.i - b.i);
  const acts = sortedActs(replacements).filter((a) => a.ms <= untilMs);
  const bound = new Map<string, PrefixBinding>();
  const out: BoxHealthRecord[] = new Array(records.length);
  let k = 0;
  const actUntil = (ms: number): void => { for (; k < acts.length && acts[k]!.ms <= ms; k += 1) applyAct(bound, acts[k]!.m); };
  for (const { r, i, ms } of ordered) {
    actUntil(ms);
    out[i] = bindRecord(bound, r);
  }
  actUntil(untilMs);
  return { out, bound };
}

/** Round 26 · OB-97: the acts in the order they apply (their time, then the order head office kept them). */
function sortedActs(replacements: readonly StoreComputerReplacement[]): { m: StoreComputerReplacement; ms: number }[] {
  return replacements.map((m, i) => ({ m, i, ms: Date.parse(m.at) })).sort((a, b) => a.ms - b.ms || a.i - b.i).map(({ m, ms }) => ({ m, ms }));
}
/** Round 26 · OB-97: an act moves its (store, prefix) to the new store computer. */
function applyAct(bound: Map<string, PrefixBinding>, m: StoreComputerReplacement): void {
  bound.set(bindingKey(m.storeId, m.prefix), { storeId: m.storeId, prefix: m.prefix, computer: m.to, since: m.at, via: 'replacement', replacementId: m.replacementId });
}
/**
 * OB-94: one report as head office reads it under the bindings so far — a prefix no store computer has named yet is bound to
 * this one; a prefix bound to another store computer is refused by name (round 27 · OB-101: with why and since when).
 */
function bindRecord(bound: Map<string, PrefixBinding>, r: BoxHealthRecord): BoxHealthRecord {
  const issued = r.receiptNumbersIssued;
  if (issued === undefined || issued.length === 0) return r;
  const kept: IssuedReport[] = [];
  const refused: RefusedIssued[] = [];
  for (const x of issued) {
    const key = bindingKey(r.storeId, x.prefix);
    const owner = bound.get(key);
    if (owner === undefined) bound.set(key, { storeId: r.storeId, prefix: x.prefix, computer: r.reportedBy, since: r.receivedAt, via: 'first_report' });
    if (owner === undefined || owner.computer === r.reportedBy) kept.push(x);
    else {
      refused.push({
        prefix: x.prefix, through: x.through, because: 'prefix_of_another_store_computer', bankedThrough: 0, boundTo: owner.computer,
        boundVia: owner.via, boundSince: owner.since, ...(owner.replacementId === undefined ? {} : { boundReplacementId: owner.replacementId }),
      });
    }
  }
  return refused.length === 0 ? r : { ...r, receiptNumbersIssued: kept, receiptNumbersRefused: [...(r.receiptNumbersRefused ?? []), ...refused] };
}

/** Round 26 · OB-97: every (store, prefix) binding as it stands at `at` (reports received and acts done by then). */
export function prefixBindings(records: readonly BoxHealthRecord[], replacements: readonly StoreComputerReplacement[], at?: string): PrefixBinding[] {
  const untilMs = at === undefined ? Infinity : Date.parse(at);
  const { bound } = foldBindings(records.filter((r) => Date.parse(r.receivedAt) <= untilMs), replacements, untilMs);
  return [...bound.values()].sort((a, b) => a.storeId.localeCompare(b.storeId) || a.prefix.localeCompare(b.prefix));
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
  /** Round 26 · OB-97: owner-approved "store computer replaced" acts — lost-bill checks follow the prefix to the new computer. */
  readonly replacements?: readonly StoreComputerReplacement[];
}): UnreceivedCandidate[] {
  return readNeverReceived(input).candidates;
}

/** Round 27 · OB-102: one number's notes in the never-received fold (`unreceivedCandidates`). */
interface Noted { noted: number; notedAt: string; gone: number }
/**
 * Round 27 · OB-102: one examination track of a prefix — the numbers noted, and (r23 NEW-2 · OB-96) the runs of counts
 * already settled (noted and said gone) or noted, so a later report can pass over them without a look.
 */
interface Track { numbers: Map<number, Noted>; settled: CountRun[]; noted: CountRun[] }
const newTrack = (): Track => ({ numbers: new Map(), settled: [], noted: [] });
/** Round 27 · OB-100: a run of counts the store computer said it gave and never used, the day it FIRST said so, and the latest time it said so. */
interface UnusedRun { lo: number; hi: number; day: string; lastMs: number }

interface FoldKey {
  readonly storeId: string; readonly prefix: string;
  latest: { readonly queue: BoxHealthRecord['queue']; readonly x: IssuedReport };
  wholeQueueSince: string | undefined; wholeQueueSinceMs: number;
  /** The previous report's words for this prefix, and the time its numbers were noted at (the repeat skip). */
  said: SaidWords | undefined; saidNoted: number;
  /**
   * Round 27 · OB-102 — the counts ABOVE what head office has banked (`aboveFrom`, the banked count the fold last used —
   * banked only ever rises): the newest UNRECEIVED_CHECK_CAP up to what the box sold, and its at-risk ones above banked.
   */
  above: Track; aboveFrom: number;
  /** Round 27 · OB-102 — the at-risk counts (the newest UNRECEIVED_CHECK_CAP of every report), at or below banked too. */
  risk: Track;
  /** Round 27 · OB-100: every count the box said it gave and never used; the latest list, and the hour it was last laid. */
  unused: UnusedRun[]; unusedList: readonly (readonly [number, number])[] | undefined; unusedListMs: number;
  /** Round 29 · OB-105: the hour of reports the unused runs were last swept for ones said too long ago (`noteUnused`). */
  unusedSwept: number;
}

/**
 * Round 27 · OB-102 "A" (owner, 13 Oct 2026, in writing, "Fix before pilot"; verifier r26 NEW-4) — THE SAVED RUNNING RESULT
 * (stated, so a person can check it). The never-received fold is a fold over the store computers' reports in the order head
 * office received them. Its state after the reports received up to a moment is saved (a disposable snapshot, like the bill-
 * number high-water's), and a later read folds only the reports received AFTER that moment onto it — never the whole history
 * again. Saved only up to FOLD_SETTLE_MINUTES before the read (a report whose write is still finishing is never left out),
 * and at most every FOLD_SNAPSHOT_EVERY reports. The answer is the same as a fold of every report, by construction:
 *   • what head office has banked only rises, so the fold keeps two tracks per prefix — the counts ABOVE the banked count
 *     it used (the newest 500 sold and the at-risk ones), and the at-risk counts — and a read takes each number from the
 *     track that a fold of everything at today's banked count would have used;
 *   • the saved result is used ONLY when everything it was made from still stands — the same settings (the owner's unsent
 *     line, claim slack and time zone), the same reports up to its moment (the same count; a report that arrived late, or a
 *     report judged differently at read, starts again from nothing), the same "store computer replaced" acts up to its last
 *     report, and no banked count lower than the one it used. Otherwise it is set aside and the fold starts from nothing.
 * Proved equal to the fold of everything on seeded random histories (tests/unit/the-never-received-fold-is-its-plain-reading).
 */
export const FOLD_SETTLE_MINUTES = 10;
export const FOLD_SNAPSHOT_EVERY = 64;
const FOLD_SNAPSHOT_VERSION = 3; // round 29: minute steps for unused numbers, their memory (OB-105)

/** A prefix head office dropped from a report when it judged it at read (`judgeReportedIssued`). */
export interface JudgedAway { readonly receivedAt: string; readonly storeId: string; readonly prefix: string; readonly through: number }

/** Round 27 · OB-102: the saved running result — plain data (it is kept as JSON on PostgreSQL). */
export interface NeverReceivedSnapshot {
  readonly version: number;
  /** Every report received at or before this moment is in it, and none after. */
  readonly settledAt: string;
  readonly settledCount: number;
  readonly lineMs: number;
  readonly slack: ClaimSlack;
  readonly timeZone: string;
  readonly judgedAway: string;
  readonly lastMs: number | null;
  readonly actsApplied: readonly string[];
  readonly bound: readonly PrefixBinding[];
  readonly keys: readonly EncodedKey[];
}
interface EncodedTrack { readonly n: readonly (readonly [number, number, string, number | null])[]; readonly s: readonly (readonly [number, number, number])[]; readonly o: readonly (readonly [number, number, number])[] }
interface EncodedKey {
  readonly storeId: string; readonly prefix: string; readonly latest: FoldKey['latest'];
  readonly wqs: string | null; readonly wqsMs: number | null;
  readonly said: { readonly queue: BoxHealthRecord['queue']; readonly x: IssuedReport; readonly contradicted: boolean } | null; readonly saidNoted: number | null;
  readonly above: EncodedTrack; readonly aboveFrom: number; readonly risk: EncodedTrack;
  readonly unused: readonly (readonly [number, number, string, number])[]; readonly unusedList: readonly (readonly [number, number])[] | null; readonly unusedListMs: number | null;
  readonly unusedSwept: number | null;
}

const fin = (v: number): number | null => (Number.isFinite(v) ? v : null);
const encodeTrack = (t: Track, from: number): EncodedTrack => ({
  n: [...t.numbers].filter(([n]) => n > from).map(([n, e]) => [n, e.noted, e.notedAt, fin(e.gone)] as const),
  s: t.settled.filter((v) => v.hi > from).map((v) => [v.lo, v.hi, v.noted] as const),
  o: t.noted.filter((v) => v.hi > from).map((v) => [v.lo, v.hi, v.noted] as const),
});
const decodeTrack = (e: EncodedTrack): Track => ({
  numbers: new Map(e.n.map(([n, noted, notedAt, gone]) => [n, { noted, notedAt, gone: gone ?? Infinity }])),
  settled: e.s.map(([lo, hi, noted]) => ({ lo, hi, noted })), noted: e.o.map(([lo, hi, noted]) => ({ lo, hi, noted })),
});

/** A short fingerprint of a text (cyrb53) — to tell a changed list from the one a snapshot was made from. */
function fingerprint(text: string): string {
  let h1 = 0xdeadbeef; let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) { const c = text.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16)}${(h1 >>> 0).toString(16)}:${text.length}`;
}
const judgedAwayUpTo = (list: readonly JudgedAway[] | undefined, ms: number): string =>
  fingerprint((list ?? []).filter((j) => Date.parse(j.receivedAt) <= ms).map((j) => `${j.receivedAt}|${j.storeId}|${j.prefix}|${j.through}`).sort().join('\n'));

/** Round 27 · OB-100: the store's calendar day of a moment (in its own time zone), worked out once per quarter hour. */
function dayIn(timeZone: string): (ms: number) => string {
  let fmt: Intl.DateTimeFormat;
  try { fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); } catch { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }); }
  // Every time zone's offset is a whole number of quarter hours, so a day never changes inside a UTC quarter hour.
  let bucket = NaN; let day = '';
  return (ms) => {
    const b = Math.floor(ms / 900_000);
    if (b !== bucket) { bucket = b; day = fmt.format(new Date(ms)); }
    return day;
  };
}
/** The shop's own time zone when head office is not told another (packages/tenant settings `locale.time_zone`). */
export const DEFAULT_STORE_TIME_ZONE = 'Asia/Kolkata';

type SortedAct = { readonly m: StoreComputerReplacement; readonly ms: number };

/** Round 27 · OB-102: the never-received fold, fed report by report (see `readNeverReceived`). */
class NeverReceivedFold {
  readonly keys = new Map<string, FoldKey>();
  readonly bound = new Map<string, PrefixBinding>();
  actsApplied: string[] = [];
  lastMs = -Infinity;
  private readonly walkSeg = new Walker(); private readonly walkS = new Walker(); private readonly walkN = new Walker();
  private readonly walkHeld = new Walker(); private readonly walkMay = new Walker();
  private readonly day: (ms: number) => string;
  constructor(readonly lineMs: number, readonly slack: ClaimSlack, readonly timeZone: string, readonly riskFull: boolean) { this.day = dayIn(timeZone); }

  /** Apply every act (sorted) up to `ms` not applied yet — before the report received at `ms` (as `foldBindings`). */
  applyActsUntil(acts: readonly SortedAct[], ms: number): void {
    for (let k = this.actsApplied.length; k < acts.length && acts[k]!.ms <= ms; k += 1) {
      applyAct(this.bound, acts[k]!.m); this.onAct?.(acts[k]!.m); this.actsApplied.push(acts[k]!.m.replacementId);
    }
  }

  /** Round 28 · OB-104: told of each act as it is applied (the box history binds the reports as kept too). */
  onAct: ((m: StoreComputerReplacement) => void) | undefined;

  /** Folds one report; answers it as bound (OB-94/97) — not believed. */
  feed(raw0: BoxHealthRecord, ms: number, acts: readonly SortedAct[], bankedOf: (prefix: string) => number): BoxHealthRecord {
    this.applyActsUntil(acts, ms);
    this.lastMs = ms;
    const raw = bindRecord(this.bound, raw0);
    const r = believedRecord(raw);
    // Round 25 · OB-93: a report that contradicts its own queue is believed neither to hold a bill nor to have let one go.
    const contradicted = r !== raw;
    const said = raw.receiptNumbersIssued ?? [];
    const issued = r.receiptNumbersIssued ?? [];
    const observedMs = Date.parse(raw.observedAt);
    for (let xi = 0; xi < issued.length; xi += 1) {
      const x = issued[xi]!;
      const key = `${r.storeId}\u0000${x.prefix}`;
      let cur = this.keys.get(key);
      if (cur === undefined) {
        cur = {
          storeId: r.storeId, prefix: x.prefix, latest: { queue: r.queue, x }, wholeQueueSince: undefined, wholeQueueSinceMs: NaN, said: undefined, saidNoted: Infinity,
          above: newTrack(), aboveFrom: bankedOf(x.prefix), risk: newTrack(), unused: [], unusedList: undefined, unusedListMs: -Infinity, unusedSwept: -Infinity,
        };
        this.keys.set(key, cur);
      }
      cur.latest = { queue: r.queue, x };
      // Round 27 · OB-100: the numbers it says it gave and never used — its own word, believed or not, kept to be SHOWN.
      this.noteUnused(cur, said[xi]?.prefix === x.prefix ? said[xi]!.unused : x.unused, observedMs, ms);
      // r22 D3: head office's own first sight of the unbroken run of reports that say no list but hold something.
      const wholeQueue = x.unsent === undefined && r.queue.unsent > 0;
      if (!wholeQueue) cur.wholeQueueSince = undefined;
      else if (cur.wholeQueueSince === undefined) { cur.wholeQueueSince = r.receivedAt; cur.wholeQueueSinceMs = ms; }
      const lineAt = cur.wholeQueueSince === undefined ? undefined : cur.wholeQueueSinceMs + this.lineMs;
      // Not on the box by its list: noted from this report — or, while its whole queue stands in, from the owner's line.
      const notedMs = lineAt === undefined || ms >= lineAt ? ms : lineAt;
      // r23 NEW-2: the same words as the previous report for this prefix, noted no earlier — nothing can change.
      const words: SaidWords = { r: { queue: r.queue }, x, contradicted };
      if (sameWords(cur.said, words) && notedMs >= cur.saidNoted) continue;
      cur.said = words;
      cur.saidNoted = notedMs;
      const banked = bankedOf(x.prefix);
      cur.aboveFrom = banked;
      const sold = x.soldThrough ?? x.through;
      // OB-96: the counts this report is checked over — the newest UNRECEIVED_CHECK_CAP up to what it sold, and the newest
      // UNRECEIVED_CHECK_CAP it cannot vouch for (across ALL its at-risk ranges) — at most 2 × the cap, whatever it sends.
      // OB-102: split at banked — above it (the "above" track), and the at-risk ones (the "risk" track: at or below banked,
      // or all of them when the result is to be saved, since banked rises).
      const risky = atRiskExamined(x.atRisk).ranges;
      const segsAbove = examinedAbove(banked, sold, risky);
      const segsRisk = this.riskFull ? risky : clipAtOrBelow(risky, banked);
      if (segsAbove.length === 0 && segsRisk.length === 0) continue;
      const notedAt = notedMs === ms ? r.receivedAt : new Date(notedMs).toISOString();
      // r23 NEW-2: this report's words, worked out once.
      const u = x.unsent;
      const d = x.deadLettered;
      const unused = x.unused ?? NO_RUNS;
      // The spans it says it MAY hold (any list's span, and the numbers it gave and never used) — none there is said gone.
      const mayHold = spansOf(names(u) ? u : undefined, names(d) ? d : undefined, unused);
      // The spans it holds WHOLE (`stillOnTheBox(r, x, n, false, slack)`) — none there is noted.
      const held = spansOf(believedWhole(u, this.slack) ? u : undefined, believedWhole(d, this.slack) ? d : undefined, unused);
      // Nothing it says lets a number go: its whole queue (or given-up queue) stands in, or (OB-93) it contradicts itself.
      const cannotSayGone = contradicted || (u === undefined && r.queue.unsent > 0) || (d === undefined && r.queue.deadLettered > 0);
      const w = { ms, notedMs, notedAt, mayHold, held, cannotSayGone };
      if (segsAbove.length > 0) this.examine(cur.above, segsAbove, w);
      if (segsRisk.length > 0) this.examine(cur.risk, segsRisk, w);
    }
    return raw;
  }

  /** One report's look at one track over the counts `segs` (the r23 NEW-2 / OB-96 walk, unchanged). */
  private examine(t: Track, segs: readonly (readonly [number, number])[], w: {
    readonly ms: number; readonly notedMs: number; readonly notedAt: string; readonly mayHold: readonly (readonly [number, number])[];
    readonly held: readonly (readonly [number, number])[]; readonly cannotSayGone: boolean;
  }): void {
    const { ms, notedMs, notedAt, mayHold, held, cannotSayGone } = w;
    // OB-96: every count it is checked over is already settled (noted no later than this report, and said gone) —
    // nothing it says can change anything, so it is passed over in a few look-ups, however many ranges it names.
    if (segs.every(([a, z]) => { const v = runAt(t.settled, a); return v !== undefined && v.hi >= z && v.noted <= notedMs; })) return;
    const numbers = t.numbers;
    const lo = segs[0]![0];
    const hi = segs[segs.length - 1]![1];
    // Every place where what is known changes: a piece between two of them is passed over whole, or looked at number by number.
    const cuts: number[] = [];
    pushEnds(cuts, segs); pushEnds(cuts, mayHold); pushEnds(cuts, held);
    const s0 = firstEndingAtOrAfter(t.settled, lo);
    const n0 = firstEndingAtOrAfter(t.noted, lo);
    for (let i = s0; i < t.settled.length && t.settled[i]!.lo <= hi; i += 1) if (t.settled[i]!.noted <= notedMs) cuts.push(t.settled[i]!.lo, t.settled[i]!.hi + 1);
    for (let i = n0; i < t.noted.length && t.noted[i]!.lo <= hi; i += 1) if (t.noted[i]!.noted <= notedMs) cuts.push(t.noted[i]!.lo, t.noted[i]!.hi + 1);
    sortSmall(cuts);
    const { walkSeg, walkS, walkN, walkHeld, walkMay } = this;
    walkSeg.reset(segs, 0, -Infinity); walkS.reset(t.settled, s0, notedMs); walkN.reset(t.noted, n0, notedMs);
    walkHeld.reset(held, 0, -Infinity); walkMay.reset(mayHold, 0, -Infinity);
    let runsS: CountRun[] | undefined;
    let runsN: CountRun[] | undefined;
    let sLo = NaN; let sMax = -Infinity; let nLo = NaN; let nMax = -Infinity;
    let last = NaN;
    for (let k = 0; k + 1 < cuts.length; k += 1) {
      const p = cuts[k]!;
      const q = cuts[k + 1]! - 1;
      if (q < p) continue;
      if (!walkSeg.holds(p)) {
        if (!Number.isNaN(sLo)) { if (p - 1 >= sLo) (runsS ??= []).push({ lo: sLo, hi: p - 1, noted: sMax }); sLo = NaN; sMax = -Infinity; }
        if (!Number.isNaN(nLo)) { if (p - 1 >= nLo) (runsN ??= []).push({ lo: nLo, hi: p - 1, noted: nMax }); nLo = NaN; nMax = -Infinity; }
        continue;
      }
      last = q;
      if (walkS.holds(p)) {
        // The SETTLED run: every number noted no later than this report and already said gone — nothing to learn.
        if (Number.isNaN(sLo)) sLo = p;
        if (Number.isNaN(nLo)) nLo = p;
        sMax = Math.max(sMax, walkS.noted); nMax = Math.max(nMax, walkS.noted);
        continue;
      }
      // A span this report holds WHOLE: none is noted, none said gone (`note` would change nothing).
      if (walkHeld.holds(p)) {
        if (!Number.isNaN(sLo)) { if (p - 1 >= sLo) (runsS ??= []).push({ lo: sLo, hi: p - 1, noted: sMax }); sLo = NaN; sMax = -Infinity; }
        if (!Number.isNaN(nLo)) { if (p - 1 >= nLo) (runsN ??= []).push({ lo: nLo, hi: p - 1, noted: nMax }); nLo = NaN; nMax = -Infinity; }
        continue;
      }
      const may = cannotSayGone || walkMay.holds(p);
      if (may && walkN.holds(p)) {
        // The NOTED run where this report may hold them: nothing to note, and nothing it can say gone.
        if (!Number.isNaN(sLo)) { if (p - 1 >= sLo) (runsS ??= []).push({ lo: sLo, hi: p - 1, noted: sMax }); sLo = NaN; sMax = -Infinity; }
        if (Number.isNaN(nLo)) nLo = p;
        nMax = Math.max(nMax, walkN.noted);
        continue;
      }
      for (let n = p; n <= q; n += 1) {
        let e = numbers.get(n);
        if (e === undefined) { e = { noted: notedMs, notedAt, gone: Infinity }; numbers.set(n, e); }
        else if (notedMs < e.noted) { e.noted = notedMs; e.notedAt = notedAt; }
        // r23 NEW-1: the first report that said, by its own word, that the box did not hold it (saysItMayHold: undefined).
        if (e.gone === Infinity && !may) e.gone = ms;
        if (e.gone !== Infinity) { if (Number.isNaN(sLo)) sLo = n; sMax = Math.max(sMax, e.noted); }
        else if (!Number.isNaN(sLo)) { if (n - 1 >= sLo) (runsS ??= []).push({ lo: sLo, hi: n - 1, noted: sMax }); sLo = NaN; sMax = -Infinity; }
        if (Number.isNaN(nLo)) nLo = n;
        nMax = Math.max(nMax, e.noted);
      }
    }
    if (!Number.isNaN(sLo) && last >= sLo) (runsS ??= []).push({ lo: sLo, hi: last, noted: sMax });
    if (!Number.isNaN(nLo) && last >= nLo) (runsN ??= []).push({ lo: nLo, hi: last, noted: nMax });
    if (runsS !== undefined) t.settled = layRuns(t.settled, runsS, ms);
    if (runsN !== undefined) t.noted = layRuns(t.noted, runsN, ms);
  }

  /**
   * Round 27 · OB-100: lay one report's "given and never used" list over what this prefix's store computer said before.
   * A count first said on a day belongs to that day (the store's own calendar, by head office's receipt of the report);
   * every count keeps the latest MINUTE it was said (round 29 · verifier r28 NEW-6: UNUSED_SAID_STEP, the store computer's
   * report time rounded DOWN to the minute — never later than it was said; it was the hour before). A list repeated word
   * for word within the same minute changes nothing.
   * Round 29 · OB-105 — THE UNUSED RUNS' MEMORY (stated): a run the store computer last said was unused more than
   * UNUSED_FORGET_DAYS (30) days before its latest report under the prefix is FORGOTTEN — checked once per hour of reports.
   * It is then no longer shown (the page shows the newest 7 days that have any) and no longer checked against head office's
   * bills; if the store computer says it again, it is a new run of that day. An honest store computer says a number is
   * unused only until a bill takes it (or for good, for a bill abandoned at the till), so a month is far beyond any
   * honest case of a bill reaching head office after its number was said unused.
   */
  private noteUnused(cur: FoldKey, list: readonly (readonly [number, number])[] | undefined, observedMs: number, ms: number): void {
    const said = list ?? NO_RUNS;
    const step = Math.floor(observedMs / UNUSED_SAID_STEP) * UNUSED_SAID_STEP;
    const hour = Math.floor(ms / 3_600_000);
    if (hour > cur.unusedSwept) {
      cur.unusedSwept = hour;
      const floor = step - UNUSED_FORGET_DAYS * 86_400_000;
      if (cur.unused.some((u) => u.lastMs < floor)) cur.unused = cur.unused.filter((u) => u.lastMs >= floor);
    }
    if (sameRanges(cur.unusedList ?? NO_RUNS, said) && (said.length === 0 || step <= cur.unusedListMs)) return;
    if (said.length > 0) cur.unused = layUnused(cur.unused, said, this.day(ms), step);
    cur.unusedList = said.length === 0 ? undefined : said;
    cur.unusedListMs = said.length === 0 ? -Infinity : Math.max(step, cur.unusedListMs);
  }

  /** The answer at `atMs`, with head office's banked counts now (never lower than the fold used). */
  finish(atMs: number, banked: ReadonlyMap<string, number>): UnreceivedCandidate[] {
    const cutoff = atMs - UNRECEIVED_GRACE_MINUTES * 60_000;
    const slack = this.slack;
    const out: UnreceivedCandidate[] = [];
    for (const v of this.keys.values()) {
      const { queue, x } = v.latest;
      const r = { queue };
      const top = banked.get(v.prefix) ?? 0;
      const standsIn = v.wholeQueueSince !== undefined && atMs < v.wholeQueueSinceMs + this.lineMs;
      const all: number[] = [];
      const reclaimed = new Map<number, 'list' | 'queue'>();
      const notes = new Map<number, Noted>();
      // OB-102: each number from the track a fold of everything at today's banked count reads it from.
      for (const [n, e] of v.risk.numbers) if (n <= top) notes.set(n, e);
      for (const [n, e] of v.above.numbers) if (n > top) notes.set(n, e);
      for (const [n, e] of notes) {
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
      const since = numbers.map((n) => notes.get(n)!.notedAt).sort()[0]!;
      const back = numbers.filter((n) => reclaimed.has(n));
      const sparse = sparseHolding(x, slack);
      out.push({
        storeId: v.storeId, prefix: v.prefix, numbers, since, capped: all.length > numbers.length,
        ...(sparse === undefined ? {} : { sparse }),
        ...(v.wholeQueueSince === undefined ? {} : { wholeQueue: { items: queue.unsent, since: v.wholeQueueSince } }),
        ...(back.length === 0 ? {} : {
          reclaimed: {
            numbers: back, saidGoneAt: new Date(Math.min(...back.map((n) => notes.get(n)!.gone))).toISOString(),
            byList: back.some((n) => reclaimed.get(n) === 'list'),
          },
        }),
      });
    }
    return out;
  }

  /** Round 27 · OB-100: per store, the numbers its store computer said it gave and never used, per till prefix and day. */
  unusedByStore(): Map<string, UnusedNumbers[]> {
    const out = new Map<string, UnusedNumbers[]>();
    for (const v of this.keys.values()) {
      const runs = v.unused;
      if (runs.length === 0) continue;
      const list = out.get(v.storeId) ?? [];
      list.push({ prefix: v.prefix, runs: runs.map((u) => ({ from: u.lo, to: u.hi, day: u.day, lastSaidAt: new Date(u.lastMs).toISOString() })) });
      out.set(v.storeId, list);
    }
    for (const list of out.values()) list.sort((a, b) => a.prefix.localeCompare(b.prefix));
    return out;
  }

  encode(meta: { settledAt: string; settledCount: number; judgedAway: string }): NeverReceivedSnapshot {
    return {
      version: FOLD_SNAPSHOT_VERSION, ...meta, lineMs: this.lineMs, slack: { numbers: this.slack.numbers, percent: this.slack.percent }, timeZone: this.timeZone, lastMs: fin(this.lastMs),
      actsApplied: [...this.actsApplied], bound: [...this.bound.values()],
      keys: [...this.keys.values()].map((v) => ({
        storeId: v.storeId, prefix: v.prefix, latest: v.latest, wqs: v.wholeQueueSince ?? null, wqsMs: fin(v.wholeQueueSinceMs),
        said: v.said === undefined ? null : { queue: v.said.r.queue, x: v.said.x, contradicted: v.said.contradicted }, saidNoted: fin(v.saidNoted),
        // The counts at or below the banked count the fold used are never read from the "above" track again (banked only rises).
        above: encodeTrack(v.above, v.aboveFrom), aboveFrom: v.aboveFrom, risk: encodeTrack(v.risk, -Infinity),
        unused: v.unused.map((u) => [u.lo, u.hi, u.day, u.lastMs] as const), unusedList: v.unusedList ?? null, unusedListMs: fin(v.unusedListMs),
        unusedSwept: fin(v.unusedSwept),
      })),
    };
  }

  static decode(s: NeverReceivedSnapshot): NeverReceivedFold {
    const f = new NeverReceivedFold(s.lineMs, s.slack, s.timeZone, true);
    f.lastMs = s.lastMs ?? -Infinity;
    f.actsApplied = [...s.actsApplied];
    for (const b of s.bound) f.bound.set(bindingKey(b.storeId, b.prefix), b);
    for (const k of s.keys) {
      f.keys.set(`${k.storeId}\u0000${k.prefix}`, {
        storeId: k.storeId, prefix: k.prefix, latest: k.latest, wholeQueueSince: k.wqs ?? undefined, wholeQueueSinceMs: k.wqsMs ?? NaN,
        said: k.said === null ? undefined : { r: { queue: k.said.queue }, x: k.said.x, contradicted: k.said.contradicted }, saidNoted: k.saidNoted ?? Infinity,
        above: decodeTrack(k.above), aboveFrom: k.aboveFrom, risk: decodeTrack(k.risk),
        unused: k.unused.map(([lo, hi, day, lastMs]) => ({ lo, hi, day, lastMs })), unusedList: k.unusedList ?? undefined, unusedListMs: k.unusedListMs ?? -Infinity,
        unusedSwept: k.unusedSwept ?? -Infinity,
      });
    }
    return f;
  }
}

/** Round 29 · verifier r28 NEW-6: the latest time a number was said unused is kept to the MINUTE, rounded down (see `noteUnused`). */
export const UNUSED_SAID_STEP = 60_000;
/** Round 29 · OB-105: a run of unused numbers not said again for this many days is forgotten (see `noteUnused`). */
export const UNUSED_FORGET_DAYS = 30;

/** Two lists of [from, to] ranges say the same. */
function sameRanges(m: readonly (readonly [number, number])[], n: readonly (readonly [number, number])[]): boolean {
  if (m === n) return true;
  if (m.length !== n.length) return false;
  for (let i = 0; i < m.length; i += 1) if (m[i]![0] !== n[i]![0] || m[i]![1] !== n[i]![1]) return false;
  return true;
}

/**
 * Round 27 · OB-100: lay a list of counts said unused (at `ms`, first said on `day`) over the kept runs: a count kept already
 * keeps its day and takes the later time; a new count takes `day` and `ms`. Runs that touch with the same day and time join.
 */
export function layUnused(kept: readonly UnusedRun[], list: readonly (readonly [number, number])[], day: string, ms: number): UnusedRun[] {
  const out: UnusedRun[] = [];
  const push = (v: UnusedRun): void => {
    const p = out[out.length - 1];
    if (p !== undefined && p.hi + 1 === v.lo && p.day === v.day && p.lastMs === v.lastMs) p.hi = v.hi; else out.push({ lo: v.lo, hi: v.hi, day: v.day, lastMs: v.lastMs });
  };
  let i = 0;
  // The kept run being read, possibly cut short at its front by the list.
  let k: UnusedRun | undefined = kept[0];
  const next = (): void => { i += 1; k = kept[i]; };
  for (const [a, z] of joinRuns(list)) {
    while (k !== undefined && k.hi < a) { push(k); next(); }
    let p = a;
    while (p <= z) {
      if (k !== undefined && k.lo <= p) {
        if (k.lo < p) push({ ...k, hi: p - 1 });
        const end = Math.min(k.hi, z);
        push({ lo: p, hi: end, day: k.day, lastMs: Math.max(k.lastMs, ms) });
        if (k.hi > z) k = { ...k, lo: z + 1 }; else next();
        p = end + 1;
      } else {
        const end = k === undefined ? z : Math.min(z, k.lo - 1);
        push({ lo: p, hi: end, day, lastMs: ms });
        p = end + 1;
      }
    }
  }
  while (k !== undefined) { push(k); next(); }
  return out;
}

/** OB-102: the counts one report is checked over ABOVE `banked` — the newest UNRECEIVED_CHECK_CAP sold, and its at-risk ones. */
function examinedAbove(banked: number, sold: number, risky: readonly (readonly [number, number])[]): readonly (readonly [number, number])[] {
  const from = Math.max(banked + 1, sold - UNRECEIVED_CHECK_CAP + 1);
  const list: [number, number][] = from <= sold ? [[from, sold]] : [];
  for (const [a, z] of risky) if (z > banked) list.push([Math.max(a, banked + 1), z]);
  return list.length <= 1 ? list : joinRuns(list);
}
/** OB-102: the part of rising, apart ranges at or below `top`. */
function clipAtOrBelow(ranges: readonly (readonly [number, number])[], top: number): readonly (readonly [number, number])[] {
  if (ranges.length === 0 || ranges[ranges.length - 1]![1] <= top) return ranges;
  const out: [number, number][] = [];
  for (const [a, z] of ranges) { if (a > top) break; out.push([a, Math.min(z, top)]); }
  return out;
}

/** Round 27 · OB-100: the counts one store computer said it gave and never used under one prefix, by the day it first said so. */
export interface UnusedNumbers {
  readonly prefix: string;
  readonly runs: readonly { readonly from: number; readonly to: number; readonly day: string; readonly lastSaidAt: string }[];
}

/**
 * Round 27 · OB-102: the never-received fold, resumed from a saved running result when one is given and still stands
 * (see FOLD_SETTLE_MINUTES above), and a new one to save when `settleBefore` is given and enough has settled since. Also
 * gives (OB-100) every number each store computer said it gave and never used, and the bindings as they stand at `at`.
 */
export function readNeverReceived(input: {
  readonly records: readonly BoxHealthRecord[];
  readonly at: string;
  readonly banked: ReadonlyMap<string, number>;
  readonly warnHours?: number;
  readonly slack?: ClaimSlack;
  readonly replacements?: readonly StoreComputerReplacement[];
  readonly timeZone?: string;
  /** A saved running result (from an earlier read). Used only when it still stands; otherwise the fold starts from nothing. */
  readonly snapshot?: NeverReceivedSnapshot;
  /** Save a new running result of the reports received at or before this moment (and never after `at`). */
  readonly settleBefore?: string;
  /** The reports' prefixes head office dropped when it judged them at read (a change sets a saved result aside). */
  readonly judgedAway?: readonly JudgedAway[];
}): { candidates: UnreceivedCandidate[]; unused: Map<string, UnusedNumbers[]>; bindings: PrefixBinding[]; snapshot?: NeverReceivedSnapshot; resumed: boolean } {
  const atMs = Date.parse(input.at);
  const lineMs = (input.warnHours ?? DEFAULT_BOX_UNSENT_WARN_HOURS) * 3_600_000;
  const slack = input.slack ?? DEFAULT_CLAIM_SLACK;
  const timeZone = input.timeZone ?? DEFAULT_STORE_TIME_ZONE;
  const acts = sortedActs(atOrBefore(input.replacements, atMs));
  const all = input.records.map((r, i) => ({ r, i, ms: Date.parse(r.receivedAt) })).filter((e) => e.ms <= atMs);
  const saving = input.settleBefore !== undefined;
  let fold: NeverReceivedFold | undefined;
  let tail = all;
  let base: { settledMs: number; settledCount: number } | undefined;
  const s = input.snapshot;
  if (s !== undefined && s.version === FOLD_SNAPSHOT_VERSION && s.lineMs === lineMs && s.slack.numbers === slack.numbers && s.slack.percent === slack.percent && s.timeZone === timeZone) {
    const settledMs = Date.parse(s.settledAt);
    const lastMs = s.lastMs ?? -Infinity;
    let settledCount = 0;
    for (const e of all) if (e.ms <= settledMs) settledCount += 1;
    // The same acts up to its last report, in the same order — and no act it has not applied dated at or before that report.
    const actsThen = acts.filter((a) => a.ms <= lastMs).map((a) => a.m.replacementId);
    const stands = settledMs <= atMs && settledCount === s.settledCount && actsThen.length === s.actsApplied.length && actsThen.every((id, k) => id === s.actsApplied[k])
      && judgedAwayUpTo(input.judgedAway, settledMs) === s.judgedAway
      && s.keys.every((k) => (input.banked.get(k.prefix) ?? 0) >= k.aboveFrom);
    if (stands) {
      fold = NeverReceivedFold.decode(s);
      tail = all.filter((e) => e.ms > settledMs);
      base = { settledMs, settledCount: s.settledCount };
    }
  }
  const resumed = fold !== undefined;
  fold ??= new NeverReceivedFold(lineMs, slack, timeZone, saving);
  tail.sort((a, b) => a.ms - b.ms || a.i - b.i);
  const bankedOf = (prefix: string): number => input.banked.get(prefix) ?? 0;
  let snapshot: NeverReceivedSnapshot | undefined;
  let k = 0;
  if (saving && fold.riskFull) {
    const settleMs = Math.min(atMs, Date.parse(input.settleBefore!));
    for (; k < tail.length && tail[k]!.ms <= settleMs; k += 1) fold.feed(tail[k]!.r, tail[k]!.ms, acts, bankedOf);
    if (k > 0 && (base === undefined || k >= FOLD_SNAPSHOT_EVERY)) {
      snapshot = fold.encode({ settledAt: new Date(settleMs).toISOString(), settledCount: (base?.settledCount ?? 0) + k, judgedAway: judgedAwayUpTo(input.judgedAway, settleMs) });
    }
  }
  for (; k < tail.length; k += 1) fold.feed(tail[k]!.r, tail[k]!.ms, acts, bankedOf);
  const candidates = fold.finish(atMs, input.banked);
  // The bindings as they stand at `at`: every act done by then applies, whether or not a report came after it.
  fold.applyActsUntil(acts, atMs);
  const bindings = [...fold.bound.values()].sort((a, b) => a.storeId.localeCompare(b.storeId) || a.prefix.localeCompare(b.prefix));
  return { candidates, unused: fold.unusedByStore(), bindings, ...(snapshot === undefined ? {} : { snapshot }), resumed };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Round 28 · OB-104 "A" (owner, 13 Oct 2026, in writing, "Before the pilot") — THE BOUNDED READ (stated, so a person can
// check it). Before this round every health read and every alert pass (each minute) read EVERY store-computer report ever
// kept (`allOf` over the box-health stream) and worked out from all of them: the never-received fold (saved since round
// 27), the refused-report timeline, the at-risk acknowledgements, the waiting clock, the store's latest report per store
// computer, its disk's growth, and the bindings. Now ONE saved running result keeps every one of those answers' working
// state as it stood after the reports received up to a moment (`settledAt`, FOLD_SETTLE_MINUTES before a read), and a read
// loads it and reads ONLY the reports at the store's positions after it (`sinceSeq`, an index range scan on PostgreSQL):
//   • THE WINDOW is not a fixed number of days. It is "every report after the saved result's position" — normally the last
//     FOLD_SETTLE_MINUTES plus up to FOLD_SNAPSHOT_EVERY reports. A fixed window (say 7 days) could not keep every answer
//     identical: a refusal from a month ago, a binding made on the first day, the first sight of a waiting bill, and a
//     store computer silent for a fortnight all reach back further than any fixed window. So everything older is CARRIED
//     in the saved result instead, kept exact:
//       – bindings (judged and as kept), the acts applied, and the never-received fold (round 27, unchanged);
//       – per store: its latest report as bound; per prefix: its latest word (bound, and believed), the at-risk and the
//         refused-report acknowledgement folds (`standing`), and the refused reports not yet answered per (count, store
//         computer) — the first and the latest, which is all the finding says (see `RfGroup`);
//       – per prefix, the waiting clock: the spans head office was told were waiting, keeping only a span that adds a number
//         no earlier span had (the FIRST span reaching any numbers is always one of those), and the "no list" run;
//       – per store computer, its latest report (kept exactly as `latestBoxReports` picks it, ties included) and its disk's
//         points over the 7 days its estimate reads (DISK_ESTIMATE_LOOKBACK_HOURS) — no older one can be read again.
//   • THE RESULT IS USED ONLY WHEN everything it was made from still stands: the same settings, every report at or below its
//     position (a settled visibility fence when it was made — a report committed late below it is impossible) and exactly
//     the reports above its position it folded (a report that arrived late sets it aside), the same "store computer
//     replaced" acts and acknowledgements up to its moment, the same verdicts on each report's prefixes (`judgeReportedIssued`),
//     and no banked count lower than it used. Otherwise it is SET ASIDE and the read folds every report, once, as before.
//   • Proved equal to the full reading on seeded random histories, on memory and on PostgreSQL, set-aside cases included
//     (tests/unit/the-box-history-is-its-full-reading, tests/integration/the-box-history-on-postgresql).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Round 28 · OB-104: what `judgeBoxes` reads of the reports, from the saved running result (`readBoxHistory(...).view`). */
export interface BoxReportsView {
  /** Head office holds at least one report. */
  readonly any: boolean;
  /** Every store with a report. */
  readonly storeIds: readonly string[];
  /** The store's latest report (by the box's own time, then by arrival — `latestBoxReports`) among the computers `bound` names. */
  latestOf(storeId: string, bound: (computer: string) => boolean): BoxHealthRecord | undefined;
  /** For each store computer NOT bound, its latest report received by `at`. */
  othersOf(storeId: string, bound: (computer: string) => boolean): BoxHealthRecord[];
  /** Round 29 · OB-107: for EACH bound store computer, its own latest report (as `latestOf` picks one), by computer. */
  latestEach(storeId: string, bound: (computer: string) => boolean): BoxHealthRecord[];
  /** The hours of trading left, from that store computer's own reports (`estimateTradingHoursLeft`). */
  estimate(latest: BoxHealthRecord): TradingHoursEstimate;
  /** The waiting clock's facts for the store (`waitingFacts`). */
  waiting(storeId: string): readonly WaitingFacts[];
}

/** One report as the box history is fed it: as kept, as judged at read (`judgeReportedIssued`), and its store position. */
export interface BoxHistoryEntry { readonly raw: BoxHealthRecord; readonly judged: BoxHealthRecord; readonly seq: number }

/** The history's working state version (bump it when its shape or a rule changes: an older one is simply set aside). */
const BOX_HISTORY_VERSION = 2; // round 29: the waiting clock's and the unused runs' memory, refused groups banked away, a seal

/** `latestBoxReports` kept exactly: at the latest box time seen, per way of writing it, the first position and the latest arrival. */
interface WinGroup { firstSeq: number; r: BoxHealthRecord; recvMs: number; seq: number }
interface Win { ms: number; groups: Map<string, WinGroup> }
const newWin = (): Win => ({ ms: -Infinity, groups: new Map() });
function winFeed(w: Win, r: BoxHealthRecord, o: number, recvMs: number, seq: number): void {
  if (!(o >= w.ms)) return;
  if (o > w.ms) { w.ms = o; w.groups = new Map(); }
  const g = w.groups.get(r.observedAt);
  if (g === undefined) { w.groups.set(r.observedAt, { firstSeq: seq, r, recvMs, seq }); return; }
  if (seq < g.firstSeq) g.firstSeq = seq;
  if (recvMs > g.recvMs || (recvMs === g.recvMs && seq > g.seq)) { g.r = r; g.recvMs = recvMs; g.seq = seq; }
}
/**
 * The report `latestBoxReports` picks over the reports these summaries were made from, read in store order: the first report
 * at the latest box time stands until one written the SAME way arrives no earlier — so the answer is, among the reports at
 * the latest time written the way the first of them was, the latest to arrive (the later position on a tie).
 */
function winPick(wins: readonly Win[]): BoxHealthRecord | undefined {
  let ms = -Infinity;
  for (const w of wins) if (w.ms > ms) ms = w.ms;
  if (ms === -Infinity) return undefined;
  const merged = new Map<string, WinGroup>();
  for (const w of wins) {
    if (w.ms !== ms) continue;
    for (const [text, g] of w.groups) {
      const m = merged.get(text);
      if (m === undefined) { merged.set(text, { ...g }); continue; }
      if (g.firstSeq < m.firstSeq) m.firstSeq = g.firstSeq;
      if (g.recvMs > m.recvMs || (g.recvMs === m.recvMs && g.seq > m.seq)) { m.r = g.r; m.recvMs = g.recvMs; m.seq = g.seq; }
    }
  }
  let first: WinGroup | undefined;
  for (const g of merged.values()) if (first === undefined || g.firstSeq < first.firstSeq) first = g;
  return first?.r;
}

/** One report's disk point, kept for the estimate (its box time, arrival, store position, sales log, and its time as written). */
interface DiskEntry { readonly o: number; readonly v: number; readonly seq: number; readonly used: number; readonly observedAt: string }
interface CompHist { all: Win; atOrBefore: Win; disk: DiskEntry[] }

/** A refused report not answered by a standing acknowledgement (when, its fold position, and its words). */
interface RfEntry { readonly at: string; readonly ms: number; readonly ord: number; readonly through: number; readonly refused: RefusedIssued; readonly by: string }
/**
 * The refused reports of one count from one kind of word (`by`: the second store computer, for a binding refusal — the act
 * moving the prefix to it answers its reports; none: banking answers them). What decides whether one is answered at read
 * is a moment: an acknowledgement of the count (it answers every report of it up to then), the act (the same), or banking
 * (all or none). The saved part keeps only the first and the latest not answered by the acknowledgements and acts up to
 * the saved moment; a later acknowledgement or act is later than every one of them, so it answers all of them or none —
 * the saved part stands whole or goes whole. Reports folded since are kept one by one until the next save.
 */
interface RfGroup { readonly through: number; readonly by: string | undefined; saved: { first: RfEntry; latest: RfEntry } | undefined; live: RfEntry[] }
interface PrefixHist {
  /** The latest bound report naming the prefix: its (first) entry for it. */
  firstX: IssuedReport | undefined;
  /** The latest believed word (its last entry for the prefix) and when that report came. */
  believed: { x: IssuedReport; receivedAt: string } | undefined;
  ar: { standing: string | undefined; last: string | undefined; lastMs: number; k: number | undefined };
  rf: { standing: number | undefined; last: number | undefined; lastMs: number; k: number | undefined; groups: Map<string, RfGroup> };
}
interface WaitHist {
  last: { x: IssuedReport; receivedAt: string; queueUnsent: number } | undefined;
  /** Round 29 · OB-105: the waiting spans kept (`WaitClock`: each added a number no kept span had; forgotten after a day unsaid). */
  clock: WaitClock;
  /** The start of the unbroken run of reports naming no list while the queue held something (`wholeQueueRunSince`). */
  wq: string | undefined;
}
interface StoreHist { latest: BoxHealthRecord | undefined; prefixes: Map<string, PrefixHist>; waits: Map<string, WaitHist>; computers: Map<string, CompHist> }

/** Is every number in [from, to] in the joined runs? */
function coveredBy(runs: readonly (readonly [number, number])[], from: number, to: number): boolean {
  let lo = 0; let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, z] = runs[mid]!;
    if (from < a) hi = mid - 1; else if (from > z) lo = mid + 1; else return to <= z;
  }
  return false;
}
/** Add [from, to] to the joined runs (in place, kept joined and in order). */
function addRun(runs: [number, number][], from: number, to: number): void {
  let i = 0;
  while (i < runs.length && runs[i]![1] < from - 1) i += 1;
  let a = from; let z = to; let j = i;
  while (j < runs.length && runs[j]![0] <= to + 1) { a = Math.min(a, runs[j]![0]); z = Math.max(z, runs[j]![1]); j += 1; }
  runs.splice(i, j - i, [a, z]);
}

/** How many of these (sorted) moments are before `ms`. */
function countBefore(list: readonly { readonly ms: number }[], ms: number): number {
  let k = 0;
  while (k < list.length && list[k]!.ms < ms) k += 1;
  return k;
}

/** The acknowledgements and acts a fold reads, sorted once per read. */
interface HistoryContext {
  refusalAcks(storeId: string, prefix: string): readonly { readonly ms: number; readonly through: number }[];
  atRiskAcks(storeId: string, prefix: string): readonly { readonly ms: number; readonly key: string }[];
}
function historyContext(refusals: readonly RefusalAcknowledgement[], atRisk: readonly AtRiskAcknowledgement[]): HistoryContext {
  const rf = new Map<string, { ms: number; through: number }[]>();
  // As `refusedOpenFromRecords`: only all-stores acknowledgements, by their time (a stable sort keeps the kept order on a tie).
  for (const a of refusals.filter((x) => x.authority === 'all_stores').map((x, i) => ({ x, i, ms: Date.parse(x.at) })).sort((p, q) => p.ms - q.ms || p.i - q.i)) {
    const key = bindingKey(a.x.storeId, a.x.prefix);
    const list = rf.get(key) ?? [];
    list.push({ ms: a.ms, through: a.x.through });
    rf.set(key, list);
  }
  const ar = new Map<string, { ms: number; key: string }[]>();
  for (const a of atRisk.filter((x) => x.authority === 'all_stores').map((x, i) => ({ x, i, ms: Date.parse(x.at) })).sort((p, q) => p.ms - q.ms || p.i - q.i)) {
    const key = bindingKey(a.x.storeId, a.x.prefix);
    const list = ar.get(key) ?? [];
    list.push({ ms: a.ms, key: runsKey(a.x.notChecked) });
    ar.set(key, list);
  }
  return { refusalAcks: (s, p) => rf.get(bindingKey(s, p)) ?? [], atRiskAcks: (s, p) => ar.get(bindingKey(s, p)) ?? [] };
}

/** Round 28 · OB-104: the box history's saved running result — plain data (kept as JSON on PostgreSQL). */
export interface BoxHistorySnapshot {
  readonly version: number;
  /** The never-received fold's saved part (round 27); its `settledAt` is this result's moment. */
  readonly never: NeverReceivedSnapshot;
  /** Every report at or below this store position is folded in. */
  readonly seq: number;
  /** The reports above `seq` that are folded in (they arrived by `settledAt`): exactly these, or the result is set aside. */
  readonly folded: readonly number[];
  readonly ord: number;
  /** The acknowledgements and acts up to `settledAt`, fingerprinted. */
  readonly acksPrint: string;
  /**
   * Each (store, prefix) a folded report named: whether it was this store's own when judged, and the highest count believed
   * (it must still be believed); and per prefix the LOWEST count judged too far ahead (it, and so every higher one, must still be).
   */
  readonly verdicts: { readonly own: readonly (readonly [string, string, boolean, number])[]; readonly ahead: readonly (readonly [string, number])[] };
  readonly rawBound: readonly PrefixBinding[];
  readonly stores: readonly unknown[];
  /**
   * Round 29 · OB-105: per prefix, the banked count refused-report groups were dropped at (a group whose count head office has
   * banked is answered for good — banked only rises); a read with a LOWER banked count sets the result aside ('banked').
   */
  readonly rfBanked: readonly (readonly [string, number])[];
  /** Round 29 · OB-106: the seal — a SHA-256 over the JSON of everything above, as written (any change sets the result aside). */
  readonly check: string;
  /** Round 29 · OB-105: the size of that JSON, in bytes (shown on the health read; an alarm above a line). */
  readonly sizeBytes: number;
}

/** Round 29 · OB-105/106: what the health read shows about the saved history itself (its size, saving held back, a failed build). */
export interface BoxHistoryState {
  readonly sizeBytes: number | null;
  readonly saveHeld: { readonly since: string; readonly waitingSeconds: number } | null;
  readonly lastBuildFailed: { readonly at: string; readonly error: string } | null;
}
/** Round 29 · OB-105: above this, the saved history's size is an alarm on the health read (an honest busy store stays under 2 MB). */
export const BOX_HISTORY_SIZE_WARN_BYTES = 4 * 1_048_576;
/** Round 29 · OB-106 (verifier r28 NEW-8): saving held back by an open database transaction this long is shown. */
export const BOX_HISTORY_SAVE_HELD_WARN_SECONDS = 300;

/**
 * Round 29 · OB-105/106 (P-08): the store computers' saved history on the health read — always shown with its size (`ok`), an
 * alarm (`degraded`) above BOX_HISTORY_SIZE_WARN_BYTES; `degraded` when saving has been held back by an open transaction
 * for BOX_HISTORY_SAVE_HELD_WARN_SECONDS, or the last build failed; `unknown` while it is being prepared (the store computer
 * checks are then not available — said, never silent).
 */
export function boxHistoryComponents(input: { readonly preparing?: { readonly since: string; readonly why: string }; readonly history?: BoxHistoryState }): ComponentHealth[] {
  const out: ComponentHealth[] = [];
  const h = input.history;
  if (input.preparing !== undefined) {
    out.push({
      name: 'box_history', status: 'unknown',
      detail: `being prepared — store computer checks not yet available: head office is building the store computers' saved history (since ${input.preparing.since}, because ${input.preparing.why}). Until it is ready, the store computers' disks, queues, tills and bill numbers are NOT judged here — not known, never "all fine". It is built in the background; the tills keep selling and nothing is lost. If this lasts more than an hour, call support`,
      evidence: { preparingSince: input.preparing.since, why: input.preparing.why },
    });
  } else if (h !== undefined && h.sizeBytes !== null) {
    const kb = Math.ceil(h.sizeBytes / 1024);
    const over = h.sizeBytes > BOX_HISTORY_SIZE_WARN_BYTES;
    out.push({
      name: 'box_history', status: over ? 'degraded' : 'ok',
      detail: over
        ? `the store computers' saved history is ${kb} KB — above the ${BOX_HISTORY_SIZE_WARN_BYTES / 1_048_576} MB line (an honest busy store stays well under 2 MB). Something is making it grow — a store computer sending many refused counts or long lists, say. Head office still answers correctly, but each health check gets slower: call support to find which store computer`
        : `the store computers' saved history is ${kb} KB (the alarm is above ${BOX_HISTORY_SIZE_WARN_BYTES / 1_048_576} MB)`,
      evidence: { sizeBytes: h.sizeBytes, warnAboveBytes: BOX_HISTORY_SIZE_WARN_BYTES },
    });
  }
  if (h?.saveHeld !== null && h?.saveHeld !== undefined && h.saveHeld.waitingSeconds >= BOX_HISTORY_SAVE_HELD_WARN_SECONDS) {
    out.push({
      name: 'box_history_saving', status: 'degraded',
      detail: `the store computers' saved history has not been saved since ${h.saveHeld.since} (${Math.floor(h.saveHeld.waitingSeconds / 60)} min): an open database transaction holds it back, so head office keeps it in memory and each health check re-reads every store-computer report since it — still correct, but slower. Ask the database administrator to find it — a session "idle in transaction" or a prepared transaction anywhere on the database server (pg_stat_activity, pg_prepared_xacts) — and end it`,
      evidence: { heldSince: h.saveHeld.since, waitingSeconds: h.saveHeld.waitingSeconds, warnAfterSeconds: BOX_HISTORY_SAVE_HELD_WARN_SECONDS },
    });
  }
  if (h?.lastBuildFailed !== null && h?.lastBuildFailed !== undefined) {
    out.push({
      name: 'box_history_build', status: 'degraded',
      detail: `building the store computers' saved history failed at ${h.lastBuildFailed.at} (${h.lastBuildFailed.error}); the next health check tries again. If this stays, call support`,
      evidence: { failedAt: h.lastBuildFailed.at, error: h.lastBuildFailed.error },
    });
  }
  return out;
}

/** Round 29 · OB-105/106: seal a saved running result (its SHA-256 and its size, over the JSON of the rest as written). */
export function sealBoxHistory(s: Omit<BoxHistorySnapshot, 'check' | 'sizeBytes'>): BoxHistorySnapshot {
  const { check: _c, sizeBytes: _z, ...rest } = s as BoxHistorySnapshot;
  void _c; void _z;
  const text = JSON.stringify(rest);
  return { ...rest, check: createHash('sha256').update(text).digest('hex'), sizeBytes: Buffer.byteLength(text) };
}

/**
 * Round 29 · OB-106: how a saved result is KEPT — as its JSON text inside the snapshot row (`{ format, text }`), never as a
 * JSON tree: PostgreSQL's jsonb keeps a string exactly but reorders an object's keys, and the seal is over the text as written.
 * Reading it back costs one SHA-256 and one JSON.parse (a few milliseconds for a megabyte); anything else kept there is
 * unreadable.
 */
export const BOX_HISTORY_STORED_FORMAT = 'box-history-text@1';
export function boxHistoryToStore(s: BoxHistorySnapshot): { readonly format: string; readonly text: string } {
  return { format: BOX_HISTORY_STORED_FORMAT, text: JSON.stringify(s) };
}
export function boxHistoryFromStore(stored: unknown): unknown {
  if (!isObj(stored) || stored['format'] !== BOX_HISTORY_STORED_FORMAT || typeof stored['text'] !== 'string') return { notStored: 'it is not in the saved form (box-history-text@1)' };
  try { return JSON.parse(stored['text']) as unknown; } catch { return { notStored: 'its text is not JSON' }; }
}

/**
 * Round 29 · OB-106 "A" (owner, 14 Oct 2026, in writing, "Both before pilot"; verifier r28 NEW-2, probe C1) — A SAVED RESULT IS
 * CHECKED BEFORE IT IS USED (stated). Every field is checked for its shape (a missing part, a wrong type, garbage), then its
 * seal is worked out again and compared: a result that cannot be read, or whose content does not match its seal (damaged,
 * or altered — a binding moved to another computer, say), is SET ASIDE ('unreadable: …') and built again from the reports,
 * never thrown and never trusted. Answers why, or undefined when it may be used.
 */
export function boxHistoryUnreadable(s: unknown): string | undefined {
  try {
    if (isObj(s) && typeof s['notStored'] === 'string') return s['notStored'];
    const why = shapeOfBoxHistory(s);
    if (why !== undefined) return why;
    const { check, sizeBytes, ...rest } = s as BoxHistorySnapshot;
    const text = JSON.stringify(rest);
    if (createHash('sha256').update(text).digest('hex') !== check) return 'its seal does not match its content (damaged or altered)';
    if (Buffer.byteLength(text) !== sizeBytes) return 'its size does not match its content';
    return undefined;
  } catch (e) {
    return `it could not be read (${e instanceof Error ? e.message : String(e)})`;
  }
}

type Check = (v: unknown) => boolean;
const vNum: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const vInt: Check = (v) => typeof v === 'number' && Number.isSafeInteger(v);
const vStr: Check = (v) => typeof v === 'string';
const vBool: Check = (v) => typeof v === 'boolean';
const vTime: Check = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const vNull = (c: Check): Check => (v) => v === null || c(v);
const vArr = (c: Check): Check => (v) => Array.isArray(v) && v.every(c);
const vTuple = (...cs: Check[]): Check => (v) => Array.isArray(v) && v.length === cs.length && cs.every((c, i) => c(v[i]));
const vObj = (fields: Readonly<Record<string, Check>>): Check => (v) => isObj(v) && Object.entries(fields).every(([k, c]) => c(v[k]));
const vRanges = vArr(vTuple(vInt, vInt));
const vQueue = vObj({ unsent: vNum, deadLettered: vNum });
const vIssued: Check = (v) => isObj(v) && vStr(v['prefix']) && vInt(v['through']);
const vRecord: Check = (v) => isObj(v) && vStr(v['storeId']) && vStr(v['reportedBy']) && vTime(v['observedAt']) && vTime(v['receivedAt'])
  && vObj({ freeBytes: vNum, totalBytes: vNum, salesLogUsedBytes: vNum, salesLogCapacityBytes: vNum, reserveBytes: vNum })(v['disk'])
  && vQueue(v['queue']) && Array.isArray(v['tills']);
const vBinding = vObj({ storeId: vStr, prefix: vStr, computer: vStr, since: vTime, via: (v) => v === 'first_report' || v === 'replacement' });
const vTrack = vObj({ n: vArr(vTuple(vInt, vNum, vStr, vNull(vNum))), s: vArr(vTuple(vInt, vInt, vNull(vNum))), o: vArr(vTuple(vInt, vInt, vNull(vNum))) });
const vKey = vObj({
  storeId: vStr, prefix: vStr, latest: vObj({ queue: vQueue, x: vIssued }), wqs: vNull(vStr), wqsMs: vNull(vNum),
  said: vNull(vObj({ queue: vQueue, x: vIssued, contradicted: vBool })), saidNoted: vNull(vNum), above: vTrack, aboveFrom: vInt, risk: vTrack,
  unused: vArr(vTuple(vInt, vInt, vStr, vNum)), unusedList: vNull(vRanges), unusedListMs: vNull(vNum), unusedSwept: vNull(vNum),
});
const vNever = vObj({
  version: vInt, settledAt: vTime, settledCount: vInt, lineMs: vNum, slack: vObj({ numbers: vNum, percent: vNum }), timeZone: vStr, judgedAway: vStr,
  lastMs: vNull(vNum), actsApplied: vArr(vStr), bound: vArr(vBinding), keys: vArr(vKey),
});
const vRf = vTuple(vStr, vNum, vInt, vInt, isObj, vStr);
const vClock: Check = (v) => {
  if (!Array.isArray(v) || (v.length - 1) % 5 !== 0 || !vNull(vNum)(v[0])) return false;
  for (let i = 1; i < v.length; i += 5) if (!(vNum(v[i]) && (v[i + 1] === 0 || vTime(v[i + 1])) && vInt(v[i + 2]) && vInt(v[i + 3]) && vNum(v[i + 4]))) return false;
  return true;
};
const vStore = vTuple(
  vStr, vNull(vRecord),
  vArr(vTuple(vStr, vNull(vIssued), vNull(vObj({ x: vIssued, receivedAt: vTime })), vTuple(vNull(vStr), vNull(vStr), vNull(vNum)), vTuple(vNull(vInt), vNull(vInt), vNull(vNum)), vArr(vTuple(vInt, vNull(vStr), vRf, vRf)))),
  vArr(vTuple(vStr, vNull(vObj({ x: vIssued, receivedAt: vTime, queueUnsent: vNum })), vClock, vNull(vStr))),
  vArr(vTuple(vStr, vNull(vNum), vArr(vTuple(vStr, vInt, vRecord, vNum, vInt)), vArr(vTuple(vNum, vNum, vInt, vNum, (v) => v === 0 || vTime(v))))),
);
function shapeOfBoxHistory(s: unknown): string | undefined {
  if (!isObj(s)) return 'it is not a saved result';
  if (s['version'] !== BOX_HISTORY_VERSION) return `it is of another version (${String(s['version'])})`;
  const parts: readonly [string, Check][] = [
    ['never', vNever], ['seq', vInt], ['folded', vArr(vInt)], ['ord', vInt], ['acksPrint', vStr],
    ['verdicts', vObj({ own: vArr(vTuple(vStr, vStr, vBool, vInt)), ahead: vArr(vTuple(vStr, vInt)) })],
    ['rawBound', vArr(vBinding)], ['stores', vArr(vStore)], ['rfBanked', vArr(vTuple(vStr, vInt))], ['check', vStr], ['sizeBytes', vInt],
  ];
  for (const [name, c] of parts) if (!c(s[name])) return `its part "${name}" is missing or not readable`;
  return undefined;
}

/** The fingerprint of the acknowledgements and acts at or before a moment (any change sets a saved result aside). */
function acksPrintUpTo(input: { readonly refusalAcks?: readonly RefusalAcknowledgement[]; readonly atRiskAcks?: readonly AtRiskAcknowledgement[]; readonly unusedAcks?: readonly unknown[]; readonly replacements?: readonly StoreComputerReplacement[] }, ms: number): string {
  const lines: string[] = [];
  for (const a of input.refusalAcks ?? []) if (Date.parse(a.at) <= ms) lines.push(`r|${a.storeId}|${a.prefix}|${a.through}|${a.at}|${a.authority ?? ''}`);
  for (const a of input.atRiskAcks ?? []) if (Date.parse(a.at) <= ms) lines.push(`n|${a.storeId}|${a.prefix}|${runsKey(a.notChecked)}|${a.at}|${a.authority ?? ''}`);
  for (const m of input.replacements ?? []) if (Date.parse(m.at) <= ms) lines.push(`m|${m.replacementId}|${m.storeId}|${m.prefix}|${m.to}|${m.at}`);
  return fingerprint(lines.sort().join('\n'));
}

/** The whole reading a health read takes from the box history (the never-received fold's, and everything else's). */
export interface BoxHistoryReading {
  readonly candidates: UnreceivedCandidate[];
  readonly unused: Map<string, UnusedNumbers[]>;
  /** The (store, prefix) bindings as the findings are judged (on the reports as judged), at `at`. */
  readonly bindings: PrefixBinding[];
  /** The bindings on the reports as kept (`prefixBindings`), at `at`. */
  readonly rawBindings: PrefixBinding[];
  /** Every store with a report. */
  readonly storeIds: readonly string[];
  /** One store's facts for `billNumberFindingsFor` (judged with the banked counts, acknowledgements and acts given). */
  facts(storeId: string): StoreBillFacts;
  readonly view: BoxReportsView;
  readonly snapshot?: BoxHistorySnapshot;
  readonly resumed: boolean;
  /** How many reports were folded on this read (the window). */
  readonly folded: number;
}

class BoxHistoryFold {
  readonly nr: NeverReceivedFold;
  readonly rawBound = new Map<string, PrefixBinding>();
  readonly stores = new Map<string, StoreHist>();
  ord = 0;
  readonly own = new Map<string, [string, string, boolean, number]>();
  /** Per prefix, the lowest count judged too far ahead (a count is believed up to a bound, so a lower one is believed first). */
  readonly ahead = new Map<string, number>();
  readonly foldedSeqs: number[] = [];

  constructor(nr: NeverReceivedFold, readonly ctx: HistoryContext) {
    this.nr = nr;
    nr.onAct = (m) => applyAct(this.rawBound, m);
  }

  private store(storeId: string): StoreHist {
    let st = this.stores.get(storeId);
    if (st === undefined) { st = { latest: undefined, prefixes: new Map(), waits: new Map(), computers: new Map() }; this.stores.set(storeId, st); }
    return st;
  }
  private prefix(st: StoreHist, prefix: string): PrefixHist {
    let ph = st.prefixes.get(prefix);
    if (ph === undefined) {
      ph = { firstX: undefined, believed: undefined, ar: { standing: undefined, last: undefined, lastMs: -Infinity, k: undefined }, rf: { standing: undefined, last: undefined, lastMs: -Infinity, k: undefined, groups: new Map() } };
      st.prefixes.set(prefix, ph);
    }
    return ph;
  }
  private computer(st: StoreHist, computer: string): CompHist {
    let c = st.computers.get(computer);
    if (c === undefined) { c = { all: newWin(), atOrBefore: newWin(), disk: [] }; st.computers.set(computer, c); }
    return c;
  }

  /** A report received after the read's moment: only the latest-report and disk answers read it (as `judgeBoxes` does). */
  feedLater(raw: BoxHealthRecord, ms: number, seq: number): void {
    const c = this.computer(this.store(raw.storeId), raw.reportedBy);
    winFeed(c.all, raw, Date.parse(raw.observedAt), ms, seq);
    this.disk(c, raw, ms, seq);
  }

  private disk(c: CompHist, raw: BoxHealthRecord, ms: number, seq: number): void {
    const o = Date.parse(raw.observedAt);
    c.disk.push({ o, v: ms, seq, used: raw.disk.salesLogUsedBytes, observedAt: raw.observedAt });
    // Points older than the 7 days before the latest box time can never be read again (that time only rises).
    if (c.disk.length % 4_096 === 0) this.prune(c);
  }
  prune(c: CompHist): void {
    const floor = c.all.ms - DISK_ESTIMATE_LOOKBACK_HOURS * 3_600_000;
    if (c.disk.some((d) => d.o < floor)) c.disk = c.disk.filter((d) => d.o >= floor);
  }

  feed(e: BoxHistoryEntry, ms: number, acts: readonly SortedAct[], bankedOf: (prefix: string) => number, judge: BoxHistoryJudge | undefined, settling: boolean): void {
    const ord = this.ord;
    this.ord += 1;
    if (settling) this.foldedSeqs.push(e.seq);
    // What the result was made from: each prefix's verdict, and the counts judged too far ahead (`judgeReportedIssued`).
    if (settling && judge !== undefined) {
      for (const x of e.raw.receiptNumbersIssued ?? []) {
        const key = bindingKey(e.raw.storeId, x.prefix);
        const owns = judge.owns(e.raw.storeId, x.prefix);
        let v = this.own.get(key);
        if (v === undefined) { v = [e.raw.storeId, x.prefix, owns, 0]; this.own.set(key, v); }
        if (!owns) continue;
        if (judge.plausible(x.prefix, x.through)) v[3] = Math.max(v[3], x.through);
        else this.ahead.set(x.prefix, Math.min(this.ahead.get(x.prefix) ?? Infinity, x.through));
      }
    }
    // The never-received fold (round 27) on the reports as judged — it applies the acts up to this report first.
    const b = this.nr.feed(e.judged, ms, acts, bankedOf);
    const st = this.store(b.storeId);
    // The bill-number facts (on the reports as judged and bound, as `storeBillFacts` reads them).
    st.latest = b;
    const issued = b.receiptNumbersIssued ?? [];
    const firstOf = new Map<string, IssuedReport>();
    for (const x of issued) if (!firstOf.has(x.prefix)) firstOf.set(x.prefix, x);
    for (const [prefix, x] of firstOf) {
      const ph = this.prefix(st, prefix);
      ph.firstX = x;
      // The not-checked acknowledgement fold (`atRiskAcknowledgementStands`).
      const acks = this.ctx.atRiskAcks(b.storeId, prefix);
      const ar = ph.ar;
      let k = ar.k ?? countBefore(acks, ar.lastMs);
      for (; k < acks.length && acks[k]!.ms < ms; k += 1) if (ar.last !== undefined && ar.last !== '' && ar.last === acks[k]!.key) ar.standing = ar.last;
      ar.k = k;
      const key = notCheckedKey(x.atRisk);
      if (ar.standing !== undefined && key !== ar.standing) ar.standing = undefined;
      ar.last = key;
      ar.lastMs = ms;
    }
    const believed = believedRecord(b);
    for (const x of believed.receiptNumbersIssued ?? []) this.prefix(st, x.prefix).believed = { x, receivedAt: b.receivedAt };
    // The refused-report timeline (`refusedOpenFromRecords`): one word per prefix per report, the refused one last.
    const said = new Map<string, { through: number; refused?: RefusedIssued }>();
    for (const x of issued) said.set(x.prefix, { through: x.through });
    for (const x of b.receiptNumbersNotFolded ?? []) said.set(x.prefix, { through: x.through });
    for (const r of b.receiptNumbersRefused ?? []) said.set(r.prefix, { through: r.through, refused: r });
    for (const [prefix, x] of said) {
      const rf = this.prefix(st, prefix).rf;
      const acks = this.ctx.refusalAcks(b.storeId, prefix);
      let k = rf.k ?? countBefore(acks, rf.lastMs);
      for (; k < acks.length && acks[k]!.ms < ms; k += 1) if (rf.last === acks[k]!.through) rf.standing = acks[k]!.through;
      rf.k = k;
      if (rf.standing !== undefined && x.through !== rf.standing) rf.standing = undefined;
      rf.last = x.through;
      rf.lastMs = ms;
      const r = x.refused;
      if (r === undefined || rf.standing === r.through) continue;
      const by = r.because === 'prefix_of_another_store_computer' ? b.reportedBy : undefined;
      const gk = `${r.through}\u0000${by ?? ''}\u0000${by === undefined ? 'p' : 'a'}`;
      let g = rf.groups.get(gk);
      if (g === undefined) { g = { through: r.through, by, saved: undefined, live: [] }; rf.groups.set(gk, g); }
      g.live.push({ at: b.receivedAt, ms, ord, through: r.through, refused: r, by: b.reportedBy });
    }
    // The waiting clock (`waitingFacts`) on the reports as KEPT, bound and believed — as `judgeBoxes` reads them.
    const w = believedRecord(bindRecord(this.rawBound, e.raw));
    const named = new Map<string, IssuedReport>();
    for (const x of w.receiptNumbersIssued ?? []) {
      if (!named.has(x.prefix)) named.set(x.prefix, x);
      let wh = st.waits.get(x.prefix);
      if (wh === undefined) { wh = { last: undefined, clock: new WaitClock(), wq: undefined }; st.waits.set(x.prefix, wh); }
      wh.last = { x, receivedAt: w.receivedAt, queueUnsent: w.queue.unsent };
      wh.clock.tick(ms);
      const u = x.unsent;
      if (names(u)) wh.clock.told(w.receivedAt, ms, u.from, u.to);
    }
    for (const [prefix, y] of named) {
      const wh = st.waits.get(prefix)!;
      if (y.unsent !== undefined || w.queue.unsent === 0) wh.wq = undefined; else wh.wq ??= w.receivedAt;
    }
    // The store computer's latest report and its disk (`judgeBoxes`, on the reports as kept).
    const c = this.computer(this.store(e.raw.storeId), e.raw.reportedBy);
    const o = Date.parse(e.raw.observedAt);
    winFeed(c.all, e.raw, o, ms, e.seq);
    winFeed(c.atOrBefore, e.raw, o, ms, e.seq);
    this.disk(c, e.raw, ms, e.seq);
  }

  /** The refused counts still open for one prefix, at read (banked now, every acknowledgement and act). */
  private refusedOf(storeId: string, prefix: string, ph: PrefixHist, banked: ReadonlyMap<string, number>, refusals: readonly RefusalAcknowledgement[], actTo: ReadonlyMap<string, number>): Map<number, { first: string; latest: RefusedSaid }> {
    const seen = new Map<number, number>();
    for (const a of refusals) if (a.storeId === storeId && a.prefix === prefix && a.authority === 'all_stores') seen.set(a.through, Math.max(seen.get(a.through) ?? 0, Date.parse(a.at)));
    const open = new Map<number, { first: RfEntry; latest: RfEntry }>();
    for (const g of ph.rf.groups.values()) {
      if (g.by === undefined && (banked.get(prefix) ?? 0) >= g.through) continue;
      const t = Math.max(seen.get(g.through) ?? -Infinity, g.by === undefined ? -Infinity : (actTo.get(`${prefix}\u0000${g.by}`) ?? -Infinity));
      let first: RfEntry | undefined;
      let latest: RfEntry | undefined;
      if (g.saved !== undefined && g.saved.first.ms > t) { first = g.saved.first; latest = g.saved.latest; }
      for (const x of g.live) if (x.ms > t) { first ??= x; latest = x; }
      if (first === undefined || latest === undefined) continue;
      const cur = open.get(g.through);
      if (cur === undefined) open.set(g.through, { first, latest });
      else open.set(g.through, { first: first.ord < cur.first.ord ? first : cur.first, latest: latest.ord > cur.latest.ord ? latest : cur.latest });
    }
    return new Map([...open].map(([n, v]) => [n, { first: v.first.at, latest: { at: v.latest.at, through: v.latest.through, refused: v.latest.refused, by: v.latest.by } }] as const));
  }

  facts(storeId: string, banked: ReadonlyMap<string, number>, refusals: readonly RefusalAcknowledgement[], replacements: readonly StoreComputerReplacement[]): StoreBillFacts {
    const st = this.stores.get(storeId);
    const actTo = new Map<string, number>();
    for (const m of replacements) if (m.storeId === storeId) actTo.set(`${m.prefix}\u0000${m.to}`, Math.max(actTo.get(`${m.prefix}\u0000${m.to}`) ?? -Infinity, Date.parse(m.at)));
    const prefixes = [...(st?.prefixes ?? new Map<string, PrefixHist>())].sort((a, b) => a[0].localeCompare(b[0]));
    const refusedOpen: [string, Map<number, { first: string; latest: RefusedSaid }>][] = [];
    for (const [prefix, ph] of prefixes) {
      if (ph.rf.groups.size === 0) continue;
      const open = this.refusedOf(storeId, prefix, ph, banked, refusals, actTo);
      if (open.size > 0) refusedOpen.push([prefix, open]);
    }
    return {
      latestRecord: st?.latest,
      deadLetteredUnsaid: (prefix) => st?.prefixes.get(prefix)?.firstX?.deadLettered === undefined,
      lastByPrefix: prefixes.flatMap(([prefix, ph]) => (ph.believed === undefined ? [] : [[prefix, ph.believed] as const])),
      atRiskStands: (prefix) => {
        const ph = st?.prefixes.get(prefix);
        const acks = this.ctx.atRiskAcks(storeId, prefix);
        if (ph === undefined || acks.length === 0) return false;
        let { standing } = ph.ar;
        const { last } = ph.ar;
        for (let k = ph.ar.k ?? countBefore(acks, ph.ar.lastMs); k < acks.length; k += 1) if (last !== undefined && last !== '' && last === acks[k]!.key) standing = last;
        return standing !== undefined && standing === last;
      },
      refusedOpen,
    };
  }

  waiting(storeId: string): WaitingFacts[] {
    const st = this.stores.get(storeId);
    if (st === undefined) return [];
    return [...st.waits].filter(([, wh]) => wh.last !== undefined).sort((a, b) => a[0].localeCompare(b[0])).map(([prefix, wh]) => ({
      prefix, lastReceivedAt: wh.last!.receivedAt, lastQueueUnsent: wh.last!.queueUnsent, x: wh.last!.x,
      firstWaiting: (from: number, to: number) => wh.clock.first(from, to),
      wholeQueueSince: () => wh.wq ?? wh.last!.receivedAt,
    }));
  }

  view(): BoxReportsView {
    const storeIds = [...this.stores.keys()].sort();
    return {
      any: storeIds.length > 0,
      storeIds,
      latestOf: (storeId, bound) => winPick([...(this.stores.get(storeId)?.computers ?? new Map<string, CompHist>())].filter(([c]) => bound(c)).map(([, c]) => c.all)),
      othersOf: (storeId, bound) => [...(this.stores.get(storeId)?.computers ?? new Map<string, CompHist>())].filter(([c]) => !bound(c))
        .flatMap(([, c]) => { const r = winPick([c.atOrBefore]); return r === undefined ? [] : [r]; }),
      latestEach: (storeId, bound) => [...(this.stores.get(storeId)?.computers ?? new Map<string, CompHist>())].filter(([c]) => bound(c))
        .sort((a, b) => a[0].localeCompare(b[0])).flatMap(([, c]) => { const r = winPick([c.all]); return r === undefined ? [] : [r]; }),
      estimate: (latest) => {
        const c = this.stores.get(latest.storeId)?.computers.get(latest.reportedBy);
        const until = Date.parse(latest.observedAt);
        const since = until - DISK_ESTIMATE_LOOKBACK_HOURS * 3_600_000;
        const points = (c?.disk ?? []).filter((d) => d.o >= since && d.o <= until).sort((a, b) => a.o - b.o || a.v - b.v || a.seq - b.seq);
        return estimateOverPoints(points, latest);
      },
      waiting: (storeId) => this.waiting(storeId),
    };
  }

  /** Plain data for the saved result (the reports folded so far all arrived by `settledMs`). */
  encode(settledMs: number, refusals: readonly RefusalAcknowledgement[], replacements: readonly StoreComputerReplacement[], banked: ReadonlyMap<string, number>, rfBanked: Map<string, number>): unknown[] {
    const out: unknown[] = [];
    const settledActs = replacements.filter((m) => Date.parse(m.at) <= settledMs);
    const settledRefusals = refusals.filter((a) => Date.parse(a.at) <= settledMs);
    for (const [storeId, st] of this.stores) {
      const actTo = new Map<string, number>();
      for (const m of settledActs) if (m.storeId === storeId) actTo.set(`${m.prefix}\u0000${m.to}`, Math.max(actTo.get(`${m.prefix}\u0000${m.to}`) ?? -Infinity, Date.parse(m.at)));
      const prefixes: unknown[] = [];
      for (const [prefix, ph] of st.prefixes) {
        const seen = new Map<number, number>();
        for (const a of settledRefusals) if (a.storeId === storeId && a.prefix === prefix && a.authority === 'all_stores') seen.set(a.through, Math.max(seen.get(a.through) ?? 0, Date.parse(a.at)));
        const groups: unknown[] = [];
        for (const g of ph.rf.groups.values()) {
          // Round 29 · OB-105: a count head office has banked answers its refused reports for good (banked only rises, and a
          // read with a lower banked count sets the result aside) — the group is dropped (`refusedOf` would pass over it).
          const top = banked.get(prefix) ?? 0;
          if (g.by === undefined && top >= g.through) { rfBanked.set(prefix, Math.max(rfBanked.get(prefix) ?? 0, top)); continue; }
          // Only what the acknowledgements and acts up to the saved moment leave open (banking is judged at each read).
          const t = Math.max(seen.get(g.through) ?? -Infinity, g.by === undefined ? -Infinity : (actTo.get(`${prefix}\u0000${g.by}`) ?? -Infinity));
          let first: RfEntry | undefined;
          let latest: RfEntry | undefined;
          if (g.saved !== undefined && g.saved.first.ms > t) { first = g.saved.first; latest = g.saved.latest; }
          for (const x of g.live) if (x.ms > t) { first ??= x; latest = x; }
          if (first === undefined || latest === undefined) continue;
          groups.push([g.through, g.by ?? null, encRf(first), encRf(latest)]);
        }
        prefixes.push([prefix, ph.firstX ?? null, ph.believed ?? null, [ph.ar.standing ?? null, ph.ar.last ?? null, fin(ph.ar.lastMs)], [ph.rf.standing ?? null, ph.rf.last ?? null, fin(ph.rf.lastMs)], groups]);
      }
      const waits = [...st.waits].map(([prefix, wh]) => [prefix, wh.last ?? null, wh.clock.encode(), wh.wq ?? null]);
      const computers = [...st.computers].map(([computer, c]) => {
        this.prune(c);
        // Delta-coded disk points (each column a run of small numbers); a box time is kept as written only when it differs.
        let po = 0; let ps = 0; let pu = 0;
        const d = c.disk.map((p) => { const row = [p.o - po, p.v - p.o, p.seq - ps, p.used - pu, p.observedAt === new Date(p.o).toISOString() ? 0 : p.observedAt]; po = p.o; ps = p.seq; pu = p.used; return row; });
        return [computer, fin(c.all.ms), [...c.all.groups].map(([text, g]) => [text, g.firstSeq, g.r, g.recvMs, g.seq]), d];
      });
      out.push([storeId, st.latest ?? null, prefixes, waits, computers]);
    }
    return out;
  }

  decodeStores(list: readonly unknown[]): void {
    type Enc = [string, BoxHealthRecord | null, unknown[], unknown[], unknown[]];
    for (const raw of list as Enc[]) {
      const [storeId, latest, prefixes, waits, computers] = raw;
      const st = this.store(storeId);
      st.latest = latest ?? undefined;
      for (const p of prefixes as [string, IssuedReport | null, { x: IssuedReport; receivedAt: string } | null, [string | null, string | null, number | null], [number | null, number | null, number | null], [number, string | null, unknown[], unknown[]][]][]) {
        const [prefix, firstX, believed, ar, rf, groups] = p;
        const ph = this.prefix(st, prefix);
        ph.firstX = firstX ?? undefined;
        ph.believed = believed ?? undefined;
        ph.ar = { standing: ar[0] ?? undefined, last: ar[1] ?? undefined, lastMs: ar[2] ?? -Infinity, k: undefined };
        ph.rf = { standing: rf[0] ?? undefined, last: rf[1] ?? undefined, lastMs: rf[2] ?? -Infinity, k: undefined, groups: new Map() };
        for (const [through, by, first, latestRf] of groups) {
          ph.rf.groups.set(`${through}\u0000${by ?? ''}\u0000${by === null ? 'p' : 'a'}`, { through, by: by ?? undefined, saved: { first: decRf(first), latest: decRf(latestRf) }, live: [] });
        }
      }
      for (const w of waits as [string, WaitHist['last'] | null, unknown[], string | null][]) {
        const [prefix, last, clock, wq] = w;
        st.waits.set(prefix, { last: last ?? undefined, clock: WaitClock.decode(clock), wq: wq ?? undefined });
      }
      for (const c of computers as [string, number | null, [string, number, BoxHealthRecord, number, number][], [number, number, number, number, string | 0][]][]) {
        const [computer, ms, groups, d] = c;
        const ch = this.computer(st, computer);
        for (const win of [ch.all, ch.atOrBefore]) {
          win.ms = ms ?? -Infinity;
          win.groups = new Map(groups.map(([text, firstSeq, r, recvMs, seq]) => [text, { firstSeq, r, recvMs, seq }] as const));
        }
        let po = 0; let ps = 0; let pu = 0;
        ch.disk = d.map(([dO, dV, dS, dU, text]) => {
          po += dO; ps += dS; pu += dU;
          return { o: po, v: po + dV, seq: ps, used: pu, observedAt: text === 0 ? new Date(po).toISOString() : text };
        });
      }
    }
  }
}
const encRf = (x: RfEntry): unknown[] => [x.at, x.ms, x.ord, x.through, x.refused, x.by];
const decRf = (e: unknown[]): RfEntry => { const [at, ms, ord, through, refused, by] = e as [string, number, number, number, RefusedIssued, string]; return { at, ms, ord, through, refused, by }; };

/** How a report's prefixes are judged at read (`judgeReportedIssued`): this store's own prefix, and a plausible count. */
export interface BoxHistoryJudge {
  owns(storeId: string, prefix: string): boolean;
  plausible(prefix: string, through: number): boolean;
}

/**
 * Round 28 · OB-104: everything a health read takes from the store computers' reports — resumed from the saved running result
 * when one is given and still stands (see THE BOUNDED READ above), folding only `entries` above its position. Returns
 * `{ setAside }` when the saved result no longer stands: the caller then gives every report, with no saved result. A new
 * result to save comes back when `settleBefore` and `settledThrough` (a settled visibility fence) are given and enough has
 * settled since.
 */
export function readBoxHistory(input: BoxHistoryInput): BoxHistoryReading | { readonly setAside: string } {
  const steps = boxHistorySteps(input, Infinity);
  for (;;) { const n = steps.next(); if (n.done === true) return n.value; }
}

/**
 * Round 29 · OB-106 (verifier r28 NEW-8): the same reading, folded in steps of `every` reports with a pause between them
 * (`setImmediate` by default) — so a long fold never holds the process for long: requests, the readiness check and
 * the store computers' own uploads are answered in between. The answer is the same as `readBoxHistory`'s.
 */
export async function readBoxHistoryInSteps(
  input: BoxHistoryInput, opts: { readonly every?: number; readonly pause?: () => Promise<void> } = {},
): Promise<BoxHistoryReading | { readonly setAside: string }> {
  const pause = opts.pause ?? (() => new Promise<void>((resolve) => { setImmediate(resolve); }));
  const steps = boxHistorySteps(input, opts.every ?? BOX_HISTORY_STEP);
  for (;;) { const n = steps.next(); if (n.done === true) return n.value; await pause(); }
}
/** Round 29 · OB-106: how many reports are folded between two pauses (a few milliseconds of work). */
export const BOX_HISTORY_STEP = 1_000;

export interface BoxHistoryInput {
  /** The reports above the saved result's position (any order; ones at or below it are ignored) — or every report. */
  readonly entries: readonly BoxHistoryEntry[];
  readonly snapshot?: BoxHistorySnapshot;
  readonly at: string;
  readonly banked: ReadonlyMap<string, number>;
  readonly warnHours?: number;
  readonly slack?: ClaimSlack;
  readonly timeZone?: string;
  readonly replacements?: readonly StoreComputerReplacement[];
  readonly refusalAcks?: readonly RefusalAcknowledgement[];
  readonly atRiskAcks?: readonly AtRiskAcknowledgement[];
  readonly judge?: BoxHistoryJudge;
  readonly settleBefore?: string;
  /** Every report at or below this store position is visible to this read (a settled visibility fence). Needed to save. */
  readonly settledThrough?: number;
  /** Round 29 · OB-106: the caller already checked this saved result (`boxHistoryUnreadable`) — its seal, so it is not checked twice. */
  readonly sealChecked?: string;
}

function* boxHistorySteps(input: BoxHistoryInput, every: number): Generator<void, BoxHistoryReading | { readonly setAside: string }, void> {
  const atMs = Date.parse(input.at);
  const lineMs = (input.warnHours ?? DEFAULT_BOX_UNSENT_WARN_HOURS) * 3_600_000;
  const slack = input.slack ?? DEFAULT_CLAIM_SLACK;
  const timeZone = input.timeZone ?? DEFAULT_STORE_TIME_ZONE;
  const replacementsAt = atOrBefore(input.replacements, atMs);
  const acts = sortedActs(replacementsAt);
  const refusals = input.refusalAcks ?? [];
  const ctx = historyContext(refusals, input.atRiskAcks ?? []);
  const s = input.snapshot;
  let fold: BoxHistoryFold | undefined;
  let entries = input.entries;
  let settledMs = -Infinity;
  const rfBanked = new Map<string, number>();
  if (s !== undefined) {
    // Round 29 · OB-106: a damaged or altered saved result is set aside, never thrown, never trusted.
    const unreadable = input.sealChecked !== undefined && input.sealChecked === s.check ? undefined : boxHistoryUnreadable(s);
    if (unreadable !== undefined) return { setAside: `unreadable: ${unreadable}` };
    const n = s.never;
    settledMs = Date.parse(n.settledAt);
    const folded = new Set(s.folded);
    entries = entries.filter((e) => e.seq > s.seq);
    const late = entries.filter((e) => Date.parse(e.raw.receivedAt) <= settledMs);
    const lastMs = n.lastMs ?? -Infinity;
    const actsThen = acts.filter((a) => a.ms <= lastMs).map((a) => a.m.replacementId);
    const why = s.version !== BOX_HISTORY_VERSION || n.version !== FOLD_SNAPSHOT_VERSION ? 'version'
      : n.lineMs !== lineMs || n.slack.numbers !== slack.numbers || n.slack.percent !== slack.percent || n.timeZone !== timeZone ? 'settings'
      : !(settledMs <= atMs) ? 'moment'
      : late.length !== folded.size || late.some((e) => !folded.has(e.seq)) ? 'late_report'
      : actsThen.length !== n.actsApplied.length || actsThen.some((id, k) => id !== n.actsApplied[k]) ? 'acts'
      : acksPrintUpTo({ refusalAcks: refusals, ...(input.atRiskAcks === undefined ? {} : { atRiskAcks: input.atRiskAcks }), replacements: replacementsAt }, settledMs) !== s.acksPrint ? 'acknowledgements'
      : input.judge !== undefined && (s.verdicts.own.some(([storeId, prefix, owns, top]) => input.judge!.owns(storeId, prefix) !== owns || (top > 0 && !input.judge!.plausible(prefix, top)))
        || s.verdicts.ahead.some(([prefix, through]) => input.judge!.plausible(prefix, through))) ? 'verdicts'
      : n.keys.some((k) => (input.banked.get(k.prefix) ?? 0) < k.aboveFrom) || s.rfBanked.some(([prefix, b]) => (input.banked.get(prefix) ?? 0) < b) ? 'banked'
      : undefined;
    if (why !== undefined) return { setAside: why };
    try {
      fold = new BoxHistoryFold(NeverReceivedFold.decode(n), ctx);
      fold.ord = s.ord;
      for (const b of s.rawBound) fold.rawBound.set(bindingKey(b.storeId, b.prefix), b);
      fold.decodeStores(s.stores);
      for (const [storeId, prefix, owns, top] of s.verdicts.own) fold.own.set(bindingKey(storeId, prefix), [storeId, prefix, owns, top]);
      for (const [prefix, through] of s.verdicts.ahead) fold.ahead.set(prefix, through);
    } catch (e) {
      return { setAside: `unreadable: it could not be read (${e instanceof Error ? e.message : String(e)})` };
    }
    for (const [prefix, b] of s.rfBanked) rfBanked.set(prefix, b);
    entries = entries.filter((e) => !folded.has(e.seq));
  }
  const resumed = fold !== undefined;
  fold ??= new BoxHistoryFold(new NeverReceivedFold(lineMs, slack, timeZone, true), ctx);
  const timed = entries.map((e) => ({ e, ms: Date.parse(e.raw.receivedAt) })).sort((a, b) => a.ms - b.ms || a.e.seq - b.e.seq);
  const now = timed.filter((t) => t.ms <= atMs);
  const later = timed.filter((t) => t.ms > atMs);
  const bankedOf = (prefix: string): number => input.banked.get(prefix) ?? 0;
  let snapshot: BoxHistorySnapshot | undefined;
  let k = 0;
  if (input.settleBefore !== undefined && input.settledThrough !== undefined) {
    const settleMs = Math.min(atMs, Date.parse(input.settleBefore));
    for (; k < now.length && now[k]!.ms <= settleMs; k += 1) {
      fold.feed(now[k]!.e, now[k]!.ms, acts, bankedOf, input.judge, true);
      if ((k + 1) % every === 0) yield;
    }
    if (k > 0 && (!resumed || k >= FOLD_SNAPSHOT_EVERY)) {
      // The new position: below every report not folded, never beyond what the fence shows visible, never below the old one.
      let unfolded = Infinity;
      for (let j = k; j < now.length; j += 1) unfolded = Math.min(unfolded, now[j]!.e.seq);
      for (const t of later) unfolded = Math.min(unfolded, t.e.seq);
      const seq = Math.max(s?.seq ?? 0, Math.min(input.settledThrough, unfolded - 1));
      const folded = [...new Set([...(s?.folded ?? []), ...fold.foldedSeqs])].filter((q) => q > seq).sort((a, b) => a - b);
      const settledAt = new Date(settleMs).toISOString();
      const stores = fold.encode(settleMs, refusals, replacementsAt, input.banked, rfBanked);
      snapshot = sealBoxHistory({
        version: BOX_HISTORY_VERSION,
        never: fold.nr.encode({ settledAt, settledCount: 0, judgedAway: '' }),
        seq, folded, ord: fold.ord,
        acksPrint: acksPrintUpTo({ refusalAcks: refusals, ...(input.atRiskAcks === undefined ? {} : { atRiskAcks: input.atRiskAcks }), replacements: replacementsAt }, settleMs),
        verdicts: { own: [...fold.own.values()].map((v) => [...v] as const), ahead: [...fold.ahead] },
        rawBound: [...fold.rawBound.values()],
        stores,
        rfBanked: [...rfBanked].sort((a, b) => a[0].localeCompare(b[0])),
      });
    }
  }
  for (; k < now.length; k += 1) {
    fold.feed(now[k]!.e, now[k]!.ms, acts, bankedOf, input.judge, false);
    if ((k + 1) % every === 0) yield;
  }
  for (const t of later) fold.feedLater(t.e.raw, t.ms, t.e.seq);
  const candidates = fold.nr.finish(atMs, input.banked);
  // The bindings as they stand at `at`: every act done by then applies, whether or not a report came after it.
  fold.nr.applyActsUntil(acts, atMs);
  const order = (list: Iterable<PrefixBinding>): PrefixBinding[] => [...list].sort((a, b) => a.storeId.localeCompare(b.storeId) || a.prefix.localeCompare(b.prefix));
  const f = fold;
  const bankedNow = input.banked;
  return {
    candidates, unused: f.nr.unusedByStore(), bindings: order(f.nr.bound.values()), rawBindings: order(f.rawBound.values()),
    storeIds: [...f.stores.keys()].sort(),
    facts: (storeId) => f.facts(storeId, bankedNow, refusals, replacementsAt),
    view: f.view(),
    ...(snapshot === undefined ? {} : { snapshot }),
    resumed, folded: now.length,
  };
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
  /** Round 26 · OB-97: owner-approved "store computer replaced" acts (the binding follows them). */
  readonly replacements?: readonly StoreComputerReplacement[];
  /** Round 26 · OB-98: acknowledgements of an `at_risk_not_checked` finding (`POST …/at-risk-not-checked/acknowledgements`). */
  readonly atRiskAcknowledged?: readonly AtRiskAcknowledgement[];
  /** Round 27 · OB-100: numbers this store's computer said it never used that head office holds a bill for (`unusedButReceived`). */
  readonly unusedReceived?: readonly UnusedReceived[];
  /** Round 28 · OB-103: acknowledgements of an `unused_number_received` finding (`POST …/unused-numbers-received/acknowledgements`). */
  readonly unusedAcknowledged?: readonly UnusedReceivedAcknowledgement[];
  /** Round 29 · verifier r28 NEW-6: per prefix, what that check did not look at (said on the line). */
  readonly unusedCapped?: readonly UnusedCheckCapped[];
  /**
   * Round 28 · OB-104: the store's facts from the saved running result (`readBoxHistory`) — when given, `records` is not read.
   * Without it they are worked out from `records` (`storeBillFacts`), as before.
   */
  readonly facts?: StoreBillFacts;
}): BillNumberFinding[] {
  const out: BillNumberFinding[] = [];
  const facts = input.facts ?? storeBillFacts(input);
  const latestRecord = facts.latestRecord;
  for (const u of input.unreceived) {
    if (u.numbers.length === 0) continue;
    const ranges = countRanges(u.numbers);
    const them = u.numbers.length === 1 ? 'it' : 'them';
    // Verifier r21 DEAD-LETTER-AS-LOST: an OLDER box that does not list the bills it gave up on, but says it holds some — they
    // may be these. Never "enter the paper bills" while that is possible: a person checks the store computer first.
    const maybeGivenUp = latestRecord !== undefined && latestRecord.queue.deadLettered > 0 && facts.deadLetteredUnsaid(u.prefix);
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
          ? `The store computer said at ${back.saidGoneAt} that it no longer held ${rangeWords(u.prefix, back.ranges)}, and its latest report says ${back.byList ? 'they are in its list of bills still to send, given up on, or given and never used' : 'its queue holds item(s) still to send, without saying which'} again. A store computer keeps a bill until head office takes it and never takes back one it has let go, so head office no longer waits on that word. Do NOT re-enter any of them from paper until a person has checked the store computer's "waiting to send" and "gave up sending" lists`
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
        detail: `store ${input.storeId}'s computer contradicts its own earlier report: at ${back.saidGoneAt} it said it no longer held ${rangeWords(u.prefix, back.ranges)} (head office has not received ${back.numbers.length === 1 ? 'it' : 'them'}), and its latest report${latestRecord === undefined ? '' : ` (${latestRecord.receivedAt})`} lists ${back.numbers.length === 1 ? 'it' : 'them'} as still on it (to send, given up on, or given and never used). A store computer keeps a bill until head office takes it and never takes back one it has let go, so head office does not believe the later list for ${back.numbers.length === 1 ? 'it' : 'them'}: ${back.numbers.length === 1 ? 'it is' : 'they are'} named as never received. The store computer or head office lost track of these bills — call support (owner decision OB-92: no blame is placed; rarely head office lost a sale it accepted). Do NOT re-enter any of them from paper until a person has checked the store computer's "waiting to send" and "gave up sending" lists`,
      });
    }
  }
  // Verifier r21 DEAD-LETTER-AS-LOST: bills the store computer GAVE UP sending — on the box, waiting for a person. Never
  // "never received", never "enter the paper bills": once a person resolves the dead letter, the box sends them.
  for (const [prefix, { x, receivedAt }] of facts.lastByPrefix) {
    const d = x.deadLettered;
    if (d === undefined || d.count === 0 || d.from === undefined || d.to === undefined) continue;
    out.push({
      kind: 'bills_dead_lettered_on_box', prefix, ranges: [[d.from, d.to]], count: d.count, since: d.oldestAt ?? receivedAt,
      detail: `needs a person (the store computer gave up sending; do NOT re-enter from paper): store ${input.storeId}'s computer holds ${d.count} bill(s) under ${prefix} (between ${rangeWords(prefix, [[d.from, d.to]])}) that it stopped trying to send to head office. They are on the store computer, not lost. Support checks why head office did not take them and releases them from the store computer's "gave up sending" list; entering them from paper as well would book them twice`,
    });
  }
  // Round 25 · OB-96: numbers the latest report cannot vouch for, beyond the newest UNRECEIVED_CHECK_CAP head office checks
  // one by one per report — never dropped in silence. Round 26 · OB-98: unless acknowledged (`atRiskAcknowledgementStands`).
  for (const [prefix, { x, receivedAt }] of facts.lastByPrefix) {
    const { ranges: checked, unchecked } = atRiskExamined(x.atRisk);
    if (unchecked === 0) continue;
    if (facts.atRiskStands(prefix)) continue;
    const below = checked[0]![0];
    out.push({
      kind: 'at_risk_not_checked', prefix, count: unchecked, ranges: atRiskNotChecked(x.atRisk), since: receivedAt,
      detail: `not checked: store ${input.storeId}'s computer says it cannot vouch for ${unchecked + checked.reduce((n, [a, z]) => n + z - a + 1, 0)} bill number(s) under ${prefix} (given after the backup it was restored from); head office checks the newest ${UNRECEIVED_CHECK_CAP} of them one by one on each report, so ${unchecked} older one(s), below ${prefix}${pad6(below)}, were NOT checked. Ask support to compare that store computer's restore record with head office's bills; any of them head office does not hold may be a sale lost by the restore. Do NOT re-enter bills from paper until support has checked. ${NOT_CHECKED_STAYS_WORDS}`,
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
  // Round 27 · OB-100 (verifier r26 NEW-1, probes U1/U4): a number the store computer listed as given and never used AFTER
  // head office's bill under it was made — its list does not fit the books. Nothing is missing (head office has the bill),
  // so nobody is sent looking for paper; the store computer's word about unused numbers under that prefix is in question.
  const byPrefix = new Map<string, UnusedReceived[]>();
  for (const u of input.unusedReceived ?? []) byPrefix.set(u.prefix, [...(byPrefix.get(u.prefix) ?? []), u]);
  for (const [prefix, list] of [...byPrefix].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sorted = [...list].sort((a, b) => a.number - b.number);
    const ranges = countRanges(sorted.map((u) => u.number));
    // Round 28 · OB-103: silenced while an all-stores acknowledgement of exactly this set of numbers stands.
    if (unusedReceivedAcknowledgementStands(input.storeId, prefix, ranges, input.unusedAcknowledged ?? [])) continue;
    const first = sorted.reduce((a, b) => (Date.parse(b.heldAt) < Date.parse(a.heldAt) ? b : a));
    const sales = sorted.filter((u) => u.heldAs === 'sale').length;
    const said = sorted.map((u) => u.lastSaidUnusedAt).sort().at(-1)!;
    const one = sorted.length === 1;
    // Round 29 · OB-108: whose clock the bill's time is (the store computer's, or — an older store computer — the till's).
    const tillClock = sorted.filter((u) => u.clock === 'till').length;
    const clockWords = tillClock === 0
      ? !sorted.every((u) => u.clock === 'store_computer') ? '' : ' (both times by the store computer\'s own clock: when it said so, and when it took the bill from the till)'
      : ` (${tillClock === sorted.length ? '' : `for ${tillClock} of them, `}the bill's time is the TILL's own clock — this store computer did not stamp when it took the bill, so a till clock that is slow can make an honest number look like this: check the till's clock first)`;
    out.push({
      kind: 'unused_number_received', prefix, ranges, count: sorted.length, since: first.heldAt,
      detail: `does not fit: store ${input.storeId}'s computer said (last at ${said}) that it gave ${rangeWords(prefix, ranges)} and never put ${one ? 'it' : 'them'} on a bill, but head office holds ${sales === sorted.length ? (one ? 'a sale' : 'sales') : sales === 0 ? (one ? 'a return' : 'returns') : 'sales and returns'} under ${one ? 'that number' : 'those numbers'}, made before that (the first at ${first.heldAt}, ${prefix}${pad6(first.number)})${clockWords}. A number put on a bill is never "unused" afterwards. Nothing is missing — head office has ${one ? 'the bill' : 'the bills'}, so do NOT look for paper bills — but the store computer's list of unused numbers under ${prefix} cannot be relied on: call support to check that store computer (the store computer or head office lost track; no blame is placed, as owner decision OB-92).${cappedWords(input.unusedCapped?.find((c) => c.prefix === prefix))} ${UNUSED_RECEIVED_STAYS_WORDS}`,
    });
  }
  out.push(...refusedFindingsFrom(input.storeId, facts.refusedOpen));
  return out;
}

/**
 * Round 28 · OB-104: what `billNumberFindingsFor` speaks from for one store, apart from the never-received numbers and the
 * ledger checks. Worked out from the store's reports here (`storeBillFacts`); the saved running result keeps the same facts
 * as it folds (`readBoxHistory`), so a health read no longer re-reads every report. Proved equal on seeded histories
 * (tests/unit/the-box-history-is-its-full-reading).
 */
export interface StoreBillFacts {
  /** The store's latest report as bound (OB-94/97), NOT believed — by the order head office received them. */
  readonly latestRecord: BoxHealthRecord | undefined;
  /** The latest bound report naming the prefix says nothing of bills given up on (`deadLettered` absent) — or none names it. */
  readonly deadLetteredUnsaid: (prefix: string) => boolean;
  /** Per prefix (in order), the latest BELIEVED word about it and when that report came. */
  readonly lastByPrefix: readonly (readonly [string, { readonly x: IssuedReport; readonly receivedAt: string }])[];
  /** An acknowledgement of the prefix's not-checked line stands (`atRiskAcknowledgementStands`). */
  readonly atRiskStands: (prefix: string) => boolean;
  /** The refused counts still open, per prefix. */
  readonly refusedOpen: RefusedOpen;
}

/** Round 28 · OB-104: one store's `StoreBillFacts`, read from its reports (the plain reading). */
export function storeBillFacts(input: {
  readonly storeId: string; readonly records: readonly BoxHealthRecord[]; readonly at: string; readonly banked?: ReadonlyMap<string, number>;
  readonly acknowledged?: readonly RefusalAcknowledgement[]; readonly replacements?: readonly StoreComputerReplacement[];
  readonly atRiskAcknowledged?: readonly AtRiskAcknowledgement[];
}): StoreBillFacts {
  const atMs = Date.parse(input.at);
  const replacements = atOrBefore(input.replacements, atMs);
  // OB-94: a second store computer's word about a bound prefix is refused (and said below), never read as the box's.
  const mine = bindInOrder(input.records.filter((r) => r.storeId === input.storeId && Date.parse(r.receivedAt) <= atMs), replacements);
  const latestOf = (prefix: string): IssuedReport | undefined => {
    let found: IssuedReport | undefined;
    for (const r of mine) found = r.receiptNumbersIssued?.find((x) => x.prefix === prefix) ?? found;
    return found;
  };
  const lastByPrefix = new Map<string, { x: IssuedReport; receivedAt: string }>();
  for (const r of mine.map(believedRecord)) for (const x of r.receiptNumbersIssued ?? []) lastByPrefix.set(x.prefix, { x, receivedAt: r.receivedAt });
  return {
    latestRecord: mine[mine.length - 1],
    deadLetteredUnsaid: (prefix) => latestOf(prefix)?.deadLettered === undefined,
    lastByPrefix: [...lastByPrefix].sort((a, b) => a[0].localeCompare(b[0])),
    atRiskStands: (prefix) => atRiskAcknowledgementStands(input.storeId, prefix, mine, input.atRiskAcknowledged ?? []),
    refusedOpen: refusedOpenFromRecords(input.storeId, mine, input.banked, input.acknowledged ?? [], replacements),
  };
}

/** Round 27 · OB-100: how long an "unused but received" finding stays (the health page's words). */
export const UNUSED_RECEIVED_STAYS_WORDS = 'This stays until the owner or head office staff (all-stores authority — a store\'s own manager cannot, and neither can the IT/platform administrator) acknowledge it with a reason, after support has checked the store computer. The acknowledgement holds while head office finds this same set of numbers; a new number needs a new acknowledgement';

/** Round 28 · OB-103: acknowledging a "said unused, but head office has the bill" line. */
export const UNUSED_RECEIVED_ACKNOWLEDGEMENTS_PATH = '/v1/store-computers/unused-numbers-received/acknowledgements';

/** Round 28 · OB-103: a person's acknowledgement of an `unused_number_received` finding (kept append-only; each one: who, when, why). */
export interface UnusedReceivedAcknowledgement {
  readonly storeId: string;
  readonly prefix: string;
  /** The numbers acknowledged, exactly, as [from, to] ranges — a different set (a new number included) is a new finding. */
  readonly numbers: readonly (readonly [number, number])[];
  /** How many numbers that is (as the health page showed it). */
  readonly count: number;
  readonly reason: string;
  readonly by: string;
  readonly at: string;
  /** Only an all-stores acknowledgement (owner / head office business staff, never IT — OB-91) is honoured. */
  readonly authority?: 'all_stores';
}

/**
 * Round 28 · OB-103 "A" (owner, 13 Oct 2026, in writing, "You/HO acknowledge") — THE RULE (stated, so a person can check it
 * by hand; the same authority as a refused report's and a not-checked line's, OB-88/OB-91/OB-98). The "said unused, but head
 * office has the bill" line for a (store, prefix) is silenced ONLY by an acknowledgement given with ALL-STORES business
 * authority whose set of numbers is EXACTLY the set head office finds now. It holds while the same set is found; a new
 * number (or any other change of the set) makes the line show again, and it needs a new acknowledgement. Each
 * acknowledgement is kept on its own (who, why, when); none is ever removed.
 */
export function unusedReceivedAcknowledgementStands(
  storeId: string, prefix: string, ranges: readonly (readonly [number, number])[], acknowledged: readonly UnusedReceivedAcknowledgement[],
): boolean {
  if (ranges.length === 0) return false;
  const key = runsKey(joinRuns(ranges));
  return acknowledged.some((a) => a.storeId === storeId && a.prefix === prefix && a.authority === 'all_stores' && runsKey(joinRuns(a.numbers)) === key);
}

/**
 * Round 27 · OB-100 — THE RULE (stated, so a person can check it by hand): a number a store computer said it gave and never
 * put on a bill is a contradiction when head office HOLDS a sale (its receipt-number index) or a return under it, AND the
 * store computer said "never used" more than UNUSED_CONTRADICTION_MARGIN_MINUTES after that bill was made (its report's
 * minute, rounded DOWN — round 29 · NEW-6; it was the hour). An honest store computer lists a number as unused only until a
 * bill takes it (a held bill completed later — verifier r26 P5-new): the bill is made after the last "unused", so it never
 * fits this rule.
 * Round 29 · OB-108 "A" (owner, 14 Oct 2026, in writing, "Use store computer time"; verifier r28 NEW-4, probe U5): "when the
 * bill was made" is the STORE COMPUTER's own time for it — the moment it took the bill from the till and wrote it to its
 * disk (`storeComputerTakenAt`, stamped by the store computer and carried with the bill to head office) — the same clock its
 * reports are written by. A till whose clock is slow can no longer make an honest number look "said unused after its
 * bill". A bill from an older store computer that does not stamp it is judged on the till's time, as before, and the line
 * says so (`clock: 'till'`). The margin allows for the minute rounding and the report's round trip.
 */
export const UNUSED_CONTRADICTION_MARGIN_MINUTES = 15;
export interface UnusedReceived {
  readonly prefix: string; readonly number: number; readonly heldAs: 'sale' | 'return'; readonly heldAt: string; readonly lastSaidUnusedAt: string;
  /** Round 29 · OB-108: whose clock `heldAt` is — the store computer's (it took the bill), or the till's (an older store computer). */
  readonly clock?: 'store_computer' | 'till';
}
export function unusedButReceived(
  prefix: string, unused: UnusedNumbers | undefined,
  held: ReadonlyMap<number, { readonly as: 'sale' | 'return'; readonly at: string; readonly clock?: 'store_computer' | 'till' }>,
): UnusedReceived[] {
  const out: UnusedReceived[] = [];
  if (held.size === 0) return out;
  for (const run of unused?.runs ?? []) {
    for (const [n, h] of held) {
      if (n < run.from || n > run.to) continue;
      if (Date.parse(run.lastSaidAt) > Date.parse(h.at) + UNUSED_CONTRADICTION_MARGIN_MINUTES * 60_000) {
        out.push({ prefix, number: n, heldAs: h.as, heldAt: h.at, lastSaidUnusedAt: run.lastSaidAt, ...(h.clock === undefined ? {} : { clock: h.clock }) });
      }
    }
  }
  return out.sort((a, b) => a.number - b.number);
}

/**
 * Round 29 · verifier r28 NEW-6 (a): per prefix, how much of a store computer's "unused" list the check above did NOT look at —
 * numbers at or below banked beyond the newest UNRECEIVED_CHECK_CAP, and numbers head office holds beyond the newest
 * UNUSED_HELD_TIMED_MAX whose bill time was read. Said on the line (and on the "taken but never used" information), never
 * dropped in silence.
 */
export interface UnusedCheckCapped { readonly prefix: string; readonly notChecked: number; readonly notTimed: number }
export const UNUSED_HELD_TIMED_MAX = 50;
const cappedWords = (c: UnusedCheckCapped | undefined): string => (c === undefined || (c.notChecked === 0 && c.notTimed === 0) ? ''
  : ` Not every number was looked at: ${[
    c.notChecked > 0 ? `${c.notChecked} older number(s) said unused, beyond the newest ${UNRECEIVED_CHECK_CAP}, were not checked against head office's bills` : '',
    c.notTimed > 0 ? `${c.notTimed} more number(s) head office holds a bill for, beyond the newest ${UNUSED_HELD_TIMED_MAX}, did not have their bill's time read` : '',
  ].filter((x) => x !== '').join('; ')} — so there may be more than this line names.`);

/** Round 27 · OB-100: one prefix's unused numbers, as the store's people read them — per day, how many and which. */
export interface UnusedNumbersDay {
  readonly prefix: string;
  /** The store's calendar day the store computer FIRST said these numbers were given and never used. */
  readonly day: string;
  readonly count: number;
  /** The numbers, as [from, to] ranges (the newest UNUSED_DAY_RANGES_SHOWN — `moreRanges` says how many more). */
  readonly ranges: readonly (readonly [number, number])[];
  readonly moreRanges: number;
  readonly lastSaidAt: string;
}
/** How many days of unused numbers the health read shows (the store's calendar, newest first). */
export const UNUSED_DAYS_SHOWN = 7;
export const UNUSED_DAY_RANGES_SHOWN = 50;
/** Round 27 · OB-100: the unused numbers per till prefix per day, the newest UNUSED_DAYS_SHOWN days with any. */
export function unusedNumbersByDay(list: readonly UnusedNumbers[]): UnusedNumbersDay[] {
  const out: UnusedNumbersDay[] = [];
  for (const u of list) {
    const days = new Map<string, { ranges: [number, number][]; count: number; last: string }>();
    for (const r of u.runs) {
      const d = days.get(r.day) ?? { ranges: [], count: 0, last: r.lastSaidAt };
      const prev = d.ranges[d.ranges.length - 1];
      if (prev !== undefined && prev[1] + 1 === r.from) prev[1] = r.to; else d.ranges.push([r.from, r.to]);
      d.count += r.to - r.from + 1;
      if (r.lastSaidAt > d.last) d.last = r.lastSaidAt;
      days.set(r.day, d);
    }
    for (const [day, d] of days) {
      out.push({ prefix: u.prefix, day, count: d.count, ranges: d.ranges.slice(-UNUSED_DAY_RANGES_SHOWN), moreRanges: Math.max(0, d.ranges.length - UNUSED_DAY_RANGES_SHOWN), lastSaidAt: d.last });
    }
  }
  const newest = new Set([...new Set(out.map((x) => x.day))].sort().reverse().slice(0, UNUSED_DAYS_SHOWN));
  return out.filter((x) => newest.has(x.day)).sort((a, b) => b.day.localeCompare(a.day) || a.prefix.localeCompare(b.prefix));
}

/** Round 26 · OB-98: what the owner reads about how a not-checked line stops being a warning (the health page's words). */
export const NOT_CHECKED_STAYS_WORDS = 'This stays until the owner or head office staff (all-stores authority — a store\'s own manager cannot, and neither can the IT/platform administrator) acknowledge it with a reason, after support has compared the restore record. The acknowledgement holds while the store computer keeps reporting this same set of not-checked numbers; a different set needs a new acknowledgement';

/**
 * Round 26 · OB-98: the at-risk numbers ONE report names that head office does NOT check one by one — every count in its
 * at-risk ranges below the newest UNRECEIVED_CHECK_CAP (`atRiskExamined`), as [from, to] ranges in rising order.
 */
export function atRiskNotChecked(atRisk: readonly (readonly [number, number])[] | undefined): [number, number][] {
  const { ranges: checked, unchecked } = atRiskExamined(atRisk);
  if (unchecked === 0) return [];
  const lowestChecked = checked.length === 0 ? Infinity : checked[0]![0];
  const out: [number, number][] = [];
  for (const [a, z] of joinRuns(atRisk ?? [])) {
    if (a >= lowestChecked) break;
    out.push([a, Math.min(z, lowestChecked - 1)]);
  }
  return out;
}

const runsKey = (ranges: readonly (readonly [number, number])[]): string => ranges.map(([a, z]) => `${a}-${z}`).join(',');
/** Round 27 (cost): a report's not-checked set as a key, worked out once per at-risk list (a report shares one across its prefixes). */
const NOT_CHECKED_KEYS = new WeakMap<object, string>();
function notCheckedKey(atRisk: readonly (readonly [number, number])[] | undefined): string {
  if (atRisk === undefined) return '';
  let key = NOT_CHECKED_KEYS.get(atRisk);
  if (key === undefined) { key = runsKey(atRiskNotChecked(atRisk)); NOT_CHECKED_KEYS.set(atRisk, key); }
  return key;
}

/** Round 26 · OB-98: a person's acknowledgement of an `at_risk_not_checked` finding (kept append-only; each one: who, when, why). */
export interface AtRiskAcknowledgement {
  readonly storeId: string;
  readonly prefix: string;
  /** The not-checked numbers acknowledged, exactly — a different set (larger, smaller, moved) is a new finding. */
  readonly notChecked: readonly (readonly [number, number])[];
  /** How many numbers that is (as the health page showed it). */
  readonly count: number;
  readonly reason: string;
  readonly by: string;
  readonly at: string;
  /** Only an all-stores acknowledgement (owner / head office business staff, never IT — OB-91) is honoured. */
  readonly authority?: 'all_stores';
}

/**
 * Round 26 · OB-98 — THE RULE (stated, so a person can check it by hand; the same shape as a refused report's, OB-88). The
 * not-checked line for a (store, prefix) is silenced ONLY by an acknowledgement given with ALL-STORES business authority
 * that still stands at the latest report naming the prefix:
 *   • it was given while the store computer's latest report (before it) named exactly that set of not-checked numbers, and
 *   • every report naming the prefix since then named that same set.
 * Once a report names a DIFFERENT set (an empty one included), the acknowledgement ends for good — that set coming back
 * later needs a new acknowledgement. Each acknowledgement is kept on its own. `mine`: the store's reports as bound (OB-94/97).
 */
export function atRiskAcknowledgementStands(storeId: string, prefix: string, mine: readonly BoxHealthRecord[], acknowledged: readonly AtRiskAcknowledgement[]): boolean {
  const acks = acknowledged.filter((a) => a.storeId === storeId && a.prefix === prefix && a.authority === 'all_stores')
    .map((a) => ({ ms: Date.parse(a.at), key: runsKey(a.notChecked) })).sort((a, b) => a.ms - b.ms);
  if (acks.length === 0) return false;
  let standing: string | undefined;
  let last: string | undefined;
  let k = 0;
  for (const r of byReceipt(mine)) {
    if (r.storeId !== storeId) continue;
    const x = (r.receiptNumbersIssued ?? []).find((y) => y.prefix === prefix);
    if (x === undefined) continue;
    const ms = Date.parse(r.receivedAt);
    for (; k < acks.length && acks[k]!.ms < ms; k += 1) if (last !== undefined && last !== '' && last === acks[k]!.key) standing = last;
    const key = notCheckedKey(x.atRisk);
    if (standing !== undefined && key !== standing) standing = undefined;
    last = key;
  }
  for (; k < acks.length; k += 1) if (last !== undefined && last !== '' && last === acks[k]!.key) standing = last;
  return standing !== undefined && standing === last;
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
function refusedOpenFromRecords(
  storeId: string, mine: readonly BoxHealthRecord[], banked: ReadonlyMap<string, number> | undefined, acknowledged: readonly RefusalAcknowledgement[],
  replacements: readonly StoreComputerReplacement[] = [],
): RefusedOpen {
  interface Said { readonly at: string; readonly through: number; readonly refused?: RefusedIssued; readonly by: string }
  // Round 27 (cost): the latest act moving each (prefix, to) of this store — an act answers the refusals from before it.
  const latestActTo = new Map<string, number>();
  for (const m of replacements) {
    if (m.storeId !== storeId) continue;
    const key = `${m.prefix}\u0000${m.to}`;
    latestActTo.set(key, Math.max(latestActTo.get(key) ?? -Infinity, Date.parse(m.at)));
  }
  const timeline = new Map<string, Said[]>();
  for (const rec of mine) {
    const said = new Map<string, Said>();
    for (const x of rec.receiptNumbersIssued ?? []) said.set(x.prefix, { at: rec.receivedAt, through: x.through, by: rec.reportedBy });
    for (const x of rec.receiptNumbersNotFolded ?? []) said.set(x.prefix, { at: rec.receivedAt, through: x.through, by: rec.reportedBy });
    for (const r of rec.receiptNumbersRefused ?? []) said.set(r.prefix, { at: rec.receivedAt, through: r.through, refused: r, by: rec.reportedBy });
    for (const [prefix, x] of said) { const list = timeline.get(prefix); if (list === undefined) timeline.set(prefix, [x]); else list.push(x); }
  }
  const out: [string, Map<number, { first: string; latest: RefusedSaid }>][] = [];
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
    const open = new Map<number, { first: string; latest: RefusedSaid }>();
    for (const x of said) {
      for (; k < acks.length && Date.parse(acks[k]!.at) < Date.parse(x.at); k += 1) if (last?.through === acks[k]!.through) standing = acks[k]!.through;
      if (standing !== undefined && x.through !== standing) standing = undefined;
      last = x;
      const r = x.refused;
      if (r === undefined) continue;
      // OB-94: a second store computer's report is never "made true" by head office's banking — only a person clears it.
      const resolved = (r.because !== 'prefix_of_another_store_computer' && banked !== undefined && (banked.get(prefix) ?? 0) >= r.through)
        || Date.parse(x.at) <= (seenUpTo.get(r.through) ?? -Infinity) || standing === r.through
        // Round 26 · OB-97: the replacement store computer's reports from BEFORE the owner approved moving the prefix to it
        // are answered by that act (the owner looked at exactly this machine) — never the old computer's, never later ones.
        || (r.because === 'prefix_of_another_store_computer' && (latestActTo.get(`${prefix}\u0000${x.by}`) ?? -Infinity) >= Date.parse(x.at));
      if (resolved) continue;
      const cur = open.get(r.through);
      open.set(r.through, { first: cur?.first ?? x.at, latest: x as RefusedSaid });
    }
    if (open.size > 0) out.push([prefix, open]);
  }
  return out;
}

/** One refused report's word, as the refused-report rule reads it (when, which count, why, and which store computer said it). */
export interface RefusedSaid { readonly at: string; readonly through: number; readonly refused: RefusedIssued; readonly by: string }
/** Round 28 · OB-104: per prefix (in order) the refused counts still open — when each was first refused, and its latest word. */
export type RefusedOpen = readonly (readonly [string, ReadonlyMap<number, { readonly first: string; readonly latest: RefusedSaid }>])[];

/** The owner's words for the refused counts still open (`refusedOpenFromRecords`, or the saved running result's). */
function refusedFindingsFrom(storeId: string, refusedOpen: RefusedOpen): BillNumberFinding[] {
  const out: BillNumberFinding[] = [];
  for (const [prefix, open] of refusedOpen) {
    if (open.size === 0) continue;
    const counts = [...open.keys()].sort((a, b) => b - a);
    const top = open.get(counts[0]!)!;
    const r = top.latest.refused!;
    const others = counts.slice(1);
    out.push({
      kind: 'report_refused', prefix, through: r.through, since: top.first,
      detail: (r.because === 'prefix_of_another_store_computer'
        ? twoComputersWords(storeId, prefix, r, top.latest.by)
        : r.because === 'prefix_of_another_store'
        ? `store ${storeId}'s computer (${top.latest.by}) reported giving bill numbers under ${prefix} through ${r.through}, but head office issued ${prefix} to a till of ANOTHER store — not counted, so no till is affected; check that store computer`
        : `store ${storeId}'s computer (${top.latest.by}) reported giving bill numbers under ${prefix} through ${r.through}, far beyond the ${r.bankedThrough} head office holds banked (at most ${r.plausibleThrough ?? r.bankedThrough + PLAUSIBLE_ISSUED_AHEAD} is believed, ${PLAUSIBLE_ISSUED_AHEAD} ahead) — not counted, so the till keeps selling; check that store computer's bill numbers`)
        + (others.length === 0 ? '' : `. It also reported ${others.length === 1 ? 'another count' : 'other counts'} head office refused under ${prefix}, still to be looked at: ${others.slice(0, 5).join(', ')}${others.length > 5 ? ` and ${others.length - 5} more` : ''}`)
        + `. ${REFUSAL_STAYS_WORDS}`,
    });
  }
  return out;
}

/**
 * Round 27 · OB-101 "A" (verifier r26 NEW-2): two store computers report one till's prefix — said NEUTRALLY, naming both,
 * which one head office uses and why (it reported the prefix first, or the owner approved moving the prefix to it), and what
 * that means for the lost-bill checks. Neither machine is called the wrong one: a person checks both.
 */
function twoComputersWords(storeId: string, prefix: string, r: RefusedIssued, other: string): string {
  const used = r.boundTo ?? '?';
  const why = r.boundVia === 'replacement'
    ? `the owner approved moving ${prefix} to it${r.boundSince === undefined ? '' : ` at ${r.boundSince}`}${r.boundReplacementId === undefined ? '' : ` (act ${r.boundReplacementId})`}`
    : `it was the first to report ${prefix}${r.boundSince === undefined ? '' : `, at ${r.boundSince}`}`;
  return `two store computers report bill numbers under ${prefix} for store ${storeId}: ${used} and ${other}. Head office uses ${used}'s reports for ${prefix} because ${why}; it keeps ${other}'s report (through ${r.through}) as evidence and does not use it. One store computer per bill-number prefix (owner decision OB-94), so until a person has checked both machines, head office checks ${prefix}'s bills for loss only on ${used}'s word — bills sold on ${other}, if that is the till's real store computer, are not checked. Check both machines: if ${other} is the till's store computer now, record a replaced store computer on the Store computers page (the owner approves it); if it is a stand-by or a copy, switch it off or give its till a new prefix`;
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
  const until = Date.parse(latest.observedAt);
  const ordered = storeRecords
    .map((r) => ({ r, o: Date.parse(r.observedAt) }))
    .filter(({ r, o }) => r.storeId === latest.storeId && o >= since && o <= until)
    .map(({ r, o }) => ({ r, o, v: Date.parse(r.receivedAt) }))
    .sort((a, b) => a.o - b.o || a.v - b.v).map(({ r, o }) => ({ o, used: r.disk.salesLogUsedBytes, observedAt: r.observedAt }));
  return estimateOverPoints(ordered, latest);
}

/** Round 28 · OB-104: one report's disk, as the estimate reads it (its time, its sales log). */
export interface DiskPoint { readonly o: number; readonly used: number; readonly observedAt: string }

/** The estimate (steps 1–5 above) over a store computer's reports of the last 7 days, oldest first. */
export function estimateOverPoints(ordered: readonly DiskPoint[], latest: BoxHealthRecord): TradingHoursEstimate {
  // Only the run since the log last got smaller (step 1).
  let start = 0;
  for (let i = 1; i < ordered.length; i += 1) if (ordered[i]!.used < ordered[i - 1]!.used) start = i;
  const run = ordered.slice(start);
  let bytes = 0;
  let minutes = 0;
  let gaps = 0;
  for (let i = 1; i < run.length; i += 1) {
    const grew = run[i]!.used - run[i - 1]!.used;
    const gapMinutes = (run[i]!.o - run[i - 1]!.o) / 60_000;
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
  /**
   * Round 27 · OB-100: the numbers this store's computer said it gave and never used — per till prefix, per day it first said
   * so (the newest UNUSED_DAYS_SHOWN days). Information, shown neutrally: "taken but never used", nothing to look for.
   */
  readonly unusedNumbers?: readonly UnusedNumbersDay[];
  /**
   * Round 27 · OB-101 "A" (verifier r26 NEW-3): the store computer this view's disk, queue, tills and numbering come from —
   * the one that holds the store's tills' bill-number prefixes (or, before any is bound, the latest to report) — and every
   * OTHER store computer reporting for this store, with its own last state (shown apart; it never stands in).
   */
  readonly computer?: string | null;
  readonly otherComputers?: readonly { readonly computer: string; readonly lastReportAt: string; readonly stale: boolean; readonly canRecordSales: boolean; readonly bindsNoTill: true }[];
  /**
   * Round 29 · OB-107: when MORE than one store computer holds this store's tills' prefixes — each of them, judged on its own
   * (which prefixes it holds, its last report, its room for sales, its queue). The store's disk and queue are the worse.
   */
  readonly boundComputers?: readonly {
    readonly computer: string; readonly prefixes: readonly string[]; readonly lastReportAt: string; readonly stale: boolean;
    readonly canRecordSales: boolean; readonly tradingHoursLeft: number | null; readonly queue: { readonly unsent: number; readonly deadLettered: number };
  }[];
}

const mb = (bytes: number): string => `${Math.floor(bytes / 1_048_576)} MB`;
/** How bad a status is (the worse of two decides — OB-107). */
const RANK_OF: Readonly<Record<string, number>> = { ok: 0, unknown: 1, degraded: 2, down: 3 };
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
  /** Round 26 · OB-97: owner-approved "store computer replaced" acts (the binding follows them). */
  readonly replacements?: readonly StoreComputerReplacement[];
  /** Round 27 · OB-101: the (store, prefix) bindings as they stand at `at` — worked out from the reports when not given. */
  readonly bindings?: readonly PrefixBinding[];
  /** Round 27 · OB-100: each store's unused numbers (`readNeverReceived(...).unused`) — worked out from the reports when not given. */
  readonly unusedNumbers?: ReadonlyMap<string, readonly UnusedNumbers[]>;
  /** The store's own time zone (its calendar days), for unused numbers worked out here. */
  readonly timeZone?: string;
  /** Round 29 · verifier r28 NEW-6: per store, what the "said unused, but head office has the bill" check did not look at. */
  readonly unusedCapped?: ReadonlyMap<string, readonly UnusedCheckCapped[]>;
  /**
   * Round 28 · OB-104: the reports as the saved running result keeps them (`readBoxHistory(...).view`) — when given, `records`
   * is not read (give `bindings` and `unusedNumbers` from the same reading). The answers are the same (proved by test).
   */
  readonly view?: BoxReportsView;
}): { readonly boxes: readonly BoxHealthView[]; readonly components: readonly ComponentHealth[]; readonly localStoreWritable: boolean | undefined } {
  const warnHours = input.diskWarnHours ?? DEFAULT_BOX_DISK_WARN_HOURS;
  const worked = input.bindings !== undefined && input.unusedNumbers !== undefined ? undefined
    : readNeverReceived({ records: input.records, at: input.at, banked: new Map(), ...(input.replacements === undefined ? {} : { replacements: input.replacements }), ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }) });
  const bindings = input.bindings ?? worked!.bindings;
  const unusedOf = input.unusedNumbers ?? worked!.unused;
  // Round 27 · OB-101 "A" (verifier r26 NEW-3, probe B2): a store's disk, queue, tills and numbering come ONLY from the store
  // computer(s) holding its tills' bill-number prefixes — a second (refused) store computer's report never stands in for
  // them. Before any prefix is bound, the latest report stands, as before.
  const boundTo = new Map<string, Set<string>>();
  for (const b of bindings) { const set = boundTo.get(b.storeId) ?? new Set<string>(); set.add(b.computer); boundTo.set(b.storeId, set); }
  const isBound = (r: Pick<BoxHealthRecord, 'storeId' | 'reportedBy'>): boolean => { const set = boundTo.get(r.storeId); return set === undefined || set.has(r.reportedBy); };
  const view = input.view;
  const latest = view === undefined ? new Map(latestBoxReports(input.records.filter(isBound))) : new Map<string, BoxHealthRecord>();
  const others = new Map<string, Map<string, BoxHealthRecord>>();
  if (view === undefined) {
    for (const r of input.records) {
      if (isBound(r) || Date.parse(r.receivedAt) > Date.parse(input.at)) continue;
      const per = others.get(r.storeId) ?? new Map<string, BoxHealthRecord>();
      const cur = per.get(r.reportedBy);
      if (cur === undefined || Date.parse(r.observedAt) > Date.parse(cur.observedAt) || (r.observedAt === cur.observedAt && Date.parse(r.receivedAt) >= Date.parse(cur.receivedAt))) per.set(r.reportedBy, r);
      others.set(r.storeId, per);
    }
  } else {
    // Round 28 · OB-104: the same answers from the saved running result (no report re-read).
    for (const storeId of view.storeIds) {
      const bound = (computer: string): boolean => isBound({ storeId, reportedBy: computer });
      const r = view.latestOf(storeId, bound);
      if (r !== undefined) latest.set(storeId, r);
      const per = view.othersOf(storeId, bound);
      if (per.length > 0) others.set(storeId, new Map(per.map((o) => [o.reportedBy, o] as const)));
    }
  }
  // Round 29 · OB-107 "A" (owner, 14 Oct 2026, in writing, "Judge each, worst wins"; verifier r28 NEW-3, probe B3): EACH store
  // computer holding any of the store's tills' prefixes is judged on its own — its own latest report, disk, queue and room
  // for sales — and the WORSE decides the store, each computer named. A second computer that holds one prefix (a new till's,
  // say) can no longer speak for the whole store and hide the other's full disk.
  const eachOf = (storeId: string): BoxHealthRecord[] => {
    // Before any prefix is bound, the latest report stands for the store, as before (no computer holds its tills yet).
    if (!boundTo.has(storeId)) return [];
    if (view !== undefined) return view.latestEach(storeId, (computer) => isBound({ storeId, reportedBy: computer }));
    const per = new Map<string, BoxHealthRecord[]>();
    // One pass, each report pushed onto its computer's list (never a copy of the list per report — that was quadratic).
    for (const x of input.records) {
      if (x.storeId !== storeId || !isBound(x)) continue;
      const list = per.get(x.reportedBy);
      if (list === undefined) per.set(x.reportedBy, [x]); else list.push(x);
    }
    return [...per].sort((a, b) => a[0].localeCompare(b[0])).flatMap(([, list]) => { const h = latestBoxReports(list).get(storeId); return h === undefined ? [] : [h]; });
  };
  const prefixesOf = (storeId: string, computer: string): string[] => bindings.filter((b) => b.storeId === storeId && b.computer === computer).map((b) => b.prefix).sort();
  const ids = [...new Set([...(input.knownStores ?? []), ...latest.keys(), ...others.keys()])].sort();
  const boxes: BoxHealthView[] = [];
  const components: ComponentHealth[] = [];
  let anyFreshCannot = false;
  let allFreshCan = latest.size > 0;
  for (const storeId of ids) {
    const r = latest.get(storeId);
    const unusedDays = unusedNumbersByDay(unusedOf.get(storeId) ?? []);
    const otherComputers = [...(others.get(storeId)?.values() ?? [])].sort((a, b) => a.reportedBy.localeCompare(b.reportedBy)).map((o) => ({
      computer: o.reportedBy, lastReportAt: o.observedAt, stale: Math.max(0, Math.floor((Date.parse(input.at) - Date.parse(o.observedAt)) / 1000)) >= input.thresholds.syncLagWarnSeconds,
      canRecordSales: boxCanRecordSales(o.disk), bindsNoTill: true as const,
    }));
    const othersSay = otherComputers.length === 0 ? '' : ` (${otherComputers.length === 1 ? 'another store computer' : 'other store computers'}, ${otherComputers.map((o) => o.computer).join(', ')}, also ${otherComputers.length === 1 ? 'reports' : 'report'} for this store but ${otherComputers.length === 1 ? 'holds' : 'hold'} none of its tills' bill numbers, so head office takes the store's health only from ${r?.reportedBy ?? 'the store computer that does'}; ${otherComputers.map((o) => `${o.computer} last reported ${o.lastReportAt}${o.canRecordSales ? '' : ', its own disk full'}`).join('; ')})`;
    if (r === undefined) {
      allFreshCan = false;
      boxes.push({
        storeId, state: 'never_reported', lastReportAt: null, ageSeconds: null, stale: true, canRecordSales: null, disk: null, queue: null, tills: [], tradingHoursLeft: null, tradingHoursLeftSays: null,
        ...(otherComputers.length === 0 ? {} : { computer: null, otherComputers }), ...(unusedDays.length === 0 ? {} : { unusedNumbers: unusedDays }),
      });
      if (otherComputers.length > 0) {
        components.push({
          name: `box_disk:${storeId}`, status: 'unknown',
          detail: `the store computer that holds store ${storeId}'s tills' bill numbers (${[...(boundTo.get(storeId) ?? [])].join(', ')}) has not reported its disk, queue or tills${othersSay}. Not known — never read from another machine`,
        });
      }
      continue;
    }
    const ageSeconds = Math.max(0, Math.floor((Date.parse(input.at) - Date.parse(r.observedAt)) / 1000));
    const stale = ageSeconds >= input.thresholds.syncLagWarnSeconds;
    const can = boxCanRecordSales(r.disk);
    // OB-107: every store computer holding the store's tills, judged on its own (one, as before: just `r`).
    const heads = eachOf(storeId);
    const several = heads.length > 1;
    for (const h of several ? heads : [r]) {
      const hStale = Math.max(0, Math.floor((Date.parse(input.at) - Date.parse(h.observedAt)) / 1000)) >= input.thresholds.syncLagWarnSeconds;
      if (hStale) allFreshCan = false; else if (!boxCanRecordSales(h.disk)) { anyFreshCannot = true; allFreshCan = false; }
    }
    // OB-101: the disk's growth from THIS store computer's own reports only.
    const estimateOf = (h: BoxHealthRecord): TradingHoursEstimate => (view === undefined ? estimateTradingHoursLeft(input.records.filter((x) => x.reportedBy === h.reportedBy), h) : view.estimate(h));
    const estimate = estimateOf(r);
    const estimateSays = estimate.known
      ? `about ${estimate.hoursLeft} hours of trading left before it would refuse a sale (the sales log grew ${mb(estimate.bytesPerTradingHour)} per trading hour over ${estimate.tradingMinutesCounted} minutes of trading in its reports since ${estimate.from}; ${mb(estimate.roomLeftBytes)} of room left above the reserve)`
      : estimate.why;
    const staleNote = `STALE — store ${storeId}'s computer last reported ${ago(ageSeconds)} ago (${r.observedAt}); it has not been heard from since, so this is old news, not the state now`;
    // Verifier r21 UNSENT-CEILING (b): bills held on the box past the owner's line are a finding of their own.
    const waiting = billsWaitingOnTheBox({
      records: input.records, storeId, at: input.at, ...(input.unsentWarnHours === undefined ? {} : { warnHours: input.unsentWarnHours }),
      ...(input.replacements === undefined ? {} : { replacements: input.replacements }),
      ...(view === undefined ? {} : { facts: view.waiting(storeId) }),
    });
    const findings = [...(input.billNumberFindings?.get(storeId) ?? []), ...waiting];
    boxes.push({
      storeId, state: 'reported', lastReportAt: r.observedAt, ageSeconds, stale, canRecordSales: can, disk: r.disk, queue: r.queue, tills: r.tills,
      tradingHoursLeft: estimate.known ? estimate.hoursLeft : null, tradingHoursLeftSays: estimateSays,
      billNumbering: r.billNumbering ?? null, billNumberFindings: findings, computer: r.reportedBy,
      ...(otherComputers.length === 0 ? {} : { otherComputers }), ...(unusedDays.length === 0 ? {} : { unusedNumbers: unusedDays }),
      ...(several ? {
        canRecordSales: heads.every((h) => boxCanRecordSales(h.disk)),
        boundComputers: heads.map((h) => {
          const e = estimateOf(h);
          return {
            computer: h.reportedBy, prefixes: prefixesOf(storeId, h.reportedBy), lastReportAt: h.observedAt,
            stale: Math.max(0, Math.floor((Date.parse(input.at) - Date.parse(h.observedAt)) / 1000)) >= input.thresholds.syncLagWarnSeconds,
            canRecordSales: boxCanRecordSales(h.disk), tradingHoursLeft: e.known ? e.hoursLeft : null, queue: h.queue,
          };
        }),
      } : {}),
    });
    // Round 27 · OB-100 "A" (verifier r26 NEW-1): numbers the store computer took and never used — SHOWN, per till and day,
    // neutrally: information (an abandoned bill, a card declined after the number was taken), nothing to look for (OB-94).
    if (unusedDays.length > 0) {
      components.push({
        name: `box_unused_numbers:${storeId}`, status: 'ok',
        detail: `taken but never used (information — nothing to look for): store ${storeId}'s computer says these bill numbers were given and never put on a bill — ${unusedDays.map((d) => `till ${d.prefix} on ${d.day}: ${d.count} number(s), ${rangeWords(d.prefix, d.ranges)}${d.moreRanges > 0 ? ` and ${d.moreRanges} more range(s)` : ''}`).join('; ')}. A bill abandoned at the till or a card declined after the number was taken keeps its number; if one day shows many, ask the store why${(input.unusedCapped?.get(storeId) ?? []).map((c) => (cappedWords(c) === '' ? '' : `. Under ${c.prefix}:${cappedWords(c).replace(/\.$/, '')}`)).join('')}`,
        evidence: { days: unusedDays.length, numbers: unusedDays.reduce((n, d) => n + d.count, 0), byTillAndDay: unusedDays.map((d) => `${d.prefix}@${d.day}:${d.count}`).join(',') },
      });
    }
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
    // One store computer's disk and queue, judged on its own report (OB-107: each bound computer; one, as before: `r`).
    const diskOf = (h: BoxHealthRecord): { status: HealthStatus; says: string; evidence: Record<string, string | number> } => {
      const hAge = Math.max(0, Math.floor((Date.parse(input.at) - Date.parse(h.observedAt)) / 1000));
      const hStale = hAge >= input.thresholds.syncLagWarnSeconds;
      const hCan = boxCanRecordSales(h.disk);
      const e = h === r ? estimate : estimateOf(h);
      const eSays = h === r ? estimateSays : e.known
        ? `about ${e.hoursLeft} hours of trading left before it would refuse a sale (the sales log grew ${mb(e.bytesPerTradingHour)} per trading hour over ${e.tradingMinutesCounted} minutes of trading in its reports since ${e.from}; ${mb(e.roomLeftBytes)} of room left above the reserve)`
        : e.why;
      const hRunningOut = hCan && e.known && e.hoursLeft < warnHours;
      const hStaleNote = `STALE — store ${storeId}'s computer last reported ${ago(hAge)} ago (${h.observedAt}); it has not been heard from since, so this is old news, not the state now`;
      const headroom = Math.max(0, h.disk.salesLogCapacityBytes - h.disk.salesLogUsedBytes - h.disk.reserveBytes);
      const diskSays = hRunningOut
        ? `store ${storeId}'s computer will run out of room for sales soon — ${eSays}, below the owner's warning line of ${warnHours} hours. Make room on it (or give it a bigger disk) before the tills have to refuse sales`
        : hCan
        ? `store ${storeId}'s computer can record sales: ${mb(h.disk.freeBytes)} free of ${mb(h.disk.totalBytes)}, ${mb(headroom)} of sales-log room left above the reserve; ${eSays}`
        : `store ${storeId}'s computer CANNOT record another sale — its disk is full (${mb(h.disk.freeBytes)} free; sales log ${mb(h.disk.salesLogUsedBytes)} of ${mb(h.disk.salesLogCapacityBytes)} with a ${mb(h.disk.reserveBytes)} reserve). Its tills refuse sales until room is made`;
      return {
        // OB-78: a fresh report whose hours of trading left are under the owner's line is `degraded` (the early warning); a
        // stale report stays `unknown` (old news never raises or clears the warning); a full disk is `down` as before.
        // Round 14 (verifier G8 · P-08): a disk that can record sales but whose hours left are not yet known reads `unknown`
        // with the reason — not a plain "ok", and not the warning either.
        status: hStale ? 'unknown' : !hCan ? 'down' : hRunningOut ? 'degraded' : e.known ? 'ok' : 'unknown',
        says: hStale ? `${hStaleNote}. Then: ${diskSays}` : diskSays,
        evidence: {
          freeBytes: h.disk.freeBytes, totalBytes: h.disk.totalBytes, salesLogHeadroomBytes: headroom, reportedAt: h.observedAt, ageSeconds: hAge,
          tradingHoursLeft: e.known ? e.hoursLeft : 'not yet known', warnBelowTradingHours: warnHours,
        },
      };
    };
    const queueOf = (h: BoxHealthRecord, pastLine: readonly BillNumberFinding[]): { status: HealthStatus; says: string; evidence: Record<string, string | number> } => {
      const hAge = Math.max(0, Math.floor((Date.parse(input.at) - Date.parse(h.observedAt)) / 1000));
      const hStale = hAge >= input.thresholds.syncLagWarnSeconds;
      const hStaleNote = `STALE — store ${storeId}'s computer last reported ${ago(hAge)} ago (${h.observedAt}); it has not been heard from since, so this is old news, not the state now`;
      const q = h.queue;
      // Verifier r21 UNSENT-CEILING: the box's per-prefix lists count too — a report whose lists say bills are waiting never
      // reads "has sent everything", and one that contradicts its own queue, or holds bills past the owner's line, is a warning.
      const issued = h.receiptNumbersIssued ?? [];
      const billsWaiting = issued.reduce((n, x) => n + (x.unsent?.count ?? 0), 0);
      const billsGivenUp = issued.reduce((n, x) => n + (x.deadLettered?.count ?? 0), 0);
      const contradiction = h.queueContradiction ?? (h.receiptNumbersIssued === undefined ? undefined : queueContradiction(q, h.receiptNumbersIssued));
      const qStatus: HealthStatus = q.deadLettered >= input.thresholds.deadLetterCritical && q.deadLettered > 0 ? 'down'
        : q.unsent >= input.thresholds.queueDepthCritical ? 'down'
          : q.unsent >= input.thresholds.queueDepthWarn || q.deadLettered > 0 || pastLine.length > 0 || contradiction !== undefined ? 'degraded' : 'ok';
      const waitingSays = pastLine.map((f) => f.detail).join('. ');
      const qSays = contradiction !== undefined
        ? `store ${storeId}'s computer's report contradicts itself — ${contradiction}; head office does not believe its list of bills still to send`
        : q.unsent === 0 && q.deadLettered === 0 && billsWaiting === 0 && billsGivenUp === 0 ? `store ${storeId}'s computer has sent everything`
          : `store ${storeId}'s computer holds ${q.unsent} item(s) still to send${billsWaiting > 0 ? ` (${billsWaiting} of them bills)` : ''}${q.deadLettered > 0 ? ` and ${q.deadLettered} item(s) it gave up sending, waiting for a person (do NOT re-enter those bills from paper)` : ''}${waitingSays === '' ? '' : `. ${waitingSays}`}`;
      return {
        status: hStale ? (pastLine.length > 0 || contradiction !== undefined ? 'degraded' : 'unknown') : qStatus,
        says: hStale ? `${hStaleNote}. Then: ${qSays}` : qSays,
        evidence: { unsent: q.unsent, deadLettered: q.deadLettered, billsWaiting, billsGivenUp, waitingPastLine: pastLine.length, contradicts: contradiction ?? '', reportedAt: h.observedAt, ageSeconds: hAge },
      };
    };
    if (!several) {
      const d = diskOf(r);
      components.push({
        name: `box_disk:${storeId}`, status: d.status,
        detail: `${d.says}${othersSay}`, evidence: { ...d.evidence, computer: r.reportedBy, otherComputers: otherComputers.map((o) => o.computer).join(',') },
      });
      const qv = queueOf(r, waiting);
      components.push({ name: `box_queue:${storeId}`, status: qv.status, detail: qv.says, evidence: qv.evidence });
    } else {
      // OB-107: each store computer holding the store's tills on its own; the WORSE decides, every one named.
      const holding = heads.map((h) => `${h.reportedBy} (${prefixesOf(storeId, h.reportedBy).join(', ')})`).join(' and ');
      const ds = heads.map((h) => ({ h, ...diskOf(h) }));
      const worstD = ds.reduce((a, b) => ((RANK_OF[b.status] ?? 0) > (RANK_OF[a.status] ?? 0) ? b : a));
      components.push({
        name: `box_disk:${storeId}`, status: worstD.status,
        detail: `store ${storeId} has ${heads.length} store computers holding its tills' bill numbers — ${holding}; head office judges each on its own and the worse decides: ${ds.map((d) => `${d.h.reportedBy}: ${d.says}`).join(' | ')}${othersSay}`,
        evidence: {
          ...worstD.evidence, computer: worstD.h.reportedBy, computers: heads.map((h) => h.reportedBy).join(','),
          statuses: ds.map((d) => `${d.h.reportedBy}:${d.status}`).join(','), otherComputers: otherComputers.map((o) => o.computer).join(','),
        },
      });
      const qs = heads.map((h) => ({ h, ...queueOf(h, []) }));
      const pastLine = waiting.map((f) => f.detail).join('. ');
      const worstQ = qs.reduce((a, b) => ((RANK_OF[b.status] ?? 0) > (RANK_OF[a.status] ?? 0) ? b : a));
      const qStatus: HealthStatus = waiting.length > 0 && (RANK_OF[worstQ.status] ?? 0) < (RANK_OF['degraded'] ?? 0) ? 'degraded' : worstQ.status;
      components.push({
        name: `box_queue:${storeId}`, status: qStatus,
        detail: `store ${storeId} has ${heads.length} store computers holding its tills' bill numbers — ${holding}; each judged on its own, the worse decides: ${qs.map((q) => `${q.h.reportedBy}: ${q.says}`).join(' | ')}${pastLine === '' ? '' : `. ${pastLine}`}`,
        evidence: { ...worstQ.evidence, waitingPastLine: waiting.length, computer: worstQ.h.reportedBy, computers: heads.map((h) => h.reportedBy).join(','), statuses: qs.map((q) => `${q.h.reportedBy}:${q.status}`).join(',') },
      });
    }

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
  /** Round 26 · OB-97: every owner-approved "store computer replaced" act (append-only). Absent: no act has been done. */
  readonly replacements?: (tenantId: string) => Promise<readonly StoreComputerReplacement[]>;
  /** Round 26 · OB-97: the version of a (store, prefix) binding's guard, read before the binding is judged. */
  readonly bindingVersion?: (tenantId: string, storeId: string, prefix: string) => Promise<number>;
  /** Round 26 · OB-97: keeps one act under that guard (throws ConcurrencyConflictError when it moved). Absent: nothing can be replaced here. */
  readonly recordReplacement?: (tenantId: string, m: StoreComputerReplacement, expectedVersion: number) => Promise<StoreComputerReplacement>;
  /** Round 26 · OB-97: the maker-checker engine (the owner's approval of the act). Absent: no act can be approved (fail closed). */
  readonly approvals?: ApprovalPort;
  /**
   * Round 26 · OB-97: each grant through which this person holds `store.computer.replace` (the same shape as
   * `alertAuthorityOf`). Absent: nobody may do the act (fail closed).
   */
  readonly replacementAuthorityOf?: (tenantId: string, userId: string) => Promise<readonly AlertAuthorityGrant[]>;
  /** Round 26 · OB-98: keeps one acknowledgement of a not-checked line (each its own record; a re-sent request answers the first). */
  readonly acknowledgeNotChecked?: (tenantId: string, a: AtRiskAcknowledgement, requestKey: string) => Promise<AtRiskAcknowledgement>;
  /**
   * Round 28 · OB-103: the numbers of the store's "said unused, but head office has the bill" line under the prefix NOW, as the
   * health page shows them (before any acknowledgement silences it), as [from, to] ranges. Absent: nothing can be acknowledged.
   */
  readonly unusedReceivedNow?: (tenantId: string, storeId: string, prefix: string) => Promise<readonly (readonly [number, number])[]>;
  /** Round 28 · OB-103: keeps one acknowledgement of that line (each its own record; a re-sent request answers the first). */
  readonly acknowledgeUnusedReceived?: (tenantId: string, a: UnusedReceivedAcknowledgement, requestKey: string) => Promise<UnusedReceivedAcknowledgement>;
  /** Round 28 · OB-104: the bindings as they stand at `at`, from the saved running result (the page's read) — else worked out from every report. */
  readonly bindingsAt?: (tenantId: string, at: string) => Promise<readonly PrefixBinding[]>;
}

/** Verifier r23 NEW-3 · OB-91: one grant through which a person may manage alerts (see `BoxHealthDeps.alertAuthorityOf`). */
export interface AlertAuthorityGrant {
  readonly roleId: string;
  readonly allStores: boolean;
  /** The platform/IT administration function (the platform administrator, or a role whose whole grant is `platform.*`). */
  readonly platformAdministration: boolean;
}

export const REFUSAL_ACKNOWLEDGEMENTS_PATH = '/v1/store-computers/bill-number-refusals/acknowledgements';
/** Round 26 · OB-97: the head office act "this store computer was replaced" for one till's bill-number prefix. */
export const STORE_COMPUTER_REPLACEMENTS_PATH = '/v1/store-computers/replacements';
/** Round 26 · OB-97: every (store, prefix) binding as it stands, and every act that moved one. */
export const PREFIX_BINDINGS_PATH = '/v1/store-computers/prefix-bindings';
/** Round 26 · OB-98: acknowledging an "at-risk numbers not checked" line. */
export const NOT_CHECKED_ACKNOWLEDGEMENTS_PATH = '/v1/store-computers/at-risk-not-checked/acknowledgements';
/** Round 26 · OB-97: the approval kind on the maker-checker engine (services/identity/src/approval-requests.ts). */
export const STORE_COMPUTER_REPLACED_KIND = 'store_computer_replaced';
/** Round 26 · OB-97: the permission of the act itself (the maker's); the owner's approval is `store.computer.replace.approve`. */
export const STORE_COMPUTER_REPLACE = 'store.computer.replace';

/**
 * OB-88 / OB-91 (and round 26 · OB-97 / OB-98): the caller acts with ALL-STORES authority through a BUSINESS role — the owner,
 * or head office staff given all stores — never only some stores, never the platform/IT administration function. Refused
 * by name otherwise (403, on the audit trail like every request); `words` says what was not done.
 */
async function assertAllStoresBusiness(
  ctx: RequestContext, grantsOf: ((tenantId: string, userId: string) => Promise<readonly AlertAuthorityGrant[]>) | undefined,
  codes: { readonly scope: string; readonly it: string }, words: { readonly act: string; readonly notDone: string; readonly ask: string },
): Promise<void> {
  if (scopeOf(ctx) !== 'all') {
    throw apiError(403, {
      code: codes.scope,
      whatHappened: `Only the owner or head office staff — a person whose authority covers ALL stores — may ${words.act}. This account's authority covers only some stores, so ${words.notDone}.`,
      wasItSaved: 'not_saved', nextSafeAction: `${words.ask} Nothing was recorded.`,
    });
  }
  const grants = grantsOf === undefined ? [] : await grantsOf(ctx.tenantId, ctx.userId);
  if (!grants.some((g) => g.allStores && !g.platformAdministration)) {
    const it = grants.some((g) => g.platformAdministration);
    throw apiError(403, it ? {
      code: codes.it,
      whatHappened: `The platform (IT) administrator looks after the store computers, so may never ${words.act} (owner decisions OB-91 / OB-95) — whatever stores the account covers. So ${words.notDone}.`,
      wasItSaved: 'not_saved', nextSafeAction: `${words.ask} Nothing was recorded.`,
    } : {
      code: codes.scope,
      whatHappened: `Only the owner or head office staff — a person whose business authority covers ALL stores — may ${words.act}. This account holds no such authority, so ${words.notDone}.`,
      wasItSaved: 'not_saved', nextSafeAction: `${words.ask} Nothing was recorded.`,
    });
  }
}

/** Round 29 · verifier r28 NEW-5: an acknowledgement names the numbers the person saw — at most this many [from, to] ranges. */
export const SEEN_RANGES_MAX = 500;
/** The [from, to] ranges an acknowledgement names (whole numbers, from ≤ to, at most SEEN_RANGES_MAX) — undefined when not readable. */
function readSeenRanges(v: unknown): [number, number][] | undefined {
  if (!Array.isArray(v) || v.length === 0 || v.length > SEEN_RANGES_MAX) return undefined;
  const out: [number, number][] = [];
  for (const r of v) {
    if (!Array.isArray(r) || r.length !== 2 || !isCount(r[0]) || !isCount(r[1]) || r[0] > r[1] || r[0] < 1) return undefined;
    out.push([r[0], r[1]]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}
const rangeCount = (ranges: readonly (readonly [number, number])[]): number => joinRuns(ranges).reduce((n, [a, z]) => n + z - a + 1, 0);

/**
 * Round 29 · OB-106: the store computers' saved history is being built (the first read after an upgrade, or after a damaged
 * result was set aside) — the reading is not available YET. Thrown by the adapter's readings for the routes that need them.
 */
export class BoxHistoryPreparing extends Error {
  constructor(readonly since: string, readonly why: string) {
    super(`the store computers' history is being prepared (since ${since}: ${why})`);
    this.name = 'BoxHistoryPreparing';
  }
}
async function preparedOr503<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); } catch (e) {
    if (!(e instanceof BoxHistoryPreparing)) throw e;
    throw apiError(503, {
      code: 'store_computer_checks_being_prepared',
      whatHappened: `Head office is preparing the store computers' saved history (since ${e.since}: ${e.why}) — the store computer checks are not available yet. It is built in the background; nothing is lost and the tills keep selling.`,
      wasItSaved: 'not_saved', nextSafeAction: 'Try again in a few minutes (the health page says when it is ready). Nothing was recorded.',
    }, 60);
  }
}

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
      // OB-94: a second store computer's report of a bound prefix is refused at read (`bindPrefixesToComputers`) — found here too.
      const refusedAt = bindPrefixesToComputers(await deps.records(ctx.tenantId), deps.replacements === undefined ? [] : await deps.replacements(ctx.tenantId)).filter((rec) => rec.storeId === storeId)
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
  }, {
    // Round 26 · OB-97 "B" (owner, 13 Oct 2026, in writing, "Owner-approved 'replaced' act"): a store computer was replaced
    // and the new one has its OWN sign-in. Head office moves the till's bill-number prefix from the old store computer to the
    // new one — so the new one's reports are used, the old one's are refused by name, and lost-bill checks resume for that
    // prefix on the new computer. The MAKER is a head office business person with all-stores authority (never the IT/platform
    // administrator — OB-91/OB-95); the CHECKER is the owner, as a separate act in his own session on the maker-checker
    // engine (kind `store_computer_replaced`; the engine refuses self-approval by name). Append-only; one act per approval.
    // Refused by name (each on the audit trail): a prefix not issued to that store; a sign-in that is not a store computer
    // of that store; a prefix no store computer has reported yet; a prefix not bound to the named old computer any more;
    // a move to the computer it is already bound to; no owner approval, or an approval for anything else.
    api: 'API-11', method: 'POST', path: STORE_COMPUTER_REPLACEMENTS_PATH,
    permission: STORE_COMPUTER_REPLACE, idempotent: true,
    handler: async (ctx) => {
      await assertAllStoresBusiness(ctx, deps.replacementAuthorityOf,
        { scope: 'replacement_needs_all_stores_authority', it: 'replacement_refused_to_platform_administrator' },
        { act: 'move a till\'s bill numbers to a replacement store computer', notDone: 'nothing was moved', ask: 'Ask head office business staff (all stores) to do it, with the owner\'s approval.' });
      const b = isObj(ctx.body) ? ctx.body : {};
      const storeId = b['storeId'];
      const prefix = b['prefix'];
      const fromComputer = b['fromComputer'];
      const toComputer = b['toComputer'];
      const reason = typeof b['reason'] === 'string' ? b['reason'].trim() : '';
      if (!isWord(storeId, 60) || !isWord(prefix, 10) || !isWord(fromComputer, 120) || !isWord(toComputer, 120) || reason.length < 5 || reason.length > 300) {
        throw apiError(400, {
          code: 'not_readable_as_store_computer_replacement',
          whatHappened: 'A "store computer replaced" act needs the store, the till\'s bill-number prefix, the old store computer\'s sign-in (fromComputer), the new one\'s (toComputer), a reason of 5 to 300 characters, and the owner\'s approval (approvalId).',
          wasItSaved: 'not_saved',
          nextSafeAction: 'Send { storeId, prefix, fromComputer, toComputer, reason, approvalId } — ask the owner\'s approval for exactly those first. Nothing was moved.',
        });
      }
      if (deps.records === undefined || deps.recordReplacement === undefined || deps.bindingVersion === undefined || deps.issuedAndBanked === undefined || deps.storeComputerScopeOf === undefined) {
        throw apiError(503, { code: 'replacements_not_kept_here', whatHappened: 'This head office keeps no store computer reports, so no bill-number prefix can be moved here.', wasItSaved: 'not_saved', nextSafeAction: 'Use the head office that keeps the store computers\' reports. Nothing was moved.' });
      }
      // The prefix must be one head office issued to a till of THIS store (receipt-prefixes.ts) — never another store's.
      const { issuedPrefixes } = await deps.issuedAndBanked(ctx.tenantId);
      if (!(issuedPrefixes.get(prefix)?.has(storeId) ?? false)) {
        throw apiError(422, {
          code: 'prefix_not_issued_to_this_store',
          whatHappened: `Head office never issued the bill-number prefix ${prefix} to a till of store ${storeId}, so it cannot be moved to a store computer there.`,
          wasItSaved: 'not_saved', nextSafeAction: 'Copy the prefix exactly as the till prefix page shows it for that store. Nothing was moved.',
        });
      }
      // The new sign-in must be a store computer OF THIS STORE (its `store_computer` grant names this store — OB-54).
      const scope = await deps.storeComputerScopeOf(ctx.tenantId, toComputer);
      if (scope === undefined || scope === 'all' || !scope.includes(storeId)) {
        throw apiError(422, {
          code: 'not_a_store_computer_of_this_store',
          whatHappened: `${toComputer} is not a store computer of store ${storeId} (it holds no store computer role naming that store), so ${prefix} cannot be moved to it.`,
          wasItSaved: 'not_saved', nextSafeAction: 'Give the new store computer its own sign-in for this store first (store computer role, this one store, approved by the owner), then do this. Nothing was moved.',
        });
      }
      // The guard first, then the binding it protects — two acts racing on one prefix cannot both land.
      const version = await deps.bindingVersion(ctx.tenantId, storeId, prefix);
      const at = deps.now();
      const replacements = deps.replacements === undefined ? [] : await deps.replacements(ctx.tenantId);
      const current = prefixBindings(await deps.records(ctx.tenantId), replacements, at).find((x) => x.storeId === storeId && x.prefix === prefix);
      if (current === undefined) {
        throw apiError(422, {
          code: 'prefix_not_bound_yet',
          whatHappened: `No store computer has reported bill numbers under ${prefix} at store ${storeId} yet, so there is nothing to move: the first store computer that reports it is bound to it.`,
          wasItSaved: 'not_saved', nextSafeAction: 'Nothing was moved, and nothing needs to be.',
        });
      }
      if (current.computer === toComputer) {
        throw apiError(409, {
          code: 'already_bound_to_that_computer',
          whatHappened: `${prefix} at store ${storeId} is already bound to ${toComputer} (since ${current.since}).`,
          wasItSaved: 'not_saved', nextSafeAction: 'Nothing was moved, and nothing needs to be.',
        });
      }
      if (current.computer !== fromComputer) {
        throw apiError(409, {
          code: 'prefix_bound_to_another_computer',
          whatHappened: `${prefix} at store ${storeId} is bound to ${current.computer} (since ${current.since}), not to ${fromComputer} — the binding is not what this act (and its approval) says it moves.`,
          wasItSaved: 'not_saved', nextSafeAction: 'Check the store computers on the bindings list, and ask the owner\'s approval for the move as it really is. Nothing was moved.',
        });
      }
      // The owner's approval, on the maker-checker engine: exactly this act, asked by this person, approved by someone else.
      const approval = await approvalNamedIn(deps.approvals, {
        tenantId: ctx.tenantId, approvalId: b['approvalId'], typedField: 'approvedBy', typedValue: b['approvedBy'],
        kind: STORE_COMPUTER_REPLACED_KIND, subjectRef: `${storeId}/${prefix}`, details: actionDetails(b), valueMinor: null,
        maker: ctx.userId, usedBy: `store-computer-replaced:${storeId}:${prefix}:${at}`, now: at,
      });
      if (approval === undefined) {
        throw apiError(422, {
          code: 'owner_approval_needed',
          whatHappened: `Moving ${prefix} at store ${storeId} from ${fromComputer} to ${toComputer} needs the owner's approval (owner decision OB-97), and none was named.`,
          wasItSaved: 'not_saved',
          nextSafeAction: `Ask for approval (POST /v1/approvals/requests, kind ${STORE_COMPUTER_REPLACED_KIND}, subjectRef "${storeId}/${prefix}", details exactly { storeId, prefix, fromComputer, toComputer, reason }); once the owner approves it, send its approvalId. Nothing was moved.`,
        });
      }
      if (approval.decision.decidedBy === ctx.userId) {
        throw apiError(422, { code: 'self_approval', whatHappened: `${ctx.userId} cannot approve their own act (§28).`, wasItSaved: 'not_saved', nextSafeAction: 'The owner must approve it in his own session. Nothing was moved.' });
      }
      await approval.spend();
      const act: StoreComputerReplacement = {
        replacementId: `scr-${(b['approvalId'] as string).trim()}`, storeId, prefix, from: current.computer, to: toComputer, reason,
        requestedBy: ctx.userId, approvedBy: approval.decision.decidedBy, approvalId: (b['approvalId'] as string).trim(), at,
      };
      let kept: StoreComputerReplacement;
      try {
        kept = await deps.recordReplacement(ctx.tenantId, act, version);
      } catch (err) {
        if (err instanceof ConcurrencyConflictError) throw concurrentChange(`the bill-number prefix ${prefix} at store ${storeId}`);
        throw err;
      }
      return { status: 201, body: { replacement: kept, binding: { storeId, prefix, computer: kept.to, since: kept.at, via: 'replacement', replacementId: kept.replacementId } } };
    },
  }, {
    // Round 26 · OB-97: every (store, prefix) binding as it stands now — which store computer's reports head office uses for
    // each till's bill numbers — and every "store computer replaced" act, with who asked and who approved.
    api: 'API-11', method: 'GET', path: PREFIX_BINDINGS_PATH,
    permission: 'platform.health.read',
    handler: async (ctx) => {
      const at = deps.now();
      const replacements = deps.replacements === undefined ? [] : await deps.replacements(ctx.tenantId);
      // Round 28 · OB-104: from the saved running result (the reports after it only) when head office keeps one.
      const bindings = deps.bindingsAt !== undefined ? await preparedOr503(() => deps.bindingsAt!(ctx.tenantId, at))
        : prefixBindings(deps.records === undefined ? [] : await deps.records(ctx.tenantId), replacements, at);
      const inScope = (storeId: string): boolean => { const sc = scopeOf(ctx); return sc === 'all' || sc.includes(storeId); };
      // Round 26 · OB-99: what THIS person may do here, judged by the same rule the acts use (all stores, a business role,
      // never IT) — so the Store computers page offers only what head office would accept. Head office re-checks every act.
      const allStoresBusiness = async (grantsOf: BoxHealthDeps['alertAuthorityOf']): Promise<boolean> =>
        scopeOf(ctx) === 'all' && (grantsOf === undefined ? [] : await grantsOf(ctx.tenantId, ctx.userId)).some((g) => g.allStores && !g.platformAdministration);
      return {
        status: 200,
        body: {
          bindings: bindings.filter((x) => inScope(x.storeId)),
          replacements: [...replacements].filter((m) => inScope(m.storeId)).sort((a, z) => Date.parse(a.at) - Date.parse(z.at)),
          you: { mayReplace: await allStoresBusiness(deps.replacementAuthorityOf), mayAcknowledge: await allStoresBusiness(deps.alertAuthorityOf) },
          asAt: at,
        },
      };
    },
  }, {
    // Round 26 · OB-98 "B" (owner, 13 Oct 2026, in writing, "You/HO acknowledge it"): the owner or head office business staff
    // (all stores, never IT — the same authority as a refused report's acknowledgement, OB-88/OB-91) acknowledge the "at-risk
    // numbers not checked" line, with a reason. Who, when and why are kept (each acknowledgement its own record); it holds
    // until the store computer reports a DIFFERENT set of not-checked numbers for that prefix (`atRiskAcknowledgementStands`).
    api: 'API-11', method: 'POST', path: NOT_CHECKED_ACKNOWLEDGEMENTS_PATH,
    permission: 'platform.alert.manage', idempotent: true,
    handler: async (ctx) => {
      await assertAllStoresBusiness(ctx, deps.alertAuthorityOf,
        { scope: 'acknowledgement_needs_all_stores_authority', it: 'acknowledgement_refused_to_platform_administrator' },
        { act: 'acknowledge that a store computer\'s older at-risk bill numbers were not checked', notDone: 'nothing was acknowledged and the warning stays', ask: 'Ask the owner or head office to acknowledge it, with the reason, once support has compared the restore record.' });
      const b = isObj(ctx.body) ? ctx.body : {};
      const storeId = b['storeId'];
      const prefix = b['prefix'];
      const count = b['count'];
      const seen = readSeenRanges(b['numbers']);
      const reason = typeof b['reason'] === 'string' ? b['reason'].trim() : '';
      if (!isWord(storeId, 60) || !isWord(prefix, 10) || seen === undefined || (count !== undefined && (!isCount(count) || count !== rangeCount(seen))) || reason.length < 5 || reason.length > 300) {
        throw apiError(400, {
          code: 'not_readable_as_acknowledgement',
          whatHappened: `An acknowledgement of a not-checked line needs the store, the bill-number prefix, the numbers not checked exactly as the health page showed them (numbers: [[from, to], …], at most ${SEEN_RANGES_MAX} ranges; a count, if sent, must match them) and a reason of 5 to 300 characters.`,
          wasItSaved: 'not_saved',
          nextSafeAction: 'Send { storeId, prefix, numbers, reason } as shown on the health page. Nothing was recorded.',
        });
      }
      if (deps.records === undefined || deps.acknowledgeNotChecked === undefined) {
        throw apiError(503, { code: 'acknowledgements_not_kept_here', whatHappened: 'This head office keeps no store computer reports, so there is nothing to acknowledge.', wasItSaved: 'not_saved', nextSafeAction: 'Use the head office that keeps the store computers\' reports. Nothing was recorded.' });
      }
      const at = deps.now();
      const atMs = Date.parse(at);
      // The store computer's latest word about the prefix, as bound (OB-94 / OB-97) — what the health page shows.
      const replacements = deps.replacements === undefined ? [] : await deps.replacements(ctx.tenantId);
      let latest: IssuedReport | undefined;
      for (const rec of bindInOrder((await deps.records(ctx.tenantId)).filter((r) => r.storeId === storeId && Date.parse(r.receivedAt) <= atMs), atOrBefore(replacements, atMs))) {
        latest = (rec.receiptNumbersIssued ?? []).find((x) => x.prefix === prefix) ?? latest;
      }
      const notChecked = atRiskNotChecked(latest?.atRisk);
      const now = notChecked.reduce((n, [a, z]) => n + z - a + 1, 0);
      if (now === 0) {
        throw apiError(404, {
          code: 'no_such_not_checked_finding',
          whatHappened: `Store ${storeId}'s computer's latest report under ${prefix} names no at-risk numbers left unchecked, so there is nothing to acknowledge.`,
          wasItSaved: 'not_saved', nextSafeAction: 'Copy the store and prefix exactly as the health page shows the not-checked line. Nothing was recorded.',
        });
      }
      // Round 29 · verifier r28 NEW-5: the EXACT numbers the person saw — not only how many — or nothing is recorded.
      if (runsKey(joinRuns(seen)) !== runsKey(joinRuns(notChecked))) {
        throw apiError(409, {
          code: 'not_checked_set_changed',
          whatHappened: `Store ${storeId}'s computer's latest report under ${prefix} now leaves ${now} at-risk number(s) unchecked (${rangeWords(prefix, joinRuns(notChecked))}), not the ${rangeCount(seen)} acknowledged (${rangeWords(prefix, joinRuns(seen))}) — the line changed since it was read.`,
          wasItSaved: 'not_saved', nextSafeAction: 'Reload the health page, look at the line as it is now, and acknowledge that. Nothing was recorded.',
        });
      }
      const kept = await deps.acknowledgeNotChecked(ctx.tenantId, { storeId, prefix, notChecked, count: now, reason, by: ctx.userId, at, authority: 'all_stores' }, ctx.idempotencyKey ?? `${ctx.userId}@${at}`);
      return { status: 201, body: { acknowledged: kept } };
    },
  }, {
    // Round 28 · OB-103 "A" (owner, 13 Oct 2026, in writing, "You/HO acknowledge"): the owner or head office business staff
    // (all stores, never IT — the same authority as a refused report's and a not-checked line's, OB-88/OB-91/OB-98) acknowledge
    // the "said unused, but head office has the bill" line, with a reason, once support has checked the store computer. Who,
    // when and why are kept (each acknowledgement its own record, never removed); it holds while head office finds the SAME
    // set of numbers (`unusedReceivedAcknowledgementStands`) — a new number needs a new acknowledgement. Refused by name (each
    // on the audit trail like every request): a store-scoped account, the IT/platform administrator, no such line, a line
    // that changed since it was read.
    api: 'API-11', method: 'POST', path: UNUSED_RECEIVED_ACKNOWLEDGEMENTS_PATH,
    permission: 'platform.alert.manage', idempotent: true,
    handler: async (ctx) => {
      await assertAllStoresBusiness(ctx, deps.alertAuthorityOf,
        { scope: 'acknowledgement_needs_all_stores_authority', it: 'acknowledgement_refused_to_platform_administrator' },
        { act: 'acknowledge that a store computer called a bill number unused after head office received the bill', notDone: 'nothing was acknowledged and the warning stays', ask: 'Ask the owner or head office to acknowledge it, with the reason, once support has checked the store computer.' });
      const b = isObj(ctx.body) ? ctx.body : {};
      const storeId = b['storeId'];
      const prefix = b['prefix'];
      const count = b['count'];
      const seen = readSeenRanges(b['numbers']);
      const reason = typeof b['reason'] === 'string' ? b['reason'].trim() : '';
      if (!isWord(storeId, 60) || !isWord(prefix, 10) || seen === undefined || (count !== undefined && (!isCount(count) || count !== rangeCount(seen))) || reason.length < 5 || reason.length > 300) {
        throw apiError(400, {
          code: 'not_readable_as_acknowledgement',
          whatHappened: `An acknowledgement of a "said unused, but head office has the bill" line needs the store, the bill-number prefix, the numbers exactly as the line showed them (numbers: [[from, to], …], at most ${SEEN_RANGES_MAX} ranges; a count, if sent, must match them) and a reason of 5 to 300 characters.`,
          wasItSaved: 'not_saved',
          nextSafeAction: 'Send { storeId, prefix, numbers, reason } as shown on the Store computers page. Nothing was recorded.',
        });
      }
      if (deps.unusedReceivedNow === undefined || deps.acknowledgeUnusedReceived === undefined) {
        throw apiError(503, { code: 'acknowledgements_not_kept_here', whatHappened: 'This head office keeps no store computer reports, so there is nothing to acknowledge.', wasItSaved: 'not_saved', nextSafeAction: 'Use the head office that keeps the store computers\' reports. Nothing was recorded.' });
      }
      const at = deps.now();
      // The line as head office finds it now — what the health page shows (before any acknowledgement silences it).
      const numbers = joinRuns(await preparedOr503(() => deps.unusedReceivedNow!(ctx.tenantId, storeId, prefix)));
      const now = numbers.reduce((n, [a, z]) => n + z - a + 1, 0);
      if (now === 0) {
        throw apiError(404, {
          code: 'no_such_unused_received_finding',
          whatHappened: `Head office finds no bill number under ${prefix} that store ${storeId}'s computer called unused after head office received its bill, so there is nothing to acknowledge.`,
          wasItSaved: 'not_saved', nextSafeAction: 'Copy the store and prefix exactly as the Store computers page shows the line. Nothing was recorded.',
        });
      }
      // Round 29 · verifier r28 NEW-5: the EXACT numbers the person saw — not only how many — or nothing is recorded.
      if (runsKey(joinRuns(seen)) !== runsKey(numbers)) {
        throw apiError(409, {
          code: 'unused_received_set_changed',
          whatHappened: `Under ${prefix}, head office now finds ${now} number(s) store ${storeId}'s computer called unused after head office received the bill (${rangeWords(prefix, numbers)}), not the ${rangeCount(seen)} acknowledged (${rangeWords(prefix, joinRuns(seen))}) — the line changed since it was read.`,
          wasItSaved: 'not_saved', nextSafeAction: 'Reload the Store computers page, look at the line as it is now, and acknowledge that. Nothing was recorded.',
        });
      }
      const kept = await deps.acknowledgeUnusedReceived(ctx.tenantId, { storeId, prefix, numbers, count: now, reason, by: ctx.userId, at, authority: 'all_stores' }, ctx.idempotencyKey ?? `${ctx.userId}@${at}`);
      return { status: 201, body: { acknowledged: kept } };
    },
  }];
}
