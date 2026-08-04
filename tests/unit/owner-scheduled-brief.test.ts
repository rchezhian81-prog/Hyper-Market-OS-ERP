import { describe, it, expect } from 'vitest';
import {
  buildScheduledBrief,
  briefsDue,
  markSent,
  type BriefFigures,
  type ScheduleState,
} from '../../packages/owner-control/src/scheduled-brief';

// M29-FR-04 acceptance: "the daily brief arrives on the phone at the set time FOR THREE
// DAYS RUNNING WITHOUT ANYONE SENDING IT; last month's store P&L is viewable by the
// owner without asking anyone; IF AI IS OFF, THE NUMBERS STILL ARRIVE."

const FIGURES: BriefFigures = {
  tradingDay: '2026-08-04',
  netSalesMinor: 4_820_000, // ₹48,200.00
  marginMinor: 964_000, // ₹9,640.00
  marginBps: 2_000, // 20.00%
  basketCount: 412,
  cashBankedMinor: 1_105_000,
  dataAgeMinutes: 12,
};

const ATTENTION = [
  { headline: 'Cashier 7 voided 6 bills', valueMinor: 300_000, ref: 'alert:void' },
  { headline: 'Rice below reorder point', valueMinor: 45_000, ref: 'alert:stock' },
  { headline: 'Milk expiring tomorrow', valueMinor: 12_000, ref: 'alert:expiry' },
  { headline: 'A fourth, smaller thing', valueMinor: 1_000, ref: 'alert:minor' },
];

describe('the numbers ARE the brief; AI is a decoration (M29-FR-04 / AI-NFR-04)', () => {
  it('produces a complete brief with NO narrative at all', () => {
    const brief = buildScheduledBrief({ figures: FIGURES, attention: ATTENTION });

    expect(brief.deterministic).toBe(true);
    expect(brief.narrative).toBeUndefined();
    expect(brief.narrativeUnavailableReason).toBe('no narrative was generated');
    // The figures are all there.
    expect(brief.lines.join(' ')).toContain('₹48,200.00');
    expect(brief.lines.join(' ')).toContain('20.00%');
    expect(brief.lines.join(' ')).toContain('412');
    // And it says the summary was missing rather than going quiet.
    expect(brief.lines[brief.lines.length - 1]).toContain('figures above are complete and correct');
  });

  it('shows exactly THREE things needing attention, worst first', () => {
    const brief = buildScheduledBrief({ figures: FIGURES, attention: ATTENTION });
    expect(brief.attention).toHaveLength(3);
    expect(brief.attention.map((a) => a.ref)).toEqual(['alert:void', 'alert:stock', 'alert:expiry']);
  });

  it('says plainly when nothing needs attention', () => {
    const brief = buildScheduledBrief({ figures: FIGURES, attention: [] });
    expect(brief.lines.join(' ')).toContain('Nothing needs your attention today.');
  });

  it('shows a confident, evidenced narrative when there is one', () => {
    const brief = buildScheduledBrief({
      figures: FIGURES,
      attention: ATTENTION,
      narrative: {
        text: 'Sales held up despite the rain; margin is down because Fresh was marked down late in the day.',
        language: 'en',
        confidence: 'high',
        evidenceRefs: ['alert:void', 'kpi:margin'],
      },
    });
    expect(brief.narrative).toContain('marked down late in the day');
    expect(brief.deterministic).toBe(false);
  });

  it('REFUSES A LOW-CONFIDENCE narrative — hedged guessing read as fact is worse than none', () => {
    const brief = buildScheduledBrief({
      figures: FIGURES,
      attention: ATTENTION,
      narrative: { text: 'Perhaps sales were affected by something.', confidence: 'low', evidenceRefs: ['x'] },
    });
    expect(brief.narrative).toBeUndefined();
    expect(brief.narrativeUnavailableReason).toContain('not confident enough');
    // The numbers still arrive.
    expect(brief.lines.join(' ')).toContain('₹48,200.00');
  });

  it('REFUSES A NARRATIVE WITH NO EVIDENCE behind it (AI-NFR-04)', () => {
    const brief = buildScheduledBrief({
      figures: FIGURES,
      attention: ATTENTION,
      narrative: { text: 'Everything looks fine.', confidence: 'high', evidenceRefs: [] },
    });
    expect(brief.narrative).toBeUndefined();
    expect(brief.narrativeUnavailableReason).toContain('no evidence for what it claimed');
  });

  it('refuses an empty narrative, and one in a language the reader did not ask for', () => {
    expect(
      buildScheduledBrief({ figures: FIGURES, attention: [], narrative: { text: '  ', confidence: 'high', evidenceRefs: ['x'] } })
        .narrativeUnavailableReason,
    ).toContain('came back empty');

    expect(
      buildScheduledBrief({
        figures: FIGURES, attention: [], language: 'ta',
        narrative: { text: 'Sales were good.', language: 'en', confidence: 'high', evidenceRefs: ['x'] },
      }).narrativeUnavailableReason,
    ).toContain('written in en, not ta');
  });
});

describe('freshness is never hidden (P-08)', () => {
  it('leads with a warning when the numbers are not live', () => {
    const brief = buildScheduledBrief({
      figures: { ...FIGURES, dataAgeMinutes: 480 },
      attention: [],
      staleAfterMinutes: 120,
    });
    expect(brief.freshness).toBe('stale');
    expect(brief.lines[0]).toContain('THESE NUMBERS ARE NOT LIVE');
    expect(brief.lines[0]).toContain('480');
  });

  it('does not warn when the data is current', () => {
    const brief = buildScheduledBrief({ figures: FIGURES, attention: [], staleAfterMinutes: 120 });
    expect(brief.freshness).toBe('fresh');
    expect(brief.lines[0]).toContain('Sales');
  });
});

describe('Tamil and English (NFR-08)', () => {
  it('renders the whole brief in Tamil when the tenant chooses it', () => {
    const brief = buildScheduledBrief({ figures: FIGURES, attention: [], language: 'ta' });
    expect(brief.language).toBe('ta');
    expect(brief.lines.join(' ')).toContain('விற்பனை');
    expect(brief.lines.join(' ')).toContain('இன்று உங்கள் கவனம் தேவைப்படும் ஒன்றும் இல்லை.');
    // The money still formats correctly.
    expect(brief.lines.join(' ')).toContain('₹48,200.00');
  });
});

describe('it sends itself, three days running, with nobody sending it', () => {
  const schedule: ScheduleState = { scheduleId: 'daily-brief', dueAt: [7, 30], sentDays: [] };

  it('is not due before the set time, and is due after it', () => {
    expect(briefsDue({ schedule, tradingDays: ['2026-08-04'], now: '2026-08-04T07:00:00Z' })).toEqual([]);
    const due = briefsDue({ schedule, tradingDays: ['2026-08-04'], now: '2026-08-04T07:30:00Z' });
    expect(due).toHaveLength(1);
    expect(due[0]?.reason).toBe('scheduled');
  });

  it('SENDS THREE DAYS RUNNING with no human involvement', () => {
    let state = schedule;
    const sent: string[] = [];
    for (const day of ['2026-08-04', '2026-08-05', '2026-08-06']) {
      const due = briefsDue({ schedule: state, tradingDays: [day], now: `${day}T07:31:00Z` });
      expect(due).toHaveLength(1);
      sent.push(due[0]!.tradingDay);
      state = markSent(state, day);
    }
    expect(sent).toEqual(['2026-08-04', '2026-08-05', '2026-08-06']);
  });

  it('IS IDEMPOTENT — a scheduler that fires twice sends once', () => {
    const state = markSent(schedule, '2026-08-04');
    expect(briefsDue({ schedule: state, tradingDays: ['2026-08-04'], now: '2026-08-04T08:00:00Z' })).toEqual([]);
    // And marking it again changes nothing.
    expect(markSent(state, '2026-08-04')).toBe(state);
  });

  it('CARRIES A MISSED DAY rather than skipping it', () => {
    // The server was down on the 4th. That morning is not simply gone.
    const due = briefsDue({
      schedule,
      tradingDays: ['2026-08-04', '2026-08-05'],
      now: '2026-08-05T07:31:00Z',
    });
    expect(due.map((d) => [d.tradingDay, d.reason])).toEqual([
      ['2026-08-04', 'missed_catch_up'],
      ['2026-08-05', 'scheduled'],
    ]);
    expect(due[0]?.detail).toContain('labelled late, rather than being skipped');
  });

  it('never sends a future day early', () => {
    expect(briefsDue({ schedule, tradingDays: ['2026-08-09'], now: '2026-08-05T07:31:00Z' })).toEqual([]);
  });
});
