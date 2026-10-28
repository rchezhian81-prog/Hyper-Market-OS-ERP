// Scan-and-go on the customer's phone (R8-3 · D04-FR-06 · owner decision OB-350, 24 Oct 2026) — the tested model, DOM-free.
//
// The phone builds the basket as the customer walks the aisles: the camera (or the typed number under the barcode) finds
// the product in the shop's own list on this phone, and the line goes in. The running total is said honestly:
//
//   • "on the shelf" — this phone's sum at the shop's published prices, BEFORE offers, always available (offline too);
//   • "the shop's price" — the shop's quote with the till's own offers engine, when the shop can be asked.
//
// Neither is what the customer pays. At the till lane the cashier keys the six-digit code the phone shows, the till brings
// the basket up and RE-PRICES every line from its own pack, and payment and the bag check happen there. The phone is never
// trusted with money: it sends product ids and quantities, nothing else. A loose weighed item is weighed at the till
// (OB-302 — never a keyed weight). The basket is kept on this phone (a convenience; losing it loses nothing paid).

/** A product as the phone's shop list carries it. */
export interface ScanProduct {
  readonly productId: string;
  readonly name: string;
  readonly unitPriceMinor: number;
  readonly uom: string;
  readonly barcodes?: readonly string[];
  readonly status?: string;
}

export interface ScanLine { readonly productId: string; readonly name: string; readonly quantityMinor: number; readonly unitPriceMinor: number }

export type ScanRefusal = 'unknown_barcode' | 'weighed_at_the_till' | 'not_on_sale' | 'too_many' | 'handed_to_the_till'
  /** OB-521: the first scan of a new basket on a withdrawn or too-old build (a basket already started is finished). */
  | 'app_version_too_old';
export type ScanAdd = { readonly ok: true; readonly line: ScanLine } | { readonly ok: false; readonly why: ScanRefusal };

/** Units a phone may count: one piece is one piece. Anything else (kg, g, l) is weighed or measured at the till. */
export const PIECE_UNITS: ReadonlySet<string> = new Set(['ea', 'each', 'pc', 'pcs', 'piece', 'unit', 'nos', 'pack']);
export const MAX_SCAN_QTY = 99;
export const MAX_SCAN_LINES = 100;
/** The six digits the till keys. */
export const TILL_CODE = /^\d{6}$/;

interface Store { getItem(k: string): string | null; setItem(k: string, v: string): void }

export interface ScanAndGo {
  /** Put one of a product in the basket — by the barcode the camera read (or that was typed), or by its id. */
  add(codeOrId: string): ScanAdd;
  /** Change a line's count; 0 takes it out. */
  setQuantity(productId: string, quantityMinor: number): void;
  lines(): readonly ScanLine[];
  /** This phone's sum at the shelf prices, before offers — never the price paid. */
  shelfTotalMinor(): number;
  units(): number;
  /** The basket's id, stable until a new trip — the shop answers the same code for the same basket. */
  basketId(): string;
  /** The code the shop gave for this basket, once handed to the till; then the basket cannot change. */
  tillCode(): string | undefined;
  handed(code: string): void;
  /** Start again with an empty basket (after paying at the till). */
  newTrip(): void;
}

export function createScanAndGo(input: {
  readonly products: () => readonly ScanProduct[];
  readonly newBasketId: () => string;
  readonly storage?: Store | undefined;
  readonly key?: string;
  /** OB-521: the words refusing NEW work on this build, or undefined when it may start (the app's version gate). */
  readonly newWorkRefusal?: () => { readonly en: string; readonly ta: string } | undefined;
}): ScanAndGo {
  const key = input.key ?? 'sre.shop.scan-and-go';
  type Saved = { basketId: string; lines: ScanLine[]; code?: string };
  const load = (): Saved => {
    try {
      const raw = input.storage?.getItem(key);
      if (raw) {
        const v = JSON.parse(raw) as Partial<Saved>;
        if (typeof v.basketId === 'string' && Array.isArray(v.lines)) {
          return { basketId: v.basketId, lines: v.lines.filter((l) => typeof l?.productId === 'string' && Number.isInteger(l.quantityMinor) && l.quantityMinor > 0), ...(typeof v.code === 'string' && TILL_CODE.test(v.code) ? { code: v.code } : {}) };
        }
      }
    } catch { /* a phone that cannot keep it starts empty — nothing paid is lost */ }
    return { basketId: input.newBasketId(), lines: [] };
  };
  let state = load();
  const save = (): void => { try { input.storage?.setItem(key, JSON.stringify(state)); } catch { /* kept in memory only */ } };
  const find = (codeOrId: string): ScanProduct | undefined => {
    const c = codeOrId.trim();
    return input.products().find((p) => p.productId === c) ?? input.products().find((p) => (p.barcodes ?? []).includes(c));
  };
  return {
    add: (codeOrId) => {
      if (state.code !== undefined) return { ok: false, why: 'handed_to_the_till' };
      // OB-521: the first scan STARTS a basket — refused on a withdrawn or too-old build; a basket already started is finished.
      if (state.lines.length === 0 && input.newWorkRefusal?.() !== undefined) return { ok: false, why: 'app_version_too_old' };
      const p = find(codeOrId);
      if (p === undefined) return { ok: false, why: 'unknown_barcode' };
      if (p.status !== undefined && p.status !== 'active' && p.status !== 'clearance') return { ok: false, why: 'not_on_sale' };
      if (!PIECE_UNITS.has(p.uom.toLowerCase())) return { ok: false, why: 'weighed_at_the_till' };
      const at = state.lines.findIndex((l) => l.productId === p.productId);
      if (at < 0 && state.lines.length >= MAX_SCAN_LINES) return { ok: false, why: 'too_many' };
      const was = at < 0 ? 0 : state.lines[at]!.quantityMinor;
      if (was >= MAX_SCAN_QTY) return { ok: false, why: 'too_many' };
      const line: ScanLine = { productId: p.productId, name: p.name, quantityMinor: was + 1, unitPriceMinor: p.unitPriceMinor };
      state = { ...state, lines: at < 0 ? [...state.lines, line] : state.lines.map((l, i) => (i === at ? line : l)) };
      save();
      return { ok: true, line };
    },
    setQuantity: (productId, q) => {
      if (state.code !== undefined || !Number.isInteger(q) || q < 0) return;
      const n = Math.min(q, MAX_SCAN_QTY);
      state = { ...state, lines: n === 0 ? state.lines.filter((l) => l.productId !== productId) : state.lines.map((l) => (l.productId === productId ? { ...l, quantityMinor: n } : l)) };
      save();
    },
    lines: () => state.lines,
    shelfTotalMinor: () => state.lines.reduce((s, l) => s + l.unitPriceMinor * l.quantityMinor, 0),
    units: () => state.lines.reduce((s, l) => s + l.quantityMinor, 0),
    basketId: () => state.basketId,
    tillCode: () => state.code,
    handed: (code) => { if (TILL_CODE.test(code)) { state = { ...state, code }; save(); } },
    newTrip: () => { state = { basketId: input.newBasketId(), lines: [] }; save(); },
  };
}

/** What the shop is sent for a quote or for the till: ids and counts only — never a price (the phone is not trusted). */
export const linesForTheShop = (lines: readonly ScanLine[]): readonly { readonly productId: string; readonly quantityMinor: number }[] =>
  lines.filter((l) => l.quantityMinor > 0).map((l) => ({ productId: l.productId, quantityMinor: l.quantityMinor }));
