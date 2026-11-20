// API-04 · Batch 20e · R6 — PHOTOS AND SCANS KEPT WITH A GOODS RECEIPT (M07-FR-04 "evidence attachments" · WF-04 · P-01 ·
// P-08 · hard rules #4, #6, #10 · ADR 0010 · OB-904 – OB-907).
//
//   POST /v1/inventory/goods-receipt/:grnId/attachments/:attachmentId/synced    a file taken at the store (Receive on the store
//        computer, or the warehouse handheld), relayed by the store computer under ITS credential — `inventory.receipt.sync`
//   POST /v1/inventory/goods-receipt/:grnId/attachments/:attachmentId           a file added at head office on Goods receipt
//        review, under the person's own session — `inventory.movement.append` (who handles the receipt's stock)
//   GET  /v1/inventory/goods-receipt/:grnId/attachments                         the receipt's files, without their bytes
//   GET  /v1/inventory/goods-receipt/:grnId/attachments/:attachmentId           one file, with its bytes (to see or open it)
//   POST /v1/inventory/goods-receipt/:grnId/attachments/:attachmentId/mistake   "attached by mistake", with a reason — KEPT
//
// Kept as documents the way ADR 0010 keeps every document — append-only events, the bytes beside the record, checked for type
// from the file itself and for size, and the SHA-256 the device sent must be the bytes' own. Nothing is ever deleted or
// overwritten (hard rule #6): a wrong file is MARKED attached by mistake, with who, when and why, and still shown (struck
// through). The same file re-sent is one record; a DIFFERENT file under an id already used is refused as a conflict (#10).
//
// A file from the store may arrive before its receipt does (they travel apart, so the receipt never waits for a photo): it is
// kept against the receipt's id all the same, scoped to the place the store computer speaks for. The person named is
// re-verified from their own grants and a doubt is FLAGGED on the record — never a silent keep, never a silent drop.

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import {
  fileFromBase64, isReceiptAttachmentKind, MIN_MISTAKE_REASON,
  type CapturedReceiptAttachment, type ReceiptAttachmentKind, type ReceiptAttachmentType,
} from '../../../packages/receiving/src/receipt-attachments';
import { assertLocationInScope, type LocationBranches } from './location-scope';

/** One kept file, without its bytes — what lists, the screen and the printed GRN read. */
export interface StoredReceiptAttachment {
  readonly attachmentId: string;
  readonly grnId: string;
  readonly receiptNumber: string;
  readonly warehouseId: string;
  readonly storeId: string | null;
  readonly kind: ReceiptAttachmentKind;
  readonly productId?: string;
  readonly fileName: string;
  readonly mediaType: ReceiptAttachmentType;
  readonly bytes: number;
  readonly sha256: string;
  readonly attachedBy: string;
  readonly attachedAt: string;
  readonly source: CapturedReceiptAttachment['source'] | 'head-office';
  /** The store computer that carried it (its credential), or null when added at head office. Never the attacher (#4). */
  readonly relayedBy: string | null;
  readonly receivedAt: string;
  /** Doubts about the person named, said on the record (`attacher_unknown`, `attacher_lacks_authority`). */
  readonly flags: readonly string[];
}

/** "Attached by mistake" — a fact about a file, never its removal. */
export interface ReceiptAttachmentMistake {
  readonly attachmentId: string;
  readonly grnId: string;
  readonly reason: string;
  readonly markedBy: string;
  readonly markedAt: string;
}

export interface ReceiptAttachmentsDeps {
  /** The receipt as these routes need it, or undefined when head office does not hold it (yet). */
  readonly grn: (tenantId: string, grnId: string) => Promise<{ readonly warehouseId: string; readonly number: string } | undefined>;
  readonly attachments: (tenantId: string, grnId: string) => Promise<readonly StoredReceiptAttachment[]>;
  readonly attachment: (tenantId: string, attachmentId: string) => Promise<(StoredReceiptAttachment & { readonly contentBase64: string }) | undefined>;
  /** Keep the file — its record on the receipt's list and its bytes — in ONE append. */
  readonly recordAttachment: (tenantId: string, a: StoredReceiptAttachment, contentBase64: string) => Promise<void>;
  readonly mistakes: (tenantId: string, grnId: string) => Promise<readonly ReceiptAttachmentMistake[]>;
  readonly recordMistake: (tenantId: string, m: ReceiptAttachmentMistake) => Promise<void>;
  /** The permissions the named person holds through their grants; undefined when the name is unknown. */
  readonly permissionsOfUser: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  readonly locationBranches?: LocationBranches;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isIso = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
const ID = /^[A-Za-z0-9._:-]{1,120}$/;

/** A file with its "attached by mistake" mark, as the screen shows it. */
export type ListedAttachment = StoredReceiptAttachment & { readonly mistake?: ReceiptAttachmentMistake };

/** The kept and the marked-by-mistake counts of one receipt's files — what the GRN list and the printed GRN say. */
export function attachmentTally(list: readonly StoredReceiptAttachment[], mistakes: readonly ReceiptAttachmentMistake[]): { readonly kept: number; readonly mistaken: number } {
  const marked = new Set(mistakes.map((m) => m.attachmentId));
  const ids = new Set(list.map((a) => a.attachmentId));
  const mistaken = [...ids].filter((id) => marked.has(id)).length;
  return { kept: ids.size - mistaken, mistaken };
}

export function goodsReceiptAttachmentRoutes(deps: ReceiptAttachmentsDeps): readonly Route[] {
  const audit = async (ctx: RequestContext, actorId: string, action: string, grnId: string, after: Record<string, string>, reason?: string): Promise<void> => {
    await deps.recordAudit?.(ctx.tenantId, {
      actorId, action, objectType: 'goods_receipt', objectId: grnId, at: deps.now(),
      origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null, after, ...(reason === undefined ? {} : { reason }), correlationId: grnId,
    });
  };
  const flagsFor = async (tenantId: string, userId: string): Promise<string[]> => {
    const held = await deps.permissionsOfUser(tenantId, userId);
    return held === undefined ? ['attacher_unknown'] : held.includes('inventory.movement.append') || held.includes('inventory.receipt.sync') ? [] : ['attacher_lacks_authority'];
  };
  /** The same file under the same id again: one record. A different file under an id already used: a conflict, said. */
  const already = async (tenantId: string, attachmentId: string, sha256: string, grnId: string) => {
    const prior = await deps.attachment(tenantId, attachmentId);
    if (prior === undefined) return undefined;
    if (prior.sha256 !== sha256 || prior.grnId !== grnId) {
      throw apiError(409, {
        code: 'attachment_id_holds_another_file',
        whatHappened: `Head office already keeps a different file under ${attachmentId} (on ${prior.receiptNumber}). The two cannot both be that file.`,
        wasItSaved: 'not_saved', nextSafeAction: 'Do not discard it. Keep it where it is and raise it — a person must look at both files.',
      });
    }
    const { contentBase64: _c, ...meta } = prior; void _c;
    return meta;
  };
  /** Where a receipt's files may be read from: the receipt's own place, else the place its files name. */
  const placeOf = async (ctx: RequestContext, grnId: string): Promise<string | undefined> =>
    (await deps.grn(ctx.tenantId, grnId))?.warehouseId ?? (await deps.attachments(ctx.tenantId, grnId))[0]?.warehouseId;

  return [
    {
      // A file taken at the store and carried by the store computer. Body: `GoodsReceiptAttachmentCaptured`'s payload.
      api: 'API-04', method: 'POST', path: '/v1/inventory/goods-receipt/:grnId/attachments/:attachmentId/synced',
      permission: 'inventory.receipt.sync', idempotent: true,
      handler: async (ctx) => {
        const grnId = (ctx.params['grnId'] ?? '').trim();
        const attachmentId = (ctx.params['attachmentId'] ?? '').trim();
        const b = ctx.body;
        const bad = (why: string) => apiError(400, {
          code: 'not_readable_as_a_receipt_attachment',
          whatHappened: `This could not be kept as a file with a goods receipt: ${why}.`,
          wasItSaved: 'not_saved',
          nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it — it is the evidence of what arrived.',
        });
        if (!isObj(b) || !ID.test(grnId) || !ID.test(attachmentId) || b['grnId'] !== grnId || b['attachmentId'] !== attachmentId) throw bad('the receipt and the file id must match the path');
        if (!isReceiptAttachmentKind(b['kind'])) throw bad('the kind must be delivery_note, supplier_challan or damage_photo');
        if (!isStr(b['warehouseId']) || !isStr(b['attachedBy']) || !isIso(b['attachedAt']) || !isStr(b['sha256']) || !/^[0-9a-f]{64}$/.test(b['sha256'])) throw bad('it needs warehouseId, attachedBy, attachedAt and the file\'s sha256');
        const read = fileFromBase64(b['fileName'], b['mediaType'], b['contentBase64']);
        if (!read.ok) throw bad(read.detail);
        if (read.file.sha256 !== b['sha256']) throw bad('the SHA-256 sent is not the file\'s own — the file changed on the way');
        await assertLocationInScope(ctx, b['warehouseId'], deps.locationBranches); // the store computer speaks for its own store only
        const prior = await already(ctx.tenantId, attachmentId, read.file.sha256, grnId);
        if (prior !== undefined) return { status: 200, body: { attachment: prior, alreadyRecorded: true } };
        const now = deps.now();
        const source = b['source'] === 'warehouse-handheld' ? 'warehouse-handheld' as const : 'manager-screen' as const;
        const rec: StoredReceiptAttachment = {
          attachmentId, grnId, receiptNumber: isStr(b['receiptNumber']) ? b['receiptNumber'].trim() : grnId, warehouseId: b['warehouseId'],
          storeId: isStr(b['storeId']) ? b['storeId'] : null, kind: b['kind'],
          ...(b['kind'] === 'damage_photo' && isStr(b['productId']) ? { productId: b['productId'].trim() } : {}),
          fileName: read.file.fileName, mediaType: read.file.mediaType, bytes: read.file.bytes, sha256: read.file.sha256,
          attachedBy: b['attachedBy'], attachedAt: b['attachedAt'], source, relayedBy: ctx.userId, receivedAt: now,
          flags: await flagsFor(ctx.tenantId, b['attachedBy']),
        };
        await deps.recordAttachment(ctx.tenantId, rec, read.file.contentBase64);
        await audit(ctx, rec.attachedBy, 'goods_receipt.attachment.keep', grnId, {
          attachmentId, kind: rec.kind, fileName: rec.fileName, sha256: rec.sha256, bytes: String(rec.bytes), source, relayedBy: ctx.userId, flags: rec.flags.join(','),
        });
        return { status: 201, body: { attachment: rec } };
      },
    },
    {
      // A file added at head office on Goods receipt review. Body: { kind, productId?, fileName, mediaType, contentBase64 }.
      api: 'API-04', method: 'POST', path: '/v1/inventory/goods-receipt/:grnId/attachments/:attachmentId',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const grnId = (ctx.params['grnId'] ?? '').trim();
        const attachmentId = (ctx.params['attachmentId'] ?? '').trim();
        const b = isObj(ctx.body) ? ctx.body : {};
        const refuse = (code: string, why: string) => apiError(400, { code, whatHappened: why, wasItSaved: 'not_saved', nextSafeAction: 'Choose a JPEG or PNG photo, or a PDF scan, of at most 150 KB, and say what it is. Nothing was kept.' });
        if (!ID.test(grnId) || !ID.test(attachmentId)) throw refuse('not_readable_as_a_receipt_attachment', 'The receipt and the file need ids.');
        if (!isReceiptAttachmentKind(b['kind'])) throw refuse('attachment_kind_not_known', 'Say what the file is: the delivery note, the supplier\'s challan or a damage photo.');
        const grn = await deps.grn(ctx.tenantId, grnId);
        if (grn === undefined) throw notFound(`goods receipt ${grnId}`);
        await assertLocationInScope(ctx, grn.warehouseId, deps.locationBranches);
        const read = fileFromBase64(b['fileName'], b['mediaType'], b['contentBase64']);
        if (!read.ok) throw refuse(`attachment_${read.code}`, `The file was not kept: ${read.detail}.`);
        const prior = await already(ctx.tenantId, attachmentId, read.file.sha256, grnId);
        if (prior !== undefined) return { status: 200, body: { attachment: prior, alreadyRecorded: true } };
        const now = deps.now();
        const rec: StoredReceiptAttachment = {
          attachmentId, grnId, receiptNumber: grn.number, warehouseId: grn.warehouseId, storeId: null, kind: b['kind'],
          ...(b['kind'] === 'damage_photo' && isStr(b['productId']) ? { productId: b['productId'].trim() } : {}),
          fileName: read.file.fileName, mediaType: read.file.mediaType, bytes: read.file.bytes, sha256: read.file.sha256,
          attachedBy: ctx.userId, attachedAt: now, source: 'head-office', relayedBy: null, receivedAt: now, flags: [],
        };
        await deps.recordAttachment(ctx.tenantId, rec, read.file.contentBase64);
        await audit(ctx, ctx.userId, 'goods_receipt.attachment.keep', grnId, { attachmentId, kind: rec.kind, fileName: rec.fileName, sha256: rec.sha256, bytes: String(rec.bytes), source: 'head-office' });
        return { status: 201, body: { attachment: rec } };
      },
    },
    {
      // The receipt's files (no bytes), oldest first, each with its "attached by mistake" mark when it has one.
      api: 'API-04', method: 'GET', path: '/v1/inventory/goods-receipt/:grnId/attachments',
      permission: 'inventory.goodsreceipt.read',
      handler: async (ctx) => {
        const grnId = (ctx.params['grnId'] ?? '').trim();
        const place = await placeOf(ctx, grnId);
        if (place !== undefined) await assertLocationInScope(ctx, place, deps.locationBranches);
        const list = await deps.attachments(ctx.tenantId, grnId);
        const mistakes = await deps.mistakes(ctx.tenantId, grnId);
        const byId = new Map(mistakes.map((m) => [m.attachmentId, m] as const));
        const attachments: ListedAttachment[] = list.map((a) => { const m = byId.get(a.attachmentId); return m === undefined ? a : { ...a, mistake: m }; });
        return { status: 200, body: { grnId, attachments, ...attachmentTally(list, mistakes), asAt: deps.now() } };
      },
    },
    {
      // One file with its bytes, to see it on the screen or open it.
      api: 'API-04', method: 'GET', path: '/v1/inventory/goods-receipt/:grnId/attachments/:attachmentId',
      permission: 'inventory.goodsreceipt.read',
      handler: async (ctx) => {
        const grnId = (ctx.params['grnId'] ?? '').trim();
        const held = await deps.attachment(ctx.tenantId, (ctx.params['attachmentId'] ?? '').trim());
        if (held === undefined || held.grnId !== grnId) throw notFound(`a file on goods receipt ${grnId}`);
        await assertLocationInScope(ctx, held.warehouseId, deps.locationBranches);
        return { status: 200, body: { attachment: held } };
      },
    },
    {
      // "Attached by mistake" — the file stays kept and shown; this says it is not this delivery's evidence, and why.
      api: 'API-04', method: 'POST', path: '/v1/inventory/goods-receipt/:grnId/attachments/:attachmentId/mistake',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const grnId = (ctx.params['grnId'] ?? '').trim();
        const attachmentId = (ctx.params['attachmentId'] ?? '').trim();
        const held = await deps.attachment(ctx.tenantId, attachmentId);
        if (held === undefined || held.grnId !== grnId) throw notFound(`a file on goods receipt ${grnId}`);
        await assertLocationInScope(ctx, held.warehouseId, deps.locationBranches);
        const reason = isObj(ctx.body) && typeof ctx.body['reason'] === 'string' ? ctx.body['reason'].trim() : '';
        if (reason.length < MIN_MISTAKE_REASON) {
          throw apiError(400, { code: 'mistake_needs_a_reason', whatHappened: 'Say why this file was attached by mistake (at least a few words).', wasItSaved: 'not_saved', nextSafeAction: 'Type the reason, then press "Attached by mistake" again. The file is unchanged.' });
        }
        const prior = (await deps.mistakes(ctx.tenantId, grnId)).find((m) => m.attachmentId === attachmentId);
        if (prior !== undefined) return { status: 200, body: { mistake: prior, alreadyMarked: true } };
        const mistake: ReceiptAttachmentMistake = { attachmentId, grnId, reason, markedBy: ctx.userId, markedAt: deps.now() };
        await deps.recordMistake(ctx.tenantId, mistake);
        await audit(ctx, ctx.userId, 'goods_receipt.attachment.mistake', grnId, { attachmentId, fileName: held.fileName, sha256: held.sha256, kept: 'true' }, reason);
        return { status: 201, body: { mistake } };
      },
    },
  ];
}
