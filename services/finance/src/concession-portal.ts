// API-09 — the CONCESSIONAIRE'S OWN LOGIN reads its own counter (M27-FR-02 "only the concessionaire accesses it" · M27-FR-03 ·
// OB-676 "A", owner, 2 Nov 2026, in writing · OB-76 · §35 · P-04 · hard rules #4 #6).
//
//   GET /v1/concession-portal/me/counters    its counters: each contract's terms, whether it may trade today, its deposit
//   GET /v1/concession-portal/me/sales       the sales recorded for its counters (the till's docket lines and the desk's)
//   GET /v1/concession-portal/me/stock       the stock on the shop's shelves that IT owns, by product and place
//   GET /v1/concession-portal/me/invoices    the concession invoices the shop issued to it
//
// The login is given through the outside-party flow (`/v1/identity/outside-logins/concessionaires/…`): one person who
// manages concessions invites a named person's login bound to the concessionaire's record, a DIFFERENT person approves it,
// and the sign-in is a one-time password shown once — no shared login, no password anywhere in the code (hard rule #4).
// The concessionaire is the one its APPROVED login is bound to, read from head office's own records — never the request:
// there is no concessionaire id to send. A request that names another (`?concessionaireId=`) is refused AND recorded (a
// look at a competitor's counter is not a slip of the finger). A revoked login is bound to nobody and reads nothing.
// Read-only: the concessionaire cannot change a contract, a sale, a stock line or an invoice from here.

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import {
  mayConcessionTrade, depositPosition, CONCESSION_WARN_DAYS,
  type ConcessionContract, type ConcessionSale, type DepositMovement,
} from '../../../packages/concession/src/index';
import { shopToday, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';
import type { ConcessionInvoice } from './concession-invoices';

/** One line of the concessionaire's own stock, as head office's movement ledger holds it (smallest steps; value at cost). */
export interface ConcessionStockLine {
  readonly productId: string;
  readonly locationId: string;
  readonly onHandMinor: number;
  readonly valueMinor: number;
}

export interface ConcessionPortalDeps {
  readonly calendar?: ShopCalendarOf;
  /** The concessionaire the caller's APPROVED outside login is bound to; undefined → bound to nobody (never invited, revoked). */
  readonly boundConcessionaire: (tenantId: string, userId: string) => Promise<string | undefined>;
  /** Every contract's latest terms (the portal keeps only the bound concessionaire's). */
  readonly contracts: (tenantId: string) => Promise<readonly ConcessionContract[]>;
  readonly sales: (tenantId: string, contractId: string) => Promise<readonly ConcessionSale[]>;
  readonly depositMovements: (tenantId: string, concessionaireId: string) => Promise<readonly DepositMovement[]>;
  /** The stock the ledger names as owned by this concessionaire (ownership `concession`, its owner id). */
  readonly stockOwnedBy: (tenantId: string, concessionaireId: string) => Promise<readonly ConcessionStockLine[]>;
  readonly invoices: (tenantId: string) => Promise<readonly ConcessionInvoice[]>;
  /** A cross-party ask is recorded (hard rule #6). */
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

export function concessionPortalRoutes(deps: ConcessionPortalDeps): readonly Route[] {
  /** The caller's own concessionaire — or a refusal. A `?concessionaireId=` naming another is refused and recorded. */
  const own = async (ctx: RequestContext, what: string): Promise<string> => {
    const bound = await deps.boundConcessionaire(ctx.tenantId, ctx.userId);
    if (bound === undefined) {
      throw apiError(403, {
        code: 'login_not_bound_to_a_concessionaire',
        whatHappened: 'This login is not bound to a concessionaire (it was never approved, or it was revoked), so there is nothing of yours to show.',
        wasItSaved: 'not_saved', nextSafeAction: 'Ask the shop to invite your login for your counter. Nothing was read.',
      });
    }
    const asked = typeof ctx.query['concessionaireId'] === 'string' ? ctx.query['concessionaireId'].trim() : '';
    if (asked !== '' && asked !== bound) {
      await deps.recordAudit?.(ctx.tenantId, {
        actorId: ctx.userId, action: 'concession_portal.other_party_refused', objectType: 'concessionaire', objectId: asked,
        at: deps.now(), origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
        before: null, after: { boundTo: bound, asked, read: what }, correlationId: `concession-portal-${ctx.userId}`,
      });
      throw apiError(403, {
        code: 'not_your_counter',
        whatHappened: 'You may see only your own counter. This request named another concessionaire; it was refused and recorded.',
        wasItSaved: 'not_saved', nextSafeAction: 'Open your own counter (no concessionaire needs to be named). Nothing was read.',
      });
    }
    return bound;
  };
  const contractsOf = async (tenantId: string, concessionaireId: string): Promise<readonly ConcessionContract[]> =>
    (await deps.contracts(tenantId)).filter((c) => c.concessionaireId === concessionaireId).sort((a, b) => a.contractId.localeCompare(b.contractId));

  return [
    {
      api: 'API-09', method: 'GET', path: '/v1/concession-portal/me/counters',
      permission: 'concession.portal.self', entitlement: 'dept.concession',
      handler: async (ctx) => {
        const concessionaireId = await own(ctx, 'counters');
        const today = await shopToday(deps, ctx.tenantId);
        const contracts = await contractsOf(ctx.tenantId, concessionaireId);
        return {
          status: 200,
          body: {
            concessionaireId, today,
            counters: contracts.map((contract) => ({ contract, trading: mayConcessionTrade({ contract, today, warnWithinDays: CONCESSION_WARN_DAYS }) })),
            deposit: depositPosition({ concessionaireId, movements: await deps.depositMovements(ctx.tenantId, concessionaireId) }),
            asAt: deps.now(),
          },
        };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/concession-portal/me/sales',
      permission: 'concession.portal.self', entitlement: 'dept.concession',
      handler: async (ctx) => {
        const concessionaireId = await own(ctx, 'sales');
        const sales: ConcessionSale[] = [];
        for (const c of await contractsOf(ctx.tenantId, concessionaireId)) sales.push(...(await deps.sales(ctx.tenantId, c.contractId)).filter((s) => s.concessionaireId === concessionaireId));
        sales.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.saleId.localeCompare(b.saleId)));
        return { status: 200, body: { concessionaireId, sales, grossMinor: sales.reduce((n, s) => n + s.grossMinor, 0), count: sales.length, asAt: deps.now() } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/concession-portal/me/stock',
      permission: 'concession.portal.self', entitlement: 'dept.concession',
      handler: async (ctx) => {
        const concessionaireId = await own(ctx, 'stock');
        const lines = [...(await deps.stockOwnedBy(ctx.tenantId, concessionaireId))].sort((a, b) => a.productId.localeCompare(b.productId) || a.locationId.localeCompare(b.locationId));
        return { status: 200, body: { concessionaireId, lines, valueMinor: lines.reduce((n, l) => n + l.valueMinor, 0), asAt: deps.now() } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/concession-portal/me/invoices',
      permission: 'concession.portal.self', entitlement: 'dept.concession',
      handler: async (ctx) => {
        const concessionaireId = await own(ctx, 'invoices');
        const invoices = (await deps.invoices(ctx.tenantId)).filter((i) => i.concessionaireId === concessionaireId).sort((a, b) => a.number.localeCompare(b.number));
        return { status: 200, body: { concessionaireId, invoices, asAt: deps.now() } };
      },
    },
  ];
}
