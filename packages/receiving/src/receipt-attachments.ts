// Batch 20e · R6 — EVIDENCE ATTACHED TO A GOODS RECEIPT (M07-FR-04 "evidence attachments" · WF-04 · P-01 · P-08 · hard
// rule #6 · ADR 0010 · OB-904 – OB-907, decided under OB-801).
//
// A photo of the delivery note, the supplier's challan, or a damaged carton, kept WITH the goods receipt it belongs to (and,
// for damage, with the line). This is the ONE shape of such a file wherever it is taken — Receive on the store computer, the
// warehouse handheld at the door, and Goods receipt review at head office:
//
//   • what may be attached: a JPEG or PNG photo, or a PDF scan — judged from the file's OWN first bytes, never its name;
//   • how big: at most `MAX_RECEIPT_ATTACHMENT_BYTES` (150 KB). A photo is shrunk on the phone or the store computer before it
//     is kept (`shrinkPhoto`), so a cheap Android phone sends a small file over shop wifi; a PDF cannot be shrunk and a larger
//     one is refused in words ("take a photo of the paper instead");
//   • the record a device queues (`GoodsReceiptAttachmentCaptured`) — the bytes, their SHA-256, who attached it and when —
//     carried by the store computer to head office like every other piece of device work (device queue → store computer's
//     disk → head office, idempotent on the attachment's own key). The receipt never waits for it: the two travel apart;
//   • `ReceiptAttachmentQueue` — the device side: its OWN queue (never the receipts' queue, so a full device can never stop a
//     delivery being saved), the five words for where each file is, and — once the store computer holds a file on its disk —
//     the file's bytes dropped from the device's own storage (`contentDroppedOnceHanded`), so photos never fill a phone.
//
// Nothing here deletes or overwrites: a file attached by mistake is MARKED so at head office, with a reason, and kept.
// Pure and deterministic (the clock is injected); tested in tests/unit/b20e-receipt-attachments.test.ts.

import { makeEvent, type DomainEvent } from '../../contracts/src/event';
import { sha256Hex, bytesOfBase64 } from '../../fulfilment/src/sha256';
import type { DeviceStore } from '../../sync/src/device-outbox';
import type { SyncOutbox } from '../../sync/src/outbox';
import { deviceItemState, deviceItemReason, type BoxItemStatus, type DeviceItemState } from '../../sync/src/device-relay';

/** The device record's type — one per file, relayed by the store computer to head office's synced route. */
export const GOODS_RECEIPT_ATTACHMENT_CAPTURED = 'GoodsReceiptAttachmentCaptured';

/** What a file is (OB-905): the delivery note, the supplier's challan, or a photo of damage (with the line it is about). */
export const RECEIPT_ATTACHMENT_KINDS = Object.freeze(['delivery_note', 'supplier_challan', 'damage_photo'] as const);
export type ReceiptAttachmentKind = (typeof RECEIPT_ATTACHMENT_KINDS)[number];
export const isReceiptAttachmentKind = (v: unknown): v is ReceiptAttachmentKind => typeof v === 'string' && (RECEIPT_ATTACHMENT_KINDS as readonly string[]).includes(v);

/** The file types kept (OB-904): a photo (JPEG or PNG) or a PDF scan. Never anything that can carry a script. */
export const RECEIPT_ATTACHMENT_TYPES = Object.freeze(['image/jpeg', 'image/png', 'application/pdf'] as const);
export type ReceiptAttachmentType = (typeof RECEIPT_ATTACHMENT_TYPES)[number];

/**
 * The largest file kept (OB-904): 150 KB. A photo shrunk for reading a challan is well under it; it keeps one file, base64
 * in its own record, inside the store computer's 256 KB device batch, and keeps a phone's storage free.
 */
export const MAX_RECEIPT_ATTACHMENT_BYTES = 153_600;
/** The same cap as base64 characters (what travels). */
export const MAX_RECEIPT_ATTACHMENT_BASE64 = Math.ceil(MAX_RECEIPT_ATTACHMENT_BYTES / 3) * 4;
/** At most this many files on one delivery from one device (OB-904) — a delivery's evidence, not an album. */
export const MAX_ATTACHMENTS_PER_RECEIPT = 10;
/** A photo is shrunk so its longest side is at most this many pixels before it is kept (OB-904). */
export const PHOTO_LONGEST_SIDE = 1600;
/** A reason for "attached by mistake" must say something (at least this many letters). */
export const MIN_MISTAKE_REASON = 5;

/** What the file's own first bytes say it is (never its name or the type it was sent as). */
export function sniffAttachmentType(bytes: Uint8Array): ReceiptAttachmentType | undefined {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return 'application/pdf'; // %PDF-
  return undefined;
}

export type AttachmentRefusalCode = 'file_empty' | 'file_type_not_allowed' | 'file_too_large' | 'not_base64' | 'checksum_mismatch'
  | 'kind_not_known' | 'too_many_files' | 'no_receipt' | 'nobody_named';

export type AttachmentCheck =
  | { readonly ok: true; readonly mediaType: ReceiptAttachmentType; readonly bytes: number }
  | { readonly ok: false; readonly code: AttachmentRefusalCode; readonly detail: string };

/** Judge a file's bytes against what it was sent as: the type from the file itself, and its size. */
export function checkReceiptAttachment(declaredType: unknown, bytes: Uint8Array): AttachmentCheck {
  if (bytes.length === 0) return { ok: false, code: 'file_empty', detail: 'the file is empty' };
  const sniffed = sniffAttachmentType(bytes);
  if (sniffed === undefined || typeof declaredType !== 'string' || declaredType !== sniffed) {
    return { ok: false, code: 'file_type_not_allowed', detail: `only a JPEG or PNG photo or a PDF scan is kept${sniffed !== undefined && declaredType !== sniffed ? ` (the file is ${sniffed}, but was sent as ${String(declaredType)})` : ''}` };
  }
  if (bytes.length > MAX_RECEIPT_ATTACHMENT_BYTES) {
    return { ok: false, code: 'file_too_large', detail: `the file is ${Math.ceil(bytes.length / 1024)} KB; at most ${MAX_RECEIPT_ATTACHMENT_BYTES / 1024} KB is kept` };
  }
  return { ok: true, mediaType: sniffed, bytes: bytes.length };
}

/** The file as it travels and is kept: the bytes as base64 with their fingerprint. */
export interface ReceiptAttachmentFile {
  readonly fileName: string;
  readonly mediaType: ReceiptAttachmentType;
  readonly bytes: number;
  readonly sha256: string;
  readonly contentBase64: string;
}

/** The record a device queues for one file (`GoodsReceiptAttachmentCaptured`'s payload). */
export interface CapturedReceiptAttachment extends ReceiptAttachmentFile {
  readonly attachmentId: string;
  /** The goods receipt it belongs to — the same id the receipt itself travels under. */
  readonly grnId: string;
  /** The delivery note number / receipt number a person reads. */
  readonly receiptNumber: string;
  /** Where the goods were booked in (head office checks the store computer speaks for that place). */
  readonly warehouseId: string;
  readonly storeId: string | null;
  readonly kind: ReceiptAttachmentKind;
  /** The receipt line (by item) a damage photo is about; absent = the whole delivery. */
  readonly productId?: string;
  readonly attachedBy: string;
  readonly attachedAt: string;
  readonly source: 'manager-screen' | 'warehouse-handheld';
}

/** One idempotency key per file at every hop: the device, the store computer and head office dedupe on it. */
export const attachmentKeyFor = (attachmentId: string): string => `receipt-attachment-${attachmentId}`;

/** A file name a person can read, without a path and never longer than 80 characters. */
export function plainFileName(name: unknown, mediaType: ReceiptAttachmentType): string {
  const raw = typeof name === 'string' ? name.split(/[\\/]/).pop() ?? '' : '';
  const kept = raw.replace(/[^\p{L}\p{N} ._()-]/gu, '').trim().slice(0, 80);
  return kept !== '' ? kept : `file.${mediaType === 'application/pdf' ? 'pdf' : mediaType === 'image/png' ? 'png' : 'jpg'}`;
}

/** Build the file from base64 the page read: checked and fingerprinted, or refused in words. */
export function fileFromBase64(fileName: unknown, declaredType: unknown, contentBase64: unknown): { readonly ok: true; readonly file: ReceiptAttachmentFile } | { readonly ok: false; readonly code: AttachmentRefusalCode; readonly detail: string } {
  if (typeof contentBase64 !== 'string') return { ok: false, code: 'not_base64', detail: 'the file could not be read' };
  if (contentBase64.length > MAX_RECEIPT_ATTACHMENT_BASE64) return { ok: false, code: 'file_too_large', detail: `the file is larger than ${MAX_RECEIPT_ATTACHMENT_BYTES / 1024} KB` };
  const bytes = bytesOfBase64(contentBase64);
  if (bytes === undefined) return { ok: false, code: 'not_base64', detail: 'the file could not be read' };
  const checked = checkReceiptAttachment(declaredType, bytes);
  if (!checked.ok) return checked;
  return { ok: true, file: { fileName: plainFileName(fileName, checked.mediaType), mediaType: checked.mediaType, bytes: checked.bytes, sha256: sha256Hex(bytes), contentBase64 } };
}

/** The device record for one file. */
export function attachmentEvent(a: CapturedReceiptAttachment): DomainEvent<typeof GOODS_RECEIPT_ATTACHMENT_CAPTURED, CapturedReceiptAttachment> {
  return makeEvent({
    id: `receipt-attachment-${a.attachmentId}`, type: GOODS_RECEIPT_ATTACHMENT_CAPTURED, occurredAt: a.attachedAt,
    idempotencyKey: attachmentKeyFor(a.attachmentId), source: a.source, payload: a,
  });
}

// ── Shrinking a photo before it is kept (OB-904) ───────────────────────────────────────────────────────────────────────

/** Draws the photo at a longest side and JPEG quality, and answers the encoded bytes (the page supplies a canvas). */
export type PhotoEncoder = (longestSide: number, quality: number) => Promise<Uint8Array>;

const QUALITIES = [0.82, 0.7, 0.6, 0.5, 0.42] as const;

/**
 * The smallest work that fits: at the photo's own size (never enlarged) up to `PHOTO_LONGEST_SIDE`, stepping the JPEG quality
 * down, then the size down by a quarter, until the file is at most `MAX_RECEIPT_ATTACHMENT_BYTES`. `undefined` when even a
 * small, rough copy does not fit (it never does in practice; the page then says the photo could not be made small enough).
 */
export async function shrinkPhoto(encode: PhotoEncoder, originalLongestSide: number): Promise<Uint8Array | undefined> {
  let side = Math.min(PHOTO_LONGEST_SIDE, Math.max(1, Math.round(originalLongestSide)));
  for (let round = 0; round < 6 && side >= 320; round += 1) {
    for (const q of QUALITIES) {
      const out = await encode(side, q);
      if (out.length > 0 && out.length <= MAX_RECEIPT_ATTACHMENT_BYTES) return out;
    }
    side = Math.round(side * 0.75);
  }
  return undefined;
}

// ── The device side ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The device's storage for the attachment queue: once the store computer has taken a file (`acknowledged` — it is on the
 * store computer's own disk, fsync'd), its bytes are not kept on the device any more — only who, what and where it has got
 * to. A file still waiting, or one the store computer REFUSED, keeps its bytes (a refusal is evidence a person must see).
 */
export function contentDroppedOnceHanded(store: DeviceStore): DeviceStore {
  return {
    read: () => store.read(),
    write: (value) => {
      let items: unknown;
      try { items = JSON.parse(value); } catch { store.write(value); return; }
      if (!Array.isArray(items)) { store.write(value); return; }
      const slim = items.map((i) => {
        const item = i as { state?: unknown; event?: { payload?: Record<string, unknown> } };
        if (item.state !== 'acknowledged' || item.event?.payload === undefined || !('contentBase64' in item.event.payload)) return i;
        const { contentBase64: _dropped, ...payload } = item.event.payload; void _dropped;
        return { ...item, event: { ...item.event, payload: { ...payload, contentKeptOnStoreComputer: true } } };
      });
      store.write(JSON.stringify(slim));
    },
  };
}

/** One file as the device lists it: what, for which delivery, and where it has got to (the five words). */
export interface QueuedAttachment {
  readonly attachmentId: string;
  readonly grnId: string;
  readonly receiptNumber: string;
  readonly kind: ReceiptAttachmentKind;
  readonly productId?: string;
  readonly fileName: string;
  readonly bytes: number;
  readonly attachedAt: string;
  readonly state: DeviceItemState;
  readonly attempts: number;
  readonly reason?: string;
}

export interface AttachmentInput {
  readonly attachmentId: string;
  readonly grnId: string;
  readonly receiptNumber: string;
  readonly warehouseId: string;
  readonly storeId?: string | null;
  readonly kind: unknown;
  readonly productId?: string;
  readonly fileName: unknown;
  readonly mediaType: unknown;
  readonly contentBase64: unknown;
  /** Who attached it — the person signed in on this device; null = nobody, refused. */
  readonly attachedBy: string | null;
}

export type AttachmentAdded =
  | { readonly added: true; readonly attachment: QueuedAttachment }
  | { readonly added: false; readonly code: AttachmentRefusalCode; readonly detail: string };

/**
 * The device's own queue of attachment files (on the store computer's Receive screen, or the warehouse handheld). Its own
 * outbox: a file that cannot be kept on the device never touches the receipt that was saved.
 */
export class ReceiptAttachmentQueue {
  private readonly box = new Map<string, BoxItemStatus>();

  constructor(
    private readonly outbox: SyncOutbox,
    private readonly opts: { readonly now: () => string; readonly source: CapturedReceiptAttachment['source'] },
  ) {}

  /** Keep one file with a delivery. It is checked here, offline, so a wrong file is refused before anything is queued. */
  add(input: AttachmentInput): AttachmentAdded {
    if (input.attachedBy === null || input.attachedBy.trim() === '') return { added: false, code: 'nobody_named', detail: 'nobody is signed in on this screen, so nobody can attach a file' };
    if (input.grnId.trim() === '') return { added: false, code: 'no_receipt', detail: 'save or choose the delivery first' };
    if (!isReceiptAttachmentKind(input.kind)) return { added: false, code: 'kind_not_known', detail: 'say what the file is: the delivery note, the supplier\'s challan or a damage photo' };
    if (this.list().filter((a) => a.grnId === input.grnId).length >= MAX_ATTACHMENTS_PER_RECEIPT) {
      return { added: false, code: 'too_many_files', detail: `at most ${MAX_ATTACHMENTS_PER_RECEIPT} files go with one delivery` };
    }
    const read = fileFromBase64(input.fileName, input.mediaType, input.contentBase64);
    if (!read.ok) return { added: false, code: read.code, detail: read.detail };
    const record: CapturedReceiptAttachment = {
      ...read.file, attachmentId: input.attachmentId, grnId: input.grnId, receiptNumber: input.receiptNumber, warehouseId: input.warehouseId,
      storeId: input.storeId ?? null, kind: input.kind,
      ...(input.kind === 'damage_photo' && input.productId !== undefined && input.productId.trim() !== '' ? { productId: input.productId.trim() } : {}),
      attachedBy: input.attachedBy, attachedAt: this.opts.now(), source: this.opts.source,
    };
    this.outbox.enqueue(attachmentEvent(record));
    const listed = this.list().find((a) => a.attachmentId === record.attachmentId)!;
    return { added: true, attachment: listed };
  }

  /** Every file this device kept, newest first, with where it has got to. */
  list(): readonly QueuedAttachment[] {
    return this.outbox.all()
      .filter((i) => i.event.type === GOODS_RECEIPT_ATTACHMENT_CAPTURED)
      .map((i) => {
        const p = i.event.payload as CapturedReceiptAttachment;
        const status = this.box.get(i.key);
        const reason = deviceItemReason(i, status);
        return {
          attachmentId: p.attachmentId, grnId: p.grnId, receiptNumber: p.receiptNumber, kind: p.kind, ...(p.productId === undefined ? {} : { productId: p.productId }),
          fileName: p.fileName, bytes: p.bytes, attachedAt: p.attachedAt, state: deviceItemState(i, status), attempts: i.attempts, ...(reason === undefined ? {} : { reason }),
        };
      })
      .reverse();
  }

  /** The files of one delivery. */
  of(grnId: string): readonly QueuedAttachment[] {
    return this.list().filter((a) => a.grnId === grnId);
  }

  /** How many are not yet at head office (P-08: said on the screen). */
  waiting(): number {
    return this.list().filter((a) => a.state !== 'posted').length;
  }

  /** The keys the store computer has taken and not yet said are at head office (the latest 50), to ask where they have got to. */
  handedKeys(): readonly string[] {
    return this.outbox.all()
      .filter((i) => i.event.type === GOODS_RECEIPT_ATTACHMENT_CAPTURED && i.state === 'acknowledged' && this.box.get(i.key)?.state !== 'posted')
      .map((i) => i.key).slice(-50);
  }

  /** Fold in the store computer's word on files it took (posted · still pending · refused). */
  noteBoxStatus(statuses: readonly BoxItemStatus[]): void {
    for (const s of statuses) this.box.set(s.key, s);
  }
}
