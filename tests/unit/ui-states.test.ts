import { describe, it, expect } from 'vitest';
import { presentScreenState, SCREEN_STATES, type ScreenState } from '../../packages/ui/src/index';

// The canonical screen-state presenter (item 3 inc1): every state carries a word + an icon + an
// announcement (colour is never the only signal), and error/pending/recovery all pull for attention.

describe('presentScreenState', () => {
  it('gives each state a tone and a non-empty icon, with the caller supplying the words', () => {
    const face = (s: ScreenState) => presentScreenState({ state: s, label: `L-${s}` });
    expect(face('ready').tone).toBe('ok');
    expect(face('loading').tone).toBe('idle');
    expect(face('empty').tone).toBe('idle');
    expect(face('locked').tone).toBe('idle');   // terminal & deliberate — NOT an error
    expect(face('error').tone).toBe('error');
    expect(face('pending').tone).toBe('degraded');
    expect(face('recovery').tone).toBe('degraded');
    for (const s of SCREEN_STATES) {
      const p = face(s);
      expect(p.label).toBe(`L-${s}`);
      expect(p.icon.trim().length).toBeGreaterThan(0);
      expect(p.announcement.length).toBeGreaterThan(0);
    }
  });

  it('forces attention on error, pending and recovery — and not on the settled states', () => {
    const needs = (s: ScreenState) => presentScreenState({ state: s, label: 'x' }).needsAttention;
    expect([needs('error'), needs('pending'), needs('recovery')]).toEqual([true, true, true]);
    expect([needs('ready'), needs('loading'), needs('empty'), needs('locked')]).toEqual([false, false, false, false]);
  });

  it('uses a distinct announcement when given, and refuses a blank label (colour-only is impossible)', () => {
    expect(presentScreenState({ state: 'pending', label: 'Waiting', announcement: 'Waiting for the checker' }).announcement).toBe('Waiting for the checker');
    expect(() => presentScreenState({ state: 'error', label: '   ' })).toThrow();
  });

  it('the state set is the seven the directive names', () => {
    expect([...SCREEN_STATES].sort()).toEqual(['empty', 'error', 'loading', 'locked', 'pending', 'ready', 'recovery']);
  });
});
