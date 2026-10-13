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
}): BillNumberFinding[] {
  const warnHours = input.warnHours ?? DEFAULT_BOX_UNSENT_WARN_HOURS;
  const atMs = Date.parse(input.at);
  // OB-94: only the bound store computer's word about a prefix counts (`bindPrefixesToComputers`); OB-97: as replaced.
  const mine = bindInOrder(input.records.filter((r) => r.storeId === input.storeId && Date.parse(r.receivedAt) <= atMs), atOrBefore(input.replacements, atMs)).map(believedRecord);
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
const FOLD_SNAPSHOT_VERSION = 2;

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
    for (let k = this.actsApplied.length; k < acts.length && acts[k]!.ms <= ms; k += 1) { applyAct(this.bound, acts[k]!.m); this.actsApplied.push(acts[k]!.m.replacementId); }
  }

  feed(raw0: BoxHealthRecord, ms: number, acts: readonly SortedAct[], bankedOf: (prefix: string) => number): void {
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
          above: newTrack(), aboveFrom: bankedOf(x.prefix), risk: newTrack(), unused: [], unusedList: undefined, unusedListMs: -Infinity,
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
   * every count keeps the latest HOUR it was said (UNUSED_SAID_HOUR: the store computer's report time, rounded DOWN to the
   * hour — never later than it was said). A list repeated word for word within the same hour changes nothing.
   */
  private noteUnused(cur: FoldKey, list: readonly (readonly [number, number])[] | undefined, observedMs: number, ms: number): void {
    const said = list ?? NO_RUNS;
    const hour = Math.floor(observedMs / UNUSED_SAID_HOUR) * UNUSED_SAID_HOUR;
    if (sameRanges(cur.unusedList ?? NO_RUNS, said) && (said.length === 0 || hour <= cur.unusedListMs)) return;
    if (said.length > 0) cur.unused = layUnused(cur.unused, said, this.day(ms), hour);
    cur.unusedList = said.length === 0 ? undefined : said;
    cur.unusedListMs = said.length === 0 ? -Infinity : Math.max(hour, cur.unusedListMs);
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
      });
    }
    return f;
  }
}

/** Round 27 · OB-100: the latest time a number was said unused is kept to the hour, rounded down (see `noteUnused`). */
const UNUSED_SAID_HOUR = 3_600_000;

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
}): BillNumberFinding[] {
  const out: BillNumberFinding[] = [];
  const atMs = Date.parse(input.at);
  const replacements = atOrBefore(input.replacements, atMs);
  // OB-94: a second store computer's word about a bound prefix is refused (and said below), never read as the box's.
  const mine = bindInOrder(input.records.filter((r) => r.storeId === input.storeId && Date.parse(r.receivedAt) <= atMs), replacements);
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
  // Round 25 · OB-96: numbers the latest report cannot vouch for, beyond the newest UNRECEIVED_CHECK_CAP head office checks
  // one by one per report — never dropped in silence. Round 26 · OB-98: unless acknowledged (`atRiskAcknowledgementStands`).
  for (const [prefix, { x, r }] of [...lastByPrefix].sort((a, b) => a[0].localeCompare(b[0]))) {
    const { ranges: checked, unchecked } = atRiskExamined(x.atRisk);
    if (unchecked === 0) continue;
    if (atRiskAcknowledgementStands(input.storeId, prefix, mine, input.atRiskAcknowledged ?? [])) continue;
    const below = checked[0]![0];
    out.push({
      kind: 'at_risk_not_checked', prefix, count: unchecked, ranges: atRiskNotChecked(x.atRisk), since: r.receivedAt,
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
    const first = sorted.reduce((a, b) => (Date.parse(b.heldAt) < Date.parse(a.heldAt) ? b : a));
    const sales = sorted.filter((u) => u.heldAs === 'sale').length;
    const said = sorted.map((u) => u.lastSaidUnusedAt).sort().at(-1)!;
    const one = sorted.length === 1;
    out.push({
      kind: 'unused_number_received', prefix, ranges, count: sorted.length, since: first.heldAt,
      detail: `does not fit: store ${input.storeId}'s computer said (last at ${said}) that it gave ${rangeWords(prefix, ranges)} and never put ${one ? 'it' : 'them'} on a bill, but head office holds ${sales === sorted.length ? (one ? 'a sale' : 'sales') : sales === 0 ? (one ? 'a return' : 'returns') : 'sales and returns'} under ${one ? 'that number' : 'those numbers'}, made before that (the first at ${first.heldAt}, ${prefix}${pad6(first.number)}). A number put on a bill is never "unused" afterwards. Nothing is missing — head office has ${one ? 'the bill' : 'the bills'}, so do NOT look for paper bills — but the store computer's list of unused numbers under ${prefix} cannot be relied on: call support to check that store computer (the store computer or head office lost track; no blame is placed, as owner decision OB-92). ${UNUSED_RECEIVED_STAYS_WORDS}`,
    });
  }
  out.push(...refusedReportFindings(input.storeId, mine, input.banked, input.acknowledged ?? [], replacements));
  return out;
}

/** Round 27 · OB-100: how long an "unused but received" finding stays (the health page's words). */
export const UNUSED_RECEIVED_STAYS_WORDS = 'This stays while head office holds that bill and the store computer\'s word that it was never used stands (both are kept for good); how it is cleared is an owner decision still to be made';

/**
 * Round 27 · OB-100 — THE RULE (stated, so a person can check it by hand): a number a store computer said it gave and never
 * put on a bill is a contradiction when head office HOLDS a sale (its receipt-number index) or a return under it, AND the
 * store computer said "never used" more than UNUSED_CONTRADICTION_MARGIN_MINUTES after that bill was made (its report's hour,
 * rounded DOWN — so an "unused" said in the same hour as the bill is never held against the store computer). An
 * honest store computer lists a number as unused only until a bill takes it (a held bill completed later — verifier r26
 * P5-new): the bill is made after the last "unused", so it never fits this rule. The margin allows for the till's and the
 * store computer's clocks differing a little.
 */
export const UNUSED_CONTRADICTION_MARGIN_MINUTES = 15;
export interface UnusedReceived { readonly prefix: string; readonly number: number; readonly heldAs: 'sale' | 'return'; readonly heldAt: string; readonly lastSaidUnusedAt: string }
export function unusedButReceived(prefix: string, unused: UnusedNumbers | undefined, held: ReadonlyMap<number, { readonly as: 'sale' | 'return'; readonly at: string }>): UnusedReceived[] {
  const out: UnusedReceived[] = [];
  if (held.size === 0) return out;
  for (const run of unused?.runs ?? []) {
    for (const [n, h] of held) {
      if (n < run.from || n > run.to) continue;
      if (Date.parse(run.lastSaidAt) > Date.parse(h.at) + UNUSED_CONTRADICTION_MARGIN_MINUTES * 60_000) {
        out.push({ prefix, number: n, heldAs: h.as, heldAt: h.at, lastSaidUnusedAt: run.lastSaidAt });
      }
    }
  }
  return out.sort((a, b) => a.number - b.number);
}

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
function refusedReportFindings(
  storeId: string, mine: readonly BoxHealthRecord[], banked: ReadonlyMap<string, number> | undefined, acknowledged: readonly RefusalAcknowledgement[],
  replacements: readonly StoreComputerReplacement[] = [],
): BillNumberFinding[] {
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
      // OB-94: a second store computer's report is never "made true" by head office's banking — only a person clears it.
      const resolved = (r.because !== 'prefix_of_another_store_computer' && banked !== undefined && (banked.get(prefix) ?? 0) >= r.through)
        || Date.parse(x.at) <= (seenUpTo.get(r.through) ?? -Infinity) || standing === r.through
        // Round 26 · OB-97: the replacement store computer's reports from BEFORE the owner approved moving the prefix to it
        // are answered by that act (the owner looked at exactly this machine) — never the old computer's, never later ones.
        || (r.because === 'prefix_of_another_store_computer' && (latestActTo.get(`${prefix}\u0000${x.by}`) ?? -Infinity) >= Date.parse(x.at));
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
    .sort((a, b) => a.o - b.o || a.v - b.v).map(({ r }) => r);
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
  /** Round 26 · OB-97: owner-approved "store computer replaced" acts (the binding follows them). */
  readonly replacements?: readonly StoreComputerReplacement[];
  /** Round 27 · OB-101: the (store, prefix) bindings as they stand at `at` — worked out from the reports when not given. */
  readonly bindings?: readonly PrefixBinding[];
  /** Round 27 · OB-100: each store's unused numbers (`readNeverReceived(...).unused`) — worked out from the reports when not given. */
  readonly unusedNumbers?: ReadonlyMap<string, readonly UnusedNumbers[]>;
  /** The store's own time zone (its calendar days), for unused numbers worked out here. */
  readonly timeZone?: string;
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
  const isBound = (r: BoxHealthRecord): boolean => { const set = boundTo.get(r.storeId); return set === undefined || set.has(r.reportedBy); };
  const latest = latestBoxReports(input.records.filter(isBound));
  const others = new Map<string, Map<string, BoxHealthRecord>>();
  for (const r of input.records) {
    if (isBound(r) || Date.parse(r.receivedAt) > Date.parse(input.at)) continue;
    const per = others.get(r.storeId) ?? new Map<string, BoxHealthRecord>();
    const cur = per.get(r.reportedBy);
    if (cur === undefined || Date.parse(r.observedAt) > Date.parse(cur.observedAt) || (r.observedAt === cur.observedAt && Date.parse(r.receivedAt) >= Date.parse(cur.receivedAt))) per.set(r.reportedBy, r);
    others.set(r.storeId, per);
  }
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
    if (stale) allFreshCan = false; else if (!can) { anyFreshCannot = true; allFreshCan = false; }
    // OB-101: the disk's growth from THIS store computer's own reports only.
    const estimate = estimateTradingHoursLeft(input.records.filter((x) => x.reportedBy === r.reportedBy), r);
    const estimateSays = estimate.known
      ? `about ${estimate.hoursLeft} hours of trading left before it would refuse a sale (the sales log grew ${mb(estimate.bytesPerTradingHour)} per trading hour over ${estimate.tradingMinutesCounted} minutes of trading in its reports since ${estimate.from}; ${mb(estimate.roomLeftBytes)} of room left above the reserve)`
      : estimate.why;
    const runningOut = can && estimate.known && estimate.hoursLeft < warnHours;
    const staleNote = `STALE — store ${storeId}'s computer last reported ${ago(ageSeconds)} ago (${r.observedAt}); it has not been heard from since, so this is old news, not the state now`;
    // Verifier r21 UNSENT-CEILING (b): bills held on the box past the owner's line are a finding of their own.
    const waiting = billsWaitingOnTheBox({
      records: input.records, storeId, at: input.at, ...(input.unsentWarnHours === undefined ? {} : { warnHours: input.unsentWarnHours }),
      ...(input.replacements === undefined ? {} : { replacements: input.replacements }),
    });
    const findings = [...(input.billNumberFindings?.get(storeId) ?? []), ...waiting];
    boxes.push({
      storeId, state: 'reported', lastReportAt: r.observedAt, ageSeconds, stale, canRecordSales: can, disk: r.disk, queue: r.queue, tills: r.tills,
      tradingHoursLeft: estimate.known ? estimate.hoursLeft : null, tradingHoursLeftSays: estimateSays,
      billNumbering: r.billNumbering ?? null, billNumberFindings: findings, computer: r.reportedBy,
      ...(otherComputers.length === 0 ? {} : { otherComputers }), ...(unusedDays.length === 0 ? {} : { unusedNumbers: unusedDays }),
    });
    // Round 27 · OB-100 "A" (verifier r26 NEW-1): numbers the store computer took and never used — SHOWN, per till and day,
    // neutrally: information (an abandoned bill, a card declined after the number was taken), nothing to look for (OB-94).
    if (unusedDays.length > 0) {
      components.push({
        name: `box_unused_numbers:${storeId}`, status: 'ok',
        detail: `taken but never used (information — nothing to look for): store ${storeId}'s computer says these bill numbers were given and never put on a bill — ${unusedDays.map((d) => `till ${d.prefix} on ${d.day}: ${d.count} number(s), ${rangeWords(d.prefix, d.ranges)}${d.moreRanges > 0 ? ` and ${d.moreRanges} more range(s)` : ''}`).join('; ')}. A bill abandoned at the till or a card declined after the number was taken keeps its number; if one day shows many, ask the store why`,
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
      detail: `${stale ? `${staleNote}. Then: ${diskSays}` : diskSays}${othersSay}`, evidence: { ...diskEvidence, computer: r.reportedBy, otherComputers: otherComputers.map((o) => o.computer).join(',') },
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
      const records = deps.records === undefined ? [] : await deps.records(ctx.tenantId);
      const replacements = deps.replacements === undefined ? [] : await deps.replacements(ctx.tenantId);
      const inScope = (storeId: string): boolean => { const sc = scopeOf(ctx); return sc === 'all' || sc.includes(storeId); };
      // Round 26 · OB-99: what THIS person may do here, judged by the same rule the acts use (all stores, a business role,
      // never IT) — so the Store computers page offers only what head office would accept. Head office re-checks every act.
      const allStoresBusiness = async (grantsOf: BoxHealthDeps['alertAuthorityOf']): Promise<boolean> =>
        scopeOf(ctx) === 'all' && (grantsOf === undefined ? [] : await grantsOf(ctx.tenantId, ctx.userId)).some((g) => g.allStores && !g.platformAdministration);
      return {
        status: 200,
        body: {
          bindings: prefixBindings(records, replacements, at).filter((x) => inScope(x.storeId)),
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
      const reason = typeof b['reason'] === 'string' ? b['reason'].trim() : '';
      if (!isWord(storeId, 60) || !isWord(prefix, 10) || !isCount(count) || count < 1 || reason.length < 5 || reason.length > 300) {
        throw apiError(400, {
          code: 'not_readable_as_acknowledgement',
          whatHappened: 'An acknowledgement of a not-checked line needs the store, the bill-number prefix, how many numbers were not checked (count) and a reason of 5 to 300 characters.',
          wasItSaved: 'not_saved',
          nextSafeAction: 'Send { storeId, prefix, count, reason } as shown on the health page. Nothing was recorded.',
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
      if (now !== count) {
        throw apiError(409, {
          code: 'not_checked_set_changed',
          whatHappened: `Store ${storeId}'s computer's latest report under ${prefix} now leaves ${now} at-risk number(s) unchecked, not the ${count} acknowledged — the line changed since it was read.`,
          wasItSaved: 'not_saved', nextSafeAction: 'Reload the health page, look at the line as it is now, and acknowledge that. Nothing was recorded.',
        });
      }
      const kept = await deps.acknowledgeNotChecked(ctx.tenantId, { storeId, prefix, notChecked, count, reason, by: ctx.userId, at, authority: 'all_stores' }, ctx.idempotencyKey ?? `${ctx.userId}@${at}`);
      return { status: 201, body: { acknowledged: kept } };
    },
  }];
}
