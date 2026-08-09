// The inbound pack pull — SYNC-01 (audit GAP-SYNC-01), §31, P-01, P-02, P-08, hard rule #4.
//
// The outbox drain (`transport.ts` / `http-transport.ts`) carries the shop's sales UP to the cloud.
// Nothing carried anything DOWN: the store box read its catalogue pack from a file once at boot and
// never again, so a price change, a new promotion or — the one that matters — a RECALL reached the
// lanes only as fast as somebody carried a file to the box. "One commerce truth" (P-02) was only as
// fresh as a manual copy.
//
// This is the inbound MIRROR of `SyncTransport`: a port that fetches the tenant's current signed
// catalogue pack from the cloud, plus the thin HTTP adapter that reaches the real endpoint
// (`GET /v1/catalogue/pack`). It does NOT decide whether to trust the pack — that is
// `acceptPack`'s job (signature, tenant, version-not-backward), reached through `pullPack`. This
// layer only answers "did the cloud give us a pack, say it has none, or could we not reach it?".
//
// Two rules it shares with the outbound transport:
//   • **Never put the token in a message.** A reason string reaches logs and support threads (#4).
//   • **Unreachable is not rejected.** A timeout, a 5xx, an expired token — the box keeps trading on
//     the pack it already trusts and tries again next pass (P-01). Only a clean 200 is a new pack.

import type { SignedPack } from '../../../services/catalogue/src/pack';

/** The result of trying to fetch the current signed pack from the cloud. */
export type PackFetch =
  /** The cloud returned a pack. Whether the lane TRUSTS it is decided later by `acceptPack`. */
  | { readonly status: 'fetched'; readonly pack: SignedPack }
  /** The cloud was reachable but has no published catalogue for this tenant yet (404). */
  | { readonly status: 'none_published' }
  /** Offline, timed out, a 5xx, an expired token — keep the last good pack, try again next pass. */
  | { readonly status: 'unreachable'; readonly reason: string };

/**
 * Fetches the tenant's current signed catalogue pack. The inbound mirror of `SyncTransport.send`.
 * Kept a port so the puller stays testable with no network, exactly as the outbound side is.
 */
export interface PackSource {
  fetch(): Promise<PackFetch>;
}

export interface HttpPackSourceOptions {
  /** The cloud API's base URL, e.g. `https://api.example.test`. */
  readonly baseUrl: string;
  /** Bearer token for this store. Read from configuration; never logged (hard rule #4). */
  readonly token: string;
  /** How long to wait before giving up on one fetch. A hung socket must not stall the poll. */
  readonly timeoutMs?: number;
  /** Injected so the source stays testable without a network. */
  readonly fetch: typeof globalThis.fetch;
}

/** A body that at least has the two fields `acceptPack` needs, so a garbled response is not trusted. */
function looksLikeAPack(body: unknown): body is SignedPack {
  return typeof body === 'object' && body !== null
    && typeof (body as { signature?: unknown }).signature === 'string'
    && typeof (body as { snapshot?: unknown }).snapshot === 'object'
    && (body as { snapshot?: unknown }).snapshot !== null;
}

/** Reach the real endpoint. `GET /v1/catalogue/pack` returns the tenant's current `SignedPack`. */
export function httpPackSource(options: HttpPackSourceOptions): PackSource {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = options.baseUrl.replace(/\/+$/, '');

  return {
    fetch: async (): Promise<PackFetch> => {
      // Bounded and cancelled rather than left hanging, like the outbound send: an abandoned request
      // holding a socket is how one slow endpoint stalls the poll loop.
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, timeoutMs);

      try {
        const response = await options.fetch(`${base}/v1/catalogue/pack`, {
          method: 'GET',
          headers: { authorization: `Bearer ${options.token}` },
          signal: controller.signal,
        });

        // No pack published yet is a real, distinct answer — not an error, and not a bad pack.
        if (response.status === 404) return { status: 'none_published' };

        // Anything but a clean 200 (a 5xx, a 401 expired token, a 429) is treated as unreachable:
        // keep the last good pack and try again. The status, never the body — a body can echo the
        // request, and the request carries the token we must never write down (#4).
        if (response.status < 200 || response.status >= 300) {
          return { status: 'unreachable', reason: `the cloud answered ${response.status} for the catalogue pack` };
        }

        const body = await response.json() as unknown;
        // A response that does not even carry a snapshot and a signature is not a pack we can check.
        // Treated as unreachable (keep last good), never as a pack to hand to `acceptPack`, which
        // would throw canonicalising a shape that is not a catalogue.
        if (!looksLikeAPack(body)) {
          return { status: 'unreachable', reason: 'the cloud returned something that is not a signed pack' };
        }
        return { status: 'fetched', pack: body };
      } catch (e) {
        // Timeout, DNS failure, refused connection, TLS problem, a body that would not parse — all
        // the link (or a broken cloud), not a verdict on the pack. Keep trading, try again (P-01).
        const aborted = e instanceof Error && e.name === 'AbortError';
        return {
          status: 'unreachable',
          reason: aborted
            ? `no answer within ${timeoutMs}ms — still on the catalogue the lane holds`
            : 'could not reach the cloud — still on the catalogue the lane holds',
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
