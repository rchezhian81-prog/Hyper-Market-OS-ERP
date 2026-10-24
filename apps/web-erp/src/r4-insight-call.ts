// R4 Lane 3 — the one way the insight pages (Customers, Bought together, Store events, Morning brief) ask head office:
// same-origin, JSON, a fresh idempotency key on every write, and every answer folded into one Outcome the page shows.
// No retries, no timers, nothing written on open.

export type Outcome<T, K extends string = string> =
  | { readonly result: 'ok'; readonly value: T }
  | { readonly result: 'refused'; readonly status: number; readonly code: string; readonly whatHappened: string }
  | { readonly result: 'invalid'; readonly why: K }
  | { readonly result: 'lost_link' };

export type Caller = <T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) => Promise<Outcome<T, never>>;

const rand = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

export function makeCaller(input: { readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly keyPrefix: string }): Caller {
  const http = input.fetch ?? ((...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a));
  const newKey = input.newKey ?? (() => `${input.keyPrefix}-${rand()}`);
  return async <T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<Outcome<T, never>> => {
    try {
      const res = await http(path, {
        method, credentials: 'same-origin',
        headers: { accept: 'application/json', ...(method !== 'GET' ? { 'content-type': 'application/json', 'idempotency-key': newKey() } : {}) },
        ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const err = (json['error'] ?? {}) as { code?: string; whatHappened?: string };
        return { result: 'refused', status: res.status, code: err.code ?? String(res.status), whatHappened: err.whatHappened ?? `status ${res.status}` };
      }
      return { result: 'ok', value: json as T };
    } catch { return { result: 'lost_link' }; }
  };
}

export const newId = (prefix: string): string => `${prefix}-${rand().replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`;

/** The words for an outcome that is not ok, from the page's own word table. */
export function outcomeIn(words: (key: string) => string, out: Outcome<unknown>): string {
  if (out.result === 'refused') return `${words('refused')} ${out.whatHappened}`;
  if (out.result === 'invalid') return words(out.why);
  if (out.result === 'lost_link') return words('unreachable');
  return '';
}
