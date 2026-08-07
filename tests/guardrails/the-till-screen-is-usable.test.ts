import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **The screen a cashier uses eight hours a day, guarded.**
 *
 * The POS screen has properties that are decisions rather than taste, and every one of them is
 * easy to undo by accident in a hurry — a `prompt()` because it is three characters shorter, a
 * toast because it looks tidier, a colour-only badge because the words did not fit. Each would be
 * invisible in review and obvious to a cashier with a queue.
 *
 * These are static checks on the shipped files. They cannot prove the screen is *good*; a person
 * with a stopwatch does that (`docs/design/usability-test-script.md`). They can prove the
 * decisions that were made deliberately are still there.
 */

const APP = readFileSync('apps/pos/web/app.js', 'utf8');
const HTML = readFileSync('apps/pos/web/index.html', 'utf8');

/** Comments discuss these on purpose, so only real code counts. */
const code = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

describe('nothing at the till asks a question through the browser', () => {
  it('uses no prompt, confirm or alert anywhere', () => {
    // Wrong here in three separate ways: a browser prompt is a small text field with a system
    // keyboard over it, unusable with a queue waiting and impossible with gloves; kiosk browsers
    // block them outright, so the till would simply do nothing; and they cannot be styled, so the
    // one screen that must be readable across a counter is not.
    const found = [...code(APP).matchAll(/\b(?:window\.)?(prompt|confirm|alert)\s*\(/g)].map((m) => m[1]);
    expect(found).toEqual([]);
  });

  it('asks with an on-screen panel instead', () => {
    expect(HTML).toContain('id="sheet"');
    expect(HTML).toContain('id="keypad"');
    expect(code(APP)).toMatch(/function ask\(/);
  });

  it('offers void reasons as choices, never as free text', () => {
    // Free text at a till is a reason nobody can report on afterwards (M15).
    expect(code(APP)).toContain('VOID_REASONS');
    expect(code(APP)).not.toMatch(/<input[^>]*reason/i);
  });
});

describe('the message that must not be missed, is not missed', () => {
  it('has a refusal banner that does not disappear on a timer', () => {
    // A toast that fades after four seconds is a message that was missed by the person serving a
    // customer. "Do not take payment" is the one sentence in this product that must survive that.
    expect(HTML).toContain('id="refusal"');
    expect(HTML).toContain('role="alert"');
    const banner = code(APP).slice(code(APP).indexOf('function tell'), code(APP).indexOf('el(\'refusal-ok\')'));
    expect(banner).not.toMatch(/setTimeout|setInterval/);
  });

  it('shows the MODEL\'s words on a refusal, not its own', () => {
    // `laneMessage` is written for a cashier with a customer watching. Rewording it in the view
    // would put a second, untested version of the most important sentence in the product.
    expect(code(APP)).toContain('e.laneMessage');
  });
});

describe('it can be read and reached', () => {
  it('states a touch target of at least 48px', () => {
    const tap = /--tap:\s*(\d+)px/.exec(HTML);
    expect(tap, 'the shell must declare a minimum touch target').not.toBeNull();
    expect(Number(tap![1])).toBeGreaterThanOrEqual(48);
  });

  it('never uses colour as the only signal on the sync badge', () => {
    // One man in twelve has some colour blindness, and this badge is how a cashier knows whether
    // the shop is behind. The dot is the decoration; the words are the badge.
    expect(code(APP)).toContain("t('offline')");
    expect(code(APP)).toContain("t('online')");
  });

  it('carries Tamil for every word on the screen, not a subset', () => {
    // Tamil is a first language for much of the floor staff, not a translation afterthought, and a
    // half-translated screen is worse than an untranslated one: it reads as unfinished exactly
    // where somebody is relying on it.
    const source = code(APP);
    const block = (marker: string): string => {
      const from = source.indexOf(marker);
      expect(from, `the ${marker.slice(0, 2)} words are missing`).toBeGreaterThan(-1);
      return source.slice(from, source.indexOf('\n  },', from));
    };
    const keysIn = (text: string): string[] =>
      [...text.matchAll(/(?:^|[{,]\s*)(\w+):\s*'/g)].map((m) => m[1]!);

    const english = keysIn(block('en: {'));
    const tamil = new Set(keysIn(block('ta: {')));
    expect(english.length).toBeGreaterThan(10);
    for (const key of english) expect([...tamil], `"${key}" has no Tamil`).toContain(key);
  });
});

describe('the scanner cannot type into the wrong place', () => {
  it('collects scans globally rather than from a focused input', () => {
    // A retail scanner is a keyboard that types fast and presses Enter. With a focused input,
    // losing focus sends a scan into whatever was last tapped — at a till, a quantity field — and
    // a barcode typed into a quantity is a sale of nine hundred million units.
    expect(code(APP)).toMatch(/window\.addEventListener\('keydown'/);
    expect(code(APP)).toContain('scanBuffer');
    expect(HTML).not.toMatch(/<input[^>]*(?:barcode|scan)/i);
  });

  it('ignores a person pressing Enter, and a panel being open', () => {
    expect(code(APP)).toMatch(/code\.length < \d+/);
    expect(code(APP)).toContain("!el('sheet').hidden");
  });
});

describe('the drawer is counted blind', () => {
  it('never puts an expected figure on the counting panel', () => {
    // The whole design. Shown "expected: ₹6,000", people write ₹6,000 — not from dishonesty, but
    // because a number on a screen is an answer and counting is work. A cash-up anchored to the
    // expectation finds nothing, which is the one thing a cash-up exists to do.
    const panel = HTML.slice(HTML.indexOf('id="count"'), HTML.indexOf('id="refusal"'));
    expect(panel).not.toMatch(/expected|should be|target/i);

    const counting = code(APP).slice(code(APP).indexOf('function countDrawer'), code(APP).indexOf('el(\'count-cancel\')'));
    expect(counting).not.toMatch(/expected|drawerBalance/i);
  });

  it('reads the expected figure only from the RESULT, after a count was submitted', () => {
    // It may be shown once it can no longer influence what somebody wrote down.
    expect(code(APP)).toMatch(/result\.variance/);
    expect(code(APP)).not.toMatch(/session\.till\.(?:expected|drawerBalanceMinor)\(\)/);
  });

  it('tells the cashier what to DO about a material difference, not just the number', () => {
    // "Variance ₹200" is a fact. "Do not put the money away — call the manager now" is an
    // instruction, and at the end of a long shift only one of those gets acted on.
    expect(code(APP)).toContain("t('needsReason')");
    const words = code(APP).slice(code(APP).indexOf('needsReason:'), code(APP).indexOf("',", code(APP).indexOf('needsReason:')));
    expect(words).toMatch(/call the manager/i);
  });

  it('counts by denomination rather than asking for one typed total', () => {
    // A typed total is a number somebody worked out in their head at the end of a shift.
    expect(code(APP)).toContain('DENOMS');
    expect(HTML).toContain('id="denoms"');
  });
});

describe('what is not built is SAID, not hidden behind a dead button', () => {
  it('tells the cashier where to send a receipt refund instead of failing silently', () => {
    // A button that opens a screen which cannot work is worse than one that explains itself.
    expect(code(APP)).toContain("t('refundNotBuilt')");
  });
});

describe('the receipt still waits for the disk', () => {
  it('awaits the commit before it says anything about a receipt', () => {
    // The whole of hard rule #1 at this layer. The receipt number does not exist until the sale is
    // on the disk, so there is nothing to print with before then.
    expect(code(APP)).toMatch(/await session\.tenderCash\(/);
  });

  it('holds no pricing or tender arithmetic of its own', () => {
    // The view converts and displays. A second copy of a money rule on this side of the boundary
    // is a rule that is not tested.
    expect(code(APP)).not.toMatch(/taxBps|\*\s*1\.\d|discount|promotion/i);
  });
});
