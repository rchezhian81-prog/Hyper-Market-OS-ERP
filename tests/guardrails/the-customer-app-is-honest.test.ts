import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { RIGHTS_OFFERED } from '../../apps/customer-app/src/privacy-centre';

/**
 * **The only public surface in this product, guarded.**
 *
 * Everything else here is used by somebody the shop employs and can train. This one is used by a
 * stranger on a slow phone who will never read a manual, and it is the one surface where the
 * commercial incentive points the wrong way: it is always cheaper to make leaving harder than
 * arriving, and nobody ever decides to do it.
 *
 * The centrepiece is section 6(6) of the DPDP Act 2023 — *the ease of withdrawing consent must be
 * comparable to the ease with which it was given.* That rule is broken one reasonable step at a
 * time: a confirmation, then a "tell us why", then a link to support, none of which would ever be
 * added to the granting path. So the taps are **counted, in both directions**, rather than trusted
 * to review.
 */

const APP = readFileSync('apps/customer-app/web/app.js', 'utf8');
const HTML = readFileSync('apps/customer-app/web/index.html', 'utf8');
const PRIVACY = readFileSync('apps/customer-app/src/privacy-centre.ts', 'utf8');
const SESSION = readFileSync('apps/customer-app/src/shopping-session.ts', 'utf8');

/** Comments discuss these on purpose, so only real code counts. */
const code = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

/** The body of the function that renders the consent switches. */
const consentRenderer = (): string => {
  const from = code(APP).indexOf('function renderConsent');
  expect(from, 'renderConsent is missing').toBeGreaterThan(-1);
  return code(APP).slice(from, code(APP).indexOf('\nfunction renderRights', from));
};

describe('withdrawing consent costs exactly what giving it costs (DPDP s.6(6))', () => {
  it('renders ONE control per purpose, which is the same control both ways', () => {
    // The structural half: a single switch whose click handler passes the opposite of the current
    // value. There is no separate "turn off" path for a confirmation step to attach itself to.
    const renderer = consentRenderer();
    expect(renderer).toMatch(/role', 'switch'/);
    expect(renderer).toMatch(/shop\.setConsent\(control\.purpose, control\.channel, !control\.granted\)/);
  });

  it('has exactly one click handler in the whole consent renderer', () => {
    // Two would mean two paths, and two paths is where the asymmetry gets in.
    const handlers = [...consentRenderer().matchAll(/addEventListener\('click'/g)];
    expect(handlers).toHaveLength(1);
  });

  it('asks nothing extra on the way out — no confirm, no reason, no retention offer', () => {
    const renderer = consentRenderer();
    // The four shapes this dark pattern actually takes, named so a later change has to argue
    // with them rather than slip past.
    expect(renderer).not.toMatch(/confirm|are you sure|why are you|tell us why/i);
    expect(renderer).not.toMatch(/granted === false \?|!control\.granted \?/);
    expect(renderer).not.toMatch(/window\.open|href=/);
  });

  it('exposes no separate withdraw function for extra steps to accumulate on', () => {
    // A second function is where a reason field, a confirmation flag and a "here is what you will
    // miss" screen accumulate. None of them would ever be added to the granting path.
    expect(PRIVACY).not.toMatch(/export function withdraw/);
    expect(PRIVACY).toMatch(/export function setConsent/);
  });

  it('carries the tap count in the model, so a screen cannot silently disagree', () => {
    expect(PRIVACY).toMatch(/tapsToGrant: 1/);
    expect(PRIVACY).toMatch(/tapsToWithdraw: 1/);
  });

  it('labels the switch in words, not only by colour and position', () => {
    // This is the control that decides what a shop may do with somebody's information. It has to
    // be unambiguous to a person who cannot distinguish the two colours.
    expect(consentRenderer()).toContain("t('on')");
    expect(consentRenderer()).toContain("t('off')");
    expect(consentRenderer()).toMatch(/aria-checked/);
  });

  it('says WHY a purpose cannot be switched off, rather than just refusing to move', () => {
    // A necessary purpose that looks optional and then will not move is its own dark pattern.
    expect(code(APP)).toContain("t('requiredPurpose')");
    expect(code(APP)).toContain("t('cannotTurnOff')");
  });
});

describe('nothing is said to be deleted that has not been deleted', () => {
  it('shows the erasure caveat ON the button, before it is pressed', () => {
    // Somebody who taps "delete everything" believing everything goes, and learns months later
    // that eight years of invoices remain, has been misled even though every later step was true.
    const rights = code(APP).slice(code(APP).indexOf('function renderRights'));
    expect(rights).toMatch(/right\.partialByLaw/);
    expect(rights).toContain("t('erasureCaveat')");
  });

  it('has words for every right the model offers', () => {
    // Add a right and forget the words, and a customer reads `correction` off a button.
    const words = code(APP).slice(code(APP).indexOf('const RIGHT_WORDS'));
    for (const right of RIGHTS_OFFERED) {
      const at = words.indexOf(`${right.kind}: {`);
      expect(at, `"${right.kind}" has no words on the screen`).toBeGreaterThan(-1);
      const entry = words.slice(at, words.indexOf('\n};', at));
      expect(entry, `"${right.kind}" has no Tamil`).toMatch(/ta:/);
    }
  });

  it('shows the model’s own sentence rather than composing a cheerier one', () => {
    // The model says the request was RECEIVED and when it must be answered by. A view that wrote
    // its own "done!" would be lying about the one subject where being lied to matters most.
    expect(code(APP)).toMatch(/raised\.tellTheCustomer/);
  });

  it('raises a request with no staff, no phone number and no email address (QG-02)', () => {
    expect(code(APP)).toMatch(/shop\.raise\(right\.kind/);
    expect(HTML).not.toMatch(/mailto:|tel:/i);
  });
});

describe('prepared is not placed — the inverse of the till', () => {
  it('never decides for itself that the order arrived', () => {
    // `reachedTheShop` is the transport's answer. A view that set it to `true` unconditionally
    // would tell somebody their order was placed when it never left the phone.
    expect(code(APP)).toMatch(/reachedTheShop: isOnline\(\)/);
    expect(code(APP)).not.toMatch(/reachedTheShop: true/);
  });

  it('shows the model’s words for a basket that was not sent', () => {
    expect(code(APP)).toMatch(/stage === 'waiting_for_signal'/);
    expect(code(APP)).toMatch(/result\.state\.tellTheCustomer/);
  });

  it('holds no sentence of its own claiming an order was placed', () => {
    // The one sentence in this app that must never have a second, untested version.
    expect(code(APP)).not.toMatch(/order placed|placed successfully|thank you for your order/i);
  });

  it('is enforced by the model, not merely rendered by the view', () => {
    expect(SESSION).toMatch(/waiting_for_signal/);
    expect(SESSION).toMatch(/reachedTheShop/);
  });
});

describe('no card data, ever (hard rule #3)', () => {
  it('has no card field anywhere on the screen', () => {
    expect(HTML).not.toMatch(/card.?number|cvv|expiry|cardholder/i);
    expect(code(APP)).not.toMatch(/cardNumber|\bcvv\b|expiryMonth/i);
  });

  it('sends a provider token and lets the model refuse anything that looks like a card', () => {
    expect(code(APP)).toMatch(/providerRef/);
    expect(SESSION).toMatch(/card_number_supplied/);
  });
});

describe('it is usable by a stranger on a slow phone (WCAG 2.2 AA, NFR-07)', () => {
  it('uses no prompt, confirm or alert', () => {
    const found = [...code(APP).matchAll(/\b(?:window\.)?(prompt|confirm|alert)\s*\(/g)].map((m) => m[1]);
    expect(found).toEqual([]);
  });

  it('offers a skip link, so a keyboard user does not tab the nav every time', () => {
    expect(HTML).toContain('class="skip"');
    expect(HTML).toMatch(/href="#main"/);
    expect(HTML).toContain('id="main"');
  });

  it('never removes the focus outline, and states one of its own', () => {
    // The first thing a design system deletes, and the thing a keyboard user needs most.
    expect(HTML).toMatch(/:focus-visible\s*\{[^}]*outline:/);
    expect(HTML).not.toMatch(/outline:\s*(?:none|0)\s*;/);
  });

  it('declares a touch target of at least 44px', () => {
    const tap = /--tap:\s*(\d+)px/.exec(HTML);
    expect(tap, 'the shell must declare a minimum touch target').not.toBeNull();
    expect(Number(tap![1])).toBeGreaterThanOrEqual(44);
  });

  it('labels every text input, rather than relying on a placeholder', () => {
    // A placeholder disappears the moment somebody types, and screen readers treat it as a hint.
    const inputs = [...HTML.matchAll(/<input[^>]*id="([\w-]+)"/g)].map((m) => m[1]!);
    expect(inputs.length).toBeGreaterThan(0);
    for (const id of inputs) expect(HTML, `"${id}" has no label`).toMatch(new RegExp(`for="${id}"`));
  });

  it('loads no font, image or script from anywhere else', () => {
    // A first-time shopper on a slow connection is exactly who this has to work for, and a remote
    // font is also a third party being told who is shopping here.
    expect(HTML).not.toMatch(/https?:\/\//);
    expect(HTML).not.toMatch(/<img|@import|url\(/i);
  });

  it('says in words when ordering is unavailable, not only in colour', () => {
    // Ordering and payment need a connection (§31 customer row); the basket does not. The
    // difference is stated rather than discovered at the payment step.
    expect(code(APP)).toContain("t('offline')");
    expect(code(APP)).toMatch(/classList\.toggle\('off'/);
  });

  it('carries Tamil for every word, not a subset', () => {
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
    expect(english.length).toBeGreaterThan(30);
    for (const key of english) expect([...tamil], `"${key}" has no Tamil`).toContain(key);
  });

  it('actually repaints when the language changes', () => {
    const toggle = code(APP).slice(code(APP).indexOf("el('lang').addEventListener"));
    expect(toggle).toMatch(/paintChrome\(\)/);
    expect(toggle).toMatch(/render\(\)/);
  });
});

describe('what came from nowhere says so', () => {
  it('announces sample prices instead of passing them off as the shop’s', () => {
    expect(HTML).toContain('id="sample"');
    expect(code(APP)).toMatch(/el\('sample'\)\.hidden = real !== undefined/);
  });

  it('names what a repeat order could not add back', () => {
    // A repeat order that silently loses the milk is why people stop trusting the button.
    expect(code(APP)).toMatch(/result\.droppedProductIds/);
  });

  it('holds no pricing arithmetic of its own', () => {
    // The view converts and displays. A second copy of a price rule here is one nobody tests, and
    // the disagreement is only ever found by a customer being charged.
    expect(code(APP)).not.toMatch(/\* *quantityMinor|subtotal\s*\+=|\*\s*1\.\d|taxBps/);
  });
});
