import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// API-11 M31-FR-02 — the document issue/reproduce write path. Issuing renders the content NOW under the
// template version in force and FREEZES it; reproducing returns those exact bytes and NEVER re-renders from
// the current template. July's invoice still reads as July's invoice after August's template change. The
// issuer is the authenticated caller; issuing is append-only and idempotent on the document id.
//
// These template-engine properties are shown on a NOTIFICATION — the one kind that carries free words. Since PA-09 a
// business document (invoice, PO, GRN, statement) is issued only from its record, with the money read on the server:
// tests/integration/documents-issue-from-their-records.test.ts.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

// Two acts (Wave 2b · PA-03): the author drafts under their sign-in, a different person approves under theirs.
const publish = async (h: ApiHarness, _u: string, templateId: string, body: string, over: Record<string, unknown> = {}, key?: string) => {
  const k = key ?? `pub-${templateId}-${body.length}`;
  const { createdBy, approvedBy, ...rest } = { kind: 'notification', body, createdBy: 'u-owner', approvedBy: 'u-checker', changeNote: 'x', ...over } as Record<string, unknown>;
  const drafted = await h.request({ method: 'POST', path: `/v1/documents/templates/${templateId}/versions`, userId: String(createdBy), tenantId: A, idempotencyKey: `${k}-draft`, body: rest });
  if (drafted.status !== 201) return drafted;
  const version = (drafted.body as { version: number }).version;
  return h.request({ method: 'POST', path: `/v1/documents/templates/${templateId}/versions/${version}/approve`, userId: String(approvedBy), tenantId: A, idempotencyKey: `${k}-approve`, body: { ...(typeof rest['at'] === 'string' ? { at: rest['at'] } : {}) } });
};

const issue = (h: ApiHarness, u: string, templateId: string, body: unknown, key = 'iss-1') =>
  h.request({ method: 'POST', path: `/v1/documents/templates/${templateId}/issue`, userId: u, tenantId: A, idempotencyKey: key, body });

const reproduce = (h: ApiHarness, u: string, documentId: string) =>
  h.request({ method: 'GET', path: `/v1/documents/issued/${documentId}`, userId: u, tenantId: A });

describe('document issue/reproduce write path (M31-FR-02)', () => {
  it('issues a document — renders the template with the data and freezes it under the current version', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-checker', 'store_manager'); // approves the owner's draft under their own sign-in (Wave 2b · PA-03)
    await publish(h, 'u-owner', 'inv', 'Invoice for {{customer}} — amount {{amount}}');
    const res = await issue(h, 'u-owner', 'inv', { documentId: 'doc-1', kind: 'notification', subjectRef: 'sale-1', data: { customer: 'Asha', amount: 'Rs 1,234' } });
    expect(res.status).toBe(201);
    const body = res.body as { content: string; templateVersion: number; issuedBy: string };
    expect(body.content).toBe('Invoice for Asha — amount Rs 1,234');
    expect(body.templateVersion).toBe(1);
    expect(body.issuedBy).toBe('u-owner'); // the authenticated caller, never a body value
  });

  it('reproduces the EXACT bytes issued — and never re-renders from a newer template version', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-checker', 'store_manager'); // approves the owner's draft under their own sign-in (Wave 2b · PA-03)
    await publish(h, 'u-owner', 'inv', 'JULY LAYOUT: {{customer}}');
    await issue(h, 'u-owner', 'inv', { documentId: 'doc-2', kind: 'notification', subjectRef: 'sale-2', data: { customer: 'Bala' } });
    // The template changes — a new version is published.
    await publish(h, 'u-owner', 'inv', 'AUGUST LAYOUT: {{customer}}', {}, 'pub-inv-v2');
    const repro = await reproduce(h, 'u-owner', 'doc-2');
    expect(repro.status).toBe(200);
    const body = repro.body as { content: string; templateVersion: number };
    expect(body.content).toBe('JULY LAYOUT: Bala'); // the frozen July bytes, NOT the August layout
    expect(body.templateVersion).toBe(1);
  });

  it('is idempotent on the document id — a re-issue returns the same frozen document, not a second copy', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-checker', 'store_manager'); // approves the owner's draft under their own sign-in (Wave 2b · PA-03)
    await publish(h, 'u-owner', 'inv', 'V1: {{customer}}');
    await issue(h, 'u-owner', 'inv', { documentId: 'doc-3', kind: 'notification', subjectRef: 'sale-3', data: { customer: 'Deepa' } }, 'iss-3a');
    await publish(h, 'u-owner', 'inv', 'V2: {{customer}}', {}, 'pub-inv-v2');
    // Re-issue with a DIFFERENT idempotency-key: the handler runs, sees the doc already issued, returns v1.
    const again = await issue(h, 'u-owner', 'inv', { documentId: 'doc-3', kind: 'notification', subjectRef: 'sale-3', data: { customer: 'Deepa' } }, 'iss-3b');
    expect(again.status).toBe(200);
    const body = again.body as { content: string; templateVersion: number };
    expect(body.content).toBe('V1: Deepa'); // still the first version — never re-issued under v2
    expect(body.templateVersion).toBe(1);
  });

  it('refuses to issue when no approved template version exists, and when the render is empty', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-checker', 'store_manager'); // approves the owner's draft under their own sign-in (Wave 2b · PA-03)
    const noTemplate = await issue(h, 'u-owner', 'never-published', { documentId: 'doc-4', kind: 'notification', subjectRef: 's', data: {} }, 'iss-4');
    expect(noTemplate.status).toBe(422);
    expect(codeOf(noTemplate)).toBe('no_template');
    // A body that is only a placeholder, rendered with an empty value → empty document → render_failed.
    await publish(h, 'u-owner', 'blank', '{{x}}');
    const empty = await issue(h, 'u-owner', 'blank', { documentId: 'doc-5', kind: 'notification', subjectRef: 's', data: { x: '' } }, 'iss-5');
    expect(empty.status).toBe(422);
    expect(codeOf(empty)).toBe('render_failed');
  });

  it('refuses a tax invoice typed from free data — a business document is issued from its record (PA-09)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-checker', 'store_manager');
    await publish(h, 'u-owner', 'inv', 'Invoice {{customer}} {{amount}}', { kind: 'tax_invoice' });
    const typed = await issue(h, 'u-owner', 'inv', { documentId: 'doc-x', kind: 'tax_invoice', subjectRef: 'sale-1', data: { customer: 'Asha', amount: 'Rs 1' } }, 'iss-x');
    expect(typed.status).toBe(400);
    expect(codeOf(typed)).toBe('document_needs_its_source');
    // …and a notification template is not an invoice layout, nor the other way round.
    await publish(h, 'u-owner', 'note', 'Hello {{name}}', {}, 'pub-note');
    expect(codeOf(await issue(h, 'u-owner', 'inv', { documentId: 'doc-y', kind: 'notification', subjectRef: 'c-1', data: { name: 'A' } }, 'iss-y'))).toBe('template_is_for_another_kind');
  });

  it('refuses a malformed issue, and gates issue on document.issue and reproduce on document.template.read', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-checker', 'store_manager'); // approves the owner's draft under their own sign-in (Wave 2b · PA-03)
    await h.provisionRole(A, 'u-cash', 'cashier');
    await publish(h, 'u-owner', 'inv', 'X: {{customer}}');
    const bad = await issue(h, 'u-owner', 'inv', { kind: 'notification', subjectRef: 's', data: {} }, 'iss-6'); // no documentId
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('document_needs_id_kind_subject');
    expect((await issue(h, 'u-cash', 'inv', { documentId: 'doc-7', kind: 'notification', subjectRef: 's', data: {} }, 'iss-7')).status).toBe(403);
    await issue(h, 'u-owner', 'inv', { documentId: 'doc-8', kind: 'notification', subjectRef: 's', data: { customer: 'E' } }, 'iss-8');
    expect((await reproduce(h, 'u-cash', 'doc-8')).status).toBe(403);
  });
});
