import { describe, it, expect } from 'vitest';
import { minLabelHeightMm, validateLabelHeight, InvalidLabelHeightInput } from '../../packages/product/src/label-height';

// Roadmap v2.1 B24 — statutory label character heights (Legal Metrology Rule 9). The minimum height of
// a declaration rises by band with the principal-display-panel area; a self-printed template shorter
// than the minimum is a non-compliant label and fails validation.

describe('minLabelHeightMm — B24 / Rule 9 bands', () => {
  it('rises by band with the panel area, at the band edges', () => {
    expect(minLabelHeightMm(50)).toBe(1);     // ≤ 100
    expect(minLabelHeightMm(100)).toBe(1);    // edge, inclusive
    expect(minLabelHeightMm(101)).toBe(2);
    expect(minLabelHeightMm(500)).toBe(2);    // edge
    expect(minLabelHeightMm(501)).toBe(4);
    expect(minLabelHeightMm(2500)).toBe(4);   // edge
    expect(minLabelHeightMm(2501)).toBe(6);   // open-ended top band
    expect(minLabelHeightMm(10000)).toBe(6);
  });

  it('refuses a non-positive area', () => {
    expect(() => minLabelHeightMm(0)).toThrow(InvalidLabelHeightInput);
    expect(() => minLabelHeightMm(-5)).toThrow(InvalidLabelHeightInput);
  });
});

describe('validateLabelHeight — B24: a too-small height fails', () => {
  it('passes a height at or above the minimum, fails one below it', () => {
    // 300 cm² panel → 2 mm minimum.
    expect(validateLabelHeight({ principalPanelAreaCm2: 300, declaredHeightMm: 2 }).valid).toBe(true);
    expect(validateLabelHeight({ principalPanelAreaCm2: 300, declaredHeightMm: 2.5 }).valid).toBe(true);
    const bad = validateLabelHeight({ principalPanelAreaCm2: 300, declaredHeightMm: 1.5 });
    expect(bad.valid).toBe(false);
    expect(bad.minHeightMm).toBe(2);
    expect(bad.detail).toContain('non-compliant');
  });

  it('refuses a non-positive declared height', () => {
    expect(() => validateLabelHeight({ principalPanelAreaCm2: 300, declaredHeightMm: 0 })).toThrow(InvalidLabelHeightInput);
  });
});
