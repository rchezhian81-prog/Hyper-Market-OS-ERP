import { describe, it, expect } from 'vitest';
import {
  createIntegrationHealthSession, INTEGRATION_HEALTH_COPY, COPY_KEYS,
  type AdapterHealthView, type IntegrationHealthData, type AdapterHealthState,
} from '../../apps/web-erp/src/integration-health-session';
import { bilingualGaps } from '../../packages/ui/src/index';

// The integration-health desk (M32-FR-04 · API-11 · P-03 · P-08 · hard rule #1) is READ-ONLY: it shows which of
// the shop's outside connections (Tally, GST, payment, WhatsApp) have gone quiet, judged by when each LAST
// WORKED, and reassures that the till never stops. These are unit tests on the tested session model — the DOM
// and the fetch are proven separately (slice 2 guardrail, slice 3 browser e2e).

const adapter = (over: Partial<AdapterHealthView> & { state: AdapterHealthState }): AdapterHealthView => ({
  adapterId: `ad-${over.state}`, category: 'accounting', minutesSinceLastSuccess: 5, consecutiveFailures: 0,
  shopKeepsTrading: true, detail: `${over.state} detail`, ...over,
});

const data = (adapters: readonly AdapterHealthView[], over: Partial<IntegrationHealthData> = {}): IntegrationHealthData =>
  ({ adapters, posUnaffected: true, asAt: '2026-09-22T10:00:00Z', ...over });

const session = (d: IntegrationHealthData, mayRead = true, userId: string | null = 'u-admin') =>
  createIntegrationHealthSession({ userId }, { health: () => d, mayRead: () => mayRead });

describe('the integration-health screen is offered in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(INTEGRATION_HEALTH_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key genuinely absent', () => {
    const holey = { en: { ...INTEGRATION_HEALTH_COPY.en }, ta: { ...INTEGRATION_HEALTH_COPY.ta, title: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('title');
  });
});

describe('worst-first: the connection that died quietly leads', () => {
  it('orders silent → failing → degraded, and never relies on the feed order', () => {
    // Fed deliberately best-first; the screen must re-order to worst-first.
    const view = session(data([
      adapter({ state: 'healthy' }),
      adapter({ state: 'degraded' }),
      adapter({ state: 'failing' }),
      adapter({ state: 'silent', minutesSinceLastSuccess: 'never' }),
    ])).view('en');
    expect(view.attention.map((a) => a.state)).toEqual(['silent', 'failing', 'degraded']);
  });

  it('partitions attention (silent/failing/degraded) from calm (healthy/disabled)', () => {
    const view = session(data([
      adapter({ state: 'healthy', adapterId: 'ad-h' }),
      adapter({ state: 'disabled', adapterId: 'ad-x' }),
      adapter({ state: 'silent', adapterId: 'ad-s', minutesSinceLastSuccess: 'never' }),
    ])).view('en');
    expect(view.attention.map((a) => a.adapterId)).toEqual(['ad-s']);
    expect(view.calm.map((a) => a.state).sort()).toEqual(['disabled', 'healthy']);
    expect(view.attentionCount).toBe(1);
    expect(view.anyException).toBe(true);
  });
});

describe('every state reads as a state, never colour alone', () => {
  const toneOf = (state: AdapterHealthState) => {
    const all = [...session(data([adapter({ state })])).view('en').attention,
                 ...session(data([adapter({ state })])).view('en').calm];
    return all[0]!.status;
  };

  it('silent and failing are error, degraded is a watch, healthy/disabled are calm — each with an icon AND a word', () => {
    for (const [state, tone] of [['silent', 'error'], ['failing', 'error'], ['degraded', 'degraded'], ['healthy', 'ok'], ['disabled', 'idle']] as const) {
      const s = toneOf(state);
      expect(s.tone, `${state} tone`).toBe(tone);
      expect(s.icon.trim().length, `${state} icon`).toBeGreaterThan(0);
      expect(s.label.length, `${state} word`).toBeGreaterThan(0);
    }
  });

  it('a silent adapter carries needsAttention and an announcement for a screen reader', () => {
    const a = session(data([adapter({ state: 'silent', minutesSinceLastSuccess: 'never' })])).view('en').attention[0]!;
    expect(a.status.needsAttention).toBe(true);
    expect((a.status.announcement ?? '').length).toBeGreaterThan(0);
  });
});

describe('the till is never stopped by an integration failure (hard rule #1)', () => {
  it('surfaces posUnaffected even when a connection has gone silent', () => {
    const view = session(data([adapter({ state: 'silent', minutesSinceLastSuccess: 'never' })], { posUnaffected: true })).view('en');
    expect(view.posUnaffected).toBe(true);        // a red row is a queue to clear, not a shop that cannot sell
    expect(view.anyException).toBe(true);
  });
});

describe('the last-worked figure is formatted for a person', () => {
  it('reads "never worked" when it never has, and "<n> min ago" otherwise', () => {
    expect(session(data([adapter({ state: 'silent', minutesSinceLastSuccess: 'never' })])).view('en').attention[0]!.lastWorked)
      .toBe('never worked');
    expect(session(data([adapter({ state: 'degraded', minutesSinceLastSuccess: 42 })])).view('en').attention[0]!.lastWorked)
      .toBe('42 min ago');
  });

  it('translates the never-worked label into Tamil', () => {
    const ta = session(data([adapter({ state: 'silent', minutesSinceLastSuccess: 'never' })])).view('ta').attention[0]!;
    expect(ta.lastWorked).toBe(INTEGRATION_HEALTH_COPY.ta.neverWorked);
  });
});

describe('permission and empty states', () => {
  it('a reader without platform.health.read sees a not-permitted state and nothing else', () => {
    const view = session(data([adapter({ state: 'silent' })]), false).view('en');
    expect(view.screenState.tone).toBe('error');
    expect(view.attention).toEqual([]);
    expect(view.calm).toEqual([]);
    expect(view.anyException).toBe(false);
  });

  it('all-clear (every connection working) is a calm ready state with no exception', () => {
    const view = session(data([adapter({ state: 'healthy' }), adapter({ state: 'disabled' })])).view('en');
    expect(view.anyException).toBe(false);
    expect(view.attentionCount).toBe(0);
    expect(view.screenState.tone).not.toBe('error');
  });

  it('no connections configured is a calm empty state, not an error', () => {
    const view = session(data([])).view('en');
    expect(view.attention).toEqual([]);
    expect(view.calm).toEqual([]);
    expect(view.screenState.tone).not.toBe('error');
  });

  it('flags when the store computer did not say who is looking', () => {
    expect(session(data([adapter({ state: 'healthy' })]), true, null).view('en').nobodyNamed).toBe(true);
    expect(session(data([adapter({ state: 'healthy' })]), true, 'u-admin').view('en').nobodyNamed).toBe(false);
  });
});
