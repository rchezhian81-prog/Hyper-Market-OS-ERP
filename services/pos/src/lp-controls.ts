// API-05 Loss prevention over the shop's OWN records (OB-288 · audit-2 P4 · M15-FR-02 · M15-FR-03 · OB-301).
//
//   • STORED FRAUD SIGNALS — `GET /v1/fraud-signals/stored?from&to`: the four cross-domain detectors run over what the
//     shop holds (coupon redemptions, points movements, cash-on-delivery stops and their handovers, supplier bills) in
//     one window with the shop's own thresholds, every signal reconciled back to its records
//     (`packages/loss-prevention/src/signal-sources.ts`). Read-only; nothing is blocked (hard rule #5).
//   • RELATED PARTIES (OB-301) — the owner's own list of related people and firms, each with the GSTINs, phones and
//     bank accounts that identify them; which suppliers match it now. The owner's alone to keep and to read: it names
//     his family. Append-only (an entry taken off is kept, inactive — hard rule #6).
//   • STAFF PURCHASES (OB-301) — the owner's two numbers (the staff-discount cap and which till is the service desk),
//     each "not set" until he enters it; the staff members' own customer accounts, recorded by a manager; and the
//     exceptions over the bills that arrived (a staff member who rang their own shopping, or bought at a lane, or got
//     more off than the cap). The TILL refuses those bills before they commit, from the same rule
//     (`packages/restricted-sales/src/staff-purchase.ts`); this list is head office's check on what still arrived.
//   • STAFF SALARY ACCOUNTS (M15-FR-03 "duplicate bank accounts across suppliers/employees") — each employee's salary
//     account reference, recorded by the owner or the accountant, so the duplicate-account control folds employees in
//     beside suppliers. Shown masked; never printed in full.
//
// Every write names its maker as the signed-in caller and is sealed on the audit trail.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { FraudThresholds } from '../../../packages/loss-prevention/src/fraud-signals';
import {
  storedFraudSignals, type Readings, type StoredCouponRedemption, type StoredPointsMovement, type StoredCodStop, type StoredSupplierBill,
} from '../../../packages/loss-prevention/src/signal-sources';
import {
  readRelatedParty, matchSupplier, shownParty, maskedAccount, normalAccount,
  type RelatedParty, type SupplierFacts, type RelatedPartyMatch,
} from '../../../packages/loss-prevention/src/related-party';
import {
  judgeStaffPurchase, readStaffPurchasePolicy, type StaffPurchasePolicy, type StaffBill,
} from '../../../packages/restricted-sales/src/staff-purchase';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;

/** A staff member's own customer account, as a manager recorded it (latest per employee wins; `null` = removed). */
export interface StaffAccount {
  readonly employeeId: string;
  readonly customerRef: string | null;
  readonly recordedBy: string;
  readonly at: string;
}

/** An employee's salary account reference (latest per employee wins). */
export interface SalaryAccount {
  readonly employeeId: string;
  readonly accountRef: string;
  readonly recordedBy: string;
  readonly at: string;
}

/** One banked bill, as much of it as the staff-purchase check reads. */
export interface BankedBill {
  readonly saleId: string;
  readonly receiptNumber: string;
  readonly laneId: string;
  readonly cashierId: string;
  readonly committedAt: string;
  readonly customerRef?: string;
  readonly totalMinor: number;
  readonly lines: readonly { readonly quantityMinor: number; readonly unitPriceMinor: number; readonly lineTotalMinor: number; readonly priceOverride?: { readonly fromUnitPriceMinor?: number } }[];
}

export interface LpControlsDeps {
  readonly now: () => string;
  readonly thresholds: (tenantId: string) => Promise<FraudThresholds> | FraudThresholds;
  readonly couponRedemptions: (tenantId: string) => Promise<Readings<StoredCouponRedemption>>;
  readonly pointsMovements: (tenantId: string) => Promise<Readings<StoredPointsMovement>>;
  readonly codStops: (tenantId: string) => Promise<Readings<StoredCodStop>>;
  readonly supplierBills: (tenantId: string) => Promise<Readings<StoredSupplierBill>>;

  readonly relatedParties: (tenantId: string) => Promise<readonly RelatedParty[]>;
  readonly recordRelatedParty: (tenantId: string, party: RelatedParty, by: string, at: string) => Promise<void>;
  /** Every supplier's matching facts (master record + current verified bank account). */
  readonly supplierFacts: (tenantId: string) => Promise<readonly (SupplierFacts & { readonly name: string | null })[]>;

  readonly staffPolicy: (tenantId: string) => Promise<{ readonly policy: StaffPurchasePolicy; readonly setBy: string | null; readonly setAt: string | null }>;
  readonly recordStaffPolicy: (tenantId: string, policy: StaffPurchasePolicy, by: string, at: string) => Promise<void>;
  readonly staffAccounts: (tenantId: string) => Promise<readonly StaffAccount[]>;
  readonly recordStaffAccount: (tenantId: string, account: StaffAccount) => Promise<void>;
  /** Is this person on the staff list (the roster's employee record)? */
  readonly employeeKnown: (tenantId: string, employeeId: string) => Promise<boolean>;
  readonly billsBetween: (tenantId: string, from: string, to: string) => Promise<readonly BankedBill[]>;

  readonly salaryAccounts: (tenantId: string) => Promise<readonly SalaryAccount[]>;
  readonly recordSalaryAccount: (tenantId: string, account: SalaryAccount) => Promise<void>;
  readonly recordAudit?: Recorder;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const DAY_MS = 86_400_000;

const bad = (code: string, whatHappened: string, nextSafeAction = 'Correct the request and send it again. Nothing was changed.'): never => {
  throw apiError(400, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });
};

/** The window a report reads: `from`/`to` from the query, else the last 30 days to now. */
function windowOf(query: Readonly<Record<string, string>>, now: string): { from: string; to: string } {
  const to = isTime(query['to']) ? new Date(Date.parse(query['to']!) + (/^\d{4}-\d{2}-\d{2}$/.test(query['to']!) ? DAY_MS - 1 : 0)).toISOString() : now;
  const from = isTime(query['from']) ? new Date(Date.parse(query['from']!)).toISOString() : new Date(Date.parse(to) - 30 * DAY_MS).toISOString();
  if (Date.parse(from) > Date.parse(to)) bad('window_backwards', 'The first day is after the last day.');
  return { from, to };
}

/** The live staff-account map (customer account → employee), from the latest record per employee. */
export function staffAccountMap(accounts: readonly StaffAccount[]): Map<string, string> {
  const latest = new Map<string, StaffAccount>();
  for (const a of accounts) latest.set(a.employeeId, a);
  const out = new Map<string, string>();
  for (const a of latest.values()) if (a.customerRef !== null) out.set(a.customerRef, a.employeeId);
  return out;
}

/** The latest salary account per employee. */
export function latestSalaryAccounts(accounts: readonly SalaryAccount[]): readonly SalaryAccount[] {
  const latest = new Map<string, SalaryAccount>();
  for (const a of accounts) latest.set(a.employeeId, a);
  return [...latest.values()].sort((a, b) => a.employeeId.localeCompare(b.employeeId));
}

/** The policy as a screen shows it: each part, or "not set". */
function policyView(p: StaffPurchasePolicy): Record<string, unknown> {
  return {
    staffDiscountCapBps: p.staffDiscountCapBps, serviceDeskLaneIds: p.serviceDeskLaneIds,
    notSet: [...(p.staffDiscountCapBps === null ? ['staff_discount_cap'] : []), ...(p.serviceDeskLaneIds === null ? ['service_desk'] : [])],
  };
}

/** Every banked bill judged by the staff-purchase rule; only the staff purchases are returned. */
export function staffPurchaseExceptions(bills: readonly BankedBill[], policy: StaffPurchasePolicy, accounts: ReadonlyMap<string, string>): readonly Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const b of bills) {
    const bill: StaffBill = {
      laneId: b.laneId, cashierId: b.cashierId, ...(b.customerRef === undefined ? {} : { customerRef: b.customerRef }),
      lines: b.lines.map((l) => ({
        quantityMinor: l.quantityMinor, unitPriceMinor: l.unitPriceMinor, lineTotalMinor: l.lineTotalMinor,
        ...(Number.isInteger(l.priceOverride?.fromUnitPriceMinor) ? { listUnitPriceMinor: l.priceOverride!.fromUnitPriceMinor! } : {}),
      })),
    };
    const d = judgeStaffPurchase(bill, policy, accounts);
    if (!d.staffPurchase) continue;
    out.push({
      saleId: b.saleId, receiptNumber: b.receiptNumber, laneId: b.laneId, cashierId: b.cashierId, employeeId: d.employeeId,
      committedAt: b.committedAt, totalMinor: b.totalMinor, discountMinor: d.discountMinor, discountBps: d.discountBps,
      allowed: d.allowed, refusals: d.refusals, notSet: d.notSet, words: d.words,
    });
  }
  return out.sort((a, b) => Number(a['allowed']) - Number(b['allowed']) || String(b['committedAt']).localeCompare(String(a['committedAt'])));
}

export function lpControlsRoutes(deps: LpControlsDeps): readonly Route[] {
  const seal = async (tenantId: string, entry: Omit<AuditEntry, 'origin' | 'before'> & { before?: AuditEntry['before'] }): Promise<void> => {
    await deps.recordAudit?.(tenantId, { before: null, ...entry, origin: { tenantId, branchId: null } } as AuditEntry);
  };
  return [
    {
      // M15-FR-02: the four detectors over the stored registers in one window, each signal reconciled to its records.
      api: 'API-05', method: 'GET', path: '/v1/fraud-signals/stored',
      permission: 'lp.case.read',
      handler: async (ctx) => {
        const now = deps.now();
        const { from, to } = windowOf(ctx.query, now);
        const [thresholds, coupons, points, cod, supplierBills] = await Promise.all([
          deps.thresholds(ctx.tenantId), deps.couponRedemptions(ctx.tenantId), deps.pointsMovements(ctx.tenantId), deps.codStops(ctx.tenantId), deps.supplierBills(ctx.tenantId),
        ]);
        const report = storedFraudSignals({ from, to, at: now, thresholds, coupons, points, cod, supplierBills });
        return { status: 200, body: { ...report, asAt: now } };
      },
    },

    // ── related parties (OB-301) ─────────────────────────────────────────────────────────────────────────────────────
    {
      api: 'API-05', method: 'POST', path: '/v1/loss-prevention/related-parties/:partyId',
      permission: 'lp.relatedparty.manage', idempotent: true,
      handler: async (ctx) => {
        const read = readRelatedParty(ctx.params['partyId'] ?? '', ctx.body);
        if (!read.ok) bad('not_readable_as_a_related_party', read.why, 'Correct the entry and save it again. Nothing was saved.');
        const party = (read as { party: RelatedParty }).party;
        const at = deps.now();
        await deps.recordRelatedParty(ctx.tenantId, party, ctx.userId, at);
        await seal(ctx.tenantId, {
          actorId: ctx.userId, action: party.active ? 'lp.related_party.recorded' : 'lp.related_party.taken_off', objectType: 'related_party', objectId: party.partyId, at,
          after: { kind: party.kind, gstins: String(party.gstins.length), phones: String(party.phones.length), bankAccounts: String(party.bankAccountRefs.length), active: String(party.active) },
          correlationId: party.partyId,
        });
        return { status: 201, body: { party: shownParty(party), recordedAt: at } };
      },
    },
    {
      // Take an entry off the list: its facts are kept (append-only) and it stops matching. Body: { reason }.
      api: 'API-05', method: 'POST', path: '/v1/loss-prevention/related-parties/:partyId/take-off',
      permission: 'lp.relatedparty.manage', idempotent: true,
      handler: async (ctx) => {
        const partyId = (ctx.params['partyId'] ?? '').trim();
        const reason = (ctx.body as { reason?: unknown } | null)?.reason;
        if (typeof reason !== 'string' || reason.trim() === '') bad('take_off_needs_a_reason', 'Say why the entry comes off the list.', 'Write the reason and send it again. Nothing was changed.');
        const prior = (await deps.relatedParties(ctx.tenantId)).find((x) => x.partyId === partyId);
        if (prior === undefined) throw notFound(`related party ${partyId}`);
        if (!prior.active) return { status: 200, body: { party: shownParty(prior), alreadyOff: true } };
        const party: RelatedParty = { ...prior, active: false };
        const at = deps.now();
        await deps.recordRelatedParty(ctx.tenantId, party, ctx.userId, at);
        await seal(ctx.tenantId, {
          actorId: ctx.userId, action: 'lp.related_party.taken_off', objectType: 'related_party', objectId: party.partyId, at,
          after: { kind: party.kind, active: 'false' }, reason: (reason as string).trim(), correlationId: party.partyId,
        });
        return { status: 201, body: { party: shownParty(party), recordedAt: at } };
      },
    },
    {
      // The owner's list (accounts masked) and every supplier that matches an active entry now — each fact named.
      api: 'API-05', method: 'GET', path: '/v1/loss-prevention/related-parties',
      permission: 'lp.relatedparty.manage',
      handler: async (ctx) => {
        const [parties, suppliers] = await Promise.all([deps.relatedParties(ctx.tenantId), deps.supplierFacts(ctx.tenantId)]);
        const matches: { supplierId: string; name: string | null; matches: readonly RelatedPartyMatch[] }[] = [];
        for (const s of suppliers) {
          const m = matchSupplier(s, parties);
          if (m.length > 0) matches.push({ supplierId: s.supplierId, name: s.name, matches: m });
        }
        return { status: 200, body: { parties: parties.map(shownParty), count: parties.length, active: parties.filter((p) => p.active).length, supplierMatches: matches, asAt: deps.now() } };
      },
    },

    // ── staff purchases (OB-301) ─────────────────────────────────────────────────────────────────────────────────────
    {
      api: 'API-05', method: 'GET', path: '/v1/loss-prevention/staff-purchases/policy',
      permission: 'lp.case.read',
      handler: async (ctx) => {
        const p = await deps.staffPolicy(ctx.tenantId);
        return { status: 200, body: { ...policyView(p.policy), setBy: p.setBy, setAt: p.setAt } };
      },
    },
    {
      // The owner's two numbers. Body: { staffDiscountCapBps: 0…10000 | null, serviceDeskLaneIds: string[] | null }.
      api: 'API-05', method: 'POST', path: '/v1/loss-prevention/staff-purchases/policy',
      permission: 'lp.staffpurchase.manage', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const cap = b['staffDiscountCapBps'];
        const lanes = b['serviceDeskLaneIds'];
        if (cap !== null && cap !== undefined && !(Number.isInteger(cap) && (cap as number) >= 0 && (cap as number) <= 10_000)) bad('not_readable_as_a_staff_policy', 'The staff discount is a whole number of basis points from 0 to 10000 (1000 = 10%), or empty for "not set".');
        if (lanes !== null && lanes !== undefined && !(Array.isArray(lanes) && lanes.every(isStr))) bad('not_readable_as_a_staff_policy', 'The service desk is a list of till ids, or empty for "not set".');
        const policy = readStaffPurchasePolicy({ staffDiscountCapBps: cap ?? null, serviceDeskLaneIds: Array.isArray(lanes) && lanes.length > 0 ? lanes : null });
        const at = deps.now();
        await deps.recordStaffPolicy(ctx.tenantId, policy, ctx.userId, at);
        await seal(ctx.tenantId, {
          actorId: ctx.userId, action: 'lp.staff_purchase.policy_set', objectType: 'staff_purchase_policy', objectId: 'staff-purchases', at,
          after: { staffDiscountCapBps: policy.staffDiscountCapBps === null ? 'not set' : String(policy.staffDiscountCapBps), serviceDeskLaneIds: policy.serviceDeskLaneIds === null ? 'not set' : policy.serviceDeskLaneIds.join(',') },
          correlationId: 'staff-purchases',
        });
        return { status: 200, body: { ...policyView(policy), setBy: ctx.userId, setAt: at } };
      },
    },
    {
      // A staff member's own customer account (their member code), so a bill naming it is known as a staff purchase.
      // Body: { customerRef } — or { customerRef: null } when the staff member leaves (kept, never deleted).
      api: 'API-05', method: 'POST', path: '/v1/loss-prevention/staff-purchases/accounts/:employeeId',
      permission: 'lp.staffaccount.record', idempotent: true,
      handler: async (ctx) => {
        const employeeId = (ctx.params['employeeId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (employeeId === '' || !(b['customerRef'] === null || isStr(b['customerRef']))) bad('not_readable_as_a_staff_account', 'A staff account needs the employee in the address and { customerRef } — their own customer account — or null when they leave.');
        if (employeeId === ctx.userId) {
          throw apiError(422, { code: 'own_staff_account', whatHappened: 'A person does not record their own staff account — a manager records it for them (§28).', wasItSaved: 'not_saved', nextSafeAction: 'Ask another manager to record it. Nothing was saved.' });
        }
        if (!(await deps.employeeKnown(ctx.tenantId, employeeId))) throw notFound(`employee ${employeeId} on the staff list`);
        const customerRef = b['customerRef'] === null ? null : (b['customerRef'] as string).trim();
        if (customerRef !== null) {
          const owner = staffAccountMap(await deps.staffAccounts(ctx.tenantId)).get(customerRef);
          if (owner !== undefined && owner !== employeeId) {
            throw apiError(409, { code: 'customer_account_already_staff', whatHappened: `That customer account is already recorded as ${owner}'s staff account.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the account. One customer account belongs to one staff member. Nothing was saved.' });
          }
        }
        const account: StaffAccount = { employeeId, customerRef, recordedBy: ctx.userId, at: deps.now() };
        await deps.recordStaffAccount(ctx.tenantId, account);
        await seal(ctx.tenantId, { actorId: ctx.userId, action: customerRef === null ? 'lp.staff_account.removed' : 'lp.staffaccount.recorded', objectType: 'staff_account', objectId: employeeId, at: account.at, after: { recorded: String(customerRef !== null) }, correlationId: employeeId });
        return { status: 201, body: { account } };
      },
    },
    {
      api: 'API-05', method: 'GET', path: '/v1/loss-prevention/staff-purchases/accounts',
      permission: 'lp.case.read',
      handler: async (ctx) => {
        const latest = new Map<string, StaffAccount>();
        for (const a of await deps.staffAccounts(ctx.tenantId)) latest.set(a.employeeId, a);
        const accounts = [...latest.values()].filter((a) => a.customerRef !== null).sort((a, b) => a.employeeId.localeCompare(b.employeeId));
        return { status: 200, body: { accounts, count: accounts.length } };
      },
    },
    {
      // The bills that arrived naming a staff member's account, judged by the same rule the till runs — the ones the
      // rule refuses first. Read-only: a committed bill is never un-banked; a person looks.
      api: 'API-05', method: 'GET', path: '/v1/loss-prevention/staff-purchases/exceptions',
      permission: 'lp.case.read',
      handler: async (ctx) => {
        const now = deps.now();
        const { from, to } = windowOf(ctx.query, now);
        const [p, accounts, bills] = await Promise.all([deps.staffPolicy(ctx.tenantId), deps.staffAccounts(ctx.tenantId), deps.billsBetween(ctx.tenantId, from, to)]);
        const rows = staffPurchaseExceptions(bills, p.policy, staffAccountMap(accounts));
        return { status: 200, body: { from, to, policy: policyView(p.policy), bills: rows, staffBills: rows.length, refused: rows.filter((r) => r['allowed'] === false).length, billsRead: bills.length, asAt: now } };
      },
    },
    {
      // What a till needs to run the rule offline: the owner's two numbers and the staff accounts. Read by the store
      // computer for its pack (and by the till-side builder's hook); nothing here is a name.
      api: 'API-05', method: 'GET', path: '/v1/loss-prevention/staff-purchases/till-policy',
      permission: 'store.pack.read',
      handler: async (ctx) => {
        const [p, accounts] = await Promise.all([deps.staffPolicy(ctx.tenantId), deps.staffAccounts(ctx.tenantId)]);
        const map = staffAccountMap(accounts);
        return { status: 200, body: { ...policyView(p.policy), staffAccounts: [...map.entries()].map(([customerRef, employeeId]) => ({ customerRef, employeeId })).sort((a, b) => a.employeeId.localeCompare(b.employeeId)), asAt: deps.now() } };
      },
    },

    // ── staff salary accounts (M15-FR-03 duplicate bank accounts across suppliers AND employees) ─────────────────────
    {
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/employees/:employeeId/salary-account',
      permission: 'hr.salaryaccount.record', idempotent: true,
      handler: async (ctx) => {
        const employeeId = (ctx.params['employeeId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (employeeId === '' || !isStr(b['accountRef']) || normalAccount(b['accountRef']).length < 4) bad('not_readable_as_a_salary_account', 'A salary account needs the employee in the address and { accountRef } — the account reference as the bank gave it (at least 4 letters or digits).');
        if (employeeId === ctx.userId) {
          throw apiError(422, { code: 'own_salary_account', whatHappened: 'Nobody records where their own salary goes — the owner or the accountant records it for them (§28).', wasItSaved: 'not_saved', nextSafeAction: 'Ask the other of the owner or the accountant to record it. Nothing was saved.' });
        }
        if (!(await deps.employeeKnown(ctx.tenantId, employeeId))) throw notFound(`employee ${employeeId} on the staff list`);
        const account: SalaryAccount = { employeeId, accountRef: normalAccount(b['accountRef'] as string), recordedBy: ctx.userId, at: deps.now() };
        await deps.recordSalaryAccount(ctx.tenantId, account);
        await seal(ctx.tenantId, { actorId: ctx.userId, action: 'hr.salaryaccount.recorded', objectType: 'employee', objectId: employeeId, at: account.at, after: { account: maskedAccount(account.accountRef) }, correlationId: employeeId });
        return { status: 201, body: { employeeId, account: maskedAccount(account.accountRef), recordedBy: account.recordedBy, at: account.at } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/salary-accounts',
      permission: 'hr.salaryaccount.record',
      handler: async (ctx) => {
        const rows = latestSalaryAccounts(await deps.salaryAccounts(ctx.tenantId)).map((a) => ({ employeeId: a.employeeId, account: maskedAccount(a.accountRef), recordedBy: a.recordedBy, at: a.at }));
        return { status: 200, body: { accounts: rows, count: rows.length } };
      },
    },
  ];
}
