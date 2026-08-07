// Route registration — API-01…API-13 conventions (§30), SEC-03, hard rule #4, OB-01.
//
// **Every rule here is enforced when the route is registered, not when it is called.** A service
// that would serve an unversioned path, or a write with no idempotency, or an endpoint with no
// permission, fails to start — it does not fail on the one request in a thousand that exercises
// the gap, at nine on a Friday, on a lane with a queue.
//
// That choice is the whole point of the file. Request-time validation of a cross-cutting rule
// tests the requests that happen to arrive; registration-time validation tests the surface. The
// difference shows up exactly on the endpoint nobody wrote a test for.

import type { Permission } from '../../../packages/rbac/src/rbac';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Methods that change something, and therefore must be safe to repeat (§31.1). */
export const WRITE_METHODS: readonly Method[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

export const isWrite = (method: Method): boolean => WRITE_METHODS.includes(method);

export type ApiId =
  | 'API-01' | 'API-02' | 'API-03' | 'API-04' | 'API-05' | 'API-06' | 'API-07'
  | 'API-08' | 'API-09' | 'API-10' | 'API-11' | 'API-12' | 'API-13';

export interface RequestContext {
  /** The top isolation boundary (OB-01). Every read and write is inside exactly one of these. */
  readonly tenantId: string;
  readonly userId: string;
  /** The branch the action targets; null for a company-wide action. */
  readonly branchId: string | null;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
  /** Present on writes; the kernel has already checked it. */
  readonly idempotencyKey?: string;
  readonly traceId: string;
}

export interface HandlerResult {
  readonly status: number;
  readonly body: unknown;
}

export type Handler = (ctx: RequestContext) => Promise<HandlerResult> | HandlerResult;

export interface Route {
  readonly api: ApiId;
  readonly method: Method;
  /** Must carry a major version (P-06): `/v1/sales`, `/v1/products/:id`. */
  readonly path: string;
  /**
   * The permission this endpoint requires. **No default and no "public" shortcut** — an endpoint
   * whose author did not decide who may call it has not been designed, and default-deny at the
   * routing layer is the same rule `packages/rbac` applies to everything beneath it.
   */
  readonly permission: Permission;
  /**
   * Writes only: the caller must send `Idempotency-Key` and a replay returns the first result.
   *
   * Declared rather than assumed, because the edge→cloud path makes this mandatory: a till that
   * loses the reply resends, and a sale applied twice is money.
   */
  readonly idempotent?: boolean;
  readonly handler: Handler;
}

export type RouteRefusal =
  | 'path_carries_no_version'
  | 'write_without_idempotency'
  | 'read_declaring_idempotency'
  | 'route_without_permission'
  | 'two_routes_for_one_address';

export interface RegisterResult {
  readonly ok: boolean;
  readonly refusedBecause?: RouteRefusal;
  readonly detail: string;
}

const VERSIONED = /^\/v[1-9]\d*\//;

/** `/v1/products/:id` → a matcher and the parameter names it captures. */
function compile(path: string): { readonly re: RegExp; readonly names: readonly string[] } {
  const names: string[] = [];
  const source = path.split('/').map((segment) => {
    if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    names.push(segment.slice(1));
    return '([^/]+)';
  }).join('/');
  return { re: new RegExp(`^${source}$`), names };
}

interface Compiled extends Route {
  readonly re: RegExp;
  readonly names: readonly string[];
}

export interface Matched {
  readonly route: Route;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * The routing table for one service.
 *
 * Construction is where the conventions are enforced. `add` returns a refusal rather than throwing
 * so a service can report **every** malformed route at once — a startup that surfaces one problem
 * per attempt produces four restarts, and by the third the message is being argued with.
 */
export class Router {
  private readonly routes: Compiled[] = [];

  add(route: Route): RegisterResult {
    if (!VERSIONED.test(route.path)) {
      return {
        ok: false, refusedBecause: 'path_carries_no_version',
        detail: `${route.method} ${route.path} carries no major version. A path without one cannot be changed without breaking whatever is already calling it, and the till in the shop is a client we cannot redeploy in step (P-06)`,
      };
    }
    if (route.permission.trim() === '') {
      return {
        ok: false, refusedBecause: 'route_without_permission',
        detail: `${route.method} ${route.path} declares no permission. An endpoint whose author did not decide who may call it has not been designed — and default-deny has to hold at the routing layer too, or the first unguarded route is the one somebody finds (SEC-03)`,
      };
    }
    if (isWrite(route.method) && route.idempotent !== true) {
      return {
        ok: false, refusedBecause: 'write_without_idempotency',
        detail: `${route.method} ${route.path} changes something and does not declare idempotency. The till resends what it could not confirm, so a write that is not safe to repeat is a sale banked twice (§31.1)`,
      };
    }
    if (!isWrite(route.method) && route.idempotent === true) {
      return {
        ok: false, refusedBecause: 'read_declaring_idempotency',
        detail: `${route.method} ${route.path} is a read declaring idempotency. Harmless in itself, and it means the author believed a guarantee that is not being applied here — which is worse than not having it`,
      };
    }
    if (this.routes.some((r) => r.method === route.method && r.path === route.path)) {
      return {
        ok: false, refusedBecause: 'two_routes_for_one_address',
        detail: `${route.method} ${route.path} is registered twice. Whichever wins, the other is dead code that somebody believes is live`,
      };
    }

    const { re, names } = compile(route.path);
    this.routes.push({ ...route, re, names });
    return { ok: true, detail: `${route.api} ${route.method} ${route.path} → ${route.permission}` };
  }

  /** Register many, collecting every refusal rather than stopping at the first. */
  addAll(routes: readonly Route[]): readonly RegisterResult[] {
    return routes.map((r) => this.add(r));
  }

  match(method: Method, path: string): Matched | undefined {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.re.exec(path);
      if (m === null) continue;
      const params: Record<string, string> = {};
      route.names.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1] ?? ''); });
      return { route, params };
    }
    return undefined;
  }

  /** Every registered route, for the surface tests and for documentation. */
  list(): readonly Route[] {
    return this.routes.map((r) => ({
      api: r.api, method: r.method, path: r.path, permission: r.permission,
      ...(r.idempotent === undefined ? {} : { idempotent: r.idempotent }),
      handler: r.handler,
    }));
  }
}

/**
 * Register routes, or refuse to start.
 *
 * The intended entry point for a service: it either returns a router or names everything wrong
 * with the surface, and a service that cannot describe its own endpoints legally does not run.
 */
export function buildRouter(routes: readonly Route[]): {
  readonly ok: boolean;
  readonly router?: Router;
  readonly refusals: readonly RegisterResult[];
} {
  const router = new Router();
  const results = router.addAll(routes);
  const refusals = results.filter((r) => !r.ok);
  return refusals.length === 0
    ? { ok: true, router, refusals: [] }
    : { ok: false, refusals };
}
