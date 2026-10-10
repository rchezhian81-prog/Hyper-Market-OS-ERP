// Carrying out a granted compensation — Wave 6 · PF-11 (M21-FR-03, §28, hard rules #2 #5 #10, P-08).
//
// The audit found a compensation GRANT recorded on the case and nothing else: a goodwill credit the customer was promised
// existed nowhere they could spend it. Approval and execution are now separate steps. The grant (with its second-person
// approval, unchanged) is the decision; this is the execution, through the domain records that already hold value:
//
//   • goodwill_credit → a store-credit instrument for the case's customer, issued once (keyed on the compensation);
//   • loyalty_points  → a points movement onto the customer's points at the owner's point value, once;
//   • refund          → money back through a payment provider or the cash desk: no provider is connected, so it is
//                       PENDING with the reason said — never marked paid by this system (no fake success);
//   • replacement     → goods handed over at the desk: PENDING until the desk records it.
//
// Every attempt leaves a status fact (completed / pending / failed) on the compensation — append-only, the latest is the
// state — and a failed one can be tried again; a retry of a completed one does nothing twice (the value records are keyed
// on the compensation). No AI acts here (hard rule #5): only a granted, approved compensation is ever executed.

import type { CompensationKind } from '../../../packages/service-desk/src/index';
import type { Instrument, ValueMovement } from '../../../packages/loyalty/src/stored-value';

export type FulfilmentStatus = 'completed' | 'pending' | 'failed';

export interface CompensationFulfilment {
  readonly compensationId: string;
  readonly caseId: string;
  readonly kind: CompensationKind;
  readonly status: FulfilmentStatus;
  /** Where the value went: the instrument id, the points movement id — absent until something moved. */
  readonly ref?: string;
  readonly detail: string;
  readonly at: string;
}

export interface FulfilmentPorts {
  /** The point value the owner set (paise). 0 → points cannot be valued, so a points compensation cannot be carried out. */
  readonly pointValuePaise: (tenantId: string) => Promise<number>;
  /** Issue a store-credit instrument and its opening value; idempotent on the instrument id. */
  readonly issueStoreCredit: (tenantId: string, instrument: Instrument, opening: ValueMovement) => Promise<void>;
  /** Add points to a customer's points; idempotent on the movement id. */
  readonly addPoints: (tenantId: string, customerRef: string, movement: { readonly movementId: string; readonly points: number; readonly sourceRef: string; readonly at: string }) => Promise<void>;
  readonly now: () => string;
}

export async function fulfilCompensation(
  ports: FulfilmentPorts, tenantId: string,
  input: { readonly compensationId: string; readonly caseId: string; readonly customerRef: string; readonly kind: CompensationKind; readonly amountMinor: number },
): Promise<CompensationFulfilment> {
  const at = ports.now();
  const base = { compensationId: input.compensationId, caseId: input.caseId, kind: input.kind, at };
  if (input.amountMinor <= 0) return { ...base, status: 'completed', detail: 'Nothing to carry out: the compensation is for nothing.' };
  if ((input.kind === 'goodwill_credit' || input.kind === 'loyalty_points') && input.customerRef.trim() === '') {
    return { ...base, status: 'failed', detail: 'The case names no customer, so the value has nobody to go to. Name the customer on the case and carry it out again.' };
  }
  try {
    switch (input.kind) {
      case 'goodwill_credit': {
        const instrumentId = `goodwill:${input.compensationId}`;
        await ports.issueStoreCredit(tenantId,
          { instrumentId, kind: 'store_credit', ownerRef: input.customerRef, issuedAt: at },
          { movementId: `${instrumentId}:issue`, instrumentId, kind: 'issue', deltaMinor: input.amountMinor, at, channel: 'store', customerRef: input.customerRef, reason: `goodwill on case ${input.caseId}` });
        return { ...base, status: 'completed', ref: instrumentId, detail: `₹${(input.amountMinor / 100).toFixed(2)} of store credit issued to the customer.` };
      }
      case 'loyalty_points': {
        const value = await ports.pointValuePaise(tenantId);
        if (value <= 0) return { ...base, status: 'failed', detail: 'The owner has not set what a point is worth, so this amount cannot be turned into points. Set the point value and carry it out again.' };
        if (input.amountMinor % value !== 0) return { ...base, status: 'failed', detail: `₹${(input.amountMinor / 100).toFixed(2)} is not a whole number of points at ₹${(value / 100).toFixed(2)} a point.` };
        const movementId = `goodwill-${input.compensationId}`;
        await ports.addPoints(tenantId, input.customerRef, { movementId, points: input.amountMinor / value, sourceRef: `case:${input.caseId}`, at });
        return { ...base, status: 'completed', ref: movementId, detail: `${input.amountMinor / value} point(s) added to the customer.` };
      }
      case 'refund':
        return { ...base, status: 'pending', detail: 'A money refund is paid at the cash desk or through the payment provider. No provider is connected, so this system does not mark it paid — record it when the money has gone.' };
      case 'replacement':
        return { ...base, status: 'pending', detail: 'A replacement is handed over at the desk. It stays pending until the desk records it.' };
      default:
        return { ...base, status: 'failed', detail: 'This kind of compensation cannot be carried out here.' };
    }
  } catch (err) {
    return { ...base, status: 'failed', detail: `It could not be carried out: ${err instanceof Error ? err.message : String(err)}. Nothing was given twice; carry it out again.` };
  }
}
