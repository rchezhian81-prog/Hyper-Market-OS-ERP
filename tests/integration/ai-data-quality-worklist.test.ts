import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// The Data Quality steward's INBOX (A08 · API-13 · P-05 · M03-FR-02/04) on the live surface.
//
// The inbox is the live A08 findings folded with the stewards' dismissals. It re-derives every time,
// so the moment a steward FIXES a gap through the ordinary catalogue route the suggestion leaves the
// list on its own — nothing to tick off, no stale "done" flag. The one persisted human decision is a
// DISMISSAL ("this is not a problem", with a reason), recorded in the steward's name; the AI writes
// nothing. It honours the same governance as a run (hidden when killed or A08 is off) but spends
// nothing, so it is not behind the budget gate, and it commits nothing.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const MRP = [{ value: { minor: 5000, currency: 'INR' }, effectiveFrom: '2026-01-01' }];
const base = { baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'draft' };

interface WorklistItem {
  readonly finding: { readonly findingId: string; readonly kind: string; readonly headline: string };
  readonly status: 'open' | 'dismissed';
  readonly dismissal?: { readonly by: string; readonly at: string; readonly reason: string };
}
interface WorklistBody {
  readonly agentActive: boolean;
  readonly open: readonly WorklistItem[];
  readonly dismissed: readonly WorklistItem[];
  readonly openCount: number;
  readonly dismissedCount: number;
  readonly note?: string;
  readonly committedAnything: boolean;
}
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const publish = (h: ApiHarness, u: string, productId: string, product: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/catalogue/products/${productId}/publish`, userId: u, tenantId: A, idempotencyKey: key, body: { product, categories: [GROCERY] } });
const assignBarcode = (h: ApiHarness, u: string, productId: string, code: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/catalogue/products/${productId}/barcodes/${code}`, userId: u, tenantId: A, idempotencyKey: key, body: { kind: 'ean' } });
const put = (h: ApiHarness, u: string, path: string, body: unknown, key: string) =>
  h.request({ method: 'PUT', path, userId: u, tenantId: A, idempotencyKey: key, body });
const worklist = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/ai/data-quality/worklist', userId: u, tenantId: A });
const dismiss = (h: ApiHarness, u: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/ai/data-quality/dismissals', userId: u, tenantId: A, idempotencyKey: key, body });

/** Seed a master with exactly three gaps: a no-barcode item, a duplicate pair, and a no-MRP item. */
async function seedGaps(h: ApiHarness): Promise<void> {
  await publish(h, 'u-owner', 'p-noscan', { ...base, sku: 'SKU-NOSCAN', name: 'Loose Poha', brand: 'Local', mrpHistory: MRP }, 'k1');
  await publish(h, 'u-owner', 'p-atta-1', { ...base, sku: 'SKU-ATTA-1', name: 'Aashirvaad Atta 5kg', brand: 'Aashirvaad', mrpHistory: MRP }, 'k2');
  await assignBarcode(h, 'u-owner', 'p-atta-1', '8901000000002', 'bc2');
  await publish(h, 'u-owner', 'p-atta-2', { ...base, sku: 'SKU-ATTA-2', name: 'AASHIRVAAD ATTA 5 KG', brand: 'aashirvaad', mrpHistory: MRP }, 'k3');
  await assignBarcode(h, 'u-owner', 'p-atta-2', '8901000000003', 'bc3');
  await publish(h, 'u-owner', 'p-nomrp', { ...base, sku: 'SKU-NOMRP', name: 'Sugar 1kg', brand: 'Local' }, 'k5');
  await assignBarcode(h, 'u-owner', 'p-nomrp', '8901000000004', 'bc5');
}
async function armA08(h: ApiHarness): Promise<void> {
  await put(h, 'u-owner', '/v1/ai/kill-switch', { on: false }, 'k');
  await put(h, 'u-owner', '/v1/ai/agents/enabled', { agents: ['A08'] }, 'e');
}

describe('the Data Quality steward inbox (A08) on the live surface', () => {
  it('shows the open suggestions, and needs no budget to do so', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await seedGaps(h);
    await armA08(h); // enabled + kill switch off, but NO budget set — the worklist is a read, not a run

    const body = (await worklist(h, 'u-owner')).body as WorklistBody;
    expect(body.agentActive).toBe(true);
    expect(body.committedAnything).toBe(false);
    expect(body.openCount).toBe(3);
    expect(body.dismissedCount).toBe(0);
    expect(body.open.map((i) => i.finding.findingId).sort()).toEqual([
      'dq-duplicate:p-atta-1:p-atta-2',
      'dq-missing-barcode:p-noscan',
      'dq-missing-mrp:p-nomrp',
    ]);
  });

  it('a steward sets a false positive aside with a reason; it moves to dismissed and stays there', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager'); // the data steward
    await seedGaps(h);
    await armA08(h);

    const dismissed = await dismiss(h, 'u-mgr', { findingId: 'dq-duplicate:p-atta-1:p-atta-2', reason: 'checked — these are two genuinely different pack sizes' }, 'd1');
    expect(dismissed.status).toBe(200);

    const after = (await worklist(h, 'u-mgr')).body as WorklistBody;
    expect(after.openCount).toBe(2);
    expect(after.open.some((i) => i.finding.findingId === 'dq-duplicate:p-atta-1:p-atta-2')).toBe(false);
    const item = after.dismissed.find((i) => i.finding.findingId === 'dq-duplicate:p-atta-1:p-atta-2');
    expect(item).toBeDefined();
    // The human's decision is recorded in the human's name, with the reason (audit).
    expect(item!.dismissal).toMatchObject({ by: 'u-mgr', reason: 'checked — these are two genuinely different pack sizes' });
  });

  it('a reopen puts a dismissed suggestion back on the open list', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await seedGaps(h);
    await armA08(h);
    await dismiss(h, 'u-owner', { findingId: 'dq-missing-mrp:p-nomrp', reason: 'to be priced next week' }, 'd1');
    expect(((await worklist(h, 'u-owner')).body as WorklistBody).dismissedCount).toBe(1);

    await dismiss(h, 'u-owner', { findingId: 'dq-missing-mrp:p-nomrp', reopen: true }, 'd2');
    const after = (await worklist(h, 'u-owner')).body as WorklistBody;
    expect(after.dismissedCount).toBe(0);
    expect(after.open.some((i) => i.finding.findingId === 'dq-missing-mrp:p-nomrp')).toBe(true);
  });

  it('self-heals — fixing a gap through the ordinary route removes its suggestion, no tick-off needed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await seedGaps(h);
    await armA08(h);
    expect(((await worklist(h, 'u-owner')).body as WorklistBody).open.some((i) => i.finding.findingId === 'dq-missing-barcode:p-noscan')).toBe(true);

    // The steward assigns the missing barcode — the ordinary catalogue action, not a dismissal.
    expect((await assignBarcode(h, 'u-owner', 'p-noscan', '8901000000001', 'fix1')).status).toBe(201);

    const after = (await worklist(h, 'u-owner')).body as WorklistBody;
    expect(after.open.some((i) => i.finding.findingId === 'dq-missing-barcode:p-noscan')).toBe(false);
    expect(after.dismissed.some((i) => i.finding.findingId === 'dq-missing-barcode:p-noscan')).toBe(false); // gone, not dismissed
  });

  it('honours governance — hidden when A08 is not enabled or the kill switch is on', async () => {
    // (a) Not enabled at all → no suggestions, with a plain-English note.
    const h1 = apiHarness();
    await h1.seedOwner(A, 'u-owner');
    await seedGaps(h1);
    const notEnabled = (await worklist(h1, 'u-owner')).body as WorklistBody;
    expect(notEnabled.agentActive).toBe(false);
    expect(notEnabled.openCount).toBe(0);
    expect(notEnabled.note).toBeTruthy();

    // (b) Enabled with the kill switch off → active.
    const h2 = apiHarness();
    await h2.seedOwner(A, 'u-owner');
    await seedGaps(h2);
    await armA08(h2);
    expect(((await worklist(h2, 'u-owner')).body as WorklistBody).agentActive).toBe(true);

    // (c) Enabled but the kill switch is on (its safe default) → hidden, and nothing else affected.
    const h3 = apiHarness();
    await h3.seedOwner(A, 'u-owner');
    await seedGaps(h3);
    await put(h3, 'u-owner', '/v1/ai/agents/enabled', { agents: ['A08'] }, 'e'); // enable only; kill switch stays ON by default
    const killed = (await worklist(h3, 'u-owner')).body as WorklistBody;
    expect(killed.agentActive).toBe(false);
    expect(killed.openCount).toBe(0);
  });

  it('is governed access — a cashier can neither read the inbox nor dismiss; a malformed dismissal is refused', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    await seedGaps(h);
    await armA08(h);

    expect((await worklist(h, 'u-cash')).status).toBe(403);
    expect((await dismiss(h, 'u-cash', { findingId: 'dq-missing-mrp:p-nomrp', reason: 'x' }, 'c1')).status).toBe(403);

    // A dismissal with no reason is refused (400) and changes nothing.
    const bad = await dismiss(h, 'u-owner', { findingId: 'dq-missing-mrp:p-nomrp' }, 'b1');
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_a_dismissal');
    expect(((await worklist(h, 'u-owner')).body as WorklistBody).dismissedCount).toBe(0);
  });
});
