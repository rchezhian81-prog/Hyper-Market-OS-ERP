import { describe, it, expect } from 'vitest';
import { checkPackDeclarations, type PackDeclarations } from '../../packages/product/src/pack-declarations';

// Roadmap v2.1 B4 — statutory pre-packed-commodity declarations (Legal Metrology Rule 6). Four
// declarations gate whether a pack may be activated for sale; a gap blocks activation.

const COMPLETE: PackDeclarations = {
  netQuantity: '500 g',
  manufactureOrPackDate: '2026-07',
  consumerCareContact: 'SRE Hyper Market, care@sre.example, 044-12345678',
  countryOfOrigin: 'India',
};

describe('checkPackDeclarations — B4 / Rule 6', () => {
  it('marks a fully-declared pack sellable', () => {
    const r = checkPackDeclarations(COMPLETE);
    expect(r.sellable).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it('accepts a full date as well as month-and-year', () => {
    expect(checkPackDeclarations({ ...COMPLETE, manufactureOrPackDate: '2026-07-15' }).sellable).toBe(true);
  });

  it('blocks activation, naming the field, when any mandatory declaration is missing', () => {
    const fields = ['netQuantity', 'manufactureOrPackDate', 'consumerCareContact', 'countryOfOrigin'] as const;
    for (const f of fields) {
      const without = { ...COMPLETE };
      delete (without as Record<string, unknown>)[f];
      const r = checkPackDeclarations(without);
      expect(r.sellable, `missing ${f}`).toBe(false);
      expect(r.missing.some((m) => m.startsWith(f)), `names ${f}: ${r.missing.join('; ')}`).toBe(true);
    }
  });

  it('treats a blank string as missing, and a malformed date as malformed', () => {
    expect(checkPackDeclarations({ ...COMPLETE, netQuantity: '   ' }).sellable).toBe(false);
    const bad = checkPackDeclarations({ ...COMPLETE, manufactureOrPackDate: 'July 2026' });
    expect(bad.sellable).toBe(false);
    expect(bad.missing.some((m) => m.startsWith('manufactureOrPackDate'))).toBe(true);
  });
});
