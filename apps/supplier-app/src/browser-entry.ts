// Browser entry — the bundler's input for the supplier portal (`node scripts/build-app.mjs supplier-app`).
// It wires the tested supplier-portal session and attaches it as `window.supplierPortalSession`, plus a small
// read-only `window.supplierPortal` api that `web/app.js` binds to.
//
// ── Where this runs, and why it is not a store-box screen ────────────────────
//
// The supplier portal is the ONE surface a party outside the business uses, so — unlike every web-erp screen —
// it is served from the CLOUD web tier (alongside the marketing/login pages in apps/site), NOT from a store's
// edge box. There is no store pack here: the page is fed only WHO is looking (`window.supplierData` = the
// authenticated supplier login's userId + permissions, injected by the cloud session), and the two feeds it
// shows are read LIVE from the cloud, each scoped to the caller's OWN partner id ON THE SERVER (the browser
// cannot ask for another partner — there is no partner id to send). Both are GETs; this surface writes nothing
// (a supplier SUBMITS through separate routes, M24-FR-01).
//
// ── What may cache (§31) ─────────────────────────────────────────────────────
//
// The last-served page may cache so the portal opens offline and says so (the stale strip), but the figures are
// never treated as current from a cache — they are re-read live on load and Refresh.

import {
  createSupplierPortalSession,
  type SupplierPortalSession, type SupplierPortalData, type SupplierPortalPorts,
  type SubmissionView, type StatementView, type SubmissionKind,
} from './supplier-portal-session';

export interface SupplierScreenData {
  readonly userId?: string;
  readonly permissions?: readonly string[];
}

interface SupplierWindow {
  supplierData?: SupplierScreenData;
  supplierPortalSession?: SupplierPortalSession;
  supplierPortal?: {
    refresh(): Promise<SupplierPortalData | null>;
    present(data: SupplierPortalData): SupplierPortalSession;
  };
}

const SELF_PERMISSION = 'supplier.portal.self';
const KINDS: readonly SubmissionKind[] = ['rfq_response', 'catalogue', 'asn', 'invoice', 'po_acknowledgement', 'claim'];

export function supplierPortalPortsFromData(
  data: SupplierScreenData | undefined,
  current: SupplierPortalData,
): SupplierPortalPorts {
  const held = new Set(data?.permissions ?? []);
  return {
    portal: () => current,
    // Default-deny: an absent permission list reads nothing (the cloud re-checks supplier.portal.self anyway).
    mayRead: () => held.has(SELF_PERMISSION),
  };
}

/** Build the supplier-portal session over the folded data, or null when the page carried no login payload. */
export function bootSupplierPortal(
  data: SupplierScreenData | undefined,
  current: SupplierPortalData,
): SupplierPortalSession | null {
  if (data === undefined) return null;
  return createSupplierPortalSession(
    { userId: data.userId === undefined ? null : data.userId },
    supplierPortalPortsFromData(data, current),
  );
}

/** Read one supplier-portal GET and return its parsed body, or null (offline, refused, or unreadable). */
async function getPortal(path: string): Promise<Record<string, unknown> | null> {
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return null;
  try {
    const res = await fetchFn(path, { method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin' });
    if (res.status >= 400) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Read the supplier's OWN submissions (GET, read-only); null when unreadable. Partner scoped server-side. */
export async function fetchSupplierSubmissions(): Promise<readonly SubmissionView[] | null> {
  const body = await getPortal('/v1/supplier-portal/me/submissions');
  if (body === null || !Array.isArray(body['submissions'])) return null;
  return (body['submissions'] as Record<string, unknown>[]).map((s) => ({
    submissionId: String(s['submissionId']),
    kind: KINDS.includes(s['kind'] as SubmissionKind) ? (s['kind'] as SubmissionKind) : 'invoice',
    requiresReview: s['requiresReview'] === true,
    receivedAt: String(s['receivedAt'] ?? ''),
  }));
}

/** Read the supplier's OWN statement (GET, read-only); null when unreadable. Partner scoped server-side. */
export async function fetchSupplierStatement(): Promise<StatementView | null> {
  const body = await getPortal('/v1/supplier-portal/me/statement');
  if (body === null || typeof body['partnerId'] !== 'string') return null;
  return {
    partnerId: String(body['partnerId']),
    accessible: body['accessible'] === true,
    openingMinor: Number(body['openingMinor'] ?? 0),
    invoicedMinor: Number(body['invoicedMinor'] ?? 0),
    debitedMinor: Number(body['debitedMinor'] ?? 0),
    creditedMinor: Number(body['creditedMinor'] ?? 0),
    paidMinor: Number(body['paidMinor'] ?? 0),
    closingMinor: Number(body['closingMinor'] ?? 0),
    disputedMinor: Number(body['disputedMinor'] ?? 0),
    reconciles: body['reconciles'] === true,
    detail: String(body['detail'] ?? ''),
  };
}

/** Wire the portal onto the given window: boot the session and expose the read-only refresh/present api. */
export function attachSupplierPortal(win: SupplierWindow): void {
  const data = win.supplierData;
  let current: SupplierPortalData = { submissions: [], statement: null, asAt: '' };
  const session = bootSupplierPortal(data, current);
  if (session === null) return;
  win.supplierPortalSession = session;
  const present = (folded: SupplierPortalData): SupplierPortalSession =>
    createSupplierPortalSession(
      { userId: data?.userId === undefined ? null : data.userId },
      supplierPortalPortsFromData(data, folded),
    );
  win.supplierPortal = {
    refresh: async () => {
      // Both feeds read together; a feed that fails to load stays absent rather than becoming a false empty.
      const [submissions, statement] = await Promise.all([fetchSupplierSubmissions(), fetchSupplierStatement()]);
      if (submissions === null && statement === null) return null;
      current = {
        submissions: submissions ?? current.submissions,
        statement: statement ?? current.statement,
        asAt: new Date().toISOString(),
      };
      return current;
    },
    present,
  };
}

// Attach on load in the browser (the bundle is browser-only). In the browser `globalThis.window` IS the window,
// so this needs no DOM types and is inert when imported anywhere without a window (a Node test).
const browserWindow = (globalThis as { window?: SupplierWindow }).window;
if (browserWindow !== undefined) {
  attachSupplierPortal(browserWindow);
}
