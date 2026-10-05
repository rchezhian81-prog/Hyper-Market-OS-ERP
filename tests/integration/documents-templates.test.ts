import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M31-FR-01 / M36-FR-02: versioned document templates on the live API. A template change is a NEW VERSION,
// never an overwrite — so July's invoice keeps July's layout after August's change. A publish needs a
// change note and a separate approver (§28), and per-tenant branding is frozen into the version.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** A template change as the product now records it (Wave 2b · PA-03): the author DRAFTS under their own sign-in, a
 *  different person APPROVES under theirs. `body.createdBy` names the drafter, `body.approvedBy` the approver — each is
 *  the caller of its own act, never a name in a payload. */
const publish = async (h: ApiHarness, _userId: string, templateId: string, body: unknown, key: string) => {
  const b = body as Record<string, unknown>;
  const { createdBy, approvedBy, ...rest } = b;
  const drafted = await h.request({ method: 'POST', path: `/v1/documents/templates/${templateId}/versions`, userId: String(createdBy ?? 'u-designer'), tenantId: A, idempotencyKey: `${key}-draft`, body: rest });
  if (drafted.status !== 201) return drafted;
  const version = (drafted.body as { version: number }).version;
  return h.request({ method: 'POST', path: `/v1/documents/templates/${templateId}/versions/${version}/approve`, userId: String(approvedBy ?? 'u-owner'), tenantId: A, idempotencyKey: `${key}-approve`, body: { ...(typeof rest['at'] === 'string' ? { at: rest['at'] } : {}) } });
};
const current = (h: ApiHarness, userId: string, templateId: string, at?: string) =>
  h.request({ method: 'GET', path: `/v1/documents/templates/${templateId}/current`, userId, tenantId: A, ...(at ? { query: { at } } : {}) });

const V1 = { kind: 'tax_invoice', body: 'INVOICE v1 {{total}}', createdBy: 'u-designer', approvedBy: 'u-owner', changeNote: 'initial layout', at: '2026-07-01T00:00:00Z', branding: { colour: 'green' } };
const V2 = { ...V1, body: 'INVOICE v2 {{total}}', changeNote: 'new address', at: '2026-08-01T00:00:00Z' };

describe('versioned document templates (M31-FR-01 / M36-FR-02)', () => {
  it('publishes append-only versions and resolves the one in force at a moment', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-designer', 'store_manager'); // the author drafts under their own sign-in (Wave 2b · PA-03)

    expect(((await publish(h, 'u-owner', 'inv', V1, 'dt-v1')).body as { version: number }).version).toBe(1);
    expect(((await publish(h, 'u-owner', 'inv', V2, 'dt-v2')).body as { version: number }).version).toBe(2); // a change is a NEW version

    // Now (after Aug 1) the current version is v2 with its new body...
    expect(((await current(h, 'u-owner', 'inv', '2026-08-15T00:00:00Z')).body as { version: number; body: string }).body).toContain('v2');
    // ...but in July, v1 was in force — the layout a July invoice was issued under.
    const july = (await current(h, 'u-owner', 'inv', '2026-07-15T00:00:00Z')).body as { version: number; branding: { colour: string } };
    expect(july.version).toBe(1);
    expect(july.branding.colour).toBe('green'); // branding frozen into the version (M36-FR-02)
  });

  it('refuses a self-approved change and one with no change note (§28)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-designer', 'store_manager'); // the author drafts under their own sign-in (Wave 2b · PA-03)
    // Approver is the same person who wrote it.
    expect((await publish(h, 'u-owner', 'inv2', { ...V1, createdBy: 'u-owner' }, 'dt-self')).status).toBe(422);
    // No change note — an invoice layout carries the shop's legal identity.
    expect((await publish(h, 'u-owner', 'inv3', { ...V1, changeNote: '' }, 'dt-note')).status).toBe(422);
  });

  it('404s an unknown template, refuses a malformed publish, and gates on the permissions', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-designer', 'store_manager'); // the author drafts under their own sign-in (Wave 2b · PA-03)
    await h.provisionRole(A, 'u-cash', 'cashier');
    expect((await current(h, 'u-owner', 'nope')).status).toBe(404);
    expect((await publish(h, 'u-owner', 'bad', { kind: 'tax_invoice' }, 'dt-bad')).status).toBe(400);
    expect((await publish(h, 'u-cash', 'inv', { ...V1, createdBy: 'u-cash' }, 'dt-rbac')).status).toBe(403);
    expect((await current(h, 'u-cash', 'inv')).status).toBe(403);
  });
});
