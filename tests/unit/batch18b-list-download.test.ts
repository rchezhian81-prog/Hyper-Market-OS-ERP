import { describe, it, expect } from 'vitest';
import {
  BOM, REDACTED, csvCell, flushPending, isPersonalKey, listFile, listFileName, maySeePersonal, neutralise, pendingRecords, recordDownload,
  type ListDownloadRecord, type PendingStorage,
} from '../../apps/web-erp/src/list-download';
import { parseDelimited } from '../../packages/import/src/delimited';

/**
 * **Batch 18b · B1 — "Download to Excel" on every list (M30-FR-02 · P-06 · NFR-12).** The file every office list writes:
 * a UTF-8 byte-order mark so Excel keeps Tamil, the columns in screen order, the export engine's personal-data rule (the
 * SAME permission and the SAME `[redacted]` marker — never weakened), no cell that could run as a formula, and the record
 * of each download kept until head office takes it (never dropped).
 */

const memory = (): PendingStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
};
const record = (key: string): ListDownloadRecord => ({ key, screen: '/customers/', list: 'customers', label: 'Customers', rowCount: 2, columns: ['Customer', 'Segment'], redactedColumns: ['Customer'], downloadedAt: '2026-11-19T06:00:00.000Z' });
const reply = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch;

describe('batch 18b · B1 — the list file', () => {
  const columns = [
    { key: 'product', label: 'Item', personal: false },
    { key: 'customerRef', label: 'Customer', personal: true },
    { key: 'note', label: 'குறிப்பு', personal: false },
  ];
  const rows = [['துவரம் பருப்பு 1kg', 'CUST-1', 'சரி'], ['Rice, 25 kg "Ponni"', 'CUST-2', '=HYPERLINK("x")']];

  it('starts with the byte-order mark, keeps Tamil, quotes commas and quotes, and keeps screen order', () => {
    const f = listFile(columns, rows, true);
    expect(f.text.startsWith(BOM)).toBe(true);
    expect(f.text.slice(1).split('\r\n')[0]).toBe('Item,Customer,குறிப்பு');
    expect(f.text).toContain('துவரம் பருப்பு 1kg,CUST-1,சரி');
    expect(f.text).toContain('"Rice, 25 kg ""Ponni""",CUST-2');
    expect(f.rowCount).toBe(2);
    expect(f.redactedColumns).toEqual([]);
    // Any spreadsheet or system reads it back unchanged (P-06): our own importer reads it, byte-order mark and all.
    const back = parseDelimited(f.text);
    expect(back.rows[0]).toEqual({ Item: 'துவரம் பருப்பு 1kg', Customer: 'CUST-1', 'குறிப்பு': 'சரி' });
  });

  it('personal data is redacted (not dropped) unless the person holds export.sensitive — the engine\'s own rule', () => {
    const f = listFile(columns, rows, false);
    expect(f.text.slice(1).split('\r\n')[1]).toBe(`துவரம் பருப்பு 1kg,${REDACTED},சரி`);
    expect(f.redactedColumns).toEqual(['Customer']);
    expect(maySeePersonal(['export.read'])).toBe(false);
    expect(maySeePersonal(['export.read', 'export.sensitive'])).toBe(true);
    expect(maySeePersonal(undefined)).toBe(false); // a person whose permissions the page was not told: redacted
    for (const k of ['customerRef', 'memberRef', 'mobile', 'phone', 'email', 'address', 'consentEvidence']) expect(isPersonalKey(k), k).toBe(true);
    for (const k of ['customerId', 'supplierId', 'name', 'amountMinor']) expect(isPersonalKey(k), k).toBe(false);
  });

  it('a value that would run as a formula is written as text; a plain negative amount is left as it is', () => {
    expect(neutralise('=1+1')).toBe("'=1+1");
    expect(neutralise('+91 98')).toBe("'+91 98");
    expect(neutralise('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(neutralise('-cmd')).toBe("'-cmd");
    expect(neutralise('-40.00')).toBe('-40.00');
    expect(neutralise('-₹0.40')).toBe('-₹0.40');
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
  });

  it('names the file from the list in plain letters and the shop\'s day', () => {
    expect(listFileName('Goods receipts', '2026-11-19')).toBe('Goods-receipts-2026-11-19.csv');
    expect(listFileName('சரக்கு', '2026-11-19')).toBe('list-2026-11-19.csv');
    expect(listFileName('Customers / consent', 'not a day')).toBe('Customers-consent.csv');
  });
});

describe('batch 18b · B1 — the record of each download', () => {
  it('head office takes it: nothing waits on this computer', async () => {
    const s = memory();
    const out = await recordDownload(record('k1'), s, reply(201));
    expect(out).toEqual({ outcome: 'recorded', waiting: 0, kept: true });
    expect(pendingRecords(s)).toEqual([]);
  });

  it('head office out of reach: the record is kept here, and sent (with any earlier one) when it answers — never dropped', async () => {
    const s = memory();
    expect(await recordDownload(record('k1'), s, (async () => { throw new TypeError('offline'); }) as unknown as typeof fetch)).toEqual({ outcome: 'lost_link', waiting: 1, kept: true });
    expect(await recordDownload(record('k2'), s, reply(503))).toEqual({ outcome: 'lost_link', waiting: 2, kept: true });
    expect(pendingRecords(s).map((r) => r.key)).toEqual(['k1', 'k2']);
    const sent: string[] = [];
    const fetchFn = (async (_u: string, init: { headers: Record<string, string> }) => { sent.push(init.headers['idempotency-key']!); return new Response('{}', { status: 201 }); }) as unknown as typeof fetch;
    expect(await flushPending(s, fetchFn)).toBe(0);
    expect(sent).toEqual(['k1', 'k2']);
    expect(pendingRecords(s)).toEqual([]);
  });

  it('a refusal is kept and said, not dropped; a computer that cannot keep it says so', async () => {
    const s = memory();
    expect(await recordDownload(record('k1'), s, reply(400))).toEqual({ outcome: 'refused', waiting: 1, kept: true });
    const broken: PendingStorage = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    expect(await recordDownload(record('k3'), broken, reply(503))).toEqual({ outcome: 'lost_link', waiting: 1, kept: false });
  });
});
