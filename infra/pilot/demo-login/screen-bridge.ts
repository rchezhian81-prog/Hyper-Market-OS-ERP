// DEMO-ONLY identity bridge for the hosted demo (owner decision 28 Sep 2026, option A; defect H-11).
//
// ── The gap it closes ────────────────────────────────────────────────────────
// Every screen reads `window.<screen>Data` at boot. In a store, the store-edge screen server
// (ADR-0004, loopback-only) injects it at the `<!--SCREEN-DATA-->` marker. The hosted demo serves the
// shells statically from the cloud front, so nothing is injected and every screen boots "told
// nothing" — even for a signed-in person.
//
// ── What it injects, and what it deliberately does NOT ───────────────────────
// ONLY identity: the signed-in person's `userId` and `permissions`, both read from the LIVE API
// (`GET /v1/identity/me`) with that person's own token — never decided here. No business data: the
// pages listed in BRIDGED_PAGES fetch their own live data from `/v1/...`, where the API re-checks the
// same permissions on every call. The injected permissions only decide what the screen OFFERS; they
// grant nothing (P-04, least privilege).
//
// Pages NOT listed (those that render edge-built data only) get nothing and keep their sample view —
// they need the store edge, which a cloud demo does not have.

/** The injected global per bridged page path, and any identity-only defaults its boot type requires. */
export interface BridgedPage {
  readonly global: string;
  /** Required non-list fields / empty lists the page's boot type needs; never business data. */
  readonly defaults?: Readonly<Record<string, unknown>>;
}

/**
 * The pages that fetch their own live data from `/v1` and so can work with identity alone.
 * Kept in step with the page survey recorded in docs/pilot/HOSTED-DEMO-RESULTS.md (H-11).
 */
export const BRIDGED_PAGES: Readonly<Record<string, BridgedPage>> = Object.freeze({
  // web-erp — each of these boots on identity and then reads its own worklist live from /v1. The store
  // edge sends these same pages exactly `{ permissions, userId }` (edge/store-edge/src/screen-data.ts).
  '/erp/ess.html': { global: 'essData' },
  '/erp/data-quality.html': { global: 'dataQualityInboxData' },
  '/erp/operations.html': { global: 'operationsInboxData' },
  '/erp/loss-prevention.html': { global: 'lossPreventionInboxData' },
  '/erp/rostering.html': { global: 'rosteringData' },
  '/erp/checklist.html': { global: 'checklistData' },
  '/erp/production.html': { global: 'productionData' },
  '/erp/facilities.html': { global: 'facilitiesData' },
  '/erp/return-governance.html': { global: 'returnGovernanceData' },
  '/erp/cash-office.html': { global: 'cashOfficeData' },
  '/erp/risk-acceptance.html': { global: 'riskAcceptanceData' },
  // Read-only here: the Reopen action posts to the store box's lane socket, which a cloud demo has not got.
  '/erp/day-reopen.html': { global: 'dayReopenData' },
  '/erp/stock-health.html': { global: 'stockHealthData' },
  '/erp/stored-value.html': { global: 'storedValueData' },
  '/erp/integration-health.html': { global: 'integrationHealthData' },
  '/erp/goods-receipt.html': { global: 'goodsReceiptData' },
  // Export + the export log load live; with no import templates the import picker is simply empty.
  '/erp/data-io.html': { global: 'dataIoData', defaults: { importTemplates: [] } },
  '/erp/workforce.html': { global: 'workforceInboxData' },
  // Supplier portal — built to be injected by the cloud session; reads its own statement/submissions live.
  '/supplier/index.html': { global: 'supplierData' },
});

const GLOBAL_SHAPE = /^[A-Za-z][A-Za-z0-9]*$/;

/** JSON that is safe inside a <script>: no `</script>`, no HTML comment openers, no JS line separators. */
export function embedJson(value: unknown): string {
  // U+2028 / U+2029 are written via fromCharCode so no editor or tool can turn them into raw
  // line separators inside a regex literal (which broke the build once).
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .split(LS).join('\\u2028')
    .split(PS).join('\\u2029');
}

/** Normalise the `page` query value to a bridged path, or undefined. `/erp/` means `/erp/index.html`. */
export function bridgedPath(page: string | null | undefined, pages: Readonly<Record<string, BridgedPage>> = BRIDGED_PAGES): string | undefined {
  if (page === null || page === undefined) return undefined;
  const path = page.endsWith('/') ? `${page}index.html` : page;
  return Object.prototype.hasOwnProperty.call(pages, path) ? path : undefined;
}

export type BridgeOutcome =
  | { readonly kind: 'identity'; readonly script: string }
  | { readonly kind: 'sign_in'; readonly script: string }
  | { readonly kind: 'none'; readonly script: string };

/**
 * The script body for one page load. Pure: the caller has already verified the session and asked the
 * API who this is. `me` undefined = no valid session.
 */
export function bridgeScript(input: {
  readonly page: string | null | undefined;
  readonly me: { readonly userId: string; readonly permissions: readonly string[] } | undefined;
  readonly pages?: Readonly<Record<string, BridgedPage>>;
}): BridgeOutcome {
  const pages = input.pages ?? BRIDGED_PAGES;
  const path = bridgedPath(input.page, pages);
  if (path === undefined) return { kind: 'none', script: '/* demo identity bridge: nothing for this page */\n' };
  if (input.me === undefined) {
    // Not signed in on a page that needs a person: go and sign in, then come back here.
    return { kind: 'sign_in', script: `location.replace(${embedJson(`/login/?next=${encodeURIComponent(path)}`)});\n` };
  }
  const { global, defaults } = pages[path]!;
  if (!GLOBAL_SHAPE.test(global)) throw new Error(`bridged page ${path} names an invalid global "${global}"`);
  const payload = { ...(defaults ?? {}), userId: input.me.userId, permissions: [...input.me.permissions] };
  return { kind: 'identity', script: `window.${global} = ${embedJson(payload)};\n` };
}

// ── The HTTP side: GET /login/screen-data.js?page=<path> ─────────────────────

import { verifyToken } from '../../../services/identity/src/token';
import { cookieOf, type LoginRequest, type LoginResponse } from './login';

export interface ScreenBridgeDeps {
  readonly idp: { readonly secret: string; readonly issuer: string; readonly audience: string };
  readonly now: () => number;
  /** GET /v1/identity/me on the INTERNAL API with this bearer token, on behalf of this client address. */
  readonly fetchMe: (token: string, forwardedFor: string) => Promise<{ status: number; body: unknown }>;
  readonly pages?: Readonly<Record<string, BridgedPage>>;
}

const SCRIPT_HEADERS = {
  'content-type': 'text/javascript; charset=utf-8',
  // Identity is per person and per moment: never cached, by the browser or anything in between.
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export function createScreenBridgeHandler(deps: ScreenBridgeDeps): (req: LoginRequest) => Promise<LoginResponse> {
  return async (req) => {
    const url = new URL(req.url, 'https://demo.invalid');
    const page = url.searchParams.get('page');
    const token = cookieOf(req.headers);
    let me: { userId: string; permissions: readonly string[] } | undefined;

    // Only a bridged page is worth asking about; the session must verify HERE first (a forged cookie
    // never reaches the API from us) …
    const bridged = bridgedPath(page, deps.pages ?? BRIDGED_PAGES) !== undefined;
    if (bridged && token !== undefined && verifyToken(token, deps.idp, deps.now()).ok) {
      // … and then the API itself says who this is and what they may do.
      const res = await deps.fetchMe(token, req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown');
      const body = res.body as { userId?: unknown; permissions?: unknown } | undefined;
      if (res.status === 200 && typeof body?.userId === 'string' && Array.isArray(body.permissions)) {
        me = { userId: body.userId, permissions: body.permissions.filter((p): p is string => typeof p === 'string') };
      }
    }
    const out = bridgeScript({ page, me, ...(deps.pages === undefined ? {} : { pages: deps.pages }) });
    return { status: 200, headers: { ...SCRIPT_HEADERS }, body: out.script };
  };
}

// ── The gate for the DEMO store box (ADR-0016): GET /login/verify, /login/verify-sell ────────────────
// Called by the HTTPS front's `auth_request` before it forwards anything to the demo store edge. A valid
// demo session is enough to SEE the edge's screens; writing to its lane (a sale) also needs the API to
// say the person may sell (`pos.sale.sync`). Answers only 204 (go on), 401 (no session) or 403 (not
// allowed) — no body. A 204 carries the person's id in `X-Sre-User` for the front to hand to the store box (OB-16).

export const SELL_PERMISSION = 'pos.sale.sync';

export function createSessionGateHandler(deps: Omit<ScreenBridgeDeps, 'pages'>): (req: LoginRequest) => Promise<LoginResponse> {
  const plain = (status: number, who?: string): LoginResponse => ({ status, headers: { 'cache-control': 'no-store', ...(who === undefined ? {} : { 'x-sre-user': who }) }, body: '' });
  return async (req) => {
    const path = new URL(req.url, 'https://demo.invalid').pathname;
    const token = cookieOf(req.headers);
    const verdict = token === undefined ? undefined : verifyToken(token, deps.idp, deps.now());
    if (token === undefined || verdict?.ok !== true) return plain(401);
    // OB-16: a "go on" also NAMES the person, in a header the front copies to the store box (`X-Sre-User`) so the
    // screens run as the one who signed in. Never a body; the id is the one the token already carries.
    const who = verdict.principal?.userId;
    if (path !== '/login/verify-sell') return plain(204, who);
    const res = await deps.fetchMe(token, req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown');
    if (res.status === 401) return plain(401);
    const perms = (res.body as { permissions?: unknown } | undefined)?.permissions;
    return res.status === 200 && Array.isArray(perms) && perms.includes(SELL_PERMISSION) ? plain(204, who) : plain(403);
  };
}
