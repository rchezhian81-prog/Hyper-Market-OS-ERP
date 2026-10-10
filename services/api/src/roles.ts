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

/**
 * Which role runs the shop day to day — named as a constant for the same reason as the owner's: the
 * shortage rule (a material till short opens an investigation assigned to the store manager) resolves
 * this role from the tenant's grants, and a role id typed twice in two files is a control that silently
 * stops applying.
 */
export const STORE_MANAGER_ROLE_ID = 'store_manager';

/**
 * The store computer's OWN role (OB-36 "A", 10 Oct 2026). The box is a machine, not a person: it relays what happened
 * at the store and pulls its feeds, and holds exactly those permissions — nothing a person at a till or a desk uses.
 * The list is held to the routes the box actually calls by tests/unit/the-store-computer-role-covers-what-the-box-sends.
 */
export const STORE_COMPUTER_ROLE_ID = 'store_computer';

export const ROLE_CATALOGUE: readonly Role[] = [
  {
    id: OWNER_ROLE_ID,
    name: 'Owner',
    permissions: [
      'identity.self.read', 'identity.role.read', 'identity.role.request', 'identity.role.grant', 'identity.session.revoke', 'org.branch.read',
      'documents.number.allocate',
      'catalogue.pack.read', 'catalogue.pack.publish',
      'catalogue.merge.propose', 'catalogue.merge.approve',
      // SF-06-b (OB-24 "A"): the owner defines product categories; a manager proposes them for the owner's approval.
      'catalogue.category.propose', 'catalogue.category.approve',
      // PA-06 = DF-3-a: read a store's setup file (the store computer's own identity holds it at its store).
      'store.pack.read',
      'price.change.propose', 'price.change.approve',
      'promotion.simulate', 'promotion.launch', 'promotion.read',
      'purchase.invoice.capture', 'purchase.invoice.match', 'purchase.supplier.bank', 'purchase.commitment.read',
      'purchase.order.propose', 'purchase.order.approve', 'purchase.order.receive', 'purchase.supplier.block',
      'purchase.performance.record', 'purchase.contract.manage',
      'purchase.import.record', 'purchase.import.read',
      'export.read', 'export.sensitive',
      'supplier.portal.manage', 'supplier.portal.submit', 'supplier.portal.review',
      'inventory.movement.append', 'inventory.availability.read', 'inventory.writeoff.threshold.set',
      // SP-8 (F08): the floor indent chain — raise, approve / reject and read the register.
      'inventory.indent.request', 'inventory.indent.approve', 'inventory.indent.read',
      'production.recipe.manage', 'production.plan.commit', 'production.release', 'production.read',
      'concession.tag.sync',
      // SP-2a: an approval decided on the manager's screen reaches the cloud's decisions register through the box.
      'approvals.decision.sync',
      // SP-2b: a delivery booked in and a blind count captured on the manager's screen reach head office through the
      // box; the owner sets the count-approval threshold policy the cloud reconciles against (never the body, F07).
      'inventory.receipt.sync', 'inventory.count.sync', 'inventory.count.policy.set', 'inventory.count.policy.read',
      // SP-8b: the box relays the floor's indent and its receipt from the served Indents screen.
      'inventory.indent.sync',
      // SP-8c-ii: the box relays the shelf count taken on the merchandising screen; the route re-verifies the COUNTER.
      'shelf.count.sync',
      // PF-07: the box relays the till's voids to head office's loss-prevention record (held so the box identity's grant can be approved).
      'lp.activity.sync',
      // SP-7a: the owner holds the box's invoice-sync hop too, so a maker-checker grant of the box identity can be approved.
      'purchase.invoice.sync',
      // SP-7b: the owner sets the three-way-match tolerances every invoice is judged by (never the body, OC-13).
      'purchase.match.policy.set',
      // SP-7c (M06-FR-01 · M23-FR-01): the supplier master — propose / update, approve (a different person), the list, and
      // recording a payment a second person approved.
      'purchase.supplier.manage', 'purchase.supplier.approve', 'purchase.supplier.pay', 'supplier.view',
      'inventory.movement.sync',
      // SP-3b: adjustment REQUESTS relayed from the warehouse handheld, and the separate person who approves them (§28).
      'inventory.adjustment.sync', 'inventory.adjustment.approve',
      // SP-4 (ii): the owner sets the receiving tolerances the cloud applies to every delivery (never the body, F03).
      'inventory.receipt.policy.set', 'inventory.receipt.policy.read',
      'pos.sale.sync', 'pos.return.sync', 'pos.sale.read', 'pos.exception.read', 'pos.return.record', 'pos.return.approve', 'pos.return.threshold.set', 'pos.return.window.set', 'pos.storecredit.cap.set', 'pos.return.noreceipt.cap.set', 'pos.restricted.check',
      'cash.movement.record', 'cash.till.read', 'till.shift.read', 'till.overshort.review',
      // SP-4c: the till's cash movements and shift closes relayed by the store box to the synced routes.
      'cash.movement.sync', 'till.shift.sync',
      'till.dayclose.sync', 'till.dayclose.read', 'till.dayclose.approve',
      'lp.case.manage', 'lp.case.read', 'lp.rule.manage',
      'customer.consent.read', 'customer.consent.write', 'privacy.request.manage', 'privacy.erasure.approve', 'privacy.erasure.execute', 'loyalty.points.read', 'loyalty.points.write', 'loyalty.member.enrol',
      'loyalty.value.issue', 'loyalty.value.redeem', 'loyalty.value.read',
      'loyalty.coupon.issue', 'loyalty.coupon.redeem', 'loyalty.coupon.read',
      'service.case.manage', 'service.case.read', 'service.compensation.approve', 'customer.segment.read', 'customer.segment.manage',
      'customer.campaign.send', 'customer.campaign.read',
      'order.promise', 'order.reservation.read', 'order.read', 'order.lifecycle.manage', 'order.backorder.manage',
      'order.payment.record', 'order.refund.issue', 'order.refund.approve',
      // M19-FR-01 / Item 2: work any substitution-exception queue and manage them (reassign, escalation sweep).
      'order.exception.work', 'order.exception.manage',
      'delivery.attempt.record', 'delivery.run.read', 'delivery.dispatch.manage',
      'delivery.serviceability.manage', 'delivery.serviceability.read',
      'fulfilment.pack.record', 'fulfilment.pack.read',
      // HA-1: hand a wave to a picker at head office, and read a store's open assignments (the box pulls them).
      'fulfilment.wave.assign', 'fulfilment.assignment.read',
      // SP-3c-i hop: the box relays the picker handheld's line outcomes and packs to the wave register.
      'fulfilment.pick.sync',
      // SP-3c-ii hop: the box relays the driver handheld's stop outcomes, settlement and cash handover to the route register.
      'delivery.stop.sync',
      'finance.journal.post', 'finance.posting.configure', 'finance.period.close', 'finance.period.read', 'finance.period.sign', 'finance.creditnote.issue',
      'settlement.batch.import', 'settlement.review.read', 'settlement.investigation.manage',
      'b2b.account.manage', 'b2b.account.read', 'b2b.receivable.record', 'b2b.credit.check',
      'b2b.commission.record', 'b2b.commission.read', 'b2b.document.issue', 'b2b.document.read',
      'concession.contract.manage', 'concession.sale.record', 'concession.charge.read', 'concession.tag.record',
      'scrap.sale.record', 'scrap.review.read', 'waste.view', 'count.view',
      'shelf.count.record', 'shelf.count.read', 'planogram.compliance.read', 'planogram.publish', 'merchandising.space.read', 'merchandising.display.manage', 'merchandising.range.manage', 'merchandising.range.read', 'approvals.delegation.grant', 'approvals.delegation.read',
      'reporting.dashboard.read', 'reporting.report.read', 'reporting.consolidation.manage',
      'platform.health.read', 'platform.alert.manage', 'platform.device.manage', 'platform.flag.read', 'platform.flag.write',
      'platform.setup.read', 'platform.setup.write', 'org.template.pull',
      'platform.support.request', 'platform.support.grant', 'platform.support.read',
      'platform.tenant.export', 'platform.branding.read', 'platform.branding.write',
      'platform.entitlement.read', 'platform.entitlement.manage',
      'platform.plan.read', 'platform.subscription.read', 'platform.subscription.manage', 'platform.billing.webhook',
      'platform.job.read', 'platform.job.manage',
      'platform.service.read', 'platform.service.manage',
      'integration.webhook.receive',
      'facilities.schedule.manage', 'facilities.task.record', 'facilities.overdue.read',
      'facilities.asset.manage', 'facilities.asset.read', 'facilities.reading.record', 'facilities.incident.record',
      'compliance.obligation.manage', 'compliance.obligation.read',
      'compliance.risk.manage', 'compliance.risk.read',
      'audit.hold.manage', 'audit.retention.read',
      'quality.coldchain.assess', 'quality.lottrace.read',
      'quality.recall.initiate', 'quality.recall.read',
      'quality.hold.manage', 'quality.hold.release',
      'price.integrity.audit', 'selfcheckout.operate',
      'owner.alert.read', 'owner.kpi.read', 'owner.brief.manage',
      'refund.exception.read',
      'notification.send.check',
      'backup.verify.read', 'backup.drill.record', 'platform.backup.record',
      'branch.transition.evaluate', 'branch.transition.execute', 'branch.transition.approve',
      'document.template.manage', 'document.template.read', 'document.issue', 'document.retention.dispose',
      'pos.suspend.write', 'pos.suspend.read',
      'pos.quotation.write', 'pos.quotation.read',
      'finance.einvoice.generate', 'finance.einvoice.read',
      'finance.gstr.generate', 'finance.gstr.read', 'finance.gstr.approve', 'finance.gstr.submit',
      'payroll.statutory.read', 'payroll.ess.self',
      'workforce.roster.read', 'workforce.roster.manage', 'workforce.task.read', 'workforce.checklist.read', 'workforce.completion.sync', 'workforce.incentive.read', 'workforce.sop.read',
      'migration.discovery.read', 'migration.preservation.seal', 'migration.preservation.verify',
      'migration.mapping.read', 'migration.mapping.approve', 'migration.cleaning.read',
      'migration.trial.run', 'migration.reconciliation.read',
      'migration.opening.build', 'migration.delta.apply', 'migration.cutover.decide',
      'migration.controltotal.sign',
      'migration.exclusion.propose', 'migration.exclusion.approve',
      'migration.retirement.assess',
      'migration.verification.read', 'migration.exception.accept',
      'migration.extraction.record', 'migration.evidence.record', 'migration.verification.sign',
      'migration.parallel.record', 'migration.parallel.read',
      'migration.exception.record', 'migration.exception.resolve', 'migration.controltotal.record', 'migration.decision.sync',
      'migration.screen.read',
      'ai.agent.run', 'ai.proposal.read', 'ai.suggestion.dismiss', 'ai.budget.read', 'ai.budget.set', 'ai.agent.enable', 'ai.killswitch.set',
    ],
  },
  {
    id: STORE_MANAGER_ROLE_ID,
    name: 'Store manager',
    // Everything needed to run the shop, and **nothing that closes a month or grants a role**.
    // Separation of duties is not a policy document; it is which codes are absent from this list.
    permissions: [
      // M27-FR-03 / Item 3: record a concession docket line at the till; corrections are the engine's SoD call.
      'concession.tag.record',
      'identity.self.read', 'identity.role.request', 'org.branch.read', 'payroll.ess.self',
      'catalogue.pack.read',
      'catalogue.merge.propose',
      'catalogue.category.propose',
      'store.pack.read',
      'ai.proposal.read', 'ai.suggestion.dismiss',
      'price.change.propose',
      'promotion.simulate', 'promotion.launch', 'promotion.read',
      'b2b.credit.check', 'b2b.account.read', 'b2b.commission.read', 'b2b.document.issue', 'b2b.document.read',
      'purchase.invoice.capture', 'purchase.invoice.match', 'purchase.commitment.read',
      'purchase.order.propose', 'purchase.order.receive', 'purchase.supplier.block',
      'purchase.performance.record', 'purchase.contract.manage',
      'purchase.import.record', 'purchase.import.read',
      // SP-7c (M06-FR-01): the purchase user PROPOSES a supplier and reads the list — never approves one, never pays one.
      'purchase.supplier.manage', 'supplier.view',
      'export.read',
      'supplier.portal.manage', 'supplier.portal.submit', 'supplier.portal.review',
      'inventory.movement.append', 'inventory.availability.read',
      // SP-3b: the store manager is the supervisor who approves (or rejects) a handheld's adjustment request — never the raiser.
      'inventory.adjustment.approve',
      // SP-8 (F08): the floor indent chain — a manager raises, approves (never their own) and reads the register.
      'inventory.indent.request', 'inventory.indent.approve', 'inventory.indent.read',
      'production.recipe.manage', 'production.plan.commit', 'production.release', 'production.read',
      'pos.sale.sync', 'pos.return.sync', 'pos.sale.read', 'pos.exception.read', 'pos.return.record', 'pos.return.approve', 'pos.restricted.check',
      'cash.movement.record', 'cash.till.read', 'till.shift.read', 'till.overshort.review',
      'till.dayclose.sync', 'till.dayclose.read',
      'lp.case.manage', 'lp.case.read', 'lp.rule.manage',
      'customer.consent.read', 'customer.consent.write', 'privacy.request.manage', 'privacy.erasure.approve', 'privacy.erasure.execute', 'loyalty.points.read', 'loyalty.points.write', 'loyalty.member.enrol',
      'loyalty.value.issue', 'loyalty.value.redeem', 'loyalty.value.read',
      'loyalty.coupon.issue', 'loyalty.coupon.redeem', 'loyalty.coupon.read',
      'service.case.manage', 'service.case.read', 'customer.segment.read', 'customer.segment.manage',
      'customer.campaign.send', 'customer.campaign.read',
      'order.promise', 'order.reservation.read', 'order.read', 'order.lifecycle.manage', 'order.backorder.manage',
      'order.payment.record', 'order.refund.issue', 'order.refund.approve',
      // M19-FR-01 / Item 2: work any substitution-exception queue and manage them (reassign, escalation sweep).
      'order.exception.work', 'order.exception.manage',
      'delivery.attempt.record', 'delivery.run.read', 'delivery.dispatch.manage',
      'delivery.serviceability.manage', 'delivery.serviceability.read',
      'fulfilment.pack.record', 'fulfilment.pack.read',
      // HA-1: hand a wave to a picker at head office, and read a store's open assignments (the box pulls them).
      'fulfilment.wave.assign', 'fulfilment.assignment.read',
      'finance.period.read', 'reporting.dashboard.read', 'reporting.report.read',
      'scrap.review.read', 'waste.view', 'count.view', 'shelf.count.record', 'shelf.count.read', 'planogram.compliance.read', 'planogram.publish', 'merchandising.space.read', 'merchandising.display.manage', 'merchandising.range.manage', 'merchandising.range.read', 'approvals.delegation.grant', 'approvals.delegation.read', 'workforce.roster.read', 'workforce.roster.manage', 'workforce.task.read', 'workforce.checklist.read', 'workforce.completion.sync', 'workforce.incentive.read', 'workforce.sop.read',
      'platform.health.read', 'platform.alert.manage', 'platform.device.manage',
      'facilities.schedule.manage', 'facilities.task.record', 'facilities.overdue.read',
      'facilities.asset.manage', 'facilities.asset.read', 'facilities.reading.record', 'facilities.incident.record',
      'compliance.obligation.manage', 'compliance.obligation.read',
      'compliance.risk.manage', 'compliance.risk.read',
      'quality.coldchain.assess', 'quality.lottrace.read',
      'quality.recall.initiate', 'quality.recall.read',
      'quality.hold.manage', 'quality.hold.release',
      'price.integrity.audit', 'selfcheckout.operate',
      'owner.alert.read', 'owner.kpi.read', 'owner.brief.manage',
      'refund.exception.read',
      'notification.send.check',
      'backup.verify.read', 'backup.drill.record', 'platform.backup.record',
      'branch.transition.evaluate', 'branch.transition.execute',
      'document.template.manage', 'document.template.read', 'document.issue', 'document.retention.dispose',
      'pos.suspend.write', 'pos.suspend.read',
      'pos.quotation.write', 'pos.quotation.read',
      'finance.einvoice.generate', 'finance.einvoice.read',
      'finance.gstr.generate', 'finance.gstr.read',
      // The migration operator PROPOSES a history exclusion (MG-07); only the OWNER approves it, and
      // never one they proposed themselves — so the proposer must be a role other than the owner.
      'migration.parallel.record', 'migration.parallel.read', 'migration.exclusion.propose',
      // The manager works the night's exception list and records the totals the operator produced (MG-04 /
      // MG-06); signing a total stays the owner's and the CA's. The box's relayed decisions come in under
      // `migration.decision.sync`, which re-checks the decider's OWN authority.
      'migration.cleaning.read', 'migration.reconciliation.read',
      'migration.exception.record', 'migration.exception.resolve', 'migration.controltotal.record', 'migration.decision.sync',
      'migration.screen.read',
    ],
  },
  {
    id: 'cashier',
    name: 'Cashier',
    // The narrowest role in the product, and the one most people hold (P-07).
    permissions: [
      // M27-FR-03 / Item 3: record a concession docket line at the till; corrections are the engine's SoD call.
      'concession.tag.record',
      // PA-06 = DF-3-a: the store computer's own identity (a cashier grant at its store) reads that store's setup file.
      'store.pack.read',
      'identity.self.read', 'payroll.ess.self', 'catalogue.pack.read',
      // The store box's sync identity holds this role. It pulls the catalogue pack under `catalogue.pack.read`
      // and, since Stage C3b, the migration screen's feed under `migration.screen.read` — a READ of the
      // register the box's own screen shows; it grants no decision (those stay with the decider's own grants).
      'migration.screen.read',
      'pos.sale.sync', 'pos.return.sync', 'migration.decision.sync', 'pos.sale.read', 'pos.return.record', 'pos.restricted.check',
      // M27-FR-03 hop: the box relays the till's concession docket lines to the synced route under this identity.
      'concession.tag.sync',
      // SP-2a hop: the box relays approvals DECIDED on the manager's screen to the cloud's decisions register under
      // this identity. The route re-verifies the DECIDER's own authority from their grants — this grants no decision.
      'approvals.decision.sync',
      // SP-2b hops: the box relays deliveries booked in and blind counts captured on the manager's screen. The routes
      // re-verify the RECEIVER / COUNTER and own every judgement (rules, cost, expected, threshold) — these grant nothing.
      'inventory.receipt.sync', 'inventory.count.sync',
      // SP-3a hop: the box relays the warehouse handheld's put-aways and picks to the synced movement route.
      'inventory.movement.sync',
      // SP-3c-i hop: the box relays the PICKER handheld's line outcomes and wave packs to head office's wave register. The
      // routes re-verify the PICKER / PACKER from THEIR grants and record-and-flag — this grants no pick or pack of its own.
      'fulfilment.pick.sync',
      // HA-1: the box PULLS the store's open wave and route assignments for its picker and driver phones — a read of what head
      // office handed this store; it grants no assignment of its own.
      'fulfilment.assignment.read',
      // SP-3c-ii hop: the box relays the DRIVER handheld's stop outcomes, end-of-shift settlement and counted cash handover to
      // head office's route register. The routes re-verify the DRIVER from THEIR grants, run the order's own state machine and
      // record-and-flag — this grants no delivery, settlement or cash authority of its own.
      'delivery.stop.sync',
      // SP-8 (F08): floor staff raise an indent for the shelf and read where it is; a different person approves and issues.
      'inventory.indent.request', 'inventory.indent.read',
      // SP-8b hop: the box relays the floor's indent and its independent receipt from the served Indents screen.
      'inventory.indent.sync',
      // SP-8c-ii hop: the box relays the shelf count taken on the merchandising screen. The route re-verifies the COUNTER
      // from their grants and judges the shelf against head office's own map — this grants no count of its own.
      'shelf.count.sync',
      // PF-07 hop: the box relays the till's voids (with the reason and the cashier it verified) to head office's
      // loss-prevention record, where the store's rules run on them — this grants no case or rule authority of its own.
      'lp.activity.sync',
      // SP-3b hop: the box relays the handheld's adjustment REQUESTS; the route records them pending — this grants no approval.
      'inventory.adjustment.sync',
      // SP-4c hop: the box relays the till's cash movements and shift closes (F10). The routes re-verify the custodian /
      // cashier from THEIR grants and record-and-flag — these grant no cash authority of their own.
      'cash.movement.sync', 'till.shift.sync',
      // SP-7a hop: the box relays supplier invoices captured on the buyer's screen. The route re-verifies the CAPTURER and
      // the APPROVER from THEIR grants and record-and-flags — this grants no capture or approval of its own.
      'purchase.invoice.sync',
      // M01-FR-02: the box pulls the PUBLISHED document templates (the receipt header/footer in force) into the
      // lane's pack under this identity — a read of what head office put in force, never of drafts or names.
      'org.template.pull',
      'cash.movement.record', 'cash.till.read', 'till.shift.read',
      'customer.consent.read', 'loyalty.points.read', 'loyalty.points.write',
      'loyalty.value.issue', 'loyalty.value.redeem', 'loyalty.value.read',
      'loyalty.coupon.redeem', 'loyalty.coupon.read',
      // M19-FR-01 / Item 2: the service desk works the customer-service exception queue (a short-picked line —
      // the customer got less than they ordered). Which queues a role staffs is decided in
      // services/orders/src/exception-ownership.ts; this only opens the door, and never to reassign or sweep.
      'order.exception.work',
    ],
  },
  {
    id: 'platform_admin',
    name: 'Platform administrator',
    // §28 / M33-FR-01 / SEC-11 — the platform-administration function, held *apart* from running
    // the shop. This role runs the platform: settings and feature flags, devices/terminals and app
    // versions (including the remote kill of a broken release, A-10), time-bound support access,
    // tenant export, branding, and licence/entitlements. It **posts no business transaction**.
    //
    // Separation of duties here is not a policy paragraph; it is the shape of this list. Every code
    // below is in the `platform.*` namespace (plus the universal self-read), and *not one*
    // `pos.*`, `cash.*`, `finance.*`, `price.*`, `purchase.*`, `loyalty.value.*`, `scrap.*`,
    // `order.*` or `inventory.*` committing code is present — nor `identity.role.grant`, which is
    // the owner's maker-checker authority. The refusal that an administrator cannot bank a sale,
    // post a journal, approve a purchase order or grant a role is exactly that absence, enforced by
    // the same default-deny kernel as every other role (proved in
    // tests/security/the-platform-admin-cannot-post-a-business-transaction.test.ts).
    permissions: [
      // M35-FR-01: the operator (or the backup script under the operator's credential) records each backup as a fact.
      'platform.backup.record',
      'identity.self.read',
      'platform.health.read',
      'platform.alert.manage',
      'platform.device.manage',
      'platform.flag.read', 'platform.flag.write',
      'platform.support.request', 'platform.support.grant', 'platform.support.read',
      'platform.setup.read', 'platform.setup.write',
      'platform.tenant.export',
      'platform.branding.read', 'platform.branding.write',
      'platform.entitlement.read', 'platform.entitlement.manage',
      'platform.plan.read', 'platform.subscription.read', 'platform.billing.webhook',
      'platform.job.read', 'platform.job.manage',
      'platform.service.read', 'platform.service.manage',
      'platform.partner.manage', 'platform.partner.read',
      // OB-15-c · M02-FR-01: give a NAMED person — never a shared account, never somebody already holding a role — a
      // sign-in at the identity server, and see who has one. It grants no authority: roles stay the owner's
      // maker-checker act (`identity.role.grant` is absent here, by design).
      'platform.person.provision', 'platform.person.read',
    ],
  },
  {
    id: 'accountant',
    name: 'Accountant',
    // Posts journals; **cannot close the period they posted into** — that refusal is in the
    // finance service and this list is what makes it reachable rather than theoretical.
    permissions: [
      'identity.self.read', 'payroll.ess.self',
      'finance.journal.post', 'finance.posting.configure', 'finance.period.read', 'finance.period.sign', 'finance.creditnote.issue',
      'settlement.batch.import', 'settlement.review.read', 'settlement.investigation.manage',
      // M19-FR-01 / Item 2: the finance / payment-reconciliation exception queue (which queues a role staffs is
      // decided in services/orders/src/exception-ownership.ts; this permission only opens the door).
      'order.exception.work',
      'lp.case.read',
      // The §28 authority to approve a store day-close REOPEN (M14-FR-04) — finance oversight signs off
      // reopening a locked trading day; the store manager who reopens must be a different person.
      'till.dayclose.read', 'till.dayclose.approve',
      'b2b.account.manage', 'b2b.account.read', 'b2b.receivable.record', 'b2b.credit.check',
      'b2b.commission.record', 'b2b.commission.read', 'b2b.document.read',
      'concession.contract.manage', 'concession.sale.record', 'concession.charge.read', 'concession.tag.record',
      'scrap.sale.record', 'scrap.review.read',
      'purchase.invoice.match', 'purchase.commitment.read', 'purchase.import.read',
      // SP-7c (M06-FR-01 "Purchase Approver / Finance approve supplier + bank" · M23-FR-01): finance approves a supplier
      // somebody else proposed, reads the list, and records / approves a payment.
      'purchase.supplier.approve', 'purchase.supplier.pay', 'supplier.view',
      'export.read', 'audit.retention.read',
      'reporting.dashboard.read', 'reporting.report.read',
    ],
  },
  {
    id: 'chartered_accountant',
    name: 'Chartered accountant',
    // M23 / C-01 / MG-06 — the external professional who signs the FINANCE and TAX control totals at
    // migration. Deliberately the narrowest of the sign-off roles: it may read the reconciliation and
    // the verification report, and it may sign — and **nothing else**. The rule that a store manager,
    // however senior, cannot sign a tax total is enforced in the reconciliation engine
    // (`packages/migration/src/reconcile.ts` `signControlTotal`, CA_ONLY), and this role is what makes
    // that refusal reachable rather than theoretical: the CA is the one holder for whom it passes.
    permissions: [
      'identity.self.read',
      'migration.reconciliation.read',
      'migration.verification.read',
      'migration.controltotal.sign',
      'migration.verification.sign',
      'migration.parallel.read',
    ],
  },
  {
    id: 'customer',
    name: 'Customer (storefront login)',
    // M20 / §35 — the second role held by a party OUTSIDE the business: a customer signed into the storefront
    // app. As narrow as the supplier's: it may PLACE an order for itself (which reserves stock and records the
    // checkout's payment answer — the same engines the desk uses, hard rule #3 enforced at the door) and READ
    // its own orders, scoped server-side from what the order records about who placed it — never from an id in
    // the request. No `order.*` desk codes, no `pos.*`, no `cash.*`: a customer cannot move another customer's
    // order, confirm or pick anything, or see the shop's registers. A request for another customer's order is
    // refused AND recorded (hard rule #6).
    permissions: [
      'identity.self.read',
      'storefront.order.place', 'storefront.order.read',
      // FUL-06: the customer's OWN consent and data-subject requests, scoped from the session (never an id sent).
      'customer.privacy.self',
    ],
  },
  {
    id: 'supplier',
    name: 'Supplier (portal login)',
    // M24-FR-01 / §35 — the ONE role held by a party OUTSIDE the business: a supplier logging into the
    // portal to see its own orders and statement. Deliberately the narrowest external role in the product,
    // narrower even than the chartered accountant: it may read ITS OWN portal data and nothing else.
    //
    // Separation is the shape of this list. `supplier.portal.self` is a READ of the caller's own rows,
    // scoped server-side from the session's partner binding (the routes never trust a partner id in the
    // request); it is NOT `supplier.portal.manage`/`.review` (those are the BUYER's configure/review
    // authority) nor `.submit` (buyer-operated today). No `pos.*`, `cash.*`, `finance.*`, `purchase.*`
    // committing code is present — a supplier cannot post a business transaction, only see its own.
    permissions: [
      'identity.self.read',
      'supplier.portal.self',
      // SF-09 (Batch 2): the supplier SUBMITS its own documents (an invoice, an ASN) — scoped to its login's partner binding,
      // kept for a buyer's review, never taking effect on its own. Not a business transaction: a buyer decides.
      'supplier.portal.self.submit',
    ],
  },
  {
    id: 'b2b_customer',
    name: 'Business customer (portal login)',
    // M22-FR-04 / §35 — the THIRD role held by a party outside the business: a business customer (a caterer, a
    // canteen) logging into the portal to see its own account, invoices, statement and documents. As narrow as
    // the supplier's: `b2b.portal.self` is a READ of the caller's own rows, scoped server-side from the stored
    // login binding a member of staff made (the routes never trust a customer id in the request). None of the
    // `b2b.*` staff codes — a customer cannot set its own credit limit, record an invoice or issue a document.
    permissions: [
      'identity.self.read',
      'b2b.portal.self',
    ],
  },
  {
    id: STORE_COMPUTER_ROLE_ID,
    name: 'Store computer',
    permissions: [
      // what it PULLS: its own setup, the published catalogue and templates, and the feeds the store's screens serve
      'store.pack.read', 'catalogue.pack.read', 'org.template.pull', 'inventory.indent.read', 'fulfilment.assignment.read',
      'loyalty.points.read', 'migration.screen.read',
      // what it RELAYS from the till and the store's screens and phones (head office re-verifies each person named)
      'pos.sale.sync', 'pos.return.sync', 'till.dayclose.sync', 'till.shift.sync', 'cash.movement.sync',
      'workforce.completion.sync', 'concession.tag.sync', 'approvals.decision.sync', 'delivery.stop.sync', 'fulfilment.pick.sync', 'inventory.movement.sync', 'inventory.receipt.sync',
      'inventory.adjustment.sync', 'inventory.count.sync', 'inventory.indent.sync', 'purchase.invoice.sync', 'shelf.count.sync',
      'migration.decision.sync', 'lp.activity.sync',
      // the GST portal's poll/verify, relayed for the operator (no maker-checker decision; re-authorised on this permission)
      'finance.einvoice.generate',
    ],
  },
];
