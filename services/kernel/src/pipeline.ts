// The request pipeline every API-01…API-13 endpoint runs inside — §30, §31.1, SEC-02/03/12,
// hard rules #3 and #4, OB-01.
//
// Cross-cutting rules belong in one place that no handler can skip. Written per-service they are
// written thirteen times, correctly twelve times, and the exception is not the one anybody audits.
//
// Two of the guards here run on the way **out**, which is unusual and deliberate:
//
//   • **A response carrying another tenant's id is not sent.** Tenant isolation is normally
//     enforced by every query being scoped, which works until one query is not. This is the
//     backstop that does not depend on all of them being right — a leak becomes a failed request
//     rather than a customer seeing another shop's data (OB-01, SEC-02).
//
//   • **A response carrying something card-shaped is not sent.** Hard rule #3 says never store a
//     card number. The response is where "never stored" gets tested against reality, because a
//     PAN that reached the database arrives here on the way to somebody's screen.
//
// Both refuse rather than redact. Redacting sends a successful reply for a request that did
// something wrong, and the wrongness is then invisible to everyone.

import { AccessControl } from '../../../packages/rbac/src/rbac';
import {
  ApiError, apiError, forbidden, idempotencyKeyMissing, idempotencyKeyReused,
  notFound, unauthenticated,
} from './errors';
import { isWrite, type Method, type Router } from './router';

export interface Principal {
  readonly tenantId: string;
  readonly userId: string;
  readonly branchId: string | null;
}

export interface HttpRequest {
  readonly method: Method;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

/** Resolves a bearer token to a principal, or `undefined`. Identity (API-01) supplies the real one. */
export type Authenticator = (token: string) => Promise<Principal | undefined> | Principal | undefined;

export interface StoredResult {
  /** Hash of the request this key was first used for. A different body under the same key is a bug. */
  readonly requestHash: string;
  readonly status: number;
  readonly body: unknown;
}

/**
 * Idempotency storage. **Keys are scoped by tenant** — a global key space lets one tenant's key
 * collide with another's, which is both a leak and a wrong answer.
 */
export interface IdempotencyStore {
  get(tenantId: string, key: string): Promise<StoredResult | undefined> | StoredResult | undefined;
  put(tenantId: string, key: string, record: StoredResult): Promise<void> | void;
}

export interface AuditSink {
  record(entry: {
    readonly tenantId: string; readonly userId: string; readonly method: Method;
    readonly path: string; readonly status: number; readonly traceId: string;
    readonly permission: string; readonly idempotencyKey?: string;
  }): Promise<void> | void;
}

/** Stable across key order, so `{a,b}` and `{b,a}` are one request and not two. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** FNV-1a. Not a security hash — it detects a changed body, and collisions here are not adversarial. */
export function hashRequest(method: Method, path: string, body: unknown): string {
  const text = `${method} ${path} ${stableStringify(body)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ── The two outbound guards ──────────────────────────────────────────────────

const DIGITS_ONLY = /^\d+$/;

/**
 * Lengths a modern card PAN actually has: 15 (Amex), 16 (most), 19 (some RuPay/Maestro).
 *
 * **13 and 14 are excluded deliberately, and this is the important line in the file.** A retail
 * response is full of 13-digit EAN-13 barcodes and 14-digit ITF-14 carton codes — and EAN-13's
 * check digit is computed the same alternating way Luhn is, so **about one barcode in ten passes
 * Luhn by chance.** The first version of this guard did length 13–19 plus Luhn, and the first
 * service built on it, the catalogue, produced a pack whose barcodes tripped it. The single most
 * important response in the system would have been blocked.
 *
 * What this costs: a 13-digit legacy Visa would not be caught. Those were phased out decades ago,
 * this is a backstop rather than the control (hard rule #3 is that one is never stored in the
 * first place), and a guard that fires on ordinary barcodes is a guard somebody switches off —
 * which catches nothing at all.
 */
const CARD_LENGTHS = new Set([15, 16, 19]);

/** Issuer prefixes in actual use. A number is not a card because it is long and passes Luhn. */
const ISSUER = /^(4|5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720)|3[47]|3(0[0-5]|[689])|6(011|5|0|[45])|8[12])/;

/**
 * Three signals together, because any one of them alone fires on ordinary retail traffic.
 *
 * Scanning **every string in every response** is only tolerable if it is quiet on real data. A
 * guard that cries wolf on barcodes, UTRs and ARNs gets disabled, and a disabled guard is worse
 * than none because everyone believes it is running.
 */
export function looksLikeACardNumber(value: string): boolean {
  const digits = value.replace(/[\s-]/g, '');
  if (!DIGITS_ONLY.test(digits)) return false;
  if (!CARD_LENGTHS.has(digits.length)) return false;
  if (!ISSUER.test(digits)) return false;

  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const TENANT_KEYS = new Set(['tenantId', 'tenant_id', 'tenantid']);

export interface OutboundFinding {
  readonly kind: 'card_data' | 'another_tenant';
  readonly at: string;
  readonly detail: string;
}

/** Walk a response body for the two things that must never leave the process. */
export function scanOutbound(body: unknown, tenantId: string): readonly OutboundFinding[] {
  const found: OutboundFinding[] = [];
  const walk = (node: unknown, at: string): void => {
    if (typeof node === 'string') {
      if (looksLikeACardNumber(node)) {
        found.push({
          kind: 'card_data', at,
          detail: `${at} holds something structurally a card number. Hard rule #3 says one is never stored, so this reply is refused rather than sent — and the fact it got this far is the finding`,
        });
      }
      return;
    }
    if (Array.isArray(node)) { node.forEach((v, i) => { walk(v, `${at}[${i}]`); }); return; }
    if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (TENANT_KEYS.has(key) && typeof value === 'string' && value !== tenantId) {
          found.push({
            kind: 'another_tenant', at: `${at}.${key}`,
            detail: `${at}.${key} is ${value} and this request belongs to ${tenantId}. Every query is meant to be scoped; this is the backstop for the one that was not (OB-01)`,
          });
        }
        walk(value, `${at}.${key}`);
      }
    }
  };
  walk(body, '$');
  return found;
}

// ── The pipeline ─────────────────────────────────────────────────────────────

/**
 * Authorization for a request. Either a single ready `AccessControl` (tests and simple
 * compositions), or — the production shape — a per-tenant resolver that builds one from that
 * tenant's OWN role grants, so authority is scoped to the tenant and read from the authoritative
 * event source rather than a global table. Async because the grants live in the store. Default-deny
 * is preserved either way: a tenant with no grants yields an `AccessControl` that authorises nothing.
 */
export type AccessResolver = (tenantId: string) => AccessControl | Promise<AccessControl>;

export interface KernelOptions {
  readonly router: Router;
  readonly authenticate: Authenticator;
  readonly access: AccessControl | AccessResolver;
  readonly idempotency: IdempotencyStore;
  readonly audit?: AuditSink;
  /** Injected so a reply is reproducible in a test and traceable in production. */
  readonly newTraceId: () => string;
}

/** In-memory idempotency, tenant-scoped. Real deployments swap the port for PostgreSQL. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly byTenant = new Map<string, Map<string, StoredResult>>();
  get(tenantId: string, key: string): StoredResult | undefined {
    return this.byTenant.get(tenantId)?.get(key);
  }
  put(tenantId: string, key: string, record: StoredResult): void {
    const m = this.byTenant.get(tenantId) ?? new Map<string, StoredResult>();
    m.set(key, record);
    this.byTenant.set(tenantId, m);
  }
}

const asResponse = (e: ApiError, traceId: string): HttpResponse => ({
  status: e.status,
  body: { error: { ...e.body, traceId } },
  headers: { 'content-type': 'application/json' },
});

/**
 * Handle one request, all the way through.
 *
 * Order matters and is not arbitrary: authenticate, authorise, *then* look at the body. A caller
 * who may not use an endpoint must not be able to learn anything from how it responds to a
 * malformed payload.
 */
export async function handle(opts: KernelOptions, request: HttpRequest): Promise<HttpResponse> {
  const traceId = opts.newTraceId();

  // Captured as the request proceeds so the audit can be written on the way OUT, whichever way it
  // goes. Auditing only the successes was the first version of this function, and it left no
  // record of a refusal — which is the event most worth having: somebody reaching for a
  // permission they do not hold looks exactly like nothing at all (SEC-07, NFR-15).
  let auditPermission = '';
  let auditPrincipal: Principal | undefined;
  let auditKey: string | undefined;
  let auditedMethod: Method = request.method;

  const writeAudit = async (status: number): Promise<void> => {
    if (opts.audit === undefined) return;
    // Successful reads are not audited — the volume would bury the writes. Everything else is:
    // every write, and every refusal of any kind.
    const interesting = isWrite(auditedMethod) || status >= 400;
    if (!interesting) return;
    await opts.audit.record({
      tenantId: auditPrincipal?.tenantId ?? 'unauthenticated',
      userId: auditPrincipal?.userId ?? 'unauthenticated',
      method: auditedMethod,
      path: request.path,
      status,
      traceId,
      permission: auditPermission,
      ...(auditKey === undefined ? {} : { idempotencyKey: auditKey }),
    });
  };

  try {
    const matched = opts.router.match(request.method, request.path);
    if (matched === undefined) throw notFound(`${request.method} ${request.path}`);
    const { route, params } = matched;
    auditPermission = route.permission;
    auditedMethod = route.method;

    const header = request.headers['authorization'] ?? request.headers['Authorization'] ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (token === '') throw unauthenticated();
    const principal = await opts.authenticate(token);
    if (principal === undefined) throw unauthenticated();
    auditPrincipal = principal;

    // Authorization is per-tenant: a resolver reads THIS tenant's grants; a ready AccessControl is
    // used as-is. Resolve after authentication so the tenant comes from the signed principal, never
    // from anything the caller supplied. Default-deny survives either shape.
    const access = typeof opts.access === 'function' ? await opts.access(principal.tenantId) : opts.access;
    if (!access.can({
      userId: principal.userId, permission: route.permission, branchId: principal.branchId,
    })) {
      throw forbidden(route.permission);
    }

    const write = isWrite(route.method);
    const key = request.headers['idempotency-key'] ?? request.headers['Idempotency-Key'];
    let requestHash = '';

    if (write) {
      if (key === undefined || key.trim() === '') throw idempotencyKeyMissing();
      auditKey = key;
      requestHash = hashRequest(route.method, request.path, request.body);
      const seen = await opts.idempotency.get(principal.tenantId, key);
      if (seen !== undefined) {
        // A replay of the same request returns the first answer. A DIFFERENT request under the
        // same key is refused — answering it with the stored result would report success for
        // something that never ran.
        if (seen.requestHash !== requestHash) throw idempotencyKeyReused();
        const replay = sealed(seen.status, seen.body, principal.tenantId, traceId, true);
        await writeAudit(replay.status);
        return replay;
      }
    }

    const result = await route.handler({
      tenantId: principal.tenantId,
      userId: principal.userId,
      branchId: principal.branchId,
      params,
      query: request.query ?? {},
      body: request.body,
      ...(write && key !== undefined ? { idempotencyKey: key } : {}),
      traceId,
    });

    const response = sealed(result.status, result.body, principal.tenantId, traceId, false);

    // Stored only after the outbound guards passed. Banking a reply that must not be sent would
    // make every replay return it too.
    if (write && key !== undefined && response.status < 400) {
      await opts.idempotency.put(principal.tenantId, key, {
        requestHash, status: result.status, body: result.body,
      });
    }

    await writeAudit(response.status);
    return response;
  } catch (e) {
    const failure = e instanceof ApiError ? asResponse(e, traceId) : asResponse(apiError(500, {
      code: 'unhandled',
      whatHappened: 'The request failed in a way this service did not expect.',
      // An unexpected throw is the case where "did it save?" is genuinely unknown, and saying
      // anything else here is the lie that causes the double charge.
      wasItSaved: 'unknown',
      nextSafeAction: 'Do not simply repeat it. Check whether it applied, then resend under the same Idempotency-Key if it did not.',
    }), traceId);

    // The refusal goes on the record too. An audit trail that holds only what succeeded cannot
    // answer the question it exists for: who tried.
    await writeAudit(failure.status);
    return failure;
  }
}

/** Apply the outbound guards and build the reply. */
function sealed(
  status: number, body: unknown, tenantId: string, traceId: string, replayed: boolean,
): HttpResponse {
  const findings = scanOutbound(body, tenantId);
  if (findings.length > 0) {
    const first = findings[0]!;
    return asResponse(apiError(500, {
      code: first.kind === 'card_data' ? 'card_data_in_response' : 'cross_tenant_in_response',
      whatHappened: first.detail,
      // The handler already did whatever it did; only the reply is being withheld.
      wasItSaved: 'unknown',
      nextSafeAction: 'Do not retry. This is a fault in the service, not in the request — report the trace id.',
    }), traceId);
  }
  return {
    status,
    body,
    headers: {
      'content-type': 'application/json',
      'x-trace-id': traceId,
      ...(replayed ? { 'idempotent-replay': 'true' } : {}),
    },
  };
}
