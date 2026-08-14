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
}

/**
 * The ERP's full navigation catalogue (§27 role surfaces). Sections map to the
 * modules already built, so the menu grows with the system rather than ahead of it.
 */
export const ERP_NAVIGATION: readonly NavItem[] = Object.freeze([
  { id: 'dashboard', label: 'Dashboard', path: '/', requires: 'erp.dashboard.view', group: 'Overview' },
  { id: 'approvals', label: 'Approvals', path: '/approvals', requires: 'approval.decide', group: 'Overview' },
  { id: 'exceptions', label: 'Exceptions', path: '/exceptions', requires: 'exception.view', group: 'Overview' },

  { id: 'products', label: 'Products', path: '/products', requires: 'catalogue.view', group: 'Catalogue' },
  { id: 'pricing', label: 'Pricing', path: '/pricing', requires: 'price.view', group: 'Catalogue' },
  { id: 'promotions', label: 'Promotions', path: '/promotions', requires: 'promotion.view', group: 'Catalogue' },

  { id: 'suppliers', label: 'Suppliers', path: '/suppliers', requires: 'supplier.view', group: 'Purchasing' },
  { id: 'purchase-orders', label: 'Purchase orders', path: '/purchase-orders', requires: 'po.view', group: 'Purchasing' },
  { id: 'receiving', label: 'Receiving', path: '/receiving', requires: 'grn.view', group: 'Purchasing' },

  { id: 'stock', label: 'Stock', path: '/stock', requires: 'stock.view', group: 'Inventory' },
  { id: 'counts', label: 'Stock counts', path: '/counts', requires: 'count.view', group: 'Inventory' },
  { id: 'waste', label: 'Waste & write-off', path: '/waste', requires: 'waste.view', group: 'Inventory' },

  { id: 'sales', label: 'Sales', path: '/sales', requires: 'sales.view', group: 'Trading' },
  { id: 'returns', label: 'Returns', path: '/returns', requires: 'return.view', group: 'Trading' },
  { id: 'cash', label: 'Cash & day close', path: '/cash', requires: 'cash.view', group: 'Trading' },

  { id: 'finance', label: 'Finance', path: '/finance', requires: 'finance.view', group: 'Finance' },
  { id: 'reconciliation', label: 'Reconciliation', path: '/reconciliation', requires: 'reconciliation.view', group: 'Finance' },
  // GST e-invoice / e-way-bill reconciliation — gated on the SAME permission the queue route checks
  // (`finance.einvoice.read`), so the menu can never offer a screen the server would refuse (item 3 inc2).
  { id: 'gst-reconciliation', label: 'GST reconciliation', path: '/gst-reconciliation', requires: 'finance.einvoice.read', group: 'Finance' },

  { id: 'users', label: 'Users & roles', path: '/admin/users', requires: 'admin.users.manage', group: 'Administration' },
  { id: 'store-setup', label: 'Store setup', path: '/admin/setup', requires: 'platform.setup.read', group: 'Administration' },
  { id: 'settings', label: 'Settings', path: '/admin/settings', requires: 'admin.settings.manage', group: 'Administration' },
  { id: 'audit', label: 'Audit log', path: '/admin/audit', requires: 'audit.view', group: 'Administration' },
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
