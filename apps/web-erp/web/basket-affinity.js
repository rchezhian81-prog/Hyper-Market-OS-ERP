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
let answeredAt = null;
// UI-3: the source line and the shared office parts (window.sreOffice, from the chrome — painted again on `sre:chrome`).
const UI3 = {
  en: { covers: 'This store · from {from} to {to}{dept} · pairs in at least {min} baskets · head office answered at {time}', dept: ' · department {d}', allDepts: '' },
  ta: { covers: 'இந்தக் கடை · {from} முதல் {to} வரை{dept} · குறைந்தது {min} கூடைகளில் உள்ள ஜோடிகள் · தலைமை அலுவலகம் பதிலளித்த நேரம் {time}', dept: ' · துறை {d}', allDepts: '' },
};
const u3 = (k) => UI3[lang][k] ?? UI3.en[k];
const office = () => window.sreOffice ?? null;
function coversLine() {
  if (view === null) return '';
  const time = answeredAt === null ? '' : window.sreShopDay?.dateTimeOf(answeredAt) ?? answeredAt;
  return u3('covers').split('{from}').join(view.from).split('{to}').join(view.to).split('{min}').join(String(view.minBaskets))
    .split('{dept}').join(view.department === null ? u3('allDepts') : u3('dept').split('{d}').join(view.department)).split('{time}').join(time);
}
document.addEventListener('sre:chrome', () => { paint(); });

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
  $('pairs-covers').textContent = coversLine();
  const totals = [['counted', view.basketCount], ['returnsTakenOut', view.returnsTakenOut], ['belowMinimum', view.belowMinimum], ['withoutCategory', view.productsWithoutCategory]];
  const o = office();
  if (o !== null) {
    // The shared summary cards — each count exactly as head office answered it; a card keeps its `data-total` name.
    o.cards($('totals'), totals.map(([k, v]) => ({ label: t(k), value: v, icon: k === 'counted' ? 'shopping-basket' : 'list', tone: k !== 'counted' && v > 0 ? 'pending' : undefined })));
    $('totals').className = '';
    // The cards keep the plain panels' names (`.panel[data-total] .v`), so anything that reads them still finds them.
    $('totals').querySelectorAll('.sre-summary-card').forEach((card, i) => {
      card.dataset.total = totals[i][0]; card.classList.add('panel');
      card.querySelector('.sre-summary-value')?.classList.add('v');
    });
  } else {
    $('totals').replaceChildren(...totals.map(([k, v]) => {
      const p = el('div', 'panel'); p.dataset.total = k; p.append(el('span', 'k', t(k)), el('span', 'v', String(v))); return p;
    }));
  }
  if (view.pairs.length === 0 && o !== null) {
    // No pair is not "nothing goes together": it says the window and the minimum it covered (P-08).
    const li = el('li'); o.state(li, 'empty', { title: t('noPairs'), detail: coversLine() }); $('pairs').replaceChildren(li);
    return;
  }
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
  if (out.result === 'ok') { view = out.value; answeredAt = new Date().toISOString(); $('page-status').className = 'status'; $('page-status').textContent = ''; } else { view = null; say('page-status', out, false); }
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
