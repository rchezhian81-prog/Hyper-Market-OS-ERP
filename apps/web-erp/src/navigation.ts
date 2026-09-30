// Role-scoped navigation (§27 role surfaces / P-07 "the simplest interface each
// role needs" / P-04 least privilege). The ERP serves many roles — store manager,
// purchase, inventory, finance, security, admin — and each should see only their
// own work. So the menu is DERIVED from the user's actual permissions rather than
// hand-maintained per role: a section appears only if the user holds the permission
// that section requires, in the branch they are working in.
//
// Two consequences matter:
//   • the menu can never show a section the user would be refused on (default-deny
//     is the same engine that guards the action itself — `packages/rbac`), so the
//     screen and the server agree;
//   • adding a role is configuration, not code (choose-able per tenant, ADR-0003).
//
// Pure and deterministic — no I/O, no framework. Any SSR view can render this.

import type { AccessControl, Permission } from '../../../packages/rbac/src/rbac';

/** One navigable area of the ERP, gated by the permission it needs. */
export interface NavItem {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  /** The permission a user must hold for this item to appear at all. */
  readonly requires: Permission;
  /** Grouping for the sidebar; items keep their declared order within a group. */
  readonly group: string;
  /** The same label in Tamil (NFR-08) — the menu is drawn in the reader's language, never half of it. */
  readonly labelTa: string;
  /**
   * Where a person can reach this screen TODAY (Stage G slice 5b). `box` (the default) — the store computer serves
   * it, so the menu the box draws may offer it. `unserved` — the page exists in `apps/web-erp/web` but no product
   * component serves it yet, so the box omits it rather than offer a dead link. `unbuilt` — no page exists; the
   * item stays in the catalogue so the gap is named, not forgotten. Both non-box states are listed in the unit
   * test and in docs/STATUS.md, and shrink as screens are built and served.
   */
  readonly served?: 'box' | 'unserved' | 'unbuilt';
}

/** The group headings in both languages, keyed by the `group` an item declares. */
export const NAV_GROUP_LABELS: Readonly<Record<string, { readonly en: string; readonly ta: string }>> = Object.freeze({
  Overview: { en: 'Overview', ta: 'கண்ணோட்டம்' },
  Catalogue: { en: 'Catalogue', ta: 'பொருள் பட்டியல்' },
  Purchasing: { en: 'Purchasing', ta: 'கொள்முதல்' },
  Inventory: { en: 'Inventory', ta: 'சரக்கு' },
  Trading: { en: 'Trading', ta: 'வர்த்தகம்' },
  Finance: { en: 'Finance', ta: 'நிதி' },
  Payroll: { en: 'Payroll', ta: 'ஊதியம்' },
  Staff: { en: 'Staff', ta: 'பணியாளர்கள்' },
  Administration: { en: 'Administration', ta: 'நிர்வாகம்' },
});

/**
 * The ERP's full navigation catalogue (§27 role surfaces). Sections map to the
 * modules already built, so the menu grows with the system rather than ahead of it.
 */
export const ERP_NAVIGATION: readonly NavItem[] = Object.freeze([
  { id: 'dashboard', label: 'Dashboard', labelTa: 'முகப்பு', path: '/manager/', requires: 'till.dayclose.read', group: 'Overview' },
  // Every item below names the permission the SCREEN ITSELF checks (its browser-entry gate) or, for a screen fed
  // only by the store pack, the permission its own cloud read route checks — never a word nobody enforces (Stage G
  // slice 5b reconciled eighteen such words; docs/STATUS.md). Paths are the store computer's routes; `?tab=` opens a
  // tab of a screen, which the shared chrome does on arrival.

  { id: 'products', label: 'Products', labelTa: 'பொருட்கள்', path: '/products', requires: 'catalogue.pack.read', group: 'Catalogue' },
  { id: 'pricing', label: 'Pricing', labelTa: 'விலை நிர்ணயம்', path: '/pricing', requires: 'price.change.propose', group: 'Catalogue' },
  { id: 'promotions', label: 'Promotions', labelTa: 'சலுகைகள்', path: '/promotions', requires: 'promotion.launch', group: 'Catalogue' },
  // Category rules — gated on the SAME permission the resolve route checks (`catalogue.pack.read`), so the
  // menu never offers a screen the server would refuse (M03-FR-01·CAT-POLICY).
  { id: 'category-policy', label: 'Category rules', labelTa: 'வகை விதிகள்', path: '/category-policy', requires: 'catalogue.pack.read', group: 'Catalogue' },
  // Products waiting to publish — the operator delivers a queued product publish, as themselves (ADR-0013).
  // Gated on the SAME authority the publish route checks (`catalogue.pack.publish`), so the menu never offers
  // it to someone the server would refuse — it is the publisher's action screen (M03-FR-01/03).
  { id: 'product-publish-review', label: 'Products to publish', labelTa: 'வெளியிட வேண்டிய பொருட்கள்', path: '/product-publish-review', requires: 'catalogue.pack.publish', group: 'Catalogue' },
  // Data quality — the A08 steward inbox (missing barcodes, duplicate records, missing prices). Gated on the
  // SAME permission the worklist route checks (`ai.proposal.read`), so the menu never offers a screen the
  // server would refuse (A08 · API-13).
  { id: 'data-quality', label: 'Data quality', labelTa: 'தரவுத் தரம்', path: '/data-quality', requires: 'ai.proposal.read', group: 'Catalogue' },

  // Buying — the buyer's one screen: supplier invoices, matching against the order, raising an order (M06).
  // Gated on the purchase-commitment read the order list checks (`purchase.commitment.read`); the propose action
  // needs `purchase.order.propose`, which the route enforces.
  { id: 'buying', label: 'Buying', labelTa: 'வாங்குதல்', path: '/buying/', requires: 'purchase.commitment.read', group: 'Purchasing' },
  { id: 'suppliers', label: 'Suppliers', labelTa: 'விநியோகஸ்தர்கள்', path: '/suppliers', requires: 'supplier.view', group: 'Purchasing', served: 'unbuilt' },
  { id: 'goods-receipt', label: 'Goods receipt review', labelTa: 'சரக்கு வரவு ஆய்வு', path: '/goods-receipt', requires: 'inventory.availability.read', group: 'Purchasing' },

  { id: 'counts', label: 'Stock counts', labelTa: 'சரக்கு எண்ணிக்கை', path: '/counts', requires: 'count.view', group: 'Inventory' },
  { id: 'waste', label: 'Waste & write-off', labelTa: 'வீணானவை மற்றும் தள்ளுபடி', path: '/waste', requires: 'waste.view', group: 'Inventory' },
  // Record a write-off from the shop floor — the WRITE sibling of the read-only /waste review. Gated on the
  // SAME authority the governed write-off route checks (`inventory.movement.append`), so the menu never offers
  // it to someone the server would refuse; §28/evidence/threshold all stay server-side (M28-FR-01).
  { id: 'write-off-capture', label: 'Record a write-off', labelTa: 'தள்ளுபடியைப் பதிவு செய்', path: '/write-off-capture', requires: 'inventory.movement.append', group: 'Inventory' },
  { id: 'stock-health', label: 'Stock health', labelTa: 'சரக்கு நிலை', path: '/stock-health', requires: 'inventory.availability.read', group: 'Inventory' },
  // Shelves and space — counts on the shelf, refills, the range, the planogram (M04). Gated on the range read
  // (`merchandising.range.read`) the assortment route checks.
  { id: 'merchandising', label: 'Shelves & space', labelTa: 'அடுக்குகளும் இடமும்', path: '/merchandising/', requires: 'merchandising.range.read', group: 'Inventory' },
  // Expiry and recalls (M10) — gated on the recall read (`quality.recall.read`); starting or closing a recall needs
  // `quality.recall.initiate`, which the route enforces.
  { id: 'expiry', label: 'Expiry & recalls', labelTa: 'காலாவதி மற்றும் திரும்பப்பெறல்', path: '/expiry/', requires: 'quality.recall.read', group: 'Inventory' },
  // Production runs and QC release (M11) — gated on `production.read`; release needs `production.release`.
  { id: 'production', label: 'Production', labelTa: 'உற்பத்தி', path: '/production/', requires: 'production.read', group: 'Inventory' },
  // Warehouse oversight — occupancy, stock, §28 approvals, transfers, tasks (M09). Gated on the availability read
  // the bin and transfer routes check (`inventory.availability.read`).
  { id: 'warehouse-supervisor', label: 'Warehouse', labelTa: 'கிடங்கு', path: '/warehouse-supervisor/', requires: 'inventory.availability.read', group: 'Inventory' },

  { id: 'finance', label: 'Finance', labelTa: 'நிதி', path: '/finance', requires: 'finance.period.read', group: 'Finance' },
  // Day book — the M23 posting screen: one trading day's sales, returns, takings and refunds posted as balanced
  // journals through the posting map; open exceptions are money the accounts have not taken. Gated on the SAME
  // permission the day-book read route checks (`finance.period.read`), so the menu never offers a screen the server
  // would refuse (M23-FR-01).
  { id: 'day-book', label: 'Day book', labelTa: 'நாள் புத்தகம்', path: '/day-book', requires: 'finance.period.read', group: 'Finance' },
  { id: 'reconciliation', label: 'Reconciliation', labelTa: 'சரிக்கட்டல்', path: '/reconciliation', requires: 'reconciliation.view', group: 'Finance', served: 'unbuilt' },
  // GST e-invoice / e-way-bill reconciliation — gated on the SAME permission the queue route checks
  // (`finance.einvoice.read`), so the menu can never offer a screen the server would refuse (item 3 inc2).
  { id: 'gst-reconciliation', label: 'GST reconciliation', labelTa: 'GST சரிக்கட்டல்', path: '/gst-reconciliation', requires: 'finance.einvoice.read', group: 'Finance' },
  // GST returns — the GSTR-1 filing-status queue, gated on the SAME permission the queue route checks
  // (`finance.gstr.read`), so the menu can never offer a screen the server would refuse (item 3, 4th domain).
  { id: 'gst-returns', label: 'GST returns', labelTa: 'GST ரிட்டர்ன்கள்', path: '/gst-returns', requires: 'finance.gstr.read', group: 'Finance' },

  // Payroll — its OWN group, gated on the payroll permission the server enforces (`payroll.statutory.read`),
  // so cashier/warehouse/floor/ordinary-manager roles never see it and the menu can never offer a screen the
  // server would refuse (owner directive; §27 least-privilege surfaces).
  { id: 'payroll', label: 'Payroll', labelTa: 'ஊதியப் பட்டியல்', path: '/payroll', requires: 'payroll.statutory.read', group: 'Payroll', served: 'unserved' },
  // Employee self-service — own payslip only. Gated on `payroll.ess.self`, which ordinary staff MAY hold for
  // themselves (it is own-record only; the engine refuses any other employee), so it is a separate item.
  { id: 'my-payslip', label: 'My payslip', labelTa: 'என் சம்பளச் சீட்டு', path: '/my-payslip', requires: 'payroll.ess.self', group: 'Payroll', served: 'unserved' },
  // Employee self-service — my rota + my payslip on one screen. Same own-record grant `payroll.ess.self`.
  { id: 'ess', label: 'My self-service', labelTa: 'என் சுய சேவை', path: '/ess', requires: 'payroll.ess.self', group: 'Payroll' },

  // Rota — the manager's rostering screen (M25-FR-01). Gated on the roster read (`workforce.roster.read`);
  // assigning a shift needs `workforce.roster.manage`, which the route enforces.
  { id: 'rostering', label: 'Rota', labelTa: 'பணி முறை', path: '/rostering/', requires: 'workforce.roster.read', group: 'Staff' },
  // Checklists — the day's opening, closing and hygiene checks (M25-FR-02). Gated on `workforce.checklist.read`.
  { id: 'checklist', label: 'Checklists', labelTa: 'சரிபார்ப்புப் பட்டியல்கள்', path: '/checklist/', requires: 'workforce.checklist.read', group: 'Staff' },
  { id: 'users', label: 'Users & roles', labelTa: 'பயனர்களும் பங்குகளும்', path: '/admin/?tab=people', requires: 'identity.role.read', group: 'Administration' },
  // Outside access — the admin screen on its "Outside access" tab: support sessions granted and expiring (M02 /
  // M36). Gated on the support-session read (`platform.support.read`).
  { id: 'support-access', label: 'Outside access', labelTa: 'வெளி அணுகல்', path: '/admin/?tab=support', requires: 'platform.support.read', group: 'Administration' },
  // Tills and devices — the fleet screen (M33): health, registration, status. Gated on `platform.health.read`;
  // registering or changing a device needs `platform.device.manage`, which the routes enforce.
  { id: 'fleet', label: 'Tills & devices', labelTa: 'கல்லாக்களும் சாதனங்களும்', path: '/fleet/', requires: 'platform.health.read', group: 'Administration' },
  // Connections — integration health (M32): each connector's state, dead letters, last contact. Gated on the SAME
  // permission its route checks (`platform.health.read`).
  { id: 'integration-health', label: 'Connections', labelTa: 'இணைப்புகள்', path: '/integration-health/', requires: 'platform.health.read', group: 'Administration' },
  // Facilities — overdue maintenance and compliance tasks (M26). Gated on `facilities.overdue.read`.
  { id: 'facilities', label: 'Facilities', labelTa: 'வசதிகள்', path: '/facilities/', requires: 'facilities.overdue.read', group: 'Administration' },
  // AI control — the kill switch, agents, the proposal queue, cost (A01–A10 governance). Gated on the budget read
  // (`ai.budget.read`), the owner's permission; the switches need `ai.killswitch.set` / `ai.budget.set` /
  // `ai.agent.enable`, which the routes enforce.
  { id: 'ai', label: 'AI control', labelTa: 'AI கட்டுப்பாடு', path: '/ai/', requires: 'ai.budget.read', group: 'Administration' },
  // Migration — where the cutover stands, the figures, the data, the parallel run, the old system (MG-01–MG-12).
  // Gated on the exceptions read the desk route checks (`migration.cleaning.read`); a decision needs
  // `migration.exception.resolve` / `migration.controltotal.sign`, which the routes enforce.
  { id: 'migration', label: 'Migration', labelTa: 'தரவு மாற்றம்', path: '/migration/', requires: 'migration.cleaning.read', group: 'Administration' },  { id: 'store-setup', label: 'Store setup', labelTa: 'கடை அமைப்பு', path: '/admin/setup', requires: 'platform.setup.read', group: 'Administration', served: 'unserved' },
  // Document templates — the wording on every bill / invoice / PO / GRN / statement, versioned: drafted by one
  // person, approved by another, published; the previous version kept (M01-FR-02, §28). Gated on the SAME
  // permission the register route checks (`platform.setup.read`), so the menu never offers a screen the server
  // would refuse; the writes need `platform.setup.write` and the screen withholds them without it.
  { id: 'document-templates', label: 'Document templates', labelTa: 'ஆவண வார்ப்புருக்கள்', path: '/document-templates', requires: 'platform.setup.read', group: 'Administration' },
  { id: 'settings', label: 'Settings', labelTa: 'அமைப்புகள்', path: '/admin/settings', requires: 'admin.settings.manage', group: 'Administration', served: 'unbuilt' },
  { id: 'audit', label: 'Audit log', labelTa: 'தணிக்கைப் பதிவு', path: '/admin/?tab=records', requires: 'audit.retention.read', group: 'Administration' },
  // Operations — the A06 incident inbox (a stuck sync queue, a growing dead-letter pile, an unwell
  // connection, each with its runbook). Gated on the SAME permission the worklist route checks
  // (`ai.proposal.read`), so the menu never offers a screen the server would refuse (A06 · API-13).
  { id: 'operations', label: 'Operations', labelTa: 'செயல்பாடுகள்', path: '/operations', requires: 'ai.proposal.read', group: 'Administration' },
  // Loss prevention — the M15 investigations inbox (a till short, a run of voids, a suspicious refund, each an
  // open case with the money at stake). Gated on the SAME permission the worklist route checks (`lp.case.read`),
  // so the menu never offers a screen the server would refuse (M15-FR-04).
  { id: 'loss-prevention', label: 'Investigations', labelTa: 'விசாரணைகள்', path: '/loss-prevention', requires: 'lp.case.read', group: 'Administration' },
  // Delivery exceptions — the M19 substitution-exception inbox (a swap that left a refund due, an adjustment to
  // collect, a charge above the cap, a short-picked line — each owned by a queue with an SLA clock). Gated on the
  // SAME permission the worklist route checks (`order.read`), so the menu never offers a screen the server would
  // refuse (M19-FR-01 · Item 2).
  // Reports — the reporting screen (D13): sales by day, what cannot be run yet, what to record next. Gated on the
  // report read the catalogue and report routes check (`reporting.report.read`); an export is checked on the box
  // against the pack's own roles per family.
  { id: 'reporting', label: 'Reports', labelTa: 'அறிக்கைகள்', path: '/reporting/', requires: 'reporting.report.read', group: 'Trading' },
  // Service desk — returns taken and cases worked (M13 / M21). Gated on the case read (`service.case.read`).
  { id: 'service', label: 'Service desk', labelTa: 'சேவை மேசை', path: '/service/', requires: 'service.case.read', group: 'Trading' },
  // Store credit and vouchers — liability, velocity, double spends (M17). Gated on the SAME permission its three
  // read routes check (`lp.case.read`): it is loss-prevention oversight of stored value.
  { id: 'stored-value', label: 'Store credit & vouchers', labelTa: 'கடை கடன் மற்றும் வவுச்சர்கள்', path: '/stored-value/', requires: 'lp.case.read', group: 'Trading' },
  { id: 'substitution-exceptions', label: 'Delivery exceptions', labelTa: 'டெலிவரி விதிவிலக்குகள்', path: '/substitution-exceptions', requires: 'order.read', group: 'Trading' },
  // Refund exceptions — the M13/M17 governance surface: refunds that reconciled with a rule broken (store credit
  // over the owner's cap, a credit with no customer, a §28 approval breach, more sent back than the bill sold or
  // was paid). Gated on the SAME permission the exceptions route checks (`lp.case.read`), so the menu never offers
  // a screen the server would refuse (P-03 control-by-exception, P-08 no silent failure).
  { id: 'return-governance', label: 'Refund exceptions', labelTa: 'பணத்திருப்ப விதிவிலக்குகள்', path: '/return-governance', requires: 'lp.case.read', group: 'Administration' },
  { id: 'cash-office', label: 'Over / short sign-off', labelTa: 'கூடுதல் / குறைவு ஒப்புதல்', path: '/cash-office', requires: 'till.shift.read', group: 'Administration' },
  { id: 'risk-acceptance', label: 'Risk acceptance', labelTa: 'இடர் ஏற்பு', path: '/risk-acceptance', requires: 'compliance.risk.read', group: 'Administration' },
  // Reopen a locked day — the controlled, audited unlock (M14-FR-04 / §28). Gated on `till.dayclose.read` (the
  // permission the locked-day list checks); the reopen itself needs `till.dayclose.approve`, which the box and
  // cloud enforce, and the screen offers the form only to a holder. Accountant/owner work.
  { id: 'day-reopen', label: 'Reopen a locked day', labelTa: 'மூடிய நாளை மீண்டும் திற', path: '/day-reopen', requires: 'till.dayclose.read', group: 'Administration' },
  // Data import & export — the M30 console (take data out to an open CSV with an audit trail; bring data in
  // under §28 maker-checker). Gated on `export.read`, the permission the export catalogue/log checks; the import
  // routes additionally enforce their own permissions server-side (M30-FR-01/02/03).
  { id: 'data-io', label: 'Import & export', labelTa: 'தரவு இறக்கம் மற்றும் ஏற்றம்', path: '/data-io', requires: 'export.read', group: 'Administration' },
  // Workforce — the A10 guidance inbox (the day's late staff tasks, a critical overdue one escalated to the
  // manager on duty, each with the recommended action). Gated on the SAME permission the worklist route checks
  // (`ai.proposal.read`), so the menu never offers a screen the server would refuse (A10 · API-13).
  { id: 'workforce', label: 'Workforce', labelTa: 'பணியாளர்கள்', path: '/workforce', requires: 'ai.proposal.read', group: 'Staff' },
]);

/** An item retired from the catalogue, with the reason and where its job lives now — never a silent drop. */
export interface RetiredNavItem {
  readonly id: string;
  readonly label: string;
  readonly reason: string;
  /** The id of the catalogue item that covers it today. */
  readonly insteadUse: string;
}

/**
 * Items retired in Stage G slice 5b while the catalogue was reconciled with the screens the store computer serves.
 * Each was either a TAB of a screen that has its own item (the menu opens the screen; its tabs are on the page) or a
 * second door to a screen another item already opens — and every one gated on a permission no server checked.
 */
export const RETIRED_NAV_ITEMS: readonly RetiredNavItem[] = Object.freeze([
  { id: 'approvals', label: 'Approvals', reason: 'A tab of the manager\'s screen (Dashboard), not a screen of its own.', insteadUse: 'dashboard' },
  { id: 'exceptions', label: 'Exceptions', reason: 'The manager\'s Today view IS the exceptions view; investigations are their own item.', insteadUse: 'dashboard' },
  { id: 'cash', label: 'Cash & day close', reason: 'The "Close the day" tab of the manager\'s screen; over/short and reopen are their own items.', insteadUse: 'dashboard' },
  { id: 'purchase-orders', label: 'Purchase orders', reason: 'The "Raise an order" tab of the buyer\'s screen.', insteadUse: 'buying' },
  { id: 'receiving', label: 'Receiving', reason: 'Goods receipt review is the receiving screen, and already an item.', insteadUse: 'goods-receipt' },
  { id: 'stock', label: 'Stock', reason: 'Stock health is the stock screen, and already an item.', insteadUse: 'stock-health' },
  { id: 'sales', label: 'Sales', reason: 'Sales by day is the Reports screen\'s first report.', insteadUse: 'reporting' },
  { id: 'returns', label: 'Returns', reason: 'Returns are taken on the service desk and governed on Refund exceptions.', insteadUse: 'service' },
]);

export interface NavGroup {
  readonly group: string;
  readonly items: readonly NavItem[];
}

export interface NavigationContext {
  readonly userId: string;
  /** The branch the user is working in; null = a company-wide view. */
  readonly branchId: string | null;
}

/**
 * The navigation this user may actually see, grouped for the sidebar. Empty groups
 * are omitted. Default-deny: an unknown user, or one with no grants, sees nothing.
 */
export function navigationFor(
  access: AccessControl,
  context: NavigationContext,
  catalogue: readonly NavItem[] = ERP_NAVIGATION,
): NavGroup[] {
  const permitted = catalogue.filter((item) =>
    access.can({ userId: context.userId, permission: item.requires, branchId: context.branchId }),
  );

  const groups: NavGroup[] = [];
  for (const item of permitted) {
    const existing = groups.find((g) => g.group === item.group);
    if (existing === undefined) {
      groups.push({ group: item.group, items: [item] });
    } else {
      (existing.items as NavItem[]).push(item);
    }
  }
  return groups;
}

/** True if the user may open this path — the same check the server must apply. */
export function canOpen(
  access: AccessControl,
  context: NavigationContext,
  path: string,
  catalogue: readonly NavItem[] = ERP_NAVIGATION,
): boolean {
  const item = catalogue.find((i) => i.path === path);
  if (item === undefined) return false; // unknown path → denied, never a blank allow
  return access.can({ userId: context.userId, permission: item.requires, branchId: context.branchId });
}

/** The landing page for this user: their first permitted item, or null if none. */
export function landingPath(
  access: AccessControl,
  context: NavigationContext,
  catalogue: readonly NavItem[] = ERP_NAVIGATION,
): string | null {
  const groups = navigationFor(access, context, catalogue);
  return groups[0]?.items[0]?.path ?? null;
}
