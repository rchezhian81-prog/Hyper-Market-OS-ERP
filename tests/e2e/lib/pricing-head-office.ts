import { readFile } from 'node:fs/promises';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { ApiError, apiError } from '../../../services/kernel/src/index';
import {
  actionDetails, fingerprintOf, namedSecondPersonRefusal, statusOf, takeApproval, APPROVAL_KINDS,
  type ApprovalState,
} from '../../../services/identity/src/approval-requests';
import { checkPrice } from '../../../packages/price-guard/src/price-guard';
import { approveForLaunch, simulatePromotion, PromotionApprovalRequiredError } from '../../../packages/promotions/src/index';
import { money, type CurrencyCode } from '../../../packages/contracts/src/money';
import type { DecidedRequest } from '../../../packages/approvals/src/approvals';

/**
 * A stub head office for the Products & prices screen's browser proofs (ADR-0024 · §28). A helper, not a proof:
 * it cites no requirement, so the evidence ledger counts the specs that use it, never this file.
 *
 * It serves the catalogue page (GET, with the operator's context injected) AND answers, on the SAME origin, the routes
 * the screen touches — so `credentials: 'same-origin'` and a relative `/v1/...` reach it exactly as in production. The
 * routes behave like the real ones because they are built from the real pieces:
 *
 *   • the approval engine's ask + inbox record a request with its fingerprint (`fingerprintOf`) and report where it
 *     stands (`statusOf`);
 *   • `POST /v1/prices/changes` refuses a typed `approval.decidedBy` by name (`namedSecondPersonRefusal`), judges an
 *     `approvalId` with the engine's own `takeApproval` against `actionDetails(body)`, runs the real `checkPrice`, and
 *     spends the approval once;
 *   • `POST /v1/promotions/:id/launch` does the same with `actionDetails(body, { promotionId })`, the real
 *     `simulatePromotion` and `approveForLaunch`.
 *
 * Refusals come back as head office sends them: `{ error: { code, whatHappened, … } }`.
 */

const WEB_DIR = 'apps/web-erp/web';

/** The signed-in operator — the maker, as head office knows them from the session (never from a body value). */
export const CALLER = 'u-manager';
/** Who holds `price.change.approve` (the owner) — never the caller. */
const PRICE_APPROVERS: ReadonlySet<string> = new Set(['u-owner']);

export interface Recorded { readonly method: string; readonly path: string; readonly body: unknown; readonly headers: Record<string, string | string[] | undefined>; }

export interface PricingHeadOffice {
  catalogueData: Record<string, unknown>;
  /** Head office's approval requests, by id — as the engine stores them. */
  readonly approvals: Map<string, ApprovalState>;
  readonly requests: Recorded[];
  /** Make the next governed action (change / launch) refuse with this, as the real route might at that moment. */
  forceRefusal?: { readonly code: string; readonly whatHappened: string };
}

export const newHeadOffice = (catalogueData: Record<string, unknown>): PricingHeadOffice =>
  ({ catalogueData, approvals: new Map(), requests: [] });

const NOW = '2026-10-07T05:00:00.000Z';

/** A DIFFERENT person decides the request, in THEIR own session (on their Approvals page) — head office's record of it. */
export function decideAsSomeoneElse(ho: PricingHeadOffice, requestId: string, decision: 'approved' | 'rejected', reason: string, by = 'u-owner'): void {
  const state = ho.approvals.get(requestId);
  if (state === undefined) throw new Error(`no request ${requestId}`);
  ho.approvals.set(requestId, {
    ...state,
    decision: {
      requestId, decision, decidedBy: by, reason, decidedAt: '2026-10-07T04:30:00.000Z',
      expiresAt: decision === 'approved' ? '2026-10-08T04:30:00.000Z' : null,
    },
  });
}

export const posts = (ho: PricingHeadOffice, path: string): Recorded[] => ho.requests.filter((r) => r.method === 'POST' && r.path === path);

const view = (s: ApprovalState): Record<string, unknown> => ({
  ...s.request, status: statusOf(s, Date.parse(NOW)), label: APPROVAL_KINDS[s.request.kind]?.label ?? s.request.kind,
  ...(s.decision === undefined ? {} : { decidedBy: s.decision.decidedBy, decisionReason: s.decision.reason, decidedAt: s.decision.decidedAt, expiresAt: s.decision.expiresAt }),
  ...(s.usedBy === undefined ? {} : { usedBy: s.usedBy }),
});

/** The engine's judgement of an `approvalId` for this action — the same `takeApproval` the real routes use. */
async function judged(ho: PricingHeadOffice, approvalId: unknown, kind: string, subjectRef: string, details: unknown, valueMinor: number | null) {
  const state = typeof approvalId === 'string' ? ho.approvals.get(approvalId) : undefined;
  const decision = await takeApproval({
    state, kind, subjectRef, details, valueMinor, maker: CALLER, usedBy: `${kind}:${subjectRef}`, now: NOW,
    checkerHolds: (userId, permission) => permission === 'price.change.approve' && PRICE_APPROVERS.has(userId),
  });
  return { decision, spend: () => { ho.approvals.set(approvalId as string, { ...state!, usedBy: `${kind}:${subjectRef}` }); } };
}

async function route(ho: PricingHeadOffice, method: string, path: string, body: unknown): Promise<{ status: number; body: unknown } | undefined> {
  const b = (body !== null && typeof body === 'object' ? body : {}) as Record<string, unknown>;

  if (method === 'POST' && path === '/v1/approvals/requests') {
    const spec = typeof b['kind'] === 'string' ? APPROVAL_KINDS[b['kind']] : undefined;
    const details = b['details'] !== null && typeof b['details'] === 'object' && !Array.isArray(b['details']) ? b['details'] as Record<string, unknown> : undefined;
    const valueMinor = b['valueMinor'] === null || b['valueMinor'] === undefined ? null : b['valueMinor'];
    if (spec === undefined || typeof b['subjectRef'] !== 'string' || b['subjectRef'].trim() === '' || details === undefined
      || typeof b['summary'] !== 'string' || b['summary'].trim() === '' || typeof b['reason'] !== 'string' || b['reason'].trim() === ''
      || (valueMinor !== null && !Number.isSafeInteger(valueMinor))) {
      throw apiError(400, { code: 'not_readable_as_an_approval_request', whatHappened: 'Not readable as an approval request.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was asked.' });
    }
    const requestId = `areq-${ho.approvals.size + 1}`;
    const state: ApprovalState = {
      request: {
        requestId, kind: spec.kind, subjectRef: b['subjectRef'].trim(), valueMinor: valueMinor as number | null,
        fingerprint: fingerprintOf(details), details, summary: b['summary'].trim(), reason: b['reason'].trim(),
        requestedBy: CALLER, requestedAt: new Date(Date.parse('2026-10-07T04:00:00.000Z') + ho.approvals.size * 60_000).toISOString(),
      },
    };
    ho.approvals.set(requestId, state);
    return { status: 201, body: view(state) };
  }

  if (method === 'GET' && path === '/v1/approvals/requests') {
    const mine = [...ho.approvals.values()].filter((s) => s.request.requestedBy === CALLER).map(view);
    return { status: 200, body: { waitingForMe: [], mine, asAt: NOW } };
  }

  if (method === 'POST' && path === '/v1/prices/changes') {
    const typed = (b['approval'] as { decidedBy?: unknown } | undefined)?.decidedBy;
    if (typeof b['approvalId'] !== 'string' && typeof typed === 'string' && typed.trim() !== '') throw namedSecondPersonRefusal('approval.decidedBy', typed);
    if (ho.forceRefusal !== undefined) {
      const f = ho.forceRefusal; ho.forceRefusal = undefined;
      throw apiError(422, { code: f.code, whatHappened: f.whatHappened, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' });
    }
    const productId = String(b['productId']);
    const priceMinor = b['priceMinor'] as number;
    const opened = typeof b['approvalId'] === 'string'
      ? await judged(ho, b['approvalId'], 'price_change', productId, actionDetails(body), priceMinor) : undefined;
    const currency = String(b['currency']) as CurrencyCode;
    const approval: DecidedRequest | undefined = opened === undefined ? undefined : {
      id: `price-${productId}`, subjectType: 'price', subjectRef: `price-${productId}`, requestedBy: CALLER, branchId: null,
      value: null, status: 'approved', decidedBy: opened.decision.decidedBy, reason: opened.decision.reason, decidedAt: opened.decision.decidedAt,
    };
    const check = checkPrice({
      id: `price-${productId}`, proposedPrice: money(priceMinor, currency), mrp: money(b['mrpMinor'] as number, currency),
      cost: money(b['costMinor'] as number, currency), marginFloorBps: b['marginFloorBps'] as number, setBy: CALLER,
      ...(approval === undefined ? {} : { approval }),
    });
    if (!check.allowed) {
      throw apiError(422, {
        code: `price_${check.verdict}`,
        whatHappened: check.verdict === 'above_mrp'
          ? 'The price is above the printed MRP — a legal ceiling no approval can lift.'
          : `The price is ${check.verdict.replace('_', ' ')} and needs a separate approver's sign-off with a reason.`,
        wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.',
      });
    }
    opened?.spend();
    return { status: 201, body: { productId, priceMinor, verdict: check.verdict, approvedBy: approval?.decidedBy ?? null } };
  }

  const launch = /^\/v1\/promotions\/([^/]+)\/launch$/.exec(path);
  if (method === 'POST' && launch !== null) {
    const promotionId = decodeURIComponent(launch[1]!);
    const typed = b['approvedBy'];
    if (typeof b['approvalId'] !== 'string' && typeof typed === 'string' && typed.trim() !== '') throw namedSecondPersonRefusal('approvedBy', typed);
    if (ho.forceRefusal !== undefined) {
      const f = ho.forceRefusal; ho.forceRefusal = undefined;
      throw apiError(422, { code: f.code, whatHappened: f.whatHappened, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was launched.' });
    }
    const simulation = simulatePromotion({
      promotionId, description: typeof b['description'] === 'string' ? b['description'] : '',
      normalPrice: b['normalPrice'] as never, promoPrice: b['promoPrice'] as never, unitCost: b['unitCost'] as never,
      baselineUnits: b['baselineUnits'] as number, expectedUnits: b['expectedUnits'] as number,
      ...(b['vendorFundingPerUnit'] === undefined ? {} : { vendorFundingPerUnit: b['vendorFundingPerUnit'] as never }),
    });
    const opened = typeof b['approvalId'] === 'string'
      ? await judged(ho, b['approvalId'], 'promotion_launch', promotionId, actionDetails(body, { promotionId }), null) : undefined;
    let approvedBy: string | null = null;
    try {
      approvedBy = approveForLaunch(simulation, opened === undefined ? undefined
        : { subjectRef: promotionId, status: 'approved', decidedBy: opened.decision.decidedBy, rationale: opened.decision.reason }, CALLER).approvedBy ?? null;
    } catch (e) {
      if (e instanceof PromotionApprovalRequiredError) {
        throw apiError(422, { code: 'launch_needs_approval', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was launched.' });
      }
      throw e;
    }
    opened?.spend();
    return { status: 201, body: { promotionId, launched: true, verdict: simulation.verdict, approvedBy } };
  }
  return undefined;
}

export async function startPricingHeadOffice(ho: PricingHeadOffice): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const method = req.method ?? 'GET';
      const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (path.startsWith('/v1/')) {
        let body: unknown;
        if (method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const raw = Buffer.concat(chunks).toString('utf8');
          body = raw === '' ? undefined : JSON.parse(raw);
        }
        ho.requests.push({ method, path, body, headers: req.headers });
        try {
          const answer = await route(ho, method, path, body);
          if (answer === undefined) { send(404, { error: { code: 'not_found', whatHappened: `No route ${method} ${path}.` } }); return; }
          send(answer.status, answer.body);
        } catch (e) {
          if (e instanceof ApiError) { send(e.status, { error: e.body }); return; }
          send(500, { error: { code: 'internal', whatHappened: String(e) } });
        }
        return;
      }
      const file = path === '/' || path === '/catalogue' ? 'catalogue.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        let out = buf.toString('utf8');
        if (file.endsWith('.html')) {
          out = out.replace('<!--SCREEN-DATA-->', `<script>window.catalogueData = ${JSON.stringify(ho.catalogueData).replace(/</g, '\\u003c')};</script>`);
        }
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(out);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}
