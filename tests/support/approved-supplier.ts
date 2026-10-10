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
