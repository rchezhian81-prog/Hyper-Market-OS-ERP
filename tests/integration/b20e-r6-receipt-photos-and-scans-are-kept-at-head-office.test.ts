import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { backingsFor, headOffice, type HeadOffice } from '../support/till-bill-world';
import { sha256Hex } from '../../packages/fulfilment/src/sha256';

/**
 * **Batch 20e · R6 (M07-FR-04 "evidence attachments" · WF-04 · OB-904 – OB-907) — head office, on the in-memory store AND real
 * PostgreSQL (cold restarts between steps):**
 *
 *   • a photo taken at the store reaches head office through the store computer (`…/attachments/:id/synced`, the box's own
 *     credential) — even BEFORE its receipt does (they travel apart, so the receipt never waits for a photo); the bytes are
 *     checked against their SHA-256 and the type from the file itself; the same file again is one record; a different file
 *     under the same id is a conflict (409), never a silent overwrite; a place the store computer does not speak for is refused;
 *   • the receipts list counts each receipt's files; Goods receipt review lists them (no bytes) and opens one (with its bytes);
 *   • a file is added at head office by a person who handles the stock; the accountant may look but not add;
 *   • "attached by mistake" needs a reason, is recorded once with who and when, and the file stays kept and readable (#6);
 *   • the printed GRN says how many files are kept with it.
 * Synthetic data only.
 */

const { backings, open, close } = backingsFor(process.env['DATABASE_URL']);
beforeAll(open);
afterAll(close);

const AT = '2026-11-20T05:00:00.000Z';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7, 7, 7]);
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PDF = new TextEncoder().encode('%PDF-1.4 supplier challan 4471');
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');

async function seeded(ho: HeadOffice): Promise<void> {
  const node = async (id: string, body: Record<string, unknown>): Promise<void> => { await ho.ok('POST', `/v1/org/nodes/${id}`, 'u-owner', body); };
  await node('C-1', { kind: 'company', name: 'Synthetic Retail' });
  await node('store-1', { kind: 'branch', name: 'Store 1', parentId: 'C-1', companyId: 'C-1' });
  await node('store-2', { kind: 'branch', name: 'Store 2', parentId: 'C-1', companyId: 'C-1' });
}

const relayed = (ho: HeadOffice, attachmentId: string, over: Record<string, unknown> = {}, bytes = PNG, mediaType = 'image/png') =>
  ho.call('POST', `/v1/inventory/goods-receipt/${String(over['grnId'] ?? 'grn-dn-81')}/attachments/${attachmentId}/synced`, 'u-box', {
    attachmentId, grnId: 'grn-dn-81', receiptNumber: 'DN-81', warehouseId: 'store-1', storeId: 'store-1', kind: 'damage_photo', productId: 'p-oil',
    fileName: 'damage.png', mediaType, bytes: bytes.length, sha256: sha256Hex(bytes), contentBase64: b64(bytes),
    attachedBy: 'u-recv', attachedAt: AT, source: 'manager-screen', ...over,
  }, undefined, 'store-1');

describe.each(backings)('Batch 20e — photos and scans kept with a goods receipt — head office on $name', (backing) => {
  it('kept from the store before the receipt, counted on the list, added at head office, marked by mistake and still kept, printed as a count', async () => {
    const ho = await headOffice(backing, [
      { userId: 'u-recv', role: 'store_manager' }, { userId: 'u-acct', role: 'accountant' }, { userId: 'u-box', role: 'store_computer', stores: ['store-1'] },
    ]);
    await seeded(ho);

    // ── the photo arrives first — kept against the receipt's id, in the receiver's name, carried by the box ──
    const bad = await relayed(ho, 'ra-1', { sha256: '0'.repeat(64) });
    expect(bad.status, JSON.stringify(bad.body)).toBe(400);
    expect((await relayed(ho, 'ra-1', {}, new TextEncoder().encode('<svg/>'), 'image/png')).status).toBe(400); // not a photo
    const first = await relayed(ho, 'ra-1');
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ attachment: { attachedBy: 'u-recv', relayedBy: 'u-box', flags: [], kind: 'damage_photo', productId: 'p-oil', sha256: sha256Hex(PNG) } });
    ho.restartCold();
    expect((await relayed(ho, 'ra-1')).body).toMatchObject({ alreadyRecorded: true });
    const clash = await relayed(ho, 'ra-1', {}, JPG, 'image/jpeg');
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({ error: { code: 'attachment_id_holds_another_file' } });
    // The store computer speaks for its own store only.
    expect((await relayed(ho, 'ra-x', { warehouseId: 'store-2' })).status).toBe(403);

    // ── the receipt arrives; the list counts its files ──
    const receipt = await ho.call('POST', '/v1/inventory/goods-receipt/grn-dn-81/synced', 'u-box', {
      grnId: 'grn-dn-81', number: 'DN-81', poId: null, warehouseId: 'store-1', receivedBy: 'u-recv', receivedAt: AT,
      lines: [{ productId: 'p-oil', quantityMinor: 12, uom: 'ea', batchId: null }], storeId: 'store-1', source: 'manager-screen',
    }, undefined, 'store-1');
    expect(receipt.status, JSON.stringify(receipt.body)).toBeLessThan(300);
    ho.restartCold();
    const list = await ho.ok('GET', '/v1/inventory/goods-receipt', 'u-owner');
    expect((list['receipts'] as Record<string, unknown>[]).find((r) => r['grnId'] === 'grn-dn-81')?.['attachments']).toEqual({ kept: 1, mistaken: 0 });
    const review = await ho.ok('GET', '/v1/inventory/goods-receipt-review', 'u-acct');
    expect((review['receipts'] as Record<string, unknown>[]).find((r) => r['grnId'] === 'grn-dn-81')?.['attachments']).toEqual({ kept: 1, mistaken: 0 });

    // ── added at head office: a person who handles the stock may; the accountant may look, not add ──
    const challan = { kind: 'supplier_challan', fileName: 'challan-4471.pdf', mediaType: 'application/pdf', contentBase64: b64(PDF) };
    expect((await ho.call('POST', '/v1/inventory/goods-receipt/grn-dn-81/attachments/ra-ho-1', 'u-acct', challan)).status).toBe(403);
    const added = await ho.call('POST', '/v1/inventory/goods-receipt/grn-dn-81/attachments/ra-ho-1', 'u-recv', challan);
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body).toMatchObject({ attachment: { attachedBy: 'u-recv', source: 'head-office', mediaType: 'application/pdf' } });
    expect((await ho.call('POST', '/v1/inventory/goods-receipt/grn-none/attachments/ra-ho-2', 'u-recv', challan)).status).toBe(404);

    // ── "attached by mistake": a reason, once, and the file stays ──
    ho.restartCold();
    expect((await ho.call('POST', '/v1/inventory/goods-receipt/grn-dn-81/attachments/ra-ho-1/mistake', 'u-recv', { reason: '' })).status).toBe(400);
    expect((await ho.call('POST', '/v1/inventory/goods-receipt/grn-dn-81/attachments/ra-ho-1/mistake', 'u-acct', { reason: 'challan of another delivery' })).status).toBe(403);
    expect((await ho.call('POST', '/v1/inventory/goods-receipt/grn-dn-81/attachments/ra-ho-1/mistake', 'u-recv', { reason: 'challan of another delivery' })).status).toBe(201);
    expect((await ho.call('POST', '/v1/inventory/goods-receipt/grn-dn-81/attachments/ra-ho-1/mistake', 'u-recv', { reason: 'second try' })).body).toMatchObject({ alreadyMarked: true, mistake: { reason: 'challan of another delivery', markedBy: 'u-recv' } });
    ho.restartCold();
    const files = await ho.ok('GET', '/v1/inventory/goods-receipt/grn-dn-81/attachments', 'u-acct');
    expect(files).toMatchObject({ kept: 1, mistaken: 1 });
    expect((files['attachments'] as Record<string, unknown>[]).map((a) => [a['attachmentId'], a['kind'], (a['mistake'] as { reason?: string } | undefined)?.reason ?? null]))
      .toEqual([['ra-1', 'damage_photo', null], ['ra-ho-1', 'supplier_challan', 'challan of another delivery']]);
    expect(JSON.stringify(files)).not.toContain(b64(PDF)); // the list carries no bytes
    const opened = await ho.ok('GET', '/v1/inventory/goods-receipt/grn-dn-81/attachments/ra-ho-1', 'u-acct');
    expect((opened['attachment'] as { contentBase64: string }).contentBase64).toBe(b64(PDF)); // kept, readable
    expect((await ho.call('GET', '/v1/inventory/goods-receipt/grn-other/attachments/ra-ho-1', 'u-acct')).status).toBe(404); // not that receipt's file

    // ── the list and the printed GRN say how many are kept ──
    const after = await ho.ok('GET', '/v1/inventory/goods-receipt', 'u-owner');
    expect((after['receipts'] as Record<string, unknown>[]).find((r) => r['grnId'] === 'grn-dn-81')?.['attachments']).toEqual({ kept: 1, mistaken: 1 });
    const printed = await ho.call('GET', '/v1/documents/print/goods-receipts/grn-dn-81', 'u-owner');
    expect(printed.status, JSON.stringify(printed.body)).toBe(200);
    expect((printed.body as { view: { attachments: unknown } }).view.attachments).toEqual({ kept: 1, mistaken: 1 });

    // ── who and when, on the audit trail ──
    const trail = async (action: string) => ((await ho.call('GET', '/v1/audit/trail', 'u-owner', undefined, { action })).body as { matches: { actorId: string; reason?: string; after: Record<string, string> }[] }).matches;
    expect((await trail('goods_receipt.attachment.keep')).map((m) => [m.actorId, m.after['attachmentId'], m.after['source']])).toEqual([['u-recv', 'ra-1', 'manager-screen'], ['u-recv', 'ra-ho-1', 'head-office']]);
    expect((await trail('goods_receipt.attachment.mistake')).map((m) => [m.actorId, m.reason, m.after['kept']])).toEqual([['u-recv', 'challan of another delivery', 'true']]);
  }, 90_000);
});
