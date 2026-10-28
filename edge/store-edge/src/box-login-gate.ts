// THE STORE COMPUTER STOPS CALLING HEAD OFFICE WHEN HEAD OFFICE REFUSES ITS OWN LOGIN — OB-429 (owner, 28 Oct 2026, option B) ·
// FND-03 / SEC-04 · P-01 · P-08 · hard rule #1.
//
// Head office locks a source address after five failed sign-ins (`BackoffAuthThrottle`, keyed on the address). The store
// computer's own background calls (sync, feeds, reports — about fifteen a pass) and the head-office sessions it carries for
// people on the store PC leave the shop from the SAME address. So a store computer whose own login (`CLOUD_API_TOKEN`)
// had expired or been revoked used to lock its own shop out: every person signing in to head office on the store PC was
// told "too many sign-in attempts", which hid the real cause.
//
// Now the FIRST time head office answers one of the box's own calls with `401 unauthenticated`, this gate closes. From then
// on no call made with the box's login leaves the box: each fails at once as a lost link (the callers already treat that as
// "head office cannot be reached" — the sale stays queued, the screens keep what they hold), so head office counts one
// failure, never five. The screens say plainly that the store computer's login needs renewing (P-08). It stays closed until
// the box is restarted, which is how a renewed login is put on it (the new `CLOUD_API_TOKEN`, then restart).
//
// Only the box's own credential passes through here. A person's carried session uses its own fetch (head-office-link.ts)
// and is never gated by this. A 403 (a permission), a 429 (a lock or a flood limit) or a 5xx is not a refused login and
// does not close the gate. Nothing here is on the till's sale path (hard rule #1): a sale commits on the box's disk first.

/** What the box knows about head office's answer to its own login. */
export interface BoxLoginState {
  /** Head office refused this box's own login (`401 unauthenticated`); the box has stopped calling it. */
  readonly refused: boolean;
  /** When the refusal was seen (ISO-8601), or null while the login has not been refused. */
  readonly refusedAt: string | null;
}

export interface BoxLoginGate {
  /** The fetch every call made with the box's own login goes through. */
  readonly fetch: typeof globalThis.fetch;
  readonly state: () => BoxLoginState;
}

/** The error a gated call fails with — a lost link to its caller, so nothing is dead-lettered or treated as an answer. */
export class BoxLoginRefusedError extends Error {
  constructor() {
    super('this store computer\'s head-office login was refused, so it has stopped contacting head office until the login is renewed — nothing was sent');
    this.name = 'BoxLoginRefusedError';
  }
}

/** Whether a head-office answer is a refusal of the login itself (and not a permission, a lock or a fault). */
async function isRefusedLogin(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  try {
    const body = await response.clone().json() as { readonly error?: { readonly code?: unknown } };
    return body.error?.code === 'unauthenticated';
  } catch {
    return false; // a 401 head office did not word is not head office refusing the login
  }
}

export function boxLoginGate(
  fetchFn: typeof globalThis.fetch,
  opts: { readonly now?: () => string; readonly onRefused?: (at: string) => void } = {},
): BoxLoginGate {
  const now = opts.now ?? (() => new Date().toISOString());
  let refusedAt: string | null = null;
  const gated = (async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
    if (refusedAt !== null) throw new BoxLoginRefusedError();
    const response = await fetchFn(input, init);
    if (refusedAt === null && await isRefusedLogin(response)) {
      refusedAt = now();
      opts.onRefused?.(refusedAt);
    }
    return response;
  }) as typeof globalThis.fetch;
  return { fetch: gated, state: () => ({ refused: refusedAt !== null, refusedAt }) };
}
