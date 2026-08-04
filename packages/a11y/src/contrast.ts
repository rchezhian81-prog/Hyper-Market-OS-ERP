// WCAG 2.2 contrast — NFR-07, §10, design system ("contrast ≥ 4.5:1; usable at arm's length
// under fluorescent light by staff aged 50").
//
// One implementation, for the whole product. This used to live privately inside tenant branding,
// which meant the tenant-branding screen and every other surface could disagree about whether a
// colour pair was readable — and two answers to *"can a cashier read this"* is worse than one,
// because the disagreement is only ever discovered by the person who cannot read it.
//
// **Luminance is computed at full precision and rounded only at the very end.** The obvious move
// is to carry it in hundredths, matching the integer discipline this codebase uses for money
// (§29.1). It is the wrong move here and it was a real defect: relative luminance is a physical
// ratio in the range 0…1, not a currency, so rounding it to two decimal places throws away most
// of the resolution at the dark end where contrast maths is most sensitive.
//
// What that cost, before this module existed:
//
//     white on #777777    computed 4.57:1  →  PASSED AA
//                         actually  4.48:1  →  FAILS AA
//
// Mid-grey on white is one of the most common choices in any interface, so that is not an exotic
// edge — it is a body-text colour being published as accessible when it is not.
//
// Pure and deterministic: no I/O, no clock, no dependency.

/** Contrast expressed ×100, so 450 is 4.5:1 — integers at the boundary, floats never. */
export type ContrastHundredths = number;

/** WCAG 2.2 thresholds, ×100. Named, because "450" on its own means nothing in six months. */
export const WCAG = {
  /** 1.4.3 AA — body text and anything under 18pt / 14pt bold. */
  aaNormalText: 450,
  /** 1.4.3 AA — large text, 18pt+ or 14pt+ bold. */
  aaLargeText: 300,
  /** 1.4.11 AA — icons, borders, focus rings and anything that carries meaning without text. */
  aaNonText: 300,
  /** 1.4.6 AAA — where the design system asks for more than the minimum. */
  aaaNormalText: 700,
  aaaLargeText: 450,
} as const;

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Parse `#rgb` or `#rrggbb`. Returns undefined rather than guessing at a malformed value. */
export function parseHex(hex: string): Rgb | undefined {
  const value = hex.trim();
  const short = /^#([0-9a-f]{3})$/i.exec(value);
  if (short !== null) {
    const [r, g, b] = [...short[1]!].map((c) => parseInt(c + c, 16));
    return { r: r!, g: g!, b: b! };
  }
  const long = /^#([0-9a-f]{6})$/i.exec(value);
  if (long === null) return undefined;
  const n = parseInt(long[1]!, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/**
 * WCAG relative luminance, 0…1, at **full precision**.
 *
 * Deliberately not rounded. Every caller wants the ratio, and the ratio is what gets rounded —
 * rounding here instead is the defect described at the top of this file.
 */
export function relativeLuminance(hex: string): number | undefined {
  const rgb = parseHex(hex);
  if (rgb === undefined) return undefined;
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/**
 * Contrast ratio ×100 — 450 is 4.5:1.
 *
 * Rounded **down**, not to nearest. A pair that computes to 4.499:1 is not 4.5:1, and rounding
 * up at the threshold is precisely how a failing colour gets published: the whole point of the
 * number is the comparison against it.
 */
export function contrastRatio(a: string, b: string): ContrastHundredths | undefined {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === undefined || lb === undefined) return undefined;
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return Math.floor(((lighter + 0.05) / (darker + 0.05)) * 100);
}

export type TextSize = 'normal' | 'large' | 'non_text';

export interface ContrastCheck {
  readonly foreground: string;
  readonly background: string;
  readonly size: TextSize;
  readonly ratio?: ContrastHundredths;
  readonly required: ContrastHundredths;
  readonly passes: boolean;
  /** How far short, ×100. Zero when it passes — a shortfall is actionable, a boolean is not. */
  readonly shortfall: ContrastHundredths;
  readonly detail: string;
}

/**
 * Check one pair against the WCAG 2.2 AA threshold for its size.
 *
 * An unparseable colour **fails**. It is tempting to skip it as "not applicable", but a colour
 * the checker cannot read is a colour it cannot vouch for, and the surface will render something
 * regardless.
 */
export function checkContrast(input: {
  readonly foreground: string;
  readonly background: string;
  readonly size?: TextSize;
  /** Override for a surface the design system holds to AAA. */
  readonly required?: ContrastHundredths;
}): ContrastCheck {
  const size = input.size ?? 'normal';
  const required = input.required
    ?? (size === 'normal' ? WCAG.aaNormalText : size === 'large' ? WCAG.aaLargeText : WCAG.aaNonText);
  const ratio = contrastRatio(input.foreground, input.background);

  if (ratio === undefined) {
    return {
      foreground: input.foreground, background: input.background, size,
      required, passes: false, shortfall: required,
      detail: `"${input.foreground}" or "${input.background}" is not a colour this can read — an unreadable value cannot be vouched for, and the surface will render something anyway`,
    };
  }

  const passes = ratio >= required;
  return {
    foreground: input.foreground, background: input.background, size, ratio, required, passes,
    shortfall: passes ? 0 : required - ratio,
    detail: passes
      ? `${(ratio / 100).toFixed(2)}:1 against a ${(required / 100).toFixed(2)}:1 minimum`
      : `${(ratio / 100).toFixed(2)}:1 against a ${(required / 100).toFixed(2)}:1 minimum — short by ${((required - ratio) / 100).toFixed(2)}, which is a cashier squinting at a total under fluorescent light at 8pm`,
  };
}

export interface PalettePair {
  readonly name: string;
  readonly foreground: string;
  readonly background: string;
  readonly size?: TextSize;
}

export interface PaletteReport {
  readonly checks: readonly ContrastCheck[];
  readonly failures: readonly ContrastCheck[];
  readonly passes: boolean;
  /** The worst pair, named. A count of failures does not tell anybody what to change. */
  readonly worst?: ContrastCheck;
  readonly detail: string;
}

/** Check every pair a surface actually renders, and name the worst one. */
export function checkPalette(pairs: readonly PalettePair[]): PaletteReport {
  const checks = pairs.map((p) => ({
    ...checkContrast({ foreground: p.foreground, background: p.background, ...(p.size ? { size: p.size } : {}) }),
    name: p.name,
  }));
  const failures = checks.filter((c) => !c.passes);
  const worst = [...checks].sort((a, b) => (b.shortfall - a.shortfall) || ((a.ratio ?? 0) - (b.ratio ?? 0)))[0];

  return {
    checks,
    failures,
    passes: failures.length === 0,
    ...(worst ? { worst } : {}),
    detail: failures.length === 0
      ? `${checks.length} colour pairs all meet WCAG 2.2 AA`
      : `${failures.length} of ${checks.length} pairs fail WCAG 2.2 AA; the worst is ${worst?.detail}`,
  };
}
