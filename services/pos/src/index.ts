// API-05 POS — sales arriving from the lanes, and the exceptions they carry.
//
// The endpoint a till talks to after it has already sold something. Everything about the shape of
// this service follows from that: see `sale-intake.ts`.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { CatalogueProduct } from '../../../packages/catalogue/src/catalogue';
import { checkOperatorStamp } from '../../../packages/identity/src/till-seal';
import {
  acceptSale, summariseIntake,
  type IncomingSale, type IntakeContext, type IntakeResult, type SaleException,
} from './sale-intake';

export {
  acceptSale, summariseIntake,
  type IncomingSale, type IncomingSaleLine, type IncomingTender, type SaleExceptionKind,
  type ExceptionSeverity, type SaleException, type IntakeResult, type IntakeContext,
  type IntakeSummary,
} from './sale-intake';

export interface PosDeps {
  readonly catalogue: (tenantId: string) => Promise<ReadonlyMap<string, CatalogueProduct>> | ReadonlyMap<string, CatalogueProduct>;
  readonly currentPackVersion: (tenantId: string) => Promise<number> | number;
  /**
   * Two questions about one sale, rather than the whole history to search.
   *
   * `receiptNumbers(tenantId) => Map` and `bankedSaleIds(tenantId) => Set` were the previous
   * shapes, and they were a performance defect written into a **type**: a port that returns
   * everything can only be implemented by reading everything. The lane pays that on every scan,
   * and hard rule #1 is about the lane.
   */
  readonly saleHoldingReceipt: (tenantId: string, receiptNumber: string) => Promise<string | undefined> | string | undefined;
  readonly isBanked: (tenantId: string, saleId: string) => Promise<boolean> | boolean;
  /** Append-only. A sale is never updated, so there is no `updateSale` port to call. */
  readonly bankSale: (tenantId: string, sale: IncomingSale) => Promise<void> | void;
  readonly recordExceptions: (tenantId: string, exceptions: readonly SaleException[]) => Promise<void> | void;
  readonly openExceptions: (tenantId: string) => Promise<readonly SaleException[]> | readonly SaleException[];
  readonly now: () => string;
  /**
   * The permissions the named cashier holds through their grants; `undefined` when they hold none (an unknown name).
   * SP-4b · F09: the cashier a till names is re-verified here, never taken on the till's word (§28 · hard rule #4).
   * Absent → the intake raises no cashier finding (a composition that has no grants register).
   */
  readonly permissionsOfUser?: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  /**
   * The key head office checks the store computer's seal with (ADR-0023), derived from the pack signing key. Absent → no
   * seal is checked and no seal finding is raised (a composition without the key).
   */
  readonly tillSealKey?: Buffer;
  /**
   * What the sale does to the named member's loyalty points (PF-09-a · M17-FR-01): earn per the owner's rule, idempotent
   * on the sale. Never refuses — its outcome rides on the reply. Absent → no loyalty here (a composition without it).
   */
  readonly loyaltyOnSale?: (tenantId: string, sale: IncomingSale) => Promise<unknown>;
  /**
   * What the sale's points and store-credit tenders do to the member's balances (PF-09 step 3 · M17-FR-01/03): applied
   * once per sale and kind, never refused, never below zero. A part the true balance could not cover comes back as a
   * shortfall, which this route raises as a visible exception (hard rule #10). Absent → no spending here.
   */
  readonly loyaltySpendOnSale?: (tenantId: string, sale: IncomingSale) => Promise<readonly {
    readonly kind: string; readonly ref: string; readonly requestedMinor: number; readonly appliedMinor: number;
    readonly shortfallMinor: number; readonly alreadyApplied: boolean; readonly detail: string;
  }[]>;
}

/** Enough of a sale to be a sale. Anything beyond this is a finding, never a refusal. */
function readSale(body: unknown): IncomingSale | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const s = body as Partial<IncomingSale>;
  const structural = typeof s.saleId === 'string' && s.saleId.trim() !== ''
    && typeof s.totalMinor === 'number' && Number.isInteger(s.totalMinor)
    && typeof s.committedAt === 'string'
    && Array.isArray(s.lines) && Array.isArray(s.tenders)
    && typeof s.packVersion === 'number';
  return structural ? (s as IncomingSale) : undefined;
}

export function posRoutes(deps: PosDeps): readonly Route[] {
  return [
    {
      api: 'API-05', method: 'POST', path: '/v1/sales',
      permission: 'pos.sale.sync', idempotent: true,
      handler: async (ctx) => {
        const sale = readSale(ctx.body);
        if (sale === undefined) {
          // The one refusal in this service, and it is not a judgement about the sale — it is that
          // what arrived cannot be read as one, so there is nothing to bank.
          throw apiError(400, {
            code: 'not_readable_as_a_sale',
            whatHappened: 'This payload could not be read as a sale — it is missing an id, a total, a commit time, lines, tenders or a pack version.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not discard it at the lane. Keep it in the outbox and raise it — a sale that cannot be sent is still a sale that happened.',
          });
        }

        // Who rang it — re-verified from THEIR grants (SP-4b · F09): unknown is `null`, a finding; not looked up is absent.
        const cashierId = typeof sale.cashierId === 'string' ? sale.cashierId.trim() : '';
        const cashierGrants = deps.permissionsOfUser === undefined || cashierId === ''
          ? undefined
          : ((await deps.permissionsOfUser(ctx.tenantId, cashierId)) ?? null);
        // Whether the store computer vouches for that cashier: its seal over who it verified and this sale (ADR-0023).
        const cashierSeal = deps.tillSealKey === undefined || cashierId === '' ? undefined : checkOperatorStamp(deps.tillSealKey, {
          fact: 'sale', tenantId: ctx.tenantId, recordId: sale.saleId, amountMinor: sale.totalMinor, named: cashierId, stamp: sale.operatorVerified,
        });
        const intake = acceptSale(sale, {
          catalogue: await deps.catalogue(ctx.tenantId),
          currentPackVersion: await deps.currentPackVersion(ctx.tenantId),
          saleHoldingThisReceipt: await deps.saleHoldingReceipt(ctx.tenantId, sale.receiptNumber),
          alreadyBanked: await deps.isBanked(ctx.tenantId, sale.saleId),
          now: deps.now(),
          ...(cashierGrants === undefined ? {} : { cashierGrants }),
          ...(cashierSeal === undefined ? {} : { cashierSeal }),
        } satisfies IntakeContext);

        if (!intake.alreadyBanked) {
          await deps.bankSale(ctx.tenantId, sale);
          if (intake.exceptions.length > 0) {
            await deps.recordExceptions(ctx.tenantId, intake.exceptions);
          }
        }

        // Spending (PF-09 step 3): the points and store credit the till took off this bill leave the member's balances —
        // once, on a retry too. Before the earn, so the earn reads the balance the spend left. A shortfall (spent twice
        // across channels) is raised as a valued exception; a fault is said, never thrown (the sale is banked).
        let spends: unknown;
        if (deps.loyaltySpendOnSale !== undefined && sale.tenders.some((t) => t.kind === 'loyalty_points' || t.kind === 'store_credit')) {
          try {
            const outcomes = await deps.loyaltySpendOnSale(ctx.tenantId, sale);
            spends = outcomes;
            const short = outcomes.filter((o) => o.shortfallMinor > 0);
            if (short.length > 0) {
              await deps.recordExceptions(ctx.tenantId, [{
                kind: 'loyalty_value_spent_twice', severity: 'material', saleId: sale.saleId,
                differenceMinor: short.reduce((n, o) => n + o.shortfallMinor, 0),
                detail: short.map((o) => o.detail).join(' '),
                ownerAction: 'The customer has the goods and the value was spent twice across channels. Decide whether to recover it from the member or write it off; nothing was taken below zero.',
              }]);
            }
          } catch (err) {
            spends = { outcome: 'not_recorded', detail: `The sale is banked, but its points or store credit spend was not applied: ${err instanceof Error ? err.message : String(err)}. The till's resend will try again.` };
          }
        }

        // Loyalty (PF-09-a): earned once per sale, on a retry too (it is idempotent), so a crash between banking and
        // earning heals on the till's resend. It never touches the sale's answer — a fault here is said, not thrown.
        let loyalty: unknown;
        if (deps.loyaltyOnSale !== undefined) {
          try {
            loyalty = await deps.loyaltyOnSale(ctx.tenantId, sale);
          } catch (err) {
            loyalty = { outcome: 'not_recorded', detail: `The sale is banked, but its loyalty points were not recorded: ${err instanceof Error ? err.message : String(err)}. The till's resend will try again.` };
          }
        }

        // 202, not 201: the sale is banked and there may be work attached to it. A 4xx here would
        // tell a till that a sale which happened did not.
        return { status: 202, body: { ...intake, ...(loyalty === undefined ? {} : { loyalty }), ...(spends === undefined ? {} : { spends }) } };
      },
    },
    {
      api: 'API-05', method: 'GET', path: '/v1/sales/exceptions',
      permission: 'pos.exception.read',
      handler: async (ctx) => {
        const open = await deps.openExceptions(ctx.tenantId);
        return {
          status: 200,
          body: summariseIntake(open.map((e): IntakeResult => ({
            banked: true, saleId: e.saleId, exceptions: [e], alreadyBanked: false, detail: e.detail,
          }))),
        };
      },
    },
    {
      api: 'API-05', method: 'GET', path: '/v1/sales/:saleId',
      permission: 'pos.sale.read',
      handler: async (ctx) => {
        const saleId = ctx.params['saleId'] ?? '';
        if (!(await deps.isBanked(ctx.tenantId, saleId))) throw notFound(`sale ${saleId}`);
        return { status: 200, body: { saleId, banked: true } };
      },
    },
  ];
}
