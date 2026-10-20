// The store computer's own check, as the office screens see it — audit row 6 (P-08 "no silent failure", P-03 "control by
// exception"): a red banner the owner sees on the store PC with no internet.
//
// `store-computer status` (scripts/lib/store-computer-status.mjs) runs every 15 minutes on the store computer and writes
// one small file: when it checked, and each thing that is wrong — the last backup older than 2 hours, till items unsent
// for over 15 minutes, a dead letter, the disk 85% full, a container down — in English and Tamil. This box only READS
// that file (it never writes it, and nothing on the sale path waits for it: hard rule #1) and hands the answer to the
// office screens inside its sync status (GET /lane/sync-status), where sre-chrome.js draws the red banner.
//
// Two rules of its own, both P-08: a file that is missing or cannot be read is NOT an all-clear — it is a red line saying
// the check has never run or cannot be read; and a file older than 30 minutes (two missed checks) is a red line too —
// a check that stopped running says nothing about now.

export interface StoreComputerAlert {
  readonly code: string;
  readonly en: string;
  readonly ta: string;
}

export interface StoreComputerStatus {
  /** False when there is no readable status file: the alerts then say so. */
  readonly known: boolean;
  /** When the store computer last checked itself, if known. */
  readonly checkedAt: string | null;
  /** Older than STALE_AFTER_MINUTES: the check stopped running. */
  readonly stale: boolean;
  /** 'red' whenever there is any alert — including "the check has not run". */
  readonly overall: 'ok' | 'red';
  readonly alerts: readonly StoreComputerAlert[];
}

/** Two missed 15-minute checks. */
export const STALE_AFTER_MINUTES = 30;
const MAX_ALERTS = 12;
const MAX_WORDS = 400;

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= MAX_WORDS;

const NEVER: StoreComputerAlert = {
  code: 'check_never_ran',
  en: "The store computer's own check has not run yet, so nobody can say whether the backup, the till's queue, the disk and the database are all right. Set up the automatic backup (store-computer schedule-backup).",
  ta: 'கடை கணினியின் சொந்தச் சோதனை இன்னும் இயங்கவில்லை; காப்புப் பிரதி, கல்லா வரிசை, வட்டு, தரவுத்தளம் சரியா என்று சொல்ல முடியாது. தானியங்கி காப்புப் பிரதியை அமைக்கவும் (store-computer schedule-backup).',
};
const UNREADABLE: StoreComputerAlert = {
  code: 'check_unreadable',
  en: "The store computer's own check could not be read. Run: pnpm run store-computer -- status",
  ta: 'கடை கணினியின் சொந்தச் சோதனையைப் படிக்க முடியவில்லை. இயக்கவும்: pnpm run store-computer -- status',
};

/**
 * Judge the status file's text (undefined = no file). Pure: the clock is passed in. Never throws — a file that cannot be
 * judged is itself the answer.
 */
export function judgeStoreComputerStatus(text: string | undefined, nowMs: number): StoreComputerStatus {
  if (text === undefined) return { known: false, checkedAt: null, stale: false, overall: 'red', alerts: [NEVER] };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { raw = undefined; }
  const f = raw as { kind?: unknown; version?: unknown; checkedAt?: unknown; alerts?: unknown; staleAfterMinutes?: unknown } | undefined;
  const at = typeof f?.checkedAt === 'string' ? Date.parse(f.checkedAt) : Number.NaN;
  if (f === undefined || f === null || f.kind !== 'sre-store-computer-status' || f.version !== 1 || !Number.isFinite(at) || !Array.isArray(f.alerts)) {
    return { known: false, checkedAt: null, stale: false, overall: 'red', alerts: [UNREADABLE] };
  }
  const alerts: StoreComputerAlert[] = [];
  for (const a of f.alerts.slice(0, MAX_ALERTS)) {
    const x = a as { code?: unknown; en?: unknown; ta?: unknown };
    if (typeof x?.code === 'string' && /^[a-z_]{1,40}$/.test(x.code) && isText(x.en) && isText(x.ta)) alerts.push({ code: x.code, en: x.en, ta: x.ta });
    else alerts.push(UNREADABLE);
  }
  const minutes = Math.floor((nowMs - at) / 60_000);
  const stale = minutes > STALE_AFTER_MINUTES;
  if (stale) {
    alerts.unshift({
      code: 'check_stale',
      en: `The store computer's own check last ran ${minutes} minutes ago — it should run every 15 minutes. What it said then may no longer be true. Sign in to Windows on the store computer, then run: pnpm run store-computer -- status`,
      ta: `கடை கணினியின் சொந்தச் சோதனை கடைசியாக ${minutes} நிமிடங்களுக்கு முன் இயங்கியது — அது ஒவ்வொரு 15 நிமிடமும் இயங்க வேண்டும். அப்போது சொன்னது இப்போது உண்மையாக இல்லாமல் இருக்கலாம். கடை கணினியில் Windows-இல் உள்நுழைந்து இயக்கவும்: pnpm run store-computer -- status`,
    });
  }
  return { known: true, checkedAt: new Date(at).toISOString(), stale, overall: alerts.length === 0 ? 'ok' : 'red', alerts };
}

/**
 * Keep the latest text of the status file in memory, re-read every `everyMs` off the sale path (an unref'd timer, an
 * async read). `current()` is what the sync-status route hands out — never a file read of its own.
 */
export function watchStoreComputerStatus(input: {
  readonly file: string;
  readonly read: (file: string) => Promise<string>;
  readonly now?: () => number;
  readonly everyMs?: number;
}): { readonly current: () => StoreComputerStatus; readonly refresh: () => Promise<void>; readonly stop: () => void } {
  let text: string | undefined;
  const refresh = async (): Promise<void> => {
    try { text = await input.read(input.file); } catch { text = undefined; }
  };
  const timer = setInterval(() => { void refresh(); }, input.everyMs ?? 30_000);
  timer.unref?.();
  return {
    current: () => judgeStoreComputerStatus(text, (input.now ?? Date.now)()),
    refresh,
    stop: () => { clearInterval(timer); },
  };
}
