import { describe, it, expect } from 'vitest';
import {
  createTaxRatesSession, bpsOf, percentOf, gstLine, cessLine, requestLine, taxOutcomeWords, TAX_RATE_COPY, TAX_RATE_COPY_KEYS,
  type TaxRateHttp, type TaxChangeRequest,
} from '../../apps/web-erp/src/tax-rates-session';
import type { HttpAnswer } from '../../apps/web-erp/src/finance-close-session';

// M03-FR-03 (tax side) · A6 · A7: the Tax rates panel on Products and prices — a thin client over head office's tax-class
// routes. A GST CHANGE goes through head office's maker-checker engine (kind tax_rate_change, a Finance approver, never the
// asker): the panel asks for EXACTLY the change it will send and then sends it naming the approval. Synthetic data only.

const CATALOGUE_KEEPER = ['catalogue.pack.read', 'catalogue.pack.publish'];
const ACCOUNTANT = ['catalogue.pack.read', 'catalogue.tax.approve'];

function fakeHttp(answers: Record<string, HttpAnswer>, fallback: HttpAnswer = { status: 201, body: {} }): TaxRateHttp & { calls: { method: string; path: string; body?: unknown }[] } {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  return {
    calls,
    get: async (path) => { calls.push({ method: 'GET', path }); return answers[`GET ${path}`] ?? fallback; },
    post: async (path, body) => { calls.push({ method: 'POST', path, body }); return answers[`POST ${path}`] ?? fallback; },
  };
}

describe('the Tax rates panel (M03-FR-03 tax change with Finance approval)', () => {
  it('every word has a Tamil twin, and none is left in English', () => {
    for (const k of TAX_RATE_COPY_KEYS) {
      expect(TAX_RATE_COPY.ta[k].trim(), k).not.toBe('');
      expect(TAX_RATE_COPY.ta[k], k).not.toBe(TAX_RATE_COPY.en[k]);
    }
    expect(Object.keys(TAX_RATE_COPY.ta).sort()).toEqual([...TAX_RATE_COPY_KEYS].sort());
  });

  it('reads a typed percentage as exact basis points, and says basis points back as a percentage', () => {
    expect(bpsOf('18')).toBe(1800);
    expect(bpsOf(' 12.5 ')).toBe(1250);
    expect(bpsOf('0.25%')).toBe(25);
    expect(bpsOf('5.125')).toBeUndefined();
    expect(bpsOf('five')).toBeUndefined();
    expect(bpsOf('-5')).toBeUndefined();
    expect(percentOf(1800)).toBe('18');
    expect(percentOf(1250)).toBe('12.5');
    expect(percentOf(25)).toBe('0.25');
    expect(gstLine('en', { effectiveFrom: '2025-09-22', rateBps: 500 })).toBe('GST 5% from 2025-09-22');
    expect(gstLine('ta', { effectiveFrom: '2025-09-22', rateBps: 500 })).toBe('2025-09-22 முதல் ஜிஎஸ்டி 5%');
    expect(cessLine('en', { effectiveFrom: '2026-01-01', advaloremBps: 3600, specificPerQuantityMinor: 417_000, perQuantity: 1000 })).toBe('Cess 36% plus ₹4,170.00 per 1000 from 2026-01-01');
    expect(cessLine('en', { effectiveFrom: '2026-01-01', advaloremBps: 6000, specificPerQuantityMinor: 0, perQuantity: 1 })).toBe('Cess 60% from 2026-01-01');
    expect(cessLine('en', { effectiveFrom: '2027-01-01', advaloremBps: 0, specificPerQuantityMinor: 0, perQuantity: 1 })).toBe('No cess from 2027-01-01');
  });

  it('reads both schedules for an HSN code; an unreachable head office shows none', async () => {
    const http = fakeHttp({
      'GET /v1/catalogue/tax-classes/04061000/rates': { status: 200, body: { hsnCode: '04061000', schedule: [{ effectiveFrom: '2017-07-01', rateBps: 1200 }], count: 1 } },
      'GET /v1/catalogue/tax-classes/04061000/cess': { status: 200, body: { hsnCode: '04061000', schedule: [] } },
    });
    const s = createTaxRatesSession({ permissions: ACCOUNTANT }, http);
    expect(s.may).toEqual({ read: true, set: false });
    expect(await s.schedule(' 04061000 ')).toEqual({ kind: 'done', status: 200, body: { hsnCode: '04061000', gst: [{ effectiveFrom: '2017-07-01', rateBps: 1200 }], cess: [] } });
    const down = createTaxRatesSession({ permissions: ACCOUNTANT }, fakeHttp({}, { status: 0, body: null }));
    expect(await down.schedule('04061000')).toEqual({ kind: 'unreachable' });
    expect(await s.schedule('  ')).toEqual({ kind: 'invalid', detail: 'hsn' });
  });

  it('only the catalogue role records; the accountant (a Finance approver) sends nothing from here', async () => {
    const http = fakeHttp({});
    const s = createTaxRatesSession({ permissions: ACCOUNTANT }, http);
    const out = await s.setGst({ hsnCode: '04061000', effectiveFrom: '2025-09-22', ratePercent: '5' });
    expect(out).toEqual({ kind: 'not_allowed', needs: 'catalogue.pack.publish' });
    expect(await s.setCess({ hsnCode: '24022010', effectiveFrom: '2026-01-01', advaloremPercent: '36', specificRupees: '0', perQuantity: '1' })).toEqual({ kind: 'not_allowed', needs: 'catalogue.pack.publish' });
    expect(taxOutcomeWords('en', out, 'gst').text).toBe('Your role cannot record tax rates.');
    expect(http.calls).toEqual([]);
  });

  it('a first rate is sent as basis points; a change is refused in head office\'s own words and nothing else is sent', async () => {
    const http = fakeHttp({
      'POST /v1/catalogue/tax-classes/04061000/rates/2025-09-22': {
        status: 422, body: { error: { code: 'tax_change_needs_finance_approval', whatHappened: 'HSN "04061000" already carries 1200 bps (from 2017-07-01); changing it to 500 bps from 2025-09-22 is a tax change, which needs a Finance approver (the accountant or the owner) — never the person asking.', nextSafeAction: 'Nothing was changed.' } },
      },
    });
    const s = createTaxRatesSession({ permissions: CATALOGUE_KEEPER }, http);
    const first = await s.setGst({ hsnCode: '07019000', effectiveFrom: '2017-07-01', ratePercent: '0' });
    expect(taxOutcomeWords('en', first, 'gst')).toEqual({ ok: true, text: 'Saved at head office. The tills charge it from that date after the next price update.' });
    const change = await s.setGst({ hsnCode: '04061000', effectiveFrom: '2025-09-22', ratePercent: '5' });
    expect(change).toMatchObject({ kind: 'refused', code: 'tax_change_needs_finance_approval' });
    expect(taxOutcomeWords('en', change, 'gst').text).toMatch(/^Head office refused: HSN "04061000" already carries 1200 bps .* never the person asking\. Nothing was changed\.$/);
    expect(http.calls).toEqual([
      { method: 'POST', path: '/v1/catalogue/tax-classes/07019000/rates/2017-07-01', body: { rateBps: 0 } },
      { method: 'POST', path: '/v1/catalogue/tax-classes/04061000/rates/2025-09-22', body: { rateBps: 500 } },
    ]);
    // A rate that is not a number, or no date, is never sent.
    expect(await s.setGst({ hsnCode: '04061000', effectiveFrom: '22/09/2025', ratePercent: '5' })).toEqual({ kind: 'invalid', detail: 'gst' });
    expect(await s.setGst({ hsnCode: '04061000', effectiveFrom: '2025-09-22', ratePercent: 'five' })).toEqual({ kind: 'invalid', detail: 'gst' });
    expect(http.calls).toHaveLength(2);
  });

  it('asks a Finance approver for EXACTLY the change (the route\'s fingerprint), then sends it naming the approval — never a typed name', async () => {
    const approved: TaxChangeRequest = {
      requestId: 'areq-1', kind: 'tax_rate_change', subjectRef: '04061000', status: 'approved', decidedBy: 'u-acc', requestedAt: '2026-11-01T05:00:00Z',
      details: { rateBps: 500, hsnCode: '04061000', effectiveFrom: '2025-09-22' },
    };
    const http = fakeHttp({
      'POST /v1/approvals/requests': { status: 201, body: { requestId: 'areq-1', status: 'waiting' } },
      'GET /v1/approvals/requests': { status: 200, body: { waitingForMe: [], mine: [
        { ...approved, requestedAt: '2026-11-01T05:00:00Z' },
        { requestId: 'areq-0', kind: 'tax_rate_change', subjectRef: '04061000', status: 'rejected', decidedBy: 'u-acc', decisionReason: 'wrong date', requestedAt: '2026-10-31T05:00:00Z', details: { rateBps: 500, hsnCode: '04061000', effectiveFrom: '2025-09-20' } },
        { requestId: 'areq-x', kind: 'tax_rate_change', subjectRef: '22021010', status: 'waiting', requestedAt: '2026-11-01T06:00:00Z', details: { rateBps: 1800, hsnCode: '22021010', effectiveFrom: '2025-09-22' } },
        { requestId: 'areq-y', kind: 'price_change', subjectRef: '04061000', status: 'waiting', requestedAt: '2026-11-01T06:00:00Z', details: {} },
      ] } },
      'POST /v1/catalogue/tax-classes/04061000/rates/2025-09-22': { status: 201, body: { rate: { effectiveFrom: '2025-09-22', rateBps: 500 }, approvedBy: 'u-acc' } },
    });
    const s = createTaxRatesSession({ permissions: CATALOGUE_KEEPER }, http);
    expect(await s.askGstChange({ hsnCode: '04061000', effectiveFrom: '2025-09-22', ratePercent: '5', reason: '  ' })).toEqual({ kind: 'invalid', detail: 'reason' });
    const asked = await s.askGstChange({ hsnCode: '04061000', effectiveFrom: '2025-09-22', ratePercent: '5', reason: 'GST 2.0 notification' });
    expect(taxOutcomeWords('en', asked, 'ask').text).toMatch(/^Asked\. A Finance approver \(the accountant or the owner\) decides it/);
    expect(http.calls[0]).toEqual({ method: 'POST', path: '/v1/approvals/requests', body: {
      kind: 'tax_rate_change', subjectRef: '04061000', valueMinor: null, details: { rateBps: 500, hsnCode: '04061000', effectiveFrom: '2025-09-22' },
      summary: 'HSN 04061000: GST 5% from 2025-09-22', reason: 'GST 2.0 notification',
    } });
    const mine = await s.myRequests('04061000');
    expect(mine.kind === 'done' ? mine.body.map((r) => r.requestId) : mine).toEqual(['areq-1', 'areq-0']);
    if (mine.kind !== 'done') throw new Error('unreachable');
    expect(requestLine('en', mine.body[0]!)).toBe('5% from 2025-09-22 — approved by u-acc');
    expect(requestLine('en', mine.body[1]!)).toBe('5% from 2025-09-20 — refused by u-acc: wrong date');
    const saved = await s.saveApprovedGst(approved);
    expect(http.calls.at(-1)).toEqual({ method: 'POST', path: '/v1/catalogue/tax-classes/04061000/rates/2025-09-22', body: { rateBps: 500, approvalId: 'areq-1' } });
    expect(taxOutcomeWords('en', saved, 'gst').text).toBe('Saved at head office with the approval of u-acc. The tills charge it from that date after the next price update.');
    expect(JSON.stringify(http.calls)).not.toContain('approvedBy');
  });

  it('a cess is sent in head office\'s units; an unreachable head office says nothing was saved', async () => {
    const http = fakeHttp({});
    const s = createTaxRatesSession({ permissions: CATALOGUE_KEEPER }, http);
    await s.setCess({ hsnCode: '24022010', effectiveFrom: '2026-01-01', advaloremPercent: '36', specificRupees: '4,170', perQuantity: '1000' });
    expect(http.calls).toEqual([{ method: 'POST', path: '/v1/catalogue/tax-classes/24022010/cess/2026-01-01', body: { advaloremBps: 3600, specificPerQuantityMinor: 417_000, perQuantity: 1000 } }]);
    expect(await s.setCess({ hsnCode: '24022010', effectiveFrom: '2026-01-01', advaloremPercent: '36', specificRupees: 'lots', perQuantity: '1' })).toEqual({ kind: 'invalid', detail: 'cess' });
    expect(await s.setCess({ hsnCode: '24022010', effectiveFrom: '2026-01-01', advaloremPercent: '36', specificRupees: '0', perQuantity: '0' })).toEqual({ kind: 'invalid', detail: 'cess' });
    const down = createTaxRatesSession({ permissions: CATALOGUE_KEEPER }, fakeHttp({}, { status: 0, body: null }));
    const lost = await down.setCess({ hsnCode: '24022010', effectiveFrom: '2026-01-01', advaloremPercent: '36', specificRupees: '', perQuantity: '' });
    expect(taxOutcomeWords('en', lost, 'cess').text).toBe('Head office cannot be reached — nothing was saved. Try again when the connection is back.');
    expect(taxOutcomeWords('ta', lost, 'cess').text).toMatch(/^தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் சேமிக்கப்படவில்லை/);
  });
});
