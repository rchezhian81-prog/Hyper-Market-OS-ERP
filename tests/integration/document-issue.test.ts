import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// API-11 M31-FR-02 — the document issue/reproduce write path. Issuing renders the content NOW under the
// template version in force and FREEZES it; reproducing returns those exact bytes and NEVER re-renders from
// the current template. July's invoice still reads as July's invoice after August's template change. The
// issuer is the authenticated caller; issuing is append-only and idempotent on the document id.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

// Two acts (Wave 2b · PA-03): the author drafts under their sign-in, a different person approves under theirs.
const publish = async (h: ApiHarness, _u: string, templateId: string, body: string, over: Record<string, unknown> = {}, key?: string) => {
  const k = key ?? `pub-${templateId}-${body.length}`;
  const { createdBy, approvedBy, ...rest } = { kind: 'tax_invoice', body, createdBy: 'u-owner', approvedBy: 'u-checker', changeNote: 'x', ...over } as Record<string, unknown>;
  const drafted = await h.request({ method: 'POST', path: `/v1/documents/templates/${templateId}/versions`, userId: String(createdBy), tenantId: A, idempotencyKey: `${k}-draft`, body: rest });
  if (drafted.status !== 201) return drafted;
  const version = (drafted.body as { version: number }).version;
  return h.request({ method: 'POST', path: `/v1/documents/templates/${templateId}/versions/${version}/approve`, userId: String(approvedBy), tenantId: A, idempotencyKey: `${k}-approve`, body: { ...(typeof rest['at'] === 'string' ? { at: rest['at'] } : {}) } });
};

const issue = (h: ApiHarness, u: string, templateId: string, body: unknown, key = 'iss-1') =>
  h.request({ method: 'POST', path: `/v1/documents/templates/${templateId}/issue`, userId: u, tenantId: A, idempotencyKey: key, body });

const reproduce = (h: ApiHarness, u: string, documentId: string) =>
  h.request({ method: 'GET', path: `/v1/documents/issued/${documentId}`, userId: u, tenantId: A });

/** A shop with an owner, a checker, a till, and banked sales — a document is OF a record head office holds (PA-09). */
async function shop(sales: readonly [string, number][] = [['sale-1', 123_400], ['sale-2', 50_000], ['sale-3', 70_000], ['sale-8', 1_000]]): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-checker', 'store_manager'); // approves the owner's draft under their own sign-in (Wave 2b · PA-03)
  await h.provisionRole(A, 'u-till', 'cashier');
  for (const [saleId, totalMinor] of sales) {
    const r = await h.request({ method: 'POST', path: '/v1/sales', userId: 'u-till', tenantId: A, idempotencyKey: `bank-${saleId}`, body: {
      saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-till', tradingDay: '2026-07-10', committedAt: '2026-07-10T10:00:00.000Z',
      totalMinor, currency: 'INR', packVersion: 1, lines: [], tenders: [{ kind: 'cash', amountMinor: totalMinor }],
    } });
    expect(r.status).toBe(202);
  }
  return h;
}

describe('document issue/reproduce write path (M31-FR-02) — OF a governed record (audit PA-09)', () => {
  it('issues a document about a banked sale — the number and money come from the sale, frozen with its source', async () => {
    const h = await shop();
    await publish(h, 'u-owner', 'inv', 'Invoice {{number}} for {{customer}} — amount {{total}}');
    const res = await issue(h, 'u-owner', 'inv', { documentId: 'doc-1', kind: 'tax_invoice', subjectRef: 'sale-1', data: { customer: 'Asha' } });
    expect(res.status).toBe(201);
    const body = res.body as { content: string; templateVersion: number; issuedBy: string; subjectRef: string; source: Record<string, string> };
    expect(body.content).toBe('Invoice R-sale-1 for Asha — amount Rs 1,234.00');
    expect(body.templateVersion).toBe(1);
    expect(body.issuedBy).toBe('u-owner'); // the authenticated caller, never a body value
    expect(body.subjectRef).toBe('sale:sale-1');
    expect(body.source).toEqual({ type: 'sale', id: 'sale-1', version: 'pack-1', number: 'R-sale-1' });
  });

  it('the audit\'s reproduction is refused: a nonexistent sale, and money typed into the request', async () => {
    const h = await shop();
    await publish(h, 'u-owner', 'inv', 'Total {{total}}');
    const ghost = await issue(h, 'u-owner', 'inv', { documentId: 'doc-x', kind: 'tax_invoice', subjectRef: 'sale-does-not-exist', data: {} }, 'iss-x');
    expect(ghost.status).toBe(422);
    expect(codeOf(ghost)).toBe('source_not_found');
    const forged = await issue(h, 'u-owner', 'inv', { documentId: 'doc-y', kind: 'tax_invoice', subjectRef: 'sale-1', data: { total: 'Total 999999' } }, 'iss-y');
    expect(codeOf(forged)).toBe('client_financial_override');
    const sneaky = await issue(h, 'u-owner', 'inv', { documentId: 'doc-z', kind: 'tax_invoice', subjectRef: 'sale-1', data: { number: 'R-999' } }, 'iss-z');
    expect(codeOf(sneaky)).toBe('client_override');
    // A kind whose record this version cannot resolve is refused by name — never issued about nothing.
    await publish(h, 'u-owner', 'stmt', 'Statement {{period}}', { kind: 'statement' }, 'pub-stmt');
    expect(codeOf(await issue(h, 'u-owner', 'stmt', { documentId: 'doc-s', kind: 'statement', subjectRef: 'acct-1', data: { period: 'July' } }, 'iss-s'))).toBe('source_not_resolvable');
  });

  it('a purchase order document is OF an ISSUED order — a proposed one is a draft and is refused', async () => {
    const h = await shop([]);
    await h.provisionRole(A, 'u-buyer', 'store_manager');
    await publish(h, 'u-owner', 'po', 'PO {{number}} to {{supplierId}} for {{total}}', { kind: 'purchase_order' }, 'pub-po');
    expect((await h.request({ method: 'POST', path: '/v1/purchase/orders/PO-7', userId: 'u-buyer', tenantId: A, idempotencyKey: 'po-7', body: { supplierId: 'SUP-1', lines: [{ productId: 'P1', orderedQty: 4, unitCost: { minor: 2_500, currency: 'INR' } }] } })).status).toBe(201);
    expect(codeOf(await issue(h, 'u-owner', 'po', { documentId: 'doc-po', kind: 'purchase_order', subjectRef: 'PO-7', data: {} }, 'iss-po-draft'))).toBe('source_is_a_draft');
    expect((await h.request({ method: 'POST', path: '/v1/purchase/orders/PO-7/approval', userId: 'u-owner', tenantId: A, idempotencyKey: 'po-7-ok', body: { reason: 'in budget' } })).status).toBe(200);
    const doc = await issue(h, 'u-owner', 'po', { documentId: 'doc-po', kind: 'purchase_order', subjectRef: 'PO-7', data: {} }, 'iss-po');
    expect(doc.status).toBe(201);
    expect((doc.body as { content: string }).content).toBe('PO PO-7 to SUP-1 for Rs 100.00');
  });

  it('reproduces the EXACT bytes issued — and never re-renders from a newer template version (audited reprint)', async () => {
    const h = await shop();
    await publish(h, 'u-owner', 'inv', 'JULY LAYOUT: {{customer}} {{total}}');
    await issue(h, 'u-owner', 'inv', { documentId: 'doc-2', kind: 'tax_invoice', subjectRef: 'sale-2', data: { customer: 'Bala' } });
    await publish(h, 'u-owner', 'inv', 'AUGUST LAYOUT: {{customer}} {{total}}', {}, 'pub-inv-v2');
    const repro = await reproduce(h, 'u-owner', 'doc-2');
    expect(repro.status).toBe(200);
    const body = repro.body as { content: string; templateVersion: number };
    expect(body.content).toBe('JULY LAYOUT: Bala Rs 500.00'); // the frozen July bytes, NOT the August layout
    expect(body.templateVersion).toBe(1);
  });

  it('is idempotent on the document id — a re-issue returns the same frozen document, not a second copy', async () => {
    const h = await shop();
    await publish(h, 'u-owner', 'inv', 'V1: {{customer}}');
    await issue(h, 'u-owner', 'inv', { documentId: 'doc-3', kind: 'tax_invoice', subjectRef: 'sale-3', data: { customer: 'Deepa' } }, 'iss-3a');
    await publish(h, 'u-owner', 'inv', 'V2: {{customer}}', {}, 'pub-inv-v2');
    const again = await issue(h, 'u-owner', 'inv', { documentId: 'doc-3', kind: 'tax_invoice', subjectRef: 'sale-3', data: { customer: 'Deepa' } }, 'iss-3b');
    expect(again.status).toBe(200);
    const body = again.body as { content: string; templateVersion: number };
    expect(body.content).toBe('V1: Deepa');
    expect(body.templateVersion).toBe(1);
  });

  it('refuses to issue when no approved template version exists, and when the render is empty', async () => {
    const h = await shop();
    const noTemplate = await issue(h, 'u-owner', 'never-published', { documentId: 'doc-4', kind: 'tax_invoice', subjectRef: 'sale-1', data: {} }, 'iss-4');
    expect(noTemplate.status).toBe(422);
    expect(codeOf(noTemplate)).toBe('no_template');
    await publish(h, 'u-owner', 'blank', '{{x}}');
    const empty = await issue(h, 'u-owner', 'blank', { documentId: 'doc-5', kind: 'tax_invoice', subjectRef: 'sale-1', data: { x: '' } }, 'iss-5');
    expect(empty.status).toBe(422);
    expect(codeOf(empty)).toBe('render_failed');
  });

  it('refuses a malformed issue, and gates issue on document.issue and reproduce on document.template.read', async () => {
    const h = await shop();
    await h.provisionRole(A, 'u-cash', 'cashier');
    await publish(h, 'u-owner', 'inv', 'X: {{customer}}');
    const bad = await issue(h, 'u-owner', 'inv', { kind: 'tax_invoice', subjectRef: 'sale-1', data: {} }, 'iss-6'); // no documentId
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('document_needs_id_kind_subject');
    expect((await issue(h, 'u-cash', 'inv', { documentId: 'doc-7', kind: 'tax_invoice', subjectRef: 'sale-1', data: {} }, 'iss-7')).status).toBe(403);
    await issue(h, 'u-owner', 'inv', { documentId: 'doc-8', kind: 'tax_invoice', subjectRef: 'sale-8', data: { customer: 'E' } }, 'iss-8');
    expect((await reproduce(h, 'u-cash', 'doc-8')).status).toBe(403);
  });
});
