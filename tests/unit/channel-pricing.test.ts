import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { switchesOn, gatedEntries, switchOf, type ChannelSwitchRequest } from '../../services/pricing/src/channel-pricing';
import { resolvePrice, type PriceEntry } from '../../packages/price-list/src/price-list';

/** D-19 (R3, OB-148 "A"): the switches, the gate, and the guardrail that no path charges a channel price while off. */
const e = (id: string, scope: PriceEntry['scope'], scopeRef: string, minor: number): PriceEntry => ({ id, productId: 'p', scope, scopeRef, price: { minor, currency: 'INR' }, effectiveFrom: '2030-01-01', status: 'active', version: 1 });
const req = (requestId: string, subject: string, to: 'on' | 'off', status: 'pending' | 'applied', at: string): ChannelSwitchRequest => ({ requestId, subject, to, reason: 'r', requestedBy: 'a', requestedAt: at, status, approvedBy: status === 'applied' ? 'b' : null, approvedAt: status === 'applied' ? at : null });
const ENTRIES = [e('shelf', 'store', 'S-A', 10_000), e('app', 'channel', 'app', 9_000), e('zone', 'zone', 'Z-1', 9_500)];
const at = { productId: 'p', at: '2030-06-01T00:00:00Z', storeId: 'S-A', channel: 'app', zoneId: 'Z-1' };

describe('D-19 channel pricing switches', () => {
  it('everything is off until an approved request turns it on; a pending one changes nothing', () => {
    expect(switchesOn([]).size).toBe(0);
    expect(resolvePrice(gatedEntries(ENTRIES, switchesOn([])), at)!.id).toBe('shelf');
    expect(resolvePrice(gatedEntries(ENTRIES, switchesOn([req('1', 'channel:app', 'on', 'pending', '2030-01-02')])), at)!.id).toBe('shelf');
    expect(resolvePrice(gatedEntries(ENTRIES, switchesOn([req('1', 'channel:app', 'on', 'applied', '2030-01-02')])), at)!.id).toBe('app');
    expect(resolvePrice(gatedEntries(ENTRIES, switchesOn([req('1', 'zone', 'on', 'applied', '2030-01-02')])), at)!.id).toBe('zone');
  });
  it('the latest applied request decides; off restores the shelf price', () => {
    const on = switchesOn([req('1', 'channel:app', 'on', 'applied', '2030-01-02'), req('2', 'channel:app', 'off', 'applied', '2030-01-03')]);
    expect(on.has('channel:app')).toBe(false);
    expect(switchOf('store', 'S-A')).toBeUndefined();
    expect(switchOf('customer', 'c-1')).toBeUndefined();
  });
});

describe('D-19 guardrail: no channel price is charged while its switch is off', () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  it('the price-list publish refuses a switched-off scope, with no override', () => {
    const src = strip(readFileSync('services/pricing/src/price-list.ts', 'utf8'));
    const at0 = src.indexOf('deps.channelPricingOn !== undefined');
    const block = src.slice(at0, src.indexOf('}', src.indexOf("code: 'channel_pricing_switched_off'")));
    expect(block).toContain("'channel_pricing_switched_off'");
    for (const bypass of ['override', 'force', 'b.approval', 'approvalId']) expect(block).not.toContain(bypass);
    expect(src).toContain('deps.allowedEntries === undefined ? stored : await deps.allowedEntries(ctx.tenantId, stored)');
  });
  it('switching on is applied only by an approval route that refuses the asker', () => {
    const src = strip(readFileSync('services/pricing/src/channel-pricing.ts', 'utf8'));
    expect(src).toContain("status: to === 'off' ? 'applied' : 'pending'");
    expect(src).toMatch(/requests\/:requestId\/approve',\s*permission: 'price\.change\.approve'/);
    expect(src).toContain("code: 'self_approval'");
  });
  it('the running system wires the gate into the price-list routes', () => {
    expect(readFileSync('services/api/src/main.ts', 'utf8')).toContain('...channelPricingGateFor({ store, now })');
  });
});
