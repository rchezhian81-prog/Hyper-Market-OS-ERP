import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Scheduled daily brief, end to end (M29-FR-04, API-10). The brief that sends itself: a durable schedule
// (due time, language), which briefs are DUE now with a MISSED day carried (not skipped — a silent no-show is
// indistinguishable from a quiet day), an append-only send record (a day sent twice is one send), and a brief
// composed COMPLETE without any AI (the numbers ARE the brief; the narrative is additive, dropped when absent,
// low-confidence, wrong-language or evidence-free). Config/send gated owner.brief.manage; read/due/build read
// owner.kpi.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const TODAY = new Date().toISOString().slice(0, 10); // the harness runs on the real clock, same as the server

const figures = (over: Record<string, unknown> = {}) =>
  ({ tradingDay: '2026-09-02', netSalesMinor: 12345600, marginMinor: 2469120, marginBps: 2000, basketCount: 340, cashBankedMinor: 5000000, dataAgeMinutes: 30, ...over });

const setSchedule = (h: ApiHarness, u: string, body: Record<string, unknown>, key = 's-1') =>
  h.request({ method: 'POST', path: '/v1/reporting/brief-schedule', userId: u, tenantId: A, idempotencyKey: key, body });
const getSchedule = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/reporting/brief-schedule', userId: u, tenantId: A });
const due = (h: ApiHarness, u: string, body: Record<string, unknown>, key = 'd-1') =>
  h.request({ method: 'POST', path: '/v1/reporting/brief-schedule/due', userId: u, tenantId: A, idempotencyKey: key, body });
const sent = (h: ApiHarness, u: string, body: Record<string, unknown>, key = 'sent-1') =>
  h.request({ method: 'POST', path: '/v1/reporting/brief-schedule/sent', userId: u, tenantId: A, idempotencyKey: key, body });
const build = (h: ApiHarness, u: string, body: Record<string, unknown>, key = 'b-1') =>
  h.request({ method: 'POST', path: '/v1/reporting/brief', userId: u, tenantId: A, idempotencyKey: key, body });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                // owner.brief.manage + owner.kpi.read
  await h.provisionRole(A, 'u-cash', 'cashier');  // neither
  return h;
}

describe('scheduled daily brief: sends itself, carries a missed day, works with no AI (M29-FR-04)', () => {
  it('sets a schedule, surfaces due (missed carried) and scheduled briefs, records a send idempotently', async () => {
    const h = await cast();
    expect((await setSchedule(h, 'u-owner', { dueAt: [0, 0], language: 'en' })).status).toBe(200);
    expect((await getSchedule(h, 'u-owner')).body).toMatchObject({ schedule: { dueAt: [0, 0], sentDays: [] } });

    // A day in the past never covered → carried as a labelled catch-up; today (past 00:00) → scheduled.
    const d = await due(h, 'u-owner', { tradingDays: ['2020-01-01', TODAY] });
    const list = (d.body as { due: { tradingDay: string; reason: string }[]; count: number });
    expect(list.due.find((x) => x.tradingDay === '2020-01-01')).toMatchObject({ reason: 'missed_catch_up' });
    expect(list.due.find((x) => x.tradingDay === TODAY)).toMatchObject({ reason: 'scheduled' });

    // Record the catch-up sent, twice (different request keys) — the day collapses to ONE send.
    expect((await sent(h, 'u-owner', { tradingDay: '2020-01-01' }, 'sent-a')).body).toMatchObject({ sentDays: ['2020-01-01'] });
    await sent(h, 'u-owner', { tradingDay: '2020-01-01' }, 'sent-b');
    expect((await getSchedule(h, 'u-owner')).body).toMatchObject({ schedule: { sentDays: ['2020-01-01'] } });

    // A day already sent is never due again.
    const after = await due(h, 'u-owner', { tradingDays: ['2020-01-01', TODAY] }, 'd-2');
    expect((after.body as { due: { tradingDay: string }[] }).due.some((x) => x.tradingDay === '2020-01-01')).toBe(false);

    // Durable across a restart.
    const h2 = apiHarness({ store: h.store });
    expect((await getSchedule(h2, 'u-owner')).body).toMatchObject({ schedule: { dueAt: [0, 0], sentDays: ['2020-01-01'] } });
  });

  it('builds a complete brief with NO AI — the numbers are the brief', async () => {
    const h = await cast();
    const res = await build(h, 'u-owner', { figures: figures(), attention: [{ headline: 'Unbanked cash', valueMinor: 300000, ref: 'cash-1' }] });
    expect(res.status).toBe(200);
    const brief = res.body as { deterministic: boolean; narrative?: string; narrativeUnavailableReason: string; lines: string[]; freshness: string; attention: unknown[] };
    expect(brief).toMatchObject({ deterministic: true, freshness: 'fresh' });
    expect(brief.narrative).toBeUndefined();
    expect(brief.narrativeUnavailableReason).toBe('no narrative was generated');
    expect(brief.lines.length).toBeGreaterThan(0); // the figures are present regardless
  });

  it('adds a confident, evidence-backed narrative but drops a low-confidence one (AI is additive)', async () => {
    const h = await cast();
    const withNarr = await build(h, 'u-owner', { figures: figures(), narrative: { text: 'Steady day, margin healthy.', confidence: 'high', evidenceRefs: ['e1'], language: 'en' } }, 'b-narr');
    expect(withNarr.body).toMatchObject({ deterministic: false, narrative: 'Steady day, margin healthy.' });

    const lowConf = await build(h, 'u-owner', { figures: figures(), narrative: { text: 'Maybe up?', confidence: 'low', evidenceRefs: ['e1'] } }, 'b-low');
    const brief = lowConf.body as { deterministic: boolean; narrative?: string; narrativeUnavailableReason: string };
    expect(brief.deterministic).toBe(true); // narrative dropped
    expect(brief.narrative).toBeUndefined();
    expect(brief.narrativeUnavailableReason).toContain('not confident enough');
  });

  it('leads with a not-live warning when the data is stale (P-08)', async () => {
    const h = await cast();
    await setSchedule(h, 'u-owner', { dueAt: [6, 0], staleAfterMinutes: 60 });
    const res = await build(h, 'u-owner', { figures: figures({ dataAgeMinutes: 200 }) }, 'b-stale'); // 200 > 60
    const brief = res.body as { freshness: string; lines: string[] };
    expect(brief.freshness).toBe('stale');
    expect(brief.lines[0]).toContain('NOT LIVE');
  });

  it('404s due/sent without a schedule, rejects a bad due time (400), and gates the routes', async () => {
    const h = await cast();
    expect((await due(h, 'u-owner', { tradingDays: [TODAY] }, 'd-none')).status).toBe(404);
    expect((await sent(h, 'u-owner', { tradingDay: TODAY }, 'sent-none')).status).toBe(404);

    const bad = await setSchedule(h, 'u-owner', { dueAt: [25, 0] }, 's-bad'); // hour out of range
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('schedule_needs_a_due_time');

    await setSchedule(h, 'u-owner', { dueAt: [6, 0] }, 's-ok');
    // A cashier holds neither owner.brief.manage nor owner.kpi.read → refused on write and read.
    expect((await setSchedule(h, 'u-cash', { dueAt: [6, 0] }, 's-cash')).status).toBe(403);
    expect((await build(h, 'u-cash', { figures: figures() }, 'b-cash')).status).toBe(403);
    expect((await getSchedule(h, 'u-cash')).status).toBe(403);
  });
});
