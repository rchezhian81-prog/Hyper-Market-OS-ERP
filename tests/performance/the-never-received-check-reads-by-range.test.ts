import { describe, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { unbankedAboveBanked, atRiskBelowBanked } from '../support/never-received-cost';

/**
 * **Verifier r20 (cost) — "bills issued but never received" is checked by RANGE, never one bill at a time.**
 *
 * r19 looked every candidate number up on its own (`findByIdempotencyKey`: four round trips each on PostgreSQL), up to 500
 * per prefix: probe zz-v20-lostcost took 1.9–2.8 s for ONE health read with 8 lanes × 500 unbanked bills. Now:
 *   • a number ABOVE the prefix's banked count is unbanked by definition (banked is the highest count head office holds) —
 *     it is never read at all;
 *   • the numbers a restored box cannot vouch for that sit AT OR BELOW banked are looked up in ONE indexed read per prefix
 *     (`existingIdempotencyKeys`: the ledger's unique (tenant, key) index).
 * Proved by COUNTING the store calls (memory and PostgreSQL) and by the wall clock on PostgreSQL: one health read with 8
 * lanes × 500 unbanked bills, and 8 lanes × 500 at-risk bills below banked, each well under 200 ms — with the same answer.
 */

describe('verifier r20 (cost): the never-received check reads by range (memory: counted)', () => {
  it('numbers above banked are never read', async () => { await unbankedAboveBanked(new InMemoryEventStore(), randomUUID(), false); });
  it('at-risk numbers below banked: one indexed read per prefix', async () => { await atRiskBelowBanked(new InMemoryEventStore(), randomUUID(), false); });
});
