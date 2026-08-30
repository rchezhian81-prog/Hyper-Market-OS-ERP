import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  FLEET_COPY, FLEET_VERDICTS,
  createFleetSession, type FleetDeviceRow, type FleetPorts,
} from '../../apps/web-erp/src/fleet-session';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * **The device fleet manager is usable, bilingual, and triages by exception (M33-FR-02/04 · A-10 · P-03 · P-08).**
 *
 * The store is in Tamil Nadu and the roadmap mandates both languages, so the tripwire binds to the session's
 * single `BilingualCopy` via the shared `packages/ui` check: every verdict a device can carry must read as a
 * word in BOTH languages, never as a bare colour. It also holds the screen to the same rules the other
 * screens carry — no browser dialogs, defers to the session, and (this being the READ increment) records
 * nothing — and pins the two things this screen exists to do:
 *   • a machine that cannot trade, or must update before it can, reads as ATTENTION with the error tone;
 *   • a machine that has gone QUIET reads as ATTENTION too (P-08: silence is a warning, not health),
 *     even when its version verdict is otherwise fine.
 */

const row = (over: Partial<FleetDeviceRow>): FleetDeviceRow => ({
  deviceId: 'till-01', label: 'Till 1', kind: 'till', branchId: 'main', status: 'active',
  appVersion: '2.1.0', lastSeenAt: '2026-08-29 09:20', verdict: 'ok',
  mayTrade: true, mustUpgrade: false, detail: '', silent: false, ...over,
});

const portsOf = (rows: readonly FleetDeviceRow[], perms?: { read?: boolean; manage?: boolean }): FleetPorts => ({
  fleet: () => ({
    summary: { total: rows.length, trading: 0, blocked: 0, mustUpgrade: 0, silent: 0, byVersion: {} },
    devices: rows,
  }),
  mayRead: () => perms?.read ?? true,
  mayManage: () => perms?.manage ?? false,
});

const first = (r: FleetDeviceRow, lang: 'en' | 'ta' = 'en') =>
  createFleetSession({ userId: 'u' }, portsOf([r])).view(lang).devices[0];

describe('the fleet copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(FLEET_COPY);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('gives EVERY verdict a device can show a real word in both languages — never a bare colour', () => {
    for (const verdict of FLEET_VERDICTS) {
      const en = first(row({ verdict, silent: false }), 'en');
      const ta = first(row({ verdict, silent: false }), 'ta');
      expect(en?.status.label.trim(), `${verdict} has no English word`).not.toBe('');
      expect(ta?.status.label.trim(), `${verdict} has no Tamil word`).not.toBe('');
      // Not merely the English echoed back — the two languages actually differ.
      expect(ta?.status.label, `${verdict} is not translated`).not.toBe(en?.status.label);
    }
  });

  it('tripwire — the detector fires on a key that is genuinely absent', () => {
    const holey = { en: { ...FLEET_COPY.en }, ta: { ...FLEET_COPY.ta, vBlocked: '' } };
    expect(bilingualGaps(holey).ta).toContain('vBlocked');
  });
});

describe('a machine that needs a look is never shown as an ordinary line (P-03 · P-08)', () => {
  it('cannot-trade and must-update both read as attention with the error tone', () => {
    const cannotTrade = first(row({ verdict: 'blocked', mayTrade: false }));
    expect(cannotTrade?.needsAttention).toBe(true);
    expect(cannotTrade?.status.tone).toBe('error');

    const mustUpdate = first(row({ verdict: 'upgrade_required', mayTrade: false, mustUpgrade: true }));
    expect(mustUpdate?.needsAttention).toBe(true);
    expect(mustUpdate?.status.tone).toBe('error');
  });

  it('a device that has gone quiet reads as attention even when its version is fine (silence is a warning)', () => {
    const silent = first(row({ verdict: 'ok', mayTrade: true, mustUpgrade: false, silent: true }));
    expect(silent?.needsAttention).toBe(true);
    expect(silent?.status.tone).toBe('degraded');
    expect(silent?.silent).toBe(true);

    const fine = first(row({ verdict: 'ok', mayTrade: true, mustUpgrade: false, silent: false }));
    expect(fine?.needsAttention).toBe(false);
    expect(fine?.status.tone).toBe('ok');
  });

  it('the ones that need a look come first, so a big estate is triaged not scrolled', () => {
    const view = createFleetSession({ userId: 'u' }, portsOf([
      row({ deviceId: 'a', verdict: 'ok' }),
      row({ deviceId: 'b', verdict: 'blocked', mayTrade: false }),
    ])).view('en');
    expect(view.devices[0]?.deviceId).toBe('b');
    expect(view.devices[0]?.needsAttention).toBe(true);
  });

  it('a reader without permission is refused, not shown an empty-but-healthy fleet', () => {
    const view = createFleetSession({ userId: 'u' }, portsOf([row({})], { read: false })).view('en');
    expect(view.screenState.tone).toBe('error');
    expect(view.devices).toEqual([]);
  });
});

describe('the fleet view defers to the model and uses no browser dialogs', () => {
  const VIEW = readFileSync('apps/web-erp/web/fleet.js', 'utf8');

  it('never calls alert / confirm / prompt', () => {
    expect(/\b(alert|confirm|prompt)\s*\(/.test(VIEW)).toBe(false);
  });

  it('renders from the bundled session rather than re-deciding health', () => {
    expect(VIEW).toMatch(/window\.fleetSession/);
    expect(VIEW).toMatch(/session\.view\(/);
  });

  it('records nothing — a read-only fleet view has no write action (no fetch/XHR/outbox)', () => {
    expect(/\bfetch\s*\(/.test(VIEW), 'a read-only screen must not call the network').toBe(false);
    expect(/XMLHttpRequest/.test(VIEW)).toBe(false);
    expect(/\.enqueue\s*\(/.test(VIEW), 'a read-only screen registers no device').toBe(false);
  });

  it('the shell loads the shared bundle, carries the data marker, and offers a language toggle', () => {
    const HTML = readFileSync('apps/web-erp/web/fleet.html', 'utf8');
    expect(HTML).toMatch(/web-erp\.bundle\.js/);
    expect(HTML).toContain('<!--SCREEN-DATA-->');
    expect(HTML).toMatch(/id="lang"[^>]*aria-label=/);
    expect(HTML).toMatch(/id="rows"[^>]*aria-label=/);
  });

  it('every rendered status carries a screen-reader announcement and an aria-hidden icon', () => {
    expect(VIEW).toMatch(/status\.setAttribute\('aria-label'/);
    expect(VIEW).toMatch(/icon\.setAttribute\('aria-hidden', 'true'\)/);
  });
});
