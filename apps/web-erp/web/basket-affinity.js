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
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title-text', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['l-from', 'from'], ['l-to', 'to'], ['l-min', 'minBaskets'], ['l-department', 'department'], ['show', 'show'], ['pairs-h', 'pairsH'], ['suggestions-note', 'suggestions']]) $(id).textContent = t(k);
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.basketAffinityData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  $('show').disabled = !may.read;
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
  const out = await session.pairs($('from').value, $('to').value, $('min').value, $('department').value);
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
