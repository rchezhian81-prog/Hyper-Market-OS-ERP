import { describe, it, expect } from 'vitest';
import {
  sniffAttachmentType, checkReceiptAttachment, fileFromBase64, shrinkPhoto, plainFileName, attachmentEvent, attachmentKeyFor,
  contentDroppedOnceHanded, ReceiptAttachmentQueue, MAX_RECEIPT_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_RECEIPT, PHOTO_LONGEST_SIDE,
  RECEIPT_ATTACHMENT_KINDS, GOODS_RECEIPT_ATTACHMENT_CAPTURED,
} from '../../packages/receiving/src/receipt-attachments';
import { RECEIPT_ATTACHMENT_WORDS, attachmentWord, attachmentKindChoices } from '../../packages/receiving/src/receipt-attachment-words';
import { openAttachmentRelay } from '../../packages/receiving/src/receipt-attachment-relay';
import { openDeviceOutbox, noDeviceStore } from '../../packages/sync/src/device-outbox';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { isRelayable } from '../../packages/sync/src/device-relay';
import { HANDHELD_PERSON_FIELD } from '../../edge/store-edge/src/handheld-sign-in';
import { sha256Hex } from '../../packages/fulfilment/src/sha256';
import { printLayout, type PrintView } from '../../packages/documents/src/print-view';
import { createReceiptAttachmentsReview, type ReviewedAttachment } from '../../apps/web-erp/src/receipt-attachments-review';
import { attachmentTally, goodsReceiptAttachmentRoutes, type StoredReceiptAttachment, type ReceiptAttachmentMistake } from '../../services/inventory/src/goods-receipt-attachments';

/**
 * **Batch 20e · R6 (M07-FR-04 "evidence attachments" · WF-04 · OB-904 – OB-907):** the one shape of a photo or scan kept with a
 * goods receipt — what may be kept (JPEG / PNG / PDF from the file's own bytes, at most 150 KB), how a photo is made smaller,
 * the device's OWN queue (refusals in words, the five states, the bytes dropped from the device once the store computer holds
 * the file), the relay one file at a time, the words in English and Tamil, the printed GRN's "N attachments", the review
 * session's calls, and head office's routes (sha check, idempotency, conflict, "attached by mistake" kept, audit).
 */

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);
const PDF = new TextEncoder().encode('%PDF-1.4 challan');
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');

describe('what may be kept (OB-904)', () => {
  it('the type is read from the file\'s own first bytes; a JPEG/PNG photo or a PDF scan only; at most 150 KB', () => {
    expect(sniffAttachmentType(PNG)).toBe('image/png');
    expect(sniffAttachmentType(JPG)).toBe('image/jpeg');
    expect(sniffAttachmentType(PDF)).toBe('application/pdf');
    expect(sniffAttachmentType(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeUndefined();
    expect(checkReceiptAttachment('image/png', PNG)).toEqual({ ok: true, mediaType: 'image/png', bytes: PNG.length });
    expect(checkReceiptAttachment('image/jpeg', PNG)).toMatchObject({ ok: false, code: 'file_type_not_allowed' }); // sent as the wrong type
    expect(checkReceiptAttachment('image/png', new Uint8Array())).toMatchObject({ ok: false, code: 'file_empty' });
    const big = new Uint8Array(MAX_RECEIPT_ATTACHMENT_BYTES + 1); big.set(PDF);
    expect(checkReceiptAttachment('application/pdf', big)).toMatchObject({ ok: false, code: 'file_too_large' });
    const fits = new Uint8Array(MAX_RECEIPT_ATTACHMENT_BYTES); fits.set(PDF);
    expect(checkReceiptAttachment('application/pdf', fits)).toMatchObject({ ok: true });
  });

  it('a file read from base64 carries its own SHA-256 and a plain name (no path, no odd characters)', () => {
    const r = fileFromBase64('C:\\scans\\challan<1>.pdf', 'application/pdf', b64(PDF));
    expect(r).toMatchObject({ ok: true, file: { fileName: 'challan1.pdf', mediaType: 'application/pdf', bytes: PDF.length, sha256: sha256Hex(PDF) } });
    expect(fileFromBase64('x', 'image/png', 'not base64!')).toMatchObject({ ok: false, code: 'not_base64' });
    expect(plainFileName('', 'image/jpeg')).toBe('file.jpg');
  });

  it('a photo is shrunk: never enlarged, quality then size stepped down until it fits; undefined when nothing fits', async () => {
    const asked: [number, number][] = [];
    const encode = async (side: number, q: number): Promise<Uint8Array> => { asked.push([side, q]); return new Uint8Array(side >= PHOTO_LONGEST_SIDE ? MAX_RECEIPT_ATTACHMENT_BYTES + 1 : 1000); }; // fits only once the size is stepped down
    expect((await shrinkPhoto(encode, 4000))?.length).toBe(1000);
    expect(asked[0]).toEqual([PHOTO_LONGEST_SIDE, 0.82]); // a 4000 px photo starts at 1600 px
    expect(asked.some(([s]) => s < PHOTO_LONGEST_SIDE)).toBe(true);
    asked.length = 0;
    await shrinkPhoto(async (side) => { asked.push([side, 0]); return new Uint8Array(10); }, 800);
    expect(asked[0]![0]).toBe(800); // a small photo is never enlarged
    expect(await shrinkPhoto(async () => new Uint8Array(MAX_RECEIPT_ATTACHMENT_BYTES + 1), 3000)).toBeUndefined();
  });
});

describe('the device\'s own queue (OB-906)', () => {
  const input = (over: Record<string, unknown> = {}) => ({
    attachmentId: 'ra-1', grnId: 'grn-1', receiptNumber: 'DN-1', warehouseId: 'store-1', storeId: 'store-1', kind: 'delivery_note',
    fileName: 'note.png', mediaType: 'image/png', contentBase64: b64(PNG), attachedBy: 'u-mgr', ...over,
  });

  it('refuses in words before anything is queued; keeps one record per file, in the person\'s name, with the five states', () => {
    const outbox = new SyncOutbox();
    const q = new ReceiptAttachmentQueue(outbox, { now: () => '2026-11-20T05:00:00.000Z', source: 'manager-screen' });
    expect(q.add(input({ attachedBy: null }))).toMatchObject({ added: false, code: 'nobody_named' });
    expect(q.add(input({ kind: 'invoice' }))).toMatchObject({ added: false, code: 'kind_not_known' });
    expect(q.add(input({ grnId: ' ' }))).toMatchObject({ added: false, code: 'no_receipt' });
    expect(q.add(input({ mediaType: 'image/jpeg' }))).toMatchObject({ added: false, code: 'file_type_not_allowed' });
    expect(outbox.all()).toHaveLength(0);
    // A damage photo names its item; any other kind does not carry one.
    expect(q.add(input({ attachmentId: 'ra-2', kind: 'damage_photo', productId: 'p-oil' }))).toMatchObject({ added: true, attachment: { kind: 'damage_photo', productId: 'p-oil', state: 'saved_here' } });
    expect(q.add(input({ attachmentId: 'ra-3', productId: 'p-oil' })).added).toBe(true);
    const [note] = q.list(); // newest first: the delivery note
    expect(note).not.toHaveProperty('productId');
    const ev = outbox.all()[0]!.event;
    expect(ev).toMatchObject({ type: GOODS_RECEIPT_ATTACHMENT_CAPTURED, idempotencyKey: attachmentKeyFor('ra-2'), payload: { attachedBy: 'u-mgr', sha256: sha256Hex(PNG), source: 'manager-screen' } });
    // Where each has got to: retrying → with the store computer → posted / refused with the reason.
    outbox.recordFailure(attachmentKeyFor('ra-2'));
    expect(q.of('grn-1').find((a) => a.attachmentId === 'ra-2')?.state).toBe('retrying');
    outbox.acknowledge(attachmentKeyFor('ra-2'));
    outbox.acknowledge(attachmentKeyFor('ra-3'));
    expect(q.handedKeys()).toEqual([attachmentKeyFor('ra-2'), attachmentKeyFor('ra-3')]);
    q.noteBoxStatus([{ key: attachmentKeyFor('ra-2'), state: 'posted', attempts: 1 }, { key: attachmentKeyFor('ra-3'), state: 'refused', attempts: 1, reason: 'head office refused it' }]);
    expect(q.list().map((a) => [a.attachmentId, a.state, a.reason])).toEqual([['ra-3', 'refused', 'head office refused it'], ['ra-2', 'posted', undefined]]);
    expect(q.handedKeys()).toEqual([attachmentKeyFor('ra-3')]); // a posted file is not asked after again
    expect(q.waiting()).toBe(1);
  });

  it('at most 10 files with one delivery', () => {
    const q = new ReceiptAttachmentQueue(new SyncOutbox(), { now: () => '2026-11-20T05:00:00.000Z', source: 'warehouse-handheld' });
    for (let i = 0; i < MAX_ATTACHMENTS_PER_RECEIPT; i += 1) expect(q.add(input({ attachmentId: `ra-${i}` })).added).toBe(true);
    expect(q.add(input({ attachmentId: 'ra-x' }))).toMatchObject({ added: false, code: 'too_many_files' });
    expect(q.add(input({ attachmentId: 'ra-y', grnId: 'grn-2' })).added).toBe(true);
  });

  it('once the store computer holds a file, its bytes leave the device\'s storage; a waiting or refused file keeps them', () => {
    const disk = noDeviceStore();
    const outbox = openDeviceOutbox(contentDroppedOnceHanded(disk), () => {});
    const q = new ReceiptAttachmentQueue(outbox, { now: () => '2026-11-20T05:00:00.000Z', source: 'manager-screen' });
    q.add(input({ attachmentId: 'ra-a' }));
    q.add(input({ attachmentId: 'ra-b' }));
    q.add(input({ attachmentId: 'ra-c' }));
    outbox.acknowledge(attachmentKeyFor('ra-a'));
    outbox.deadLetter(attachmentKeyFor('ra-c'), 'not a record this box relays');
    const saved = JSON.parse(disk.read()!) as { key: string; event: { payload: Record<string, unknown> } }[];
    const content = (id: string) => saved.find((i) => i.key === attachmentKeyFor(id))!.event.payload;
    expect(content('ra-a')).not.toHaveProperty('contentBase64');
    expect(content('ra-a')).toMatchObject({ contentKeptOnStoreComputer: true, sha256: sha256Hex(PNG) });
    expect(content('ra-b')['contentBase64']).toBe(b64(PNG));
    expect(content('ra-c')['contentBase64']).toBe(b64(PNG));
    // Read back after a restart: the list still says every file and where it has got to.
    const again = new ReceiptAttachmentQueue(openDeviceOutbox(disk, () => {}), { now: () => '', source: 'manager-screen' });
    expect(again.list().map((a) => [a.attachmentId, a.state])).toEqual([['ra-c', 'refused'], ['ra-b', 'saved_here'], ['ra-a', 'handed_to_box']]);
  });

  it('the relay hands over ONE file per batch and asks the store computer where the files have got to', async () => {
    const outbox = new SyncOutbox();
    const q = new ReceiptAttachmentQueue(outbox, { now: () => '2026-11-20T05:00:00.000Z', source: 'manager-screen' });
    q.add(input({ attachmentId: 'ra-1' }));
    q.add(input({ attachmentId: 'ra-2' }));
    const batches: number[] = [];
    const fetch = async (url: string, init: { body?: string }) => {
      if (url.includes('/lane/outbox/status')) return { status: 200, json: async () => ({ items: [{ key: attachmentKeyFor('ra-1'), state: 'posted', attempts: 1 }] }) };
      const body = JSON.parse(init.body ?? '{}') as { source: string; items: { key: string }[] };
      expect(body.source).toBe('manager');
      batches.push(body.items.length);
      return { status: 200, json: async () => ({ acks: body.items.map((i) => ({ key: i.key, status: 'accepted' })) }) };
    };
    const relay = openAttachmentRelay({ boxBase: 'http://box', outbox, queue: q, source: 'manager', fetch })!;
    expect(await relay.syncNow()).toMatchObject({ handed: 2, offline: false });
    expect(batches).toEqual([1, 1]);
    expect(q.list().map((a) => a.state)).toEqual(['handed_to_box', 'posted']);
    // The link down: every file kept, nothing lost.
    q.add(input({ attachmentId: 'ra-3' }));
    const down = openAttachmentRelay({ boxBase: 'http://box', outbox, queue: q, source: 'manager', fetch: async () => { throw new Error('ECONNREFUSED'); } })!;
    expect(await down.syncNow()).toMatchObject({ handed: 0, offline: true });
    expect(q.of('grn-1').find((a) => a.attachmentId === 'ra-3')?.state).toBe('retrying');
    expect(openAttachmentRelay({ boxBase: undefined, outbox, queue: q, source: 'manager', fetch })).toBeUndefined();
  });

  it('the store computer relays it from the Receive screen and the warehouse handheld, and a phone record names who attached it', () => {
    expect(isRelayable(GOODS_RECEIPT_ATTACHMENT_CAPTURED, 'manager')).toBe(true);
    expect(isRelayable(GOODS_RECEIPT_ATTACHMENT_CAPTURED, 'warehouse')).toBe(true);
    expect(isRelayable(GOODS_RECEIPT_ATTACHMENT_CAPTURED, 'driver')).toBe(false);
    expect(HANDHELD_PERSON_FIELD[GOODS_RECEIPT_ATTACHMENT_CAPTURED]).toBe('attachedBy');
    const ev = attachmentEvent({ attachmentId: 'ra-9', grnId: 'g', receiptNumber: 'n', warehouseId: 'w', storeId: null, kind: 'supplier_challan', fileName: 'c.pdf', mediaType: 'application/pdf', bytes: 3, sha256: 'x', contentBase64: 'AAAA', attachedBy: 'u', attachedAt: '2026-11-20T05:00:00.000Z', source: 'warehouse-handheld' });
    expect(ev).toMatchObject({ id: 'receipt-attachment-ra-9', source: 'warehouse-handheld', idempotencyKey: 'receipt-attachment-ra-9' });
  });
});

describe('the words, English and Tamil, one at a time', () => {
  it('every key has both languages; every kind and every refusal a screen can show has words', () => {
    expect(Object.keys(RECEIPT_ATTACHMENT_WORDS.ta).sort()).toEqual(Object.keys(RECEIPT_ATTACHMENT_WORDS.en).sort());
    for (const k of Object.keys(RECEIPT_ATTACHMENT_WORDS.ta)) expect((RECEIPT_ATTACHMENT_WORDS.ta as Record<string, string>)[k]!.trim(), k).not.toBe('');
    for (const code of ['file_empty', 'file_type_not_allowed', 'file_too_large', 'not_base64', 'checksum_mismatch', 'kind_not_known', 'too_many_files', 'no_receipt', 'nobody_named', 'could_not_shrink', 'could_not_read']) {
      expect(attachmentWord('en', code)).not.toBe(code);
      expect(attachmentWord('ta', code)).not.toBe(attachmentWord('en', code));
    }
    expect(attachmentKindChoices('en').map((k) => k.kind)).toEqual([...RECEIPT_ATTACHMENT_KINDS]);
    expect(attachmentKindChoices('ta').map((k) => k.label)).toEqual(['டெலிவரி குறிப்பு', 'சப்ளையரின் சலான்', 'சேதப் புகைப்படம்']);
    expect(attachmentWord('en', 'savedWith', { n: 2 })).toBe('2 photo(s) or scan(s) kept with the delivery.');
  });
});

describe('the printed GRN says how many files are kept with it (OB-907)', () => {
  const view = (attachments?: { kept: number; mistaken: number }): PrintView => ({
    kind: 'goods_receipt', documentNumber: 'GRN1/26-27/00001', date: '2026-11-20', shop: { name: 'SRE', gstin: null, address: [] }, supplier: { name: null, gstin: null, address: [] },
    facts: [], lines: [], totalMinor: 0, currency: 'INR', readAt: '2026-11-20T05:00:00.000Z', ...(attachments === undefined ? {} : { attachments }),
  });
  it('"N attachments", "1 attachment", none said too, and those marked by mistake', () => {
    expect(printLayout(view({ kept: 3, mistaken: 0 }), 'en').notes).toContain('3 attachments (photos and scans) are kept with this receipt — see Goods receipt review.');
    expect(printLayout(view({ kept: 1, mistaken: 1 }), 'en').notes.at(-1)).toBe('1 attachment (a photo or scan) is kept with this receipt — see Goods receipt review. 1 more marked attached by mistake (kept).');
    expect(printLayout(view({ kept: 0, mistaken: 0 }), 'en').notes.at(-1)).toBe('No photo or scan is kept with this receipt.');
    expect(printLayout(view({ kept: 2, mistaken: 0 }), 'ta').notes.at(-1)).toContain('2 இணைப்புகள்');
    expect(printLayout(view(), 'en').notes).toHaveLength(1); // an older view with no count says nothing about files
  });
});

describe('Goods receipt review\'s calls (online, the reader\'s own session)', () => {
  it('reads, opens, adds and marks; a reader without the stock right only reads; a mistake needs a reason', async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const fetch = (async (url: string, init: { method: string; body?: string }) => {
      calls.push({ method: init.method, url, ...(init.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }) });
      const json = url.endsWith('/attachments') ? { attachments: [{ attachmentId: 'a1', grnId: 'g/1', kind: 'damage_photo', productId: 'p-oil', fileName: 'x.jpg', mediaType: 'image/jpeg', bytes: 2048, attachedBy: 'u-recv', attachedAt: '2026-11-20T05:00:00.000Z', source: 'warehouse-handheld', flags: ['attacher_lacks_authority'], mistake: { reason: 'wrong delivery', markedBy: 'u-mgr', markedAt: '2026-11-20T06:00:00.000Z' } }] }
        : url.endsWith('/a1') ? { attachment: { mediaType: 'image/jpeg', contentBase64: 'AAAA' } } : { alreadyRecorded: false };
      return { ok: true, status: 200, json: async () => json };
    }) as unknown as typeof globalThis.fetch;
    const review = createReceiptAttachmentsReview({ viewer: { userId: 'u-mgr', permissions: ['inventory.movement.append'] }, fetch, newId: () => 'ra-new' });
    const files = await review.files('g/1');
    expect(files).toMatchObject({ result: 'ok', value: [{ attachmentId: 'a1' }] });
    expect(calls[0]!.url).toBe('/v1/inventory/goods-receipt/g%2F1/attachments');
    expect(await review.open('g/1', 'a1')).toEqual({ result: 'ok', value: 'data:image/jpeg;base64,AAAA' });
    expect(await review.markMistake('g/1', 'a1', 'no')).toEqual({ result: 'invalid', why: 'needReason' });
    await review.markMistake('g/1', 'a1', 'photo of another delivery');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: '/v1/inventory/goods-receipt/g%2F1/attachments/a1/mistake', body: { reason: 'photo of another delivery' } });
    expect(await review.add('g/1', { fileName: 'c.pdf', mediaType: 'application/pdf', contentBase64: 'AAAA' }, 'scan')).toEqual({ result: 'invalid', why: 'kind_not_known' });
    expect(await review.add('g/1', { fileName: 'c.pdf', mediaType: 'application/pdf', contentBase64: 'AAAA' }, 'supplier_challan')).toEqual({ result: 'ok', value: { alreadyRecorded: false } });
    expect(calls.at(-1)).toMatchObject({ url: '/v1/inventory/goods-receipt/g%2F1/attachments/ra-new', body: { kind: 'supplier_challan', fileName: 'c.pdf' } });
    const said = review.describe('en', (files as unknown as { value: readonly ReviewedAttachment[] }).value[0]!, () => '20/11/2026 11:30', () => 'Groundnut oil');
    expect(said).toEqual({
      title: 'Damage photo · for Groundnut oil · x.jpg', detail: '2 KB · Attached by u-recv · 20/11/2026 11:30 · from the warehouse handheld',
      mistake: 'Marked attached by mistake by u-mgr on 20/11/2026 11:30: wrong delivery. Kept.', flags: ['The person named does not hold the right to receive goods.'],
    });
    const reader = createReceiptAttachmentsReview({ viewer: { userId: 'u-acct', permissions: ['inventory.goodsreceipt.read'] }, fetch });
    expect(reader.mayChange).toBe(false);
    expect(await reader.markMistake('g/1', 'a1', 'photo of another delivery')).toEqual({ result: 'invalid', why: 'mayNotChange' });
    expect(await createReceiptAttachmentsReview({ viewer: undefined, fetch }).add('g', { fileName: 'a', mediaType: 'b', contentBase64: 'c' }, 'delivery_note')).toEqual({ result: 'invalid', why: 'nobody' });
  });
});

describe('head office\'s routes on a bare in-memory register', () => {
  const kept: { meta: StoredReceiptAttachment; content: string }[] = [];
  const mistakes: ReceiptAttachmentMistake[] = [];
  const audits: { action: string; actorId: string }[] = [];
  const routes = goodsReceiptAttachmentRoutes({
    grn: async (_t, grnId) => (grnId === 'grn-1' ? { warehouseId: 'store-1', number: 'GRN1/26-27/00001' } : undefined),
    attachments: async (_t, grnId) => kept.filter((k) => k.meta.grnId === grnId).map((k) => k.meta),
    attachment: async (_t, id) => { const k = kept.find((x) => x.meta.attachmentId === id); return k === undefined ? undefined : { ...k.meta, contentBase64: k.content }; },
    recordAttachment: async (_t, meta, content) => { kept.push({ meta, content }); },
    mistakes: async (_t, grnId) => mistakes.filter((m) => m.grnId === grnId),
    recordMistake: async (_t, m) => { mistakes.push(m); },
    permissionsOfUser: (_t, u) => (u === 'u-recv' ? ['inventory.movement.append'] : u === 'u-cashier' ? ['pos.sale.create'] : undefined),
    recordAudit: (_t, e) => { audits.push({ action: e.action, actorId: e.actorId }); },
    now: () => '2026-11-20T05:00:00.000Z',
  });
  const route = (method: string, path: string) => routes.find((r) => r.method === method && r.path === path)!;
  const ctx = (params: Record<string, string>, body: unknown, userId = 'u-box') => ({ tenantId: 't', userId, scope: 'all', params, query: {}, body, branchId: null }) as never;
  const synced = route('POST', '/v1/inventory/goods-receipt/:grnId/attachments/:attachmentId/synced');
  const relayed = (over: Record<string, unknown> = {}) => ({
    attachmentId: 'ra-1', grnId: 'grn-1', receiptNumber: 'DN-1', warehouseId: 'store-1', storeId: 'store-1', kind: 'damage_photo', productId: 'p-oil',
    fileName: 'd.png', mediaType: 'image/png', bytes: PNG.length, sha256: sha256Hex(PNG), contentBase64: b64(PNG), attachedBy: 'u-recv', attachedAt: '2026-11-20T04:59:00.000Z', source: 'manager-screen', ...over,
  });

  it('keeps a relayed file once, checks its hash, flags a doubtful person, refuses a different file under the same id, audits each', async () => {
    await expect(synced.handler(ctx({ grnId: 'grn-1', attachmentId: 'ra-1' }, relayed({ sha256: '0'.repeat(64) })))).rejects.toMatchObject({ status: 400 });
    await expect(synced.handler(ctx({ grnId: 'grn-1', attachmentId: 'ra-1' }, relayed({ grnId: 'grn-2' })))).rejects.toMatchObject({ status: 400 });
    const first = await synced.handler(ctx({ grnId: 'grn-1', attachmentId: 'ra-1' }, relayed()));
    expect(first).toMatchObject({ status: 201, body: { attachment: { relayedBy: 'u-box', attachedBy: 'u-recv', flags: [], productId: 'p-oil' } } });
    expect(await synced.handler(ctx({ grnId: 'grn-1', attachmentId: 'ra-1' }, relayed()))).toMatchObject({ status: 200, body: { alreadyRecorded: true } });
    await expect(synced.handler(ctx({ grnId: 'grn-1', attachmentId: 'ra-1' }, relayed({ contentBase64: b64(JPG), mediaType: 'image/jpeg', sha256: sha256Hex(JPG) })))).rejects.toMatchObject({ status: 409 });
    const flagged = await synced.handler(ctx({ grnId: 'grn-9', attachmentId: 'ra-2' }, relayed({ grnId: 'grn-9', attachmentId: 'ra-2', attachedBy: 'u-cashier', kind: 'delivery_note' })));
    expect(flagged).toMatchObject({ status: 201, body: { attachment: { flags: ['attacher_lacks_authority'] } } });
    expect((flagged.body as { attachment: object }).attachment).not.toHaveProperty('productId');
    expect(audits.map((a) => [a.action, a.actorId])).toEqual([['goods_receipt.attachment.keep', 'u-recv'], ['goods_receipt.attachment.keep', 'u-cashier']]);
  });

  it('"attached by mistake" needs a reason, is recorded once, and the file stays kept and readable', async () => {
    const mark = route('POST', '/v1/inventory/goods-receipt/:grnId/attachments/:attachmentId/mistake');
    await expect(mark.handler(ctx({ grnId: 'grn-1', attachmentId: 'ra-1' }, { reason: 'no' }, 'u-mgr'))).rejects.toMatchObject({ status: 400 });
    await expect(mark.handler(ctx({ grnId: 'grn-2', attachmentId: 'ra-1' }, { reason: 'wrong delivery' }, 'u-mgr'))).rejects.toMatchObject({ status: 404 });
    expect(await mark.handler(ctx({ grnId: 'grn-1', attachmentId: 'ra-1' }, { reason: 'wrong delivery' }, 'u-mgr'))).toMatchObject({ status: 201 });
    expect(await mark.handler(ctx({ grnId: 'grn-1', attachmentId: 'ra-1' }, { reason: 'again' }, 'u-mgr'))).toMatchObject({ status: 200, body: { alreadyMarked: true, mistake: { reason: 'wrong delivery' } } });
    const list = await route('GET', '/v1/inventory/goods-receipt/:grnId/attachments').handler(ctx({ grnId: 'grn-1' }, undefined, 'u-mgr'));
    expect(list.body).toMatchObject({ kept: 0, mistaken: 1, attachments: [{ attachmentId: 'ra-1', mistake: { markedBy: 'u-mgr' } }] });
    const one = await route('GET', '/v1/inventory/goods-receipt/:grnId/attachments/:attachmentId').handler(ctx({ grnId: 'grn-1', attachmentId: 'ra-1' }, undefined, 'u-mgr'));
    expect((one.body as { attachment: { contentBase64: string } }).attachment.contentBase64).toBe(b64(PNG));
    expect(audits.at(-1)).toEqual({ action: 'goods_receipt.attachment.mistake', actorId: 'u-mgr' });
    expect(attachmentTally(kept.map((k) => k.meta), mistakes)).toEqual({ kept: 1, mistaken: 1 }); // grn-1's and grn-9's files
    // No route removes or replaces a file (hard rule #6).
    expect(routes.some((r) => (r.method as string) === 'DELETE' || (r.method as string) === 'PUT')).toBe(false);
  });

  it('a file added at head office needs the receipt to exist and a kind; the person signed in is the attacher', async () => {
    const add = route('POST', '/v1/inventory/goods-receipt/:grnId/attachments/:attachmentId');
    await expect(add.handler(ctx({ grnId: 'grn-404', attachmentId: 'ra-h' }, { kind: 'supplier_challan', fileName: 'c.pdf', mediaType: 'application/pdf', contentBase64: b64(PDF) }, 'u-acct'))).rejects.toMatchObject({ status: 404 });
    await expect(add.handler(ctx({ grnId: 'grn-1', attachmentId: 'ra-h' }, { kind: 'bill', fileName: 'c.pdf', mediaType: 'application/pdf', contentBase64: b64(PDF) }, 'u-acct'))).rejects.toMatchObject({ status: 400 });
    const out = await add.handler(ctx({ grnId: 'grn-1', attachmentId: 'ra-h' }, { kind: 'supplier_challan', fileName: 'c.pdf', mediaType: 'application/pdf', contentBase64: b64(PDF) }, 'u-acct'));
    expect(out).toMatchObject({ status: 201, body: { attachment: { attachedBy: 'u-acct', source: 'head-office', relayedBy: null, receiptNumber: 'GRN1/26-27/00001' } } });
  });
});
