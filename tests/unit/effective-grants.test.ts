import { describe, it, expect } from 'vitest';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { effectiveGrants, assignmentKey, STREAM, ROLE_GRANTED, ROLE_REVOKED } from '../../services/api/src/adapters';

/**
 * **Grants minus revocations (Wave 2b-i · audit PA-02 · M02-FR-02 · M02-FR-04).** Every reader of authority folds this
 * ONE function. Before it, a `RoleGranted` could never be undone on the ledger — no reader knew a revocation event.
 */

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-10-05T10:00:00.000Z';
let n = 0;
const ev = (type: string, payload: Record<string, unknown>) =>
  makeEvent({ id: `g-${n += 1}`, type, occurredAt: AT, idempotencyKey: `g-${n}`, source: 'test', payload });
const g = (userId: string, roleId: string, branchScope: readonly string[] | 'all' = 'all') => ({ userId, roleId, branchScope });

describe('effectiveGrants', () => {
  it('a grant stands until a revocation of the same person, role and scope; a grant made again afterwards stands', async () => {
    const s = new InMemoryEventStore();
    await s.append(T, STREAM.identity, ev(ROLE_GRANTED, g('u1', 'cashier')));
    expect(await effectiveGrants(s, T)).toEqual([g('u1', 'cashier')]);
    await s.append(T, STREAM.identity, ev(ROLE_REVOKED, g('u1', 'cashier')));
    expect(await effectiveGrants(s, T)).toEqual([]);
    await s.append(T, STREAM.identity, ev(ROLE_GRANTED, g('u1', 'cashier')));
    expect(await effectiveGrants(s, T)).toEqual([g('u1', 'cashier')]);
  });

  it('a revocation names the scope too: taking the role away at b1 leaves it at b2; a revocation of something never granted is nothing', async () => {
    const s = new InMemoryEventStore();
    await s.append(T, STREAM.identity, ev(ROLE_GRANTED, g('u1', 'store_manager', ['b1'])));
    await s.append(T, STREAM.identity, ev(ROLE_GRANTED, g('u1', 'store_manager', ['b2'])));
    await s.append(T, STREAM.identity, ev(ROLE_REVOKED, g('u1', 'store_manager', ['b1'])));
    await s.append(T, STREAM.identity, ev(ROLE_REVOKED, g('u1', 'owner')));
    expect(await effectiveGrants(s, T)).toEqual([g('u1', 'store_manager', ['b2'])]);
  });

  it('other people are untouched; the order of branches in a scope does not matter to the key; other event types on the stream are ignored', async () => {
    const s = new InMemoryEventStore();
    await s.append(T, STREAM.identity, ev(ROLE_GRANTED, g('u1', 'cashier', ['b1', 'b2'])));
    await s.append(T, STREAM.identity, ev(ROLE_GRANTED, g('u2', 'cashier', ['b1', 'b2'])));
    await s.append(T, STREAM.identity, ev('TokenRevoked', { id: 'r1', userId: 'u1' }));
    await s.append(T, STREAM.identity, ev(ROLE_REVOKED, g('u1', 'cashier', ['b2', 'b1'])));
    expect(await effectiveGrants(s, T)).toEqual([g('u2', 'cashier', ['b1', 'b2'])]);
    expect(assignmentKey(g('u1', 'cashier', ['b2', 'b1']))).toBe(assignmentKey(g('u1', 'cashier', ['b1', 'b2'])));
  });

  it('is per tenant: a revocation in one tenant never touches another\'s grant', async () => {
    const s = new InMemoryEventStore();
    const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await s.append(T, STREAM.identity, ev(ROLE_GRANTED, g('u1', 'cashier')));
    await s.append(B, STREAM.identity, ev(ROLE_GRANTED, g('u1', 'cashier')));
    await s.append(B, STREAM.identity, ev(ROLE_REVOKED, g('u1', 'cashier')));
    expect(await effectiveGrants(s, T)).toEqual([g('u1', 'cashier')]);
    expect(await effectiveGrants(s, B)).toEqual([]);
  });
});
