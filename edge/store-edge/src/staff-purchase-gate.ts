// OB-301 (M15-FR-03, owner 23 Oct 2026, in writing): "staff buy only at the service desk, under an owner-set staff-discount
// cap that shows 'not set' until entered; staff never bill themselves" — judged HERE, on the store computer, BEFORE the
// disk, for every sale a till sends. Offline: the rule (`judgeStaffPurchase`, the same function head office's exception
// list runs) reads only the owner's policy and the staff accounts the store pack carries (`policies.staffPurchase`, built
// at head office from `GET /v1/loss-prevention/staff-purchases/till-policy`), and the record the till sent — no network
// call (hard rule #1). A refused sale is never saved: the cashier is told why, in English and Tamil, with the customer
// still at the counter.
//
// Which till is ringing it is THIS box's own lane id (the socket the till is signed in on), never the lane the record
// claims — a till cannot call itself the service desk. The customer named on the bill is the member code this box made
// from the keyed number a moment before (the till never sends one it is believed on). Who rang it is the cashier this box
// has verified as signed in at this till.
//
// A pack that does not carry the policy (one built before the rule) recognises no staff member, so nothing is refused
// here; head office's exception list (`/v1/loss-prevention/staff-purchases/exceptions`) still shows any staff purchase that
// arrives (P-08). A pack that carries it with a part "not set" refuses as the rule says: no service desk named → staff
// shopping is refused at every till; no cap → no staff discount at all.

import {
  judgeStaffPurchase, readStaffPurchasePolicy, type StaffPurchasePolicy, type StaffBill, type StaffPurchaseRefusal,
} from '../../../packages/restricted-sales/src/staff-purchase';

/** The policy as this box's store pack carries it — or undefined when the pack does not carry it (built before OB-301). */
export interface PackStaffPurchase {
  readonly policy: StaffPurchasePolicy;
  /** Customer account (member code) → the employee it belongs to. */
  readonly accounts: ReadonlyMap<string, string>;
}

export type StaffPurchaseAnswer =
  | { readonly ok: true; readonly staffPurchase: boolean }
  | {
    readonly ok: false;
    readonly refusedBecause: 'staff_purchase_refused';
    readonly refusals: readonly StaffPurchaseRefusal[];
    readonly notSet: readonly ('staff_discount_cap' | 'service_desk')[];
    readonly laneMessage: string;
    readonly laneMessageTa: string;
  };

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Read `policies.staffPurchase` from a store pack's policies section. Absent or not an object → undefined (not carried). */
export function packStaffPurchaseOf(policies: unknown): PackStaffPurchase | undefined {
  const raw = isObj(policies) ? policies['staffPurchase'] : undefined;
  if (!isObj(raw)) return undefined;
  const accounts = new Map<string, string>();
  for (const a of Array.isArray(raw['staffAccounts']) ? raw['staffAccounts'] as unknown[] : []) {
    if (!isObj(a)) continue;
    const ref = text(a['customerRef']); const emp = text(a['employeeId']);
    if (ref !== undefined && emp !== undefined) accounts.set(ref, emp);
  }
  return { policy: readStaffPurchasePolicy(raw), accounts };
}

/** The bill as the rule reads it, from the sale record the till sent (after this box named the member). */
export function staffBillOf(record: Record<string, unknown>, laneId: string): StaffBill {
  const lines = Array.isArray(record['lines']) ? record['lines'] as unknown[] : [];
  const customerRef = text(record['customerRef']);
  return {
    laneId, cashierId: text(record['cashierId']) ?? '',
    ...(customerRef === undefined ? {} : { customerRef }),
    lines: lines.flatMap((raw) => {
      if (!isObj(raw)) return [];
      const q = raw['quantityMinor']; const u = raw['unitPriceMinor']; const t = raw['lineTotalMinor'];
      if (typeof q !== 'number' || typeof u !== 'number' || typeof t !== 'number') return [];
      const override = isObj(raw['priceOverride']) ? raw['priceOverride'] : {};
      const from = override['fromUnitPriceMinor'];
      return [{ quantityMinor: q, unitPriceMinor: u, lineTotalMinor: t, ...(Number.isInteger(from) ? { listUnitPriceMinor: from as number } : {}) }];
    }),
  };
}

/** Judge one sale before the disk. Not carried → allowed (head office's list backstops it). */
export function checkStaffPurchase(record: Record<string, unknown>, laneId: string, carried: PackStaffPurchase | undefined): StaffPurchaseAnswer {
  if (carried === undefined) return { ok: true, staffPurchase: false };
  const d = judgeStaffPurchase(staffBillOf(record, laneId), carried.policy, carried.accounts);
  if (!d.staffPurchase) return { ok: true, staffPurchase: false };
  if (d.allowed) return { ok: true, staffPurchase: true };
  return {
    ok: false, refusedBecause: 'staff_purchase_refused', refusals: d.refusals, notSet: d.notSet,
    laneMessage: `Do not take payment. This is a staff member's own shopping. ${d.words.en} Nothing was saved.`,
    laneMessageTa: `பணம் வாங்க வேண்டாம். இது ஒரு பணியாளரின் சொந்தப் பொருட்கள். ${d.words.ta} எதுவும் சேமிக்கப்படவில்லை.`,
  };
}
