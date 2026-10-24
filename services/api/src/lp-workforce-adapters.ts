// OB-288 · loss prevention, workforce, facilities and adoption — head office's wiring (audit-2 P4 · audit-3 package 5 ·
// audit-4 D11 / M28 · OB-301 · OB-317 · OB-320 · OB-323).
//
// One entry point, `lpWorkforceSurface(surface, input)`, is the line in main.ts. It ADDS this package's routes and wraps
// existing ones IN PLACE, each keeping its own path, permission and behaviour and gaining only the step named here:
//
//   • `POST /v1/purchase/orders/:poId/approval` and `POST /v1/purchase/orders/:poId` — the related-party guard (OB-301):
//     an order with a supplier on the owner's related-party list is issued only with the owner's written approval
//     (`services/purchase/src/related-party-order-guard.ts`).
//   • `GET /v1/fraud-signals/duplicate-bank` — employees' salary accounts join the suppliers' in the duplicate fold.
//   • `POST /v1/purchase/suppliers/:supplierId/payments/:paymentId` — a supplier whose bank account is an EMPLOYEE's
//     salary account is not paid until a person has reviewed it (M15-FR-03), the same refusal the supplier-to-supplier
//     duplicate already gets.
//   • `POST /v1/loyalty/coupons/:code` — each coupon issued is put on the coupon index the stored fraud signals read.
//   • `POST /v1/customers/:customerId/points` — who moved points by hand is kept beside the movement, so "points that
//     came from nowhere" names the person who issued them.
//
// A target route that is missing throws at start-up: a guard that silently guards nothing is the failure P-08 forbids.
// Every register here is append-only on its own stream (hard rules #2, #6). Nothing here moves money or stock, and no
// AI writes anything (hard rule #5).

import { InMemoryEventStore, type EventStore } from '../../../packages/persistence/src/event-store';
import type { Route, RequestContext, HandlerResult } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { makeEvent } from '../../../packages/contracts/src/event';
import { detectDuplicateBankAccounts, holdersBlockedForDuplicate, type BankAccountHolder } from '../../../packages/bank-controls/src/duplicate-bank';
import { normalAccount, maskedAccount, type RelatedParty, type SupplierFacts } from '../../../packages/loss-prevention/src/related-party';
import type { StoredCouponRedemption, StoredPointsMovement, StoredCodStop, StoredSupplierBill } from '../../../packages/loss-prevention/src/signal-sources';
import { readStaffPurchasePolicy, type StaffPurchasePolicy } from '../../../packages/restricted-sales/src/staff-purchase';
import type { FraudThresholds } from '../../../packages/loss-prevention/src/fraud-signals';
import type { Coupon, Redemption } from '../../../packages/loyalty/src/coupons';
import type { RecordedPointsMovement } from '../../customer/src/index';
import type { RouteStopUpdate, CashHandoverRecord } from '../../fulfilment/src/driver-runs';
import type { IncomingSale } from '../../pos/src/index';
import { lpControlsRoutes, latestSalaryAccounts, type LpControlsDeps, type StaffAccount, type SalaryAccount, type BankedBill } from '../../pos/src/lp-controls';
import { withRelatedPartyOrderGuard, relatedPartyApprovalRoutes, type RelatedPartyOrderGuardDeps, type RelatedPartyOrderApproval } from '../../purchase/src/related-party-order-guard';
import {
  STREAM, streamName, effectiveGrants, fraudSignalsAdapter, supplierMasterAdapter, purchaseOrdersAdapter, liveSupplierInvoices, rosterStoreAdapter,
  sopStoreAdapter, orgStructureAdapter, categoryRegisterAdapter, productMasterAdapter, permissionsHeldBy,
} from './adapters';
import type { StoredRoster } from '../../finance/src/roster-store';
import type { SopAcknowledgement } from '../../../packages/workforce/src/workforce';
import type { TrainingAssignment, TrainingCompletion, CompetencySignOff, ApprovedCurriculum } from '../../../packages/workforce/src/training';
import type { FloorChampion } from '../../../packages/workforce/src/adoption-gate';
import type { LetterWording, AppointmentLetter, SignedScan } from '../../../packages/workforce/src/appointment-letter';
import { workforceEnablementRoutes, readAdoptionGate, type WorkforceEnablementDeps } from '../../finance/src/workforce-enablement';
import type { OtherGateBlocker } from '../../compliance/src/risk';
import { helpCentreRoutes, helpLibrary, type HelpCentreDeps, type SopContent, type EmergencyContacts, type EmergencyDrill } from '../../finance/src/help-centre';
import { appointmentLetterRoutes, type AppointmentLetterDeps } from '../../finance/src/appointment-letters';
import { currentLinks, type DepartmentLinkRecord } from '../../platform/src/org-departments';
import { departmentOfCategory } from '../../../packages/org/src/departments';
import { facilitiesOfficeRoutes, type FacilitiesOfficeDeps } from '../../platform/src/facilities-office';
import { writeOffCaptureRoutes, type WriteOffCaptureDeps, type CaptureRecord } from '../../inventory/src/write-off-captured';
import { lossValueOf } from '../../inventory/src/write-off';
import { branchOfLocationIn } from '../../inventory/src/location-scope';
import { latestPlanograms } from '../../inventory/src/planograms';
import { relabelTaskRoutes, relabelTasksFor, raiseRelabelTasks, type RelabelTaskDeps, type RelabelTask, type RelabelDone } from '../../pricing/src/relabel-tasks';
import { facilitiesAssetsAdapter, facilitiesMonitoringAdapter, facilitiesAdapter, writeOffAdapter, planogramStoreAdapter } from './adapters';
import { OWNER_ROLE_ID } from './roles';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
export interface LpWorkforceInput {
  readonly store: EventStore | undefined;
  readonly now: () => string;
  readonly recordAudit?: Recorder;
}
interface Base { readonly store: EventStore; readonly now: () => string; readonly recordAudit?: Recorder }

// ── the registers ───────────────────────────────────────────────────────────────────────────────────────────────────

export const LP_STREAMS = Object.freeze({
  relatedParties: streamName(STREAM.lossPrevention, 'related-parties'),
  relatedPartyApprovals: streamName(STREAM.lossPrevention, 'related-party-approvals'),
  staffPolicy: streamName(STREAM.lossPrevention, 'staff-purchase-policy'),
  staffAccounts: streamName(STREAM.lossPrevention, 'staff-accounts'),
  couponIndex: streamName(STREAM.lossPrevention, 'coupon-index'),
  pointsAttribution: streamName(STREAM.lossPrevention, 'points-attribution'),
  salaryAccounts: streamName(STREAM.payroll, 'salary-accounts'),
});

async function all<T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<readonly T[]> {
  return (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);
}

/** Append one fact; a re-send under the same key collapses onto the first (idempotent, append-only). */
async function put(store: EventStore, tenantId: string, stream: string, type: string, key: string, at: string, payload: unknown): Promise<void> {
  await store.append(tenantId, stream, makeEvent({ id: `${type}-${key}`, type, occurredAt: at, idempotencyKey: `${tenantId}-${type}-${key}`, source: 'api/lp-workforce', payload }));
}

/** A value's short fingerprint for an idempotency key (a re-sent identical write collapses; a changed one is new). */
function fp(v: unknown): string {
  const s = JSON.stringify(v);
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

export async function isOwnerNow(store: EventStore, tenantId: string, userId: string): Promise<boolean> {
  return (await effectiveGrants(store, tenantId)).some((g) => g.userId === userId && g.roleId === OWNER_ROLE_ID);
}

/** The owner's related-party list, latest entry per id. */
export async function relatedPartiesOf(store: EventStore, tenantId: string): Promise<readonly RelatedParty[]> {
  const latest = new Map<string, RelatedParty>();
  for (const r of await all<{ party: RelatedParty }>(store, tenantId, LP_STREAMS.relatedParties, 'RelatedPartyRecorded')) latest.set(r.party.partyId, r.party);
  return [...latest.values()].sort((a, b) => a.partyId.localeCompare(b.partyId));
}

/** A supplier's matching facts: its master record's GSTIN and phone, and its current verified bank account. */
async function supplierFactsOf(input: Base, tenantId: string, supplierId: string): Promise<SupplierFacts & { readonly name: string | null }> {
  const master = supplierMasterAdapter({ store: input.store, now: input.now });
  const [record, bank] = await Promise.all([master.record(tenantId, supplierId), master.bankState(tenantId, supplierId)]);
  return { supplierId, name: record?.name ?? null, gstin: record?.gstin ?? null, phone: record?.phone ?? null, bankAccountRef: bank?.accountRef ?? null };
}

/** The latest salary account per employee, as duplicate-bank holders (normalised references). */
export async function employeeBankHolders(store: EventStore, tenantId: string): Promise<readonly BankAccountHolder[]> {
  return latestSalaryAccounts(await all<SalaryAccount>(store, tenantId, LP_STREAMS.salaryAccounts, 'SalaryAccountRecorded'))
    .map((a) => ({ holderId: a.employeeId, holderType: 'employee' as const, accountRef: normalAccount(a.accountRef) }));
}

/** Every holder (suppliers' current accounts and employees' salary accounts), each reference in its one written form. */
export async function allBankHolders(input: Base, tenantId: string): Promise<readonly BankAccountHolder[]> {
  const suppliers = await fraudSignalsAdapter({ store: input.store, now: input.now }).bankHolders(tenantId);
  return [...suppliers.map((h) => ({ ...h, accountRef: normalAccount(h.accountRef) })), ...await employeeBankHolders(input.store, tenantId)];
}

// ── the stored fraud signals' sources ──────────────────────────────────────────────────────────────────────────────

async function couponRedemptionsOf(input: Base, tenantId: string): Promise<readonly StoredCouponRedemption[]> {
  const codes = [...new Set((await all<{ code: string }>(input.store, tenantId, LP_STREAMS.couponIndex, 'CouponIndexed')).map((c) => c.code))].sort();
  const out: StoredCouponRedemption[] = [];
  for (const code of codes) {
    const stream = streamName(STREAM.loyalty, 'coupon', code);
    const issued = await all<Coupon>(input.store, tenantId, stream, 'CouponIssued');
    const coupon = issued.at(-1);
    for (const r of await all<Redemption>(input.store, tenantId, stream, 'CouponRedeemed')) {
      out.push({
        redemptionId: r.redemptionId, code: r.code, saleId: r.saleId, at: r.at, ...(r.customerRef === undefined ? {} : { customerRef: r.customerRef }),
        ...(coupon === undefined ? {} : { coupon: { kind: coupon.kind, ...(coupon.valueMinor === undefined ? {} : { valueMinor: coupon.valueMinor }), maxPerCustomer: coupon.maxPerCustomer } }),
      });
    }
  }
  return out;
}

async function pointsMovementsOf(input: Base, tenantId: string): Promise<readonly StoredPointsMovement[]> {
  const attributed = new Map<string, string>();
  const customers = new Set<string>();
  for (const a of await all<{ movementId: string; customerId: string; issuedBy: string }>(input.store, tenantId, LP_STREAMS.pointsAttribution, 'PointsMovementAttributed')) {
    attributed.set(a.movementId, a.issuedBy); customers.add(a.customerId);
  }
  for (const m of await all<{ memberRef: string }>(input.store, tenantId, streamName(STREAM.loyalty, 'members'), 'LoyaltyMember')) customers.add(m.memberRef);
  const out: StoredPointsMovement[] = [];
  for (const c of [...customers].sort()) {
    for (const m of await all<RecordedPointsMovement>(input.store, tenantId, streamName(STREAM.loyalty, c), 'PointsMovement')) {
      const by = attributed.get(m.movementId);
      out.push({ movementId: m.movementId, customerId: m.customerId, delta: m.delta, reason: m.reason, sourceRef: m.sourceRef, at: m.at, ...(by === undefined ? {} : { issuedBy: by }) });
    }
  }
  return out;
}

async function codStopsOf(input: Base, tenantId: string): Promise<readonly StoredCodStop[]> {
  const routes = [...new Set((await all<{ kind: string; id: string }>(input.store, tenantId, streamName(STREAM.delivery, 'assignment-index'), 'AssignmentPlaced')).filter((a) => a.kind === 'route').map((a) => a.id))].sort();
  const out: StoredCodStop[] = [];
  for (const routeId of routes) {
    const stream = streamName(STREAM.delivery, 'route', routeId);
    const latest = new Map<string, RouteStopUpdate>();
    for (const u of await all<RouteStopUpdate>(input.store, tenantId, stream, 'RouteStopUpdateRecorded')) latest.set(u.stopId, u);
    const handover = (await all<CashHandoverRecord>(input.store, tenantId, stream, 'DriverCashHandoverRecorded'))[0];
    for (const s of latest.values()) {
      out.push({
        routeId, stopId: s.stopId, driverId: s.driverId, orderRef: s.orderRef, state: s.state, codExpectedMinor: s.codExpectedMinor, codCollectedMinor: s.codCollectedMinor,
        codMethod: s.codMethod, at: s.at, ...(handover === undefined ? {} : { handedInAt: handover.at }),
      });
    }
  }
  return out;
}

async function supplierBillsOf(input: Base, tenantId: string): Promise<readonly StoredSupplierBill[]> {
  return (await liveSupplierInvoices(input.store, tenantId)).map((b) => ({
    invoiceId: b.invoiceId, supplierId: b.supplierId, capturedAt: b.capturedAt,
    lines: b.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor })),
  }));
}

const reading = async <T>(f: () => Promise<readonly T[]>) => ({ known: true as const, records: await f() });

/** The loss-prevention controls' deps over the event store. */
export function lpControlsAdapter(input: Base): LpControlsDeps {
  const { store, now } = input;
  const roster = rosterStoreAdapter({ store, now });
  return {
    now,
    thresholds: async (t): Promise<FraudThresholds> => fraudSignalsAdapter({ store, now }).thresholds(t),
    couponRedemptions: (t) => reading(() => couponRedemptionsOf(input, t)),
    pointsMovements: (t) => reading(() => pointsMovementsOf(input, t)),
    codStops: (t) => reading(() => codStopsOf(input, t)),
    supplierBills: (t) => reading(() => supplierBillsOf(input, t)),
    relatedParties: (t) => relatedPartiesOf(store, t),
    recordRelatedParty: (t, party, by, at) => put(store, t, LP_STREAMS.relatedParties, 'RelatedPartyRecorded', `${party.partyId}-${fp(party)}`, at, { party, by, at }),
    supplierFacts: async (t) => {
      const records = await supplierMasterAdapter({ store, now }).records(t);
      return Promise.all(records.map((r) => supplierFactsOf(input, t, r.supplierId)));
    },
    staffPolicy: async (t) => {
      const last = (await all<{ policy: StaffPurchasePolicy; by: string; at: string }>(store, t, LP_STREAMS.staffPolicy, 'StaffPurchasePolicySet')).at(-1);
      return last === undefined ? { policy: readStaffPurchasePolicy({}), setBy: null, setAt: null } : { policy: readStaffPurchasePolicy(last.policy), setBy: last.by, setAt: last.at };
    },
    recordStaffPolicy: (t, policy, by, at) => put(store, t, LP_STREAMS.staffPolicy, 'StaffPurchasePolicySet', `${fp(policy)}-${at}`, at, { policy, by, at }),
    staffAccounts: (t) => all<StaffAccount>(store, t, LP_STREAMS.staffAccounts, 'StaffAccountRecorded'),
    recordStaffAccount: (t, a) => put(store, t, LP_STREAMS.staffAccounts, 'StaffAccountRecorded', `${a.employeeId}-${a.at}`, a.at, a),
    employeeKnown: async (t, employeeId) => (await roster.roster(t)).employees.some((e) => e.employeeId === employeeId),
    billsBetween: async (t, from, to) => (await store.readStream(t, STREAM.sales, { type: 'SaleCommitted', from, to: new Date(Date.parse(to) + 1).toISOString() }))
      .map((e) => e.event.payload as IncomingSale)
      .map((s): BankedBill => ({
        saleId: s.saleId, receiptNumber: s.receiptNumber, laneId: s.laneId, cashierId: s.cashierId, committedAt: s.committedAt, totalMinor: s.totalMinor,
        ...(s.customerRef === undefined ? {} : { customerRef: s.customerRef }),
        lines: (s.lines ?? []).map((l) => ({ quantityMinor: l.quantityMinor, unitPriceMinor: l.unitPriceMinor, lineTotalMinor: l.lineTotalMinor, ...(l.priceOverride === undefined ? {} : { priceOverride: { ...(l.priceOverride.fromUnitPriceMinor === undefined ? {} : { fromUnitPriceMinor: l.priceOverride.fromUnitPriceMinor }) } }) })),
      })),
    salaryAccounts: (t) => all<SalaryAccount>(store, t, LP_STREAMS.salaryAccounts, 'SalaryAccountRecorded'),
    recordSalaryAccount: (t, a) => put(store, t, LP_STREAMS.salaryAccounts, 'SalaryAccountRecorded', `${a.employeeId}-${a.at}`, a.at, a),
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
  };
}

/** The related-party purchase-order guard's deps. */
export function relatedPartyOrderGuardAdapter(input: Base): RelatedPartyOrderGuardDeps {
  const { store, now } = input;
  const orders = purchaseOrdersAdapter({ store, now });
  return {
    now,
    order: (t, poId) => orders.order(t, poId),
    supplierFacts: (t, supplierId) => supplierFactsOf(input, t, supplierId),
    relatedParties: (t) => relatedPartiesOf(store, t),
    approvals: async (t, poId) => (await all<RelatedPartyOrderApproval>(store, t, LP_STREAMS.relatedPartyApprovals, 'RelatedPartyOrderApproved')).filter((a) => a.poId === poId),
    recordApproval: (t, a) => put(store, t, LP_STREAMS.relatedPartyApprovals, 'RelatedPartyOrderApproved', `${a.poId}-${fp(a.fingerprint)}`, a.at, a),
    isOwner: (t, userId) => isOwnerNow(store, t, userId),
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
  };
}

// ── workforce: enablement, help, letters ───────────────────────────────────────────────────────────────────────────

export const WF_STREAMS = Object.freeze({
  training: streamName(STREAM.workforce, 'training'),
  curricula: streamName(STREAM.workforce, 'curricula'),
  champions: streamName(STREAM.workforce, 'floor-champions'),
  sopContent: streamName(STREAM.workforce, 'sop-content'),
  emergency: streamName(STREAM.workforce, 'emergency'),
  letters: streamName(STREAM.workforce, 'appointment-letters'),
  scan: (scanId: string): string => streamName(STREAM.workforce, 'signed-scan', scanId),
});
const DEPARTMENT_CATEGORIES_STREAM = streamName(STREAM.org, 'department-categories');

async function rosterOf(input: Base, tenantId: string): Promise<StoredRoster> {
  return rosterStoreAdapter({ store: input.store, now: input.now }).roster(tenantId);
}

/** Banked sales in [from, to) by department (the categories each owns — the department report's rule), and the rest. */
async function salesByDepartmentOf(input: Base, tenantId: string, from: string, to: string): Promise<{ totalMinor: number; departments: { departmentId: string; name: string; salesMinor: number }[]; unownedMinor: number }> {
  const { store, now } = input;
  const [sales, nodes, links, categories, products] = await Promise.all([
    store.readStream(tenantId, STREAM.sales, { type: 'SaleCommitted', from, to }),
    orgStructureAdapter({ store, now }).nodes(tenantId),
    all<DepartmentLinkRecord>(store, tenantId, DEPARTMENT_CATEGORIES_STREAM, 'DepartmentCategoriesSet'),
    categoryRegisterAdapter({ store, now }).categories(tenantId),
    productMasterAdapter({ store, now }).products(tenantId),
  ]);
  const live = currentLinks(links);
  const parent = new Map(categories.map((c) => [c.categoryId, c.parentId] as const));
  const productCat = new Map(products.map((p) => [p.productId, p.primaryCategoryId] as const));
  const departments = nodes.filter((n) => n.kind === 'department' && n.status !== 'closed');
  const by = new Map<string, number>(departments.map((d) => [d.nodeId, 0] as const));
  let total = 0; let unowned = 0;
  for (const e of sales) {
    for (const l of (e.event.payload as IncomingSale).lines ?? []) {
      total += l.lineTotalMinor;
      const d = departmentOfCategory(live, (c) => parent.get(c) ?? null, productCat.get(l.productId) ?? null);
      if (d === undefined || !by.has(d)) unowned += l.lineTotalMinor;
      else by.set(d, by.get(d)! + l.lineTotalMinor);
    }
  }
  return { totalMinor: total, departments: departments.map((d) => ({ departmentId: d.nodeId, name: d.name, salesMinor: by.get(d.nodeId) ?? 0 })), unownedMinor: unowned };
}

export function workforceEnablementAdapter(input: Base): WorkforceEnablementDeps {
  const { store, now } = input;
  const sops = sopStoreAdapter({ store, now });
  return {
    now,
    employees: async (t) => (await rosterOf(input, t)).employees,
    shifts: async (t) => { const r = await rosterOf(input, t); return { shifts: r.shifts, assignments: r.assignments }; },
    grants: async (t) => effectiveGrants(store, t),
    trainingAssignments: (t) => all<TrainingAssignment>(store, t, WF_STREAMS.training, 'TrainingAssigned'),
    recordAssignment: (t, a) => put(store, t, WF_STREAMS.training, 'TrainingAssigned', a.assignmentId, a.assignedAt, a),
    trainingCompletions: (t) => all<TrainingCompletion>(store, t, WF_STREAMS.training, 'TrainingCompleted'),
    recordCompletion: (t, c) => put(store, t, WF_STREAMS.training, 'TrainingCompleted', c.assignmentId, c.completedAt, c),
    competencySignOffs: (t) => all<CompetencySignOff>(store, t, WF_STREAMS.training, 'CompetencySigned'),
    recordSignOff: (t, s) => put(store, t, WF_STREAMS.training, 'CompetencySigned', `${s.assignmentId}-${s.signedAt}`, s.signedAt, s),
    curricula: (t) => all<ApprovedCurriculum>(store, t, WF_STREAMS.curricula, 'CurriculumApproved'),
    recordCurriculum: (t, c) => put(store, t, WF_STREAMS.curricula, 'CurriculumApproved', `${c.roleId}-v${c.version}`, c.approvedAt, c),
    departments: async (t) => (await orgStructureAdapter({ store, now }).nodes(t)).filter((n) => n.kind === 'department' && n.status !== 'closed').map((n) => ({ departmentId: n.nodeId, name: n.name })),
    champions: (t) => all<FloorChampion>(store, t, WF_STREAMS.champions, 'FloorChampionNamed'),
    recordChampion: (t, c) => put(store, t, WF_STREAMS.champions, 'FloorChampionNamed', `${c.departmentId}-${c.at}`, c.at, c),
    sops: async (t) => helpLibrary(await sops.sops(t), await all<SopContent>(store, t, WF_STREAMS.sopContent, 'SopContentSet')).map((s) => ({ sopId: s.sopId, title: s.title, version: s.version, forRoles: s.forRoles })),
    acknowledgements: (t) => sops.acknowledgements(t) as Promise<readonly SopAcknowledgement[]>,
    owners: async (t) => [...new Set((await effectiveGrants(store, t)).filter((g) => g.roleId === OWNER_ROLE_ID).map((g) => g.userId))].sort(),
    salesByDepartment: (t, from, to) => salesByDepartmentOf(input, t, from, to),
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
  };
}

export function helpCentreAdapter(input: Base): HelpCentreDeps {
  const { store, now } = input;
  const sops = sopStoreAdapter({ store, now });
  return {
    now,
    sops: async (t) => sops.sops(t),
    putSop: async (t, sop, key) => { await sops.putSop(t, sop, key); },
    contents: (t) => all<SopContent>(store, t, WF_STREAMS.sopContent, 'SopContentSet'),
    putContent: (t, c) => put(store, t, WF_STREAMS.sopContent, 'SopContentSet', `${c.sopId}-v${c.version}`, c.setAt, c),
    acknowledgements: async (t, employeeId) => sops.acknowledgements(t, employeeId),
    putAcknowledgement: async (t, ack, key) => { await sops.putAcknowledgement(t, ack, key); },
    employee: async (t, id) => (await rosterOf(input, t)).employees.find((e) => e.employeeId === id),
    employees: async (t) => (await rosterOf(input, t)).employees,
    rolesOf: async (t, userId) => [...new Set((await effectiveGrants(store, t)).filter((g) => g.userId === userId).map((g) => g.roleId))],
    permissionsOf: (t, userId) => permissionsHeldBy(store, t, userId),
    contacts: async (t) => (await all<EmergencyContacts>(store, t, WF_STREAMS.emergency, 'EmergencyContactsSet')).at(-1),
    putContacts: (t, c) => put(store, t, WF_STREAMS.emergency, 'EmergencyContactsSet', `${fp(c.contacts)}-${c.setAt}`, c.setAt, c),
    drills: (t) => all<EmergencyDrill>(store, t, WF_STREAMS.emergency, 'EmergencyDrillRecorded'),
    putDrill: (t, d) => put(store, t, WF_STREAMS.emergency, 'EmergencyDrillRecorded', d.drillId, d.recordedAt, d),
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
  };
}

export function appointmentLetterAdapter(input: Base): AppointmentLetterDeps {
  const { store, now } = input;
  return {
    now,
    wordings: (t) => all<LetterWording>(store, t, WF_STREAMS.letters, 'AppointmentLetterWordingSet'),
    putWording: (t, w) => put(store, t, WF_STREAMS.letters, 'AppointmentLetterWordingSet', `v${w.version}`, w.setAt, w),
    employee: async (t, id) => (await rosterOf(input, t)).employees.find((e) => e.employeeId === id),
    employerNameFor: async (t, branchId) => {
      const org = orgStructureAdapter({ store, now });
      const branch = (await org.nodes(t)).find((n) => n.nodeId === branchId);
      if (branch?.gstin === undefined) return undefined;
      return (await org.registrations(t)).find((r) => r.gstin === branch.gstin)?.legalName;
    },
    letters: (t) => all<AppointmentLetter>(store, t, WF_STREAMS.letters, 'AppointmentLetterIssued'),
    putLetter: (t, l) => put(store, t, WF_STREAMS.letters, 'AppointmentLetterIssued', l.letterId, l.issuedAt, l),
    scans: async (t, letterId) => (await all<SignedScan>(store, t, WF_STREAMS.letters, 'SignedScanKept')).filter((s) => letterId === undefined || s.letterId === letterId),
    putScan: async (t, s, contentBase64) => {
      // The bytes on their own stream (read only when asked for), then the record that names them — never deleted (#6).
      await put(store, t, WF_STREAMS.scan(s.scanId), 'SignedScanBytes', s.scanId, s.keptAt, { scanId: s.scanId, sha256: s.sha256, contentBase64 });
      await put(store, t, WF_STREAMS.letters, 'SignedScanKept', `${s.letterId}-${s.scanId}`, s.keptAt, s);
    },
    scanBytes: async (t, scanId) => (await all<{ contentBase64: string }>(store, t, WF_STREAMS.scan(scanId), 'SignedScanBytes'))[0]?.contentBase64,
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
  };
}

// ── facilities office, captured write-offs, relabel tasks ──────────────────────────────────────────────────────────

/** A route's handler on the surface, found when it is called (so a wrap applied later is the one run). */
const handlerOf = (surface: readonly Route[], method: string, path: string) => (ctx: RequestContext): Promise<HandlerResult> => {
  const r = surface.find((x) => x.method === method && x.path === path);
  if (r === undefined) throw new Error(`the loss-prevention and workforce wiring cannot find ${method} ${path}`);
  return Promise.resolve(r.handler(ctx));
};

export function facilitiesOfficeAdapter(input: Base, surface: readonly Route[]): FacilitiesOfficeDeps {
  const { store, now } = input;
  const assets = facilitiesAssetsAdapter({ store, now });
  const monitoring = facilitiesMonitoringAdapter({ store, now });
  const facilities = facilitiesAdapter({ store, now });
  return {
    now,
    assets: async (t) => assets.assets(t), services: async (t) => assets.services(t), downtime: async (t) => assets.downtime(t), energyReadings: async (t) => assets.energyReadings(t),
    ranges: async (t) => monitoring.ranges(t), readings: async (t) => monitoring.readings(t), contents: async (t) => monitoring.contents(t),
    incidents: async (t) => facilities.incidents(t),
    permissionsOf: (t, u) => permissionsHeldBy(store, t, u),
    recordReadingAs: handlerOf(surface, 'POST', '/v1/facilities/equipment/:assetId/readings/:readingId'),
  };
}

const WRITE_OFF_CAPTURES_STREAM = streamName(STREAM.inventory, 'write-off-captures');
export function writeOffCaptureAdapter(input: Base, surface: readonly Route[]): WriteOffCaptureDeps {
  const { store, now } = input;
  const writeOffs = writeOffAdapter({ store, now });
  return {
    now,
    captures: (t) => all<CaptureRecord>(store, t, WRITE_OFF_CAPTURES_STREAM, 'WriteOffCaptureRecorded'),
    recordCapture: (t, r) => put(store, t, WRITE_OFF_CAPTURES_STREAM, 'WriteOffCaptureRecorded', `${r.loss.writeOffId}-${r.state}-${r.at}`, r.at, r),
    writeOffExists: async (t, id) => writeOffs.writeOffExists(t, id),
    permissionsOf: (t, u) => permissionsHeldBy(store, t, u),
    valueOf: async (t, l) => { const v = await lossValueOf(writeOffs, t, l.productId, l.locationId, l.qty, l.uom); return v.known ? v.valueMinor : undefined; },
    writeOffAs: handlerOf(surface, 'POST', '/v1/inventory/write-off/:writeOffId'),
    askApprovalAs: handlerOf(surface, 'POST', '/v1/approvals/requests'),
    decideApprovalAs: handlerOf(surface, 'POST', '/v1/approvals/requests/:requestId/decide'),
    locationBranches: async (t) => branchOfLocationIn(await orgStructureAdapter({ store, now }).nodes(t)),
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
  };
}

const RELABEL_STREAM = streamName(STREAM.pricing, 'relabel-tasks');
export function relabelTaskAdapter(input: Base, surface: readonly Route[]): RelabelTaskDeps {
  const { store, now } = input;
  const plans = planogramStoreAdapter({ store, now });
  return {
    now,
    tasks: (t) => all<RelabelTask>(store, t, RELABEL_STREAM, 'RelabelTaskRaised'),
    done: (t) => all<RelabelDone>(store, t, RELABEL_STREAM, 'RelabelTaskDone'),
    recordTask: (t, task) => put(store, t, RELABEL_STREAM, 'RelabelTaskRaised', task.taskId, task.raisedAt, task),
    recordDone: (t, d) => put(store, t, RELABEL_STREAM, 'RelabelTaskDone', d.taskId, d.doneAt, d),
    shelfPlaces: async (t, storeId, productId) => latestPlanograms(await plans.planograms(t, storeId)).flatMap((p) => p.assignments.filter((a) => a.productId === productId).map((a) => a.locationId)),
    recordObservationAs: handlerOf(surface, 'POST', '/v1/pricing/integrity/observations/:observationId'),
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
  };
}

/** D11-FR-03: a price set for stores raises the shelf relabel tasks (a price change at once; a store price-list entry from its day). */
function relabelOnPriceChange(surface: Route[], input: Base): void {
  const deps = relabelTaskAdapter(input, surface);
  wrap(surface, 'POST', '/v1/prices/changes', (inner) => async (ctx) => {
    const res = await inner(ctx);
    const b = res.body as { productId?: unknown; priceMinor?: unknown; operativeAt?: unknown } | null;
    if (res.status < 300 && typeof b?.productId === 'string' && Number.isInteger(b.priceMinor) && Array.isArray(b.operativeAt)) {
      const raised = await raiseRelabelTasks(deps, ctx.tenantId, await relabelTasksFor(deps, ctx.tenantId, { productId: b.productId, priceMinor: b.priceMinor as number, storeIds: b.operativeAt as string[], dueAt: input.now(), because: 'price_change', sourceRef: `price-change:${b.productId}:${input.now()}` }));
      return { ...res, body: { ...(res.body as Record<string, unknown>), relabelTasks: raised.length } };
    }
    return res;
  });
  wrap(surface, 'POST', '/v1/prices/list/:productId/entries/:entryId', (inner) => async (ctx) => {
    const res = await inner(ctx);
    const b = res.body as { productId?: unknown; scope?: unknown; scopeRef?: unknown; priceMinor?: unknown; effectiveFrom?: unknown; entryId?: unknown } | null;
    if (res.status < 300 && b?.scope === 'store' && typeof b.scopeRef === 'string' && typeof b.productId === 'string' && Number.isInteger(b.priceMinor) && typeof b.effectiveFrom === 'string') {
      const from = Date.parse(b.effectiveFrom);
      const dueAt = Number.isNaN(from) ? input.now() : new Date(Math.max(from, Date.parse(input.now()))).toISOString();
      const raised = await raiseRelabelTasks(deps, ctx.tenantId, await relabelTasksFor(deps, ctx.tenantId, { productId: b.productId, priceMinor: b.priceMinor as number, storeIds: [b.scopeRef], dueAt, because: 'price_list_entry', sourceRef: `price-list:${b.productId}:${String(b.entryId)}` }));
      return { ...res, body: { ...(res.body as Record<string, unknown>), relabelTasks: raised.length } };
    }
    return res;
  });
}

/**
 * QG-09 as a gate check the owner's gate decisions read (QG-12): while the adoption gate is not GO it blocks a GO
 * decision on QG-09, with its first reason and how many more — the same reading the Training and adoption page shows.
 */
export async function adoptionGateBlockers(store: EventStore, now: () => string, tenantId: string): Promise<readonly OtherGateBlocker[]> {
  const reading = await readAdoptionGate(workforceEnablementAdapter({ store, now }), tenantId);
  if (reading.verdict === 'GO') return [];
  const first = reading.why[0] ?? '';
  return [{ gate: 'QG-09', kind: 'check', ref: 'adoption-gate', reason: `QG-09 adoption is ${reading.verdict === 'HOLD' ? 'on HOLD' : 'not proven'} — ${first}${reading.why.length > 1 ? ` (and ${reading.why.length - 1} more)` : ''}` }];
}

// ── the surface ────────────────────────────────────────────────────────────────────────────────────────────────────

function wrap(surface: Route[], method: string, path: string, around: (inner: Route['handler']) => Route['handler']): void {
  const at = surface.findIndex((r) => r.method === method && r.path === path);
  if (at < 0) throw new Error(`the loss-prevention and workforce wiring cannot find ${method} ${path} — the control it adds would silently not happen`);
  surface[at] = { ...surface[at]!, handler: around(surface[at]!.handler) };
}

/** M15-FR-03: suppliers AND employees in the duplicate-account control (the fold, the report and the payment block). */
function duplicateBankWithEmployees(surface: Route[], input: Base): void {
  wrap(surface, 'GET', '/v1/fraud-signals/duplicate-bank', () => async (ctx: RequestContext): Promise<HandlerResult> => {
    const suppliersAsKept = new Map((await fraudSignalsAdapter({ store: input.store, now: input.now }).bankHolders(ctx.tenantId)).map((h) => [normalAccount(h.accountRef), h.accountRef] as const));
    const flags = detectDuplicateBankAccounts(await allBankHolders(input, ctx.tenantId))
      // An account an employee holds is their salary account — personal data, shown masked. A supplier-only flag is shown as
      // the supplier master keeps it (business data by OB-153 "A"), exactly as before.
      .map((f) => (f.holders.some((h) => h.holderType === 'employee') ? { ...f, accountRef: maskedAccount(f.accountRef) } : { ...f, accountRef: suppliersAsKept.get(f.accountRef) ?? f.accountRef }));
    const employees = (await employeeBankHolders(input.store, ctx.tenantId)).length;
    return { status: 200, body: { flags, blocked: [...holdersBlockedForDuplicate(detectDuplicateBankAccounts(await allBankHolders(input, ctx.tenantId)))].sort(), employeesFolded: employees, asAt: input.now() } };
  });
  wrap(surface, 'POST', '/v1/purchase/suppliers/:supplierId/payments/:paymentId', (inner) => async (ctx) => {
    const supplierId = (ctx.params['supplierId'] ?? '').trim();
    const paymentId = (ctx.params['paymentId'] ?? '').trim();
    const master = supplierMasterAdapter({ store: input.store, now: input.now });
    const already = (await master.payments(ctx.tenantId)).some((p) => p.paymentId === paymentId);
    if (!already && supplierId !== '') {
      const flags = detectDuplicateBankAccounts(await allBankHolders(input, ctx.tenantId));
      const sharedWithEmployee = flags.some((f) => f.holders.some((h) => h.holderId === supplierId && h.holderType === 'supplier') && f.holders.some((h) => h.holderType === 'employee'));
      if (sharedWithEmployee) {
        await input.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'purchase.payment.refused_duplicate_bank', objectType: 'supplier', objectId: supplierId, at: input.now(),
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null, after: { paymentId, sharedWith: 'employee', outcome: 'refused' },
          reason: 'M15-FR-03: a supplier account that is an employee\'s salary account', correlationId: paymentId,
        });
        throw apiError(409, {
          code: 'duplicate_bank_account',
          whatHappened: `Supplier ${supplierId}'s bank account is also an employee's salary account (M15-FR-03) — payment is blocked until a person has reviewed it.`,
          wasItSaved: 'not_saved',
          nextSafeAction: 'Review the duplicate-account flag on the Investigations page and resolve it. Nothing was recorded.',
        });
      }
    }
    return inner(ctx);
  });
}

/** Each coupon issued goes on the coupon index first (idempotent per code), so the stored signals can read it. */
function couponIndex(surface: Route[], input: Base): void {
  wrap(surface, 'POST', '/v1/loyalty/coupons/:code', (inner) => async (ctx) => {
    const code = (ctx.params['code'] ?? '').trim();
    if (code !== '') await put(input.store, ctx.tenantId, LP_STREAMS.couponIndex, 'CouponIndexed', code, input.now(), { code });
    return inner(ctx);
  });
}

/** A points movement made by hand keeps who made it beside it (only once the movement is recorded). */
function pointsAttribution(surface: Route[], input: Base): void {
  wrap(surface, 'POST', '/v1/customers/:customerId/points', (inner) => async (ctx) => {
    const res = await inner(ctx);
    const movementId = (res.body as { movementId?: unknown } | null)?.movementId;
    if (res.status < 300 && typeof movementId === 'string') {
      await put(input.store, ctx.tenantId, LP_STREAMS.pointsAttribution, 'PointsMovementAttributed', movementId, input.now(), { movementId, customerId: ctx.params['customerId'] ?? '', issuedBy: ctx.userId });
    }
    return res;
  });
}

/** The one line in main.ts: this package's routes, and the in-place steps on the existing ones. */
export function lpWorkforceSurface(surface: Route[], raw: LpWorkforceInput): void {
  const input: Base = { store: raw.store ?? new InMemoryEventStore(), now: raw.now, ...(raw.recordAudit === undefined ? {} : { recordAudit: raw.recordAudit }) };
  surface.push(...lpControlsRoutes(lpControlsAdapter(input)));
  surface.push(...workforceEnablementRoutes(workforceEnablementAdapter(input)));
  surface.push(...helpCentreRoutes(helpCentreAdapter(input)));
  surface.push(...appointmentLetterRoutes(appointmentLetterAdapter(input)));
  surface.push(...facilitiesOfficeRoutes(facilitiesOfficeAdapter(input, surface)));
  surface.push(...writeOffCaptureRoutes(writeOffCaptureAdapter(input, surface)));
  surface.push(...relabelTaskRoutes(relabelTaskAdapter(input, surface)));
  relabelOnPriceChange(surface, input);
  const guardDeps = relatedPartyOrderGuardAdapter(input);
  surface.push(...relatedPartyApprovalRoutes(guardDeps));
  const guarded = withRelatedPartyOrderGuard(surface, guardDeps);
  surface.splice(0, surface.length, ...guarded);
  duplicateBankWithEmployees(surface, input);
  couponIndex(surface, input);
  pointsAttribution(surface, input);
}
