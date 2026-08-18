import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M03-FR-02: the barcode register on the live API — the durable "one code, one item" map the till
// depends on. A code belongs to exactly one product: re-assigning the same code to the SAME product is a
// harmless no-op (an import re-run must not fail), assigning it to a DIFFERENT product is refused with the
// current owner named. Assignments are event-sourced, so the register survives a restart. Assigning is
// gated catalogue.pack.publish; lookups are catalogue.pack.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const assign = (h: ApiHarness, u: string, productId: string, code: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/catalogue/products/${productId}/barcodes/${code}`, userId: u, tenantId: A, idempotencyKey: key, body });
const lookup = (h: ApiHarness, u: string, code: string) =>
  h.request({ method: 'GET', path: `/v1/catalogue/barcodes/${code}`, userId: u, tenantId: A });
const forProduct = (h: ApiHarness, u: string, productId: string) =>
  h.request({ method: 'GET', path: `/v1/catalogue/products/${productId}/barcodes`, userId: u, tenantId: A });

describe('barcode register (M03-FR-02)', () => {
  it('assigns a barcode to a product and reads it back → the product it names', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await assign(h, 'u-owner', 'p-salt', '8901058000108', { kind: 'ean' }, 'k1');
    expect(res.status).toBe(201);
    expect((res.body as { barcode: { productId: string; kind: string } }).barcode).toMatchObject({ productId: 'p-salt', kind: 'ean' });
    const got = await lookup(h, 'u-owner', '8901058000108');
    expect(got.status).toBe(200);
    expect((got.body as { barcode: { productId: string } }).barcode.productId).toBe('p-salt');
  });

  it('refuses the same code for a DIFFERENT product (owner named); the same product is idempotent', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await assign(h, 'u-owner', 'p-salt', '890111', { kind: 'ean' }, 'k1');
    // A second product cannot take a code that already names one — one code, one item.
    const clash = await assign(h, 'u-owner', 'p-sugar', '890111', { kind: 'ean' }, 'k2');
    expect(clash.status).toBe(409);
    expect(codeOf(clash)).toBe('barcode_already_assigned');
    expect((clash.body as { error: { whatHappened: string } }).error.whatHappened).toContain('p-salt'); // the current owner is named
    // The same product re-assigning its own code is a no-op, not an error (an import re-run).
    expect((await assign(h, 'u-owner', 'p-salt', '890111', { kind: 'ean' }, 'k3')).status).toBe(201);
    // The code still names the original product — the clash changed nothing.
    expect((await lookup(h, 'u-owner', '890111')).body as { barcode: { productId: string } }).toMatchObject({ barcode: { productId: 'p-salt' } });
  });

  it('lists every code for one product, and an unknown code is a 404 (an unknown scan)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await assign(h, 'u-owner', 'p-milk', '111', { kind: 'ean' }, 'k1');
    await assign(h, 'u-owner', 'p-milk', '222', { kind: 'internal' }, 'k2');
    const list = await forProduct(h, 'u-owner', 'p-milk');
    expect(list.status).toBe(200);
    expect((list.body as { count: number }).count).toBe(2);
    expect((await lookup(h, 'u-owner', 'never-scanned')).status).toBe(404);
  });

  it('gates assigning on catalogue.pack.publish; a manager may read but not assign; malformed → 400', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager'); // has catalogue.pack.read, NOT catalogue.pack.publish
    await assign(h, 'u-owner', 'p-salt', '333', { kind: 'ean' }, 'k-seed');
    expect((await assign(h, 'u-mgr', 'p-x', '444', { kind: 'ean' }, 'k-mgr')).status).toBe(403); // cannot assign
    expect((await lookup(h, 'u-mgr', '333')).status).toBe(200); // can read
    expect((await forProduct(h, 'u-mgr', 'p-salt')).status).toBe(200);
    // Malformed: no kind, or an unknown kind.
    expect((await assign(h, 'u-owner', 'p-bad', '555', {}, 'k-bad1')).status).toBe(400);
    const bad2 = await assign(h, 'u-owner', 'p-bad', '555', { kind: 'qr-code' }, 'k-bad2');
    expect(bad2.status).toBe(400);
    expect(codeOf(bad2)).toBe('not_readable_as_a_barcode');
  });
});
