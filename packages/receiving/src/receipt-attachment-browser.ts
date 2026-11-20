// Batch 20e · R6 (M07-FR-04 · OB-904) — reading a file a person picked (or a photo the phone's camera just took) in the
// browser, shrunk and ready to keep with a goods receipt. Shared by Receive on the store computer, the warehouse handheld and
// Goods receipt review, so all three keep the same kind of file.
//
//   • A photo (JPEG or PNG, or whatever the phone's camera gives) is DRAWN AGAIN as a JPEG no bigger than
//     `PHOTO_LONGEST_SIDE` and at most `MAX_RECEIPT_ATTACHMENT_BYTES` (`shrinkPhoto`). Drawing it again also leaves behind
//     what the camera wrote inside the file (the phone's location among it) — only the picture is kept.
//   • A PDF scan is kept as it is when it fits; a larger one is refused in words (a PDF cannot be shrunk here).
//   • Anything else is refused in words. Nothing is sent anywhere by this module: it answers the file, and the caller keeps it.
//
// The browser's own pieces (FileReader-free `arrayBuffer`, `createImageBitmap`, a canvas) are reached through `globalThis`, so
// this bundles for every app without the DOM types. The size rule is the tested, pure `shrinkPhoto`.

import { MAX_RECEIPT_ATTACHMENT_BYTES, shrinkPhoto, plainFileName } from './receipt-attachments';

/** The parts of a picked `File` this needs. */
export interface PickedFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type ReadPicked =
  | { readonly ok: true; readonly fileName: string; readonly mediaType: 'image/jpeg' | 'application/pdf'; readonly contentBase64: string; readonly bytes: number }
  | { readonly ok: false; readonly code: 'file_type_not_allowed' | 'file_too_large' | 'could_not_shrink' | 'could_not_read' };

/** Bytes → standard base64, in chunks (a 150 KB file must not overflow the argument list). */
export function base64Of(bytes: Uint8Array): string {
  const btoaFn = (globalThis as { btoa?: (s: string) => string }).btoa;
  if (btoaFn === undefined) return '';
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoaFn(text);
}

interface Bitmap { readonly width: number; readonly height: number; close?(): void }
interface Canvas2d { drawImage(img: Bitmap, x: number, y: number, w: number, h: number): void }
interface CanvasLike {
  width: number; height: number;
  getContext(kind: '2d'): Canvas2d | null;
  toBlob(cb: (b: { arrayBuffer(): Promise<ArrayBuffer> } | null) => void, type: string, quality: number): void;
}

/** Read a picked file into one that may be kept with a receipt (see the header). */
export async function readPickedFile(file: PickedFile): Promise<ReadPicked> {
  const type = (file.type || '').toLowerCase();
  if (type === 'application/pdf') {
    if (file.size > MAX_RECEIPT_ATTACHMENT_BYTES) return { ok: false, code: 'file_too_large' };
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return { ok: true, fileName: plainFileName(file.name, 'application/pdf'), mediaType: 'application/pdf', contentBase64: base64Of(bytes), bytes: bytes.length };
    } catch { return { ok: false, code: 'could_not_read' }; }
  }
  if (!type.startsWith('image/')) return { ok: false, code: 'file_type_not_allowed' };
  const g = globalThis as { createImageBitmap?: (b: unknown) => Promise<Bitmap>; document?: { createElement(tag: 'canvas'): CanvasLike } };
  if (g.createImageBitmap === undefined || g.document === undefined) return { ok: false, code: 'could_not_read' };
  let bitmap: Bitmap;
  try { bitmap = await g.createImageBitmap(file); } catch { return { ok: false, code: 'file_type_not_allowed' }; }
  const canvas = g.document.createElement('canvas');
  const longest = Math.max(bitmap.width, bitmap.height);
  const encode = async (side: number, quality: number): Promise<Uint8Array> => {
    const scale = Math.min(1, side / longest);
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    return blob === null ? new Uint8Array() : new Uint8Array(await blob.arrayBuffer());
  };
  const out = await shrinkPhoto(encode, longest);
  bitmap.close?.();
  if (out === undefined) return { ok: false, code: 'could_not_shrink' };
  const base = plainFileName(file.name, 'image/jpeg').replace(/\.(png|jpe?g|heic|heif|webp|gif|bmp)$/i, '');
  return { ok: true, fileName: `${base}.jpg`, mediaType: 'image/jpeg', contentBase64: base64Of(out), bytes: out.length };
}

/** A fresh id for a file, unique on this device (the time and a random part). */
export function newAttachmentId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const random = c?.randomUUID?.().replace(/-/g, '').slice(0, 16) ?? Math.random().toString(36).slice(2, 14);
  return `ra-${Date.now().toString(36)}-${random}`;
}
