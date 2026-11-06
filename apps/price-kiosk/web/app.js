// Price kiosk — the view layer. The rule lives in the TESTED model (`apps/price-kiosk/src/price-kiosk.ts`), attached
// as `window.kiosk`; this file draws it. A scanner is a keyboard that types fast and presses Enter — there is no box to
// type a code into. Read-only: nothing here is ever sent anywhere.

// OB-607: a moment is shown at the SHOP's clock (its zone, as the store computer told the page) — never this device's.
const shopWhen = (value) => window.sreShopDay?.dateTimeOf(value) ?? '';
const el = (id) => document.getElementById(id);
const mark = (name, size = 22) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, size) : null);
function paintIconSlots() {
  for (const slot of document.querySelectorAll('[data-sre-icon]')) {
    if (slot.firstElementChild !== null) continue;
    const m = mark(slot.dataset.sreIcon, 22);
    if (m !== null) slot.append(m);
  }
}

const WORDS = {
  en: {
    title: 'Price check', ask: 'Scan an item to see its price.', limitNotSet: 'When this kiosk stops quoting an old list is not set by the owner, so it shows the list\'s age with every price.',
    limitSet: 'This kiosk stops quoting when its list is older than {m} minutes.', noBundle: 'This kiosk is not ready. Please ask a colleague.',
    staleShell: 'No connection to the store computer. This is the price list as it was last served, at',
  },
  ta: {
    title: 'விலை சரிபார்ப்பு', ask: 'விலையைப் பார்க்க ஒரு பொருளை ஸ்கேன் செய்யவும்.', limitNotSet: 'பழைய பட்டியலில் இருந்து விலை சொல்வதை எப்போது நிறுத்துவது என்பதை உரிமையாளர் அமைக்கவில்லை; ஆகவே ஒவ்வொரு விலையுடனும் பட்டியலின் வயது காட்டப்படும்.',
    limitSet: 'பட்டியல் {m} நிமிடங்களுக்கு மேல் பழையதானால் இந்தக் கியோஸ்க் விலை சொல்வதை நிறுத்தும்.', noBundle: 'இந்தக் கியோஸ்க் தயாராக இல்லை. எங்கள் ஊழியரிடம் கேளுங்கள்.',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இது கடைசியாக வழங்கப்பட்ட விலைப் பட்டியல், நேரம்:',
  },
};
let lang = 'en';
const t = (k) => WORDS[lang][k];
const kiosk = window.kiosk;
let last = null;

/**
 * UI-2: the model's sentence laid out for a customer a step away — "Ponni rice 1kg: ₹70.00. Offers are applied at the
 * till." becomes the name large, the price the largest thing on the screen, and the note under it. The sentence is kept
 * WHOLE (the joins ride along for a screen reader), so what the kiosk says never changes; a sentence the layout does not
 * recognise is shown as it is.
 */
function paintAnswer(node, sentence, priceMinor) {
  const price = typeof priceMinor === 'number' ? `₹${(priceMinor / 100).toFixed(2)}` : null;
  const at = price === null ? -1 : sentence.indexOf(price);
  const stop = at < 0 ? -1 : sentence.indexOf('. ', at + price.length);
  const nameEnd = at < 0 ? -1 : sentence.lastIndexOf(': ', at);
  if (at < 0 || stop < 0 || nameEnd < 0) { node.textContent = sentence; return; }
  const part = (cls, text) => { const span = document.createElement('span'); span.className = cls; span.textContent = text; return span; };
  const figure = part('sre-figure-xl', price);
  const per = sentence.slice(at + price.length, stop);
  if (per.trim() !== '') figure.append(part('per', per));
  node.replaceChildren(
    part('sre-kiosk-name', sentence.slice(0, nameEnd)), part('sr-only', ': '),
    figure,
    part('sr-only', '. '), part('sre-kiosk-note', sentence.slice(stop + 2)),
  );
}

function render() {
  el('title').textContent = t('title');
  el('ask-words').textContent = t('ask');
  if (kiosk === undefined) { el('answer').textContent = t('noBundle'); el('answer').className = 'answer refused'; el('card').hidden = false; el('card').dataset.tone = 'warn'; return; }
  el('limit').textContent = kiosk.staleAfter === null ? t('limitNotSet') : t('limitSet').replace('{m}', String(kiosk.staleAfter));
  if (last === null) {
    el('answer').textContent = '';
    el('age-words').textContent = lang === 'ta' ? kiosk.age().ta : kiosk.age().en;
    return;
  }
  const sentence = lang === 'ta' ? last.words.ta : last.words.en;
  if (last.outcome === 'quoted') paintAnswer(el('answer'), sentence, last.priceMinor); else el('answer').textContent = sentence;
  el('answer').className = last.outcome === 'quoted' ? 'answer quoted' : 'answer refused';
  // A refusal is the same card in amber — the words are the signal; the tone only backs them.
  el('card').hidden = false;
  if (last.outcome === 'quoted') delete el('card').dataset.tone; else el('card').dataset.tone = 'warn';
  el('age-words').textContent = lang === 'ta' ? last.age.ta : last.age.en;
}

let buffer = '';
document.addEventListener('keydown', (e) => {
  if (kiosk === undefined) return;
  if (e.key === 'Enter') {
    const code = buffer.trim();
    buffer = '';
    // UI-2: a scanner ends every code with Enter, and Enter on a FOCUSED button presses it — the language button a
    // customer last touched would flip the language on the next scan. The Enter belongs to the scan (as at the till).
    if (code !== '') { e.preventDefault(); last = kiosk.lookup(code); render(); }
    return;
  }
  if (e.key.length === 1) buffer += e.key;
});

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  render();
});

// A copy the service worker served when the store computer could not be reached says so, and when (P-08).
function paintStale() {
  const at = window.shellCachedAt;
  const strip = el('stale');
  if (!strip) return;
  strip.hidden = at === undefined;
  if (at === undefined) return;
  strip.textContent = `${t('staleShell')} ${shopWhen(at)}`;
}
paintStale();
el('lang').addEventListener('click', paintStale);
paintIconSlots();
render();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the kiosk still opens; it just will not be there without the store computer */
  });
}
