// Scrap and recycling (M28-FR-02) — the page over head office's own scrap routes. The session
// (apps/web-erp/src/scrap-session.ts, in the bundle as window.scrap) does every call; this page lays out what it is told.
// Nothing is read on open; every write is a click. Every word has a Tamil twin; every button its icon.

const $ = (id) => document.getElementById(id);
// U5 · G17: the chrome's shared parts (window.sreOffice) may load after this page — each part is drawn once it is there,
// and the page keeps its words meanwhile. States are the chrome's chips and state boxes, never a ✓/⚠ character.
const sreO = () => window.sreOffice ?? null;
/** A line that begins with a state chip and goes on in words: "[Done] Wave given to the picker …". */
function withChip(node, state) { const o = sreO(); if (o) node.prepend(o.recordChip(state), ' '); return node; }
const api = window.scrap ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, review: false, record: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
// U1 · OB-698 (design system §1.3, §27.1): a money/stock click asks the shared consequence-and-confirm sheet first.
// `null` = the person went back (nothing is sent); 'unavailable' = the sheet could not open (said, never silent).
async function confirmFirst(spec) {
  const office = window.sreOffice;
  if (!office || typeof office.confirm !== 'function') return 'unavailable';
  const answer = await office.confirm(spec);
  return answer && answer.ok === true ? answer : null;
}



// ── U2 · G5: pick a thing, never type its code ──────────────────────────────
// A "Choose…" button beside an id field opens the shared picker (sreOffice.pick, the chrome); the pick writes the id into
// the field and names it beside, so the page still sends exactly the id it always sent. The field stays typeable: when the
// list cannot be read (head office down, no right) typing the code is the fallback, never a dead end (P-01, P-08).
function pickerBeside(input, kind, titleKey, extra = {}) {
  const o = sreO();
  if (!o || typeof o.pickable !== 'function') { document.addEventListener('sre:chrome', () => pickerBeside(input, kind, titleKey, extra), { once: true }); return; }
  o.pickable(input, kind, { en: api.words('en', titleKey), ta: api.words('ta', titleKey) }, typeof extra === 'function' ? extra() : extra);
}

/** U2 · G5: the person's own store, from the chrome (sreOffice.me) or the store computer's directory — '' when not known. */
function myStore() {
  const office = window.sreOffice;
  const me = office && typeof office.me === 'function' ? office.me() : null;
  return (me && me.storeId) || (window.sreDirectory && window.sreDirectory.store && window.sreDirectory.store.id) || '';
}
/** The branch fields start as the person's own store (changeable); the chrome may load after this page. */
function prefillBranches() {
  const id = myStore(); if (id === '') return;
  for (const f of ['v-branch', 's-branch']) if ($(f).value.trim() === '') $(f).value = id;
}

// U2 · G14: the review's two days are the chrome's shared date field (dd/mm/yyyy, the shop's calendar; read back as ISO);
// until the chrome is there the plain boxes stay (ISO typed), so the page is never a dead end.
function dateable(inputId, labelKey) {
  const o = sreO();
  if (!o || typeof o.shopDate !== 'function') { document.addEventListener('sre:chrome', () => dateable(inputId, labelKey), { once: true }); return; }
  o.shopDate(inputId, { en: api.words('en', labelKey), ta: api.words('ta', labelKey) }, { required: true });
}
const dateOf = (fieldId) => { const o = sreO(); return o && typeof o.dateOf === 'function' ? (o.dateOf(fieldId) ?? '') : ($(fieldId)?.value ?? ''); };
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, act, iconName, quiet) {
  const b = document.createElement('button'); b.type = 'button'; b.dataset.act = act; if (quiet) b.className = 'quiet sre-btn sre-btn-quiet';
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
/** The review's figures as the chrome's cards (label and value); plain words until the chrome is there. */
function paintFigures(pairs) {
  const o = sreO(); const host = $('v-figures');
  if (!o) { host.replaceChildren(...pairs.map(([label, value]) => text('span', `${label} ${value}`))); return; }
  o.cards(host, pairs.map(([label, value]) => ({ label, value })));
}
function paintReview() {
  for (const id of ['v-figures', 'rate-rows', 'finding-rows']) $(id).replaceChildren();
  $('rates-h').textContent = ''; $('findings-h').textContent = '';
  if (review === null) return;
  paintFigures([[t('sales'), String(review.sales)], [t('proceeds'), rs(review.totalProceedsMinor)], [t('weight'), api.kg(review.totalGrams)], [t('unposted'), rs(review.unpostedMinor)]]);
  $('rates-h').textContent = t('ratesH');
  const rates = Object.entries(review.ratesPerTonneMinor);
  if (rates.length === 0) $('rate-rows').append(withChip(text('li', t('noRates')), 'unknown'));
  for (const [cat, minor] of rates) $('rate-rows').append(text('li', `${t(`c_${cat}`)} · ${rs(minor)} ${t('perTonne')}`));
  $('findings-h').textContent = t('findingsH');
  if (review.findings.length === 0) $('finding-rows').append(withChip(text('li', t('noFindings')), 'done'));
  for (const f of review.findings) {
    const li = document.createElement('li'); li.className = 'attention'; li.dataset.scrap = f.scrapId; li.dataset.flag = f.flag;
    li.append(withChip(text('strong', t(`fl_${f.flag}`)), 'warning'));
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
  for (const [elId, key] of [['review-h', 'reviewH'], ['v-branch-l', 'branch'], ['v-from-l', 'from'], ['v-to-l', 'to'], ['v-show-text', 'show'],
    ['record-h', 'recordH'], ['s-branch-l', 'branch'], ['s-category-l', 'category'], ['s-disposal-l', 'disposal'], ['s-kg-l', 'kg'], ['s-proceeds-l', 'proceedsRs'],
    ['s-buyer-l', 'buyer'], ['s-evidence-l', 'evidence'], ['s-recycler-l', 'recycler'], ['s-by-l', 'handledBy'], ['s-record-text', 'record']]) { const n = $(elId); if (n !== null) n.textContent = t(key); } // a day label belongs to the chrome's date field once mounted
  if (api !== null) { fillSelect('s-category', api.categories, 'c_'); fillSelect('s-disposal', api.disposals, 'd_'); }
  paintReview();
}
async function showReview() {
  const out = await session.review({ branchId: $('v-branch').value, from: dateOf('v-from'), to: dateOf('v-to') });
  if (out.result !== 'ok') { review = null; $('v-status').textContent = api.outcomeWords(lang, out); paintReview(); return; }
  review = out.value; $('v-status').textContent = ''; paintReview();
}

for (const [id, name] of [['v-show', 'search'], ['s-record', 'list-plus']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
prefillBranches();
document.addEventListener('sre:chrome', prefillBranches);
if (may.named && may.review) {
  const today = api.today();
  $('v-from').value = today; $('v-to').value = today;
  $('review').hidden = false;
  dateable('v-from', 'from'); dateable('v-to', 'to');
  pickerBeside($('v-branch'), 'store', 'whichBranch');
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
    pickerBeside($('s-branch'), 'store', 'whichBranch');
    $('s-by').value = session.userId ?? '';
    $('s-record').addEventListener('click', async () => {
      // U1 · OB-698: the consequence-and-confirm sheet before the disposal is recorded — Go back sends nothing.
      const proceeds = Number($('s-proceeds').value);
      const sub = (l, key) => String(api.words(l, key)).replace('{kg}', $('s-kg').value).replace('{category}', $('s-category').value).replace('{disposal}', $('s-disposal').value).replace('{proceeds}', Number.isFinite(proceeds) ? `₹${proceeds.toFixed(2)}` : $('s-proceeds').value);
      // An incomplete form skips the sheet and gets the session's own words on what is missing (nothing is sent either way).
      const complete = $('s-branch').value.trim() !== '' && Number($('s-kg').value) > 0 && Number.isFinite(proceeds) && $('s-by').value.trim() !== '';
      const answer = !complete ? { ok: true } : await confirmFirst({ title: { en: sub('en', 'confirmTitle'), ta: sub('ta', 'confirmTitle') }, detail: { en: sub('en', 'confirmDetail'), ta: sub('ta', 'confirmDetail') }, authority: { en: sub('en', 'confirmAuthority'), ta: sub('ta', 'confirmAuthority') }, confirmLabel: { en: sub('en', 'confirmLabel'), ta: sub('ta', 'confirmLabel') }, tone: 'primary' });
      if (answer === 'unavailable') { $('s-status').textContent = t('confirmUnavailable'); return; }
      if (answer === null) return;
      const out = await session.record({
        branchId: $('s-branch').value, category: $('s-category').value, disposal: $('s-disposal').value, kg: $('s-kg').value, proceedsRupees: $('s-proceeds').value,
        buyerName: $('s-buyer').value, evidence: $('s-evidence').value, recyclerRegistration: $('s-recycler').value, handledBy: $('s-by').value,
      });
      $('s-status').textContent = api.outcomeWords(lang, out);
      if (out.result === 'ok' && review !== null) await showReview();
    });
  }
}
