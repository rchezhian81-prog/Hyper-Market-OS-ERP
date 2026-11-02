// Bought together — the page over head office's D-23 read (R4 · signed OB-227). The session (apps/web-erp/src/basket-
// affinity-session.ts, in the bundle as window.basketAffinity) asks head office; this page only shows its answers: the
// pairs bought together more often than chance with their basket count, support, confidence and lift, what was counted
// and what was left out, and draft suggestions. "Make a draft promotion" sends a DRAFT to the existing promotion route as
// the signed-in person; it is not live until the promotion launch approval. Nothing is written on open.

const $ = (id) => document.getElementById(id);
const api = window.basketAffinity ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, draft: false };

let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));

// U2 · G14 (UI/UX gap audit): a date a shop person reads — dd/mm/yyyy in the chrome's shared field (`sreOffice.dateField`),
// while the page goes on sending ISO (`dateOf`). Before the chrome has loaded, or off the box, the field stays as it was.
const wordsIn = (l, k) => (api === null ? k : api.words(l, k)); // the page's own words, for either language (null off the box)
const shopDates = new Map();
/** The shared fields' labels follow the language toggle like the page's own words do. */
function repaintShopDates() { const l = document.documentElement.lang === 'ta' ? 'ta' : 'en'; for (const [id, words] of shopDates) { const lab = $(id)?.closest('.sre-field')?.querySelector('.sre-field-label'); if (lab && lab.firstChild) lab.firstChild.textContent = words[l] ?? words.en; } }
function shopDate(id, words, opts = {}) {
  const office = window.sreOffice; const input = $(id);
  if (!office || typeof office.dateField !== 'function' || input === null || shopDates.has(id)) return;
  // a value already on the plain field is carried over — ISO as the page set it, or dd/mm/yyyy as a person typed it
  const typed = input.value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(typed) ? typed : (typeof office.parseShopDate === 'function' ? office.parseShopDate(typed) : null);
  const field = office.dateField({ id, label: words, required: opts.required === true, ...(iso ? { value: iso } : {}), ...(opts.hint ? { hint: opts.hint } : {}) });
  (input.closest('label') ?? input).replaceWith(field);
  shopDates.set(id, words);
}
const dateOf = (id) => (shopDates.has(id) ? (window.sreOffice.dateValue(id) ?? '') : ($(id)?.value ?? ''));
let view = null;

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function say(id, out, good) { $(id).className = `status ${good ? 'good' : 'err'}`; $(id).textContent = good ? out : api.outcomeWords(lang, out); }
const pct = (x) => `${(x * 100).toFixed(1)}%`;

function field(labelKey, cls, type = 'text') {
  const label = el('label'); const input = el('input'); input.className = cls; input.type = type; input.autocomplete = 'off';
  label.append(el('span', '', t(labelKey)), input);
  return { label, input };
}

function paint() {
  repaintShopDates();
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title-text', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['l-from', 'from'], ['l-to', 'to'], ['l-min', 'minBaskets'], ['l-department', 'department'], ['show', 'show'], ['pairs-h', 'pairsH'], ['suggestions-note', 'suggestions']]) { const n = $(id); if (n) n.textContent = t(k); }
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.basketAffinityData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  $('show').disabled = !may.read; whyDisabled($('show'), may.read ? '' : 'role');
  $('pairs-section').hidden = view === null;
  if (view === null) return;
  $('totals').replaceChildren(...[['counted', view.basketCount], ['returnsTakenOut', view.returnsTakenOut], ['belowMinimum', view.belowMinimum], ['withoutCategory', view.productsWithoutCategory]].map(([k, v]) => {
    const p = el('div', 'panel'); p.dataset.total = k; p.append(el('span', 'k', t(k)), el('span', 'v', String(v))); return p;
  }));
  $('pairs').replaceChildren(...(view.pairs.length === 0 ? [el('li', 'row', t('noPairs'))] : view.pairs.map((p) => {
    const li = el('li', 'row'); li.dataset.pair = `${p.productA}+${p.productB}`;
    li.append(
      el('strong', '', `${p.productA} + ${p.productB}`),
      el('span', 'facts', `${p.basketCount} ${t('baskets')} · ${t('support')} ${pct(p.support)} · ${t('confidence')} ${p.productA}→${p.productB} ${pct(p.confidenceAtoB)}, ${p.productB}→${p.productA} ${pct(p.confidenceBtoA)} · ${t('lift')} ${p.lift}`),
    );
    if (may.draft) {
      const f = el('form');
      const a = field('percent', 'percent'); const s = field('startsAt', 'starts', 'date'); const e = field('endsAt', 'ends', 'date');
      const b = el('button', 'draft-promo', t('draftPromo')); b.type = 'submit';
      f.append(a.label, s.label, e.label, b);
      f.addEventListener('submit', (ev) => { ev.preventDefault(); void draft(p, a.input.value, s.input.value, e.input.value); });
      li.append(f);
    }
    return li;
  })));
}

async function show(event) {
  event?.preventDefault();
  const out = await session.pairs(dateOf('from'), dateOf('to'), $('min').value, $('department').value);
  if (out.result === 'ok') { view = out.value; $('page-status').className = 'status'; $('page-status').textContent = ''; } else { view = null; say('page-status', out, false); }
  paint();
}
async function draft(pair, percent, startsAt, endsAt) {
  const out = await session.draftPromotion(pair, percent, startsAt, endsAt);
  if (out.result === 'ok') say('promo-status', `${t('drafted')} (${out.value.promotionId})`, true); else say('promo-status', out, false);
}

$('ask').addEventListener('submit', (e) => { void show(e); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (may.named && !may.read) { $('page-status').className = 'status err'; $('page-status').textContent = t('cannotRead'); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}

/** A greyed button says why (U1 · G3 · design system §4 "disabled state explains why"): the reason is the button's tooltip
 *  and the words beside it, in the reader's language. `why` is 'role' (your role may not), 'offline' (head office cannot
 *  be reached), a page's own { en, ta } pair or sentence; '' takes the words away. */
function whyWords() {
  return {
  role: { en: 'Your role may not do this.', ta: 'உங்கள் பங்குக்கு இதைச் செய்ய அனுமதி இல்லை.' },
  offline: { en: 'Head office cannot be reached, so this cannot be done now.', ta: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை, எனவே இப்போது இதைச் செய்ய முடியாது.' },
  };
}
function whyDisabled(btn, why) {
  const tongue = document.documentElement.lang === 'ta' ? 'ta' : 'en';
  const words = why === '' || why === undefined || why === null ? '' : typeof why === 'string' ? (whyWords()[why]?.[tongue] ?? why) : (why[tongue] ?? why.en);
  let note = btn.nextElementSibling;
  if (!(note && note.classList.contains('sre-why'))) {
    note = document.createElement('small'); note.className = 'sre-why';
    note.id = `${btn.id || `b${Math.random().toString(36).slice(2, 7)}`}-why`;
    btn.after(note);
  }
  note.textContent = words; note.hidden = words === '';
  if (words === '') { btn.removeAttribute('title'); btn.removeAttribute('aria-describedby'); } else { btn.title = words; btn.setAttribute('aria-describedby', note.id); }
}
// the chrome loads after this script: its shared date fields replace the plain ones once it is there
document.addEventListener('sre:chrome', () => { shopDate('from', { en: wordsIn('en', 'from'), ta: wordsIn('ta', 'from') }); shopDate('to', { en: wordsIn('en', 'to'), ta: wordsIn('ta', 'to') }); paint(); }, { once: true });
