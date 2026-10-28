// OB-502 (M25-FR-03): a person who records food-handling work (a production, bakery or counter-food run) needs a VERIFIED
// food-handling certificate in force. This puts one on file for a test's cook — their staff record (when the roster does not
// already hold one) and a certificate verified by a manager — straight on head office's own registers, the way the
// certificate route records them. Synthetic people only.

import type { EventStore } from '../../packages/persistence/src/event-store';
import { certStoreAdapter, rosterStoreAdapter } from '../../services/api/src/adapters';
import { FOOD_HANDLING_CERTIFICATE } from '../../packages/workforce/src/food-handling';

export async function certifyFoodHandler(store: EventStore, tenantId: string, userId: string, opts: {
  readonly branchId?: string; readonly validUntil?: string; readonly issuedOn?: string; readonly verifiedBy?: string; readonly name?: string; readonly certificationId?: string;
} = {}): Promise<void> {
  const now = (): string => new Date().toISOString();
  const roster = rosterStoreAdapter({ store, now });
  const known = (await roster.roster(tenantId)).employees.some((e) => e.employeeId === userId);
  if (!known) {
    await roster.putEmployee(tenantId, { employeeId: userId, name: opts.name ?? userId, branchId: opts.branchId ?? 'br-1', roles: ['cook'], active: true }, `food-handler-emp-${userId}`);
  }
  const certificationId = opts.certificationId ?? `food-${userId}`;
  await certStoreAdapter({ store, now }).putCertification(tenantId, {
    certificationId, employeeId: userId, kind: FOOD_HANDLING_CERTIFICATE, issuedOn: opts.issuedOn ?? '2026-01-01', validUntil: opts.validUntil ?? '2099-12-31',
    verifiedBy: opts.verifiedBy ?? 'u-cert-verifier',
  }, `food-handler-cert-${certificationId}-${opts.validUntil ?? '2099-12-31'}`);
}

/** The roster and certificate sections a hand-written store pack carries for these cooks (valid food-handling certificates). */
export function foodHandlerPackSections(storeId: string, cooks: readonly string[], opts: { readonly validUntil?: string } = {}): { roster: unknown; certifications: unknown } {
  const asAt = new Date().toISOString();
  return {
    roster: { storeId, asAt, employees: cooks.map((c) => ({ employeeId: c, name: c, roles: ['cook'], active: true })), shifts: [], assignments: [], published: [] },
    certifications: {
      asAt, foodHandlingKind: FOOD_HANDLING_CERTIFICATE,
      certifications: cooks.map((c) => ({ certificationId: `food-${c}`, employeeId: c, kind: FOOD_HANDLING_CERTIFICATE, issuedOn: '2026-01-01', validUntil: opts.validUntil ?? '2099-12-31', verifiedBy: 'u-cert-verifier' })),
    },
  };
}
