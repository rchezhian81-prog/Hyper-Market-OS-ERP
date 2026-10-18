import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';
import { buildSurface } from '../../services/api/src/main';
import { refuseOutwardChange, evaluateGstr3bLock, foldGstr9 } from '../../packages/finance/src/index';
import { foldGstControls } from '../../services/finance/src/gst-controls';

/**
 * R3 lane 1 guardrails — every "no override exists" claim of the signed sentences, bound to the code:
 *
 *   A16  the GSTR-3B outward liability has NO change path: the only routes that write the GSTR-3B register are the lock
 *        (once, only after GSTR-1 is filed) and the amendment (into the NEXT month); the outward-liability route only
 *        ever refuses; the builder takes no override input; a lock is written once per month.
 *   A14  reverse charge is cash only: GSTR-3B's set-off of reverse-charge tax against ITC is the literal 0.
 *   OB-143 / OB-149 / A19  built switched off; only the owner switches reverse charge or the 30-day guard on, or sets N;
 *        only the CA lists reverse-charge heads.
 *   A15  ITC is never a silent zero: the stub port answers "not reconciled", and GSTR-9's year ITC is "not known".
 */

const read = (p: string): string => readFileSync(p, 'utf8');
const STORE = read('services/finance/src/gstr3b-store.ts');
const ENGINE = read('packages/finance/src/gstr3b.ts');
const ADAPTERS = read('services/api/src/r3-gst-adapters.ts');

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name === 'dist') continue;
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('A16 — the GSTR-3B outward liability cannot be edited', () => {
  it('the outward-liability route ONLY refuses — its handler throws on every path and records nothing', () => {
    const start = STORE.indexOf("path: '/v1/finance/gstr3b/:period/outward-liability'");
    expect(start).toBeGreaterThan(0);
    const handler = STORE.slice(start, STORE.indexOf('    },\n', start));
    expect(handler).toMatch(/refuseOutwardChange\(/);
    expect(handler).toMatch(/throw apiError\(409/);
    expect(handler).not.toMatch(/deps\.record/);
    expect(handler).not.toMatch(/return \{ status/);
    // The engine's answer is a refusal whatever the state.
    expect(refuseOutwardChange({ period: '052027' }).allowed).toBe(false);
  });

  it('only the lock and the amendment write the GSTR-3B register, and the lock is keyed once per month', () => {
    const writes = [...ADAPTERS.matchAll(/append\(store, t, GSTR3B, '(\w+)'/g)].map((m) => m[1]);
    expect(writes.sort()).toEqual(['Gstr1AmendmentRecorded', 'Gstr3bLocked']);
    expect(ADAPTERS).toMatch(/'Gstr3bLocked', `lock\|\$\{l\.period\}`/);
    // No other file writes the GSTR-3B register's event types.
    for (const f of [...filesUnder('services'), ...filesUnder('packages'), ...filesUnder('edge')]) {
      if (f.endsWith('r3-gst-adapters.ts')) continue;
      const src = read(f);
      expect(src.includes("'Gstr3bLocked'") || src.includes("'Gstr1AmendmentRecorded'"), f).toBe(false);
    }
    // The lock route records only after the engine allows it; the engine allows it only for a filed GSTR-1, once.
    const lock = STORE.slice(STORE.indexOf("path: '/v1/finance/gstr3b/:period/lock'"));
    expect(lock.indexOf('evaluateGstr3bLock(')).toBeLessThan(lock.indexOf('deps.recordLock('));
    expect(evaluateGstr3bLock({ gstr1State: 'approved' }).allowed).toBe(false);
  });

  it('the builder takes no override, adjustment or typed outward figure', () => {
    const inputStart = ENGINE.indexOf('export function buildGstr3b(input: {');
    const input = ENGINE.slice(inputStart, ENGINE.indexOf('}): Gstr3b {', inputStart));
    expect(input).not.toMatch(/override|adjust|manual|typed|outward\??:/i);
    expect(ENGINE).toMatch(/readonly editable: false;/);
  });

  it('no route on the surface sets a GSTR-3B figure other than the four this lane declares', () => {
    const routes = buildSurface({ signingKey: 'k'.repeat(48), boxHistorySealSecret: 's'.repeat(48), migrationTargetKind: 'rehearsal' })
      .filter((r) => r.path.startsWith('/v1/finance/gstr3b'));
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'GET /v1/finance/gstr3b/:period',
      'POST /v1/finance/gstr3b/:period/amendments/:amendmentId',
      'POST /v1/finance/gstr3b/:period/lock',
      'POST /v1/finance/gstr3b/:period/outward-liability',
    ]);
  });
});

describe('A14 — reverse-charge tax is paid in cash only', () => {
  it('the set-off against ITC is the literal 0 in type and value', () => {
    expect(ENGINE).toMatch(/readonly reverseChargeSetOffAgainstItcMinor: 0;/);
    expect(ENGINE).toMatch(/reverseChargeSetOffAgainstItcMinor: 0,/);
    expect(ENGINE).toMatch(/reverseChargePaidInCashMinor: taxOf\(rc\)/);
  });
});

describe('OB-143 / OB-149 / A19 — built switched off; the owner switches; the CA lists heads', () => {
  const holders = (perm: string): string[] => ROLE_CATALOGUE.filter((r) => r.permissions.includes(perm)).map((r) => r.id).sort();

  it('everything starts off / unset / empty', () => {
    const c = foldGstControls([], []);
    expect(c.reverseCharge.value).toBe(false);
    expect(c.einvoice30DayGuard.value).toBe(false);
    expect(c.timeBarWarningDays.value).toBeNull();
    expect(c.rcmHeads).toEqual([]);
  });

  it('only the owner holds the switches and N; only the chartered accountant lists heads', () => {
    expect(holders('finance.rcm.switch')).toEqual(['owner']);
    expect(holders('finance.einvoice.guard.switch')).toEqual(['owner']);
    expect(holders('finance.gst.timebar.set')).toEqual(['owner']);
    expect(holders('finance.rcm.configure')).toEqual(['chartered_accountant']);
  });

  it('the controls are written only by the controls routes', () => {
    for (const f of [...filesUnder('services'), ...filesUnder('packages')]) {
      if (f.endsWith('r3-gst-adapters.ts')) continue;
      expect(read(f).includes("'GstControlChanged'"), f).toBe(false);
    }
  });
});

describe('A15 / A18 — ITC is never a silent zero', () => {
  it('the stand-in port answers "not reconciled", and a year with such a month has ITC "not known"', () => {
    expect(read('packages/finance/src/itc-port.ts')).toMatch(/status: 'not_reconciled'/);
    expect(ADAPTERS).toMatch(/input\.itc \?\? ITC_NOT_YET_RECONCILED/);
    expect(foldGstr9({ fy: '2027-28', months: [] }).table6Itc.allOther.status).toBe('not_known');
  });
});
