import { describe, it, expect } from 'vitest';
import { createAccessReviewSession, accessReviewWords, whereWords, ordered, ACCESS_REVIEW_COPY } from '../../apps/web-erp/src/access-review-session';

describe('the Access review session (M02-FR-01/02)', () => {
  it('reads only for a person holding the review, flagged rows first, and says where a role reaches', async () => {
    const calls: string[] = [];
    const fetch = (async (path: string) => { calls.push(path); return { ok: true, status: 200, json: async () => ({ rows: [], count: 0, flagged: 0, asAt: 'x' }) } as Response; }) as typeof globalThis.fetch;
    expect(await createAccessReviewSession({ viewer: { userId: 'u-cash', permissions: [] }, fetch }).read(false)).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(await createAccessReviewSession({ viewer: undefined, fetch }).matrixCsv()).toEqual({ result: 'invalid', why: 'nobody' });
    expect(calls).toEqual([]);
    const s = createAccessReviewSession({ viewer: { userId: 'u-acc', permissions: ['identity.access.review'] }, fetch });
    await s.read(true); await s.matrixCsv();
    expect(calls).toEqual(['/v1/identity/access-review?flagged=true', '/v1/identity/permission-matrix?format=csv']);
    expect(whereWords('en', { roleId: 'store_manager', roleName: 'Store manager', branchScope: ['b1'], departmentScope: ['D-dairy'] })).toBe('b1 · departments: D-dairy');
    expect(whereWords('ta', { roleId: 'owner', roleName: 'Owner', branchScope: 'all', departmentScope: 'all' })).toBe('எல்லாக் கிளைகளும் · எல்லாத் துறைகளும்');
    const row = (userId: string, flags: string[]) => ({ userId, displayName: null, signIn: 'none' as const, secondFactor: null, privileged: false, machine: false, roles: [], emergency: [], flags });
    expect(ordered([row('a', []), row('b', ['emergency_access_live'])]).map((r) => r.userId)).toEqual(['b', 'a']);
  });

  it('has a Tamil word for every English one', () => {
    expect(Object.keys(ACCESS_REVIEW_COPY.en).filter((k) => !(k in ACCESS_REVIEW_COPY.ta))).toEqual([]);
    expect(accessReviewWords('ta', 'title')).toBe('அணுகல் மீளாய்வு');
  });
});
