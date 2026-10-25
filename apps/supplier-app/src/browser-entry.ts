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
// cannot ask for another partner — there is no partner id to send). They are GETs; this surface writes ONE thing only
// (OB-362): the "Delivery update" for one of the supplier's own open orders — the existing `delivery_status` submission,
// `POST /v1/supplier-portal/me/submissions`, checked first by the tested `readDeliveryUpdate`.
//
// ── What may cache (§31) ─────────────────────────────────────────────────────
//
// The last-served page may cache so the portal opens offline and says so (the stale strip), but the figures are
// never treated as current from a cache — they are re-read live on load and Refresh.

import {
  createSupplierPortalSession, readDeliveryUpdate,
  type SupplierPortalSession, type SupplierPortalData, type SupplierPortalPorts,
  type SubmissionView, type StatementView, type SubmissionKind, type SupplierOrdersFeed, type DeliveryUpdateInput,
} from './supplier-portal-session';

import { mountDemoBanner, type BannerDocument } from '../../../packages/ui/src/demo-banner';

// The practice-data strip ("TRIAL COPY · PRACTICE DATA"), exactly as the ERP shell mounts it. `PILOT_DEMO_BANNER` is a
// build-time constant baked in by esbuild (`scripts/build-app.mjs`): '1' in the hosted-demo build, empty
// in production. `typeof` guards the unbundled case (identifier absent) and a non-browser import.
declare const PILOT_DEMO_BANNER: string;
const demoBannerDoc = (globalThis as { document?: unknown }).document;
if (demoBannerDoc !== undefined && demoBannerDoc !== null) {
  mountDemoBanner(demoBannerDoc as BannerDocument, typeof PILOT_DEMO_BANNER === 'string' ? PILOT_DEMO_BANNER : '');
}

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
    /** OB-362: the supplier's own open orders as last read (null until read, or when unreadable). */
    orders(): SupplierOrdersFeed | null;
    /** OB-362: send the Delivery update — checked first; the one write this surface makes. */
    sendDeliveryUpdate(input: DeliveryUpdateInput): Promise<DeliveryUpdateOutcome>;
  };
}

const SELF_PERMISSION = 'supplier.portal.self';
const KINDS: readonly SubmissionKind[] = ['rfq_response', 'catalogue', 'asn', 'invoice', 'po_acknowledgement', 'claim', 'delivery_status'];

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

/** OB-362: read the supplier's OWN open orders (GET); null when unreadable. Partner scoped server-side. */
export async function fetchSupplierOrders(): Promise<SupplierOrdersFeed | null> {
  const body = await getPortal('/v1/supplier-portal/me/orders');
  if (body === null || !Array.isArray(body['orders'])) return null;
  return {
    ordersKnown: body['ordersKnown'] === true,
    mayUpdate: body['mayUpdate'] === true,
    orders: (body['orders'] as Record<string, unknown>[]).map((o) => ({
      poId: String(o['poId']), number: String(o['number'] ?? o['poId']),
      issuedAt: typeof o['issuedAt'] === 'string' ? o['issuedAt'] : null,
      deliverToLocationId: typeof o['deliverToLocationId'] === 'string' ? o['deliverToLocationId'] : null,
    })),
  };
}

/** OB-362: what sending a delivery update came to. */
export type DeliveryUpdateOutcome =
  | { readonly result: 'sent'; readonly submissionId: string }
  | { readonly result: 'invalid'; readonly why: string }
  | { readonly result: 'refused'; readonly whatHappened: string }
  | { readonly result: 'lost_link' };

/**
 * OB-362: the ONE write this surface makes — the `delivery_status` submission for one of the supplier's own open orders.
 * Checked against the orders it was shown before anything is sent; the server re-checks the order is this supplier's.
 */
export async function postDeliveryUpdate(input: DeliveryUpdateInput, feed: SupplierOrdersFeed | null, newId: () => string = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`): Promise<DeliveryUpdateOutcome> {
  const read = readDeliveryUpdate(input, feed);
  if (!read.ok) return { result: 'invalid', why: read.why };
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return { result: 'lost_link' };
  const submissionId = `ds-${read.document.poId}-${newId()}`;
  try {
    const res = await fetchFn('/v1/supplier-portal/me/submissions', {
      method: 'POST', credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'idempotency-key': submissionId },
      body: JSON.stringify({ submissionId, kind: 'delivery_status', document: read.document }),
    });
    if (res.status >= 400) {
      const b = (await res.json().catch(() => ({}))) as { error?: { whatHappened?: string } };
      return { result: 'refused', whatHappened: b.error?.whatHappened ?? `status ${res.status}` };
    }
    return { result: 'sent', submissionId };
  } catch {
    return { result: 'lost_link' };
  }
}

/** Wire the portal onto the given window: boot the session and expose the refresh/present api (and OB-362's one write). */
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
      // The feeds read together; a feed that fails to load stays absent rather than becoming a false empty.
      const [submissions, statement, orders] = await Promise.all([fetchSupplierSubmissions(), fetchSupplierStatement(), fetchSupplierOrders()]);
      if (submissions === null && statement === null && orders === null) return null;
      current = {
        submissions: submissions ?? current.submissions,
        statement: statement ?? current.statement,
        orders: orders ?? current.orders ?? null,
        asAt: new Date().toISOString(),
      };
      return current;
    },
    present,
    orders: () => current.orders ?? null,
    sendDeliveryUpdate: (input) => postDeliveryUpdate(input, current.orders ?? null),
  };
}

// Attach on load in the browser (the bundle is browser-only). In the browser `globalThis.window` IS the window,
// so this needs no DOM types and is inert when imported anywhere without a window (a Node test).
const browserWindow = (globalThis as { window?: SupplierWindow }).window;
if (browserWindow !== undefined) {
  attachSupplierPortal(browserWindow);
}
