// Batch 20e · R6 (M07-FR-04 · ADR 0010 · hard rules #2, #6) — head-office wiring for the photos and scans kept with a goods
// receipt. Every fact is an append-only event on its own stream: the file's bytes on one stream per file, its record on the
// tenant's attachment register (what lists and counts read, never the bytes), and "attached by mistake" on its own register.
// Nothing is ever removed or replaced.

import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import {
  attachmentTally, type ReceiptAttachmentsDeps, type StoredReceiptAttachment, type ReceiptAttachmentMistake,
} from '../../inventory/src/goods-receipt-attachments';
import { STREAM, streamName, allOf, goodsReceiptAdapter, permissionsHeldBy } from './adapters';

/** The tenant's register of kept files (records only). */
export const RECEIPT_ATTACHMENTS_STREAM = streamName(STREAM.inventory, 'receipt-attachments');
/** One file's bytes. */
export const receiptAttachmentFileStream = (attachmentId: string): string => streamName(STREAM.inventory, 'receipt-attachment', attachmentId);
/** The "attached by mistake" register. */
export const RECEIPT_ATTACHMENT_MISTAKES_STREAM = streamName(STREAM.inventory, 'receipt-attachment-mistakes');

const KEPT = 'ReceiptAttachmentKept';
const FILE_KEPT = 'ReceiptAttachmentFileKept';
const MARKED = 'ReceiptAttachmentMarkedMistake';

/** Every kept file's record on the tenant (oldest first). */
export const receiptAttachmentsOf = (store: EventStore, tenantId: string): Promise<readonly StoredReceiptAttachment[]> =>
  allOf<StoredReceiptAttachment>(store, tenantId, RECEIPT_ATTACHMENTS_STREAM, KEPT);
export const receiptAttachmentMistakesOf = (store: EventStore, tenantId: string): Promise<readonly ReceiptAttachmentMistake[]> =>
  allOf<ReceiptAttachmentMistake>(store, tenantId, RECEIPT_ATTACHMENT_MISTAKES_STREAM, MARKED);

/** Each receipt's kept and marked-by-mistake counts, read once (the GRN list and the printed GRN). */
export async function receiptAttachmentCounts(store: EventStore, tenantId: string): Promise<ReadonlyMap<string, { readonly kept: number; readonly mistaken: number }>> {
  const [all, mistakes] = await Promise.all([receiptAttachmentsOf(store, tenantId), receiptAttachmentMistakesOf(store, tenantId)]);
  const out = new Map<string, { kept: number; mistaken: number }>();
  for (const grnId of new Set(all.map((a) => a.grnId))) {
    out.set(grnId, attachmentTally(all.filter((a) => a.grnId === grnId), mistakes.filter((m) => m.grnId === grnId)));
  }
  return out;
}

export function receiptAttachmentsAdapter(input: { readonly store: EventStore; readonly now: () => string }): Omit<ReceiptAttachmentsDeps, 'recordAudit' | 'locationBranches'> {
  const { store, now } = input;
  const grns = goodsReceiptAdapter({ store, now });
  return {
    now,
    grn: async (tenantId, grnId) => {
      const g = await grns.grn(tenantId, grnId);
      return g === undefined ? undefined : { warehouseId: g.warehouseId, number: g.documentNumber ?? g.number };
    },
    attachments: async (tenantId, grnId) => (await receiptAttachmentsOf(store, tenantId)).filter((a) => a.grnId === grnId),
    attachment: async (tenantId, attachmentId) =>
      (await allOf<StoredReceiptAttachment & { contentBase64: string }>(store, tenantId, receiptAttachmentFileStream(attachmentId), FILE_KEPT))[0],
    recordAttachment: async (tenantId, a, contentBase64) => {
      await store.appendBatch(tenantId, [
        { stream: receiptAttachmentFileStream(a.attachmentId), event: makeEvent({ id: `receipt-attachment-file-${a.attachmentId}`, type: FILE_KEPT, occurredAt: a.receivedAt, idempotencyKey: `receipt-attachment-file-${tenantId}-${a.attachmentId}`, source: 'api/inventory', payload: { ...a, contentBase64 } }) },
        { stream: RECEIPT_ATTACHMENTS_STREAM, event: makeEvent({ id: `receipt-attachment-${a.attachmentId}`, type: KEPT, occurredAt: a.receivedAt, idempotencyKey: `receipt-attachment-${tenantId}-${a.attachmentId}`, source: 'api/inventory', payload: a }) },
      ]);
    },
    mistakes: async (tenantId, grnId) => (await receiptAttachmentMistakesOf(store, tenantId)).filter((m) => m.grnId === grnId),
    recordMistake: async (tenantId, m) => {
      await store.append(tenantId, RECEIPT_ATTACHMENT_MISTAKES_STREAM, makeEvent({
        id: `receipt-attachment-mistake-${m.attachmentId}`, type: MARKED, occurredAt: m.markedAt,
        idempotencyKey: `receipt-attachment-mistake-${tenantId}-${m.attachmentId}`, source: 'api/inventory', payload: m,
      }));
    },
    permissionsOfUser: (tenantId, userId) => permissionsHeldBy(store, tenantId, userId),
  };
}
