// API-03 Supplier claims — ONE register for everything claimed between the shop and a supplier over a delivery
// (U6 of the UI/UX gap audit, §27 "Purchase — claims": judged PARTIAL because the claims were spread over the goods
// receipt page and the rebates page; M07-FR-03 "supplier claim raised where due"; M24-FR-02 "a supplier raises claims").
//
// Nothing here is a second record. The shop's claims AGAINST a supplier are read from the supplier ACCOUNT fold
// (supplier-account.ts): a debit note a second person's disposition raised (short or damaged goods returned or claimed,
// valued at the delivered cost), the goods refused at the dock and never owed, a return still to go back, and the
// numbered debit notes raised at the DSD door. A supplier's claims ON the shop are the `claim` submissions it sent through
// the portal, each with the buyer's decision beside it. The register lays both sides out with their states, so the person
// who settles claims sees every one in one place — and acts through the routes that already exist (issue the debit note:
// supplier-master.ts; decide a supplier's claim: supplier-portal.ts review). Read only here.

import type { Route } from '../../kernel/src/index';
import { accountRegisters, foldAllSupplierAccounts, foldSupplierAccount, type SupplierAccountDeps, type SupplierAccountStatement } from './supplier-account';
import type { SubmissionRecord, SubmissionReview, SupplierClaimAgainst } from './supplier-portal';

export interface SupplierClaimsDeps {
  readonly account: SupplierAccountDeps;
  /** Every supplier the portal has met, and what each sent and how the buyer decided (M24-FR-02). Optional: no portal, no supplier-raised claims. */
  readonly partners?: (tenantId: string) => Promise<readonly string[]>;
  readonly submissions?: (tenantId: string, partnerId: string) => Promise<readonly SubmissionRecord[]> | readonly SubmissionRecord[];
  readonly reviews?: (tenantId: string, partnerId: string) => Promise<readonly SubmissionReview[]> | readonly SubmissionReview[];
  /** The supplier's name on the master, for the register's rows. */
  readonly supplierName?: (tenantId: string, supplierId: string) => Promise<string | undefined> | string | undefined;
  readonly now: () => string;
}

/** The shop's claims AGAINST one supplier, read from its account fold. Pure. */
export function claimsAgainstSupplier(a: SupplierAccountStatement): readonly SupplierClaimAgainst[] {
  const partnerId = a.supplierId;
  const notes = a.debitNotes.map((d): SupplierClaimAgainst => ({
    partnerId, claimId: d.debitNoteRef, kind: 'debit_note', grnId: d.grnId, poId: d.poId, productId: d.productId, quantityMinor: d.quantityMinor,
    valueMinor: d.valueMinor, reason: `${d.disposition}: ${d.reason}`, raisedAt: d.decidedAt, number: d.number, state: d.number === null ? 'raised' : 'issued',
  }));
  const refused = a.refusedNotOwed.map((r): SupplierClaimAgainst => ({
    partnerId, claimId: `refused-${r.grnId}-${r.lineId}`, kind: 'refused_at_door', grnId: r.grnId, poId: r.poId, productId: r.productId, quantityMinor: r.quantityMinor,
    valueMinor: r.valueMinor, reason: `${r.disposition}: refused at the dock, never received against the order, so never owed`, raisedAt: a.asAt, number: null, state: 'never_owed',
  }));
  const returns = a.pendingLineReturns.map((r): SupplierClaimAgainst => ({
    partnerId, claimId: `return-${r.grnId}-${r.lineId}`, kind: 'return_pending', grnId: r.grnId, poId: r.poId, productId: r.productId, quantityMinor: r.quantityMinor,
    valueMinor: r.valueMinor, reason: `goods to go back to the supplier (debit note ${r.debitNoteRef})`, raisedAt: r.decidedAt, number: null, state: r.returned ? 'returned' : 'pending',
  }));
  const door = a.doorDebitNotes.map((d): SupplierClaimAgainst => ({
    partnerId, claimId: d.debitNoteRef, kind: 'door_debit_note', grnId: d.checkInId, poId: null, productId: d.lines.length === 1 ? d.lines[0]!.productId : null,
    quantityMinor: d.lines.length === 1 ? d.lines[0]!.quantityMinor : null, valueMinor: d.valueMinor,
    reason: d.lines.map((l) => `${l.productId}: ${l.reason}`).join('; '), raisedAt: d.raisedAt, number: d.number, state: d.number === null ? 'raised' : 'issued',
  }));
  return [...notes, ...refused, ...returns, ...door];
}

/** A supplier's claim ON the shop, as the register reads a `claim` submission with the buyer's decision beside it. */
export interface SupplierRaisedClaim {
  readonly supplierId: string;
  readonly submissionId: string;
  readonly poId: string | null;
  readonly claimMinor: number | null;
  readonly why: string;
  readonly receivedAt: string;
  readonly submittedBy: string | null;
  readonly state: 'awaiting_buyer' | 'accepted' | 'rejected';
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly reason: string | null;
}

export function supplierRaisedClaim(partnerId: string, s: SubmissionRecord, review: SubmissionReview | undefined): SupplierRaisedClaim {
  const d = s.document ?? {};
  return {
    supplierId: partnerId, submissionId: s.submissionId, poId: typeof d['poId'] === 'string' ? d['poId'] : null,
    claimMinor: typeof d['claimMinor'] === 'number' ? d['claimMinor'] : null, why: typeof d['why'] === 'string' ? d['why'] : '',
    receivedAt: s.receivedAt, submittedBy: s.submittedBy ?? null,
    state: review === undefined ? 'awaiting_buyer' : review.decision, decidedBy: review?.reviewedBy ?? null, decidedAt: review?.reviewedAt ?? null, reason: review?.reason ?? null,
  };
}

/** The claims the shop holds against one supplier (for the portal's `/me/claims`). */
export async function claimsAgainst(deps: SupplierAccountDeps, tenantId: string, supplierId: string): Promise<readonly SupplierClaimAgainst[]> {
  return claimsAgainstSupplier(foldSupplierAccount({ ...(await accountRegisters(deps, tenantId)), supplierId }));
}

export function supplierClaimsRoutes(deps: SupplierClaimsDeps): readonly Route[] {
  return [
    {
      // The one register (U6 · M07-FR-03 · M24-FR-02): every claim between the shop and its suppliers, both sides, with the
      // state each is in and the counts — read from the account fold and the portal's submissions, never kept twice.
      api: 'API-03', method: 'GET', path: '/v1/purchase/supplier-claims',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const folded = foldAllSupplierAccounts(await accountRegisters(deps.account, t));
        const shopClaims = folded.accounts.flatMap((a) => claimsAgainstSupplier(a));
        const supplierClaims: SupplierRaisedClaim[] = [];
        if (deps.partners !== undefined && deps.submissions !== undefined) {
          for (const partnerId of await deps.partners(t)) {
            const reviews = (await deps.reviews?.(t, partnerId)) ?? [];
            for (const s of await deps.submissions(t, partnerId)) {
              if (s.kind !== 'claim') continue;
              supplierClaims.push(supplierRaisedClaim(partnerId, s, reviews.find((r) => r.submissionId === s.submissionId)));
            }
          }
        }
        const names: Record<string, string> = {};
        if (deps.supplierName !== undefined) {
          for (const id of new Set([...shopClaims.map((c) => c.partnerId), ...supplierClaims.map((c) => c.supplierId)])) {
            const name = await deps.supplierName(t, id);
            if (name !== undefined) names[id] = name;
          }
        }
        const counts = {
          raised: shopClaims.filter((c) => c.state === 'raised').length,
          issued: shopClaims.filter((c) => c.state === 'issued').length,
          neverOwed: shopClaims.filter((c) => c.state === 'never_owed').length,
          returnPending: shopClaims.filter((c) => c.state === 'pending').length,
          returned: shopClaims.filter((c) => c.state === 'returned').length,
          awaitingBuyer: supplierClaims.filter((c) => c.state === 'awaiting_buyer').length,
          accepted: supplierClaims.filter((c) => c.state === 'accepted').length,
          rejected: supplierClaims.filter((c) => c.state === 'rejected').length,
        };
        return {
          status: 200,
          body: {
            shopClaims: shopClaims.map(({ partnerId, ...c }) => ({ supplierId: partnerId, ...c })).sort((a, b) => (a.raisedAt < b.raisedAt ? 1 : -1)),
            supplierClaims: supplierClaims.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1)),
            counts, supplierNames: names, unattributed: folded.unattributed, asAt: deps.now(),
          },
        };
      },
    },
  ];
}
