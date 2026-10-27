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
// `POST /v1/supplier-portal/me/submissions`, checked first by the tested `readDeliveryUpdate` — and, since OB-389, ONE
// more: a vendor-managed-inventory "Top-up proposal" for the supplier's own VMI items at one store,
// `POST /v1/supplier-portal/me/vmi/proposals/:proposalId`, checked first by the tested `readTopUpProposal`. A proposal
// waits for a buyer; it orders nothing (P-05, §28). Exactly these two writes, nothing else.
//
// ── What may cache (§31) ─────────────────────────────────────────────────────
//
// The last-served page may cache so the portal opens offline and says so (the stale strip), but the figures are
// never treated as current from a cache — they are re-read live on load and Refresh.

import {
  createSupplierPortalSession, readDeliveryUpdate, readTopUpProposal,
  type SupplierPortalSession, type SupplierPortalData, type SupplierPortalPorts,
  type SubmissionView, type StatementView, type SubmissionKind, type SupplierOrdersFeed, type DeliveryUpdateInput, type SupplierRebateClaimsFeed,
  type SupplierVmiFeed, type SupplierVmiItem, type SupplierVmiProposalView, type TopUpInput,
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
    /** OB-389: the supplier's own VMI items and proposals as last read (null until read, or when unreadable). */
    vmi(): SupplierVmiFeed | null;
    /** D03-FR-03 · OB-404: the rebate claims the shop sent this supplier, as last read (null until read, or when unreadable). */
    rebateClaims(): SupplierRebateClaimsFeed | null;
    /** OB-389: send the Top-up proposal — checked first; the second and last write this surface makes. */
    sendTopUpProposal(input: TopUpInput): Promise<TopUpOutcome>;
  };
}

const SELF_PERMISSION = 'supplier.portal.self';
/** OB-389: the grant a top-up proposal needs (the server re-checks it). */
const SUBMIT_PERMISSION = 'supplier.portal.self.submit';
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

/** D03-FR-03 · OB-404: read the rebate claims the shop sent this supplier (GET); null when unreadable. Partner scoped server-side. */
export async function fetchSupplierRebateClaims(): Promise<SupplierRebateClaimsFeed | null> {
  const body = await getPortal('/v1/supplier-portal/me/rebate-claims');
  if (body === null || !Array.isArray(body['claims'])) return null;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const STATES = ['sent', 'partly_answered', 'answered', 'withdrawn'] as const;
  return {
    claimsKnown: body['claimsKnown'] === true,
    claims: (body['claims'] as Record<string, unknown>[]).map((c) => ({
      claimId: String(c['claimId']), schemeId: String(c['schemeId'] ?? ''), amountMinor: num(c['amountMinor']), sentOn: String(c['sentOn'] ?? ''),
      answerDueOn: typeof c['answerDueOn'] === 'string' ? c['answerDueOn'] : null, paidMinor: num(c['paidMinor']), leftToPayMinor: num(c['leftToPayMinor']),
      state: (STATES as readonly string[]).includes(String(c['state'])) ? c['state'] as (typeof STATES)[number] : 'sent',
    })),
  };
}

/** OB-389: read the supplier's OWN VMI items and proposals (GET); null when unreadable. Partner scoped server-side. */
export async function fetchSupplierVmi(mayPropose: boolean): Promise<SupplierVmiFeed | null> {
  const body = await getPortal('/v1/supplier-portal/me/vmi');
  if (body === null || !Array.isArray(body['items'])) return null;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const items: SupplierVmiItem[] = (body['items'] as Record<string, unknown>[]).map((i) => ({
    storeId: String(i['storeId']), productId: String(i['productId']), minQty: num(i['minQty']), maxQty: num(i['maxQty']),
    uom: String(i['uom'] ?? ''), onHand: num(i['onHand']), onOrder: num(i['onOrder']), room: num(i['room']), belowMinimum: i['belowMinimum'] === true,
  }));
  const STATUSES = ['awaiting_buyer', 'accepted', 'rejected'] as const;
  const proposals: SupplierVmiProposalView[] = (Array.isArray(body['proposals']) ? body['proposals'] as Record<string, unknown>[] : []).map((p) => ({
    proposalId: String(p['proposalId']), storeId: String(p['storeId']),
    lines: (Array.isArray(p['lines']) ? p['lines'] as Record<string, unknown>[] : []).map((l) => ({ productId: String(l['productId']), quantity: num(l['quantity']) })),
    proposedAt: String(p['proposedAt'] ?? ''),
    status: (STATUSES as readonly string[]).includes(String(p['status'])) ? p['status'] as SupplierVmiProposalView['status'] : 'awaiting_buyer',
    reason: typeof p['reason'] === 'string' ? p['reason'] : null,
  }));
  return { items, notSet: typeof body['notSet'] === 'string' ? body['notSet'] : null, proposals, mayPropose };
}

/** OB-389: what sending a top-up proposal came to. */
export type TopUpOutcome =
  | { readonly result: 'sent'; readonly proposalId: string }
  | { readonly result: 'invalid'; readonly why: string; readonly productId?: string }
  | { readonly result: 'refused'; readonly whatHappened: string }
  | { readonly result: 'lost_link' };

/**
 * OB-389: the SECOND and last write this surface makes — a replenishment proposal for the supplier's own VMI items at one
 * store. Checked against the room it was shown before anything is sent; the server judges it again against the buyer's
 * limits and the stock now, and a buyer decides.
 */
export async function postTopUpProposal(input: TopUpInput, feed: SupplierVmiFeed | null, newId: () => string = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`): Promise<TopUpOutcome> {
  const read = readTopUpProposal(input, feed);
  if (!read.ok) return { result: 'invalid', why: read.why, ...(read.productId === undefined ? {} : { productId: read.productId }) };
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return { result: 'lost_link' };
  const proposalId = `vmi-${read.document.storeId}-${newId()}`;
  try {
    const res = await fetchFn(`/v1/supplier-portal/me/vmi/proposals/${encodeURIComponent(proposalId)}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'idempotency-key': proposalId },
      body: JSON.stringify(read.document),
    });
    if (res.status >= 400) {
      const b = (await res.json().catch(() => ({}))) as { error?: { whatHappened?: string } };
      return { result: 'refused', whatHappened: b.error?.whatHappened ?? `status ${res.status}` };
    }
    return { result: 'sent', proposalId };
  } catch {
    return { result: 'lost_link' };
  }
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

/** Wire the portal onto the given window: boot the session and expose the refresh/present api (and the two writes: OB-362, OB-389). */
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
      const mayPropose = new Set(data?.permissions ?? []).has(SUBMIT_PERMISSION);
      const [submissions, statement, orders, vmi, rebateClaims] = await Promise.all([fetchSupplierSubmissions(), fetchSupplierStatement(), fetchSupplierOrders(), fetchSupplierVmi(mayPropose), fetchSupplierRebateClaims()]);
      if (submissions === null && statement === null && orders === null && vmi === null && rebateClaims === null) return null;
      current = {
        submissions: submissions ?? current.submissions,
        statement: statement ?? current.statement,
        orders: orders ?? current.orders ?? null,
        vmi: vmi ?? current.vmi ?? null,
        rebateClaims: rebateClaims ?? current.rebateClaims ?? null,
        asAt: new Date().toISOString(),
      };
      return current;
    },
    present,
    orders: () => current.orders ?? null,
    sendDeliveryUpdate: (input) => postDeliveryUpdate(input, current.orders ?? null),
    vmi: () => current.vmi ?? null,
    rebateClaims: () => current.rebateClaims ?? null,
    sendTopUpProposal: (input) => postTopUpProposal(input, current.vmi ?? null),
  };
}

// Attach on load in the browser (the bundle is browser-only). In the browser `globalThis.window` IS the window,
// so this needs no DOM types and is inert when imported anywhere without a window (a Node test).
const browserWindow = (globalThis as { window?: SupplierWindow }).window;
if (browserWindow !== undefined) {
  attachSupplierPortal(browserWindow);
}
