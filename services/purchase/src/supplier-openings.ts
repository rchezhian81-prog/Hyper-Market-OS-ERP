// API-03 Supplier OPENING balances (GT-05 · MG-08 "load and sign off … outstanding … accounting openings" · M23-FR-01 · §28 ·
// P-08 · hard rules #2 #10).
//
// On the day the shop moves off the old system it already OWES its suppliers money: bills the old system booked and nobody
// has paid yet. Those bills were never ordered, received or matched in this system, so the supplier account (a projection
// over order · receipt · invoice · match, supplier-account.ts) cannot see them — until now the migration could only BUILD
// an "opening event" and hand it back (POST /v1/migration/opening-events), and nothing anywhere owed it.
//
// This register is the domain write path for them:
//
//   • RECORD (`POST /v1/purchase/suppliers/:supplierId/opening-balances/:openingId`) — one outstanding legacy bill, as the old
//     ledger states it: bill number, bill date, due date, the amount still outstanding, the date the opening is true at, and
//     the load it came in under. Only for a supplier the MASTER holds. Append-only: the same opening sent again is the same
//     opening (a re-run doubles nothing); the same id with DIFFERENT figures is a visible conflict, never a silent overwrite
//     (hard rule #10).
//   • SIGN OFF (`POST /v1/purchase/opening-balances/sign-off/:loadId`) — a DIFFERENT person holding the supplier-approval
//     authority (finance) states the control total and count from the old system's creditors' list; the sign-off is refused
//     unless the recorded openings add up to exactly that (MG-06 — reconcile before it counts). Until it is signed an opening
//     is SHOWN on the account as pending sign-off and is NOT owed (it cannot be paid, it does not post).
//   • READ (`GET /v1/purchase/opening-balances`) — every opening, by load, with its signed state and totals.
//
// A signed opening joins the supplier's balance (owed, payable, posted to the ledger as `supplier_opening_balance` through the
// accountant's mapping — packages/finance/src/payables.ts). A correction is NOT an edit: it is a payment, a debit note, or a
// new opening of the right figure plus the accountant's journal — hard rule #2.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';

/** One outstanding legacy supplier bill carried into the new books. Never edited. */
export interface SupplierOpeningBalance {
  readonly openingId: string;
  readonly supplierId: string;
  /** The bill number the old system and the supplier know it by. */
  readonly billNumber: string;
  /** YYYY-MM-DD. */
  readonly billDate: string;
  readonly dueOn: string | null;
  /** What is still OUTSTANDING on the bill at the opening date, in paise. */
  readonly amountMinor: number;
  readonly currency: 'INR';
  /** YYYY-MM-DD — the date the opening books are true at (the cutover count date). */
  readonly openingDate: string;
  /** The migration load it came in under — the unit a sign-off covers. */
  readonly loadId: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

/** A second person's sign-off of a load's supplier openings against the old system's control total. */
export interface SupplierOpeningSignOff {
  readonly loadId: string;
  /** Exactly the openings the signer reconciled — one recorded after the sign-off is NOT covered by it. */
  readonly openingIds: readonly string[];
  readonly totalMinor: number;
  readonly signedBy: string;
  readonly signedAt: string;
  readonly note: string | null;
}

/** An opening as an account shows it. */
export interface AccountOpening extends SupplierOpeningBalance {
  readonly signed: boolean;
  readonly signedBy: string | null;
  readonly signedAt: string | null;
}

export interface SupplierOpeningDeps {
  /** The supplier master record (only its existence and status matter here). */
  readonly record: (tenantId: string, supplierId: string) => Promise<{ readonly supplierId: string } | undefined> | { readonly supplierId: string } | undefined;
  readonly openings: (tenantId: string) => Promise<readonly SupplierOpeningBalance[]> | readonly SupplierOpeningBalance[];
  /** Append the opening; resolve the opening that STANDS under its id (another writer's, when theirs landed first). */
  readonly recordOpening: (tenantId: string, opening: SupplierOpeningBalance) => Promise<SupplierOpeningBalance | void> | SupplierOpeningBalance | void;
  readonly signOffs: (tenantId: string) => Promise<readonly SupplierOpeningSignOff[]> | readonly SupplierOpeningSignOff[];
  /** Append the sign-off; resolve the sign-off that STANDS for the load (another signer's, when theirs landed first). */
  readonly recordSignOff: (tenantId: string, signOff: SupplierOpeningSignOff) => Promise<SupplierOpeningSignOff | void> | SupplierOpeningSignOff | void;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

/** The openings with their signed state — the one fold the account, the list and the posting all read. Pure. */
export function openingsWithSignOff(openings: readonly SupplierOpeningBalance[], signOffs: readonly SupplierOpeningSignOff[]): readonly AccountOpening[] {
  const signedBy = new Map<string, SupplierOpeningSignOff>();
  for (const s of signOffs) for (const id of s.openingIds) if (!signedBy.has(id)) signedBy.set(id, s);
  return openings.map((o) => {
    const s = signedBy.get(o.openingId);
    return { ...o, signed: s !== undefined, signedBy: s?.signedBy ?? null, signedAt: s?.signedAt ?? null };
  });
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));
const isPosInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const isNonNegInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

const sameFigures = (a: SupplierOpeningBalance, b: Omit<SupplierOpeningBalance, 'recordedBy' | 'recordedAt'>): boolean =>
  a.supplierId === b.supplierId && a.billNumber === b.billNumber && a.billDate === b.billDate && a.dueOn === b.dueOn
  && a.amountMinor === b.amountMinor && a.openingDate === b.openingDate && a.loadId === b.loadId;

export function supplierOpeningRoutes(deps: SupplierOpeningDeps): readonly Route[] {
  const audit = async (tenantId: string, entry: AuditEntry): Promise<void> => { await deps.recordAudit?.(tenantId, entry); };
  return [
    {
      api: 'API-03', method: 'POST', path: '/v1/purchase/suppliers/:supplierId/opening-balances/:openingId',
      permission: 'purchase.invoice.capture', idempotent: true,
      handler: async (ctx) => {
        const supplierId = (ctx.params['supplierId'] ?? '').trim();
        const openingId = (ctx.params['openingId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (supplierId === '' || openingId === '' || !isStr(b['billNumber']) || !isDate(b['billDate'])
          || !(b['dueOn'] === undefined || b['dueOn'] === null || isDate(b['dueOn'])) || !isPosInt(b['amountMinor'])
          || !isDate(b['openingDate']) || !isStr(b['loadId'])) {
          throw apiError(400, {
            code: 'not_readable_as_an_opening_balance',
            whatHappened: 'An opening supplier balance needs the supplierId and openingId in the path and { billNumber, billDate (YYYY-MM-DD), dueOn? (YYYY-MM-DD), amountMinor (whole paise, more than 0 — the amount still outstanding), openingDate (YYYY-MM-DD), loadId }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the bill as the old system holds it. Nothing was recorded.',
          });
        }
        const t = ctx.tenantId;
        const candidate = {
          openingId, supplierId, billNumber: (b['billNumber'] as string).trim(), billDate: b['billDate'] as string,
          dueOn: (b['dueOn'] as string | null | undefined) ?? null, amountMinor: b['amountMinor'] as number, currency: 'INR' as const,
          openingDate: b['openingDate'] as string, loadId: (b['loadId'] as string).trim(),
        };
        const prior = (await deps.openings(t)).find((o) => o.openingId === openingId);
        if (prior !== undefined) {
          if (sameFigures(prior, candidate)) return { status: 200, body: { opening: prior, alreadyRecorded: true } };
          throw apiError(409, {
            code: 'opening_balance_conflict',
            whatHappened: `Opening ${openingId} is already recorded for supplier ${prior.supplierId} as bill ${prior.billNumber} for ${prior.amountMinor} paise (load ${prior.loadId}). These figures differ, and an opening is never overwritten.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Find out which figure is right in the old system. A wrong opening is corrected by a payment, a debit note or the accountant\'s journal — never by sending it again with new numbers.',
          });
        }
        if (await deps.record(t, supplierId) === undefined) {
          throw apiError(422, {
            code: 'supplier_unknown',
            whatHappened: `Supplier ${supplierId} is not in the supplier master, so a balance owed to them cannot be opened.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Load the supplier (name and GSTIN) first, then the opening balance. Nothing was recorded.',
          });
        }
        const opening: SupplierOpeningBalance = { ...candidate, recordedBy: ctx.userId, recordedAt: deps.now() };
        const standing = (await deps.recordOpening(t, opening)) ?? opening;
        if (standing.recordedAt !== opening.recordedAt || standing.recordedBy !== opening.recordedBy) {
          // Another writer's opening under the same id landed first, at the same moment.
          if (sameFigures(standing, candidate)) return { status: 200, body: { opening: standing, alreadyRecorded: true } };
          throw apiError(409, {
            code: 'opening_balance_conflict',
            whatHappened: `Opening ${openingId} was recorded by ${standing.recordedBy} at the same moment with different figures (${standing.amountMinor} paise). An opening is never overwritten.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Find out which figure is right in the old system before anything else is done with this bill.',
          });
        }
        await audit(t, {
          actorId: ctx.userId, action: 'supplier.opening_balance.record', objectType: 'supplier', objectId: supplierId,
          at: opening.recordedAt, origin: { tenantId: t, branchId: ctx.branchId ?? null },
          before: {}, after: { openingId, billNumber: opening.billNumber, amountMinor: String(opening.amountMinor), loadId: opening.loadId, openingDate: opening.openingDate },
          correlationId: opening.loadId,
        });
        return { status: 201, body: { opening, alreadyRecorded: false, signed: false } };
      },
    },
    {
      api: 'API-03', method: 'POST', path: '/v1/purchase/opening-balances/sign-off/:loadId',
      permission: 'purchase.supplier.approve', idempotent: true,
      handler: async (ctx) => {
        const loadId = (ctx.params['loadId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (loadId === '' || !isNonNegInt(b['expectedTotalMinor']) || !isNonNegInt(b['expectedCount'])
          || !(b['note'] === undefined || b['note'] === null || typeof b['note'] === 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_a_sign_off',
            whatHappened: 'Signing off a load\'s opening supplier balances needs the loadId in the path and { expectedTotalMinor, expectedCount } — the creditors\' total and the number of open bills from the old system — and an optional note.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the old system\'s control total and count. Nothing was signed.',
          });
        }
        const t = ctx.tenantId;
        const [openings, signOffs] = await Promise.all([deps.openings(t), deps.signOffs(t)]);
        const prior = signOffs.find((s) => s.loadId === loadId);
        if (prior !== undefined) return { status: 200, body: { signOff: prior, alreadySigned: true } };
        const ofLoad = openings.filter((o) => o.loadId === loadId);
        if (ofLoad.length === 0) {
          throw apiError(404, {
            code: 'no_openings_for_load',
            whatHappened: `No opening supplier balances are recorded under load ${loadId}. An empty sign-off would certify nothing.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Check the load id, or load the openings first. Nothing was signed.',
          });
        }
        const makers = [...new Set(ofLoad.map((o) => o.recordedBy))];
        if (makers.includes(ctx.userId)) {
          throw apiError(403, {
            code: 'signer_recorded_the_openings',
            whatHappened: `You recorded opening balances in load ${loadId}, so you cannot also sign them off (§28: the person who loads a figure never certifies it).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Ask another person who approves suppliers (finance) to reconcile and sign this load. Nothing was signed.',
          });
        }
        const total = ofLoad.reduce((s, o) => s + o.amountMinor, 0);
        if (total !== b['expectedTotalMinor'] || ofLoad.length !== b['expectedCount']) {
          throw apiError(422, {
            code: 'opening_total_differs',
            whatHappened: `Load ${loadId} holds ${ofLoad.length} opening bill(s) totalling ${total} paise; the old system's figures you gave are ${String(b['expectedCount'])} bill(s) totalling ${String(b['expectedTotalMinor'])} paise. They must agree to the paisa before the openings count (MG-06).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Find the difference line by line (GET /v1/purchase/opening-balances?loadId=…). Load the missing bill or have the wrong one corrected, then sign again. Nothing was signed.',
          });
        }
        const signOff: SupplierOpeningSignOff = {
          loadId, openingIds: ofLoad.map((o) => o.openingId).sort(), totalMinor: total, signedBy: ctx.userId, signedAt: deps.now(),
          note: typeof b['note'] === 'string' && b['note'].trim() !== '' ? b['note'].trim() : null,
        };
        const stood = (await deps.recordSignOff(t, signOff)) ?? signOff;
        if (stood.signedBy !== signOff.signedBy || stood.signedAt !== signOff.signedAt) return { status: 200, body: { signOff: stood, alreadySigned: true } };
        await audit(t, {
          actorId: ctx.userId, action: 'supplier.opening_balance.sign_off', objectType: 'migration_load', objectId: loadId,
          at: signOff.signedAt, origin: { tenantId: t, branchId: ctx.branchId ?? null },
          before: {}, after: { count: String(ofLoad.length), totalMinor: String(total), recordedBy: makers.join(',') },
          correlationId: loadId,
        });
        return { status: 201, body: { signOff, alreadySigned: false } };
      },
    },
    {
      api: 'API-03', method: 'GET', path: '/v1/purchase/opening-balances',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const loadId = ctx.query['loadId'];
        const supplierId = ctx.query['supplierId'];
        const [openings, signOffs] = await Promise.all([deps.openings(ctx.tenantId), deps.signOffs(ctx.tenantId)]);
        const rows = openingsWithSignOff(openings, signOffs)
          .filter((o) => (loadId === undefined || o.loadId === loadId) && (supplierId === undefined || o.supplierId === supplierId));
        const signedMinor = rows.filter((o) => o.signed).reduce((s, o) => s + o.amountMinor, 0);
        const pendingMinor = rows.filter((o) => !o.signed).reduce((s, o) => s + o.amountMinor, 0);
        return {
          status: 200,
          body: {
            openings: rows, count: rows.length, signedMinor, pendingSignOffMinor: pendingMinor,
            signOffs: signOffs.filter((s) => loadId === undefined || s.loadId === loadId), asAt: deps.now(),
          },
        };
      },
    },
  ];
}
