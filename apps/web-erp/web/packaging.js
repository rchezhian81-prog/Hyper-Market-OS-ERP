// Packaging and crates (M28-FR-03) — the page over head office's own packaging back office. The session
// (apps/web-erp/src/packaging-session.ts, in the bundle as window.packaging) does every call; this page lays out what it is
// told. Nothing is read on open; every write is a click. Every word has a Tamil twin; every button its icon.

const $ = (id) => document.getElementById(id);
const api = window.packaging ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, move: false };
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



// U5 · G17: the chrome's shared parts (window.sreOffice) may load after this page — each part is drawn once it is there,
// and the page keeps its words meanwhile.
const office = () => window.sreOffice ?? null;
const whenChrome = (fn) => { if (window.sreOffice) fn(); else document.addEventListener('sre:chrome', fn, { once: true }); };
const paintPickers = () => {}; // U5: the chrome's `pickable` keeps its own words on the toggle
/** U2 · G5: the person's own store, from the chrome (sreOffice.me) or the store computer's directory — '' when not known. */
function myStore() {
  const office = window.sreOffice;
  const me = office && typeof office.me === 'function' ? office.me() : null;
  return (me && me.storeId) || (window.sreDirectory && window.sreDirectory.store && window.sreDirectory.store.id) || '';
}
/** The branch fields start as the person's own store (changeable); the chrome may load after this page. */
function prefillBranches() {
  const id = myStore(); if (id === '') return;
  for (const f of ['q-branch', 'm-branch']) if ($(f).value.trim() === '') $(f).value = id;
}
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
let position = null;

function fillSelect(id, values, prefix) {
  const sel = $(id); const keep = sel.value;
  sel.replaceChildren(...values.map((v) => { const o = document.createElement('option'); o.value = v; o.textContent = t(`${prefix}${v}`); return o; }));
  if (keep) sel.value = keep;
}
/** The position's figures as summary cards (each carries its key for the tests and the eye); the negative warning as a chip. */
function paintPosition() {
  const o = office();
  $('q-negative').hidden = true; $('q-negative').replaceChildren();
  if (position === null || !o) { $('q-figures').replaceChildren(); return; }
  const p = position;
  if (p.negative) { $('q-negative').hidden = false; $('q-negative').append(o.chip('degraded', t('negativeWarn'))); }
  const cards = [
    { key: 'onHand', label: `${p.name} · ${t('onHand')}`, value: String(p.onHand), tone: p.negative ? 'degraded' : undefined },
    { key: 'inCirculation', label: t('inCirculation'), value: String(p.inCirculation) },
    { key: 'issued', label: t('issued'), value: String(p.issuedTotal) },
    { key: 'returned', label: t('returned'), value: String(p.returnedTotal) },
    { key: 'writtenOff', label: t('writtenOff'), value: String(p.writtenOff) },
    { key: 'lossRate', label: t('lossRate'), value: p.lossRateBps === 'not_meaningful' ? null : `${(p.lossRateBps / 100).toFixed(2)}%`, note: p.lossRateBps === 'not_meaningful' ? t('notMeaningful') : undefined },
  ];
  const list = o.cards($('q-figures'), cards);
  [...list.children].forEach((card, i) => { card.dataset.figure = cards[i].key; });
}
function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['position-h', 'positionH'], ['q-item-l', 'item'], ['q-branch-l', 'branch'], ['q-show-text', 'show'],
    ['register-h', 'registerH'], ['i-item-l', 'item'], ['i-name-l', 'name'], ['i-kind-l', 'kind'], ['i-charge-l', 'charge'], ['i-tax-l', 'tax'], ['i-deposit-l', 'deposit'], ['i-returnable-l', 'returnable'], ['i-save-text', 'register'],
    ['move-h', 'moveH'], ['m-item-l', 'item'], ['m-branch-l', 'branch'], ['m-kind-l', 'move'], ['m-qty-l', 'qty'], ['m-ref-l', 'reference'], ['m-record-text', 'recordMove']]) $(id).textContent = t(key);
  if (api !== null) { fillSelect('i-kind', api.kinds, 'k_'); fillSelect('m-kind', api.moves, 'm_'); }
  paintPickers();
  paintPosition();
}
async function showPosition() {
  const out = await session.position($('q-item').value, $('q-branch').value);
  if (out.result !== 'ok') { position = null; $('q-status').textContent = api.outcomeWords(lang, out); paintPosition(); return; }
  position = out.value; $('q-status').textContent = ''; paintPosition();
}

for (const [id, name] of [['q-show', 'search'], ['i-save', 'check'], ['m-record', 'list-plus']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
prefillBranches();
document.addEventListener('sre:chrome', prefillBranches);
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else {
  $('position').hidden = false;
  whenChrome(() => { office().pickable($('q-branch'), 'store', { en: api.words('en', 'whichBranch'), ta: api.words('ta', 'whichBranch') }); });
  $('q-show').addEventListener('click', () => { void showPosition(); });
  if (may.move) {
    $('register').hidden = false; $('move').hidden = false;
    whenChrome(() => { office().pickable($('m-branch'), 'store', { en: api.words('en', 'whichBranch'), ta: api.words('ta', 'whichBranch') }); });
    $('i-save').addEventListener('click', async () => {
      const out = await session.register({ packagingId: $('i-item').value, name: $('i-name').value, kind: $('i-kind').value, returnable: $('i-returnable').checked, chargeRupees: $('i-charge').value, taxPercent: $('i-tax').value, depositRupees: $('i-deposit').value });
      $('i-status').textContent = api.outcomeWords(lang, out);
    });
    $('m-record').addEventListener('click', async () => {
      // U1 · OB-698: the consequence-and-confirm sheet before the movement is recorded — Go back sends nothing.
      const kindWord = (l) => { const k = $('m-kind'); const opt = k.selectedOptions ? k.selectedOptions[0] : null; return l === lang && opt ? opt.textContent.trim() : (api.words(l, k.value) === k.value ? k.value : api.words(l, k.value)); };
      const sub = (l, key) => String(api.words(l, key)).replace('{qty}', $('m-qty').value).replace('{item}', $('m-item').value).replace('{kind}', kindWord(l)).replace('{branch}', $('m-branch').value);
      // An incomplete form skips the sheet and gets the session's own words on what is missing (nothing is sent either way).
      const complete = $('m-item').value.trim() !== '' && $('m-branch').value.trim() !== '' && $('m-kind').value !== '' && /^[1-9][0-9]*$/.test($('m-qty').value.trim());
      const answer = !complete ? { ok: true } : await confirmFirst({ title: { en: sub('en', 'confirmTitle'), ta: sub('ta', 'confirmTitle') }, detail: { en: sub('en', 'confirmDetail'), ta: sub('ta', 'confirmDetail') }, authority: { en: sub('en', 'confirmAuthority'), ta: sub('ta', 'confirmAuthority') }, confirmLabel: { en: sub('en', 'confirmLabel'), ta: sub('ta', 'confirmLabel') }, tone: 'primary' });
      if (answer === 'unavailable') { $('m-status').textContent = t('confirmUnavailable'); return; }
      if (answer === null) return;
      const out = await session.move({ packagingId: $('m-item').value, branchId: $('m-branch').value, kind: $('m-kind').value, qty: $('m-qty').value, reference: $('m-ref').value });
      $('m-status').textContent = api.outcomeWords(lang, out);
      if (out.result === 'ok' && position !== null && position.packagingId === $('m-item').value.trim()) await showPosition();
    });
  }
}
