// API-04 — The stock LEDGER as a screen reads it (U6 of the UI/UX gap audit, 7 Nov 2026 · §27 Inventory "Ledger" ·
// M08-FR-01 · hard rule #2 · P-08).
//
// The movement ledger is the one true record of stock (M08-FR-01): every receipt, sale, transfer, count, adjustment and
// write-off is an append-only `InventoryMoved` event, and on-hand is projected from them, never kept. Until U6 nothing
// showed a PERSON that record: the counts and transfers pages each showed their own slice, availability showed the
// projected figure, and the ledger itself was read only by code. This route hands a screen ONE product's movements, in
// ledger order, with the running balance after each — so a manager can answer "why does the system say 48?" by reading
// what happened, line by line, in whose name and for what reason.
//
// Bounded by design: a product is REQUIRED. "Every movement the shop ever made" is the unbounded read the availability
// adapter was rebuilt to avoid; a screen asks per product (and may narrow to a place and a window). The running balance is
// computed over the product's WHOLE history at each place, then the window filters what is shown — so the first row in a
// window still carries the true balance after it, never a balance that starts at zero on the window's first day.
//
// Nothing here writes. The ledger stays append-only; this is a reading of it.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { EFFECT_ON_HAND, type Movement, type MovementKind } from './index';
import { stockReadScope, type LocationBranches } from './location-scope';

export interface StockLedgerDeps {
  /** ONE product's movements, in ledger order (append order) — the adapter owns where they come from. */
  readonly movementsOf: (tenantId: string, productId: string) => Promise<readonly Movement[]> | readonly Movement[];
  /** PA-01-r1: which branch a location belongs to; absent → a location is its own branch key. */
  readonly locationBranches?: LocationBranches;
  readonly now: () => string;
}

/** One ledger line as the screen shows it: the movement, its effect, and the balance at that place after it. */
export interface LedgerLine {
  readonly movementId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly kind: MovementKind;
  /** +1 adds to on-hand, −1 takes from it (declared per kind, never inferred). */
  readonly effect: 1 | -1;
  readonly quantityMinor: number;
  readonly uom: string;
  readonly occurredAt: string;
  readonly batchId: string | null;
  readonly expiry: string | null;
  readonly reason: string | null;
  readonly enteredBy: string;
  readonly approvedBy: string | null;
  /** On-hand at this place after this movement — projected from every movement of this product there, in order. */
  readonly balanceAfterMinor: number;
}

const isIso = (v: string): boolean => !Number.isNaN(Date.parse(v));

/** The ledger lines for one product: ordered, with the running balance per place, then narrowed to a place and a window. */
export function ledgerLines(moves: readonly Movement[], filter: { readonly locationId?: string; readonly from?: string; readonly to?: string } = {}): readonly LedgerLine[] {
  const balance = new Map<string, number>();
  const lines: LedgerLine[] = [];
  for (const m of moves) {
    const effect = EFFECT_ON_HAND[m.kind];
    const after = (balance.get(m.locationId) ?? 0) + effect * m.quantityMinor;
    balance.set(m.locationId, after);
    lines.push({
      movementId: m.movementId, productId: m.productId, locationId: m.locationId, kind: m.kind, effect,
      quantityMinor: m.quantityMinor, uom: m.uom, occurredAt: m.occurredAt,
      batchId: m.batchId ?? null, expiry: m.expiry ?? null, reason: m.reason ?? null,
      enteredBy: m.enteredBy, approvedBy: m.approvedBy ?? null, balanceAfterMinor: after,
    });
  }
  return lines.filter((l) =>
    (filter.locationId === undefined || l.locationId === filter.locationId)
    && (filter.from === undefined || l.occurredAt >= filter.from)
    && (filter.to === undefined || l.occurredAt <= filter.to));
}

export function stockLedgerRoutes(deps: StockLedgerDeps): readonly Route[] {
  return [
    {
      // GET /v1/inventory/ledger?productId=…[&locationId=…][&from=ISO][&to=ISO]
      api: 'API-04', method: 'GET', path: '/v1/inventory/ledger',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const productId = (ctx.query['productId'] ?? '').trim();
        const locationId = (ctx.query['locationId'] ?? '').trim();
        const from = (ctx.query['from'] ?? '').trim();
        const to = (ctx.query['to'] ?? '').trim();
        if (productId === '') {
          throw apiError(400, {
            code: 'not_readable_as_a_ledger_read',
            whatHappened: 'Reading the stock ledger needs ?productId= — the ledger is read one product at a time, never the whole shop at once.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Choose a product and read again. Nothing was changed.',
          });
        }
        if ((from !== '' && !isIso(from)) || (to !== '' && !isIso(to))) {
          throw apiError(400, {
            code: 'not_readable_as_a_ledger_read',
            whatHappened: 'The window needs ISO timestamps: ?from= and ?to=.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Correct the dates and read again. Nothing was changed.',
          });
        }
        // PA-01-r1: a reader sees the product's movements at THEIR branches only — a store manager never reads another store's.
        const scope = await stockReadScope(ctx, deps.locationBranches);
        const moves = (await deps.movementsOf(ctx.tenantId, productId)).filter((m) => scope.covers(m.locationId));
        const lines = ledgerLines(moves, {
          ...(locationId === '' ? {} : { locationId }), ...(from === '' ? {} : { from }), ...(to === '' ? {} : { to }),
        });
        // On-hand NOW per place, from the same lines (the whole history, not the window), so the screen's figure and its
        // rows come from one reading and cannot disagree.
        const onHand = new Map<string, number>();
        for (const l of ledgerLines(moves)) onHand.set(l.locationId, l.balanceAfterMinor);
        const places = [...onHand.entries()].filter(([loc]) => locationId === '' || loc === locationId)
          .map(([loc, onHandMinor]) => ({ locationId: loc, onHandMinor }));
        return {
          status: 200,
          body: {
            productId, locationId: locationId === '' ? null : locationId, from: from === '' ? null : from, to: to === '' ? null : to,
            lines, count: lines.length,
            inMinor: lines.filter((l) => l.effect === 1).reduce((s, l) => s + l.quantityMinor, 0),
            outMinor: lines.filter((l) => l.effect === -1).reduce((s, l) => s + l.quantityMinor, 0),
            places, movementsEver: moves.length, asAt: deps.now(),
          },
        };
      },
    },
  ];
}
