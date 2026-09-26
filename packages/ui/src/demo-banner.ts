// The "DEMO / PILOT — NOT PRODUCTION" banner (Option 1 hosted-demo requirement).
//
// A hosted demo runs the REAL software against SYNTHETIC data, which is exactly the situation where a
// person can forget which one they are looking at — and a screen that looks production-real is how a
// demo action gets mistaken for a live one. This puts an unmissable, bilingual (English/Tamil) strip
// at the top of every screen when the deployment turns it on, and shows NOTHING when it does not, so
// production never carries it. It is off by default; the pilot build turns it on
// (`PILOT_DEMO_BANNER=1` at build time — see `scripts/build-app.mjs`).
//
// The decision is a pure function (unit-tested); the DOM insertion is a thin shell over it that runs
// only in a browser, so importing this module never requires a DOM.

export const DEMO_BANNER_TEXT_EN = 'DEMO / PILOT — NOT PRODUCTION · synthetic data only';
export const DEMO_BANNER_TEXT_TA = 'டெமோ / பைலட் — உண்மைச் சூழல் அல்ல · போலித் தரவு மட்டும்';
export const DEMO_BANNER_ELEMENT_ID = 'demo-pilot-banner';

export interface DemoBannerModel {
  readonly show: boolean;
  readonly textEn: string;
  readonly textTa: string;
}

/**
 * Decide whether the banner shows, from the build-time flag. Truthy only for an explicit opt-in
 * (`'1'` or `'true'`), so an unset, empty, or `'0'` flag — the production default — shows nothing.
 */
export function shouldShowDemoBanner(flag: string | undefined | null): boolean {
  return flag === '1' || flag === 'true';
}

/** The full model a caller renders: whether to show, and the bilingual text. Pure. */
export function demoBannerModel(flag: string | undefined | null): DemoBannerModel {
  return { show: shouldShowDemoBanner(flag), textEn: DEMO_BANNER_TEXT_EN, textTa: DEMO_BANNER_TEXT_TA };
}

/** The minimal DOM surface the mount needs — kept structural so it can be exercised without a browser. */
export interface BannerDocument {
  getElementById(id: string): unknown;
  createElement(tag: string): {
    id: string;
    textContent: string | null;
    setAttribute(name: string, value: string): void;
    style: Record<string, string>;
  };
  body: { prepend(node: unknown): void } | null;
}

/**
 * Insert the banner at the very top of `document.body` when the flag is on. Idempotent (never inserts
 * twice), safe when there is no document or no body, and a no-op when the flag is off. Returns whether
 * a banner is present after the call, for a test to assert on.
 */
export function mountDemoBanner(doc: BannerDocument | undefined | null, flag: string | undefined | null): boolean {
  const model = demoBannerModel(flag);
  if (!model.show) return false;
  if (doc === undefined || doc === null || doc.body === null) return false;
  if (doc.getElementById(DEMO_BANNER_ELEMENT_ID) !== null && doc.getElementById(DEMO_BANNER_ELEMENT_ID) !== undefined) return true;

  const el = doc.createElement('div');
  el.id = DEMO_BANNER_ELEMENT_ID;
  el.textContent = `${model.textEn}  |  ${model.textTa}`;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('data-demo-banner', 'true');
  // High-contrast, fixed to the top, and impossible to miss — amber on near-black, full width.
  Object.assign(el.style, {
    position: 'sticky', top: '0', left: '0', right: '0', zIndex: '2147483647',
    background: '#b45309', color: '#fff8ec', textAlign: 'center',
    font: '700 13px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    letterSpacing: '0.04em', padding: '6px 12px', borderBottom: '2px solid #78350f',
  });
  doc.body.prepend(el);
  return true;
}
