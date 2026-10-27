// HEAD OFFICE'S MAKER-CHECKER ENGINE (ADR-0024 · Wave 2b-vi · audit PA-03 · M02-FR-03 · §28 · hard rules #2, #5, #10).
//
// M02-FR-03: "Maker submits an action needing approval → engine routes to the authorized checker → checker approves /
// rejects with reason → action commits or is discarded → evidence recorded … A maker can never approve their own request;
// changing the amount of a pending request invalidates its approval." Head office never had the engine, so each module
// grew its own box where the person doing the work TYPED the approver's name — and the audit's triage found 26 routes
// that took that name as the approver's act. This is the engine they move onto:
//
//   1. the MAKER asks, in their own session (`POST /v1/approvals/requests`): what kind of action, on what, for how much,
//      a plain-words summary and why — and the exact details, which the engine FINGERPRINTS;
//   2. a CHECKER — anyone else who holds that kind's approval permission, never the maker — sees it in their inbox
//      (`GET /v1/approvals/requests`) and approves or rejects it with a reason, in THEIR own session
//      (`POST /v1/approvals/requests/:requestId/decide`);
//   3. the maker then does the action naming the approved request (`approvalId`); the action's route checks that it is
//      the same kind, the same subject, the same details (fingerprint), the same amount and the same maker; that it was
//      approved and has not expired; that the checker still holds the permission; and that it has not been used — then
//      spends it under its own guard, once, BEFORE the action is written: never an action without an approval, never
//      two actions with one. If the action then fails, nothing changed and the maker asks again.
//
// Value-limit routing (OB-290) and escalation by age (OB-292) are wired through `authorityOf` and `escalations` — the
// owner's money limits and waits, held on the server (`authority-limits.ts`, `approval-escalation.ts`).

import { createHash, randomUUID } from 'node:crypto';
import type { Route } from '../../kernel/src/index';
import { apiError, concurrentChange } from '../../kernel/src/index';
import { ConcurrencyConflictError } from '../../../packages/persistence/src/event-store';
import { limitedSubjectOf, mayApproveValue, authorityWords, type Authority } from '../../../packages/approvals/src/authority-rules';

/** One kind of action that needs a second person: who may ask, who may approve, how long an approval lasts. */
export interface ApprovalKind {
  readonly kind: string;
  /** What the action is, in the owner's words — shown in the inbox. */
  readonly label: string;
  /** The maker must hold this (the permission of the action itself). */
  readonly makerPermission: string;
  /** The checker must hold this, and must not be the maker. */
  readonly checkerPermission: string;
  /** How long an approval may wait to be used. */
  readonly validForMinutes: number;
}

/** The kinds the engine knows. Each slice that moves a route onto the engine adds its kind here. */
export const APPROVAL_KINDS: Readonly<Record<string, ApprovalKind>> = Object.freeze({
  supplier_bank_change: {
    kind: 'supplier_bank_change', label: 'Change where a supplier is paid',
    makerPermission: 'purchase.supplier.bank', checkerPermission: 'purchase.supplier.approve', validForMinutes: 24 * 60,
  },
  // The checker is ANOTHER person already authorised to import (owner, store manager) — each checks the other's work. A
  // dedicated "approve imports" authority would be new role policy, which is the owner's to set, not the engine's.
  data_import_commit: {
    kind: 'data_import_commit', label: 'Apply a bulk import',
    makerPermission: 'purchase.import.record', checkerPermission: 'purchase.import.record', validForMinutes: 24 * 60,
  },
  // SF-06-b (M03-FR-01 "Owner/Manager approve new category", OB-24 "A"): a manager proposes a category, the owner approves.
  category_define: {
    kind: 'category_define', label: 'Add or change a product category',
    makerPermission: 'catalogue.category.propose', checkerPermission: 'catalogue.category.approve', validForMinutes: 24 * 60,
  },
  // SF-06-a (M30-FR-04 "rollback approved"): undoing a committed load is approved by another person who may import.
  data_import_rollback: {
    kind: 'data_import_rollback', label: 'Undo a bulk import',
    makerPermission: 'purchase.import.record', checkerPermission: 'purchase.import.record', validForMinutes: 24 * 60,
  },
  // Pricing (2b-vi-b · M05-FR-02/04 · M12-FR-02): a loss-making price, list entry, promotion or quotation is approved by
  // someone holding the pricing-approval authority (`price.change.approve`) — "above the setter's authority".
  // OB-291 (owner, 23 Oct 2026): also a change larger than the set size — more than 10% or more than ₹50 a unit.
  price_change: {
    kind: 'price_change', label: 'Change a price by more than the set size, or below cost or the margin floor',
    makerPermission: 'price.change.propose', checkerPermission: 'price.change.approve', validForMinutes: 24 * 60,
  },
  price_list_entry: {
    kind: 'price_list_entry', label: 'Add a price-list entry below cost or below the margin floor',
    makerPermission: 'price.change.propose', checkerPermission: 'price.change.approve', validForMinutes: 24 * 60,
  },
  promotion_launch: {
    kind: 'promotion_launch', label: 'Launch a promotion that loses margin',
    makerPermission: 'promotion.launch', checkerPermission: 'price.change.approve', validForMinutes: 24 * 60,
  },
  quotation_below_floor: {
    kind: 'quotation_below_floor', label: 'Quote a customer below the margin floor',
    makerPermission: 'pos.quotation.write', checkerPermission: 'price.change.approve', validForMinutes: 24 * 60,
  },
  // Finance (2b-vi-b-2 · M23-FR-04 "period close/reopen by Finance with approval"): the person who closes or reopens a
  // month asks; someone holding the authority to SIGN a period (`finance.period.sign` — the accountant, the CA, the
  // owner) approves — the signature that certifies the control totals is that person's own act.
  period_close: {
    kind: 'period_close', label: 'Close and sign an accounting month',
    makerPermission: 'finance.period.close', checkerPermission: 'finance.period.sign', validForMinutes: 24 * 60,
  },
  period_reopen: {
    kind: 'period_reopen', label: 'Reopen a signed accounting month',
    makerPermission: 'finance.period.close', checkerPermission: 'finance.period.sign', validForMinutes: 24 * 60,
  },
  // Concessions (M27-FR-01 "contracts approved"; a forfeit takes a deposit off the liability): the checker is ANOTHER
  // person already authorised to manage concession contracts (owner, accountant) — a dedicated approval authority would
  // be new role policy, which is the owner's to set.
  concession_contract: {
    kind: 'concession_contract', label: 'Approve a concession contract',
    makerPermission: 'concession.contract.manage', checkerPermission: 'concession.contract.manage', validForMinutes: 24 * 60,
  },
  concession_deposit_forfeit: {
    kind: 'concession_deposit_forfeit', label: 'Forfeit a concessionaire\'s deposit',
    makerPermission: 'concession.contract.manage', checkerPermission: 'concession.contract.manage', validForMinutes: 24 * 60,
  },
  // Stock, orders and purchasing (2b-vi-b-3). Each checker is the authority the route already named — now verified as an
  // approval that person GAVE, never a name in the body. A material write-off and an upward stock correction are
  // checked by ANOTHER person who handles stock (M28-FR-01 "Manager/Owner"; the same authority the write-off already
  // required), never the one who raised it.
  stock_write_off: {
    kind: 'stock_write_off', label: 'Write off stock (a material loss)',
    makerPermission: 'inventory.movement.append', checkerPermission: 'inventory.movement.append', validForMinutes: 24 * 60,
  },
  stock_adjustment_up: {
    kind: 'stock_adjustment_up', label: 'Correct stock upward',
    makerPermission: 'inventory.movement.append', checkerPermission: 'inventory.movement.append', validForMinutes: 24 * 60,
  },
  order_refund: {
    kind: 'order_refund', label: 'Refund an online order',
    makerPermission: 'order.refund.issue', checkerPermission: 'order.refund.approve', validForMinutes: 24 * 60,
  },
  // FUL-14 (M19-FR-01 · M18-FR-04): charging a dearer substitute ABOVE the original line price needs the customer's own
  // yes AND a second person with authority over online-order money — the same authority that approves an order refund.
  substitution_above_cap: {
    kind: 'substitution_above_cap', label: 'Charge a dearer substitute above the original price',
    makerPermission: 'order.lifecycle.manage', checkerPermission: 'order.refund.approve', validForMinutes: 24 * 60,
  },
  service_compensation: {
    kind: 'service_compensation', label: 'Give a customer compensation above the desk\'s own limit',
    makerPermission: 'service.case.manage', checkerPermission: 'service.compensation.approve', validForMinutes: 24 * 60,
  },
  supplier_invoice_check: {
    kind: 'supplier_invoice_check', label: 'Check a supplier bill',
    makerPermission: 'purchase.invoice.capture', checkerPermission: 'purchase.invoice.match', validForMinutes: 24 * 60,
  },
  supplier_payment: {
    kind: 'supplier_payment', label: 'Pay a supplier',
    makerPermission: 'purchase.supplier.pay', checkerPermission: 'purchase.supplier.pay', validForMinutes: 24 * 60,
  },
  // A supplier's commercial terms (2b-vi-c-1). Each was stored with a typed "approved by" that cleared its review finding.
  // The approver is the Purchase Approver / Finance authority M06-FR-01 names for approving a supplier
  // (`purchase.supplier.approve` — the accountant and the owner today). For a display contract this is D02-FR-06's
  // "Finance approves funding terms". The person who records the terms asks; a different person approves.
  display_contract: {
    kind: 'display_contract', label: 'Approve a supplier\'s display-space funding',
    makerPermission: 'merchandising.display.manage', checkerPermission: 'purchase.supplier.approve', validForMinutes: 24 * 60,
  },
  rebate_scheme: {
    kind: 'rebate_scheme', label: 'Approve a supplier rebate scheme',
    makerPermission: 'purchase.contract.manage', checkerPermission: 'purchase.supplier.approve', validForMinutes: 24 * 60,
  },
  // D03-FR-03 · §28 "Finance approves rebate claims" (OB-404, owner, 27 Oct 2026, option A): the person who keeps the
  // supplier schemes raises a claim; Finance (`purchase.supplier.approve` — the accountant and the owner, the same Finance
  // authority that approves a rebate scheme) approves exactly that claim — supplier, scheme and amount — before it is sent.
  rebate_claim: {
    kind: 'rebate_claim', label: 'Approve a supplier rebate claim before it is sent',
    makerPermission: 'purchase.contract.manage', checkerPermission: 'purchase.supplier.approve', validForMinutes: 24 * 60,
  },
  purchase_contract: {
    kind: 'purchase_contract', label: 'Approve a supplier contract',
    makerPermission: 'purchase.contract.manage', checkerPermission: 'purchase.supplier.approve', validForMinutes: 24 * 60,
  },
  // Access (2b-vi-c-2 · M02-FR-04): "Store/HR manager (request/confirm), Owner (approve emergency access) … separation
  // between requester and granter (§28)". The person ASKING was a name typed by the approver; now the requester asks in
  // their own session (`identity.role.request`) and the owner approves in theirs (`identity.role.grant`), never their own.
  emergency_access: {
    kind: 'emergency_access', label: 'Give someone emergency access for a short time',
    makerPermission: 'identity.role.request', checkerPermission: 'identity.role.grant', validForMinutes: 24 * 60,
  },
  access_change: {
    kind: 'access_change', label: 'Change a person\'s access (joining, moving or leaving)',
    makerPermission: 'identity.role.request', checkerPermission: 'identity.role.grant', validForMinutes: 24 * 60,
  },
  // Branches (PA-04 · M01-FR-04 "every transition except reopening needs the owner's approval; the person executing is
  // never the person approving"): the manager or owner who carries out the opening/closing asks; the OWNER approves
  // (`branch.transition.approve` — the owner's alone, like every other domain's approve authority).
  // D14 / M32 round 10: sending the shop's business events to a partner — another person with setup rights approves
  // exactly the subscription (who, where, which events, which signing key), never the person who set it up.
  partner_webhook_subscription: {
    kind: 'partner_webhook_subscription', label: 'Send the shop\'s business events to a partner',
    makerPermission: 'platform.setup.write', checkerPermission: 'platform.setup.write', validForMinutes: 24 * 60,
  },
  branch_transition: {
    kind: 'branch_transition', label: 'Open, close for now, or close a branch for good',
    makerPermission: 'branch.transition.execute', checkerPermission: 'branch.transition.approve', validForMinutes: 24 * 60,
  },
  // Round 26 · OB-97 "B" (owner, 13 Oct 2026): a head office business person (all stores, never IT) moves a till's bill-number
  // prefix to a replacement store computer; the OWNER approves (`store.computer.replace.approve` — the owner's alone).
  // L2 (B6 integrity): an existing weighing scale's Legal Metrology stamp dates decide whether its lanes may weigh. The
  // checker is ANOTHER person already authorised to manage facilities assets (the owner checks the store manager, and the
  // other way round) — a dedicated approval authority would be new role policy, which is the owner's to set.
  scale_stamp_change: {
    kind: 'scale_stamp_change', label: 'Change a weighing scale\'s stamp date',
    makerPermission: 'facilities.asset.manage', checkerPermission: 'facilities.asset.manage', validForMinutes: 24 * 60,
  },
  store_computer_replaced: {
    kind: 'store_computer_replaced', label: 'Move a till\'s bill numbers to a replacement store computer',
    makerPermission: 'store.computer.replace', checkerPermission: 'store.computer.replace.approve', validForMinutes: 24 * 60,
  },
  // R2 C20 · OB-165 "A" (owner, 16 Oct 2026): the OWNER adds or removes an Internal Committee member (that role only); a
  // second person who takes part in access changes (`identity.role.request` — a store manager today) confirms it.
  posh_committee_change: {
    kind: 'posh_committee_change', label: 'Add or remove an Internal Committee member',
    makerPermission: 'posh.committee.manage', checkerPermission: 'identity.role.request', validForMinutes: 24 * 60,
  },
  // ── OB-288 lane 1 · P1 (identity, authority and configuration governance) — begin
  // OB-290/291/292: the owner's money limits, escalation waits and price-check size change only through a second person —
  // the OWNER approves (`approvals.rules.approve`); §28 "Store Manager … cannot modify … own approval limits".
  approval_rule_change: {
    kind: 'approval_rule_change', label: 'Change an approval rule (money limits, escalation waits or the price-check size)',
    makerPermission: 'approvals.rules.propose', checkerPermission: 'approvals.rules.approve', validForMinutes: 24 * 60,
  },
  // M01-FR-01 "structural changes are owner-approved (maker-checker)": activating, suspending or closing a place in the
  // business, or changing one that is already live.
  org_structure_change: {
    kind: 'org_structure_change', label: 'Activate, change or close a company, branch, warehouse or department',
    makerPermission: 'platform.setup.write', checkerPermission: 'org.structure.approve', validForMinutes: 24 * 60,
  },
  // M01-FR-02/03: a high-impact setting (trading day, currency, time zone, payments, pricing, offline limits) or switch.
  config_change: {
    kind: 'config_change', label: 'Change a high-impact setting',
    makerPermission: 'platform.setup.write', checkerPermission: 'platform.config.approve', validForMinutes: 24 * 60,
  },
  flag_change: {
    kind: 'flag_change', label: 'Turn a high-impact switch on or off',
    makerPermission: 'platform.flag.write', checkerPermission: 'platform.config.approve', validForMinutes: 24 * 60,
  },
  // OB-407 (owner, 27 Oct 2026, in writing — option B · D14-FR-05 · R8-7 · §8.2): switching ON a floor device (cameras, shelf
  // labels, RFID readers, sensors) needs, besides the owner's `flag_change`, the NAMED security reviewer's signature (OB-330 /
  // OB-405), given in the reviewer's own session. The engine lets anyone who may read the risk register decide it; the
  // rollout route counts it only when the decider is the reviewer named NOW, and never the person switching or the owner
  // who approved (services/platform/src/rollout.ts).
  floor_device_review: {
    kind: 'floor_device_review', label: 'Sign as the security reviewer: switch on cameras, shelf labels, RFID or sensors',
    makerPermission: 'platform.flag.write', checkerPermission: 'compliance.risk.read', validForMinutes: 24 * 60,
  },
  // M02-FR-02 · §28 "Department Manager — assigned departments": limiting a person's role to some departments.
  department_scope_change: {
    kind: 'department_scope_change', label: 'Limit a person\'s role to some departments',
    makerPermission: 'identity.role.request', checkerPermission: 'identity.role.grant', validForMinutes: 24 * 60,
  },
  // FG-4 · M02-FR-02 · §28 "Purchase User — assigned suppliers/categories", "Receiver/QC, Warehouse User — assigned
  // locations": limiting a person's role to some suppliers, categories or locations inside a branch.
  role_scope_change: {
    kind: 'role_scope_change', label: 'Limit a person\'s role to some suppliers, categories or locations',
    makerPermission: 'identity.role.request', checkerPermission: 'identity.role.grant', validForMinutes: 24 * 60,
  },
  // ── OB-288 lane 1 · P1 — end
  // ── OB-288 P2 (catalogue, pricing and product legal guards) — begin
  // M03.md "Permissions (§28): tax change with Finance approval": a new GST rate on an HSN class that already has one is
  // asked by the person who keeps the catalogue and approved by Finance (`catalogue.tax.approve`: the accountant, the owner).
  tax_rate_change: {
    kind: 'tax_rate_change', label: 'Change the GST rate of an HSN class',
    makerPermission: 'catalogue.pack.publish', checkerPermission: 'catalogue.tax.approve', validForMinutes: 24 * 60,
  },
  // M05-FR-04 · D02-FR-06 pattern: a supplier's funding of a promotion is approved by Finance, like a display contract.
  promotion_funding: {
    kind: 'promotion_funding', label: 'Approve a supplier\'s funding of a promotion',
    makerPermission: 'promotion.launch', checkerPermission: 'purchase.supplier.approve', validForMinutes: 24 * 60,
  },
  // ── OB-288 P2 — end
  // ── OB-288 till side — begin
  // OB-347 (owner, 24 Oct 2026, in writing): changing a PUBLISHED product's tax (HSN) class is asked by the person who keeps
  // the catalogue and approved by Finance (`catalogue.tax.approve`: the accountant or the owner) — never the maker.
  hsn_class_change: {
    kind: 'hsn_class_change', label: 'Change the tax (HSN) class of a published product',
    makerPermission: 'catalogue.pack.publish', checkerPermission: 'catalogue.tax.approve', validForMinutes: 24 * 60,
  },
  // ── OB-288 till side — end
  // ── OB-288 commercial desks (M22 · M24 · M27) — begin
  // M22-FR-01 "contract/credit changes approved": a B2B contract (its price list, dates, terms, credit limit, expiry policy)
  // is proposed by one contract manager and approved by ANOTHER (the owner and the accountant check each other) — the
  // concession-contract pattern; a dedicated approval authority would be new role policy, the owner's to set.
  b2b_contract: {
    kind: 'b2b_contract', label: 'Approve a business customer\'s contract (prices, dates, credit and terms)',
    makerPermission: 'b2b.contract.manage', checkerPermission: 'b2b.contract.manage', validForMinutes: 24 * 60,
  },
  // M22-FR-01 "an order exceeding the credit limit is blocked pending approval" · OB-290 (owner, 23 Oct 2026): above a
  // person's limit goes to the owner — the person taking the order asks; the OWNER (`b2b.credit.override`) decides.
  b2b_credit_override: {
    kind: 'b2b_credit_override', label: 'Let a business order go over the customer\'s credit limit (or past a lapsed contract)',
    makerPermission: 'b2b.document.issue', checkerPermission: 'b2b.credit.override', validForMinutes: 24 * 60,
  },
  // OB-360 (owner, 24–25 Oct 2026, in writing): EVERY change of a B2B credit limit (or the terms set with it) goes through
  // the engine with a second person, like a contract's limit — the owner and the accountant check each other.
  b2b_credit_limit: {
    kind: 'b2b_credit_limit', label: 'Set or change a business customer\'s credit limit (and payment terms)',
    makerPermission: 'b2b.account.manage', checkerPermission: 'b2b.account.manage', validForMinutes: 24 * 60,
  },
  // ── OB-288 commercial desks — end
  // ── OB-288 P4 (multi-tenant SaaS and rollout) — begin
  // M36-FR-03 "closure is governed/approved": closing the shop's account is asked by the IT administrator and approved by
  // the owner (the OB-335 pattern: IT asks, the owner approves a structural change) — never the asker.
  tenant_closure: {
    kind: 'tenant_closure', label: 'Close this shop\'s account (access ends; the law\'s records and the audit are kept)',
    makerPermission: 'platform.tenant.close', checkerPermission: 'platform.tenant.close.approve', validForMinutes: 24 * 60,
  },
  // ── OB-288 P4 — end
});

/** A maker's request, as recorded. */
export interface ApprovalRequest {
  readonly requestId: string;
  readonly kind: string;
  readonly subjectRef: string;
  /** The amount it is for, in paise; null when the action moves no money. Changing it voids the approval. */
  readonly valueMinor: number | null;
  /** SHA-256 over the exact details the maker asked for. Changing any detail voids the approval. */
  readonly fingerprint: string;
  /** The details as asked — shown to the checker, so they approve what will actually happen. */
  readonly details: Readonly<Record<string, unknown>>;
  readonly summary: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
}

/** A checker's decision on a request. */
export interface ApprovalDecision {
  readonly requestId: string;
  readonly decision: 'approved' | 'rejected';
  readonly decidedBy: string;
  readonly reason: string;
  readonly decidedAt: string;
  /** Approved only: after this it can no longer be used. */
  readonly expiresAt: string | null;
}

/** A request, its decision once made, and the action that used it once it has been. */
export interface ApprovalState {
  readonly request: ApprovalRequest;
  readonly decision?: ApprovalDecision;
  readonly usedBy?: string;
}

export interface ApprovalRequestDeps {
  readonly recordRequest: (tenantId: string, request: ApprovalRequest) => Promise<void> | void;
  /** Append a decision under the request's own guard, read before the decision was judged (`expectedVersion`), and
   *  resolve the decision that STANDS — another checker's, when theirs landed first at the same moment. */
  readonly recordDecision: (tenantId: string, decision: ApprovalDecision, expectedVersion: number) => Promise<ApprovalDecision | void> | ApprovalDecision | void;
  readonly approvalState: (tenantId: string, requestId: string) => Promise<ApprovalState | undefined> | ApprovalState | undefined;
  readonly approvalVersion: (tenantId: string, requestId: string) => Promise<number> | number;
  readonly allRequests: (tenantId: string) => Promise<readonly ApprovalState[]> | readonly ApprovalState[];
  /** The permissions a person holds; `undefined` when head office does not know them. */
  readonly permissionsOfUser: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  /**
   * OB-290 (owner, 23 Oct 2026): the CHECKER's money authority for a kind, held on the server — a refund, purchase order or
   * stock adjustment above it is not theirs to approve and goes to the owner. Optional on a bare stub (then no money limit
   * is applied, as before).
   */
  readonly authorityOf?: (tenantId: string, userId: string, subjectType: string) => Promise<Authority>;
  /** OB-292: the requests escalated to the owner by age — when, and after how long. Optional on a bare stub. */
  readonly escalations?: (tenantId: string) => Promise<ReadonlyMap<string, ApprovalEscalationView>>;
  readonly now: () => string;
}

/** An age escalation as the inbox shows it (OB-292). */
export interface ApprovalEscalationView {
  readonly escalatedAt: string;
  readonly waitedMinutes: number;
  readonly waitMinutes: number;
  readonly escalatedTo: 'owner';
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** A stable text for any JSON value: object keys sorted, so the same details always fingerprint the same. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

/** The fingerprint of an action's exact details — the maker's request and the action's route compute it the same way. */
export function fingerprintOf(details: unknown): string {
  return createHash('sha256').update(canonical(details), 'utf8').digest('hex');
}

const notPermitted = (what: string): Error => apiError(403, {
  code: 'not_permitted_for_this_approval',
  whatHappened: what,
  wasItSaved: 'not_saved',
  nextSafeAction: 'Nothing was recorded. Someone who holds that authority must do it.',
});

export function approvalRequestRoutes(deps: ApprovalRequestDeps): readonly Route[] {
  const holds = async (tenantId: string, userId: string, permission: string): Promise<boolean> =>
    ((await deps.permissionsOfUser(tenantId, userId)) ?? []).includes(permission);

  return [
    {
      // The maker asks, in their own session. Gated per kind on the action's own permission (checked below); the route
      // itself needs only a signed-in member of the shop.
      api: 'API-01', method: 'POST', path: '/v1/approvals/requests',
      permission: 'identity.self.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body !== null && typeof ctx.body === 'object' ? ctx.body : {}) as Record<string, unknown>;
        const spec = isStr(b['kind']) ? APPROVAL_KINDS[b['kind'].trim()] : undefined;
        const valueMinor = b['valueMinor'] === undefined || b['valueMinor'] === null ? null
          : (typeof b['valueMinor'] === 'number' && Number.isSafeInteger(b['valueMinor']) && b['valueMinor'] >= 0 ? b['valueMinor'] : undefined);
        const details = b['details'] !== null && typeof b['details'] === 'object' && !Array.isArray(b['details']) ? b['details'] as Record<string, unknown> : undefined;
        if (spec === undefined || !isStr(b['subjectRef']) || valueMinor === undefined || details === undefined || !isStr(b['summary']) || !isStr(b['reason'])) {
          throw apiError(400, {
            code: 'not_readable_as_an_approval_request',
            whatHappened: `An approval request names a known kind (${Object.keys(APPROVAL_KINDS).join(', ')}), what it is about (subjectRef), the exact details of the action, a plain-words summary and why; an amount in whole paise when it moves money.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was asked. Send those.',
          });
        }
        if (!(await holds(ctx.tenantId, ctx.userId, spec.makerPermission))) {
          throw notPermitted(`${ctx.userId} may not ${spec.label.toLowerCase()}, so cannot ask for it to be approved.`);
        }
        const request: ApprovalRequest = {
          requestId: `areq-${randomUUID()}`, kind: spec.kind, subjectRef: b['subjectRef'].trim(), valueMinor,
          fingerprint: fingerprintOf(details), details, summary: b['summary'].trim().slice(0, 300), reason: b['reason'].trim().slice(0, 300),
          requestedBy: ctx.userId, requestedAt: deps.now(),
        };
        await deps.recordRequest(ctx.tenantId, request);
        return { status: 201, body: { ...request, status: 'waiting' } };
      },
    },
    {
      // The inbox: what waits for the caller to decide (kinds they may approve, never their own), and what they asked.
      api: 'API-01', method: 'GET', path: '/v1/approvals/requests',
      permission: 'identity.self.read',
      handler: async (ctx) => {
        const held = (await deps.permissionsOfUser(ctx.tenantId, ctx.userId)) ?? [];
        const now = Date.parse(deps.now());
        const all = await deps.allRequests(ctx.tenantId);
        const escalated = (await deps.escalations?.(ctx.tenantId)) ?? new Map<string, ApprovalEscalationView>();
        const view = (s: ApprovalState) => ({
          ...s.request, status: statusOf(s, now),
          ...(s.decision === undefined ? {} : { decidedBy: s.decision.decidedBy, decisionReason: s.decision.reason, decidedAt: s.decision.decidedAt, expiresAt: s.decision.expiresAt }),
          ...(s.usedBy === undefined ? {} : { usedBy: s.usedBy }),
          label: APPROVAL_KINDS[s.request.kind]?.label ?? s.request.kind,
          // OB-292: an approval that waited past its kind's time has gone to the owner — said on the row, never silent.
          ...(escalated.has(s.request.requestId) ? { escalation: escalated.get(s.request.requestId)! } : {}),
        });
        const open = all.filter((s) => s.decision === undefined && s.request.requestedBy !== ctx.userId
          && held.includes(APPROVAL_KINDS[s.request.kind]?.checkerPermission ?? '\u0000'));
        // OB-290: a request above the caller's money limit is not theirs to approve — it is routed to the owner, and the
        // caller is told how many went there (never a silently shorter list, P-08).
        const mineToDecide: ApprovalState[] = []; let routedToOwner = 0;
        for (const s of open) {
          const subject = limitedSubjectOf(s.request.kind);
          if (deps.authorityOf !== undefined && subject !== undefined && s.request.valueMinor !== null
            && !mayApproveValue(await deps.authorityOf(ctx.tenantId, ctx.userId, s.request.kind), s.request.valueMinor)) { routedToOwner += 1; continue; }
          mineToDecide.push(s);
        }
        const mine = all.filter((s) => s.request.requestedBy === ctx.userId).map(view);
        return { status: 200, body: { waitingForMe: mineToDecide.map(view), mine, routedToOwnerAboveYourLimit: routedToOwner, asAt: deps.now() } };
      },
    },
    {
      // The checker decides, in their own session — never the maker (§28), always with a reason (M02-FR-03).
      api: 'API-01', method: 'POST', path: '/v1/approvals/requests/:requestId/decide',
      permission: 'identity.self.read', idempotent: true,
      handler: async (ctx) => {
        const requestId = ctx.params['requestId'] ?? '';
        const b = (ctx.body !== null && typeof ctx.body === 'object' ? ctx.body : {}) as Record<string, unknown>;
        const decision = b['decision'] === 'approved' || b['decision'] === 'rejected' ? b['decision'] : undefined;
        if (decision === undefined || !isStr(b['reason'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_decision', whatHappened: 'A decision is "approved" or "rejected", with a reason (M02-FR-03).',
            wasItSaved: 'not_saved', nextSafeAction: 'Nothing was decided. Send the decision and why.',
          });
        }
        // The request's guard first, then the request it protects — so two checkers deciding at once cannot both win.
        const version = await Promise.resolve(deps.approvalVersion(ctx.tenantId, requestId));
        const state = await Promise.resolve(deps.approvalState(ctx.tenantId, requestId));
        if (state === undefined) {
          throw apiError(404, { code: 'not_found', whatHappened: `There is no approval request ${requestId}.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the request in your inbox.' });
        }
        const spec = APPROVAL_KINDS[state.request.kind];
        if (spec === undefined || !(await holds(ctx.tenantId, ctx.userId, spec.checkerPermission))) {
          throw notPermitted(`${ctx.userId} may not approve "${spec?.label ?? state.request.kind}".`);
        }
        if (state.request.requestedBy === ctx.userId) {
          throw apiError(422, {
            code: 'self_approval', whatHappened: `${ctx.userId} asked for this and cannot also decide it (§28).`,
            wasItSaved: 'not_saved', nextSafeAction: 'A different person who holds the authority must decide it.',
          });
        }
        if (state.decision !== undefined) {
          if (state.decision.decidedBy === ctx.userId && state.decision.decision === decision) {
            return { status: 200, body: { ...state.decision, alreadyDecided: true } }; // the same decision, resent
          }
          throw apiError(409, {
            code: 'already_decided', whatHappened: `This request was already ${state.decision.decision} by ${state.decision.decidedBy}.`,
            wasItSaved: 'not_saved', nextSafeAction: 'A decision is final. A change is a new request.',
          });
        }
        // OB-290: approving money is bounded by the checker's own limit, read on the server (rejecting needs no budget).
        if (decision === 'approved' && deps.authorityOf !== undefined && state.request.valueMinor !== null && limitedSubjectOf(state.request.kind) !== undefined) {
          const authority = await deps.authorityOf(ctx.tenantId, ctx.userId, state.request.kind);
          if (!mayApproveValue(authority, state.request.valueMinor)) {
            throw apiError(422, {
              code: 'exceeds_your_limit',
              whatHappened: `This is for ₹${(state.request.valueMinor / 100).toFixed(2)}; ${ctx.userId}'s ${authority.limitedAs?.replace('_', ' ') ?? 'approval'} limit is ${authorityWords(authority)}. A decision above a person's limit goes to the owner.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'The owner decides it (it is in the owner\'s inbox). You may still reject it with a reason. Nothing was approved.',
            });
          }
        }
        const decidedAt = deps.now();
        const record: ApprovalDecision = {
          requestId, decision, decidedBy: ctx.userId, reason: b['reason'].trim().slice(0, 300), decidedAt,
          expiresAt: decision === 'approved' ? new Date(Date.parse(decidedAt) + spec.validForMinutes * 60_000).toISOString() : null,
        };
        let stands: ApprovalDecision | void;
        try {
          stands = await deps.recordDecision(ctx.tenantId, record, version);
        } catch (err) {
          if (err instanceof ConcurrencyConflictError) throw concurrentChange(`approval request ${requestId}`);
          throw err;
        }
        // Two checkers at the same moment: one decision stands, and the other is TOLD — never a 201 for a decision
        // that was not recorded (hard rule #10).
        if (stands !== undefined && (stands.decidedBy !== record.decidedBy || stands.decision !== record.decision)) {
          throw apiError(409, {
            code: 'already_decided', whatHappened: `This request was ${stands.decision} by ${stands.decidedBy} at the same moment; your decision was not recorded.`,
            wasItSaved: 'not_saved', nextSafeAction: 'A decision is final. A change is a new request.',
          });
        }
        return { status: 201, body: stands ?? record };
      },
    },
  ];
}

/** Where a request stands. */
export function statusOf(s: ApprovalState, nowMs: number): 'waiting' | 'approved' | 'rejected' | 'expired' | 'used' {
  if (s.usedBy !== undefined) return 'used';
  if (s.decision === undefined) return 'waiting';
  if (s.decision.decision === 'rejected') return 'rejected';
  return s.decision.expiresAt !== null && Date.parse(s.decision.expiresAt) <= nowMs ? 'expired' : 'approved';
}

/**
 * May this action use this approved request? Same kind, same subject, same details (fingerprint), same amount, same
 * maker; approved and not expired; never used; and the checker still holds the permission. ONE use, strictly: a lost
 * reply is answered by its own idempotency key before this runs, and an action that failed after spending asks again. Resolves the decision, or throws the refusal in plain words (nothing has changed).
 */
export async function takeApproval(input: {
  readonly state: ApprovalState | undefined;
  readonly kind: string;
  readonly subjectRef: string;
  readonly details: unknown;
  readonly valueMinor: number | null;
  readonly maker: string;
  readonly usedBy: string;
  readonly now: string;
  readonly checkerHolds: (userId: string, permission: string) => Promise<boolean> | boolean;
}): Promise<ApprovalDecision> {
  const refuse = (code: string, whatHappened: string): never => {
    throw apiError(422, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed. Ask for approval of exactly this, and have a different person with the authority approve it.' });
  };
  const s = input.state;
  if (s === undefined) return refuse('approval_unknown', 'Head office has no such approval request.');
  const r = s.request;
  if (s.usedBy !== undefined) return refuse('approval_already_used', `That approval was already used (${s.usedBy}); one approval allows one action.`);
  if (r.kind !== input.kind || r.subjectRef !== input.subjectRef || r.requestedBy !== input.maker
    || r.valueMinor !== input.valueMinor || r.fingerprint !== fingerprintOf(input.details)) {
    return refuse('approval_does_not_match', `That approval is for "${r.summary}", asked by ${r.requestedBy} — not exactly this. A change to the details or the amount needs a new approval.`);
  }
  if (s.decision === undefined) return refuse('approval_still_waiting', 'That request has not been decided yet.');
  if (s.decision.decision === 'rejected') return refuse('approval_rejected', `That request was rejected by ${s.decision.decidedBy}: ${s.decision.reason}`);
  if (s.decision.expiresAt !== null && Date.parse(s.decision.expiresAt) <= Date.parse(input.now)) {
    return refuse('approval_expired', `That approval expired at ${s.decision.expiresAt}.`);
  }
  const spec = APPROVAL_KINDS[r.kind];
  if (spec === undefined || !(await input.checkerHolds(s.decision.decidedBy, spec.checkerPermission))) {
    return refuse('checker_may_not_approve', `${s.decision.decidedBy} no longer holds the authority to approve this, so their approval does not count.`);
  }
  return s.decision;
}

/** Refused: the request names a second person with no approval behind it. */
export function namedSecondPersonRefusal(field: string, named: string): Error {
  return apiError(422, {
    code: 'approver_named_without_approval',
    whatHappened: `This names ${named} as ${field}, but naming a person is not their approval: they never approved it.`,
    wasItSaved: 'not_saved',
    nextSafeAction: 'Ask for approval (POST /v1/approvals/requests); once a different person with the authority approves it, send the approvalId. Nothing was changed.',
  });
}

/** What an action's route needs of the engine to use an approval. */
export interface ApprovalPort {
  readonly approvalState: (tenantId: string, requestId: string) => Promise<ApprovalState | undefined> | ApprovalState | undefined;
  readonly approvalVersion: (tenantId: string, requestId: string) => Promise<number> | number;
  /** Record the one use; resolves `false` when another action's use landed first (even the same action sent twice). */
  readonly spendApproval: (tenantId: string, requestId: string, usedBy: string, expectedVersion: number) => Promise<boolean | void> | boolean | void;
  readonly permissionsOfUser: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
}

/** No engine wired (a bare stub): every approval is unknown, so nothing is approved by accident. */
export const NO_APPROVALS: ApprovalPort = Object.freeze({
  approvalState: () => undefined, approvalVersion: () => 0, spendApproval: () => {}, permissionsOfUser: () => undefined,
});

/** Fields that are never part of the action itself: the approval's id (and, OB-407, the reviewer's), and the typed second-person fields it replaced. */
const CONTROL_FIELDS: ReadonlySet<string> = new Set(['approvalId', 'approval', 'approvedBy', 'rationale', 'reviewApprovalId']);

/**
 * What a maker asks approval FOR: the action's own body without its control fields, plus the route's path ids. The
 * rule every client follows is the same — ask with exactly the body you will send (and the ids in its address).
 */
export function actionDetails(body: unknown, pathIds: Readonly<Record<string, string>> = {}): Record<string, unknown> {
  const b = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) if (!CONTROL_FIELDS.has(k)) out[k] = v;
  return { ...out, ...pathIds };
}

/**
 * The common shape of an action that may need a second person: a typed name with no `approvalId` is refused by name;
 * no approval at all resolves `undefined` (the action's own rules then decide whether it needed one); an `approvalId`
 * is opened against exactly these details (`openApproval`).
 */
export async function approvalNamedIn(port: ApprovalPort | undefined, input: {
  readonly tenantId: string;
  readonly approvalId: unknown;
  /** The legacy typed second-person field and what it carried — refused by name when there is no approval. */
  readonly typedField: string;
  readonly typedValue: unknown;
  readonly kind: string;
  readonly subjectRef: string;
  readonly details: unknown;
  readonly valueMinor: number | null;
  readonly maker: string;
  readonly usedBy: string;
  readonly now: string;
}): Promise<{ readonly decision: ApprovalDecision; spend(): Promise<void> } | undefined> {
  if (!isStr(input.approvalId)) {
    if (isStr(input.typedValue)) throw namedSecondPersonRefusal(input.typedField, input.typedValue);
    return undefined;
  }
  return openApproval(port ?? NO_APPROVALS, {
    tenantId: input.tenantId, approvalId: input.approvalId.trim(), kind: input.kind, subjectRef: input.subjectRef,
    details: input.details, valueMinor: input.valueMinor, maker: input.maker, usedBy: input.usedBy, now: input.now,
  });
}

/**
 * Open an approval for one action: read the request's guard FIRST, then judge the approval (`takeApproval`). Resolves
 * the decision — so the route can run its own rules that need the checker (e.g. "not the supplier's creator") — and
 * `spend()`, which the route calls after every rule has passed and BEFORE the action is written. Two actions racing on
 * one approval: the second's spend is refused by name (409, nothing changed).
 */
export async function openApproval(port: ApprovalPort, input: {
  readonly tenantId: string;
  readonly approvalId: string;
  readonly kind: string;
  readonly subjectRef: string;
  readonly details: unknown;
  readonly valueMinor: number | null;
  readonly maker: string;
  readonly usedBy: string;
  readonly now: string;
}): Promise<{ readonly decision: ApprovalDecision; spend(): Promise<void> }> {
  const version = await Promise.resolve(port.approvalVersion(input.tenantId, input.approvalId));
  const state = await Promise.resolve(port.approvalState(input.tenantId, input.approvalId));
  const decision = await takeApproval({
    ...input, state,
    checkerHolds: async (userId, permission) => ((await port.permissionsOfUser(input.tenantId, userId)) ?? []).includes(permission),
  });
  return {
    decision,
    spend: async () => {
      let landed: boolean | void;
      try {
        landed = await port.spendApproval(input.tenantId, input.approvalId, input.usedBy, version);
      } catch (err) {
        if (err instanceof ConcurrencyConflictError) throw concurrentChange(`approval ${input.approvalId}`);
        throw err;
      }
      // Two actions at the same moment — even the same one sent twice: the one whose use landed proceeds; this one is
      // refused by name and changes nothing.
      if (landed === false) {
        throw apiError(409, {
          code: 'approval_already_used', whatHappened: `Approval ${input.approvalId} was used by another request at the same moment; one approval allows one action.`,
          wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed. Ask for a new approval if this is a separate action.',
        });
      }
    },
  };
}
