import { describe, it, expect } from 'vitest';
import { fulfilCompensation, type FulfilmentPorts } from '../../services/customer/src/compensation-fulfilment';

// PF-11: execution of a granted compensation — what moves, what waits, and what fails, always said.

const ports = (over: Partial<FulfilmentPorts> = {}): FulfilmentPorts & { issued: unknown[]; points: unknown[] } => {
  const issued: unknown[] = [];
  const points: unknown[] = [];
  return {
    issued, points,
    now: () => '2026-10-10T10:00:00.000Z',
    pointValuePaise: async () => 100,
    issueStoreCredit: async (_t, i) => { issued.push(i); },
    addPoints: async (_t, c, m) => { points.push({ c, ...m }); },
    ...over,
  };
};
const input = (kind: 'goodwill_credit' | 'loyalty_points' | 'refund' | 'replacement', amountMinor = 1_000, customerRef = 'm-1') =>
  ({ compensationId: 'comp-1', caseId: 'k1', customerRef, kind, amountMinor });

describe('fulfilCompensation', () => {
  it('goodwill credit → one store-credit instrument keyed on the compensation', async () => {
    const p = ports();
    expect(await fulfilCompensation(p, 't', input('goodwill_credit'))).toMatchObject({ status: 'completed', ref: 'goodwill:comp-1' });
    expect(p.issued).toEqual([expect.objectContaining({ instrumentId: 'goodwill:comp-1', kind: 'store_credit', ownerRef: 'm-1' })]);
  });
  it('points → whole points at the owner\'s value, keyed on the compensation; a part point fails, said', async () => {
    const p = ports();
    expect(await fulfilCompensation(p, 't', input('loyalty_points', 1_000))).toMatchObject({ status: 'completed', ref: 'goodwill-comp-1' });
    expect(p.points).toEqual([expect.objectContaining({ c: 'm-1', points: 10, movementId: 'goodwill-comp-1' })]);
    expect(await fulfilCompensation(p, 't', input('loyalty_points', 1_050))).toMatchObject({ status: 'failed' });
  });
  it('no customer on the case, or a port that throws: failed, with what to do', async () => {
    expect(await fulfilCompensation(ports(), 't', input('goodwill_credit', 1_000, ''))).toMatchObject({ status: 'failed' });
    const broken = ports({ issueStoreCredit: async () => { throw new Error('disk full'); } });
    const r = await fulfilCompensation(broken, 't', input('goodwill_credit'));
    expect(r).toMatchObject({ status: 'failed' });
    expect(r.detail).toMatch(/disk full.*carry it out again/);
  });
  it('a refund and a replacement are pending — this system never marks money paid', async () => {
    expect(await fulfilCompensation(ports(), 't', input('refund'))).toMatchObject({ status: 'pending' });
    expect(await fulfilCompensation(ports(), 't', input('replacement'))).toMatchObject({ status: 'pending' });
  });
});
