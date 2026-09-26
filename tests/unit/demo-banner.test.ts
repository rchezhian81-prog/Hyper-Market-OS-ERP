// The DEMO / PILOT banner (Option 1 hosted-demo requirement). Proves it shows ONLY on an explicit
// opt-in (so production never carries it), is bilingual, and inserts once at the top of the body.

import { describe, it, expect } from 'vitest';
import {
  shouldShowDemoBanner, demoBannerModel, mountDemoBanner,
  DEMO_BANNER_ELEMENT_ID, DEMO_BANNER_TEXT_EN, DEMO_BANNER_TEXT_TA,
  type BannerDocument,
} from '../../packages/ui/src/demo-banner';

describe('shouldShowDemoBanner — off unless explicitly opted in', () => {
  it('is true only for an explicit "1" or "true"', () => {
    expect(shouldShowDemoBanner('1')).toBe(true);
    expect(shouldShowDemoBanner('true')).toBe(true);
  });
  it('is false for the production defaults (unset / empty / "0" / null)', () => {
    for (const off of [undefined, null, '', '0', 'false', 'no']) {
      expect(shouldShowDemoBanner(off)).toBe(false);
    }
  });
});

describe('demoBannerModel — bilingual', () => {
  it('carries both English and Tamil text', () => {
    const m = demoBannerModel('1');
    expect(m.show).toBe(true);
    expect(m.textEn).toBe(DEMO_BANNER_TEXT_EN);
    expect(m.textTa).toBe(DEMO_BANNER_TEXT_TA);
    expect(m.textTa.length).toBeGreaterThan(0);
  });
});

/** A minimal fake document that records what was prepended. */
function fakeDoc(): BannerDocument & { prepended: unknown[]; byId: Map<string, unknown> } {
  const byId = new Map<string, unknown>();
  const prepended: unknown[] = [];
  return {
    prepended, byId,
    getElementById: (id) => byId.get(id) ?? null,
    createElement: () => {
      const el = { id: '', textContent: null as string | null, style: {} as Record<string, string>, setAttribute() {} };
      return el;
    },
    body: {
      prepend(node: unknown) {
        prepended.push(node);
        const el = node as { id: string };
        byId.set(el.id, node);
      },
    },
  };
}

describe('mountDemoBanner — inserts once, only when on', () => {
  it('inserts the banner at the top of the body when the flag is on', () => {
    const doc = fakeDoc();
    const shown = mountDemoBanner(doc, '1');
    expect(shown).toBe(true);
    expect(doc.prepended).toHaveLength(1);
    const el = doc.prepended[0] as { id: string; textContent: string | null };
    expect(el.id).toBe(DEMO_BANNER_ELEMENT_ID);
    expect(el.textContent).toContain(DEMO_BANNER_TEXT_EN);
    expect(el.textContent).toContain(DEMO_BANNER_TEXT_TA);
  });

  it('is idempotent — a second mount does not add a second banner', () => {
    const doc = fakeDoc();
    mountDemoBanner(doc, '1');
    mountDemoBanner(doc, '1');
    expect(doc.prepended).toHaveLength(1);
  });

  it('does nothing when the flag is off', () => {
    const doc = fakeDoc();
    expect(mountDemoBanner(doc, '')).toBe(false);
    expect(doc.prepended).toHaveLength(0);
  });

  it('is safe when there is no document or no body', () => {
    expect(mountDemoBanner(undefined, '1')).toBe(false);
    expect(mountDemoBanner(null, '1')).toBe(false);
    expect(mountDemoBanner({ ...fakeDoc(), body: null }, '1')).toBe(false);
  });
});
