// MG-11 "rehearsed checklist with BACKUP, go/no-go, ROLLBACK THRESHOLDS and named command team" (OB-288 P5 · §34 · P-08).
//
// Two things the cutover gate lacked:
//
//   • A BACKUP CHECK. The night needs something whole to go back to. A backup counts only when the backup job itself
//     reported it completed, encrypted and copied off-site (M35-FR-01) — and only when it is recent enough by the owner's
//     own limit. No limit set: the check is NOT KNOWN (it fails); no good backup within it: it fails.
//   • NUMERIC ROLLBACK LIMITS, AGREED BEFORE THE NIGHT. "Roll back if it goes badly" is a judgement made at 6am by a tired
//     person. Four numbers, each the OWNER's (OB-288: a number the owner must still enter is shown as "not set", never
//     invented): the largest control-total difference tolerated (paise), the longest the store may be cut off from head
//     office (minutes), how long the night may run from GO (minutes), and how old the backup may be (hours). Every limit
//     must be set before the gate can say GO. On the night, an observation past a limit RAISES the rollback trigger by
//     itself — a person still performs the rollback (it is one labelled action), but nobody has to argue that it is time.
//
// Pure and deterministic: the clock and every observation are passed in.

import type { RollbackTrigger } from './cutover';

export interface RollbackLimits {
  /** The largest control-total difference tolerated on the night, in paise. Null: not set. */
  readonly controlTotalDifferenceMinor: number | null;
  /** The longest the store may be cut off from head office (no complete sync), in minutes. Null: not set. */
  readonly edgeOutageMinutes: number | null;
  /** How long the night may run from the GO before it must be rolled back, in minutes. Null: not set. */
  readonly windowMinutes: number | null;
  /** How old the last good backup may be when the gate is asked, in hours. Null: not set. */
  readonly backupMaxAgeHours: number | null;
  readonly version: number;
  readonly setBy: string;
  readonly setAt: string;
}

export type RollbackLimitName = 'controlTotalDifferenceMinor' | 'edgeOutageMinutes' | 'windowMinutes' | 'backupMaxAgeHours';
export const ROLLBACK_LIMIT_NAMES: readonly RollbackLimitName[] = Object.freeze(['controlTotalDifferenceMinor', 'edgeOutageMinutes', 'windowMinutes', 'backupMaxAgeHours']);

/** Each limit in the owner's words, English and Tamil — for the screen and for the refusal sentences. */
export const ROLLBACK_LIMIT_WORDS: Readonly<Record<RollbackLimitName, { readonly en: string; readonly ta: string }>> = Object.freeze({
  controlTotalDifferenceMinor: { en: 'Largest money difference allowed on the night (paise)', ta: 'அன்றிரவு அனுமதிக்கப்படும் அதிகபட்ச பண வித்தியாசம் (பைசா)' },
  edgeOutageMinutes: { en: 'Longest the store may be cut off from head office (minutes)', ta: 'கடை தலைமை அலுவலகத்துடன் தொடர்பின்றி இருக்கக்கூடிய அதிகபட்ச நேரம் (நிமிடங்கள்)' },
  windowMinutes: { en: 'How long the night may run after GO (minutes)', ta: 'GO-க்குப் பிறகு இரவு வேலை நடக்கக்கூடிய நேரம் (நிமிடங்கள்)' },
  backupMaxAgeHours: { en: 'How old the last good backup may be (hours)', ta: 'கடைசி நல்ல காப்புப்பிரதி எவ்வளவு பழையதாக இருக்கலாம் (மணிநேரம்)' },
});

const TRIGGER_OF: Readonly<Record<Exclude<RollbackLimitName, 'backupMaxAgeHours'>, RollbackTrigger>> = {
  controlTotalDifferenceMinor: 'control_total_failed',
  edgeOutageMinutes: 'edge_cannot_trade',
  windowMinutes: 'time_window_exceeded',
};

/** A limit value as entered: a whole number, not negative, or null for "not set". */
export const isLimitValue = (v: unknown): v is number | null => v === null || (Number.isSafeInteger(v) && (v as number) >= 0);

/** The limits not set yet (every one, when none has been recorded). */
export function limitsNotSet(limits: RollbackLimits | undefined): readonly RollbackLimitName[] {
  if (limits === undefined) return ROLLBACK_LIMIT_NAMES;
  return ROLLBACK_LIMIT_NAMES.filter((n) => limits[n] === null);
}

/** One backup as the backup job reported it (M35-FR-01). */
export interface BackupReport {
  readonly backupId: string;
  readonly at: string;
  readonly ok: boolean;
  readonly encrypted: boolean;
  readonly offsite: boolean;
}

export interface BackupStanding {
  readonly state: 'passed' | 'failed' | 'not_known';
  readonly evidence: string;
  /** When the backup that passed was taken. */
  readonly at?: string;
  readonly backupId?: string;
}

/** Is there a good backup within the owner's limit? Not set → not known; none good, or too old → failed. */
export function backupStanding(backups: readonly BackupReport[], maxAgeHours: number | null, now: string): BackupStanding {
  if (maxAgeHours === null) return { state: 'not_known', evidence: 'the owner has not set how old the backup may be, so no backup can be judged recent enough (not set)' };
  const good = backups.filter((b) => b.ok && b.encrypted && b.offsite).sort((a, b) => b.at.localeCompare(a.at))[0];
  if (good === undefined) {
    const latest = [...backups].sort((a, b) => b.at.localeCompare(a.at))[0];
    return { state: 'failed', evidence: latest === undefined ? 'the backup job has never reported a backup' : `the latest backup (${latest.backupId}, ${latest.at}) is not good: ${[latest.ok ? '' : 'it did not complete', latest.encrypted ? '' : 'it is not encrypted', latest.offsite ? '' : 'it has no off-site copy'].filter((x) => x !== '').join(', ')}` };
  }
  const ageHours = (Date.parse(now) - Date.parse(good.at)) / 3_600_000;
  if (ageHours > maxAgeHours) return { state: 'failed', evidence: `the last good backup (${good.backupId}) was taken ${Math.floor(ageHours)} hour(s) ago — older than the ${maxAgeHours} hour(s) agreed`, at: good.at, backupId: good.backupId };
  return { state: 'passed', evidence: `a good backup (${good.backupId}: completed, encrypted, off-site) was taken at ${good.at}, within the ${maxAgeHours} hour(s) agreed`, at: good.at, backupId: good.backupId };
}

/** What head office observes on the night. A missing observation is NOT KNOWN — never taken as inside a limit. */
export interface NightObservations {
  readonly controlTotalDifferenceMinor?: number;
  readonly edgeOutageMinutes?: number;
  readonly minutesSinceGo?: number;
}

export interface CrossedLimit {
  readonly limit: Exclude<RollbackLimitName, 'backupMaxAgeHours'>;
  readonly trigger: RollbackTrigger;
  readonly limitValue: number;
  readonly observed: number;
  readonly detail: string;
}

/** The limits the night has crossed, and what could not be judged (a limit not set, or nothing observed). */
export function crossedLimits(limits: RollbackLimits | undefined, observed: NightObservations): { readonly crossed: readonly CrossedLimit[]; readonly notKnown: readonly string[] } {
  const crossed: CrossedLimit[] = [];
  const notKnown: string[] = [];
  const pairs: [Exclude<RollbackLimitName, 'backupMaxAgeHours'>, number | undefined][] = [
    ['controlTotalDifferenceMinor', observed.controlTotalDifferenceMinor],
    ['edgeOutageMinutes', observed.edgeOutageMinutes],
    ['windowMinutes', observed.minutesSinceGo],
  ];
  for (const [name, value] of pairs) {
    const limit = limits?.[name] ?? null;
    if (limit === null) { notKnown.push(`${ROLLBACK_LIMIT_WORDS[name].en}: not set`); continue; }
    if (value === undefined) { notKnown.push(`${ROLLBACK_LIMIT_WORDS[name].en}: nothing observed yet`); continue; }
    if (value > limit) {
      crossed.push({ limit: name, trigger: TRIGGER_OF[name], limitValue: limit, observed: value, detail: `${ROLLBACK_LIMIT_WORDS[name].en}: ${value} is past the agreed ${limit}` });
    }
  }
  return { crossed, notKnown };
}
