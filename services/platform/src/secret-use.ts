// W6 · M32-FR-03 ("abnormal usage alerts") · owner decision OB-688: abnormal secret use is detected from a DURABLE DAILY COUNT.
//
// What "a secret's use" is here: every authenticated head-office API call made with a MACHINE credential — the signed token
// a store computer, the backup job, the message-provider relay, the CI scanner, the release script or the floor-device
// gateway signs in with. Each call is one use of THAT credential, counted per caller (the signed caller id), per API (the
// route's catalogue id) and per shop day, by the credential's REFERENCE id (the token's own id, `jti`). A person's sign-in
// is not counted: it is a session, not a kept secret. Nothing here can hold a secret value, a token or a key — the types
// have no field for one (hard rule #4; a guardrail reads these types).
//
//   • COUNT — the kernel tells the counter of each call on the way out; head office appends the day's counts to its
//     append-only ledger (hard rule #2): a count is never overwritten, a day's total is the sum of what was appended.
//   • ROLL UP, ONCE A DAY — the nightly sweep judges each finished shop day, ONCE (the roll-up is keyed on the day, so a
//     second pass never doubles it), and catches up every day it missed (a night the head office was down).
//   • "CHANGES SHARPLY" — the usage-signals route's OWN rule (`usageSignalsOf`, the tested `findUsageSignals`): a caller far
//     above its baseline, an error surge, a caller gone quiet, a caller with no history. The baseline is the SAME WEEKDAY A
//     WEEK BEFORE (as every test of that rule compares). A day is judged only once counting had already started on its
//     baseline day — before that there is no history and "every caller is new" would be noise (P-03).
//   • REPORTED, NEVER BLOCKED — `actionTaken` is the literal `false`; the alert goes to the IT custodian. No AI acts here.
//
// Pure: dates in, findings out, no I/O. The composition (the ledger, the kernel hook, the sweep) is in services/api.

import { findUsageSignals, type UsageWindow, type UsageFinding } from '../../../packages/integration/src/index';

/**
 * THE usage-signals rule — one function, run by `POST /v1/integration/secrets/usage-signals` and by the nightly roll-up, so
 * "changes sharply" means the same thing in both. The tested `findUsageSignals` with its own defaults (a spike is more than
 * 3× the baseline, an error surge more than 10% of calls); a caller may pass its own basis points to the route.
 */
export function usageSignalsOf(input: { readonly current: readonly UsageWindow[]; readonly baseline: readonly UsageWindow[]; readonly spikeBps?: number; readonly errorBps?: number }): readonly UsageFinding[] {
  return findUsageSignals({
    current: input.current, baseline: input.baseline,
    ...(input.spikeBps === undefined ? {} : { spikeBps: input.spikeBps }),
    ...(input.errorBps === undefined ? {} : { errorBps: input.errorBps }),
  });
}

/** One day's count of one credential's use by one caller against one API. References and numbers only — never a value. */
export interface SecretUseCount {
  readonly day: string;
  /** The credential's reference id (the signed token id), or `unnamed` when the token carries none. */
  readonly credentialRef: string;
  readonly callerId: string;
  readonly api: string;
  readonly calls: number;
  /** Calls head office refused or failed (status 400 and above). */
  readonly errors: number;
}

/** The fact the nightly roll-up keeps for each judged (or not-judgeable) day — once per day. */
export interface SecretUseDayRollup {
  readonly day: string;
  readonly baselineDay: string;
  /** false: counting had not started by the baseline day, so there was no history to judge against. */
  readonly judged: boolean;
  readonly windows: readonly UsageWindow[];
  readonly findings: readonly UsageFinding[];
  readonly rolledUpAt: string;
}

/** How a credential reference is written when the token named none. */
export const UNNAMED_CREDENTIAL = 'unnamed';

const DAY_MS = 86_400_000;
const isDay = (d: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));

/** A calendar day plus or minus whole days (pure date arithmetic on YYYY-MM-DD; no zone is involved). */
export function addDays(day: string, n: number): string {
  if (!isDay(day)) throw new RangeError(`"${day}" is not a YYYY-MM-DD day`);
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** The baseline a day is compared with: the same weekday a week before. */
export const baselineDayOf = (day: string): string => addDays(day, -7);

/** Sum appended counts into one total per (day, credential, caller, api). Order-independent. */
export function totalCounts(counts: readonly SecretUseCount[]): readonly SecretUseCount[] {
  const by = new Map<string, { -readonly [K in keyof SecretUseCount]: SecretUseCount[K] }>();
  for (const c of counts) {
    const k = `${c.day}\u0000${c.credentialRef}\u0000${c.callerId}\u0000${c.api}`;
    const seen = by.get(k);
    if (seen === undefined) by.set(k, { day: c.day, credentialRef: c.credentialRef, callerId: c.callerId, api: c.api, calls: c.calls, errors: c.errors });
    else { seen.calls += c.calls; seen.errors += c.errors; }
  }
  return [...by.values()].sort((a, b) => a.day.localeCompare(b.day) || a.callerId.localeCompare(b.callerId) || a.api.localeCompare(b.api) || a.credentialRef.localeCompare(b.credentialRef));
}

/** One day's usage windows, as the usage-signals rule reads them: per caller, per API (every credential the caller used). */
export function usageWindowsOf(counts: readonly SecretUseCount[], day: string): readonly UsageWindow[] {
  const by = new Map<string, { identityId: string; api: string; calls: number; errors: number }>();
  for (const c of counts) {
    if (c.day !== day) continue;
    const k = `${c.callerId}\u0000${c.api}`;
    const w = by.get(k) ?? { identityId: c.callerId, api: c.api, calls: 0, errors: 0 };
    w.calls += c.calls; w.errors += c.errors;
    by.set(k, w);
  }
  return [...by.values()].sort((a, b) => a.identityId.localeCompare(b.identityId) || a.api.localeCompare(b.api)).map((w) => ({ ...w, onDate: day }));
}

/**
 * The days the nightly roll-up must judge now: every finished day (up to and including `yesterday`) from the first day
 * counted, that has not been rolled up yet — so a missed night is caught up, and a day already rolled up is never judged
 * twice. Bounded to the last `maxDays` days (a head office down for months catches up the recent month, and says so).
 */
export function daysToRollUp(input: { readonly firstCountedDay: string | undefined; readonly yesterday: string; readonly rolledUp: ReadonlySet<string>; readonly maxDays?: number }): readonly string[] {
  if (input.firstCountedDay === undefined || input.firstCountedDay > input.yesterday) return [];
  const earliest = addDays(input.yesterday, -((input.maxDays ?? 31) - 1));
  const out: string[] = [];
  for (let d = input.firstCountedDay < earliest ? earliest : input.firstCountedDay; d <= input.yesterday; d = addDays(d, 1)) {
    if (!input.rolledUp.has(d)) out.push(d);
  }
  return out;
}

/** Judge one finished day against its baseline with the usage-signals route's own rule. */
export function rollUpSecretUseDay(input: { readonly day: string; readonly counts: readonly SecretUseCount[]; readonly firstCountedDay: string; readonly at: string }): SecretUseDayRollup {
  const baselineDay = baselineDayOf(input.day);
  const windows = usageWindowsOf(input.counts, input.day);
  const judged = input.firstCountedDay <= baselineDay;
  const findings = judged ? usageSignalsOf({ current: windows, baseline: usageWindowsOf(input.counts, baselineDay) }) : [];
  return { day: input.day, baselineDay, judged, windows, findings, rolledUpAt: input.at };
}

/** One credential's use over a window of days — the Integration health page's "last 30 days". */
export interface SecretUseSummary {
  readonly credentialRef: string;
  readonly callerId: string;
  readonly api: string;
  readonly calls: number;
  readonly errors: number;
  readonly daysUsed: number;
  readonly lastUsedOn: string;
  readonly byDay: readonly { readonly day: string; readonly calls: number; readonly errors: number }[];
}

export function summariseSecretUse(counts: readonly SecretUseCount[], from: string, to: string): readonly SecretUseSummary[] {
  const by = new Map<string, { credentialRef: string; callerId: string; api: string; days: Map<string, { calls: number; errors: number }> }>();
  for (const c of totalCounts(counts)) {
    if (c.day < from || c.day > to) continue;
    const k = `${c.credentialRef}\u0000${c.callerId}\u0000${c.api}`;
    const s = by.get(k) ?? { credentialRef: c.credentialRef, callerId: c.callerId, api: c.api, days: new Map() };
    s.days.set(c.day, { calls: c.calls, errors: c.errors });
    by.set(k, s);
  }
  return [...by.values()].map((s) => {
    const byDay = [...s.days].sort(([a], [b]) => a.localeCompare(b)).map(([day, n]) => ({ day, ...n }));
    return {
      credentialRef: s.credentialRef, callerId: s.callerId, api: s.api,
      calls: byDay.reduce((n, d) => n + d.calls, 0), errors: byDay.reduce((n, d) => n + d.errors, 0),
      daysUsed: byDay.length, lastUsedOn: byDay.at(-1)?.day ?? from, byDay,
    };
  }).sort((a, b) => a.credentialRef.localeCompare(b.credentialRef) || a.callerId.localeCompare(b.callerId) || a.api.localeCompare(b.api));
}

/** The words of the alert the IT custodian gets for one finding — the references, the caller and the counts; never a value. */
export function secretUseAlertDetail(f: UsageFinding, r: SecretUseDayRollup, counts: readonly SecretUseCount[]): string {
  const refs = [...new Set(counts.filter((c) => (c.day === r.day || c.day === r.baselineDay) && c.callerId === f.identityId && c.api === f.api).map((c) => c.credentialRef))].sort();
  const now = r.windows.find((w) => w.identityId === f.identityId && w.api === f.api);
  const before = usageWindowsOf(counts, r.baselineDay).find((w) => w.identityId === f.identityId && w.api === f.api);
  const what: Record<UsageFinding['signal'], string> = {
    spike: 'far more calls than the same day a week before',
    error_surge: 'many of its calls were refused or failed',
    silent: 'it stopped calling',
    new_caller: 'it called with no history',
  };
  return `On ${r.day}, ${f.identityId} (credential reference ${refs.length === 0 ? UNNAMED_CREDENTIAL : refs.join(', ')}) used ${f.api}: `
    + `${now?.calls ?? 0} call(s), ${now?.errors ?? 0} refused or failed; on ${r.baselineDay} (the same day a week before): `
    + `${before?.calls ?? 0} call(s), ${before?.errors ?? 0} refused or failed — ${what[f.signal]}. Reported, not blocked: nothing was switched off. `
    + 'If this was not expected, the IT custodian checks the credential and revokes it if it is lost.';
}
