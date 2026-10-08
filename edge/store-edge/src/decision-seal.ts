// THE STORE COMPUTER SEALS WHO MADE A BACK-OFFICE DECISION (ADR-0023 amendment · Wave 2b-vi-c-3 · audit PA-03 ·
// hard rule #10).
//
// A back-office screen the box serves hands it a decision to carry to head office: an approval decided, a supplier bill
// captured, a checklist signed, a migration exception resolved or a control total signed. Each names the person who made
// it. Until now head office could not tell whether a person was actually signed in when that name was written — any
// holder of the sync permission could post a body naming anybody.
//
// Here the box stamps the decision ONLY when the person it verified for this request (the till session, or on the hosted
// copy the person the front's sign-in named) is the person the decision names. The seal covers every word of the record,
// so a decision changed after the box saw it no longer matches. Anything else travels unstamped and head office flags it
// "not verified at the store". A stamp a device sent itself is always removed first: only the box vouches.

import type { DomainEvent } from '../../../packages/contracts/src/event';
import { DECIDER_STAMP_FIELD, sealDecision, type DecisionKind } from '../../../packages/identity/src/till-seal';

/** For each decision the box carries: its kind, the field naming the decider and the field addressing the record. */
export const SEALED_DECISIONS: Readonly<Record<string, { readonly kind: DecisionKind; readonly named: string; readonly id: string }>> = Object.freeze({
  ApprovalDecided: { kind: 'approval_decision', named: 'decidedBy', id: 'id' },
  SupplierInvoiceCaptured: { kind: 'supplier_invoice', named: 'capturedBy', id: 'invoiceId' },
  ChecklistCompleted: { kind: 'checklist', named: 'signedBy', id: 'checklistId' },
  MigrationExceptionResolved: { kind: 'migration_exception', named: 'decidedBy', id: 'exceptionId' },
  MigrationTotalSigned: { kind: 'migration_total', named: 'signedBy', id: 'totalId' },
});

/** The person the box verified for this request, and how. */
export interface VerifiedPerson {
  readonly userId: string;
  readonly via: string;
  readonly laneId: string;
}

/**
 * The event as the box will carry it: a decision stamped when the verified person is the one it names, otherwise
 * unstamped (any stamp it arrived with removed). Every other event is returned untouched.
 */
export function withDeciderSeal(key: Buffer, tenantId: string, event: DomainEvent, verified: VerifiedPerson | undefined): DomainEvent {
  const shape = SEALED_DECISIONS[event.type];
  if (shape === undefined || event.payload === null || typeof event.payload !== 'object' || Array.isArray(event.payload)) return event;
  const payload = { ...(event.payload as Record<string, unknown>) };
  delete payload[DECIDER_STAMP_FIELD];
  const named = payload[shape.named];
  const recordId = payload[shape.id];
  if (verified !== undefined && verified.userId !== '' && typeof named === 'string' && named.trim() === verified.userId
    && typeof recordId === 'string' && recordId !== '') {
    payload[DECIDER_STAMP_FIELD] = sealDecision(key, {
      tenantId, kind: shape.kind, recordId, record: payload, laneId: verified.laneId, userId: verified.userId, via: verified.via,
    });
  }
  return Object.freeze({ ...event, payload: Object.freeze(payload) });
}
