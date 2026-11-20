import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { useBackings } from '../support/backings';
import { decide } from '../support/approval-request';
import { STREAM, streamName } from '../../services/api/src/adapters';
import type { SignedPack } from '../../services/catalogue/src/pack';
import { CatalogueCache } from '../../packages/catalogue/src/catalogue';

/**
 * **C-7 (15 Nov pilot audit · M03-FR-02 · batch 20d) — a wrongly keyed barcode is removed from an item, or moved to the right
 * item, only as a proposal a second person approves — on head office's real routes, on the in-memory store and, with
 * DATABASE_URL, on real PostgreSQL.**
 *   • nothing changes on the proposal; the direct making routes refuse; the proposer never approves his own;
 *   • approved: made once, append-only — the old link stays in the item's barcode history with who proposed, who approved,
 *     when and why; the audit trail names every step;
 *   • refused in plain words: a code not on the item, a move to the item that already has it or to no item, the only
 *     barcode without "leave it with no barcode";
 *   • the owner's own proposal is approved by the accountant (OB-613 pattern); a change approved after another already
 *     moved the code is NOT made, said by name (hard rule 10);
 *   • bills already made keep their item; the tills get the new mapping only with the next pack (the old pack still maps the
 *     old way, P-01); a sale from a till on the old pack that scanned the moved code is a visible exception.
 * Synthetic data only.
 */

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const words = (r: Res): string => (r.body as { error?: { whatHappened?: string } }).error?.whatHappened ?? '';
const STORE = 'store-01';
const AS_OF = '2030-06-01';
interface Row { requestId: string; kind: string; status: string; summary: string; details: { changes: { field: string; before: string; after: string }[] }; catalogueChange?: { applied: boolean; code?: string; reason?: string } }
interface History { code: string; what: string; otherProductId?: string; proposedBy?: string; approvedBy?: string; reason?: string; requestId?: string }

async function setUp(harness: () => ApiHarness) {
  const h = harness();
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner');
  await h.provisionRole(T, 'u-mgr', 'store_manager');
  await h.provisionRole(T, 'u-acct', 'accountant');
  await h.provisionRole(T, 'u-cash', 'cashier');
  const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner'): Promise<Res> =>
    h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
  const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
  await ok(req('POST', '/v1/catalogue/categories/grocery', { name: 'Grocery', parentId: null }), 'category');
  await ok(req('POST', '/v1/catalogue/tax-classes/25010020/rates/2017-07-01', { rateBps: 500 }), 'tax');
  for (const [id, name, codes] of [['SALT', 'Synthetic Salt 1kg', ['C7-SALT', 'C7-WRONG']], ['SUGAR', 'Synthetic Sugar 1kg', ['C7-SUGAR']], ['OIL', 'Synthetic Oil 1L', ['C7-OIL']]] as const) {
    await ok(req('POST', `/v1/catalogue/products/${id}/publish`, { product: { sku: `SKU-${id}`, name, baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'active', mrpHistory: [{ value: { minor: 9_500, currency: 'INR' }, effectiveFrom: '2026-01-01' }] } }), `publish ${id}`);
    await ok(req('POST', `/v1/prices/list/${id}/entries/e1`, { scope: 'store', scopeRef: STORE, priceMinor: 9_000, mrpMinor: 9_500, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: '2030-01-01' }), `price ${id}`);
    for (const code of codes) await ok(req('POST', `/v1/catalogue/products/${id}/barcodes/${code}`, { kind: 'internal' }), `barcode ${code}`);
  }
  const propose = (body: Record<string, unknown>, userId = 'u-mgr') => req('POST', '/v1/catalogue/changes', body, userId);
  const inbox = async (userId: string) => (await req('GET', '/v1/approvals/requests', undefined, userId)).body as { waitingForMe: Row[]; mine: Row[] };
  const owner = async (code: string): Promise<string | undefined> => { const r = await req('GET', `/v1/catalogue/barcodes/${code}`); return r.status === 200 ? (r.body as { barcode: { productId: string } }).barcode.productId : undefined; };
  const codes = async (id: string): Promise<string[]> => ((await req('GET', `/v1/catalogue/products/${id}/barcodes`)).body as { barcodes: { code: string }[] }).barcodes.map((b) => b.code).sort();
  const history = async (id: string): Promise<History[]> => ((await req('GET', `/v1/catalogue/products/${id}/barcode-history`)).body as { history: History[] }).history;
  const trail = async (action: string) => (await h.store.readStream(T, streamName(STREAM.audit, 'domain-trail'), { type: 'AuditRecordSealed' }))
    .map((e) => e.event.payload as { action: string; actorId: string; objectId: string; before: Record<string, string> | null; after: Record<string, string> | null; approvalId?: string; reason?: string })
    .filter((r) => r.action === action);
  return { h, T, req, ok, propose, inbox, owner, codes, history, trail };
}

describe.each(useBackings())('C-7: a wrongly keyed barcode is removed or moved only with a second person — on $name', ({ harness }) => {
  it('a move: nothing changes until the owner approves; then made once, the old link kept in the history and on the audit trail', async () => {
    const { h, T, req, propose, inbox, owner, codes, history, trail } = await setUp(harness);
    const sent = await propose({ change: 'barcode_move', productId: 'SALT', code: 'C7-WRONG', toProductId: 'SUGAR', reason: 'keyed on salt by mistake; it is the sugar pack (synthetic)' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body).toMatchObject({ kind: 'catalogue_change', status: 'waiting', nothingChangedYet: true });
    const requestId = (sent.body as { requestId: string }).requestId;
    expect(await owner('C7-WRONG')).toBe('SALT');

    // The owner reads exactly what it would do.
    const row = (await inbox('u-owner')).waitingForMe.find((r) => r.requestId === requestId)!;
    expect(row.summary).toBe('Move barcode C7-WRONG from Synthetic Salt 1kg (SALT) to Synthetic Sugar 1kg (SUGAR)');
    expect(row.details.changes).toEqual([
      { field: 'moveBarcode', before: 'C7-WRONG on Synthetic Salt 1kg (SALT)', after: 'C7-WRONG on Synthetic Sugar 1kg (SUGAR)' },
      { field: 'barcodes', before: 'C7-SALT, C7-WRONG', after: 'C7-SALT' },
      { field: 'barcodesOfTheOtherItem', before: 'C7-SUGAR', after: 'C7-SUGAR, C7-WRONG' },
    ]);

    // No back door: the making route refuses a direct call, even from the owner; the proposer cannot approve his own.
    const direct = await req('POST', '/v1/catalogue/products/SALT/barcodes/C7-WRONG/move', { toProductId: 'SUGAR' });
    expect(direct.status).toBe(403);
    expect(codeOf(direct)).toBe('barcode_change_needs_a_second_person');
    expect((await req('POST', '/v1/catalogue/products/SALT/barcodes/C7-WRONG/remove', {})).status).toBe(403);
    expect((await decide(h, T, 'u-mgr', requestId)).status).toBe(403);
    expect(await owner('C7-WRONG')).toBe('SALT');

    const approved = await decide(h, T, 'u-owner', requestId, 'approved', 'checked the sugar pack (synthetic)');
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect(approved.body).toMatchObject({ catalogueChange: { applied: true, proposedBy: 'u-mgr', approvedBy: 'u-owner' } });
    expect(await owner('C7-WRONG')).toBe('SUGAR');
    expect(await codes('SALT')).toEqual(['C7-SALT']);
    expect(await codes('SUGAR')).toEqual(['C7-SUGAR', 'C7-WRONG']);

    // Append-only: the old link is still there to read, with who, when and why.
    expect((await history('SALT')).map((x) => [x.code, x.what, x.otherProductId ?? ''])).toEqual([['C7-SALT', 'given', ''], ['C7-WRONG', 'given', ''], ['C7-WRONG', 'moved_away', 'SUGAR']]);
    expect((await history('SALT'))[2]).toMatchObject({ proposedBy: 'u-mgr', approvedBy: 'u-owner', reason: 'keyed on salt by mistake; it is the sugar pack (synthetic)', requestId });
    expect((await history('SUGAR')).map((x) => [x.code, x.what, x.otherProductId ?? ''])).toEqual([['C7-SUGAR', 'given', ''], ['C7-WRONG', 'moved_here', 'SALT']]);
    expect((await trail('catalogue.barcode.move'))).toEqual([expect.objectContaining({
      actorId: 'u-owner', objectId: 'SALT', approvalId: requestId, reason: 'keyed on salt by mistake; it is the sugar pack (synthetic)',
      before: expect.objectContaining({ code: 'C7-WRONG', item: 'SALT', barcodes: 'C7-SALT, C7-WRONG' }),
      after: expect.objectContaining({ code: 'C7-WRONG', item: 'SUGAR', barcodes: 'C7-SALT', proposedBy: 'u-mgr', approvedBy: 'u-owner' }),
    })]);
    expect(await trail('catalogue.change.propose')).toHaveLength(1);
    expect(await trail('catalogue.change.apply')).toHaveLength(1);

    // Re-sent: answered once, made once.
    expect((await decide(h, T, 'u-owner', requestId, 'approved', 'checked the sugar pack (synthetic)')).body).toMatchObject({ alreadyDecided: true, catalogueChange: { applied: true } });
    expect(await trail('catalogue.barcode.move')).toHaveLength(1);
    expect((await inbox('u-mgr')).mine.find((r) => r.requestId === requestId)).toMatchObject({ status: 'used', catalogueChange: { applied: true } });
  });

  it('refused in plain words: not on the item, already on the target, no such item, the only barcode; with the warning ticked a removal goes through', async () => {
    const { h, T, propose, inbox, owner, codes, history, trail } = await setUp(harness);
    const notOn = await propose({ change: 'barcode_remove', productId: 'SALT', code: 'C7-OIL', reason: 'x' });
    expect([notOn.status, codeOf(notOn)]).toEqual([422, 'barcode_not_on_this_item']);
    expect(words(notOn)).toBe('Barcode C7-OIL is not on Synthetic Salt 1kg (SALT). It is on Synthetic Oil 1L (OIL).');
    const nobody = await propose({ change: 'barcode_remove', productId: 'SALT', code: 'C7-NEVER', reason: 'x' });
    expect(words(nobody)).toMatch(/No item has this barcode now\.$/);
    const same = await propose({ change: 'barcode_move', productId: 'SALT', code: 'C7-WRONG', toProductId: 'SALT', reason: 'x' });
    expect([same.status, codeOf(same)]).toEqual([422, 'barcode_already_on_that_item']);
    expect(words(same)).toBe('Synthetic Salt 1kg (SALT) already has barcode C7-WRONG. There is nothing to move.');
    const ghost = await propose({ change: 'barcode_move', productId: 'SALT', code: 'C7-WRONG', toProductId: 'NOPE', reason: 'x' });
    expect(codeOf(ghost)).toBe('no_such_item');
    const only = await propose({ change: 'barcode_remove', productId: 'OIL', code: 'C7-OIL', reason: 'wrong code (synthetic)' });
    expect([only.status, codeOf(only)]).toEqual([422, 'only_barcode_of_the_item']);
    expect(words(only)).toMatch(/only barcode on Synthetic Oil 1L\. Without it the tills cannot sell Synthetic Oil 1L by scanning/);
    expect(codeOf(await propose({ change: 'barcode_remove', productId: 'SALT', code: 'C7-WRONG' }))).toBe('not_readable_as_a_catalogue_change'); // no reason
    expect((await propose({ change: 'barcode_remove', productId: 'SALT', code: 'C7-WRONG', reason: 'x' }, 'u-cash')).status).toBe(403);
    expect((await inbox('u-owner')).waitingForMe).toEqual([]);

    // Ticked: allowed, and the approver reads the warning.
    const sent = await propose({ change: 'barcode_remove', productId: 'OIL', code: 'C7-OIL', leaveWithoutBarcode: true, reason: 'the code belongs to another brand (synthetic)' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const requestId = (sent.body as { requestId: string }).requestId;
    const row = (await inbox('u-owner')).waitingForMe.find((r) => r.requestId === requestId)!;
    expect(row.summary).toBe('Remove barcode C7-OIL from Synthetic Oil 1L (OIL)');
    expect(row.details.changes).toEqual([
      { field: 'removeBarcode', before: 'C7-OIL', after: '' },
      { field: 'barcodes', before: 'C7-OIL', after: 'none' },
      { field: 'noBarcodeLeft', before: '', after: 'Synthetic Oil 1L will have no barcode: the tills can sell it only by finding it by name' },
    ]);
    expect((await decide(h, T, 'u-owner', requestId, 'approved', 'agreed (synthetic)')).body).toMatchObject({ catalogueChange: { applied: true } });
    expect(await owner('C7-OIL')).toBeUndefined();
    expect(await codes('OIL')).toEqual([]);
    expect((await history('OIL')).map((x) => x.what)).toEqual(['given', 'removed']);
    expect((await trail('catalogue.barcode.remove'))[0]).toMatchObject({ approvalId: requestId, after: expect.objectContaining({ noBarcodeLeft: 'yes' }) });

    // A refusal by the approver changes nothing.
    const again = await propose({ change: 'barcode_remove', productId: 'SALT', code: 'C7-WRONG', reason: 'x (synthetic)' });
    const r2 = (again.body as { requestId: string }).requestId;
    expect((await decide(h, T, 'u-owner', r2, 'rejected', 'it is right, the pack has two codes (synthetic)')).body).toMatchObject({ catalogueChange: { applied: false, refused: true } });
    expect(await owner('C7-WRONG')).toBe('SALT');
  });

  it('the owner\'s own proposal is approved by the accountant, never by himself; a change approved after the code already moved is not made, by name', async () => {
    const { h, T, propose, inbox, owner, codes } = await setUp(harness);
    const mine = await propose({ change: 'barcode_remove', productId: 'SALT', code: 'C7-WRONG', reason: 'typed twice (synthetic)' }, 'u-owner');
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    const id = (mine.body as { requestId: string }).requestId;
    const own = await decide(h, T, 'u-owner', id);
    expect([own.status, codeOf(own)]).toEqual([422, 'self_approval']);
    expect((await inbox('u-acct')).waitingForMe.map((r) => r.requestId)).toContain(id);
    expect((await inbox('u-mgr')).waitingForMe.map((r) => r.requestId)).not.toContain(id);

    // Meanwhile the manager proposes moving the same code; it is approved and made first.
    const move = await propose({ change: 'barcode_move', productId: 'SALT', code: 'C7-WRONG', toProductId: 'SUGAR', reason: 'sugar pack (synthetic)' });
    const moveId = (move.body as { requestId: string }).requestId;
    expect((await decide(h, T, 'u-owner', moveId, 'approved', 'ok (synthetic)')).body).toMatchObject({ catalogueChange: { applied: true } });

    const late = await decide(h, T, 'u-acct', id, 'approved', 'ok (synthetic)');
    expect(late.status, JSON.stringify(late.body)).toBe(201);
    expect(late.body).toMatchObject({ catalogueChange: { applied: false, code: 'barcode_not_on_this_item', reason: 'Barcode C7-WRONG is not on Synthetic Salt 1kg (SALT). It is on Synthetic Sugar 1kg (SUGAR).' } });
    expect(await owner('C7-WRONG')).toBe('SUGAR');
    expect(await codes('SUGAR')).toEqual(['C7-SUGAR', 'C7-WRONG']);
    expect((await inbox('u-owner')).mine.find((r) => r.requestId === id)).toMatchObject({ status: 'used', catalogueChange: { applied: false } });
  });

  it('old bills keep their item; the tills get the new mapping only with the next pack; a till still on the old pack that scanned the moved code is a visible exception', async () => {
    const { h, T, req, ok, propose } = await setUp(harness);
    await ok(req('POST', '/v1/catalogue/pack', { storeId: STORE, asOf: AS_OF }), 'publish v1');
    const v1 = (await req('GET', '/v1/catalogue/pack')).body as SignedPack;
    expect(new CatalogueCache(v1.snapshot).scan('C7-WRONG')).toMatchObject({ product: { productId: 'SALT' }, scannedCode: 'C7-WRONG' });
    const sale = (saleId: string, productId: string, packVersion: number) => req('POST', '/v1/sales', {
      saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-owner', tradingDay: '2030-06-01', committedAt: '2030-06-01T10:00:00.000Z',
      totalMinor: 9_000, currency: 'INR', packVersion, locationId: STORE,
      lines: [{ productId, quantityMinor: 1, uom: 'ea', unitPriceMinor: 9_000, lineTotalMinor: 9_000, scannedCode: 'C7-WRONG' }],
      tenders: [{ kind: 'cash', amountMinor: 9_000 }],
    });
    await ok(sale('c7-before', 'SALT', v1.snapshot.version), 'sale before');

    const sent = await propose({ change: 'barcode_move', productId: 'SALT', code: 'C7-WRONG', toProductId: 'SUGAR', reason: 'sugar pack (synthetic)' });
    await decide(h, T, 'u-owner', (sent.body as { requestId: string }).requestId, 'approved', 'ok (synthetic)');
    // Not yet on the tills: the pack they hold still maps the old way (an offline till keeps selling, P-01).
    expect(((await req('GET', '/v1/catalogue/pack')).body as SignedPack).snapshot.version).toBe(v1.snapshot.version);
    expect(new CatalogueCache(v1.snapshot).scan('C7-WRONG').product.productId).toBe('SALT');
    await ok(req('POST', '/v1/catalogue/pack', { storeId: STORE, asOf: AS_OF }), 'publish v2');
    const v2 = (await req('GET', '/v1/catalogue/pack')).body as SignedPack;
    expect(v2.snapshot.version).toBe(v1.snapshot.version + 1);
    expect(new CatalogueCache(v2.snapshot).scan('C7-WRONG').product.productId).toBe('SUGAR');

    // The bill made before is unchanged.
    const banked = (await h.store.findByIdempotencyKey(T, `sale-${T}-c7-before`))?.event.payload as { lines: { productId: string; scannedCode?: string }[] };
    expect(banked.lines[0]).toMatchObject({ productId: 'SALT', scannedCode: 'C7-WRONG' });
    // A till still on v1 sold it as salt: a visible exception, not a silent wrong sale. A till on v2 sold it as sugar: nothing.
    await ok(sale('c7-offline', 'SALT', v1.snapshot.version), 'offline sale');
    await ok(sale('c7-current', 'SUGAR', v2.snapshot.version), 'current sale');
    const open = ((await req('GET', '/v1/sales/exceptions')).body as { material: { kind: string; saleId: string; detail: string; ownerAction: string }[] }).material
      .filter((e) => e.kind === 'barcode_changed_since_the_tills_pack');
    expect(open.map((e) => e.saleId)).toEqual(['c7-offline']);
    expect(open[0]!.detail).toBe(`barcode C7-WRONG was sold as SALT by a till on catalogue v${v1.snapshot.version}; head office's catalogue v${v2.snapshot.version} has it on SUGAR`);
    expect(open[0]!.ownerAction).toMatch(/^The barcode was removed or moved at head office after this till last took its catalogue pack/);
  });
});
