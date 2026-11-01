import { describe, it, expect } from 'vitest';
import { createSupplierTermsSession, contractBody, schemeBody, basisPointsOf, supplierTermsWords, supplierTermsOutcomeWords, SUPPLIER_TERMS_COPY } from '../../apps/web-erp/src/supplier-terms-session';
import { actionDetails } from '../../services/identity/src/approval-requests';

/**
 * Supplier terms (M06-FR-03 · §28 · ADR-0024): a contract with its agreed lead time, and a rebate scheme, put on head office's
 * record from a screen. The approval asked for carries EXACTLY the details head office will fingerprint when the terms are
 * recorded (the engine's own `actionDetails`), and the record names the asker's own approved request — never a typed name.
 * The connected proof is tests/e2e/supplier-contracts-and-rebate-schemes-are-recorded-on-their-pages.e2e.ts.
 */

const CONTRACT = { contractId: ' ct-1 ', supplierId: ' sup-1 ', startsOn: '2026-11-01', endsOn: '2027-10-31', leadDays: '4' };
const SCHEME = { schemeId: 'rb-9', supplierId: 'sup-1', basis: 'purchase_value', ratePct: '2.5', thresholdRupees: '10,000', startsOn: '2026-11-01', endsOn: '2027-03-31' };

function fakeFetch(approvals: unknown[] = [], answer: Record<string, unknown> = {}) {
  const sent: { method: string; path: string; body?: unknown }[] = [];
  const fetch = (async (path: string, init: { method: string; body?: string }) => {
    sent.push({ method: init.method, path, ...(init.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }) });
    const body = init.method === 'GET' && path === '/v1/approvals/requests' ? { mine: approvals } : init.method === 'POST' && path === '/v1/approvals/requests' ? { requestId: 'apr-1' } : answer;
    return { ok: true, status: 201, json: async () => body };
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const KEEPER = { userId: 'u-buyer', permissions: ['purchase.commitment.read', 'purchase.contract.manage'] };

describe('supplier terms (M06-FR-03)', () => {
  it('reads the forms into head office\'s bodies, and refuses an incomplete one before any call', () => {
    expect(contractBody(CONTRACT)).toEqual({ contractId: 'ct-1', body: { supplierId: 'sup-1', startsOn: '2026-11-01', endsOn: '2027-10-31', agreedLeadTimeDays: 4 } });
    expect(contractBody({ ...CONTRACT, endsOn: '2026-10-01' })).toBeNull();
    expect(contractBody({ ...CONTRACT, leadDays: '2.5' })).toBeNull();
    expect(contractBody({ ...CONTRACT, contractId: 'has space' })).toBeNull();
    expect(schemeBody(SCHEME)).toEqual({ schemeId: 'rb-9', body: { supplierId: 'sup-1', basis: 'purchase_value', rateBp: 250, thresholdMinor: 1_000_000, startsOn: '2026-11-01', endsOn: '2027-03-31' } });
    expect(schemeBody({ ...SCHEME, thresholdRupees: '' })?.body).not.toHaveProperty('thresholdMinor');
    expect(schemeBody({ ...SCHEME, basis: 'gut_feel' })).toBeNull();
    expect(schemeBody({ ...SCHEME, ratePct: '2.555' })).toBeNull();
    expect([basisPointsOf('3'), basisPointsOf('1.25%'), basisPointsOf('-1'), basisPointsOf('x')]).toEqual([300, 125, null, null]);
  });

  it('asks for exactly the details head office fingerprints, and records naming the asker\'s own approved request', async () => {
    const { fetch, sent } = fakeFetch([{ requestId: 'apr-old', kind: 'purchase_contract', subjectRef: 'ct-1', status: 'used' }, { requestId: 'apr-1', kind: 'purchase_contract', subjectRef: 'ct-1', status: 'approved' }], { contract: { contractId: 'ct-1', approvedBy: 'u-acct' } });
    const s = createSupplierTermsSession({ viewer: KEEPER, fetch });
    expect(await s.askContract(CONTRACT)).toEqual({ result: 'ok', value: { requestId: 'apr-1' } });
    const recorded = await s.recordContract(CONTRACT);
    expect(recorded.result === 'ok' && recorded.value.approved).toBe(true);
    const ask = sent[0]!.body as { kind: string; subjectRef: string; details: Record<string, unknown> };
    const record = sent[2]!;
    expect(ask).toMatchObject({ kind: 'purchase_contract', subjectRef: 'ct-1', valueMinor: null });
    expect(record.path).toBe('/v1/purchase/contracts/ct-1');
    expect(record.body).toEqual({ supplierId: 'sup-1', startsOn: '2026-11-01', endsOn: '2027-10-31', agreedLeadTimeDays: 4, approvalId: 'apr-1' });
    // The engine's own rule: the details asked for are the body recorded plus the path id — so the approval fits.
    expect(ask.details).toEqual(actionDetails(record.body, { contractId: 'ct-1' }));
    expect(supplierTermsOutcomeWords('en', recorded)).toBe('Recorded with its approval — head office kept the terms and who approved them.');
  });

  it('records without an approval when nobody has approved yet, and says the terms show as not approved', async () => {
    const { fetch, sent } = fakeFetch([], { scheme: { schemeId: 'rb-9' } });
    const s = createSupplierTermsSession({ viewer: KEEPER, fetch });
    const out = await s.recordScheme(SCHEME);
    expect(sent.map((x) => `${x.method} ${x.path}`)).toEqual(['GET /v1/approvals/requests', 'POST /v1/purchase/rebate-schemes/rb-9']);
    expect(sent[1]!.body).not.toHaveProperty('approvalId');
    expect(supplierTermsOutcomeWords('en', out)).toMatch(/^Recorded WITHOUT an approval/);
    await s.askScheme(SCHEME);
    expect((sent[2]!.body as { details: unknown }).details).toEqual(actionDetails(sent[1]!.body, { schemeId: 'rb-9' }));
  });

  it('a reader may read the contracts but not record terms; a nobody sends nothing; every word has a Tamil twin', async () => {
    const { fetch, sent } = fakeFetch();
    const reader = createSupplierTermsSession({ viewer: { userId: 'u-a', permissions: ['purchase.commitment.read'] }, fetch });
    expect(reader.may).toEqual({ named: true, read: true, manage: false });
    expect(await reader.askContract(CONTRACT)).toEqual({ result: 'invalid', why: 'cannotManage' });
    expect(await createSupplierTermsSession({ viewer: KEEPER, fetch }).askScheme({ ...SCHEME, startsOn: '' })).toEqual({ result: 'invalid', why: 'needScheme' });
    expect(await createSupplierTermsSession({ viewer: undefined, fetch }).contracts()).toEqual({ result: 'invalid', why: 'nobody' });
    expect(await createSupplierTermsSession({ viewer: { userId: 'u-c', permissions: [] }, fetch }).contracts()).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(sent).toEqual([]);
    for (const k of Object.keys(SUPPLIER_TERMS_COPY.en)) expect(supplierTermsWords('ta', k), k).not.toBe(supplierTermsWords('en', k));
  });
});
