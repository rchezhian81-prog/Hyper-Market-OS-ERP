// API-05 POS — sales arriving from the lanes, and the exceptions they carry.
//
// The endpoint a till talks to after it has already sold something. Everything about the shape of
// this service follows from that: see `sale-intake.ts`.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { CatalogueProduct } from '../../../packages/catalogue/src/catalogue';
import { checkOperatorStamp } from '../../../packages/identity/src/till-seal';
import { assignSaleLots, type LotOnHand } from './sale-lots';
import { storeComputerTimeFrom, type StoreComputerScopeOfCaller } from './returns';
import { withoutCardData } from '../../../packages/tender/src/tender-card-data';
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
  /** Round 35 · NEW-6: whether a caller is a store computer (only its own time on a synced sale is kept). */
  readonly storeComputerScopeOf?: StoreComputerScopeOfCaller;
  /**
   * OB-35 "A": the batches on hand where this sale's stock is drawn from, earliest expiry first per product (Batch 2's
   * `fefoBatchesAt` over the batch projection). Absent → no assignment is made (the finding fires as before).
   */
  readonly lotsOnHand?: (tenantId: string, sale: IncomingSale) => Promise<(productId: string) => readonly LotOnHand[]>;
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
  /**
   * Hard rule #10 · OB-87 (verifier r18 OB85-1): the sale head office already banked under this id — so a sale that arrives
   * again under the same id with DIFFERENT content (a re-issued bill number) is a visible finding, never an "already
   * banked" resend. Absent → no comparison (a composition without the ledger).
   */
  readonly bankedSale?: (tenantId: string, saleId: string) => Promise<IncomingSale | undefined>;
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
  /**
   * L3 (B6): the scales head office's OWN register says weigh for this sale's lane (in the sale's store), with the last day
   * each stamp is valid — what a weighed line is judged against. Absent → the till's own scale evidence is judged.
   */
  readonly scalesOnRegisterFor?: (tenantId: string, sale: IncomingSale) => Promise<readonly { readonly assetId: string; readonly reverificationDueOn: string }[] | undefined>;
  /**
   * B13 (OB-138): for the HUIDs a sale carries, the OTHER banked sale each was already sold on. Absent → head office does
   * not judge a HUID sold twice (a composition without the sales ledger); a gold line with no HUID is still raised.
   */
  readonly huidsSoldElsewhere?: (tenantId: string, sale: IncomingSale) => Promise<ReadonlyMap<string, string>>;
  readonly loyaltySpendOnSale?: (tenantId: string, sale: IncomingSale) => Promise<readonly {
    readonly kind: string; readonly ref: string; readonly requestedMinor: number; readonly appliedMinor: number;
    readonly shortfallMinor: number; readonly alreadyApplied: boolean; readonly detail: string;
  }[]>;
}

/**
 * What makes a bill the SAME bill (hard rule #10): its number, time, total, lines and tenders — not what head office added
 * on banking (a batch assignment, a store stamped from the credential), so an honest resend always matches.
 */
export function billFingerprint(s: IncomingSale): string {
  return JSON.stringify([
    s.receiptNumber ?? null, s.committedAt, s.totalMinor,
    s.lines.map((l) => [l.productId, l.quantityMinor, l.unitPriceMinor, l.lineTotalMinor ?? null]),
    s.tenders.map((t) => [t.kind, t.amountMinor]),
  ]);
}

const TENDER_WORDS: Readonly<Record<string, string>> = {
  cash: 'cash', card: 'card', upi: 'UPI', store_credit: 'store credit', split: 'split', exchange_credit: 'exchange credit', loyalty_points: 'points',
  // OB-256: the mirror pilot's tender — its own words, never "cash" (P-08).
  paid_on_old_erp: 'paid on the old system',
};

/**
 * Verifier r21 IC-3 breadth: everything a NOT-banked bill carried that head office therefore did not apply — every payment
 * (with what it leaves open: the cash in that till's drawer counts over at shift close; an exchange credit leaves the
 * return's clearing open), every line's stock (not taken out at head office), and coupons (a coupon is redeemed centrally
 * before payment, so one redeemed for this sale id stays redeemed). Itemised so the person who banks it by hand settles
 * all of it, not only the loyalty.
 */
export function notBankedBillEffects(s: IncomingSale): string {
  const tenders = s.tenders.map((t) => `${TENDER_WORDS[t.kind] ?? t.kind} ${t.amountMinor}${t.kind === 'loyalty_points' && t.points !== undefined ? ` (${t.points} points)` : ''}`);
  const cash = s.tenders.filter((t) => t.kind === 'cash').reduce((n, t) => n + t.amountMinor, 0);
  const exchange = s.tenders.filter((t) => t.kind === 'exchange_credit').reduce((n, t) => n + t.amountMinor, 0);
  const lines = s.lines.map((l) => `${l.productId} × ${l.quantityMinor} ${l.uom}${l.batchId === undefined ? '' : ` (batch ${l.batchId})`}`);
  return [
    `Not applied at head office — payments: ${tenders.length === 0 ? 'none' : tenders.join(', ')}`,
    cash > 0 ? `the cash (${cash}) is in till ${s.laneId}'s drawer, which will count OVER by it at shift close until this bill is banked` : '',
    exchange > 0 ? `the exchange credit (${exchange}) was given against a return that IS banked, so its exchange clearing stays open by ${exchange} until this bill is banked` : '',
    `stock: ${lines.length === 0 ? 'no lines' : `${lines.join(', ')} — not taken out of stock at head office`}`,
    'coupons: any coupon redeemed for this sale id stays redeemed',
  ].filter((x) => x !== '').join('; ');
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
        const sent = readSale(ctx.body);
        if (sent === undefined) {
          // The one refusal in this service, and it is not a judgement about the sale — it is that
          // what arrived cannot be read as one, so there is nothing to bank.
          throw apiError(400, {
            code: 'not_readable_as_a_sale',
            whatHappened: 'This payload could not be read as a sale — it is missing an id, a total, a commit time, lines, tenders or a pack version.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not discard it at the lane. Keep it in the outbox and raise it — a sale that cannot be sent is still a sale that happened.',
          });
        }
        // Round 35 · NEW-6: the store computer's time for the bill is kept only from the store computer's own sign-in; from
        // anybody else it is dropped and the bill notes that it was offered and ignored (head office writes the note — one
        // sent in the body is never kept).
        const { storeComputerTakenAt: offered, storeComputerTakenAtIgnored: _claimed, ...rest } = sent;
        void _claimed;
        const time = await storeComputerTimeFrom(deps.storeComputerScopeOf, ctx.tenantId, ctx.userId, offered, deps.now());
        const arrived: IncomingSale = {
          ...rest,
          ...(time.ignored === undefined && offered !== undefined ? { storeComputerTakenAt: offered } : {}),
          ...(time.ignored === undefined ? {} : { storeComputerTakenAtIgnored: time.ignored }),
        };

        // OB-35 "A": a batch-tracked line the till sent with no batch is assigned the earliest-expiry batch on hand at the
        // store, recorded on the sale and marked as an assignment. Only on first banking — a resend keeps what was banked.
        // A till's own claim to an assignment is never trusted: it is dropped first.
        const unclaimed: IncomingSale = arrived.lines.some((l) => 'batchAssigned' in l)
          ? { ...arrived, lines: arrived.lines.map((l) => { const { batchAssigned: _a, ...rest } = l; void _a; return rest; }) }
          : arrived;
        const catalogue = await deps.catalogue(ctx.tenantId);
        const alreadyBanked = await deps.isBanked(ctx.tenantId, unclaimed.saleId);
        const sale = alreadyBanked || deps.lotsOnHand === undefined
          ? unclaimed
          : assignSaleLots(unclaimed, (p) => catalogue.get(p)?.batchTracked === true, await deps.lotsOnHand(ctx.tenantId, unclaimed)).sale;

        // Who rang it — re-verified from THEIR grants (SP-4b · F09): unknown is `null`, a finding; not looked up is absent.
        const cashierId = typeof sale.cashierId === 'string' ? sale.cashierId.trim() : '';
        const cashierGrants = deps.permissionsOfUser === undefined || cashierId === ''
          ? undefined
          : ((await deps.permissionsOfUser(ctx.tenantId, cashierId)) ?? null);
        // Whether the store computer vouches for that cashier: its seal over who it verified and this sale (ADR-0023).
        const cashierSeal = deps.tillSealKey === undefined || cashierId === '' ? undefined : checkOperatorStamp(deps.tillSealKey, {
          fact: 'sale', tenantId: ctx.tenantId, recordId: sale.saleId, amountMinor: sale.totalMinor, named: cashierId, stamp: sale.operatorVerified,
        });
        const laneScalesOnRegister = deps.scalesOnRegisterFor === undefined ? undefined : await deps.scalesOnRegisterFor(ctx.tenantId, sale);
        const huidsSoldElsewhere = deps.huidsSoldElsewhere === undefined || !sale.lines.some((l) => typeof l.huid === 'string' || catalogue.get(l.productId)?.regulatedFlags?.['gold'] === true)
          ? undefined : await deps.huidsSoldElsewhere(ctx.tenantId, sale);
        const intake = acceptSale(sale, {
          catalogue,
          ...(laneScalesOnRegister === undefined ? {} : { laneScalesOnRegister }),
          ...(huidsSoldElsewhere === undefined ? {} : { huidsSoldElsewhere }),
          currentPackVersion: await deps.currentPackVersion(ctx.tenantId),
          saleHoldingThisReceipt: await deps.saleHoldingReceipt(ctx.tenantId, sale.receiptNumber),
          alreadyBanked,
          now: deps.now(),
          ...(cashierGrants === undefined ? {} : { cashierGrants }),
          ...(cashierSeal === undefined ? {} : { cashierSeal }),
        } satisfies IntakeContext);

        // NEW-3 (C10 · hard rule #3): what is KEPT never holds card data. The intake above judged the sale as it arrived
        // (and raised what it found, by field name); from here on — the event store, loyalty, the findings — only the
        // tenders with the forbidden fields removed travel. The sale itself stands: it happened.
        const cleaned = withoutCardData(sale.tenders);
        const kept: IncomingSale = cleaned.removed.length === 0 ? sale : { ...sale, tenders: cleaned.tenders as IncomingSale['tenders'] };

        let notThisBill: Record<string, unknown> | undefined;
        // Verifier r20 IC-3: the bill loyalty follows — the one head office BANKED under this sale id. A different bill that
        // arrives under a banked id earns and spends nothing; its loyalty is raised for a person instead (below).
        let loyaltyBill: IncomingSale = kept;
        if (!intake.alreadyBanked) {
          await deps.bankSale(ctx.tenantId, kept);
          if (intake.exceptions.length > 0) {
            await deps.recordExceptions(ctx.tenantId, intake.exceptions);
          }
        } else if (deps.bankedSale !== undefined) {
          // Hard rule #10: "already banked" only when it IS the same bill. A different bill under a banked sale id (a box
          // that re-issued a number) is kept as a finding — head office keeps the first and says the second was not banked.
          const first = await deps.bankedSale(ctx.tenantId, sale.saleId);
          if (first !== undefined && billFingerprint(first) !== billFingerprint(sale)) {
            await deps.recordExceptions(ctx.tenantId, [{
              kind: 'receipt_number_reused', severity: 'material', saleId: sale.saleId, differenceMinor: sale.totalMinor - first.totalMinor,
              detail: `sale ${sale.saleId} (receipt ${sale.receiptNumber}) arrived again as a DIFFERENT bill — ${sale.totalMinor} against the ${first.totalMinor} head office banked under that id: the first stands and this one was NOT banked. ${notBankedBillEffects(kept)}`,
              ownerAction: 'A store computer gave one bill number to two different bills (a computer restored from a backup, or two computers on one till). The customer holds the second bill, which head office has not banked. Find it at the store computer, bank it by hand, and check that till\'s bill-number prefix. '
                + 'Settle ALL of it when you bank it: every payment listed (cash in that till\'s drawer, card and UPI, an exchange credit, points or store credit), its stock, and any coupon redeemed for this sale.',
            }]);
            // Verifier r19 IC-3: the answer says what happened — this bill was NOT banked (a different bill holds the id). Still
            // 202, so the store computer stops re-sending it; the owner's finding above is where it is worked. Loyalty below
            // follows the BANKED bill (idempotent per sale id: it never earns or spends twice for the id).
            loyaltyBill = first;
            // What the not-banked bill carried for loyalty (a member, points or store credit spent): raised, never applied —
            // a person who banks it by hand settles it (the same member code and tender amounts, never a phone number).
            const spentOnIt = kept.tenders.filter((t) => t.kind === 'loyalty_points' || t.kind === 'store_credit');
            const member = typeof sale.customerRef === 'string' && sale.customerRef.trim() !== '' ? sale.customerRef : undefined;
            if (member !== undefined || spentOnIt.length > 0) {
              await deps.recordExceptions(ctx.tenantId, [{
                kind: 'loyalty_on_a_bill_not_banked', severity: 'material', saleId: sale.saleId,
                differenceMinor: spentOnIt.reduce((n, t) => n + t.amountMinor, 0),
                detail: `sale ${sale.saleId} (receipt ${sale.receiptNumber}) arrived as a DIFFERENT bill from the one head office banked under that id, and it carried loyalty — ${member === undefined ? 'no member named' : `member ${member}`}${spentOnIt.length === 0 ? ', nothing spent' : `, spent ${spentOnIt.map((t) => `${t.kind === 'loyalty_points' ? 'points' : 'store credit'} worth ${t.amountMinor}`).join(' and ')}`}. None of it was earned or spent at head office: loyalty follows only the bill head office banked`,
                ownerAction: 'When this bill is banked by hand, settle its loyalty with it: take the points or store credit the customer spent at the till, and add the points it earns, for the member named. Until then the member\'s balance does not include it.',
              }]);
            }
            notThisBill = {
              alreadyBanked: false, thisBillBanked: false,
              notBankedBecause: 'a_different_bill_holds_this_sale_id',
              detail: `sale ${sale.saleId} is already held by a DIFFERENT bill that head office banked first (${first.totalMinor} against this ${sale.totalMinor}); this bill was NOT banked — it is on head office's sales findings as "receipt number reused" for a person to bank by hand`,
            };
          }
        }

        // Spending (PF-09 step 3): the points and store credit the till took off this bill leave the member's balances —
        // once, on a retry too. Before the earn, so the earn reads the balance the spend left. A shortfall (spent twice
        // across channels) is raised as a valued exception; a fault is said, never thrown (the sale is banked).
        let spends: unknown;
        if (deps.loyaltySpendOnSale !== undefined && loyaltyBill.tenders.some((t) => t.kind === 'loyalty_points' || t.kind === 'store_credit')) {
          try {
            const outcomes = await deps.loyaltySpendOnSale(ctx.tenantId, loyaltyBill);
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
            loyalty = await deps.loyaltyOnSale(ctx.tenantId, loyaltyBill);
          } catch (err) {
            loyalty = { outcome: 'not_recorded', detail: `The sale is banked, but its loyalty points were not recorded: ${err instanceof Error ? err.message : String(err)}. The till's resend will try again.` };
          }
        }

        // 202, not 201: the sale is banked and there may be work attached to it. A 4xx here would
        // tell a till that a sale which happened did not.
        return { status: 202, body: { ...intake, ...(loyalty === undefined ? {} : { loyalty }), ...(spends === undefined ? {} : { spends }), ...(notThisBill ?? {}), ...(time.ignored === undefined ? {} : { storeComputerTakenAtIgnored: time.ignored }) } };
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
