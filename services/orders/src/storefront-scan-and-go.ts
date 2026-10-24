// API-07 / API-04 — scan-and-go on the customer's own phone (R8-3 · D04-FR-06 · owner decision OB-350, 24 Oct 2026: "the
// phone builds the basket and shows the total; payment and the exit check are at a till lane").
//
//   POST /v1/storefront/scan-and-go/baskets/:basketId   the CUSTOMER hands the basket their phone built to head office, which
//                                                       holds it under a 6-digit code the phone shows at the till
//   GET  /v1/storefront/scan-and-go/baskets             MY held baskets, and which till took each one
//   POST /v1/store/scan-and-go/:code/recall             the STORE COMPUTER, for the cashier at a till lane: the basket's lines
//                                                       — strictly once (any second recall is refused, naming the first)
//
// What the phone is trusted with: NOTHING that moves money. It sends product ids and quantities. Head office keeps only
// products in the shop's current signed pack, sold by the piece (a loose weighed item is weighed at the till — OB-302, never
// a keyed weight), with the barcode the till will scan for each. It keeps NO price: the phone's running total came from the
// shop's own quote (`POST /v1/storefront/cart/quote` — the till's offers engine), and at the lane the till RE-PRICES every
// line from its own pack and takes the payment; the cashier's look at the bag is the exit check. An age-restricted item is
// asked about at the till like any other. Offline, the phone keeps building its basket and says the total is the till's;
// the code needs head office, and without it the cashier simply scans the items (the sale never waits — hard rule #1).
// Append-only (hard rules #2/#6): a held basket and its one recall are records, never edited or deleted.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';

/** The shop's current pack, as scan-and-go reads it — products and the barcodes the till scans. */
export interface ScanAndGoPack {
  readonly version: number;
  readonly products: readonly { readonly productId: string; readonly name: string; readonly baseUom: string; readonly unitPriceMinor: number }[];
  readonly barcodes: readonly { readonly code: string; readonly productId: string; readonly kind: string }[];
}

export interface PhoneBasketLine {
  readonly productId: string;
  readonly name: string;
  readonly quantityMinor: number;
  /** The barcode the TILL scans for this line — from the pack, never typed. */
  readonly barcode: string;
}

/** A basket a customer's phone built, held for a till lane. No price is kept — the till prices it. */
export interface PhoneBasket {
  readonly code: string;
  readonly basketId: string;
  readonly customerRef: string;
  readonly lines: readonly PhoneBasketLine[];
  readonly packVersion: number;
  readonly heldAt: string;
}

/** The one recall of a held basket — which store computer, which till, which cashier, when. */
export interface PhoneBasketRecall {
  readonly code: string;
  readonly recalledBy: string;
  readonly laneId: string;
  readonly cashierId: string;
  readonly at: string;
}

export interface ScanAndGoDeps {
  readonly pack: (tenantId: string) => Promise<ScanAndGoPack | undefined>;
  readonly basket: (tenantId: string, code: string) => Promise<PhoneBasket | undefined>;
  readonly recalls: (tenantId: string, code: string) => Promise<readonly PhoneBasketRecall[]>;
  readonly basketsOf: (tenantId: string, customerRef: string) => Promise<readonly PhoneBasket[]>;
  /** Append a basket — idempotent on its code. */
  readonly recordBasket: (tenantId: string, b: PhoneBasket) => Promise<void>;
  /** Append the recall — idempotent on the code: the first recall stands. */
  readonly recordRecall: (tenantId: string, r: PhoneBasketRecall) => Promise<void>;
  readonly randomInt: (max: number) => number;
  readonly now: () => string;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

/** A basket's code: six digits, easy for a cashier to key from the phone's screen. */
export const PHONE_BASKET_CODE = /^\d{6}$/;
const BASKET_ID = /^[A-Za-z0-9_-]{6,64}$/;
const MAX_LINES = 100;
const MAX_QTY = 99;
/** Units the phone may count: one piece is one piece. A weight is the till scale's to read (OB-302). */
const PIECE_UNITS: ReadonlySet<string> = new Set(['ea', 'each', 'pc', 'pcs', 'piece', 'unit', 'nos', 'pack']);

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

const WORDS = {
  atTheTill: {
    en: 'Go to any till lane and show this code. The cashier brings up your basket, the till works out the price, and you pay there.',
    ta: 'எந்தக் கட்டண வரிசைக்கும் சென்று இந்தக் குறியீட்டைக் காட்டுங்கள். காசாளர் உங்கள் கூடையைத் திறப்பார், விலையை கட்டண இயந்திரம் கணக்கிடும், அங்கேயே செலுத்துங்கள்.',
  },
} as const;

export function scanAndGoRoutes(deps: ScanAndGoDeps): readonly Route[] {
  const view = async (tenantId: string, b: PhoneBasket) => {
    const recall = (await deps.recalls(tenantId, b.code))[0];
    return {
      code: b.code, basketId: b.basketId, heldAt: b.heldAt, lines: b.lines, lineCount: b.lines.length,
      units: b.lines.reduce((n, l) => n + l.quantityMinor, 0),
      recalled: recall === undefined ? null : { laneId: recall.laneId, at: recall.at },
      tellTheCustomer: WORDS.atTheTill,
    };
  };
  return [
    {
      // Body: { lines: [{ productId, quantityMinor }] } — what the phone scanned. No price is read or kept.
      api: 'API-07', method: 'POST', path: '/v1/storefront/scan-and-go/baskets/:basketId',
      permission: 'storefront.order.place', entitlement: 'customer_app', idempotent: true,
      handler: async (ctx) => {
        const basketId = (ctx.params['basketId'] ?? '').trim();
        const b = ctx.body;
        const lines = isObj(b) ? b['lines'] : undefined;
        if (!BASKET_ID.test(basketId) || !Array.isArray(lines) || lines.length === 0 || lines.length > MAX_LINES
          || !lines.every((l) => isObj(l) && isStr(l['productId']) && Number.isInteger(l['quantityMinor']) && (l['quantityMinor'] as number) >= 1 && (l['quantityMinor'] as number) <= MAX_QTY)) {
          throw apiError(400, {
            code: 'not_readable_as_a_phone_basket',
            whatHappened: `A scan-and-go basket needs { lines: [{ productId, quantityMinor 1–${MAX_QTY} }] } (at most ${MAX_LINES} lines) and an id of 6–64 letters, digits, - or _.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Your basket is still on your phone. Try again, or scan the items at the till.',
          });
        }
        // The same basket sent again (a lost reply) is the same code.
        const prior = (await deps.basketsOf(ctx.tenantId, ctx.userId)).find((x) => x.basketId === basketId);
        if (prior !== undefined) return { status: 200, body: { ...(await view(ctx.tenantId, prior)), alreadyHeld: true } };
        const pack = await deps.pack(ctx.tenantId);
        if (pack === undefined) {
          throw apiError(409, { code: 'no_pack_published', whatHappened: 'The shop has published no price pack, so no till can price this basket.', wasItSaved: 'not_saved', nextSafeAction: 'Scan the items at the till. Nothing was kept.' });
        }
        // Merge repeated lines; every product must be in the pack, sold by the piece, with a barcode the till can scan.
        const qty = new Map<string, number>();
        for (const l of lines as { productId: string; quantityMinor: number }[]) qty.set(l.productId, (qty.get(l.productId) ?? 0) + l.quantityMinor);
        const kept: PhoneBasketLine[] = [];
        const refused: { productId: string; why: 'not_in_the_pack' | 'weighed_at_the_till' | 'no_barcode' }[] = [];
        for (const [productId, quantityMinor] of qty) {
          const p = pack.products.find((x) => x.productId === productId);
          if (p === undefined) { refused.push({ productId, why: 'not_in_the_pack' }); continue; }
          if (!PIECE_UNITS.has(p.baseUom.toLowerCase())) { refused.push({ productId, why: 'weighed_at_the_till' }); continue; }
          const code = pack.barcodes.find((c) => c.productId === productId && (c.kind === 'standard' || c.kind === 'alternate'))?.code;
          if (code === undefined) { refused.push({ productId, why: 'no_barcode' }); continue; }
          kept.push({ productId, name: p.name, quantityMinor: Math.min(quantityMinor, MAX_QTY), barcode: code });
        }
        if (refused.length > 0) {
          throw apiError(422, {
            code: 'not_for_scan_and_go',
            whatHappened: `These cannot go through scan-and-go: ${refused.map((r) => `${r.productId} (${r.why === 'weighed_at_the_till' ? 'weighed at the till' : r.why === 'no_barcode' ? 'no barcode the till can scan' : 'not on sale in the shop\'s price pack'})`).join(', ')}.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Take them out of the phone basket and have them weighed or scanned at the till. Nothing was kept.',
            refused,
          } as Parameters<typeof apiError>[1]);
        }
        // Six digits, never one another basket already holds.
        let code: string | undefined;
        for (let i = 0; i < 10 && code === undefined; i += 1) {
          const candidate = String(deps.randomInt(1_000_000)).padStart(6, '0');
          if ((await deps.basket(ctx.tenantId, candidate)) === undefined) code = candidate;
        }
        if (code === undefined) throw apiError(503, { code: 'no_code_free', whatHappened: 'The shop could not give a code just now.', wasItSaved: 'not_saved', nextSafeAction: 'Try again, or scan the items at the till.' });
        const basket: PhoneBasket = { code, basketId, customerRef: ctx.userId, lines: kept, packVersion: pack.version, heldAt: deps.now() };
        await deps.recordBasket(ctx.tenantId, basket);
        const stood = (await deps.basket(ctx.tenantId, code)) ?? basket;
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'scan_and_go.hold', objectType: 'phone_basket', objectId: code, at: stood.heldAt,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: { lines: String(stood.lines.length), packVersion: String(stood.packVersion) }, correlationId: basketId,
        });
        return { status: 201, body: await view(ctx.tenantId, stood) };
      },
    },
    {
      api: 'API-07', method: 'GET', path: '/v1/storefront/scan-and-go/baskets',
      permission: 'storefront.order.read', entitlement: 'customer_app',
      handler: async (ctx) => {
        const mine = [...await deps.basketsOf(ctx.tenantId, ctx.userId)].sort((a, b) => b.heldAt.localeCompare(a.heldAt));
        const baskets = [];
        for (const b of mine) baskets.push(await view(ctx.tenantId, b));
        return { status: 200, body: { baskets, asAt: deps.now() } };
      },
    },
    {
      // The store computer recalls a held basket for the cashier at a till lane. Body: { laneId, cashierId } — who asked,
      // as the box verified them. Once: a second recall (another lane, or the same code again) is refused, naming the first.
      api: 'API-04', method: 'POST', path: '/v1/store/scan-and-go/:code/recall',
      permission: 'storefront.scango.recall', entitlement: 'customer_app', idempotent: true,
      handler: async (ctx) => {
        const code = (ctx.params['code'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!PHONE_BASKET_CODE.test(code) || !isStr(b['laneId']) || !isStr(b['cashierId'])) {
          throw apiError(400, { code: 'not_readable_as_a_recall', whatHappened: 'A recall needs the six-digit code on the customer\'s phone, the till (laneId) and the cashier (cashierId).', wasItSaved: 'not_saved', nextSafeAction: 'Key the code again, or scan the items. Nothing was changed.' });
        }
        const basket = await deps.basket(ctx.tenantId, code);
        if (basket === undefined) {
          throw apiError(404, { code: 'no_such_phone_basket', whatHappened: `No phone basket is held under ${code}.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the code on the customer\'s phone, or scan the items. Nothing was changed.' });
        }
        // Strictly once — even the same till asking again: a basket rung twice is a customer charged twice. A till that never
        // got the first answer (a lost reply) scans the items instead; the record says which till took it, and when.
        const first = (await deps.recalls(ctx.tenantId, code))[0];
        if (first !== undefined) {
          throw apiError(409, { code: 'already_recalled', whatHappened: `This basket was already brought up at till ${first.laneId} at ${first.at}. A basket is brought up once — ringing it twice would charge the customer twice.`, wasItSaved: 'not_saved', nextSafeAction: 'If that till did not get it, scan the items as usual. Nothing was changed.' });
        }
        const recall: PhoneBasketRecall = { code, recalledBy: ctx.userId, laneId: (b['laneId'] as string).trim(), cashierId: (b['cashierId'] as string).trim(), at: deps.now() };
        await deps.recordRecall(ctx.tenantId, recall);
        const stood = (await deps.recalls(ctx.tenantId, code))[0] ?? recall;
        if (stood.laneId !== recall.laneId || stood.cashierId !== recall.cashierId) {
          throw apiError(409, { code: 'already_recalled', whatHappened: `This basket was just brought up at till ${stood.laneId}.`, wasItSaved: 'not_saved', nextSafeAction: 'Ask the customer which till has it. Nothing was changed.' });
        }
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: recall.cashierId, action: 'scan_and_go.recall', objectType: 'phone_basket', objectId: code, at: recall.at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: { laneId: recall.laneId, relayedBy: ctx.userId, lines: String(basket.lines.length) }, correlationId: basket.basketId,
        });
        return { status: 200, body: { recalled: true, code, lines: basket.lines, packVersion: basket.packVersion, recall: stood } };
      },
    },
  ];
}
