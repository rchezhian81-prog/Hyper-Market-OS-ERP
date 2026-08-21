// API-09 Concession — a partner trading a counter inside the store (M27). The one truth this surface
// exists to protect: **the money the store's tills take for a concession sale was NEVER the store's
// revenue.** It is money held on the partner's behalf, a liability the settlement discharges;
// presenting it as revenue and the payout as a cost inflates both sides of the P&L and makes every
// margin figure in the business wrong. The period charge (rent / revenue share / higher-of-both) is
// computed in exact integer money.
//
// This surface also carries the OWNERSHIP + ELIGIBILITY controls (M27-FR ownership/eligibility):
//   • **valuation excludes what the store does not own** — concession/consignment stock sits on the
//     store's shelves and belongs to somebody else; a valuation that includes it overstates the balance
//     sheet, the insurance schedule and the tax position at once. `valueOwnStock` names what it excluded;
//   • **a counter with a lapsed agreement, insurance or licence cannot take new sales** — an uninsured
//     counter inside the shop is the shop's exposure. `mayConcessionTrade` reports every blocker at once;
//   • **a deposit is the concessionaire's money, a liability never rent** — `depositPosition` projects it
//     from movements, and a forfeit with nobody's name on it stays a liability;
//   • **somebody else's stock is not ours to adjust or write off** — `checkStockAccess` refuses it and
//     flags a security event.
//
// The rules are the pure engine in `packages/concession` (the `services-run-on-their-tested-engine`
// guardrail); this file is the persistence + HTTP skin. Managing contracts/deposits is gated
// `concession.contract.manage`; reads/decisions are `concession.charge.read`.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  computePeriodCharge, settleConcession, mayConcessionTrade, depositPosition, valueOwnStock, checkStockAccess,
  type ConcessionContract, type ConcessionSale, type ConcessionChargeBasis,
  type DepositMovement, type OwnedLot, type OwnershipStatus,
} from '../../../packages/concession/src/index';

export type { ConcessionContract, ConcessionSale, DepositMovement } from '../../../packages/concession/src/index';

const BASES: readonly ConcessionChargeBasis[] = ['fixed_rent', 'revenue_share', 'higher_of_both'];
const TENDERED: readonly ConcessionSale['tenderedTo'][] = ['store_till', 'concessionaire_till'];
const DEPOSIT_KINDS: readonly DepositMovement['kind'][] = ['received', 'refunded', 'forfeited'];
const OWNERSHIPS: readonly OwnershipStatus[] = ['own', 'concession', 'consignment', 'customer_property'];
const ACTIONS = ['view', 'sell', 'adjust', 'write_off', 'count'] as const;
const ACTOR_KINDS = ['store_staff', 'concessionaire'] as const;

const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPosMinor = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

const isLot = (v: unknown): v is OwnedLot =>
  isObj(v) && isStr(v['lotId']) && isStr(v['productId']) && isStr(v['branchId'])
  && Number.isInteger(v['qty']) && (v['qty'] as number) >= 0 && Number.isInteger(v['unitCostMinor'])
  && typeof v['ownership'] === 'string' && OWNERSHIPS.includes(v['ownership'] as OwnershipStatus)
  && (v['ownerId'] === undefined || typeof v['ownerId'] === 'string');

export interface ConcessionDeps {
  readonly contract: (tenantId: string, contractId: string) => Promise<ConcessionContract | undefined> | ConcessionContract | undefined;
  readonly sales: (tenantId: string, contractId: string) => Promise<readonly ConcessionSale[]> | readonly ConcessionSale[];
  readonly recordContract: (tenantId: string, contract: ConcessionContract) => Promise<void> | void;
  readonly recordSale: (tenantId: string, sale: ConcessionSale) => Promise<void> | void;
  /** Every deposit movement for a concessionaire — the deposit position is projected from these. */
  readonly depositMovements: (tenantId: string, concessionaireId: string) => Promise<readonly DepositMovement[]> | readonly DepositMovement[];
  /** Record a deposit movement (received / refunded / forfeited). Idempotent on the movement id. */
  readonly recordDepositMovement: (tenantId: string, movement: DepositMovement) => Promise<void> | void;
  readonly now: () => string;
}

export function concessionRoutes(deps: ConcessionDeps): readonly Route[] {
  return [
    {
      api: 'API-09', method: 'POST', path: '/v1/concession/contracts/:contractId',
      permission: 'concession.contract.manage', idempotent: true,
      handler: async (ctx) => {
        const contractId = ctx.params['contractId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['concessionaireId'] !== 'string' || (b['concessionaireId'] as string).trim() === ''
          || typeof b['name'] !== 'string' || typeof b['branchId'] !== 'string'
          || !isDate(b['startsOn']) || !isDate(b['endsOn'])
          || typeof b['basis'] !== 'string' || !BASES.includes(b['basis'] as ConcessionChargeBasis)
          || !Number.isInteger(b['depositMinor']) || (b['depositMinor'] as number) < 0
          || (b['insuranceUntil'] !== undefined && !isDate(b['insuranceUntil']))
          || (b['licenceUntil'] !== undefined && !isDate(b['licenceUntil']))
          || (b['approvedBy'] !== undefined && typeof b['approvedBy'] !== 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_a_contract',
            whatHappened: 'A concession contract needs a concessionaire, name, branch, start/end dates, a basis (fixed_rent, revenue_share or higher_of_both) and a non-negative deposit; insuranceUntil/licenceUntil (if given) are YYYY-MM-DD.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the contract fields and try again. Nothing was set.',
          });
        }
        const contract: ConcessionContract = {
          contractId, tenantId: ctx.tenantId, branchId: b['branchId'] as string,
          concessionaireId: b['concessionaireId'] as string, name: b['name'] as string,
          startsOn: b['startsOn'] as string, endsOn: b['endsOn'] as string, basis: b['basis'] as ConcessionChargeBasis,
          depositMinor: b['depositMinor'] as number, active: b['active'] !== false,
          ...(Number.isInteger(b['fixedRentMinor']) ? { fixedRentMinor: b['fixedRentMinor'] as number } : {}),
          ...(Number.isInteger(b['revenueShareBps']) ? { revenueShareBps: b['revenueShareBps'] as number } : {}),
          ...(Number.isInteger(b['utilitiesMinor']) ? { utilitiesMinor: b['utilitiesMinor'] as number } : {}),
          // Captured so the eligibility gate is real — a lapsed insurance/licence blocks trading, and an
          // unapproved contract cannot trade (§28). Previously dropped, so may-trade could never pass.
          ...(isDate(b['insuranceUntil']) ? { insuranceUntil: b['insuranceUntil'] as string } : {}),
          ...(isDate(b['licenceUntil']) ? { licenceUntil: b['licenceUntil'] as string } : {}),
          ...(isStr(b['approvedBy']) ? { approvedBy: b['approvedBy'] as string } : {}),
        };
        await deps.recordContract(ctx.tenantId, contract);
        return { status: 201, body: { contractId, concessionaireId: contract.concessionaireId, basis: contract.basis } };
      },
    },
    {
      // Record a concession sale. A refund carries a NEGATIVE gross and names the sale it reverses, so
      // revenue share is never charged on money that went back to a customer.
      api: 'API-09', method: 'POST', path: '/v1/concession/contracts/:contractId/sales',
      permission: 'concession.sale.record', idempotent: true,
      handler: async (ctx) => {
        const contractId = ctx.params['contractId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['saleId'] !== 'string' || (b['saleId'] as string).trim() === ''
          || !Number.isInteger(b['grossMinor']) || !Number.isInteger(b['taxMinor'])
          || typeof b['tenderedTo'] !== 'string' || !TENDERED.includes(b['tenderedTo'] as ConcessionSale['tenderedTo'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_concession_sale',
            whatHappened: 'A concession sale needs a sale id, a whole gross (negative for a refund) and tax, and where it was tendered (store_till or concessionaire_till).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the sale id, amounts and tender. Nothing was recorded.',
          });
        }
        const contract = await deps.contract(ctx.tenantId, contractId);
        if (contract === undefined) throw notFound(`concession contract ${contractId}`);

        const sale: ConcessionSale = {
          saleId: b['saleId'] as string, contractId, concessionaireId: contract.concessionaireId, branchId: contract.branchId,
          at: isDate((b['at'] as string ?? '').slice(0, 10)) ? b['at'] as string : deps.now(),
          grossMinor: b['grossMinor'] as number, taxMinor: b['taxMinor'] as number,
          tenderedTo: b['tenderedTo'] as ConcessionSale['tenderedTo'],
          ...(typeof b['refundOf'] === 'string' ? { refundOf: b['refundOf'] } : {}),
        };
        await deps.recordSale(ctx.tenantId, sale);
        return { status: 201, body: { saleId: sale.saleId, contractId, grossMinor: sale.grossMinor, tenderedTo: sale.tenderedTo } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/concession/contracts/:contractId/charge',
      permission: 'concession.charge.read',
      handler: async (ctx) => {
        const contractId = ctx.params['contractId'] ?? '';
        const from = ctx.query['from']; const to = ctx.query['to'];
        if (!isDate(from) || !isDate(to)) throw apiError(400, { code: 'charge_needs_a_window', whatHappened: 'A period charge needs ?from=YYYY-MM-DD&to=YYYY-MM-DD.', wasItSaved: 'not_saved', nextSafeAction: 'Send the window. A charge reads, it never writes.' });
        const contract = await deps.contract(ctx.tenantId, contractId);
        if (contract === undefined) throw notFound(`concession contract ${contractId}`);
        const metered = ctx.query['meteredUtilitiesMinor'];
        const charge = computePeriodCharge({
          contract, sales: await deps.sales(ctx.tenantId, contractId), from, to,
          ...(metered !== undefined && Number.isInteger(Number(metered)) ? { meteredUtilitiesMinor: Number(metered) } : {}),
        });
        return { status: 200, body: { ...charge, asAt: deps.now() } };
      },
    },
    {
      // Settle a period. `collectedForThemMinor` is a LIABILITY (money we hold for them), never our
      // revenue; the deposit is stated but NEVER netted without instruction; a till-vs-counter
      // difference is a valued exception, not a rounding note.
      api: 'API-09', method: 'GET', path: '/v1/concession/contracts/:contractId/settlement',
      permission: 'concession.charge.read',
      handler: async (ctx) => {
        const contractId = ctx.params['contractId'] ?? '';
        const from = ctx.query['from']; const to = ctx.query['to']; const banked = ctx.query['bankedForThemMinor'];
        if (!isDate(from) || !isDate(to) || banked === undefined || !Number.isInteger(Number(banked))) {
          throw apiError(400, { code: 'settlement_needs_a_window_and_banked', whatHappened: 'A settlement needs ?from=&to=YYYY-MM-DD and ?bankedForThemMinor= (what the tills actually banked for this concession, from the day-close).', wasItSaved: 'not_saved', nextSafeAction: 'Send the window and the banked figure. A settlement reads, it never writes.' });
        }
        const contract = await deps.contract(ctx.tenantId, contractId);
        if (contract === undefined) throw notFound(`concession contract ${contractId}`);
        const sales = await deps.sales(ctx.tenantId, contractId);
        const charge = computePeriodCharge({ contract, sales, from, to });
        const settlement = settleConcession({ contract, charge, sales, bankedForThemMinor: Number(banked) });
        return { status: 200, body: { ...settlement, asAt: deps.now() } };
      },
    },
    {
      // May this counter trade today? Every blocker at once (expired / not-started / insurance / licence
      // / not-approved / inactive), with expiry warnings so a counter can be renewed before it shuts.
      api: 'API-09', method: 'GET', path: '/v1/concession/contracts/:contractId/may-trade',
      permission: 'concession.charge.read',
      handler: async (ctx) => {
        const contractId = ctx.params['contractId'] ?? '';
        const contract = await deps.contract(ctx.tenantId, contractId);
        if (contract === undefined) throw notFound(`concession contract ${contractId}`);
        const today = isDate(ctx.query['today']) ? (ctx.query['today'] as string) : deps.now().slice(0, 10);
        const warn = Number(ctx.query['warnWithinDays']);
        const decision = mayConcessionTrade({
          contract, today,
          ...(Number.isInteger(warn) && warn >= 0 ? { warnWithinDays: warn } : {}),
        });
        return { status: 200, body: { ...decision, asAt: deps.now() } };
      },
    },
    {
      // Record a deposit movement — a deposit is the concessionaire's money, a LIABILITY never rent. A
      // forfeit needs a named approver (the engine keeps an unapproved forfeit as a liability).
      api: 'API-09', method: 'POST', path: '/v1/concession/concessionaires/:concessionaireId/deposit-movements/:movementId',
      permission: 'concession.contract.manage', idempotent: true,
      handler: async (ctx) => {
        const concessionaireId = (ctx.params['concessionaireId'] ?? '').trim();
        const movementId = (ctx.params['movementId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (concessionaireId === '' || movementId === '' || typeof b['kind'] !== 'string'
          || !DEPOSIT_KINDS.includes(b['kind'] as DepositMovement['kind']) || !isPosMinor(b['amountMinor'])
          || (b['approvedBy'] !== undefined && typeof b['approvedBy'] !== 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_a_deposit_movement',
            whatHappened: 'A deposit movement needs concessionaireId + movementId in the path and { kind (received|refunded|forfeited), amountMinor (whole, ≥0), approvedBy? } in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the kind and amount. A forfeit needs a named approver to leave the liability.',
          });
        }
        const movement: DepositMovement = {
          movementId, concessionaireId, kind: b['kind'] as DepositMovement['kind'],
          amountMinor: b['amountMinor'] as number, at: deps.now(),
          ...(isStr(b['approvedBy']) ? { approvedBy: b['approvedBy'] as string } : {}),
        };
        await deps.recordDepositMovement(ctx.tenantId, movement);
        return { status: 201, body: { movementId, concessionaireId, kind: movement.kind, amountMinor: movement.amountMinor } };
      },
    },
    {
      // The deposit position, projected from movements — money owed back, with unapproved forfeits still
      // counted as a liability (the commonest small shop-in-shop fraud is a deposit booked as rent).
      api: 'API-09', method: 'GET', path: '/v1/concession/concessionaires/:concessionaireId/deposit',
      permission: 'concession.charge.read',
      handler: async (ctx) => {
        const concessionaireId = (ctx.params['concessionaireId'] ?? '').trim();
        if (concessionaireId === '') throw notFound('concessionaire (none named)');
        const movements = await deps.depositMovements(ctx.tenantId, concessionaireId);
        return { status: 200, body: { ...depositPosition({ concessionaireId, movements }), asAt: deps.now() } };
      },
    },
    {
      // Value ONLY the stock the store owns. Concession/consignment/customer stock on the store's
      // shelves belongs to somebody else; a valuation that includes it overstates the balance sheet, the
      // insurance schedule and the tax position at once. What is excluded is named + valued, never dropped.
      api: 'API-09', method: 'POST', path: '/v1/concession/valuation',
      permission: 'concession.charge.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const lots = b['lots'];
        if (!isStr(b['branchId']) || !Array.isArray(lots) || !lots.every(isLot)) {
          throw apiError(400, {
            code: 'not_readable_as_a_valuation',
            whatHappened: 'A valuation needs { branchId, lots[] (each with lotId, productId, branchId, whole qty ≥0, whole unitCostMinor, ownership (own|concession|consignment|customer_property), ownerId? } }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the branch and the lots to value. A valuation reads, it never writes.',
          });
        }
        return { status: 200, body: { ...valueOwnStock({ branchId: b['branchId'] as string, lots: lots as OwnedLot[] }), asAt: deps.now() } };
      },
    },
    {
      // May this actor touch this lot? A concessionaire may handle only their own stock; store staff may
      // sell the concession's on their behalf where the contract allows, but never adjust/write-off/count
      // it — somebody else's inventory written off by our staff is a bill we cannot argue with.
      api: 'API-09', method: 'POST', path: '/v1/concession/stock-access',
      permission: 'concession.charge.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isLot(b['lot']) || !isStr(b['actorId']) || typeof b['actorKind'] !== 'string'
          || !ACTOR_KINDS.includes(b['actorKind'] as typeof ACTOR_KINDS[number])
          || typeof b['action'] !== 'string' || !ACTIONS.includes(b['action'] as typeof ACTIONS[number])) {
          throw apiError(400, {
            code: 'not_readable_as_a_stock_access_check',
            whatHappened: 'A stock-access check needs { lot, actorId, actorKind (store_staff|concessionaire), action (view|sell|adjust|write_off|count), concessionaireId?, storeSellsOnBehalf? }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the lot, the actor and the action.',
          });
        }
        const decision = checkStockAccess({
          lot: b['lot'] as OwnedLot,
          actorId: b['actorId'] as string,
          actorKind: b['actorKind'] as typeof ACTOR_KINDS[number],
          action: b['action'] as typeof ACTIONS[number],
          ...(isStr(b['concessionaireId']) ? { concessionaireId: b['concessionaireId'] as string } : {}),
          ...(b['storeSellsOnBehalf'] === true ? { storeSellsOnBehalf: true } : {}),
        });
        return { status: 200, body: { ...decision } };
      },
    },
  ];
}
