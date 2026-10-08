// THE IDENTITY SERVER'S PUBLIC KEYS (OB-15 · ADR-0019 · M02-FR-01 · hard rule #4).
//
// Keycloak signs each sign-in with a private key it never shares, and publishes the matching PUBLIC keys at its
// `.../protocol/openid-connect/certs` address (a JSON Web Key Set). Head office fetches that set, keeps it, and checks
// every token against it. Nothing here can sign anything: a public key only verifies.
//
//   • Only RSA keys published for signing (`use: sig`, `alg: RS256` or no alg) are kept — an encryption key, or a key of
//     another type, is not a key a sign-in can be checked against.
//   • A token naming a key id this set does not hold asks for ONE refresh — the server rotates its keys — at most once
//     per `minRefreshIntervalMs`, so a stream of made-up key ids cannot turn into a stream of fetches.
//   • A set that cannot be fetched or read leaves the keys already held in place and says why; an RS256 token is
//     refused until a key it names is held. Nothing on a sale path depends on this (P-01): the till never asks it.

import { createPublicKey, type JsonWebKey, type KeyObject } from 'node:crypto';
import type { PublicKeyring } from './token';

export interface JwksKeyringOptions {
  /** The identity server's published key set address, from configuration. */
  readonly url: string;
  readonly fetch: typeof globalThis.fetch;
  /** The least time between two fetches the keyring makes on its own (default 30 s). */
  readonly minRefreshIntervalMs?: number;
  readonly now?: () => number;
  /** Told when the set could not be fetched or read — for the operator's log. Never contains a token. */
  readonly onProblem?: (detail: string) => void;
}

export interface JwksKeyring extends PublicKeyring {
  /** Fetch the set now. Resolves to how many signing keys are held afterwards. */
  refresh(): Promise<number>;
  /** Ask for a refresh because a token named a key id not held — rate-limited; resolves when any refresh settles. */
  refreshForUnknownKey(): Promise<void>;
  /** How many signing keys are held. */
  size(): number;
}

/** The signing keys a published set holds, by key id. Anything that is not an RSA signing key is left out. */
export function signingKeysOf(set: unknown): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  const list = set !== null && typeof set === 'object' && Array.isArray((set as { keys?: unknown }).keys) ? (set as { keys: unknown[] }).keys : [];
  for (const k of list) {
    if (k === null || typeof k !== 'object') continue;
    const jwk = k as Record<string, unknown>;
    if (jwk['kty'] !== 'RSA' || typeof jwk['kid'] !== 'string' || jwk['kid'] === '') continue;
    if (jwk['use'] !== undefined && jwk['use'] !== 'sig') continue;
    if (jwk['alg'] !== undefined && jwk['alg'] !== 'RS256') continue;
    if (typeof jwk['n'] !== 'string' || typeof jwk['e'] !== 'string') continue;
    // A private part in a PUBLISHED set is a misconfiguration; only the public numbers are ever used.
    try {
      keys.set(jwk['kid'], createPublicKey({ key: { kty: 'RSA', n: jwk['n'], e: jwk['e'] } as JsonWebKey, format: 'jwk' }));
    } catch { /* unreadable key — skipped */ }
  }
  return keys;
}

export function jwksKeyring(options: JwksKeyringOptions): JwksKeyring {
  const now = options.now ?? (() => Date.now());
  const minGap = options.minRefreshIntervalMs ?? 30_000;
  let keys = new Map<string, KeyObject>();
  let lastAttempt = -Infinity;
  let inFlight: Promise<number> | undefined;

  const refresh = (): Promise<number> => {
    if (inFlight !== undefined) return inFlight;
    lastAttempt = now();
    inFlight = (async () => {
      try {
        const res = await options.fetch(options.url, { headers: { accept: 'application/json' } });
        if (!res.ok) { options.onProblem?.(`the identity server's key set answered ${res.status}`); return keys.size; }
        const fresh = signingKeysOf(await res.json() as unknown);
        if (fresh.size === 0) { options.onProblem?.('the identity server published no RSA signing key'); return keys.size; }
        keys = fresh;
        return keys.size;
      } catch (e) {
        options.onProblem?.(`the identity server's key set could not be fetched: ${e instanceof Error ? e.message : String(e)}`);
        return keys.size;
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };

  return {
    get: (kid) => keys.get(kid),
    refresh,
    refreshForUnknownKey: async () => {
      if (inFlight !== undefined) { await inFlight; return; }
      if (now() - lastAttempt < minGap) return;
      await refresh();
    },
    size: () => keys.size,
  };
}
