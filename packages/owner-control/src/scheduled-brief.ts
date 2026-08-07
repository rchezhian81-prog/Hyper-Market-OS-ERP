// Scheduled reports and the daily brief (M29-FR-04 / D13 / AI-NFR-04 / NFR-08).
//
// The roadmap's acceptance for this is unusually concrete, and it is the right test:
// **"the daily brief arrives on the phone at the set time for three days running
// without anyone sending it"** — and **"if AI is off, the numbers still arrive."**
//
// Both halves matter, and the second is the one systems get wrong. A brief that depends
// on a language model is a brief that stops on the morning the model is down, the API
// key expires, or the internet is out — which in a Tamil Nadu hypermarket is a Tuesday.
// So the architecture here is deliberately inverted from how these are usually built:
//
//     the numbers ARE the brief.  The narrative is a decoration on top.
//
// `buildScheduledBrief` composes the deterministic figures first and **always returns a
// complete, sendable brief**. The narrative is applied afterwards, and if it is absent,
// broken, or arrives with low confidence, the brief goes out unchanged with a line
// saying the written summary was not available. AI is **additive, never blocking**
// (AI-NFR-04) — and it never touches a number: it is handed the figures and may only
// arrange words around them.
//
// A missed send is **carried, not skipped**. A brief that silently does not arrive is
// indistinguishable from a quiet day, which is exactly the morning you needed it.
//
// Language is per-tenant (NFR-08): Tamil or English, and an untranslated narrative
// falls back to the figures rather than to English the reader may not have.
//
// Pure and deterministic: the clock is injected and nothing is sent from here — this
// builds what a transport delivers.

export type BriefLanguage = 'en' | 'ta';

export interface BriefFigures {
  readonly tradingDay: string;
  readonly netSalesMinor: number;
  readonly marginMinor: number;
  readonly marginBps: number;
  readonly basketCount: number;
  readonly cashBankedMinor: number;
  /** How old the underlying data is, in minutes. Always stated (P-08). */
  readonly dataAgeMinutes: number;
}

export interface AttentionLine {
  readonly headline: string;
  readonly valueMinor: number;
  readonly ref: string;
}

/** What a model may return. Every field is optional — none of it is depended upon. */
export interface Narrative {
  readonly text?: string;
  readonly language?: BriefLanguage;
  /** The model's own confidence. Low confidence is shown as unavailable, not as fact. */
  readonly confidence?: 'low' | 'medium' | 'high';
  /** Refs the narrative claims to be based on (AI-NFR-04 evidence). */
  readonly evidenceRefs?: readonly string[];
}

export interface ScheduledBrief {
  readonly tradingDay: string;
  readonly language: BriefLanguage;
  /** The deterministic figures. Present whatever else fails. */
  readonly figures: BriefFigures;
  /** At most three, worst first — an owner reads three things, not thirty. */
  readonly attention: readonly AttentionLine[];
  /** Written summary, only when it is safe to show one. */
  readonly narrative?: string;
  /** True when the brief is complete without any AI involvement at all. */
  readonly deterministic: boolean;
  /** Why there is no narrative, when there is none. Stated, never silent. */
  readonly narrativeUnavailableReason?: string;
  readonly lines: readonly string[];
  readonly freshness: 'fresh' | 'stale';
}

const WORDS: Record<BriefLanguage, Record<string, string>> = {
  en: {
    sales: 'Sales',
    margin: 'Margin',
    baskets: 'Baskets',
    cash: 'Cash banked',
    attention: 'Needs your attention',
    nothing: 'Nothing needs your attention today.',
    staleWarning: 'THESE NUMBERS ARE NOT LIVE — the last update was',
    minutesAgo: 'minutes ago.',
    noNarrative: 'The written summary was not available this morning; the figures above are complete and correct.',
  },
  ta: {
    sales: 'விற்பனை',
    margin: 'லாபம்',
    baskets: 'பில்கள்',
    cash: 'வங்கியில் செலுத்திய பணம்',
    attention: 'உங்கள் கவனம் தேவை',
    nothing: 'இன்று உங்கள் கவனம் தேவைப்படும் ஒன்றும் இல்லை.',
    staleWarning: 'இந்த எண்கள் நேரலை அல்ல — கடைசி புதுப்பிப்பு',
    minutesAgo: 'நிமிடங்களுக்கு முன்பு.',
    noNarrative: 'இன்று காலை எழுத்துச் சுருக்கம் கிடைக்கவில்லை; மேலே உள்ள எண்கள் முழுமையானவை.',
  },
};

function rupees(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}₹${Math.trunc(abs / 100).toLocaleString('en-IN')}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Build the brief. **Always returns a complete, sendable brief** — the narrative is
 * applied only if it is present, confident and in the reader's language.
 *
 * `staleAfterMinutes` is per-tenant; beyond it the brief leads with a plain warning
 * that the numbers are not live, because an owner acting on yesterday's figures
 * believing they are today's is worse off than one with no figures at all (P-08).
 */
export function buildScheduledBrief(input: {
  readonly figures: BriefFigures;
  readonly attention: readonly AttentionLine[];
  readonly language?: BriefLanguage;
  readonly narrative?: Narrative;
  readonly staleAfterMinutes?: number;
}): ScheduledBrief {
  const language = input.language ?? 'en';
  const w = WORDS[language];
  const stale = input.figures.dataAgeMinutes > (input.staleAfterMinutes ?? 120);

  const top = [...input.attention].sort((a, b) => b.valueMinor - a.valueMinor).slice(0, 3);

  const lines: string[] = [];
  if (stale) {
    lines.push(`${w['staleWarning']} ${input.figures.dataAgeMinutes} ${w['minutesAgo']}`);
  }
  lines.push(
    `${w['sales']}: ${rupees(input.figures.netSalesMinor)}`,
    `${w['margin']}: ${rupees(input.figures.marginMinor)} (${(input.figures.marginBps / 100).toFixed(2)}%)`,
    `${w['baskets']}: ${input.figures.basketCount}`,
    `${w['cash']}: ${rupees(input.figures.cashBankedMinor)}`,
  );
  lines.push(
    top.length === 0
      ? w['nothing']!
      : `${w['attention']}: ${top.map((a) => `${a.headline} (${rupees(a.valueMinor)})`).join('; ')}`,
  );

  // Everything above this point exists without any AI. What follows is decoration.
  const n = input.narrative;
  let narrative: string | undefined;
  let reason: string | undefined;

  if (n === undefined) {
    reason = 'no narrative was generated';
  } else if (n.text === undefined || n.text.trim() === '') {
    reason = 'the narrative came back empty';
  } else if (n.confidence === 'low') {
    // A hedged, uncertain summary read as fact is worse than no summary.
    reason = 'the written summary was not confident enough to show';
  } else if (n.language !== undefined && n.language !== language) {
    reason = `the narrative was written in ${n.language}, not ${language}`;
  } else if ((n.evidenceRefs ?? []).length === 0) {
    // AI-NFR-04: a narrative with no evidence behind it is not shown.
    reason = 'the narrative carried no evidence for what it claimed';
  } else {
    narrative = n.text;
  }

  if (narrative === undefined) {
    lines.push(w['noNarrative']!);
  }

  return {
    tradingDay: input.figures.tradingDay,
    language,
    figures: input.figures,
    attention: top,
    ...(narrative === undefined ? {} : { narrative }),
    deterministic: narrative === undefined,
    ...(reason === undefined ? {} : { narrativeUnavailableReason: reason }),
    lines,
    freshness: stale ? 'stale' : 'fresh',
  };
}

export interface ScheduleState {
  readonly scheduleId: string;
  /** Local hour and minute the brief is due, per-tenant. */
  readonly dueAt: readonly [number, number];
  /** Trading days already sent, so a send is never repeated. */
  readonly sentDays: readonly string[];
}

export interface DueBrief {
  readonly tradingDay: string;
  readonly reason: 'scheduled' | 'missed_catch_up';
  readonly detail: string;
}

/**
 * Which briefs are due right now, including any that were **missed**.
 *
 * A brief that silently does not arrive is indistinguishable from a quiet day — which
 * is exactly the morning you needed it. So a day the schedule should have covered and
 * did not is returned as a catch-up, labelled as late rather than passed off as today's.
 *
 * Idempotent: a day already sent is never returned again, so a scheduler that fires
 * twice sends once.
 */
export function briefsDue(input: {
  readonly schedule: ScheduleState;
  /** Trading days the brief should cover, oldest first. */
  readonly tradingDays: readonly string[];
  readonly now: string;
}): readonly DueBrief[] {
  const [dueHour, dueMinute] = input.schedule.dueAt;
  const nowHour = Number.parseInt(input.now.slice(11, 13), 10);
  const nowMinute = Number.parseInt(input.now.slice(14, 16), 10);
  const today = input.now.slice(0, 10);
  const due: DueBrief[] = [];

  for (const day of input.tradingDays) {
    if (input.schedule.sentDays.includes(day)) continue;

    if (day < today) {
      due.push({
        tradingDay: day,
        reason: 'missed_catch_up',
        detail: `the brief for ${day} was never sent — it is going out now, labelled late, rather than being skipped as though the day never happened`,
      });
      continue;
    }
    if (day === today && (nowHour > dueHour || (nowHour === dueHour && nowMinute >= dueMinute))) {
      due.push({
        tradingDay: day,
        reason: 'scheduled',
        detail: `due at ${String(dueHour).padStart(2, '0')}:${String(dueMinute).padStart(2, '0')}`,
      });
    }
  }

  return due;
}

/** Record a send. Returns new state — the schedule is never mutated in place. */
export function markSent(schedule: ScheduleState, tradingDay: string): ScheduleState {
  if (schedule.sentDays.includes(tradingDay)) return schedule;
  return { ...schedule, sentDays: [...schedule.sentDays, tradingDay] };
}
