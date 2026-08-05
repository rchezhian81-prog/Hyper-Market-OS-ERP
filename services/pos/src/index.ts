// API-05 POS — sales arriving from the lanes, and the exceptions they carry.
//
// The endpoint a till talks to after it has already sold something. Everything about the shape of
// this service follows from that: see `sale-intake.ts`.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { CatalogueProduct } from '../../../packages/catalogue/src/catalogue';
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
  readonly receiptNumbers: (tenantId: string) => Promise<ReadonlyMap<string, string>> | ReadonlyMap<string, string>;
  readonly bankedSaleIds: (tenantId: string) => Promise<ReadonlySet<string>> | ReadonlySet<string>;
  /** Append-only. A sale is never updated, so there is no `updateSale` port to call. */
  readonly bankSale: (tenantId: string, sale: IncomingSale) => Promise<void> | void;
  readonly recordExceptions: (tenantId: string, exceptions: readonly SaleException[]) => Promise<void> | void;
  readonly openExceptions: (tenantId: string) => Promise<readonly SaleException[]> | readonly SaleException[];
  readonly now: () => string;
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

        const intake = acceptSale(sale, {
          catalogue: await deps.catalogue(ctx.tenantId),
          currentPackVersion: await deps.currentPackVersion(ctx.tenantId),
          receiptNumbers: await deps.receiptNumbers(ctx.tenantId),
          alreadyBanked: await deps.bankedSaleIds(ctx.tenantId),
          now: deps.now(),
        } satisfies IntakeContext);

        if (!intake.alreadyBanked) {
          await deps.bankSale(ctx.tenantId, sale);
          if (intake.exceptions.length > 0) {
            await deps.recordExceptions(ctx.tenantId, intake.exceptions);
          }
        }

        // 202, not 201: the sale is banked and there may be work attached to it. A 4xx here would
        // tell a till that a sale which happened did not.
        return { status: 202, body: intake };
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
        const banked = await deps.bankedSaleIds(ctx.tenantId);
        const saleId = ctx.params['saleId'] ?? '';
        if (!banked.has(saleId)) throw notFound(`sale ${saleId}`);
        return { status: 200, body: { saleId, banked: true } };
      },
    },
  ];
}
