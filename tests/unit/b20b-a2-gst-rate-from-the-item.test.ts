import { describe, it, expect } from 'vitest';
import { percentToBps, bpsToPercent, gstRateMark, gstRateSecondLook, createSupplierBillsSession, typedCaptureBody, type HeadOfficeCall } from '../../apps/web-erp/src/supplier-bills-session';
import { createBillCheckSession } from '../../apps/web-erp/src/supplier-bills-to-the-books-session';

/**
 * **Batch 20b · A2 (M07-FR-04 · D-043) — a paper bill's GST rate is filled from the item as a STARTING value.** The rate box is
 * filled from the item master's rate and marked "from the item — check against the bill"; what the person types is kept; a
 * rate that differs from the item's is flagged for a second look and named in the second person's check — never changed
 * back. The rate is NOT part of the bill sent to head office: nothing about how GST is worked out or posted changes.
 */

describe('A2: the GST rate of a typed line', () => {
  it('reads a rate as a person writes it, and says it as a bill prints it', () => {
    expect(['5', '18%', ' 12 % ', '2.5', '0', '28'].map(percentToBps)).toEqual([500, 1800, 1200, 250, 0, 2800]);
    expect(['', 'five', '-5', '123', '5.123', '41'].map(percentToBps)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect([500, 250, 1800, 0].map(bpsToPercent)).toEqual(['5', '2.5', '18', '0']);
  });

  it('marks the box: from the item, differs (flagged), no rate held, not a rate, not looked up yet', () => {
    expect(gstRateMark('5', 500)).toEqual({ kind: 'from_item', itemPercent: '5' });
    expect(gstRateMark('', 500)).toEqual({ kind: 'from_item', itemPercent: '5' });
    expect(gstRateMark('12', 500)).toEqual({ kind: 'differs', itemPercent: '5', typedPercent: '12' });
    expect(gstRateMark('18', null)).toEqual({ kind: 'no_item_rate' });
    expect(gstRateMark('five', 500)).toEqual({ kind: 'not_a_rate' });
    expect(gstRateMark('5', undefined)).toEqual({ kind: 'not_looked_up' });
  });

  it('names only the differing lines for the second person', () => {
    expect(gstRateSecondLook([
      { productId: 'OIL', rate: '5', itemBps: 500 }, { productId: 'RICE', rate: '12', itemBps: 500 }, { productId: 'SALT', rate: '5', itemBps: null },
    ])).toEqual(['line 2 (RICE): GST typed 12%, the item says 5%']);
  });

  it('asks head office for the items\' rates — one read, only rates — and says an item with none held as null', async () => {
    const asked: string[] = [];
    const call: HeadOfficeCall = async (r) => { asked.push(`${r.method} ${r.path}`); return { status: 200, body: { rates: { OIL: 500, SALT: null, ODD: -1 } } }; };
    const s = createSupplierBillsSession(call, { permissions: ['purchase.invoice.capture'] });
    const got = await s.itemGstRates(['OIL', ' SALT ', 'OIL', '', 'ODD']);
    expect(asked).toEqual(['GET /v1/catalogue/item-gst-rates?productIds=OIL,SALT,ODD']);
    expect(got).toEqual({ ok: true, value: { OIL: 500, SALT: null, ODD: null } });
    expect(await s.itemGstRates([])).toEqual({ ok: true, value: {} });
    expect(asked).toHaveLength(1);
    const lost = createSupplierBillsSession(async () => 'unreachable', { permissions: [] });
    expect(await lost.itemGstRates(['OIL'])).toEqual({ ok: false, unreachable: true });
  });

  it('the bill sent is unchanged (no rate in it); the second person\'s check names the differing rate', async () => {
    const typed = typedCaptureBody({ invoiceId: 'sup-k-7', supplierId: 'sup-k', poId: 'po-1', total: '525', lines: [{ productId: 'RICE', quantity: '10', unitPrice: '50', amount: '500', cgst: '12.50', sgst: '12.50' }], documentId: '' });
    if (!typed.ok) throw new Error('typed');
    expect(JSON.stringify(typed.body)).not.toMatch(/rate/i);
    const calls: { body: Record<string, unknown> }[] = [];
    const fetch = (async (_u: string | URL | Request, init?: RequestInit) => { calls.push({ body: JSON.parse(String(init?.body)) }); return new Response(JSON.stringify({ requestId: 'r1' }), { status: 200 }); }) as typeof globalThis.fetch;
    const s = createBillCheckSession({ viewer: { userId: 'u-buyer', permissions: ['purchase.invoice.capture'] }, fetch });
    await s.askCheck({ invoiceId: typed.invoiceId, body: typed.body, secondLook: ['line 1 (RICE): GST typed 12%, the item says 5%'] });
    expect(calls[0]!.body['summary']).toBe('Supplier bill sup-k-7 from sup-k: ₹525.00 — look again at the GST rate: line 1 (RICE): GST typed 12%, the item says 5%');
    expect(calls[0]!.body['reason']).toBe('Check the typed bill against the paper — a GST rate differs from the item\'s');
    expect(calls[0]!.body['details']).toEqual({ ...typed.body, invoiceId: 'sup-k-7' });
    await s.askCheck({ invoiceId: typed.invoiceId, body: typed.body, secondLook: [] });
    expect(calls[1]!.body['summary']).toBe('Supplier bill sup-k-7 from sup-k: ₹525.00');
  });
});
