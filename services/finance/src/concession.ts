// API-09 Concession — a partner trading a counter inside the store (M27). The one truth this surface
// exists to protect: **the money the store's tills take for a concession sale was NEVER the store's
// revenue.** It is money held on the partner's behalf, a liability the settlement discharges;
// presenting it as revenue and the payout as a cost inflates both sides of the P&L and makes every
// margin figure in the business wrong. The period charge (rent / revenue share / higher-of-both) is
// computed in exact integer money. The rule is the pure `computePeriodCharge` / `settleConcession` in
// `packages/concession` — another complete engine nothing fed on the cloud.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  computePeriodCharge, settleConcession,
  type ConcessionContract, type ConcessionSale, type ConcessionChargeBasis,
} from '../../../packages/concession/src/index';

export type { ConcessionContract, ConcessionSale } from '../../../packages/concession/src/index';

const BASES: readonly ConcessionChargeBasis[] = ['fixed_rent', 'revenue_share', 'higher_of_both'];
const TENDERED: readonly ConcessionSale['tenderedTo'][] = ['store_till', 'concessionaire_till'];
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));

export interface ConcessionDeps {
  readonly contract: (tenantId: string, contractId: string) => Promise<ConcessionContract | undefined> | ConcessionContract | undefined;
  readonly sales: (tenantId: string, contractId: string) => Promise<readonly ConcessionSale[]> | readonly ConcessionSale[];
  readonly recordContract: (tenantId: string, contract: ConcessionContract) => Promise<void> | void;
  readonly recordSale: (tenantId: string, sale: ConcessionSale) => Promise<void> | void;
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
          || !Number.isInteger(b['depositMinor']) || (b['depositMinor'] as number) < 0) {
          throw apiError(400, {
            code: 'not_readable_as_a_contract',
            whatHappened: 'A concession contract needs a concessionaire, name, branch, start/end dates, a basis (fixed_rent, revenue_share or higher_of_both) and a non-negative deposit.',
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
  ];
}
