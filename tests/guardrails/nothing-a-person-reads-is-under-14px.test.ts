import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **Nothing a person must read is under 14px (design system §3.2 · OB-13 · the UI/UX gap audit of 1 Nov 2026, G8).**
 *
 * The owner's look sets a 16px base and says nothing a person must read goes under 14px; the one allowed smaller
 * size is an UPPERCASE, letter-spaced label at `--fs-label` (12.5px). The audit found 30 office pages and the owner's
 * phone app with hints, captions, labels, footnotes and error lines at 11–13px — the words a person reads to fix a
 * file or follow a rule, drawn smaller than the rule allows. Round U0 raised every one to `var(--fs-sm)`.
 *
 * This guardrail reads every page's own `<style>` and refuses a `font-size` under 14px unless the same rule is an
 * uppercase letter-spaced label of at least 12.5px, or the selector is the logo, avatar initials, a keyboard hint or
 * screen-reader-only text. It is a file-level rule, so it catches the next 13px caption before any browser does.
 */

const OFFICE = 'apps/web-erp/web';
const OWNER_APP = 'apps/owner-app/web/index.html';

interface SmallRule { readonly file: string; readonly selector: string; readonly size: number }

/** Every font-size under 14px in a page's own stylesheet that the rule does not allow. */
export function smallTextRules(file: string, source: string): SmallRule[] {
  const found: SmallRule[] = [];
  const pattern = /font-size:\s*(\d+(?:\.\d+)?)px/g;
  for (const m of source.matchAll(pattern)) {
    const size = Number(m[1]);
    if (size >= 14) continue;
    const at = m.index ?? 0;
    const open = source.lastIndexOf('{', at);
    const close = source.indexOf('}', at);
    const rule = source.slice(open, close);
    const selector = source.slice(source.lastIndexOf('}', open) + 1, open).trim().split('\n').pop()?.trim() ?? '';
    const label = /text-transform:\s*uppercase/.test(rule) && /letter-spacing/.test(rule) && size >= 12.5;
    const exempt = /\bkbd\b|\.logo\b|\.avatar\b|\.sr-only\b/.test(selector);
    if (!label && !exempt) found.push({ file, selector, size });
  }
  return found;
}

describe('nothing a person must read is under 14px (design system §3.2)', () => {
  const pages = readdirSync(OFFICE).filter((f) => f.endsWith('.html')).map((f) => join(OFFICE, f));

  it('every office page and the owner app keep their words at 14px or more', () => {
    const offending = [...pages, OWNER_APP].flatMap((file) => smallTextRules(file, readFileSync(file, 'utf8')));
    expect(offending.map((r) => `${r.file} ${r.selector} ${r.size}px`)).toEqual([]);
  });

  it('tripwire — the scanner bites: a 13px caption is reported, a 12.5px uppercase label and a kbd hint are not', () => {
    const css = `
      .meta { color: var(--muted); font-size: 13px; }
      .label { font-size: 12.5px; letter-spacing: .06em; text-transform: uppercase; }
      .label.small { font-size: 12px; letter-spacing: .06em; text-transform: uppercase; }
      kbd { font-size: 12px; }
      .note { font-size: var(--fs-sm); }`;
    expect(smallTextRules('x.html', css)).toEqual([
      { file: 'x.html', selector: '.meta', size: 13 },
      { file: 'x.html', selector: '.label.small', size: 12 },
    ]);
  });
});
