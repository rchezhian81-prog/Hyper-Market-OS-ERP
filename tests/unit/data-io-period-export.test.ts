import { describe, it, expect } from 'vitest';
import {
  DATA_IO_COPY, COPY_KEYS, createDataIoSession, defaultExportPeriod,
  type DataIoPorts, type ExportDomainView,
} from '../../apps/web-erp/src/data-io-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **A dated export domain takes a period on the data import & export console (audit SF-10 round 5c · M30-FR-02).** The
 * page offers From / To for a domain head office says is dated (attendance), defaulting to the last 7 days ending
 * yesterday in the shop's calendar; sends the period; says how many rows were taken and what was hidden; and puts a
 * refused period in the page's own plain words, in English and Tamil.
 */

const PRODUCTS: ExportDomainView = { domain: 'products', requires: 'catalogue.pack.read', columns: [{ name: 'sku', type: 'text', sensitive: false }] };
const ATT: ExportDomainView = { domain: 'attendance', requires: 'workforce.roster.read', period: { required: true, maxDays: 31 }, columns: [{ name: 'hours', type: 'text', sensitive: true }] };

const ports = (over: Partial<DataIoPorts> = {}): DataIoPorts => ({
  exportDomains: () => [PRODUCTS, ATT], recentExports: () => [], importTemplates: () => [],
  mayExport: () => true, mayImport: () => true, mayCommitImport: () => true,
  runExport: async () => 'exported', validate: async () => 'refused', commit: async () => 'lost_link',
  ...over,
});
const dated = (over: Partial<DataIoPorts> = {}, now = '2026-10-10T20:00:00.000Z') => createDataIoSession({ userId: 'u-op', now: () => now }, ports(over));

describe('a dated export domain takes a period (SF-10 · attendance)', () => {
  it('offers the last 7 days ending yesterday in the shop\'s calendar, and only on the dated domain', () => {
    // 20:00 UTC on the 10th is 01:30 on the 11th in the shop (IST): yesterday is the 10th.
    expect(defaultExportPeriod('2026-10-10T20:00:00.000Z')).toEqual({ from: '2026-10-04', to: '2026-10-10' });
    expect(defaultExportPeriod('2026-10-10T10:00:00.000Z')).toEqual({ from: '2026-10-03', to: '2026-10-09' });
    const view = dated().exportPanel('en');
    expect(view.domains.find((d) => d.domain === 'attendance')!.period).toMatchObject({ maxDays: 31, defaultFrom: '2026-10-04', defaultTo: '2026-10-10' });
    expect(view.domains.find((d) => d.domain === 'products')!.period).toBeUndefined();
    expect(dated().exportPanel('ta').domains.find((d) => d.domain === 'attendance')!.period!.hint).toContain('31');
  });

  it('sends the period, says the rows and what was hidden, and puts a refused period in plain words (en/ta)', async () => {
    const sent: unknown[] = [];
    const s = dated({ runPeriodExport: async (domain, period) => { sent.push([domain, period]); return { kind: 'exported', rowCount: 5, redactedColumns: ['hours'] }; } });
    const r = await s.runPeriodExport('attendance', { from: ' 2026-09-01', to: '2026-09-03 ' });
    expect(sent).toEqual([['attendance', { from: '2026-09-01', to: '2026-09-03' }]]);
    expect(s.presentExportReply('en', 'attendance', r).label).toBe('Exported 5 rows. Hidden for you: hours.');
    const refused = { kind: 'refused', code: 'export_period_not_bounded', whatHappened: "'attendance' is exported for a bounded period: { \"from\" ... }" } as const;
    const en = s.presentExportReply('en', 'attendance', refused);
    expect(en.tone).toBe('error');
    expect(en.label).toContain('at most 31 days');
    expect(en.label).not.toContain('{');
    expect(s.presentExportReply('ta', 'attendance', refused).label).toContain('31');
    expect(s.presentExportReply('en', 'attendance', { kind: 'refused', code: 'export_not_permitted', whatHappened: "You may not export 'attendance'." }).label)
      .toBe("Not exported — You may not export 'attendance'.");
  });

  it('without export permission nothing is sent; with no link the page says so', async () => {
    let posted = false;
    const no = dated({ mayExport: () => false, runPeriodExport: async () => { posted = true; return { kind: 'lost_link' }; } });
    expect((await no.runPeriodExport('attendance', { from: '2026-09-01', to: '2026-09-02' })).kind).toBe('refused');
    expect(posted).toBe(false);
    expect(await dated().runPeriodExport('attendance', { from: '2026-09-01', to: '2026-09-02' })).toEqual({ kind: 'lost_link' });
  });

  it('every new label is in English and Tamil', () => {
    expect(bilingualGaps(DATA_IO_COPY)).toEqual({ en: [], ta: [] });
    for (const k of ['periodFrom', 'periodTo', 'periodHint', 'exportedRows', 'exportedHidden', 'periodRefused', 'exportRefusedWords'] as const) expect(COPY_KEYS).toContain(k);
  });
});
