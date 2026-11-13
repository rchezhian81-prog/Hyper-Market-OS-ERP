import { describe, it, expect } from 'vitest';
import {
  createKeysSession, keysWords, keysOutcomeWords, secretRowOf, dueWords, SECRET_KINDS, SECRET_STATES, KEYS_COPY,
} from '../../apps/web-erp/src/keys-session';

/**
 * **The Keys and credentials page (U6 · §27 Admin/Security "keys" · M32-FR-03 · hard rule 4): the session carries
 * references, states and dates — never a value.**
 *
 * The audit (lane 4) found no screen naming the shop's keys and credentials; the secret inventory sat as one list on
 * Integration health with no way to rotate or revoke. This pins the page's rules before the page exists: a secret's value
 * never passes through (only the named fields do, whatever head office sends); a rotation needs a vault REFERENCE and a
 * positive grace; a revocation needs a reason; a token revocation needs a person or a token and a reason; every act is
 * gated on the person's own permission; every word has a Tamil twin.
 */

const OWNER = { userId: 'u-owner', permissions: ['platform.setup.read', 'platform.setup.write', 'identity.session.revoke'] };
const READER = { userId: 'u-reader', permissions: ['platform.setup.read'] };

type Sent = { method: string; path: string; body?: unknown };
function fakeFetch(answer: (s: Sent) => unknown) {
  const sent: Sent[] = [];
  const fetch = (async (path: string, init?: { method?: string; body?: string }) => {
    const s: Sent = { method: init?.method ?? 'GET', path, ...(init?.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }) };
    sent.push(s);
    const body = answer(s);
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

describe('the Keys and credentials session (U6)', () => {
  it('reads the inventory as rows that carry only the named fields — a value head office ever sent along is dropped', async () => {
    const f = fakeFetch(() => ({ secrets: [{ secretId: 'sec-pay', kind: 'payment_provider', vaultRef: 'vault://payments/live#v4', version: 4, state: 'active', createdOn: '2026-01-10', owner: 'u-owner', protects: 'card payments at the tills', rotateEveryDays: 90, environment: 'production', lastRotatedOn: '2026-10-01', value: 'sk_live_SHOULD_NEVER_APPEAR', apiKey: 'nope' }] }));
    const s = createKeysSession({ viewer: OWNER, fetch: f.fetch });
    const out = await s.inventory();
    expect(out.result).toBe('ok');
    if (out.result !== 'ok') return;
    expect(out.value).toHaveLength(1);
    const row = out.value[0]!;
    expect(JSON.stringify(row)).not.toContain('SHOULD_NEVER_APPEAR');
    expect(JSON.stringify(row)).not.toContain('nope');
    expect(Object.keys(row).sort()).toEqual(['createdOn', 'environment', 'kind', 'lastRotatedOn', 'owner', 'protects', 'rotateEveryDays', 'secretId', 'state', 'vaultRef', 'version']);
  });

  it('a rotation needs a vault reference (a scheme URI, never a key) and a positive grace; it is sent with both', async () => {
    const f = fakeFetch(() => ({ secretId: 'sec-pay', rotated: true, outcome: 'rotated', detail: 'rotated with 7 days of overlap' }));
    const s = createKeysSession({ viewer: OWNER, fetch: f.fetch });
    expect(await s.rotate('sec-pay', { newVaultRef: '', graceDays: '7' })).toEqual({ result: 'invalid', why: 'noVaultRef' });
    expect(await s.rotate('sec-pay', { newVaultRef: 'sk_live_abc123', graceDays: '7' })).toEqual({ result: 'invalid', why: 'notAReference' });
    expect(await s.rotate('sec-pay', { newVaultRef: 'vault://payments/live#v5', graceDays: '0' })).toEqual({ result: 'invalid', why: 'noGrace' });
    const ok = await s.rotate('sec-pay', { newVaultRef: 'vault://payments/live#v5', graceDays: '7' });
    expect(ok.result).toBe('ok');
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ method: 'POST', path: '/v1/integration/secrets/sec-pay/rotation', body: { newVaultRef: 'vault://payments/live#v5', graceDays: 7 } });
  });

  it('a revocation needs a reason; a token revocation needs a person or a token and one of the named reasons', async () => {
    const f = fakeFetch(() => ({ secretId: 'sec-pay', revoked: { secretId: 'sec-pay', state: 'revoked' }, willBreak: [], detail: 'revoked' }));
    const s = createKeysSession({ viewer: OWNER, fetch: f.fetch });
    expect(await s.revoke('sec-pay', '  ')).toEqual({ result: 'invalid', why: 'noReason' });
    expect((await s.revoke('sec-pay', 'laptop stolen')).result).toBe('ok');
    expect(f.sent[0]).toMatchObject({ method: 'POST', path: '/v1/integration/secrets/sec-pay/revocation', body: { reason: 'laptop stolen' } });
    expect(await s.revokeTokens('user', '', 'security')).toEqual({ result: 'invalid', why: 'noWho' });
    expect(await s.revokeTokens('user', 'u-ravi', 'because')).toEqual({ result: 'invalid', why: 'noRevocationReason' });
    expect((await s.revokeTokens('user', 'u-ravi', 'security')).result).toBe('ok');
    expect(f.sent[1]).toMatchObject({ method: 'POST', path: '/v1/identity/token-revocations', body: { userId: 'u-ravi', reason: 'security' } });
  });

  it('every act is gated on the person\'s own permission, and nobody signed in is said as such', async () => {
    const f = fakeFetch(() => ({ secrets: [] }));
    const reader = createKeysSession({ viewer: READER, fetch: f.fetch });
    expect(reader.may).toEqual({ named: true, read: true, write: false, revokeTokens: false });
    expect(await reader.rotate('sec-pay', { newVaultRef: 'vault://x#v2', graceDays: '7' })).toEqual({ result: 'invalid', why: 'notAllowed' });
    expect(await reader.revokeTokens('user', 'u-ravi', 'security')).toEqual({ result: 'invalid', why: 'notAllowed' });
    const nobody = createKeysSession({ viewer: undefined, fetch: f.fetch });
    expect(nobody.may.named).toBe(false);
    expect(await nobody.inventory()).toEqual({ result: 'invalid', why: 'nobody' });
    expect(f.sent, 'nothing was asked of head office for a person without the right').toHaveLength(0);
  });

  it('says when a rotation is due, in both languages, from the dates and the policy — "not known" when there is no date', () => {
    const base = secretRowOf({ secretId: 's', kind: 'gst_portal', vaultRef: 'vault://gst#v1', version: 1, state: 'active', createdOn: '2026-01-01', owner: 'u-owner', protects: 'GST filing', rotateEveryDays: 90, environment: 'production' });
    expect(dueWords('en', base, '2026-02-01')).toBe('due in 59 days (1 Apr 2026)');
    expect(dueWords('en', base, '2026-05-01')).toBe('overdue by 30 days (was due 1 Apr 2026)');
    expect(dueWords('ta', base, '2026-05-01')).toContain('30');
    expect(dueWords('en', { ...base, lastRotatedOn: '2026-04-15' }, '2026-05-01')).toBe('due in 74 days (14 Jul 2026)');
    expect(dueWords('en', { ...base, state: 'revoked', revokedOn: '2026-03-01' }, '2026-05-01')).toBe('revoked on 1 Mar 2026');
    expect(dueWords('en', { ...base, createdOn: '' }, '2026-05-01')).toBe('not known — no date on record');
  });

  it('every word, kind, state, finding and refusal has a Tamil twin; a refusal carries the three parts', () => {
    const en = Object.keys(KEYS_COPY.en).sort(); const ta = Object.keys(KEYS_COPY.ta).sort();
    expect(ta).toEqual(en);
    for (const k of SECRET_KINDS) { expect(keysWords('ta', `k_${k}`)).not.toBe(`k_${k}`); expect(keysWords('en', `k_${k}`)).not.toBe(`k_${k}`); }
    for (const st of SECRET_STATES) expect(keysWords('ta', `st_${st}`)).not.toBe(`st_${st}`);
    for (const fnd of ['overdue_rotation', 'rotation_due_soon', 'no_owner', 'never_rotated', 'revoked_still_referenced']) expect(keysWords('ta', `f_${fnd}`)).not.toBe(`f_${fnd}`);
    const said = keysOutcomeWords('en', { result: 'refused', status: 409, code: 'no_grace_on_rotation', whatHappened: 'A rotation must overlap.' });
    expect(said).toContain('A rotation must overlap.');
    expect(said).toMatch(/Nothing was changed|nothing was changed|not changed/);
    expect(keysOutcomeWords('ta', { result: 'lost_link' })).not.toBe('');
  });
});
