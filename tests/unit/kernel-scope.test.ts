import { describe, it, expect } from 'vitest';
import { ApiError, assertBranchInScope, branchInScope, documentsVerifiedByTheCaller, narrowScope, scopeOf, withinScope, type VerifiableDocument } from '../../services/kernel/src/index';

/** The kernel's scope helpers (Wave 2b-ii · PA-01 / EA-03): narrow to what is held, refuse what is not, by name. */
const code = (fn: () => unknown): string => { try { fn(); } catch (e) { if (e instanceof ApiError) return e.body.code; throw e; } return 'no-error'; };

describe('scope helpers', () => {
  it('a context with no scope (a handler run outside the pipeline) holds nothing — fail closed', () => {
    expect(scopeOf({})).toEqual([]);
    expect(branchInScope({}, 'br-1')).toBe(false);
    expect(code(() => assertBranchInScope({}, 'br-1'))).toBe('outside_your_branch_scope');
    expect(code(() => narrowScope({}, ['br-1']))).toBe('scope_not_held');
    expect(narrowScope({})).toEqual([]);
  });

  it('narrows what is held to what was asked for; refuses a branch not held, and "all" unless all is held', () => {
    const held = { scope: ['br-1', 'br-2'] as const };
    expect(narrowScope(held)).toEqual(['br-1', 'br-2']);
    expect(narrowScope(held, ['br-2'])).toEqual(['br-2']);
    expect(code(() => narrowScope(held, ['br-2', 'br-3']))).toBe('scope_not_held');
    expect(code(() => narrowScope(held, 'all'))).toBe('scope_not_held');
    const all = { scope: 'all' as const };
    expect(narrowScope(all)).toBe('all');
    expect(narrowScope(all, 'all')).toBe('all');
    expect(narrowScope(all, ['br-9'])).toEqual(['br-9']);
  });

  it('withinScope keeps the rows of the branches held', () => {
    const rows = [{ branchId: 'br-1', x: 1 }, { branchId: 'br-2', x: 2 }];
    expect(withinScope(['br-2'], rows)).toEqual([{ branchId: 'br-2', x: 2 }]);
    expect(withinScope('all', rows)).toEqual(rows);
    expect(withinScope([], rows)).toEqual([]);
  });
});

describe('who verified a document is the person who did, under their own sign-in (2b-vi-c-1 · PA-03)', () => {
  const NOW = '2026-10-07T10:00:00.000Z';
  const gst = { documentId: 'd1', kind: 'gst_registration', reference: 'G-1', validFrom: '2026-01-01', validUntil: '2027-12-31' };
  const stored: VerifiableDocument[] = [{ ...gst, verifiedBy: 'u-a', verifiedAt: '2026-09-01T09:00:00.000Z' }];
  it('stamps the caller\'s verification with the server\'s clock — a typed time is not evidence', () => {
    expect(documentsVerifiedByTheCaller<VerifiableDocument>({ userId: 'u-b' }, [{ ...gst, verifiedBy: 'u-b', verifiedAt: '2001-01-01T00:00:00.000Z' }], [], NOW))
      .toEqual([{ ...gst, verifiedBy: 'u-b', verifiedAt: NOW }]);
  });
  it('keeps a document re-sent exactly as stored, with its verifier and time, whoever sends it', () => {
    expect(documentsVerifiedByTheCaller<VerifiableDocument>({ userId: 'u-b' }, [{ ...gst, verifiedBy: 'u-a' }], stored, NOW)).toEqual(stored);
  });
  it('refuses a name for anyone else on a new or changed document, by name', () => {
    expect(code(() => documentsVerifiedByTheCaller<VerifiableDocument>({ userId: 'u-b' }, [{ ...gst, verifiedBy: 'u-a' }], [], NOW))).toBe('actor_is_the_caller');
    expect(code(() => documentsVerifiedByTheCaller<VerifiableDocument>({ userId: 'u-b' }, [{ ...gst, validUntil: '2030-01-01', verifiedBy: 'u-a' }], stored, NOW))).toBe('actor_is_the_caller');
  });
  it('a document with no verifier is unverified, whatever time is sent', () => {
    expect(documentsVerifiedByTheCaller<VerifiableDocument>({ userId: 'u-b' }, [{ ...gst, verifiedAt: NOW }], stored, NOW)).toEqual([gst]);
  });
});
