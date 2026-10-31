// Scrap and recycling (M28-FR-02) — the page over head office's own scrap routes. The session
// (apps/web-erp/src/scrap-session.ts, in the bundle as window.scrap) does every call; this page lays out what it is told.
// Nothing is read on open; every write is a click. Every word has a Tamil twin; every button its icon.

const $ = (id) => document.getElementById(id);
const api = window.scrap ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, review: false, record: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, act, iconName, quiet) {
  const b = document.createElement('button'); b.type = 'button'; b.dataset.act = act; if (quiet) b.className = 'quiet';
  const i = icon(iconName); if (i !== null) b.append(i);
  b.append(text('span', words)); return b;
}
const rs = (minor) => api.rupees(minor);
let review = null;
const posted = new Set();

function fillSelect(id, values, prefix) {
  const sel = $(id); const keep = sel.value;
  sel.replaceChildren(...values.map((v) => { const o = document.createElement('option'); o.value = v; o.textContent = t(`${prefix}${v}`); return o; }));
  if (keep) sel.value = keep;
}
function figure(label, value) { const s = document.createElement('span'); s.append(text('small', label), text('b', value)); return s; }
function paintReview() {
  for (const id of ['v-figures', 'rate-rows', 'finding-rows']) $(id).replaceChildren();
  $('rates-h').textContent = ''; $('findings-h').textContent = '';
  if (review === null) return;
  $('v-figures').append(figure(t('sales'), String(review.sales)), figure(t('proceeds'), rs(review.totalProceedsMinor)), figure(t('weight'), api.kg(review.totalGrams)), figure(t('unposted'), rs(review.unpostedMinor)));
  $('rates-h').textContent = t('ratesH');
  const rates = Object.entries(review.ratesPerTonneMinor);
  if (rates.length === 0) $('rate-rows').append(text('li', `○ ${t('noRates')}`));
  for (const [cat, minor] of rates) $('rate-rows').append(text('li', `${t(`c_${cat}`)} · ${rs(minor)} ${t('perTonne')}`));
  $('findings-h').textContent = t('findingsH');
  if (review.findings.length === 0) $('finding-rows').append(text('li', `✓ ${t('noFindings')}`));
  for (const f of review.findings) {
    const li = document.createElement('li'); li.className = 'attention'; li.dataset.scrap = f.scrapId; li.dataset.flag = f.flag;
    li.append(text('strong', `⚠ ${t(`fl_${f.flag}`)}`));
    li.append(text('span', `${f.scrapId} · ${t(`c_${f.category}`)} · ${rs(f.proceedsMinor)}`, 'meta'));
    if (f.flag === 'not_posted_to_finance' && may.record && !posted.has(f.scrapId)) {
      const acts = document.createElement('div'); acts.className = 'acts';
      acts.append(button(t('markPosted'), 'posted', 'check'));
      li.append(acts);
    }
    li.append(text('p', '', 'status row-status'));
    $('finding-rows').append(li);
  }
}
// What the page says about the person on it: nobody signed in, may not read the review — or (Round B · OB-515, the owner's
// decision: the owner and the accountant record, a store manager reviews) may read it but not record, so the record form
// is not shown and the page SAYS why rather than leaving it silently missing. Repainted in the chosen language.
const pageStatusKey = !may.named ? 'nobody' : !may.review ? 'cannotReview' : !may.record ? 'recordNotYours' : null;
function paint() {
  $('page-status').textContent = pageStatusKey === null ? '' : t(pageStatusKey);
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['review-h', 'reviewH'], ['v-branch-l', 'branch'], ['v-from-l', 'from'], ['v-to-l', 'to'], ['v-show-text', 'show'],
    ['record-h', 'recordH'], ['s-branch-l', 'branch'], ['s-category-l', 'category'], ['s-disposal-l', 'disposal'], ['s-kg-l', 'kg'], ['s-proceeds-l', 'proceedsRs'],
    ['s-buyer-l', 'buyer'], ['s-evidence-l', 'evidence'], ['s-recycler-l', 'recycler'], ['s-by-l', 'handledBy'], ['s-record-text', 'record']]) $(id).textContent = t(key);
  if (api !== null) { fillSelect('s-category', api.categories, 'c_'); fillSelect('s-disposal', api.disposals, 'd_'); }
  paintReview();
}
async function showReview() {
  const out = await session.review({ branchId: $('v-branch').value, from: $('v-from').value, to: $('v-to').value });
  if (out.result !== 'ok') { review = null; $('v-status').textContent = api.outcomeWords(lang, out); paintReview(); return; }
  review = out.value; $('v-status').textContent = ''; paintReview();
}

for (const [id, name] of [['v-show', 'search'], ['s-record', 'list-plus']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (may.named && may.review) {
  const today = api.today();
  $('v-from').value = today; $('v-to').value = today;
  $('review').hidden = false;
  $('v-show').addEventListener('click', () => { void showReview(); });
  $('finding-rows').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act="posted"]'); if (b === null) return;
    const li = b.closest('li'); const id = li.dataset.scrap;
    const out = await session.markPosted(id);
    if (out.result === 'ok') { posted.add(id); await showReview(); }
    const again = $('finding-rows').querySelector(`li[data-scrap="${CSS.escape(id)}"] .row-status`);
    ($('v-status')).textContent = api.outcomeWords(lang, out);
    if (again !== null) again.textContent = api.outcomeWords(lang, out);
  });
  if (may.record) {
    $('record').hidden = false;
    $('s-by').value = session.userId ?? '';
    $('s-record').addEventListener('click', async () => {
      const out = await session.record({
        branchId: $('s-branch').value, category: $('s-category').value, disposal: $('s-disposal').value, kg: $('s-kg').value, proceedsRupees: $('s-proceeds').value,
        buyerName: $('s-buyer').value, evidence: $('s-evidence').value, recyclerRegistration: $('s-recycler').value, handledBy: $('s-by').value,
      });
      $('s-status').textContent = api.outcomeWords(lang, out);
      if (out.result === 'ok' && review !== null) await showReview();
    });
  }
}
