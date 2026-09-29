// Browser entry — the bundler's input for the business-customer portal (`node scripts/build-app.mjs b2b-app`).
// It wires the tested B2B-portal session and attaches it as `window.b2bPortalSession`, plus a small read-only
// `window.b2bPortal` api that `web/app.js` binds to.
//
// ── Where this runs, and why it is not a store-box screen ────────────────────
//
// The B2B portal is a surface a party OUTSIDE the business uses (a caterer or canteen buying on account), so —
// like the supplier portal and unlike every web-erp screen — it is served from the CLOUD web tier (alongside the
// marketing/login pages in apps/site), NOT from a store's edge box. There is no store pack here: the page is fed
// only WHO is looking (`window.b2bData` = the authenticated portal login's userId + permissions, injected by the
// cloud session), and the four feeds it shows are read LIVE from the cloud, each scoped to the caller's OWN
// customer id ON THE SERVER (the browser cannot ask for another customer — there is no customer id to send).
// All four are GETs; this surface writes nothing (M22-FR-04 · §35 · P-04).
//
// ── Refusals are answers, not blanks (P-08) ──────────────────────────────────
//
// A feed the login may not see comes back 403 `no_grant`; that is carried into the data as a refusal so the
// screen says "your login cannot see this — ask us", never a balance of ₹0.00. A network failure is
// `unavailable` — "could not be read just now", not "nothing owed".
//
// ── What may cache (§31) ─────────────────────────────────────────────────────
//
// The last-served page may cache so the portal opens offline and says so (the stale strip), but the figures are
// never treated as current from a cache — they are re-read live on load and Refresh.

import {
  createB2BPortalSession, B2B_DOCUMENT_KINDS, AGE_BUCKETS,
  type B2BPortalSession, type B2BPortalData, type B2BPortalPorts, type B2BFeed, type FeedRefusal,
  type B2BAccountView, type B2BInvoiceView, type B2BStatementView, type B2BDocumentView, type B2BDocumentKind, type AgeBucket,
} from './b2b-portal-session';

export interface B2BScreenData {
  readonly userId?: string;
  readonly permissions?: readonly string[];
}

interface B2BWindow {
  b2bData?: B2BScreenData;
  b2bPortalSession?: B2BPortalSession;
  b2bPortal?: {
    refresh(): Promise<B2BPortalData | null>;
    present(data: B2BPortalData): B2BPortalSession;
  };
}

const SELF_PERMISSION = 'b2b.portal.self';
const EMPTY: B2BPortalData = Object.freeze({ account: null, invoices: null, statement: null, documents: null, refusals: {}, asAt: '' });

export function b2bPortalPortsFromData(data: B2BScreenData | undefined, current: B2BPortalData): B2BPortalPorts {
  const held = new Set(data?.permissions ?? []);
  return {
    portal: () => current,
    // Default-deny: an absent permission list reads nothing (the cloud re-checks b2b.portal.self anyway).
    mayRead: () => held.has(SELF_PERMISSION),
  };
}

/** Build the B2B-portal session over the folded data, or null when the page carried no login payload. */
export function bootB2BPortal(data: B2BScreenData | undefined, current: B2BPortalData): B2BPortalSession | null {
  if (data === undefined) return null;
  return createB2BPortalSession({ userId: data.userId === undefined ? null : data.userId }, b2bPortalPortsFromData(data, current));
}

type FeedRead<T> = { readonly ok: true; readonly body: T } | { readonly ok: false; readonly refusal: FeedRefusal };

/** Read one portal GET. A 403 `no_grant` is a permission answer carried as such; anything else unreadable is
 *  `unavailable`. Never throws, never invents a body. */
async function getFeed(path: string): Promise<FeedRead<Record<string, unknown>>> {
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return { ok: false, refusal: 'unavailable' };
  try {
    const res = await fetchFn(path, { method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin' });
    if (res.status >= 400) {
      let code = '';
      try { code = String(((await res.json()) as { error?: { code?: string } }).error?.code ?? ''); } catch { /* an unreadable refusal is still a refusal */ }
      return { ok: false, refusal: res.status === 403 && code === 'no_grant' ? 'no_grant' : 'unavailable' };
    }
    return { ok: true, body: (await res.json()) as Record<string, unknown> };
  } catch {
    return { ok: false, refusal: 'unavailable' };
  }
}

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const optNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const readAccount = (b: Record<string, unknown>): B2BAccountView => ({
  customerId: str(b['customerId']), hasCreditAccount: b['hasCreditAccount'] === true, outstandingMinor: num(b['outstandingMinor']),
  ...(optNum(b['creditLimitMinor']) === undefined ? {} : { creditLimitMinor: optNum(b['creditLimitMinor']) as number }),
  ...(optStr(b['currency']) === undefined ? {} : { currency: optStr(b['currency']) as string }),
  ...(optNum(b['availableCreditMinor']) === undefined ? {} : { availableCreditMinor: optNum(b['availableCreditMinor']) as number }),
  ...(optStr(b['detail']) === undefined ? {} : { detail: optStr(b['detail']) as string }),
});

const readInvoices = (b: Record<string, unknown>): readonly B2BInvoiceView[] =>
  (Array.isArray(b['invoices']) ? (b['invoices'] as Record<string, unknown>[]) : []).map((i) => ({
    invoiceId: str(i['invoiceId']), number: str(i['number']), issuedOn: str(i['issuedOn']), dueOn: str(i['dueOn']),
    grossMinor: num(i['grossMinor']), settledMinor: num(i['settledMinor']), outstandingMinor: num(i['outstandingMinor']),
    disputed: i['disputed'] === true,
    ...(optStr(i['disputeReason']) === undefined ? {} : { disputeReason: optStr(i['disputeReason']) as string }),
  }));

const readStatement = (b: Record<string, unknown>): B2BStatementView => {
  const ageing = b['ageing'];
  const a = ageing !== null && typeof ageing === 'object' ? (ageing as Record<string, unknown>) : null;
  const rawBuckets = a !== null && typeof a['buckets'] === 'object' && a['buckets'] !== null ? (a['buckets'] as Record<string, unknown>) : {};
  const buckets = Object.fromEntries(AGE_BUCKETS.map((k) => [k, num(rawBuckets[k])])) as Record<AgeBucket, number>;
  return {
    customerId: str(b['customerId']), asAt: str(b['asAt']),
    ageing: a === null ? null : {
      totalOutstandingMinor: num(a['totalOutstandingMinor']), overdueMinor: num(a['overdueMinor']), disputedMinor: num(a['disputedMinor']),
      buckets, detail: str(a['detail']),
    },
    ...(optStr(b['detail']) === undefined ? {} : { detail: optStr(b['detail']) as string }),
  };
};

const readDocuments = (b: Record<string, unknown>): readonly B2BDocumentView[] =>
  (Array.isArray(b['documents']) ? (b['documents'] as Record<string, unknown>[]) : []).map((d) => ({
    documentId: str(d['documentId']),
    kind: (B2B_DOCUMENT_KINDS as readonly string[]).includes(str(d['kind'])) ? (d['kind'] as B2BDocumentKind) : 'tax_invoice',
    number: str(d['number']), grossMinor: num(d['grossMinor']),
    ...(optStr(d['derivedFrom']) === undefined ? {} : { derivedFrom: optStr(d['derivedFrom']) as string }),
    ...(optStr(d['orderId']) === undefined ? {} : { orderId: optStr(d['orderId']) as string }),
    ...(optStr(d['validUntil']) === undefined ? {} : { validUntil: optStr(d['validUntil']) as string }),
  }));

/** Read the customer's OWN four feeds (GETs, read-only), together. A feed that cannot be read stays absent with
 *  its reason — never a false empty. Returns null only when NOTHING could be read (offline). */
export async function fetchB2BPortal(): Promise<B2BPortalData | null> {
  const [account, invoices, statement, documents] = await Promise.all([
    getFeed('/v1/b2b-portal/me/account'), getFeed('/v1/b2b-portal/me/invoices'),
    getFeed('/v1/b2b-portal/me/statement'), getFeed('/v1/b2b-portal/me/documents'),
  ]);
  const reads: readonly [B2BFeed, FeedRead<Record<string, unknown>>][] = [['account', account], ['invoices', invoices], ['statement', statement], ['documents', documents]];
  if (reads.every(([, r]) => !r.ok && r.refusal === 'unavailable')) return null;
  const refusals: Partial<Record<B2BFeed, FeedRefusal>> = {};
  for (const [feed, r] of reads) if (!r.ok) refusals[feed] = r.refusal;
  return {
    account: account.ok ? readAccount(account.body) : null,
    invoices: invoices.ok ? readInvoices(invoices.body) : null,
    statement: statement.ok ? readStatement(statement.body) : null,
    documents: documents.ok ? readDocuments(documents.body) : null,
    refusals,
    asAt: new Date().toISOString(),
  };
}

/** Wire the portal onto the given window: boot the session and expose the read-only refresh/present api. */
export function attachB2BPortal(win: B2BWindow): void {
  const data = win.b2bData;
  const session = bootB2BPortal(data, EMPTY);
  if (session === null) return;
  win.b2bPortalSession = session;
  win.b2bPortal = {
    refresh: fetchB2BPortal,
    present: (folded) => createB2BPortalSession(
      { userId: data?.userId === undefined ? null : data.userId },
      b2bPortalPortsFromData(data, folded),
    ),
  };
}

// Attach on load in the browser (the bundle is browser-only). In the browser `globalThis.window` IS the window,
// so this needs no DOM types and is inert when imported anywhere without a window (a Node test).
const browserWindow = (globalThis as { window?: B2BWindow }).window;
if (browserWindow !== undefined) {
  attachB2BPortal(browserWindow);
}
