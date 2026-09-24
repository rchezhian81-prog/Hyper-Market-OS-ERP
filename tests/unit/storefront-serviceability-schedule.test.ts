import { describe, it, expect } from 'vitest';
import {
  resolveServiceabilityPolicy,
  DEFAULT_SERVICEABILITY_POLICY,
  InvalidServiceabilitySchedule,
  type ServiceabilityPeriod,
} from '../../packages/storefront/src/index';

// M18-FR-01 / D08 — the serviceability policy in force ON A DATE, from a per-tenant effective-dated
// schedule (radius / fee / free-threshold / minimum). Mirrors resolveGstRate's boundary rule. The D08
// default (10 km) applies until the owner configures real radii, so the store ships serviceable before
// he has settled his production numbers; a malformed period is a visible error, never a silent default.

const period = (effectiveFrom: string, over: Partial<ServiceabilityPeriod['policy']> = {}): ServiceabilityPeriod =>
  ({ effectiveFrom, policy: { radiusMetres: 8_000, deliveryFeeMinor: 3_000, ...over } });

describe('resolveServiceabilityPolicy — effective-dated serviceability (M18-FR-01, D08)', () => {
  it('with no schedule, the D08 default (10 km) applies — shippable before real radii are set', () => {
    const r = resolveServiceabilityPolicy({ schedule: [], on: '2026-09-24' });
    expect(r).toMatchObject({ source: 'default', effectiveFrom: null });
    expect(r.policy).toEqual(DEFAULT_SERVICEABILITY_POLICY);
    expect(r.policy.radiusMetres).toBe(10_000);
  });

  it('a date before the earliest period falls back to the default', () => {
    const r = resolveServiceabilityPolicy({ schedule: [period('2026-10-01')], on: '2026-09-30' });
    expect(r.source).toBe('default');
  });

  it('picks the period in force, and switches on the effective-from day (boundary)', () => {
    const schedule = [period('2026-07-01', { radiusMetres: 8_000 }), period('2026-10-01', { radiusMetres: 12_000 })];
    // the day before the new period → old radius
    expect(resolveServiceabilityPolicy({ schedule, on: '2026-09-30' }).policy.radiusMetres).toBe(8_000);
    // on the effective-from day → new radius
    const onDay = resolveServiceabilityPolicy({ schedule, on: '2026-10-01' });
    expect(onDay).toMatchObject({ source: 'scheduled', effectiveFrom: '2026-10-01' });
    expect(onDay.policy.radiusMetres).toBe(12_000);
    // well after → still the latest
    expect(resolveServiceabilityPolicy({ schedule, on: '2027-01-01' }).policy.radiusMetres).toBe(12_000);
  });

  it('resolves regardless of the order periods are supplied in', () => {
    const schedule = [period('2026-10-01', { radiusMetres: 12_000 }), period('2026-07-01', { radiusMetres: 8_000 })];
    expect(resolveServiceabilityPolicy({ schedule, on: '2026-08-15' }).policy.radiusMetres).toBe(8_000);
  });

  it('throws on a malformed period — a bad date', () => {
    expect(() => resolveServiceabilityPolicy({ schedule: [period('2026-13-40')], on: '2026-09-24' })).toThrow(InvalidServiceabilitySchedule);
  });

  it('throws on a negative or non-whole policy field', () => {
    expect(() => resolveServiceabilityPolicy({ schedule: [period('2026-07-01', { radiusMetres: -1 })], on: '2026-09-24' })).toThrow(InvalidServiceabilitySchedule);
    expect(() => resolveServiceabilityPolicy({ schedule: [period('2026-07-01', { deliveryFeeMinor: 12.5 })], on: '2026-09-24' })).toThrow(InvalidServiceabilitySchedule);
  });

  it('throws on two periods sharing an effective date (ambiguous)', () => {
    expect(() => resolveServiceabilityPolicy({ schedule: [period('2026-07-01'), period('2026-07-01', { radiusMetres: 9_000 })], on: '2026-09-24' }))
      .toThrow(InvalidServiceabilitySchedule);
  });

  it('throws on an invalid date to resolve on', () => {
    expect(() => resolveServiceabilityPolicy({ schedule: [period('2026-07-01')], on: 'today' })).toThrow(InvalidServiceabilitySchedule);
  });

  it('the default policy is frozen — a caller cannot mutate the shared default', () => {
    expect(Object.isFrozen(DEFAULT_SERVICEABILITY_POLICY)).toBe(true);
  });
});
