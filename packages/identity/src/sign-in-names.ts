// Who a sign-in may be for (OB-15-c · M02-FR-01: "a shared/generic account cannot be created"). One person, one
// sign-in: a name that reads as a job, a counter or a shared account is refused — by head office, and before that by the
// Admin screen, from these SAME rules. Browser-safe: no node built-ins (the browser-apps bundle guardrail).

// Words that name a job, a place or a shared account — never a person. Checked on the name with any trailing number
// or separator removed ("till2", "cashier-01", "admin_1").
const GENERIC = new Set([
  'admin', 'administrator', 'root', 'system', 'service', 'default', 'superuser', 'sa',
  'cashier', 'cash', 'counter', 'till', 'pos', 'lane', 'billing', 'bill', 'checkout',
  'manager', 'supervisor', 'owner', 'operator', 'staff', 'user', 'users', 'employee', 'worker', 'team', 'office',
  'store', 'shop', 'branch', 'warehouse', 'stock', 'sales', 'accounts', 'account', 'finance', 'hr',
  'test', 'tester', 'testing', 'demo', 'trial', 'guest', 'temp', 'temporary', 'training', 'trainee',
  'shared', 'common', 'generic', 'support', 'helpdesk', 'it', 'reception', 'frontdesk', 'security', 'picker', 'driver',
]);

/** True when a sign-in name (or a person's name) is a job, a place or a shared account rather than a person. */
export function isGenericName(name: string): boolean {
  const n = name.trim().toLowerCase();
  const base = n.replace(/[\s._-]*\d+$/, '').replace(/[\s._-]+$/, '');
  if (base === '' || GENERIC.has(base)) return true;
  if (/(^|[\s._-])(shared|common|generic)([\s._-]|$)/.test(n)) return true;
  // "store manager", "till-3 cashier": every word generic.
  const words = base.split(/[\s._-]+/).filter((w) => w !== '' && !/^\d+$/.test(w));
  return words.length > 0 && words.every((w) => GENERIC.has(w));
}

/** A sign-in name: 3 to 40 of a-z, 0-9, dot, underscore, hyphen, starting with a letter or digit. */
export const SIGN_IN_NAME = /^[a-z0-9][a-z0-9._-]{2,39}$/;
/** The product's id for a person. */
export const PRODUCT_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;

/** A person's full name as typed: trimmed and single-spaced. */
export function tidyPersonName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/** Readable as a person's name: 2 to 80 characters with at least one letter. */
export function readablePersonName(name: string): boolean {
  return name.length >= 2 && name.length <= 80 && /\p{L}/u.test(name);
}
