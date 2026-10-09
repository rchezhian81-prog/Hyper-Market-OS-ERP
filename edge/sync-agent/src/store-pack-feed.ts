// The inbound store-pack pull (Wave 4 · PA-06 = DF-3-a · OB-26 "A" · §31 · P-01 · P-08 · hard rule #4).
//
// The store computer used to read its store pack from a file once, at boot. This is the inbound mirror of the catalogue
// pull (`pack-source.ts` / `pack-puller.ts`): a `StorePackSource` fetches `GET /v1/store-packs/:storeId` under the box's
// own credential, and `pullStorePack` decides — with no network — whether the box takes it, using the SAME trust check
// head office's tests use (`verifyStorePack`: signature, shop, store, newer, not expired on arrival):
//   • **Never put the token in a message** (#4).
//   • **Unreachable is not rejected** — a timeout, a 5xx, an expired token: the box keeps the pack it holds, says how old
//     it is, and tries again next pass (P-01).
//   • **Never go backwards, never take a stranger's pack** — a refused pack is said once, and the held pack stays.

import { verifyStorePack, type StorePackEnvelope } from '../../../services/platform/src/store-packs';
import type { PackSigner } from '../../../services/catalogue/src/pack';

export type StorePackFetch =
  | { readonly status: 'fetched'; readonly body: unknown }
  /** Head office has not set this store up yet (it answered, but has nothing to send). */
  | { readonly status: 'not_set_up'; readonly reason: string }
  | { readonly status: 'unreachable'; readonly reason: string };

export interface StorePackSource {
  fetch(): Promise<StorePackFetch>;
}

export function httpStorePackSource(options: {
  readonly baseUrl: string;
  /** Bearer token for this store. Read from configuration; never logged (hard rule #4). */
  readonly token: string;
  readonly storeId: string;
  readonly timeoutMs?: number;
  readonly fetch: typeof globalThis.fetch;
}): StorePackSource {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = options.baseUrl.replace(/\/+$/, '');
  return {
    fetch: async (): Promise<StorePackFetch> => {
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
      try {
        const response = await options.fetch(`${base}/v1/store-packs/${encodeURIComponent(options.storeId)}`, {
          method: 'GET', headers: { authorization: `Bearer ${options.token}` }, signal: controller.signal,
        });
        if (response.status === 404) return { status: 'not_set_up', reason: 'head office does not know this store yet' };
        // Anything but a clean 200 is "could not get it" — the status, never the body (#4).
        if (response.status < 200 || response.status >= 300) return { status: 'unreachable', reason: `head office answered ${response.status} for this store's setup` };
        return { status: 'fetched', body: await response.json() as unknown };
      } catch (e) {
        const aborted = e instanceof Error && e.name === 'AbortError';
        return { status: 'unreachable', reason: aborted ? `no answer within ${timeoutMs}ms` : 'could not reach head office' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface StorePackReceiver {
  readonly tenantId: string;
  readonly storeId: string;
  /** The pack this box trades on now, or undefined if it has never taken one from head office. */
  held(): StorePackEnvelope | undefined;
  /** Take a verified, newer pack as this store's setup from now on. */
  take(pack: StorePackEnvelope, receivedAt: string): Promise<void>;
}

export type StorePackPullStatus = 'updated' | 'unchanged' | 'refused' | 'not_set_up' | 'offline';
export interface StorePackPullOutcome {
  readonly status: StorePackPullStatus;
  readonly heldVersion: number | null;
  readonly heldIssuedAt: string | null;
  /** True when the pack the box holds is past its expiry: it keeps trading on it (P-01) and says so (P-08). */
  readonly expired: boolean;
  readonly staffMessage: string;
}

const ageWords = (issuedAt: string, now: string): string => {
  const hours = Math.max(0, Math.round((Date.parse(now) - Date.parse(issuedAt)) / 3_600_000));
  return hours < 1 ? 'less than an hour old' : hours < 48 ? `${hours} hour(s) old` : `${Math.round(hours / 24)} day(s) old`;
};

export async function pullStorePack(input: { readonly source: StorePackSource; readonly receiver: StorePackReceiver; readonly signer: PackSigner; readonly now: string }): Promise<StorePackPullOutcome> {
  const fetched = await input.source.fetch();
  const describe = (status: StorePackPullStatus, lead: string): StorePackPullOutcome => {
    const held = input.receiver.held();
    const expired = held !== undefined && Date.parse(held.expiresAt) <= Date.parse(input.now);
    const holding = held === undefined
      ? 'This computer has no setup from head office yet.'
      : `This computer is on store setup ${held.version}, ${ageWords(held.issuedAt, input.now)}${expired ? ' — OUT OF DATE: the till keeps trading on it, but head office should be reached' : ''}.`;
    return { status, heldVersion: held?.version ?? null, heldIssuedAt: held?.issuedAt ?? null, expired, staffMessage: `${lead} ${holding}` };
  };
  if (fetched.status === 'unreachable') return describe('offline', `Head office could not be reached (${fetched.reason}).`);
  if (fetched.status === 'not_set_up') return describe('not_set_up', `Head office has no setup for store ${input.receiver.storeId} yet (${fetched.reason}).`);
  const held = input.receiver.held();
  const body = fetched.body as Partial<StorePackEnvelope> | null;
  // The same content re-issued (a newer version, the same fingerprint) is not news — keep the held one, quietly.
  if (held !== undefined && body !== null && typeof body === 'object' && body.contentHash === held.contentHash && body.storeId === held.storeId) {
    return describe('unchanged', 'Head office\'s store setup has not changed.');
  }
  const verdict = verifyStorePack(input.signer, fetched.body, { tenantId: input.receiver.tenantId, storeId: input.receiver.storeId, heldVersion: held?.version ?? null, now: input.now });
  if (!verdict.accepted) return describe('refused', `${verdict.staffMessage[0]!.toUpperCase()}${verdict.staffMessage.slice(1)}.`);
  await input.receiver.take(fetched.body as StorePackEnvelope, input.now);
  return describe('updated', 'A new store setup from head office is in use.');
}
