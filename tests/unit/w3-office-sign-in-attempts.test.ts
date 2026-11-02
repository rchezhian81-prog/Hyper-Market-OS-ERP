import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { claimedIdentityOf, sourceOf, officeSignInAttempt } from '../../services/kernel/src/sign-in-attempts';

// W3 · D13-FR-06: what a kept office sign-in attempt holds — the shop and person a refused token CLAIMS, an address
// class with the last part masked — and never the token or anything secret.

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const T = '0f1e2d3c-4b5a-4968-8776-655443322110';

describe('D13-FR-06 — the claims of a refused token', () => {
  it('reads the claimed shop (a UUID only) and person (sre_user_id, else sub), cleaned', () => {
    expect(claimedIdentityOf(`${b64({ alg: 'none' })}.${b64({ tenant_id: T.toUpperCase(), sub: 'u-1' })}.x`)).toEqual({ tenantId: T, userId: 'u-1' });
    expect(claimedIdentityOf(`${b64({})}.${b64({ tenant_id: T, sub: 'abc', sre_user_id: 'u-staff' })}.x`).userId).toBe('u-staff');
    expect(claimedIdentityOf(`${b64({})}.${b64({ tenant_id: 'shop-1', sub: 'u\n<script>' })}.x`)).toEqual({ tenantId: null, userId: 'uscript' });
  });
  it('anything unreadable is null — never a throw', () => {
    for (const t of ['', 'abc', 'a.b.c', `${b64({})}.${Buffer.from('not json').toString('base64url')}.x`, `${b64({})}.${b64('a string')}.x`]) {
      expect(claimedIdentityOf(t)).toEqual({ tenantId: null, userId: null });
    }
  });
});

describe('D13-FR-06 — the source address as a class, never the whole address', () => {
  it('classes and masks', () => {
    expect(sourceOf('203.0.113.77')).toEqual({ sourceClass: 'public', sourceNetwork: '203.0.113.x' });
    expect(sourceOf('192.168.1.20')).toEqual({ sourceClass: 'private', sourceNetwork: '192.168.1.x' });
    expect(sourceOf('172.20.0.5').sourceClass).toBe('private');
    expect(sourceOf('::ffff:10.1.2.3')).toEqual({ sourceClass: 'private', sourceNetwork: '10.1.2.x' });
    expect(sourceOf('127.0.0.1').sourceClass).toBe('loopback');
    expect(sourceOf('::1').sourceClass).toBe('loopback');
    expect(sourceOf('2001:db8:aa:bb:cc:dd:ee:ff')).toEqual({ sourceClass: 'public', sourceNetwork: '2001:db8:aa:bb:x' });
    expect(sourceOf(undefined)).toEqual({ sourceClass: 'unknown', sourceNetwork: 'unknown' });
    expect(sourceOf('unknown').sourceClass).toBe('unknown');
  });
});

describe('D13-FR-06 — the record never holds the token', () => {
  it('keeps the claims, the class and the path; not the token, its signature or the full address', () => {
    // Made up as the test runs (never a literal in the repo): what a guesser might put in a forged token.
    const guessed = { word: randomUUID(), digits: String(1000 + Math.floor(Math.random() * 9000)) };
    const token = `${b64({ alg: 'HS256' })}.${b64({ tenant_id: T, sub: 'u-guess', password: guessed.word, pin: guessed.digits })}.c2lnbmF0dXJl`;
    const a = officeSignInAttempt({ at: '2026-11-02T10:00:00.000Z', outcome: 'locked_out', token, clientIp: '198.51.100.9', path: '/v1/x', traceId: 't-1', lockedForSeconds: 5 });
    expect(a).toEqual({ at: '2026-11-02T10:00:00.000Z', outcome: 'locked_out', claimedTenantId: T, claimedUserId: 'u-guess', sourceClass: 'public', sourceNetwork: '198.51.100.x', path: '/v1/x', traceId: 't-1', lockedForSeconds: 5 });
    const kept = JSON.stringify(a);
    for (const s of [token, 'c2lnbmF0dXJl', guessed.word, guessed.digits, '198.51.100.9']) expect(kept).not.toContain(s);
  });
});
