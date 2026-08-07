import { describe, it, expect } from 'vitest';
import {
  parseHex, relativeLuminance, contrastRatio, checkContrast, checkPalette, WCAG,
} from '../../packages/a11y/src/contrast';
import { contrastRatioHundredths } from '../../packages/platform/src/branding';

// NFR-07 — WCAG 2.2 AA. The maths, and the defect it was written to fix.

describe('the precision defect this module exists to fix', () => {
  it('FAILS white on #777777, which the old rounding passed', () => {
    // The shipped implementation carried luminance in hundredths, matching this codebase's
    // integer discipline for money (§29.1). Luminance is not money — it is a physical ratio in
    // 0…1, and two decimal places throws away most of the resolution where contrast is most
    // sensitive. White on mid-grey came out at 4.57:1 and PASSED against a true 4.48:1.
    const r = contrastRatio('#FFFFFF', '#777777')!;
    expect(r).toBe(447);
    expect(checkContrast({ foreground: '#FFFFFF', background: '#777777' }).passes).toBe(false);
  });

  it('still PASSES #767676, one step lighter — the fix discriminates, it does not just lower everything', () => {
    expect(checkContrast({ foreground: '#FFFFFF', background: '#767676' }).passes).toBe(true);
    expect(contrastRatio('#FFFFFF', '#767676')!).toBe(454);
  });

  it('is accurate at the dark end, where the old rounding was worst', () => {
    // #111111 on white: the old code said 17.50:1, the truth is 18.88:1 — 7% out.
    expect(contrastRatio('#FFFFFF', '#111111')!).toBe(1_888);
    // #0A0A0A on white: the old code said 21.00:1 — above the theoretical maximum for that pair.
    expect(contrastRatio('#FFFFFF', '#0A0A0A')!).toBe(1_979);
  });

  it('never exceeds the theoretical maximum of 21:1', () => {
    expect(contrastRatio('#000000', '#FFFFFF')!).toBe(2_100);
    for (const hex of ['#010101', '#0A0A0A', '#111111', '#050505']) {
      expect(contrastRatio('#FFFFFF', hex)!, hex).toBeLessThanOrEqual(2_100);
    }
  });

  it('rounds DOWN at the threshold, because the number exists to be compared against it', () => {
    // A pair at 4.499:1 is not 4.5:1. Rounding to nearest at the boundary is exactly how a
    // failing colour gets published with a green tick beside it.
    const check = checkContrast({ foreground: '#FFFFFF', background: '#777777' });
    expect(check.ratio).toBeLessThan(WCAG.aaNormalText);
    expect(check.shortfall).toBe(WCAG.aaNormalText - 447);
  });

  it('gives the same answer as the tenant-branding screen — one implementation, not two', () => {
    // Two answers to "can a cashier read this" is worse than one, because the disagreement is
    // only ever discovered by the person who cannot read it.
    for (const [a, b] of [['#FFFFFF', '#777777'], ['#000000', '#595959'], ['#1A1A1A', '#8A8A8A']]) {
      expect(contrastRatioHundredths(a!, b!)).toBe(contrastRatio(a!, b!));
    }
  });
});

describe('the maths itself', () => {
  it('parses both #rgb and #rrggbb', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex('#FFFFFF')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex('  #1a2b3c  ')).toEqual({ r: 26, g: 43, b: 60 });
  });

  it('refuses a value it cannot read rather than guessing', () => {
    for (const bad of ['fff', '#ffff', 'rgb(255,255,255)', 'white', '', '#gggggg']) {
      expect(parseHex(bad), bad).toBeUndefined();
      expect(contrastRatio('#FFFFFF', bad), bad).toBeUndefined();
    }
  });

  it('puts the WCAG reference points where the standard puts them', () => {
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 6);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 6);
    // Green carries most of the perceived luminance; blue almost none.
    expect(relativeLuminance('#00FF00')!).toBeGreaterThan(relativeLuminance('#FF0000')!);
    expect(relativeLuminance('#FF0000')!).toBeGreaterThan(relativeLuminance('#0000FF')!);
  });

  it('is symmetrical — order of arguments cannot change readability', () => {
    expect(contrastRatio('#FFFFFF', '#333333')).toBe(contrastRatio('#333333', '#FFFFFF'));
  });
});

describe('an unreadable colour FAILS rather than being skipped', () => {
  it('does not treat "cannot parse" as "not applicable"', () => {
    const check = checkContrast({ foreground: '#FFFFFF', background: 'var(--brand)' });
    expect(check.passes).toBe(false);
    expect(check.shortfall).toBe(WCAG.aaNormalText);
    expect(check.detail).toContain('the surface will render something anyway');
  });
});

describe('thresholds are per text size, and named', () => {
  it('holds large text to 3:1 and body text to 4.5:1', () => {
    const grey = { foreground: '#FFFFFF', background: '#949494' };
    expect(checkContrast({ ...grey, size: 'normal' }).passes).toBe(false);
    expect(checkContrast({ ...grey, size: 'large' }).passes).toBe(true);
  });

  it('holds icons and focus rings to 3:1 (1.4.11), not to nothing', () => {
    const check = checkContrast({ foreground: '#FFFFFF', background: '#B0B0B0', size: 'non_text' });
    expect(check.required).toBe(WCAG.aaNonText);
    expect(check.passes).toBe(false);
  });

  it('allows a surface to be held to AAA where the design system asks', () => {
    const check = checkContrast({ foreground: '#FFFFFF', background: '#767676', required: WCAG.aaaNormalText });
    expect(check.passes).toBe(false);
    expect(check.detail).toContain('7.00:1 minimum');
  });
});

describe('a palette report names the WORST pair, not a count', () => {
  const palette = [
    { name: 'body on surface', foreground: '#1A1A1A', background: '#FFFFFF' },
    { name: 'total on surface', foreground: '#111111', background: '#FFFFFF' },
    { name: 'hint on surface', foreground: '#777777', background: '#FFFFFF' },
    { name: 'offline badge', foreground: '#FFFFFF', background: '#8A5A00' },
  ];

  it('passes a palette where every rendered pair meets AA', () => {
    const r = checkPalette(palette.filter((p) => p.name !== 'hint on surface'));
    expect(r.passes).toBe(true);
    expect(r.detail).toContain('meet WCAG 2.2 AA');
  });

  it('catches the classic amber badge — white on a mid amber is 3.92:1 and fails', () => {
    // Worth its own case because it is the mistake every product makes: amber reads as a
    // "warning" colour, so white text goes on it without anybody checking, and the badge that
    // tells a cashier the till is offline is the one nobody can read.
    expect(checkContrast({ foreground: '#FFFFFF', background: '#B0740A' }).passes).toBe(false);
    // Darkening the amber fixes it; so does black text, and the design system should pick one
    // deliberately rather than discover it at the lane.
    expect(checkContrast({ foreground: '#FFFFFF', background: '#8A5A00' }).passes).toBe(true);
    expect(checkContrast({ foreground: '#000000', background: '#B0740A' }).passes).toBe(true);
  });

  it('names the worst pair so somebody knows what to change', () => {
    const r = checkPalette(palette);
    expect(r.passes).toBe(false);
    expect(r.failures).toHaveLength(1);
    // A count of failures does not tell anybody which colour to change.
    expect(r.worst?.foreground).toBe('#777777');
    expect(r.detail).toContain('the worst is');
    expect(r.detail).toContain('8pm');
  });
});
