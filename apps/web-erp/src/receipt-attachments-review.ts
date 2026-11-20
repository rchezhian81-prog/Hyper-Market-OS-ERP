// Batch 20e · R6 (M07-FR-04 · WF-04 · OB-907) — the photos and scans of a delivery on Goods receipt review. DOM-free: the
// page draws what this hands over. Online reads and writes under the reader's own session (head office's record; with no
// connection the page says so and nothing is queued or pretended — P-08):
//
//   files(grnId)                 the receipt's files (no bytes) — each with who attached it, from where, and any mistake mark
//   open(grnId, attachmentId)    one file's bytes, as a `data:` address the page shows (a thumbnail) or opens
//   add(grnId, file, kind)       keep a file a person picked at head office (`inventory.movement.append`)
//   markMistake(...)             "attached by mistake" with a reason — the file stays kept and shown (hard rule #6)

import { makeCaller, type Outcome } from './r4-insight-call';
import { newAttachmentId } from '../../../packages/receiving/src/receipt-attachment-browser';
import { MIN_MISTAKE_REASON, isReceiptAttachmentKind, type ReceiptAttachmentKind } from '../../../packages/receiving/src/receipt-attachments';
import { attachmentWord, type AttachmentLang } from '../../../packages/receiving/src/receipt-attachment-words';

/** One file as head office lists it. */
export interface ReviewedAttachment {
  readonly attachmentId: string;
  readonly grnId: string;
  readonly kind: ReceiptAttachmentKind;
  readonly productId?: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly attachedBy: string;
  readonly attachedAt: string;
  readonly source: string;
  readonly flags?: readonly string[];
  readonly mistake?: { readonly reason: string; readonly markedBy: string; readonly markedAt: string };
}

export type AttachmentWhy = 'nobody' | 'mayNotChange' | 'needReason' | 'kind_not_known';

export interface ReceiptAttachmentsReview {
  /** May this reader add a file or mark one attached by mistake (they hold `inventory.movement.append`)? */
  readonly mayChange: boolean;
  files(grnId: string): Promise<Outcome<readonly ReviewedAttachment[], never>>;
  open(grnId: string, attachmentId: string): Promise<Outcome<string, never>>;
  add(grnId: string, file: { readonly fileName: string; readonly mediaType: string; readonly contentBase64: string }, kind: string, productId?: string): Promise<Outcome<{ readonly alreadyRecorded: boolean }, AttachmentWhy>>;
  markMistake(grnId: string, attachmentId: string, reason: string): Promise<Outcome<unknown, AttachmentWhy>>;
  /** The line a person reads under a file: what it is, its size, who attached it and from where, and any mistake. */
  describe(lang: AttachmentLang, a: ReviewedAttachment, when: (iso: string) => string, itemName?: (productId: string) => string): { readonly title: string; readonly detail: string; readonly mistake?: string; readonly flags: readonly string[] };
}

const SOURCE_WORD: Readonly<Record<string, 'fromStore' | 'fromHandheld' | 'fromHeadOffice'>> = { 'manager-screen': 'fromStore', 'warehouse-handheld': 'fromHandheld', 'head-office': 'fromHeadOffice' };

export function createReceiptAttachmentsReview(input: {
  readonly viewer: { readonly userId?: string; readonly permissions?: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch;
  readonly newKey?: () => string;
  readonly newId?: () => string;
}): ReceiptAttachmentsReview {
  const named = input.viewer?.userId !== undefined && input.viewer.userId.trim() !== '';
  const mayChange = named && (input.viewer?.permissions ?? []).includes('inventory.movement.append');
  const call = makeCaller({ keyPrefix: 'grn-attachment', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const enc = encodeURIComponent;
  const base = (grnId: string): string => `/v1/inventory/goods-receipt/${enc(grnId)}/attachments`;
  const gate = (): { result: 'invalid'; why: AttachmentWhy } | undefined => (!named ? { result: 'invalid', why: 'nobody' } : !mayChange ? { result: 'invalid', why: 'mayNotChange' } : undefined);
  return {
    mayChange,
    files: async (grnId) => {
      const r = await call<{ attachments?: ReviewedAttachment[] }>('GET', base(grnId));
      return r.result === 'ok' ? { result: 'ok', value: r.value.attachments ?? [] } : r;
    },
    open: async (grnId, attachmentId) => {
      const r = await call<{ attachment?: { mediaType?: string; contentBase64?: string } }>('GET', `${base(grnId)}/${enc(attachmentId)}`);
      if (r.result !== 'ok') return r;
      const a = r.value.attachment;
      return { result: 'ok', value: `data:${a?.mediaType ?? 'application/octet-stream'};base64,${a?.contentBase64 ?? ''}` };
    },
    add: async (grnId, file, kind, productId) => {
      const no = gate(); if (no !== undefined) return no;
      if (!isReceiptAttachmentKind(kind)) return { result: 'invalid', why: 'kind_not_known' };
      const id = (input.newId ?? newAttachmentId)();
      const r = await call<{ alreadyRecorded?: boolean }>('POST', `${base(grnId)}/${enc(id)}`, { kind, ...(productId === undefined || productId === '' ? {} : { productId }), ...file });
      return r.result === 'ok' ? { result: 'ok', value: { alreadyRecorded: r.value.alreadyRecorded === true } } : r;
    },
    markMistake: async (grnId, attachmentId, reason) => {
      const no = gate(); if (no !== undefined) return no;
      if (reason.trim().length < MIN_MISTAKE_REASON) return { result: 'invalid', why: 'needReason' };
      return call('POST', `${base(grnId)}/${enc(attachmentId)}/mistake`, { reason: reason.trim() });
    },
    describe: (lang, a, when, itemName) => {
      const kind = attachmentWord(lang, a.kind);
      const item = a.productId === undefined ? '' : ` · ${attachmentWord(lang, 'forItem', { item: itemName?.(a.productId) ?? a.productId })}`;
      const from = attachmentWord(lang, SOURCE_WORD[a.source] ?? 'fromStore');
      const flags = (a.flags ?? []).map((f) => attachmentWord(lang, f === 'attacher_unknown' ? 'flagUnknown' : 'flagNoAuthority'));
      return {
        title: `${kind}${item} · ${a.fileName}`,
        detail: `${attachmentWord(lang, 'kb', { n: Math.max(1, Math.round(a.bytes / 1024)) })} · ${attachmentWord(lang, 'attachedBy', { who: a.attachedBy, when: when(a.attachedAt) })} · ${from}`,
        ...(a.mistake === undefined ? {} : { mistake: attachmentWord(lang, 'mistakeMarked', { who: a.mistake.markedBy, when: when(a.mistake.markedAt), reason: a.mistake.reason }) }),
        flags,
      };
    },
  };
}
