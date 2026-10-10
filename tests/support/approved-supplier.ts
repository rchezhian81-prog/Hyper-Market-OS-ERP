// OB-32 "A" (owner, 10 Oct 2026): a purchase order is refused for a supplier the master does not know or finance has not
// approved. A test that raises an order therefore first puts its supplier in the master THE WAY THE SHOP DOES — proposed by
// one person, approved by a different person who holds the authority — through the real routes, never a seeded record.

import type { ApiHarness } from './api-harness';

/** The two people every seeded supplier goes through: a buyer who proposes it and finance who approves it. */
export const SUPPLIER_MAKER = 'u-supplier-maker';
export const SUPPLIER_CHECKER = 'u-supplier-checker';

type Call = (method: 'POST', path: string, userId: string, body: unknown, idempotencyKey: string) => Promise<{ readonly status: number; readonly body: unknown }>;

/** Propose and approve `supplierId` through the routes, as two different people, given a way to call the API. */
export async function approveSupplierWith(call: Call, supplierId: string, name = `Synthetic supplier ${supplierId}`): Promise<void> {
  const proposed = await call('POST', `/v1/purchase/suppliers/${encodeURIComponent(supplierId)}`, SUPPLIER_MAKER, { name }, `seed-supplier-${supplierId}`);
  if (proposed.status >= 300) throw new Error(`could not propose supplier ${supplierId}: ${proposed.status} ${JSON.stringify(proposed.body)}`);
  const approved = await call('POST', `/v1/purchase/suppliers/${encodeURIComponent(supplierId)}/approval`, SUPPLIER_CHECKER, { reason: 'synthetic test supplier, documents checked' }, `seed-supplier-approve-${supplierId}`);
  if (approved.status >= 300) throw new Error(`could not approve supplier ${supplierId}: ${approved.status} ${JSON.stringify(approved.body)}`);
}

/** The same on the API harness: provisions the two people (idempotent) and puts each supplier in the master, approved. */
export async function approvedSuppliers(h: ApiHarness, tenantId: string, ...supplierIds: string[]): Promise<void> {
  await h.provisionRole(tenantId, SUPPLIER_MAKER, 'store_manager');
  await h.provisionRole(tenantId, SUPPLIER_CHECKER, 'accountant');
  for (const supplierId of supplierIds) {
    await approveSupplierWith((method, path, userId, body, idempotencyKey) => h.request({ method, path, userId, tenantId, body, idempotencyKey }), supplierId);
  }
}

/**
 * OB-37 "A" (owner, 10 Oct 2026): every purchase order names the store it is delivered to — a place in head office's org
 * hierarchy — and a receipt against it is booked at that store or a place under it. A test shop with no hierarchy gets one
 * here: a company, the store as a branch under it, and each of `under` as a warehouse inside that store. Idempotent.
 */
export async function deliveryPlaces(h: ApiHarness, tenantId: string, storeId: string, ...under: string[]): Promise<void> {
  const setup = 'u-org-setup';
  await h.provisionOwner(tenantId, setup);
  const node = async (id: string, body: Record<string, unknown>): Promise<void> => {
    const res = await h.request({ method: 'POST', path: `/v1/org/nodes/${encodeURIComponent(id)}`, userId: setup, tenantId, idempotencyKey: `seed-org-${id}`, body });
    if (res.status >= 300) throw new Error(`could not set up ${id}: ${res.status} ${JSON.stringify(res.body)}`);
  };
  await node('C-FIXTURE', { kind: 'company', name: 'Synthetic Retail' });
  await node(storeId, { kind: 'branch', name: `Store ${storeId}`, parentId: 'C-FIXTURE', companyId: 'C-FIXTURE' });
  for (const id of under) await node(id, { kind: 'warehouse', name: `Back store ${id}`, parentId: storeId, companyId: 'C-FIXTURE' });
}
