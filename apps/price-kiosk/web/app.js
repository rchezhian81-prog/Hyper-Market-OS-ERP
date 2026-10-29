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

function render() {
  el('title').textContent = t('title');
  el('ask-words').textContent = t('ask');
  if (kiosk === undefined) { el('answer').textContent = t('noBundle'); el('answer').className = 'answer refused'; return; }
  el('limit').textContent = kiosk.staleAfter === null ? t('limitNotSet') : t('limitSet').replace('{m}', String(kiosk.staleAfter));
  if (last === null) {
    el('answer').textContent = '';
    el('age-words').textContent = lang === 'ta' ? kiosk.age().ta : kiosk.age().en;
    return;
  }
  el('answer').textContent = lang === 'ta' ? last.words.ta : last.words.en;
  el('answer').className = last.outcome === 'quoted' ? 'answer quoted' : 'answer refused';
  el('age-words').textContent = lang === 'ta' ? last.age.ta : last.age.en;
}

let buffer = '';
document.addEventListener('keydown', (e) => {
  if (kiosk === undefined) return;
  if (e.key === 'Enter') {
    const code = buffer.trim();
    buffer = '';
    if (code !== '') { last = kiosk.lookup(code); render(); }
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
