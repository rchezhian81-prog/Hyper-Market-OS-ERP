// The role catalogue — API-01, M02, SEC-03, OB-01.
//
// **A role is configuration, not tenant data.** What `store_manager` *means* is a set of permission
// codes this product defines; which people hold it is the tenant's business and lives in the event
// stream. Keeping the two apart is what stops a tenant inventing a role that grants a permission
// the product does not have, and what stops one tenant's role definition leaking into another's.
//
// The list is deliberately short and deliberately here, in the composition root, rather than in a
// service: `services/identity` takes the catalogue as a port precisely so this file is the one
// place the product's authority model is written down.

import type { Role } from '../../../packages/rbac/src/rbac';

/**
 * Which role carries the owner's authority.
 *
 * Named as a constant because two separate controls turn on it — only the owner may accept a
 * migration figure into the opening books, and only the owner may sign the verification report —
 * and a string typed twice in two files is a control that silently stops applying.
 */
export const OWNER_ROLE_ID = 'owner';

export const ROLE_CATALOGUE: readonly Role[] = [
  {
    id: OWNER_ROLE_ID,
    name: 'Owner',
    permissions: [
      'identity.self.read', 'identity.role.read', 'identity.role.grant', 'org.branch.read',
      'documents.number.allocate',
      'catalogue.pack.read', 'catalogue.pack.publish',
      'price.change.propose', 'price.change.approve',
      'promotion.simulate', 'promotion.launch', 'promotion.read',
      'purchase.invoice.capture', 'purchase.invoice.match', 'purchase.supplier.bank', 'purchase.commitment.read',
      'inventory.movement.append', 'inventory.availability.read',
      'pos.sale.sync', 'pos.sale.read', 'pos.exception.read', 'pos.return.record',
      'cash.movement.record', 'cash.till.read', 'till.shift.close', 'till.shift.read',
      'customer.consent.read', 'customer.consent.write', 'loyalty.points.read', 'loyalty.points.write',
      'loyalty.value.issue', 'loyalty.value.redeem', 'loyalty.value.read',
      'order.promise', 'order.reservation.read',
      'delivery.attempt.record', 'delivery.run.read',
      'finance.journal.post', 'finance.period.close', 'finance.period.read',
      'settlement.batch.import', 'settlement.review.read', 'settlement.investigation.manage',
      'reporting.dashboard.read', 'reporting.report.read',
      'platform.health.read', 'platform.flag.read', 'platform.flag.write',
      'platform.setup.read', 'platform.setup.write', 'platform.support.grant',
      'migration.verification.read', 'migration.exception.accept',
      'ai.agent.run', 'ai.proposal.read', 'ai.budget.read', 'ai.killswitch.set',
    ],
  },
  {
    id: 'store_manager',
    name: 'Store manager',
    // Everything needed to run the shop, and **nothing that closes a month or grants a role**.
    // Separation of duties is not a policy document; it is which codes are absent from this list.
    permissions: [
      'identity.self.read', 'org.branch.read',
      'catalogue.pack.read',
      'price.change.propose',
      'promotion.simulate', 'promotion.launch', 'promotion.read',
      'purchase.invoice.capture', 'purchase.invoice.match', 'purchase.commitment.read',
      'inventory.movement.append', 'inventory.availability.read',
      'pos.sale.sync', 'pos.sale.read', 'pos.exception.read', 'pos.return.record',
      'cash.movement.record', 'cash.till.read', 'till.shift.close', 'till.shift.read',
      'customer.consent.read', 'customer.consent.write', 'loyalty.points.read', 'loyalty.points.write',
      'loyalty.value.issue', 'loyalty.value.redeem', 'loyalty.value.read',
      'order.promise', 'order.reservation.read',
      'delivery.attempt.record', 'delivery.run.read',
      'finance.period.read', 'reporting.dashboard.read', 'reporting.report.read',
      'platform.health.read',
    ],
  },
  {
    id: 'cashier',
    name: 'Cashier',
    // The narrowest role in the product, and the one most people hold (P-07).
    permissions: [
      'identity.self.read', 'catalogue.pack.read',
      'pos.sale.sync', 'pos.sale.read', 'pos.return.record',
      'cash.movement.record', 'cash.till.read', 'till.shift.close', 'till.shift.read',
      'customer.consent.read', 'loyalty.points.read', 'loyalty.points.write',
      'loyalty.value.issue', 'loyalty.value.redeem', 'loyalty.value.read',
    ],
  },
  {
    id: 'accountant',
    name: 'Accountant',
    // Posts journals; **cannot close the period they posted into** — that refusal is in the
    // finance service and this list is what makes it reachable rather than theoretical.
    permissions: [
      'identity.self.read',
      'finance.journal.post', 'finance.period.read',
      'settlement.batch.import', 'settlement.review.read', 'settlement.investigation.manage',
      'purchase.invoice.match', 'purchase.commitment.read',
      'reporting.dashboard.read', 'reporting.report.read',
    ],
  },
];
