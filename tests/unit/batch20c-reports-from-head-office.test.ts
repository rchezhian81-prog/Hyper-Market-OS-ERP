import { describe, it, expect } from 'vitest';
import { REPORTS } from '../../packages/reporting/src/index';
import { PRODUCED, createReportingSession, type ReportingPorts } from '../../apps/web-erp/src/reporting-session';
import {
  AT_HEAD_OFFICE, NOW_AT_HEAD_OFFICE, HEAD_OFFICE_NOT_REACHED, NOW_FOR_PERIOD_AT_HEAD_OFFICE, GST_WHOLE_MONTHS, PERIOD_NOT_STARTED,
  runAtHeadOffice, wholeMonths, reasonIn,
} from '../../apps/web-erp/src/reporting-head-office';
import { PRODUCED_AT_HEAD_OFFICE } from '../../services/api/src/report-producers';
import { AccessControl } from '../../packages/rbac/src/index';
import type { HeadOfficeHttp, HttpAnswer } from '../../apps/web-erp/src/head-office-http';

/**
 * Batch 20c · O2 — the Reports page's eighteen head-office reports: which they are, how the page asks for them, and what it
 * says when it cannot have them. (The real routes are proven in tests/integration/batch20c-reports-from-head-office-for-a-period.)
 */

const NOW = '2026-11-20T06:00:00.000Z';
const TODAY = '2026-11-20';
const fake = (answers: Record<string, HttpAnswer>, asked: string[] = []): HeadOfficeHttp => ({
  get: async (path) => { asked.push(path); return answers[path] ?? { result: 'refused', status: 404, code: 'no_such', whatHappened: 'nothing here' }; },
  post: async () => ({ result: 'lost_link' }),
});
const run = (reportId: string, asked: { from: string; to: string }, http: HeadOfficeHttp | undefined) =>
  runAtHeadOffice({ reportId, http, asked, today: TODAY, now: NOW, laggingAfterMinutes: 5, staleAfterMinutes: 60 });

describe('every one of the 29 reports runs: on the store computer, or from head office', () => {
  it('the store computer\'s reports and head office\'s are the whole catalogue, with no report in both', () => {
    expect(REPORTS).toHaveLength(29);
    expect([...PRODUCED, ...AT_HEAD_OFFICE].sort()).toEqual(REPORTS.map((r) => r.id).sort());
    expect(AT_HEAD_OFFICE.filter((id) => PRODUCED.includes(id))).toEqual([]);
    expect(AT_HEAD_OFFICE).toHaveLength(18);
  });

  it('head office has a producer for every one the page asks it for', () => {
    for (const id of AT_HEAD_OFFICE) expect(PRODUCED_AT_HEAD_OFFICE, id).toContain(id);
  });

  it('with every fact recorded, the catalogue offers all 29; a head-office report is run by asking head office, never by this box', () => {
    const all = [...new Set(REPORTS.flatMap((r) => r.needs))];
    const ports: ReportingPorts = {
      access: () => new AccessControl([], []), records: () => all, sales: () => [], lastSyncedAt: () => null, unsentCount: () => 0,
      exceptions: () => [], exceptionRulesKnown: () => false, dayTotals: () => [], unitsByCategory: () => ({}), unitsWithNoCategory: () => 0, categoryNames: () => undefined,
    };
    const session = createReportingSession({ tenantId: 't', storeId: 's', userId: 'u', currency: 'INR', now: NOW, laggingAfterMinutes: 5, staleAfterMinutes: 60, branchId: null, tradingDay: TODAY }, ports);
    expect(session.catalogue().filter((e) => e.availability.available)).toHaveLength(29);
    expect(session.atHeadOffice('waste')).toBe(true);
    expect(session.atHeadOffice('sales_by_day')).toBe(false);
    const refused = session.run('waste');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal).toBe('worked_out_at_head_office');
    const exported = session.export('waste');
    expect('csv' in exported).toBe(false);
  });
});

describe('asking head office', () => {
  it('a period report asks for exactly the days chosen and says what head office says it covers', async () => {
    const asked: string[] = [];
    const http = fake({ '/v1/reports/waste?from=2026-11-01&to=2026-11-20': { result: 'ok', status: 200, body: { figures: [{ name: 'Write-offs', valueMinor: 3, unit: 'count', asAt: NOW, staleness: 'live', detail: '' }], rows: [{ writeOffId: 'WO-1' }], period: { from: '2026-11-01', to: '2026-11-20' } } } }, asked);
    const r = await run('waste', { from: '2026-11-01', to: '2026-11-30' }, http);
    expect(asked).toEqual(['/v1/reports/waste?from=2026-11-01&to=2026-11-20']);
    expect(r?.state).toBe('shown');
    expect(r?.covers).toEqual({ from: '2026-11-01', to: '2026-11-20' });
    expect(r?.rows).toEqual([{ writeOffId: 'WO-1' }]);
  });

  it('a report about now: asked without a period on Today; for another period, not known and nobody is asked', async () => {
    for (const id of NOW_AT_HEAD_OFFICE) {
      const asked: string[] = [];
      const http = fake({ [`/v1/reports/${id}`]: { result: 'ok', status: 200, body: { figures: [], rows: [] } } }, asked);
      expect((await run(id, { from: TODAY, to: TODAY }, http))?.now).toBe(true);
      expect(asked).toEqual([`/v1/reports/${id}`]);
      const past = await run(id, { from: '2026-11-19', to: '2026-11-19' }, http);
      expect(past?.state).toBe('not_for_period');
      expect(past?.figures[0]?.notAvailableBecause).toBe(NOW_FOR_PERIOD_AT_HEAD_OFFICE);
      expect(asked).toHaveLength(1);
    }
  });

  it('no head office: "Not known — head office cannot be reached", one figure, no value — never a nought, never a copy', async () => {
    for (const http of [undefined, fake({}), { get: async (): Promise<HttpAnswer> => ({ result: 'lost_link' }), post: async (): Promise<HttpAnswer> => ({ result: 'lost_link' }) }]) {
      const r = await run('shrinkage', { from: TODAY, to: TODAY }, http as HeadOfficeHttp | undefined);
      if (http !== undefined && r?.state === 'refused') { expect(r.figures[0]?.notAvailableBecause).toBe('Not shown — head office said: nothing here'); continue; }
      expect(r?.state).toBe('not_reached');
      expect(r?.figures.map((f) => [f.valueMinor, f.notAvailableBecause])).toEqual([[undefined, HEAD_OFFICE_NOT_REACHED]]);
    }
  });

  it('a period that has not started is not known; an unknown report is not asked for', async () => {
    expect((await run('waste', { from: '2026-12-01', to: '2026-12-31' }, fake({})))?.figures[0]?.notAvailableBecause).toBe(PERIOD_NOT_STARTED);
    expect(await run('sales_by_day', { from: TODAY, to: TODAY }, fake({}))).toBeUndefined();
  });
});

describe('GST from the GST returns, by whole months', () => {
  it('whole months: from the 1st to a month\'s last day, or this month to today', () => {
    expect(wholeMonths({ from: '2026-10-01', to: '2026-10-31' }, TODAY)).toEqual(['2026-10']);
    expect(wholeMonths({ from: '2026-09-01', to: '2026-11-20' }, TODAY)).toEqual(['2026-09', '2026-10', '2026-11']);
    expect(wholeMonths({ from: '2026-02-01', to: '2026-02-28' }, TODAY)).toEqual(['2026-02']);
    expect(wholeMonths({ from: '2026-11-02', to: '2026-11-20' }, TODAY)).toBeNull();
    expect(wholeMonths({ from: '2026-10-01', to: '2026-10-30' }, TODAY)).toBeNull();
    expect(wholeMonths({ from: TODAY, to: TODAY }, TODAY)).toBeNull();
  });

  it('adds GSTR-3B\'s heads month by month; purchase GST not reconciled is not known, naming the month', async () => {
    const month = (period: string, taxable: number, itc: 'reconciled' | 'not_reconciled') => ({
      period, basis: 'provisional_gstr1_not_filed',
      table31: { a: { taxableMinor: taxable, cgstMinor: taxable / 20, sgstMinor: taxable / 20, igstMinor: 0 }, c: { taxableMinor: 500 }, d: { taxableMinor: 0, cgstMinor: 0, sgstMinor: 0, igstMinor: 0 } },
      table4: { a5AllOther: itc === 'reconciled' ? { status: 'reconciled', cgstMinor: 10, sgstMinor: 10, igstMinor: 0, cessMinor: 0, detail: 'ok' } : { status: 'not_reconciled', detail: 'GSTR-2B not imported' } },
      exceptions: [],
    });
    const asked: string[] = [];
    const http = fake({
      '/v1/finance/gstr3b/102026': { result: 'ok', status: 200, body: month('102026', 10_000, 'reconciled') },
      '/v1/finance/gstr3b/112026': { result: 'ok', status: 200, body: month('112026', 20_000, 'not_reconciled') },
    }, asked);
    const r = await run('gst', { from: '2026-10-01', to: '2026-11-20' }, http);
    expect(asked).toEqual(['/v1/finance/gstr3b/102026', '/v1/finance/gstr3b/112026']);
    expect(r?.figures.find((f) => f.name === 'Taxable sales (GSTR-3B 3.1 a)')?.valueMinor).toBe(30_000);
    expect(r?.figures.find((f) => f.name === 'GST collected — CGST')?.valueMinor).toBe(1_500);
    expect(r?.figures.find((f) => f.name === 'Nil-rated and exempt sales (3.1 c)')?.valueMinor).toBe(1_000);
    expect(r?.figures.find((f) => f.name === 'GST paid on purchases you may claim (4 A 5)')?.notAvailableBecause).toBe('Not known — the purchase GST you may claim is not reconciled yet for 11/2026 (GSTR-2B not imported)');
    expect(r?.rows.map((row) => [row['month'], row['claimableMinor']])).toEqual([['10/2026', '20'], ['11/2026', 'not known']]);
    expect(r?.notes).toEqual(['10/2026: provisional — GSTR-1 not filed yet, so these will move as sales are banked', '11/2026: provisional — GSTR-1 not filed yet, so these will move as sales are banked']);

    const week = await run('gst', { from: '2026-11-16', to: TODAY }, http);
    expect(week?.figures[0]?.notAvailableBecause).toBe(GST_WHOLE_MONTHS);
    expect(asked).toHaveLength(2);
  });
});

describe('one language at a time', () => {
  it('the page\'s own sentences have Tamil; head office\'s own words stay as it said them', () => {
    for (const en of [HEAD_OFFICE_NOT_REACHED, NOW_FOR_PERIOD_AT_HEAD_OFFICE, GST_WHOLE_MONTHS, PERIOD_NOT_STARTED]) {
      expect(reasonIn('en', en)).toBe(en);
      expect(reasonIn('ta', en)).not.toBe(en);
      expect(reasonIn('ta', en)).not.toMatch(/[A-Za-z]{4,}/);
    }
    expect(reasonIn('ta', 'Not shown — head office said: You may not read reports.')).toBe('காட்டப்படவில்லை — தலைமை அலுவலகம் சொன்னது: You may not read reports.');
    expect(reasonIn('ta', '11/2026: provisional — GSTR-1 not filed yet, so these will move as sales are banked')).toMatch(/^11\/2026: தற்காலிகம்/);
    expect(reasonIn('ta', 'something head office said')).toBe('something head office said');
  });
});
