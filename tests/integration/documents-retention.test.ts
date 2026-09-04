import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M31 document retention & archival on the live API — the "archival remains" follow-on. Two reads over the
// stored corpus, and both DISPOSE OF NOTHING: `GET /v1/documents/retention/templates` says which template
// VERSIONS may ever go (a version any issued document depends on can never go — hard rule #6), and
// `GET /v1/documents/retention/documents` PROPOSES which issued documents a person may be asked about
// disposing of (a legal hold beats any date, a statutory record is never proposed, silence never means
// discard). Gated document.template.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const publish = (h: ApiHarness, u: string, templateId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/documents/templates/${templateId}/publish`, userId: u, tenantId: A, idempotencyKey: key, body });
const issue = (h: ApiHarness, u: string, templateId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/documents/templates/${templateId}/issue`, userId: u, tenantId: A, idempotencyKey: key, body });
const retTemplates = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/documents/retention/templates', userId: u, tenantId: A });
const retDocuments = (h: ApiHarness, u: string, today?: string) =>
  h.request({ method: 'GET', path: '/v1/documents/retention/documents', userId: u, tenantId: A, ...(today ? { query: { today } } : {}) });

const INV_V1 = { kind: 'tax_invoice', body: 'INV v1 {{total}}', createdBy: 'u-designer', approvedBy: 'u-owner', changeNote: 'initial', at: '2026-07-01T00:00:00Z' };
const INV_V2 = { ...INV_V1, body: 'INV v2 {{total}}', changeNote: 'new address', at: '2026-08-01T00:00:00Z' };
const RCPT_V1 = { kind: 'receipt', body: 'RCPT {{total}}', createdBy: 'u-designer', approvedBy: 'u-owner', changeNote: 'initial', at: '2026-07-01T00:00:00Z' };

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                // document.template.manage/.read + document.issue
  await h.provisionRole(A, 'u-cash', 'cashier');  // none
  return h;
}

describe('document retention & archival (M31): assess versions, propose documents — never delete', () => {
  it('marks an unused template version disposable but keeps one an issued document depends on (hard rule #6)', async () => {
    const h = await cast();
    await publish(h, 'u-owner', 'inv', INV_V1, 'p-v1');
    await publish(h, 'u-owner', 'inv', INV_V2, 'p-v2'); // a change is a NEW version; v2 is current now
    await issue(h, 'u-owner', 'inv', { documentId: 'd1', kind: 'tax_invoice', subjectRef: 'sale-1', data: { total: '100' } }, 'i-d1');

    const body = (await retTemplates(h, 'u-owner')).body as {
      count: number; disposableCount: number;
      decisions: { templateId: string; version: number; disposable: boolean; dependentDocuments: number }[];
    };
    expect(body.count).toBe(2);
    expect(body.disposableCount).toBe(1);
    const v1 = body.decisions.find((d) => d.version === 1)!;
    const v2 = body.decisions.find((d) => d.version === 2)!;
    expect(v1.disposable).toBe(true);   // nothing was ever issued under v1
    expect(v2.disposable).toBe(false);  // d1 depends on v2 — it is the record of that layout
    expect(v2.dependentDocuments).toBe(1);
  });

  it('proposes only a document past its retention — legal hold, statutory kind, and no-date all kept', async () => {
    const h = await cast();
    await publish(h, 'u-owner', 'rcpt', RCPT_V1, 'p-rcpt');
    await publish(h, 'u-owner', 'inv', INV_V1, 'p-inv');

    await issue(h, 'u-owner', 'rcpt', { documentId: 'd-hold', kind: 'receipt', subjectRef: 's1', data: { total: '1' }, retainUntil: '2020-01-01', legalHold: true }, 'i-hold');
    await issue(h, 'u-owner', 'rcpt', { documentId: 'd-none', kind: 'receipt', subjectRef: 's2', data: { total: '2' } }, 'i-none');
    await issue(h, 'u-owner', 'rcpt', { documentId: 'd-future', kind: 'receipt', subjectRef: 's3', data: { total: '3' }, retainUntil: '2099-01-01' }, 'i-future');
    await issue(h, 'u-owner', 'rcpt', { documentId: 'd-expired', kind: 'receipt', subjectRef: 's4', data: { total: '4' }, retainUntil: '2020-01-01' }, 'i-expired');
    await issue(h, 'u-owner', 'inv', { documentId: 'd-tax', kind: 'tax_invoice', subjectRef: 's5', data: { total: '5' }, retainUntil: '2020-01-01' }, 'i-tax');

    const body = (await retDocuments(h, 'u-owner', '2026-09-04')).body as {
      today: string; proposedForDisposalCount: number;
      plan: { documentId: string; action: string; reason: string }[];
    };
    const by = Object.fromEntries(body.plan.map((p) => [p.documentId, p.action]));
    expect(by['d-hold']).toBe('keep');       // a legal hold beats any retention date
    expect(by['d-none']).toBe('keep');       // silence never means discard
    expect(by['d-future']).toBe('keep');     // still within its retention window
    expect(by['d-tax']).toBe('keep');        // a tax invoice is statutory — never proposed, past date or not
    expect(by['d-expired']).toBe('propose_disposal'); // the only one whose retention has ended
    expect(body.proposedForDisposalCount).toBe(1);
  });

  it('refuses a bad ?today= and gates both retention reads on document.template.read', async () => {
    const h = await cast();
    expect(codeOf(await retDocuments(h, 'u-owner', '04-09-2026'))).toBe('retention_date_invalid');
    expect((await retTemplates(h, 'u-cash')).status).toBe(403);
    expect((await retDocuments(h, 'u-cash')).status).toBe(403);
  });
});
