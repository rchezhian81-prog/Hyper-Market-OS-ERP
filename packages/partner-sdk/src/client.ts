// The partner client (M36-FR-04 · M32-FR-01 · D14-FR-06 · P-06 · hard rules #4 and #7).
//
// A partner builds against the versioned API that already exists — nothing in here adds to it:
//   • THE SURFACE IS THE PUBLISHED MANIFEST. `GET /v1/platform/api-manifest` lists every endpoint with its permission and
//     whether it is idempotent. The client reads it once and refuses, locally and by name, a call to anything not on it —
//     an unversioned or invented endpoint never leaves the partner's machine.
//   • THE IDEMPOTENCY KEY BELONGS TO THE DECISION. A write is an `Intent`, made once when the partner's system decides
//     to act; every retry of it carries the SAME key, so a timeout and a resend can never become two effects.
//   • THE CLIENT NEVER MINTS A TOKEN. It is handed a function that returns the access token the partner's credential was
//     issued (out of band, by SRE's administrator — sandbox credentials reach only the sandbox, hard rule #7). The client
//     sends it and nothing else; it holds no signing key and calls no token endpoint.
//   • THE SHOP'S WORDS REACH THE PARTNER. A refusal comes back as the API wrote it — `code`, `whatHappened`,
//     `wasItSaved` (saved / not_saved / unknown) and `nextSafeAction` — never flattened to "request failed".
//
// Standalone: no import outside this package, no dependency beyond the platform's `fetch`.

export const SDK_VERSION = '1.0.0';
/** The API major this SDK speaks. Every path it sends starts with it. */
export const API_VERSION = 'v1';

export type SavedState = 'saved' | 'not_saved' | 'unknown';
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A refusal from the API, or from the client itself before anything was sent (`wasItSaved: not_saved`). */
export class PartnerApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly whatHappened: string,
    public readonly wasItSaved: SavedState,
    public readonly nextSafeAction: string,
  ) {
    super(`${code}: ${whatHappened}`);
    this.name = 'PartnerApiError';
  }
}

/** One endpoint as the manifest publishes it. */
export interface ManifestRoute {
  readonly method: Method;
  readonly path: string;
  readonly permission: string;
  readonly entitlement: string | null;
  readonly write: boolean;
  readonly idempotent: boolean;
}

export interface Manifest {
  readonly apis: readonly { readonly api: string; readonly name: string; readonly routes: readonly ManifestRoute[] }[];
}

/** One thing the partner's system decided to do. Its key is minted here, once — never per attempt. */
export interface Intent {
  readonly method: Exclude<Method, 'GET'>;
  readonly path: string;
  readonly body: unknown;
  readonly idempotencyKey: string;
}

export interface PartnerClientOptions {
  /** Where the API is, e.g. https://api.example.test (no trailing slash needed). */
  readonly baseUrl: string;
  /** The access token the partner's credential was issued. The SDK never makes one. */
  readonly accessToken: () => string | Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
  /** How many times one intent is sent when the line drops or the server says 5xx/429. Default 3. */
  readonly maxAttempts?: number;
  /** Key source for intents (the platform's random UUID by default). */
  readonly newKey?: () => string;
}

const randomKey = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID === undefined) throw new Error('no random source for an idempotency key — pass newKey');
  return `partner-${c.randomUUID()}`;
};

/** Does a concrete path match a manifest template (`/v1/products/:productId`)? */
export function matchesTemplate(template: string, path: string): boolean {
  const t = template.split('/');
  const p = path.split('?')[0]!.split('/');
  return t.length === p.length && t.every((seg, i) => (seg.startsWith(':') ? p[i] !== '' : seg === p[i]));
}

export interface PartnerClient {
  /** The published surface (read once, then reused). */
  manifest(): Promise<Manifest>;
  /** Make an intent for a write. Keep it (e.g. in your outbox) and send it as often as needed. */
  intend(method: Intent['method'], path: string, body: unknown): Intent;
  /** A read. */
  get<T = unknown>(path: string, query?: Readonly<Record<string, string>>): Promise<T>;
  /** Send a write intent: same key on every attempt; answers the API's body. */
  send<T = unknown>(intent: Intent): Promise<T>;
  /** What head office sent a webhook subscription from a time — to compare with what you received. */
  reconcile<T = unknown>(subscriptionId: string, from: string): Promise<T>;
}

export function createPartnerClient(options: PartnerClientOptions): PartnerClient {
  const http = options.fetch ?? ((...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a));
  const base = options.baseUrl.replace(/\/+$/, '');
  const attempts = Math.max(1, options.maxAttempts ?? 3);
  const newKey = options.newKey ?? randomKey;
  let manifest: Promise<Manifest> | undefined;

  const refuseLocally = (code: string, whatHappened: string, nextSafeAction: string): PartnerApiError =>
    new PartnerApiError(0, code, whatHappened, 'not_saved', nextSafeAction);

  const raw = async (method: Method, path: string, body: unknown, key: string | undefined): Promise<{ status: number; json: unknown }> => {
    const token = await options.accessToken();
    if (typeof token !== 'string' || token.trim() === '') throw refuseLocally('no_access_token', 'The partner credential gave no access token.', 'Get the token your credential was issued; the SDK never makes one.');
    const res = await http(`${base}${path}`, {
      method,
      headers: {
        accept: 'application/json', authorization: `Bearer ${token}`, 'x-sre-sdk-version': SDK_VERSION,
        ...(method === 'GET' ? {} : { 'content-type': 'application/json' }), ...(key === undefined ? {} : { 'idempotency-key': key }),
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  const fail = (status: number, json: unknown): PartnerApiError => {
    const e = ((json as { error?: Record<string, unknown> } | null)?.error ?? {}) as Record<string, unknown>;
    const saved = e['wasItSaved'];
    return new PartnerApiError(status, typeof e['code'] === 'string' ? e['code'] : String(status), typeof e['whatHappened'] === 'string' ? e['whatHappened'] : `status ${status}`,
      saved === 'saved' || saved === 'not_saved' || saved === 'unknown' ? saved : 'unknown', typeof e['nextSafeAction'] === 'string' ? e['nextSafeAction'] : 'Read the status and try again later.');
  };

  const routeFor = async (method: Method, path: string): Promise<ManifestRoute> => {
    if (!path.startsWith(`/${API_VERSION}/`)) throw refuseLocally('unversioned_call', `"${path}" does not name the API version (/${API_VERSION}/…).`, 'Every call names its version; nothing was sent.');
    const m = await client.manifest();
    const route = m.apis.flatMap((a) => a.routes).find((r) => r.method === method && matchesTemplate(r.path, path));
    if (route === undefined) throw refuseLocally('not_in_the_published_surface', `${method} ${path} is not in the published API manifest.`, 'Use an endpoint the manifest lists; nothing was sent.');
    return route;
  };

  const client: PartnerClient = {
    manifest: () => {
      manifest ??= (async () => {
        const r = await raw('GET', `/${API_VERSION}/platform/api-manifest`, undefined, undefined);
        if (r.status !== 200) { manifest = undefined; throw fail(r.status, r.json); }
        return r.json as Manifest;
      })();
      return manifest;
    },
    intend: (method, path, body) => ({ method, path, body, idempotencyKey: newKey() }),
    get: async <T>(path: string, query?: Readonly<Record<string, string>>): Promise<T> => {
      await routeFor('GET', path);
      const qs = query === undefined || Object.keys(query).length === 0 ? '' : `?${new URLSearchParams(query).toString()}`;
      const r = await raw('GET', `${path}${qs}`, undefined, undefined);
      if (r.status >= 300) throw fail(r.status, r.json);
      return r.json as T;
    },
    send: async <T>(intent: Intent): Promise<T> => {
      const route = await routeFor(intent.method, intent.path);
      if (!route.idempotent) throw refuseLocally('write_not_idempotent', `${intent.method} ${intent.path} is not idempotent, so a retry could do it twice.`, 'Use an idempotent endpoint for anything you may resend; nothing was sent.');
      let last: unknown;
      for (let i = 0; i < attempts; i += 1) {
        try {
          const r = await raw(intent.method, intent.path, intent.body, intent.idempotencyKey);
          if (r.status < 300) return r.json as T;
          if (r.status !== 429 && r.status < 500) throw fail(r.status, r.json);
          last = fail(r.status, r.json);
        } catch (e) {
          if (e instanceof PartnerApiError && e.status !== 0 && e.status !== 429 && e.status < 500) throw e;
          if (e instanceof PartnerApiError && e.status === 0) throw e;
          last = e;
        }
      }
      // Still not known: the SAME intent can be sent again later — its key makes it one effect.
      throw last instanceof PartnerApiError
        ? new PartnerApiError(last.status, last.code, last.whatHappened, 'unknown', 'Send the same intent again later; its key makes it one effect.')
        : new PartnerApiError(0, 'no_answer', 'The API did not answer.', 'unknown', 'Send the same intent again later; its key makes it one effect.');
    },
    reconcile: <T>(subscriptionId: string, from: string) =>
      client.get<T>(`/${API_VERSION}/integration/outbound-webhooks/${encodeURIComponent(subscriptionId)}/reconciliation`, { from }),
  };
  return client;
}
