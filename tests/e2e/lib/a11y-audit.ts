import type { Page } from 'playwright-core';
import { contrastRatio } from '../../../packages/a11y/src/contrast';

/**
 * **An in-browser WCAG 2.2 AA audit for the screens (NFR-07 · design system §5 · Stage G slice 3).**
 *
 * Not a framework and not a third-party engine: the rules the roadmap holds the screens to, checked against the
 * REAL rendered page in real Chromium, with the maths from `packages/a11y` (the same checker the foundation's
 * palette is proven with, so a colour cannot pass in the unit test and fail on a screen for a different reason).
 *
 *   1.4.3  Contrast (minimum)      every piece of visible text against the surface it actually sits on:
 *                                  4.5:1, or 3:1 for large text (≥ 24px, or ≥ 18.66px bold)
 *   1.4.11 Non-text contrast       switches and the sync dot against their surface: 3:1
 *   2.5.8  Target size (minimum)   every visible control at least 24×24 CSS px — and this product's own bar,
 *                                  design system §3 / §7: at least 44×44 (`minTarget`)
 *   4.1.2  Name, role, value       every button, link and input has an accessible name
 *   3.3.2  Labels or instructions  every text input is labelled, not just placeholdered
 *   3.1.1  Language of page        `<html lang>` is set — and matches the words on the screen after a toggle
 *   2.4.6  Headings                 exactly one visible h1 per view
 *   1.4.10 Reflow                    no horizontal scrolling at the viewport the test chose (a low-spec phone)
 *
 * Two honesties added for the handhelds (Stage G slice 4). An INACTIVE control — `disabled`, or `aria-disabled` —
 * is exempt from contrast and target size, as WCAG 1.4.3 and 2.5.8 exempt it; it still needs a name, because a
 * screen reader still announces it. And `opacity` is composited: words dimmed to 45% are measured at 45%, not at
 * the colour the stylesheet names — before this, a faded label could pass on paper and fail in the aisle.
 *
 * What it cannot see, and says so rather than pretends: focus visibility under a real keyboard (the static
 * guardrails hold `:focus-visible` in place), screen-reader announcement order, and the meaning of the words.
 */

export interface A11yFinding {
  readonly rule: string;
  readonly selector: string;
  readonly detail: string;
}

interface TextSample { selector: string; fg: string; bg: string; px: number; bold: boolean; text: string; alpha: number }
interface RawReport {
  texts: TextSample[];
  nonText: { selector: string; fg: string; bg: string }[];
  targets: { selector: string; w: number; h: number }[];
  unnamed: string[];
  unlabelled: string[];
  lang: string;
  h1: number;
  reflow: { scrollWidth: number; clientWidth: number };
}

/**
 * The in-page pass, as plain JavaScript SOURCE rather than a function: the test files are transpiled with helpers
 * (`__name`) that do not exist inside the page, and the tests' tsconfig deliberately has no DOM library, so a
 * string evaluated by the browser is the honest shape — it runs against the real DOM with nothing injected.
 * Colours come back as rgb()/rgba() strings; the maths happens in Node with packages/a11y.
 */
const COLLECT_SOURCE = String.raw`(() => {
  const d = document;
  const cs = (el) => getComputedStyle(el);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    let node = el;
    while (node) {
      const s = cs(node);
      if (s.display === 'none' || s.visibility === 'hidden' || node.hidden === true) return false;
      node = node.parentElement;
    }
    return true;
  };
  const describe = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className.trim() !== '' ? '.' + el.className.trim().split(/\s+/).join('.') : '';
    const text = (el.textContent || '').trim().slice(0, 30);
    return el.tagName.toLowerCase() + id + cls + (text ? ' "' + text + '"' : '');
  };
  const isTransparent = (c) => c === 'transparent' || /^rgba\((?:\d+,\s*){3}0\)$/.test(c);
  // WCAG exempts an inactive component from contrast and target size — a greyed-out button is not a target.
  const inactive = (el) => el.closest('[disabled], [aria-disabled="true"]') !== null;
  // Effective opacity: every ancestor's opacity multiplies. A word at 45% is measured at 45%.
  const alphaOf = (el) => {
    let a = 1;
    for (let node = el; node; node = node.parentElement) { const o = parseFloat(cs(node).opacity); if (!Number.isNaN(o)) a *= o; }
    return a;
  };
  const backgroundOf = (el) => {
    let node = el;
    while (node) {
      const bg = cs(node).backgroundColor;
      if (!isTransparent(bg)) return bg;
      node = node.parentElement;
    }
    return cs(d.body).backgroundColor;
  };

  const texts = [];
  const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.textContent || '').trim();
    const el = n.parentElement;
    if (!text || !el || seen.has(el)) continue;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TITLE'].includes(el.tagName)) continue;
    if (!visible(el) || inactive(el)) continue;
    seen.add(el);
    const s = cs(el);
    texts.push({ selector: describe(el), fg: s.color, bg: backgroundOf(el), px: parseFloat(s.fontSize), bold: parseInt(s.fontWeight, 10) >= 700, text: text.slice(0, 40), alpha: alphaOf(el) });
  }

  const controls = [...d.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="switch"]')].filter(visible);
  const targets = controls.filter((el) => !inactive(el)).map((el) => { const r = el.getBoundingClientRect(); return { selector: describe(el), w: r.width, h: r.height }; });
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label') || '';
    const by = el.getAttribute('aria-labelledby');
    const labelled = by ? ((d.getElementById(by) || {}).textContent || '') : '';
    const forLabel = el.id ? ((d.querySelector('label[for="' + el.id + '"]') || {}).textContent || '') : '';
    const own = el.tagName === 'INPUT' ? (el.getAttribute('value') || '') : (el.textContent || '');
    return (aria || labelled || forLabel || own).trim();
  };
  const unnamed = controls.filter((el) => nameOf(el) === '').map(describe);
  const unlabelled = [...d.querySelectorAll('input:not([type="hidden"]), select, textarea')].filter(visible)
    .filter((el) => !(el.id && d.querySelector('label[for="' + el.id + '"]')) && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby'))
    .map(describe);
  const nonText = [...d.querySelectorAll('[role="switch"], .dot')].filter(visible).filter((el) => !inactive(el)).map((el) => {
    const s = cs(el);
    const fg = s.borderStyle !== 'none' && parseFloat(s.borderWidth) > 0 && !isTransparent(s.borderColor) ? s.borderColor : s.backgroundColor;
    return { selector: describe(el), fg, bg: backgroundOf(el.parentElement || el) };
  });
  const h1 = [...d.querySelectorAll('h1')].filter(visible).length;
  const reflow = { scrollWidth: d.documentElement.scrollWidth, clientWidth: d.documentElement.clientWidth };
  return { texts, nonText, targets, unnamed, unlabelled, lang: d.documentElement.getAttribute('lang') || '', h1, reflow };
})()`;

/** `rgb(a, b, c)` / `rgba(a, b, c, 1)` → `#rrggbb`; a translucent colour is composited over the background. */
function toHex(css: string, over?: string): string | undefined {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(css.trim());
  if (!m) return undefined;
  let [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const a = m[4] === undefined ? 1 : Number(m[4]);
  if (a < 1 && over) {
    const o = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(over.trim());
    if (o) { r = Math.round(r * a + Number(o[1]) * (1 - a)); g = Math.round(g * a + Number(o[2]) * (1 - a)); b = Math.round(b * a + Number(o[3]) * (1 - a)); }
  }
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Words at `alpha` opacity over `bg` are seen as this colour. */
function dim(fgHex: string, bgHex: string, alpha: number): string {
  if (alpha >= 1) return fgHex;
  const c = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
  const mix = (i: number) => Math.round(c(fgHex, i) * alpha + c(bgHex, i) * (1 - alpha)).toString(16).padStart(2, '0');
  return `#${mix(1)}${mix(3)}${mix(5)}`;
}

export async function auditPage(page: Page, options: { readonly minTarget?: number; readonly expectLang?: string; readonly ignore?: readonly RegExp[] } = {}): Promise<A11yFinding[]> {
  const minTarget = options.minTarget ?? 44;
  const raw = (await page.evaluate(COLLECT_SOURCE)) as RawReport;
  const findings: A11yFinding[] = [];
  const ignored = (sel: string): boolean => (options.ignore ?? []).some((re) => re.test(sel));

  for (const t of raw.texts) {
    const named = toHex(t.fg, t.bg); const bg = toHex(t.bg);
    if (!named || !bg) { findings.push({ rule: '1.4.3', selector: t.selector, detail: `colour not readable: ${t.fg} on ${t.bg}` }); continue; }
    const fg = dim(named, bg, t.alpha);
    const ratio = contrastRatio(fg, bg);
    const large = t.px >= 24 || (t.px >= 18.66 && t.bold);
    const need = large ? 300 : 450;
    const faded = t.alpha < 1 ? ` at ${Math.round(t.alpha * 100)}% opacity` : '';
    if (ratio === undefined || ratio < need) findings.push({ rule: '1.4.3', selector: t.selector, detail: `${fg}${faded} on ${bg} = ${((ratio ?? 0) / 100).toFixed(2)}:1 (${t.px}px${t.bold ? ' bold' : ''}, needs ${need / 100}:1) "${t.text}"` });
  }
  for (const n of raw.nonText) {
    const fg = toHex(n.fg, n.bg); const bg = toHex(n.bg);
    const ratio = fg && bg ? contrastRatio(fg, bg) : undefined;
    if (ratio === undefined || ratio < 300) findings.push({ rule: '1.4.11', selector: n.selector, detail: `${fg ?? n.fg} on ${bg ?? n.bg} = ${((ratio ?? 0) / 100).toFixed(2)}:1 (needs 3:1)` });
  }
  for (const c of raw.targets) {
    if (c.w < minTarget || c.h < minTarget) findings.push({ rule: '2.5.8', selector: c.selector, detail: `${Math.round(c.w)}×${Math.round(c.h)} px, needs ${minTarget}×${minTarget}` });
  }
  for (const s of raw.unnamed) findings.push({ rule: '4.1.2', selector: s, detail: 'control has no accessible name' });
  for (const s of raw.unlabelled) findings.push({ rule: '3.3.2', selector: s, detail: 'input has no label' });
  if (raw.lang === '') findings.push({ rule: '3.1.1', selector: 'html', detail: 'no lang attribute' });
  if (options.expectLang && raw.lang !== options.expectLang) findings.push({ rule: '3.1.1', selector: 'html', detail: `lang is "${raw.lang}", the words on screen are "${options.expectLang}"` });
  if (raw.h1 !== 1) findings.push({ rule: '2.4.6', selector: 'h1', detail: `${raw.h1} visible h1 elements, expected exactly 1` });
  if (raw.reflow.scrollWidth > raw.reflow.clientWidth + 1) findings.push({ rule: '1.4.10', selector: 'html', detail: `the page is ${raw.reflow.scrollWidth}px wide in a ${raw.reflow.clientWidth}px viewport — horizontal scrolling` });

  return findings.filter((f) => !ignored(f.selector));
}
