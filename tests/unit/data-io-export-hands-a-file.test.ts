import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataIoPortsFromData } from '../../apps/web-erp/src/browser-entry';
import { createDataIoSession, exportReplyOf } from '../../apps/web-erp/src/data-io-session';

/**
 * **Pressing Export hands the person a real file (Round B · M30-FR-02 · P-06 · P-08).** Before this, the Admin
 * "Import & export" page said "Exported." and the person got nothing: the shell threw away the CSV head office sent
 * back. Now the CSV head office returned is handed to the browser to save, under a plain name; and when head office
 * answers with nothing that can be saved, the page says so — it never says "Exported" for nothing.
 */

const CSV = 'sku,name\nRICE5,Rice 5kg\n';
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function answer(status: number, body: unknown): void {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch;
}
const ports = () => dataIoPortsFromData({ userId: 'u-op', permissions: ['export.read'] });

describe('an export hands the browser the file head office returned', () => {
  it('a plain export carries head office\'s own CSV as a file to save, with the rows and hidden columns', async () => {
    answer(200, { domain: 'products', csv: CSV, audit: { rowCount: 1, redactedColumns: ['cost'], at: '2026-10-30T20:00:00.000Z' } });
    const r = await ports().runExport('products');
    expect(r).toEqual({
      kind: 'exported', rowCount: 1, redactedColumns: ['cost'],
      // 20:00 UTC on the 30th is the 31st in the shop (IST) — the file is named by the shop's day.
      file: { fileName: 'products-2026-10-31.csv', mime: 'text/csv;charset=utf-8', content: CSV },
    });
    const s = createDataIoSession({ userId: 'u-op' }, ports());
    const said = s.presentExportResult('en', r);
    expect(said.tone).toBe('ok');
    expect(said.label).toBe('Exported 1 row. Hidden for you: cost. Saved to this computer as products-2026-10-31.csv.');
    expect(s.presentExportResult('ta', r).label).toContain('products-2026-10-31.csv');
  });

  it('a dated export carries the file too, named by its period', async () => {
    answer(200, { domain: 'attendance', csv: CSV, audit: { rowCount: 3, redactedColumns: [] } });
    const r = await ports().runPeriodExport!('attendance', { from: '2026-10-01', to: '2026-10-07' });
    expect(r.kind).toBe('exported');
    if (r.kind !== 'exported') return;
    expect(r.file).toEqual({ fileName: 'attendance-2026-10-01-to-2026-10-07.csv', mime: 'text/csv;charset=utf-8', content: CSV });
  });

  it('when head office sends back nothing to save, the page says so — never "Exported"', async () => {
    answer(200, { domain: 'products', audit: { rowCount: 0 } });
    const r = await ports().runExport('products');
    expect(r).toEqual({ kind: 'no_file' });
    const s = createDataIoSession({ userId: 'u-op' }, ports());
    for (const lang of ['en', 'ta'] as const) {
      const said = s.presentExportResult(lang, r);
      expect(said.tone).toBe('error');
      expect(said.needsAttention).toBe(true);
      expect(said.label).not.toMatch(/^Exported/);
    }
    expect(s.presentExportResult('en', r).label).toContain('no file');
    expect(exportReplyOf('products', { csv: '   ' })).toEqual({ kind: 'no_file' });
    expect(exportReplyOf('products', null)).toEqual({ kind: 'no_file' });
  });

  it('a refusal carries head office\'s own words; no link is said as no link', async () => {
    answer(403, { error: { code: 'export_not_permitted', whatHappened: "You may not export 'products'." } });
    const r = await ports().runExport('products');
    expect(r).toEqual({ kind: 'refused', code: 'export_not_permitted', whatHappened: "You may not export 'products'." });
    globalThis.fetch = vi.fn(async () => { throw new Error('offline'); }) as typeof fetch;
    expect(await ports().runExport('products')).toEqual({ kind: 'lost_link' });
  });

  it('the page saves the file it was handed (a download link with the file name), on both export buttons', () => {
    const page = readFileSync(join(__dirname, '../../apps/web-erp/web/data-io.js'), 'utf8');
    expect(page).toMatch(/function saveFile\(file\)[\s\S]*URL\.createObjectURL\(new Blob\(\[file\.content\]/);
    expect(page).toMatch(/a\.download = file\.fileName/);
    const plain = page.slice(page.indexOf('async function runExport('), page.indexOf('async function runPeriodExport('));
    const dated = page.slice(page.indexOf('async function runPeriodExport('));
    expect(plain).toContain('saveFile(r.file)');
    expect(dated.slice(0, dated.indexOf('\n}\n'))).toContain('saveFile(r.file)');
  });
});
