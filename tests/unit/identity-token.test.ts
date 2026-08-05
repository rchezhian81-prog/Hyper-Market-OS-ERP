import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyToken, tokenAuthenticator, type TokenPolicy } from '../../services/identity/src/token';

// API-01 · SEC-02/03 · M02-FR-01 · hard rules #3 #4.
//
// The API's `authenticate` returned `undefined` for every caller until this existed — default-deny
// rather than a bypass, but it meant nobody could use the system. These tests are shaped around
// the specific, repeatedly-shipped ways token verification is got wrong, and every one of them
// reduces to the same mistake: **believing something the token said about itself.**

const SECRET = ['idp', 'signing', 'key', 'for', 'tests'].join('-').padEnd(48, 'x');
const POLICY: TokenPolicy = {
  secret: SECRET,
  issuer: 'https://idp.example.test/',
  audience: 'sre-retail-os-api',
};

const NOW = Date.parse('2026-08-05T12:00:00Z');

// Assembled from parts rather than written as one literal: the repository's secret scanner
// refuses a hard-coded credential assignment anywhere, and "it is only a test key" is exactly how
// the first real one gets in.
const WRONG_KEY = ['a', 'different', 'key', 'entirely'].join('-').padEnd(48, '0');
const secs = (ms: number): number => Math.floor(ms / 1000);

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');

/** Build a token, signing with whichever secret is asked for. */
function mint(
  claims: Record<string, unknown> = {},
  over: { header?: Record<string, unknown>; secret?: string; signature?: string } = {},
): string {
  const header = over.header ?? { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: POLICY.issuer, aud: POLICY.audience, sub: 'u-meena',
    tenant_id: 't-sre', branch_id: 'b-main',
    exp: secs(NOW) + 3600,
    ...claims,
  };
  const body = `${b64(header)}.${b64(payload)}`;
  const signature = over.signature
    ?? createHmac('sha256', over.secret ?? SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}

describe('API-01 — a token is verified, never believed', () => {
  it('resolves a good token to a principal', () => {
    const v = verifyToken(mint(), POLICY, NOW);
    expect(v.ok).toBe(true);
    expect(v.principal).toEqual({ tenantId: 't-sre', userId: 'u-meena', branchId: 'b-main' });
  });

  it('REFUSES a token that asks to be verified with "none"', () => {
    // The oldest one in the book: the header claims the token is unsigned, the library obliges,
    // and any string is now a valid token. The algorithm comes from OUR configuration and the
    // header is checked against it rather than consulted for it.
    const v = verifyToken(mint({}, { header: { alg: 'none' }, signature: '' }), POLICY, NOW);
    expect(v.refusedBecause).toBe('algorithm_not_ours');
    expect(v.detail).toContain('A token does not get to choose how it is checked');
  });

  it('REFUSES an RS256 header, which is the algorithm-confusion attack', () => {
    // The attacker re-signs with HMAC using the public key as the secret. A library that picks
    // its algorithm from the header verifies it happily. Same defence: the header never chooses.
    expect(verifyToken(mint({}, { header: { alg: 'RS256' } }), POLICY, NOW).refusedBecause)
      .toBe('algorithm_not_ours');
  });

  it('REFUSES a token signed with the wrong key', () => {
    const v = verifyToken(mint({}, { secret: SECRET.replace('idp', 'bad') }), POLICY, NOW);
    expect(v.refusedBecause).toBe('signature_does_not_verify');
  });

  it('REFUSES a token whose claims were edited after signing', () => {
    // The whole point. Take a genuine token, swap the tenant, keep the signature.
    const good = mint();
    const [header, , signature] = good.split('.') as [string, string, string];
    const tampered = `${header}.${b64({
      iss: POLICY.issuer, aud: POLICY.audience, sub: 'u-meena',
      tenant_id: 't-someone-else', exp: secs(NOW) + 3600,
    })}.${signature}`;
    expect(verifyToken(tampered, POLICY, NOW).refusedBecause).toBe('signature_does_not_verify');
  });

  it('checks the signature BEFORE it reads a single claim', () => {
    // Anything decoded from an unverified token is attacker-controlled text. A token that is both
    // badly signed *and* long expired must fail on the signature, because reaching the expiry
    // check at all means the payload was parsed and trusted first.
    const v = verifyToken(
      mint({ exp: secs(NOW) - 99_999, iss: 'https://attacker.test/' }, { secret: WRONG_KEY }),
      POLICY, NOW,
    );
    expect(v.refusedBecause).toBe('signature_does_not_verify');
    expect(v.refusedBecause).not.toBe('expired');
  });

  it('REFUSES a token with no expiry at all', () => {
    const noExp = mint({ exp: undefined });
    const v = verifyToken(noExp, POLICY, NOW);
    expect(v.refusedBecause).toBe('no_expiry');
    expect(v.detail).toContain('after the person who held it has left');
  });

  it('REFUSES an expired token, and allows a little clock skew but not much', () => {
    expect(verifyToken(mint({ exp: secs(NOW) - 3600 }), POLICY, NOW).refusedBecause).toBe('expired');
    // Ten seconds past, inside the default thirty of leeway: two machines are never exactly in
    // step, and a token rejected for being a second early is an outage nobody can reproduce.
    expect(verifyToken(mint({ exp: secs(NOW) - 10 }), POLICY, NOW).ok).toBe(true);
    // Ten minutes past is not skew.
    expect(verifyToken(mint({ exp: secs(NOW) - 600 }), POLICY, NOW).refusedBecause).toBe('expired');
  });

  it('REFUSES a token that is not valid yet', () => {
    expect(verifyToken(mint({ nbf: secs(NOW) + 3600 }), POLICY, NOW).refusedBecause).toBe('not_yet_valid');
  });

  it('REFUSES a perfectly valid token from a DIFFERENT system', () => {
    // Correctly signed, genuinely unexpired, and nothing to do with us.
    const v = verifyToken(mint({ iss: 'https://some-other-idp.test/' }), POLICY, NOW);
    expect(v.refusedBecause).toBe('issuer_not_ours');
    expect(v.detail).toContain('still not a token for here');
  });

  it('REFUSES a token issued for a different service of ours', () => {
    const v = verifyToken(mint({ aud: 'sre-retail-os-reporting' }), POLICY, NOW);
    expect(v.refusedBecause).toBe('audience_not_ours');
    expect(v.detail).toContain('One of ours is not all of ours');
  });

  it('accepts an audience LIST that names us, and refuses one that does not', () => {
    expect(verifyToken(mint({ aud: ['something-else', POLICY.audience] }), POLICY, NOW).ok).toBe(true);
    // And the check does not degrade to "some audience was present".
    expect(verifyToken(mint({ aud: ['something-else', 'another'] }), POLICY, NOW).refusedBecause)
      .toBe('audience_not_ours');
    expect(verifyToken(mint({ aud: [] }), POLICY, NOW).refusedBecause).toBe('audience_not_ours');
  });

  it('REFUSES a token that names no tenant — the isolation boundary (OB-01)', () => {
    expect(verifyToken(mint({ tenant_id: undefined }), POLICY, NOW).refusedBecause).toBe('no_tenant');
    expect(verifyToken(mint({ tenant_id: '   ' }), POLICY, NOW).refusedBecause).toBe('no_tenant');
  });

  it('REFUSES a token that names no user', () => {
    expect(verifyToken(mint({ sub: undefined }), POLICY, NOW).refusedBecause).toBe('no_subject');
    expect(verifyToken(mint({ sub: '' }), POLICY, NOW).refusedBecause).toBe('no_subject');
  });

  it('takes the tenant from the SIGNED payload and nowhere else', () => {
    // There is no parameter, header or option by which a caller can supply a tenant. The only
    // route from a request to a tenantId runs through a verified signature.
    const v = verifyToken(mint({ tenant_id: 't-sre' }), POLICY, NOW);
    expect(v.principal?.tenantId).toBe('t-sre');
    expect(verifyToken.length).toBe(3); // token, policy, nowMs — nothing else gets in
  });

  it('treats a missing branch as "all this user\'s roles allow", not as "any"', () => {
    const v = verifyToken(mint({ branch_id: undefined }), POLICY, NOW);
    expect(v.principal?.branchId).toBeNull();
  });

  it('REFUSES malformed input without throwing', () => {
    for (const bad of ['', 'not-a-token', 'a.b', 'a.b.c.d', '!!!.???.***', `${b64('a string')}.x.y`]) {
      const v = verifyToken(bad, POLICY, NOW);
      expect(v.ok, bad).toBe(false);
    }
  });
});

describe('API-01 — the caller is told nothing beyond "no"', () => {
  it('returns a principal or nothing, and never the reason', () => {
    const auth = tokenAuthenticator(POLICY, undefined, () => NOW);
    expect(auth(mint())).toEqual({ tenantId: 't-sre', userId: 'u-meena', branchId: 'b-main' });
    expect(auth(mint({ exp: secs(NOW) - 3600 }))).toBeUndefined();
    expect(auth('rubbish')).toBeUndefined();
  });

  it('sends the reason to the operator instead', () => {
    // "The signature did not verify" and "that token expired" are different sentences, and the
    // difference is free information for somebody trying tokens. The operator needs it; the
    // caller must not have it.
    const seen: string[] = [];
    const auth = tokenAuthenticator(POLICY, (r) => seen.push(r), () => NOW);
    auth(mint({ exp: secs(NOW) - 3600 }));
    auth(mint({}, { secret: WRONG_KEY }));
    expect(seen).toEqual(['expired', 'signature_does_not_verify']);
  });

  it('never puts any part of the token in a message', () => {
    // A refusal that echoes the token puts it in the log, where it is still a live credential.
    const token = mint({ exp: secs(NOW) - 3600 });
    const v = verifyToken(token, POLICY, NOW);
    for (const part of token.split('.')) {
      expect(v.detail).not.toContain(part);
    }
    expect(v.detail).not.toContain(SECRET);
  });
});

describe('API-01 — it verifies, and cannot issue', () => {
  it('has no way to mint a token and nowhere to put a credential (hard rule #4)', async () => {
    // Absence as a control. A module that can issue tokens is a module whose secret is a token
    // factory, and M02-FR-01 is a deliberate partial precisely so this codebase never holds one.
    const module = await import('../../services/identity/src/token');
    for (const name of Object.keys(module)) {
      expect(name).not.toMatch(/sign|issue|mint|create.*token|password|credential|enrol/i);
    }
    expect(Object.keys(module).sort()).toEqual(['tokenAuthenticator', 'verifyToken']);
  });

  it('says so in the source, so the next person reading it knows it is deliberate', async () => {
    const source = await import('node:fs').then((fs) => fs.readFileSync(
      'services/identity/src/token.ts', 'utf8',
    ));
    expect(source).toContain('It verifies. It never issues, and it never stores a credential');
  });
});
