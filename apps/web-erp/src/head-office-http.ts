// The one way a round-12 head-office screen talks to head office (WF-07 · WF-08 screens): a GET or a POST in the signed-in
// person's own session, each POST with its own idempotency key, and an answer read defensively into one of three
// outcomes. Head office's refusal is kept in head office's own words (`error.whatHappened`) — the screen shows it as
// said, never a paraphrase of its own — and a request that never got an answer says so (nothing is known to have
// happened). DOM-free; the browser's `fetch` is handed in (tests hand in a fake).

export type HttpAnswer =
  | { readonly result: 'ok'; readonly status: number; readonly body: unknown }
  | { readonly result: 'refused'; readonly status: number; readonly code: string; readonly whatHappened: string }
  | { readonly result: 'lost_link' };

export interface HeadOfficeHttp {
  get(path: string): Promise<HttpAnswer>;
  post(path: string, body: unknown): Promise<HttpAnswer>;
}

type FetchFn = (input: string, init: { method: string; headers: Record<string, string>; credentials: 'same-origin'; body?: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

const newKey = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

async function answerOf(res: { status: number; json(): Promise<unknown> }): Promise<HttpAnswer> {
  const body = await res.json().catch(() => null);
  if (res.status >= 200 && res.status < 300) return { result: 'ok', status: res.status, body };
  const err = (body !== null && typeof body === 'object' ? (body as { error?: { code?: unknown; whatHappened?: unknown } }).error : undefined) ?? {};
  return {
    result: 'refused', status: res.status,
    code: typeof err.code === 'string' ? err.code : `http_${res.status}`,
    whatHappened: typeof err.whatHappened === 'string' ? err.whatHappened : '',
  };
}

/** Head office over `fetch` in the signed-in person's session (same origin; the front door adds their token). */
export function headOfficeHttp(fetchFn: FetchFn | undefined = (globalThis as { fetch?: FetchFn }).fetch, key: () => string = newKey): HeadOfficeHttp {
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<HttpAnswer> => {
    if (fetchFn === undefined) return { result: 'lost_link' };
    try {
      const res = await fetchFn(path, {
        method, credentials: 'same-origin',
        headers: method === 'GET' ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json', 'idempotency-key': key() },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
      });
      return await answerOf(res);
    } catch {
      return { result: 'lost_link' };
    }
  };
  return { get: (path) => call('GET', path), post: (path, body) => call('POST', path, body) };
}

/** ₹ from paise, Indian grouping — a figure for reading, never for sums. */
export const rupees = (minor: number): string =>
  `${minor < 0 ? '−' : ''}₹${(Math.abs(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
