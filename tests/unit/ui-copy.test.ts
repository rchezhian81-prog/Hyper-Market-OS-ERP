import { describe, it, expect } from 'vitest';
import { translator, bilingualGaps, isBilingualComplete, LANGUAGES, type BilingualCopy } from '../../packages/ui/src/index';

// The shared bilingual-copy primitive (item 3 inc1): resolve in a language with an English fallback, and the
// reusable "speaks both languages" completeness check that replaces each screen's bespoke regex.

type K = 'submit' | 'approve';
const COPY: BilingualCopy<K> = {
  en: { submit: 'Submit', approve: 'Approve' },
  ta: { submit: 'சமர்ப்பி', approve: 'ஒப்புதல்' },
};

describe('translator', () => {
  it('resolves in the chosen language', () => {
    expect(translator(COPY, 'ta')('submit')).toBe('சமர்ப்பி');
    expect(translator(COPY, 'en')('approve')).toBe('Approve');
  });

  it('falls back to English when the Tamil word is missing or blank, then to the key itself', () => {
    const holey: BilingualCopy<K> = { en: { submit: 'Submit', approve: 'Approve' }, ta: { submit: '  ', approve: 'ஒப்புதல்' } };
    expect(translator(holey, 'ta')('submit')).toBe('Submit'); // blank ta → English fallback
    const noEn = { en: { submit: '' }, ta: { submit: '' } } as unknown as BilingualCopy<'submit'>;
    expect(translator(noEn, 'ta')('submit')).toBe('submit');  // even English missing → the key, never a blank
  });

  it('exposes exactly the two shipped languages', () => {
    expect([...LANGUAGES]).toEqual(['en', 'ta']);
  });
});

describe('bilingualGaps + isBilingualComplete', () => {
  it('reports nothing missing for complete copy', () => {
    expect(bilingualGaps(COPY)).toEqual({ en: [], ta: [] });
    expect(isBilingualComplete(COPY)).toBe(true);
  });

  it('flags a key present in one language and absent or blank in the other', () => {
    const holey = { en: { a: 'A', b: 'B' }, ta: { a: 'அ', b: '   ' } } as unknown as BilingualCopy<'a' | 'b'>;
    expect(bilingualGaps(holey)).toEqual({ en: [], ta: ['b'] }); // blank counts as missing
    expect(isBilingualComplete(holey)).toBe(false);
  });

  it('checks a required vocabulary — a KIND added to the model but not the copy is caught in both languages', () => {
    // `required` is the authoritative kind list (e.g. a session model's exported KINDS).
    const required = ['submit', 'approve', 'reject'] as const;
    const gaps = bilingualGaps(COPY as unknown as BilingualCopy<'submit' | 'approve' | 'reject'>, required);
    expect(gaps.en).toEqual(['reject']);
    expect(gaps.ta).toEqual(['reject']);
    expect(isBilingualComplete(COPY as unknown as BilingualCopy<'submit' | 'approve' | 'reject'>, required)).toBe(false);
  });
});
