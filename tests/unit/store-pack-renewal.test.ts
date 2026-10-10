import { describe, it, expect } from 'vitest';
import { hmacSigner } from '../../services/catalogue/src/index';
import { signStorePack, STORE_PACK_LIFETIME_HOURS, type StorePackEnvelope } from '../../services/platform/src/store-packs';
import { pullStorePack, type StorePackReceiver, type StorePackSource } from '../../edge/sync-agent/src/store-pack-feed';

/**
 * **PA-06-r1 — a renewed signature on unchanged contents is taken, checked (OB-26 "A" · §31 · P-01 · P-08).**
 * Head office builds the store setup on request and signs each answer with a new version and a new expiry. The box used to
 * compare only the content fingerprint: the same contents with a newer signature were "unchanged", so it kept the OLD
 * envelope — and after seven days said its setup was out of date although head office had renewed it every pass. Now the
 * same contents are still checked in full (signature, shop, store, newer, not expired); a valid newer one replaces the
 * held envelope (its version, issue and expiry) without rebuilding anything; anything else is refused exactly as before.
 */

// signing keys are built at run time (never a literal secret)
const keyOf = (step: number): string => Array.from({ length: 40 }, (_, i) => String.fromCharCode(97 + ((i * step) % 26))).join('');
const signer = hmacSigner(keyOf(7));
const other = hmacSigner(keyOf(11));
const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECTIONS = { policies: { storeId: 'S1', branchName: 'SRE Hyper Market' } };
const at = (iso: string, sections: Record<string, unknown> = SECTIONS, by = signer, storeId = 'S1') =>
  signStorePack(by, { tenantId: T, storeId, issuedAt: iso, sections });
const DAY = 86_400_000;

function box(initial?: StorePackEnvelope) {
  let held = initial;
  const calls: string[] = [];
  const receiver: StorePackReceiver & { renew: NonNullable<StorePackReceiver['renew']> } = {
    tenantId: T, storeId: 'S1',
    held: () => held,
    take: async (p) => { calls.push(`take:${p.version}`); held = p; },
    renew: async (p) => { calls.push(`renew:${p.version}`); held = p; },
  };
  return { receiver, calls, held: () => held };
}
const serving = (body: unknown): StorePackSource => ({ fetch: async () => ({ status: 'fetched', body }) });

describe('PA-06-r1 — the same setup with a newer signature renews the held envelope', () => {
  const first = at('2026-10-01T00:00:00.000Z');

  it('a valid, newer envelope with the same contents is RENEWED: version, issue and expiry move on, the contents are not re-taken', async () => {
    const b = box(first);
    const renewed = at('2026-10-07T23:00:00.000Z');
    const now = '2026-10-08T01:00:00.000Z'; // the held one has expired by now; the renewed one has not
    expect(Date.parse(first.expiresAt)).toBeLessThan(Date.parse(now));
    const out = await pullStorePack({ source: serving(renewed), receiver: b.receiver, signer, now });
    expect(out).toMatchObject({ status: 'renewed', heldVersion: renewed.version, expired: false });
    expect(b.calls).toEqual([`renew:${renewed.version}`]);
    expect(b.held()).toMatchObject({ version: renewed.version, issuedAt: renewed.issuedAt, expiresAt: renewed.expiresAt });
    expect(Date.parse(b.held()!.expiresAt) - Date.parse(renewed.issuedAt)).toBe(STORE_PACK_LIFETIME_HOURS * 3_600_000);
  });

  it('a receiver with no separate renew step takes the renewed envelope whole', async () => {
    const b = box(first);
    const { renew: _r, ...plain } = b.receiver;
    void _r;
    const renewed = at('2026-10-02T00:00:00.000Z');
    expect((await pullStorePack({ source: serving(renewed), receiver: plain, signer, now: '2026-10-02T00:00:01.000Z' })).status).toBe('renewed');
    expect(b.calls).toEqual([`take:${renewed.version}`]);
  });

  it('the very same envelope again is unchanged — nothing taken, nothing said', async () => {
    const b = box(first);
    expect((await pullStorePack({ source: serving(first), receiver: b.receiver, signer, now: '2026-10-01T01:00:00.000Z' })).status).toBe('unchanged');
    expect(b.calls).toEqual([]);
  });

  it('the same contents but a bad signature, another store, an older version or already expired are REFUSED and the held one stays', async () => {
    const cases: [string, unknown, string][] = [
      ['forged', at('2026-10-02T00:00:00.000Z', SECTIONS, other), '2026-10-02T00:00:01.000Z'],
      ['older', at('2026-09-30T00:00:00.000Z'), '2026-10-01T00:00:01.000Z'],
      ['expired on arrival', at('2026-10-02T00:00:00.000Z'), new Date(Date.parse('2026-10-02T00:00:00.000Z') + 8 * DAY).toISOString()],
    ];
    for (const [why, body, now] of cases) {
      const b = box(first);
      const out = await pullStorePack({ source: serving(body), receiver: b.receiver, signer, now });
      expect(out.status, why).toBe('refused');
      expect(b.calls, why).toEqual([]);
      expect(b.held(), why).toBe(first);
    }
    // another store's envelope that happens to carry the same contents
    const b = box(first);
    const stranger = { ...at('2026-10-02T00:00:00.000Z', SECTIONS, signer, 'S2') };
    expect((await pullStorePack({ source: serving(stranger), receiver: b.receiver, signer, now: '2026-10-02T00:00:01.000Z' })).status).toBe('refused');
    expect(b.held()).toBe(first);
  });

  it('a changed setup is still taken whole, as before', async () => {
    const b = box(first);
    const changed = at('2026-10-02T00:00:00.000Z', { policies: { storeId: 'S1', branchName: 'Renamed' } });
    expect((await pullStorePack({ source: serving(changed), receiver: b.receiver, signer, now: '2026-10-02T00:00:01.000Z' })).status).toBe('updated');
    expect(b.calls).toEqual([`take:${changed.version}`]);
  });
});
