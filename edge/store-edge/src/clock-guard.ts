// The store computer's CLOCK, checked against head office's (roadmap §31.1 · P-08 · OB-327 · OB-288 lane 2).
//
// §31.1: "Clock drift beyond threshold blocks time-sensitive local activation and raises incident." Everything the box
// dates — a bill's time and trading day, a temperature check "done on time", a production run's use-by, a transfer sent
// at 06:00 — is dated by THIS machine's clock, and head office judges offline work by the time the box says it was done.
// So the box measures its clock against head office's on every answer head office sends it (the HTTP `Date` header — head
// office's own clock, to the second) and says the difference in words (P-08: never silent).
//
// OB-327 (owner, in writing, 23 Oct 2026): at 2 MINUTES' difference the screens show a visible WARNING; at 5 MINUTES bills
// still commit (hard rule #1 — the sale is never blocked) but every bill taken while it is that far out is FLAGGED for
// checking; both numbers are changeable in the store computer's settings (`EDGE_CLOCK_WARN_SECONDS`,
// `EDGE_CLOCK_FLAG_SECONDS`). Nothing here stops the till selling.
//
// Restart-safe: each time the verdict changes it is appended to the box's own clock log (fsync'd), so after a cold restart
// the box still knows which bills were taken while its clock was out — the flag list is DERIVED from that log and the
// sale log, never from memory. A measurement is honest about its own error (the header is to the whole second and a reply
// takes time to arrive) and reports it beside the difference.

import { appendFile, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** OB-327's numbers, in seconds, unless the store computer's settings say otherwise. */
export const OB327_WARN_SECONDS = 120;
export const OB327_FLAG_SECONDS = 300;

export type ClockVerdict = 'not_checked' | 'in_step' | 'warning' | 'flag_bills';

export interface ClockThresholds {
  readonly warnSeconds: number;
  readonly flagSeconds: number;
  /** Where the numbers came from: the owner's decision as written, or this store computer's own settings. */
  readonly by: 'owner_decision_ob327' | 'store_computer_setting';
}

/** What the screens show about this box's clock. */
export interface ClockCheck {
  readonly verdict: ClockVerdict;
  /** Head office's clock minus this box's, in whole seconds (positive: this box is BEHIND). Null until first measured. */
  readonly offsetSeconds: number | null;
  /** How much of that the measurement itself cannot vouch for, in whole seconds (rounded up). */
  readonly uncertaintySeconds: number | null;
  /** When (by this box's clock) the last measurement was taken; null before the first. */
  readonly lastCheckedAt: string | null;
  readonly thresholds: ClockThresholds;
  /** True when a person should be told now (a warning, or bills being flagged). */
  readonly needsAttention: boolean;
  readonly staffMessage: string;
  readonly staffMessageTa: string;
}

/** Read the store computer's settings for the two numbers. Absent → OB-327's; anything unreadable → OB-327's, said. */
export function readClockThresholds(warnRaw: string | undefined, flagRaw: string | undefined): { readonly thresholds: ClockThresholds; readonly problem?: string } {
  const set = (raw: string | undefined): number | null | 'bad' => {
    if (raw === undefined || raw.trim() === '') return null;
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) && n >= 1 ? n : 'bad';
  };
  const w = set(warnRaw);
  const f = set(flagRaw);
  const ob327: ClockThresholds = { warnSeconds: OB327_WARN_SECONDS, flagSeconds: OB327_FLAG_SECONDS, by: 'owner_decision_ob327' };
  if (w === 'bad' || f === 'bad') return { thresholds: ob327, problem: 'EDGE_CLOCK_WARN_SECONDS / EDGE_CLOCK_FLAG_SECONDS must be whole numbers of seconds (1 or more) — the owner\'s numbers (2 and 5 minutes, OB-327) are used instead.' };
  if (w === null && f === null) return { thresholds: ob327 };
  const warnSeconds = w ?? OB327_WARN_SECONDS;
  const flagSeconds = f ?? OB327_FLAG_SECONDS;
  if (flagSeconds < warnSeconds) return { thresholds: ob327, problem: `The clock flag (${flagSeconds} s) cannot be sooner than the clock warning (${warnSeconds} s) — the owner's numbers (2 and 5 minutes, OB-327) are used instead.` };
  return { thresholds: { warnSeconds, flagSeconds, by: 'store_computer_setting' } };
}

const words = (seconds: number): string => {
  const s = Math.abs(seconds);
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.round(s / 60);
  return m < 120 ? `${m} minute${m === 1 ? '' : 's'}` : `${Math.round(m / 60)} hours`;
};
const wordsTa = (seconds: number): string => {
  const s = Math.abs(seconds);
  if (s < 60) return `${s} வினாடி`;
  const m = Math.round(s / 60);
  return m < 120 ? `${m} நிமிடம்` : `${Math.round(m / 60)} மணி நேரம்`;
};

/** The verdict for a measured difference (OB-327: at or beyond each number). */
export function verdictFor(offsetSeconds: number, t: ClockThresholds): Exclude<ClockVerdict, 'not_checked'> {
  const d = Math.abs(offsetSeconds);
  return d >= t.flagSeconds ? 'flag_bills' : d >= t.warnSeconds ? 'warning' : 'in_step';
}

/** One change of verdict, as the box's clock log keeps it. */
export interface ClockLogEntry { readonly at: string; readonly verdict: Exclude<ClockVerdict, 'not_checked'>; readonly offsetSeconds: number }

/** A bill taken while this box's clock was 5+ minutes (OB-327) away from head office's — committed, flagged for checking. */
export interface ClockFlaggedBill { readonly saleId: string; readonly number?: string; readonly laneId?: string; readonly committedAt: string; readonly offsetSeconds: number }

const LOG_FILE = 'clock-checks.log';

export class ClockGuard {
  private last: { readonly offsetMs: number; readonly uncertaintyMs: number; readonly at: number } | undefined;
  private history: ClockLogEntry[];
  private writes: Promise<void> = Promise.resolve();

  private constructor(readonly thresholds: ClockThresholds, private readonly dataDir: string | undefined, history: ClockLogEntry[]) {
    this.history = history;
  }

  /** Open the guard over the box's clock log (restored at boot). `dataDir` undefined → in memory only (a test). */
  static async open(thresholds: ClockThresholds, dataDir?: string): Promise<ClockGuard> {
    const history: ClockLogEntry[] = [];
    if (dataDir !== undefined) {
      let text = '';
      try { text = await readFile(join(dataDir, LOG_FILE), 'utf8'); } catch { /* none yet */ }
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        try {
          const e = JSON.parse(line) as Partial<ClockLogEntry>;
          if (typeof e.at === 'string' && !Number.isNaN(Date.parse(e.at)) && (e.verdict === 'in_step' || e.verdict === 'warning' || e.verdict === 'flag_bills') && Number.isFinite(e.offsetSeconds)) {
            history.push({ at: e.at, verdict: e.verdict, offsetSeconds: e.offsetSeconds as number });
          }
        } catch { /* a torn last line from a power cut: kept on disk, not read */ }
      }
    }
    return new ClockGuard(thresholds, dataDir, history);
  }

  /** Everything written so far is on the disk (for a test, or a clean stop). */
  settled(): Promise<void> { return this.writes; }

  /**
   * One answer from head office: its `Date` header, and when (by this box's clock) the request left and the answer came
   * back. A missing or unreadable header teaches nothing and is ignored. A CHANGE of verdict is appended to the clock log.
   */
  observe(dateHeader: string | null | undefined, sentAtMs: number, receivedAtMs: number): void {
    if (typeof dateHeader !== 'string' || dateHeader.trim() === '') return;
    const headOffice = Date.parse(dateHeader);
    if (Number.isNaN(headOffice) || !Number.isFinite(sentAtMs) || !Number.isFinite(receivedAtMs) || receivedAtMs < sentAtMs) return;
    // The header is head office's clock truncated to the second: the true moment is within [header, header + 1 s).
    const offsetMs = headOffice + 500 - (sentAtMs + receivedAtMs) / 2;
    this.last = { offsetMs, uncertaintyMs: (receivedAtMs - sentAtMs) / 2 + 500, at: receivedAtMs };
    const offsetSeconds = Math.round(offsetMs / 1000);
    const verdict = verdictFor(offsetSeconds, this.thresholds);
    if (this.history.at(-1)?.verdict !== verdict) {
      const entry: ClockLogEntry = { at: new Date(receivedAtMs).toISOString(), verdict, offsetSeconds };
      this.history.push(entry);
      if (this.dataDir !== undefined) {
        const path = join(this.dataDir, LOG_FILE);
        this.writes = this.writes.then(async () => {
          await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
          const h = await open(path, 'r+');
          try { await h.sync(); } finally { await h.close(); }
        }).catch(() => { /* a full disk: the verdict is still in force in memory and shown; the next change tries again */ });
      }
    }
  }

  /** The verdict in force at a moment, by this box's clock — from the clock log (so it survives a restart). */
  verdictAt(atIso: string): ClockLogEntry | undefined {
    const at = Date.parse(atIso);
    let found: ClockLogEntry | undefined;
    for (const e of this.history) { if (Date.parse(e.at) <= at) found = e; else break; }
    return found;
  }

  /** The bills taken while the clock was 5+ minutes out (OB-327): committed, and listed for a person to check. */
  flaggedBills(sales: readonly { readonly id: string; readonly number?: string; readonly laneId?: string; readonly committedAt?: string }[]): readonly ClockFlaggedBill[] {
    const out: ClockFlaggedBill[] = [];
    for (const s of sales) {
      if (s.committedAt === undefined) continue;
      const v = this.verdictAt(s.committedAt);
      if (v?.verdict === 'flag_bills') out.push({ saleId: s.id, ...(s.number === undefined ? {} : { number: s.number }), ...(s.laneId === undefined ? {} : { laneId: s.laneId }), committedAt: s.committedAt, offsetSeconds: v.offsetSeconds });
    }
    return out;
  }

  check(): ClockCheck {
    const t = this.thresholds;
    if (this.last === undefined) {
      const restored = this.history.at(-1);
      return {
        verdict: restored?.verdict === 'flag_bills' || restored?.verdict === 'warning' ? restored.verdict : 'not_checked',
        offsetSeconds: restored?.offsetSeconds ?? null, uncertaintySeconds: null, lastCheckedAt: restored?.at ?? null, thresholds: t,
        needsAttention: restored !== undefined && restored.verdict !== 'in_step',
        staffMessage: restored === undefined || restored.verdict === 'in_step'
          ? 'This store computer has not compared its clock with head office since it started.'
          : `This store computer's clock was ${words(restored.offsetSeconds)} away from head office when last checked (${restored.at}), and has not been checked again since it started.`,
        staffMessageTa: restored === undefined || restored.verdict === 'in_step'
          ? 'இந்தக் கடைக் கணினி தொடங்கியதிலிருந்து தலைமை அலுவலகக் கடிகாரத்துடன் மீண்டும் ஒப்பிடவில்லை.'
          : `கடைசியாகச் சரிபார்த்தபோது (${restored.at}) இந்தக் கடைக் கணினியின் கடிகாரம் தலைமை அலுவலகத்திலிருந்து ${wordsTa(restored.offsetSeconds)} விலகியிருந்தது; தொடங்கியதிலிருந்து மீண்டும் சரிபார்க்கப்படவில்லை.`,
      };
    }
    const offsetSeconds = Math.round(this.last.offsetMs / 1000);
    const uncertaintySeconds = Math.ceil(this.last.uncertaintyMs / 1000);
    const lastCheckedAt = new Date(this.last.at).toISOString();
    const ahead = this.last.offsetMs < 0;
    const diff = `${words(offsetSeconds)} ${ahead ? 'AHEAD of' : 'BEHIND'} head office`;
    const diffTa = `தலைமை அலுவலகத்தை விட ${wordsTa(offsetSeconds)} ${ahead ? 'முன்னால்' : 'பின்னால்'}`;
    const verdict = verdictFor(offsetSeconds, t);
    const base = { verdict, offsetSeconds, uncertaintySeconds, lastCheckedAt, thresholds: t, needsAttention: verdict !== 'in_step' };
    if (verdict === 'flag_bills') {
      return {
        ...base,
        staffMessage: `This store computer's clock is ${diff} — ${words(t.flagSeconds)} or more. Bills still go through, but each one is marked for checking. Tell the manager to correct the clock now.`,
        staffMessageTa: `இந்தக் கடைக் கணினியின் கடிகாரம் ${diffTa} — ${wordsTa(t.flagSeconds)} அல்லது அதிகம். பில்கள் தொடர்கின்றன, ஆனால் ஒவ்வொன்றும் சரிபார்க்கக் குறிக்கப்படுகிறது. கடிகாரத்தை உடனே சரிசெய்ய மேலாளரிடம் சொல்லுங்கள்.`,
      };
    }
    if (verdict === 'warning') {
      return {
        ...base,
        staffMessage: `Warning: this store computer's clock is ${diff} (${words(t.warnSeconds)} or more). Correct the clock before it reaches ${words(t.flagSeconds)}, when bills are marked for checking.`,
        staffMessageTa: `எச்சரிக்கை: இந்தக் கடைக் கணினியின் கடிகாரம் ${diffTa}. ${wordsTa(t.flagSeconds)} ஆகும் முன் கடிகாரத்தைச் சரிசெய்யுங்கள்.`,
      };
    }
    return {
      ...base,
      staffMessage: `This store computer's clock agrees with head office (${diff}, ± ${uncertaintySeconds} s, checked ${lastCheckedAt}).`,
      staffMessageTa: `இந்தக் கடைக் கணினியின் கடிகாரம் தலைமை அலுவலகத்துடன் ஒத்துப்போகிறது (${diffTa}).`,
    };
  }
}

/**
 * Wrap the fetch every head-office call goes through, so each answer's `Date` header is measured — the sync drain, the pack
 * pull and every feed. The call itself is untouched: same request, same answer, same failure.
 */
export function clockObservingFetch(fetchFn: typeof globalThis.fetch, guard: ClockGuard, nowMs: () => number = Date.now): typeof globalThis.fetch {
  return (async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
    const sent = nowMs();
    const response = await fetchFn(input, init);
    try { guard.observe(response.headers?.get?.('date') ?? null, sent, nowMs()); } catch { /* a reply without readable headers teaches nothing */ }
    return response;
  }) as typeof globalThis.fetch;
}
