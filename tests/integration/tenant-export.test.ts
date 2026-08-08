import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { STREAM } from '../../services/api/src/adapters';

// Tenant data export, end to end through the real API (M36-FR-03, API-11). A tenant owns and can
// export its data (P-06 / OD-09), and the export is certified through the `buildTenantExport`
// engine: it is COMPLETE or it is not an export — every domain the product declares is present
// (with zero rows where empty, because absence and emptiness are different facts), each one
// checksummed so the file can be verified. It is STRICTLY the caller's tenant and never another's,
// the critical multi-tenant isolation test (§35). It is a read: it removes nothing, and audit
// evidence is exported rather than deleted (hard rule #6). Gated by a permission the owner holds.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AT = '2026-08-07T10:00:00.000Z';

const move = (h: ApiHarness, tenant: string, user: string, m: Record<string, unknown>) =>
  h.request({ method: 'POST', path: '/v1/inventory/movements', userId: user, tenantId: tenant, idempotencyKey: `mv-${String(m['movementId'])}`, body: m });

interface ExportedEvent { seq: number; stream: string; type: string; payload: unknown }
interface ExportDomain { domain: string; rows: number; format: string; checksum: string; bytes: number }
interface Manifest {
  tenantId: string; requestedBy: string; outcome: string; complete: boolean;
  domains: ExportDomain[]; missing: string[]; totalRows: number;
}
interface ExportResponse { export: Manifest; data: Record<string, ExportedEvent[]> }
const exportTenant = (h: ApiHarness, tenant: string, user: string) =>
  h.request({ method: 'GET', path: '/v1/platform/export', userId: user, tenantId: tenant });

const base = { locationId: 'L1', uom: 'each', occurredAt: AT };

describe('a tenant can export its whole dataset, certified complete, and only its own (M36-FR-03)', () => {
  it('certifies the export complete: every declared domain present and checksummed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner'); // writes a RoleGranted on the identity stream
    await move(h, A, 'u-owner', { movementId: 'a1', productId: 'AONLY', kind: 'received', quantityMinor: 100, enteredBy: 'u-owner', ...base });
    await move(h, A, 'u-owner', { movementId: 'a2', productId: 'AONLY', kind: 'sold', quantityMinor: 30, enteredBy: 'u-owner', ...base });

    const res = await exportTenant(h, A, 'u-owner');
    expect(res.status).toBe(200);
    const { export: manifest, data } = res.body as ExportResponse;

    expect(manifest).toMatchObject({ tenantId: A, requestedBy: 'u-owner', outcome: 'complete', complete: true });
    expect(manifest.missing).toEqual([]);

    // Every domain the product declares is present in the manifest — the exporter cannot fall
    // behind the product — and every one carries a checksum so the file can be verified.
    const manifested = new Set(manifest.domains.map((d) => d.domain));
    for (const domain of new Set(Object.values(STREAM))) expect(manifested.has(domain)).toBe(true);
    expect(manifest.domains.every((d) => d.checksum.length === 64)).toBe(true); // sha256 hex

    // The data holds this tenant's real events across more than one domain (identity AND inventory).
    expect(data[STREAM.identity]?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect((data[STREAM.inventory] ?? []).map((e) => e.type)).toContain('InventoryMoved');

    // A domain the tenant has no data in is PRESENT with zero — absence and emptiness differ.
    const empty = manifest.domains.find((d) => d.rows === 0);
    expect(empty).toBeDefined();
    expect(empty!.checksum.length).toBe(64);
  });

  it('exports the CALLER\'s tenant only — never another tenant\'s rows (§35, the isolation test)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await move(h, A, 'u-owner', { movementId: 'a1', productId: 'AONLY', kind: 'received', quantityMinor: 100, enteredBy: 'u-owner', ...base });
    await h.seedOwner(B, 'u-owner-b');
    await move(h, B, 'u-owner-b', { movementId: 'b1', productId: 'BONLY', kind: 'received', quantityMinor: 50, enteredBy: 'u-owner-b', ...base });

    const aDump = JSON.stringify((await exportTenant(h, A, 'u-owner')).body);
    expect(aDump).toContain('AONLY');
    expect(aDump).not.toContain('BONLY'); // B's data never appears in A's export

    const bBody = (await exportTenant(h, B, 'u-owner-b')).body as ExportResponse;
    expect(bBody.export.tenantId).toBe(B);
    const bDump = JSON.stringify(bBody);
    expect(bDump).toContain('BONLY');
    expect(bDump).not.toContain('AONLY');
  });

  it('is a read that removes nothing — the same export twice, and the ledger still serves (hard rule #6)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await move(h, A, 'u-owner', { movementId: 'a1', productId: 'AONLY', kind: 'received', quantityMinor: 100, enteredBy: 'u-owner', ...base });

    const first = ((await exportTenant(h, A, 'u-owner')).body as ExportResponse).export;
    const second = ((await exportTenant(h, A, 'u-owner')).body as ExportResponse).export;
    expect(second.totalRows).toBe(first.totalRows); // exporting changed nothing
    // The checksums are stable across two exports of unchanged data — a real, verifiable digest.
    const digest = (m: Manifest): string => m.domains.map((d) => `${d.domain}:${d.checksum}`).join('|');
    expect(digest(second)).toBe(digest(first));

    // The data is still there and still answers after being exported.
    const avail = (await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: 'u-owner', tenantId: A })).body as { rows: { productId: string; onHandMinor: number }[] };
    expect(avail.rows.find((r) => r.productId === 'AONLY')?.onHandMinor).toBe(100);
  });

  it('is gated: a cashier cannot export the tenant (403)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    expect((await exportTenant(h, A, 'u-cash')).status).toBe(403);
  });
});
