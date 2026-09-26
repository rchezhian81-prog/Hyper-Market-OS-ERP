// Step-up re-authentication — pure decision (SEC-03 / GAP-SEC-06). Proves the freshness/strength rule
// in isolation: presence of a re-auth, then the required factor, then the freshness window, each
// refused with its own reason. Also proves the router refuses to register a step-up route with a
// non-positive window (a control that could never be satisfied fails at startup, not at 9pm Friday).

import { describe, it, expect } from 'vitest';
import { evaluateStepUp, type ReauthRequirement } from '../../services/kernel/src/step-up';
import { buildRouter, type Route } from '../../services/kernel/src/index';

const NOW_SEC = 1_700_000_000;
const NOW_MS = NOW_SEC * 1000;
const MFA: ReauthRequirement = { withinSeconds: 300, amr: ['mfa'] };

describe('evaluateStepUp — presence, factor, freshness', () => {
  it('accepts a fresh, MFA-backed sign-in', () => {
    expect(evaluateStepUp(MFA, { authTime: NOW_SEC - 10, amr: ['pwd', 'mfa'] }, NOW_MS)).toEqual({ ok: true });
  });

  it('refuses when there is NO re-auth evidence at all', () => {
    const d = evaluateStepUp(MFA, { amr: ['pwd', 'mfa'] }, NOW_MS);
    expect(d.ok).toBe(false);
    expect(d.shortfall).toBe('no_reauth_evidence');
  });

  it('refuses when the required factor (mfa) is absent — single-factor is not enough', () => {
    const d = evaluateStepUp(MFA, { authTime: NOW_SEC - 10, amr: ['pwd'] }, NOW_MS);
    expect(d.ok).toBe(false);
    expect(d.shortfall).toBe('reauth_factor_insufficient');
  });

  it('refuses when amr is entirely absent but a factor is required', () => {
    const d = evaluateStepUp(MFA, { authTime: NOW_SEC - 10 }, NOW_MS);
    expect(d.ok).toBe(false);
    expect(d.shortfall).toBe('reauth_factor_insufficient');
  });

  it('refuses when the re-auth is too old, even with the right factor', () => {
    const d = evaluateStepUp(MFA, { authTime: NOW_SEC - 100_000, amr: ['pwd', 'mfa'] }, NOW_MS);
    expect(d.ok).toBe(false);
    expect(d.shortfall).toBe('reauth_expired');
  });

  it('is a boundary at exactly the window: == window passes, +1 fails', () => {
    expect(evaluateStepUp(MFA, { authTime: NOW_SEC - 300, amr: ['mfa'] }, NOW_MS).ok).toBe(true);
    expect(evaluateStepUp(MFA, { authTime: NOW_SEC - 301, amr: ['mfa'] }, NOW_MS).shortfall).toBe('reauth_expired');
  });

  it('treats a future auth_time (clock skew) as fresh, never an error', () => {
    expect(evaluateStepUp(MFA, { authTime: NOW_SEC + 60, amr: ['mfa'] }, NOW_MS).ok).toBe(true);
  });

  it('with no factor requirement, checks freshness only', () => {
    const freshnessOnly: ReauthRequirement = { withinSeconds: 300 };
    expect(evaluateStepUp(freshnessOnly, { authTime: NOW_SEC - 10 }, NOW_MS).ok).toBe(true);
    expect(evaluateStepUp(freshnessOnly, { authTime: NOW_SEC - 999 }, NOW_MS).shortfall).toBe('reauth_expired');
    expect(evaluateStepUp(freshnessOnly, {}, NOW_MS).shortfall).toBe('no_reauth_evidence');
  });
});

describe('router registration — a step-up window must be positive', () => {
  const base: Omit<Route, 'reauth'> = {
    api: 'API-01', method: 'POST', path: '/v1/things/:id',
    permission: 'identity.role.grant', idempotent: true,
    handler: () => ({ status: 200, body: {} }),
  };

  it('refuses a route whose step-up window is zero or negative', () => {
    const zero = buildRouter([{ ...base, reauth: { withinSeconds: 0 } }]);
    expect(zero.ok).toBe(false);
    expect(zero.refusals[0]?.refusedBecause).toBe('step_up_window_not_positive');
  });

  it('accepts a route with a positive step-up window', () => {
    const ok = buildRouter([{ ...base, reauth: { withinSeconds: 300, amr: ['mfa'] } }]);
    expect(ok.ok).toBe(true);
  });
});
