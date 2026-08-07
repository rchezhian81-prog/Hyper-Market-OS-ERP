// Built-in thermal paper formats and the standard receipt template
// (OC-15 · M31-FR-02 · M36-FR-02).
//
// A retailer does not describe a receipt format to us. The product ships the
// standard thermal roll sizes — 58 mm (2"), 80 mm (3") and 112 mm (4") — and a
// neutral header/footer template; each tenant supplies only its own facts (store
// name, address, GSTIN). That is branding, not a code fork (M36-FR-02).
//
// The renderer already takes a character-column width (`renderText` in
// ./receipt.ts). A PaperFormat just gives those columns a name, so a tenant
// chooses "80 mm (3 inch)" rather than the number 42.

import { renderText, type ReceiptDocument } from './receipt';

/** A named thermal paper format: physical width and the Font-A character columns. */
export interface PaperFormat {
  /** Stable id used in config / branding (e.g. picked in the setup screen). */
  readonly id: string;
  /** Human label shown to the tenant. */
  readonly label: string;
  /** Physical roll width in millimetres. */
  readonly widthMm: number;
  /** Character columns for the renderer (typical Font-A columns for this width). */
  readonly widthChars: number;
}

export const PAPER_58: PaperFormat = { id: 'thermal-58', label: '58 mm (2 inch)', widthMm: 58, widthChars: 32 };
export const PAPER_80: PaperFormat = { id: 'thermal-80', label: '80 mm (3 inch)', widthMm: 80, widthChars: 48 };
export const PAPER_112: PaperFormat = { id: 'thermal-112', label: '112 mm (4 inch)', widthMm: 112, widthChars: 64 };

/** Every built-in thermal format, narrowest first. */
export const PAPER_FORMATS: readonly PaperFormat[] = [PAPER_58, PAPER_80, PAPER_112];

/** 80 mm is the common retail default; a tenant may pick another. */
export const DEFAULT_PAPER_FORMAT: PaperFormat = PAPER_80;

/** The built-in template set id (matches `neutralBranding().templateSetId`). */
export const BUILTIN_TEMPLATE_SET_ID = 'builtin:default';

export class UnknownPaperFormatError extends Error {
  constructor(id: string) {
    super(`Unknown paper format '${id}'. Known: ${PAPER_FORMATS.map((f) => f.id).join(', ')}.`);
    this.name = 'UnknownPaperFormatError';
  }
}

/** Look a format up by id; refuses an unknown id rather than guessing a width. */
export function paperFormat(id: string): PaperFormat {
  const found = PAPER_FORMATS.find((f) => f.id === id);
  if (found === undefined) throw new UnknownPaperFormatError(id);
  return found;
}

/** Render a receipt on a named paper format (defaults to 80 mm). */
export function renderReceipt(doc: ReceiptDocument, format: PaperFormat = DEFAULT_PAPER_FORMAT): string[] {
  return renderText(doc, format.widthChars);
}

// ── The standard header/footer template ───────────────────────────────────────

/** The store facts a tenant supplies; everything but the name is optional. */
export interface StoreIdentity {
  /** The trading name — required; it prints on every bill (OC-15). */
  readonly storeName: string;
  readonly addressLines?: readonly string[];
  /** 15-character GSTIN; printed as "GSTIN: …" when given. */
  readonly gstin?: string;
  readonly phone?: string;
  /** Overrides the default thank-you line. */
  readonly thanksLine?: string;
  /** Extra footer lines (e.g. a returns policy). */
  readonly footerLines?: readonly string[];
}

/** A resolved template: the header and footer line arrays a receipt carries. */
export interface ReceiptTemplate {
  readonly header: readonly string[];
  readonly footer: readonly string[];
}

export class StoreNameRequiredError extends Error {
  constructor() {
    super('A receipt template needs the store name — it prints on every bill (OC-15).');
    this.name = 'StoreNameRequiredError';
  }
}

export class InvalidGstinError extends Error {
  constructor(gstin: string) {
    super(`GSTIN '${gstin}' is not 15 characters — a wrong GSTIN on a bill is a tax error (OC-15).`);
    this.name = 'InvalidGstinError';
  }
}

const DEFAULT_THANKS = 'Thank you — please visit again';
const GSTIN_SHAPE = /^[0-9A-Z]{15}$/;

/**
 * Build the standard receipt header/footer from a tenant's own facts. The store
 * name is required (block-until-given, OC-15); a supplied GSTIN must be the right
 * shape. Everything else is optional and simply omitted when absent — no blank
 * lines, no placeholder text.
 */
export function standardReceiptTemplate(store: StoreIdentity): ReceiptTemplate {
  const name = store.storeName.trim();
  if (name === '') throw new StoreNameRequiredError();

  const header: string[] = [name];
  for (const line of store.addressLines ?? []) {
    const trimmed = line.trim();
    if (trimmed !== '') header.push(trimmed);
  }
  if (store.phone !== undefined && store.phone.trim() !== '') {
    header.push(`Ph: ${store.phone.trim()}`);
  }
  if (store.gstin !== undefined && store.gstin.trim() !== '') {
    const gstin = store.gstin.trim().toUpperCase();
    if (!GSTIN_SHAPE.test(gstin)) throw new InvalidGstinError(store.gstin);
    header.push(`GSTIN: ${gstin}`);
  }

  const thanks = (store.thanksLine ?? DEFAULT_THANKS).trim() || DEFAULT_THANKS;
  const footer: string[] = [thanks];
  for (const line of store.footerLines ?? []) {
    const trimmed = line.trim();
    if (trimmed !== '') footer.push(trimmed);
  }

  return { header, footer };
}
