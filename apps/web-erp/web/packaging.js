// Packaging and crates (M28-FR-03) — the page over head office's own packaging back office. The session
// (apps/web-erp/src/packaging-session.ts, in the bundle as window.packaging) does every call; this page lays out what it is
// told. Nothing is read on open; every write is a click. Every word has a Tamil twin; every button its icon.

const $ = (id) => document.getElementById(id);
const api = window.packaging ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, move: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
let position = null;

function fillSelect(id, values, prefix) {
  const sel = $(id); const keep = sel.value;
  sel.replaceChildren(...values.map((v) => { const o = document.createElement('option'); o.value = v; o.textContent = t(`${prefix}${v}`); return o; }));
  if (keep) sel.value = keep;
}
function figure(label, value, key) { const s = document.createElement('span'); s.dataset.figure = key; s.append(text('small', label), text('b', value)); return s; }
function paintPosition() {
  $('q-figures').replaceChildren(); $('q-negative').hidden = true;
  if (position === null) return;
  const p = position;
  $('q-negative').hidden = !p.negative; $('q-negative').textContent = `⚠ ${t('negativeWarn')}`;
  $('q-figures').append(
    figure(`${p.name} · ${t('onHand')}`, String(p.onHand), 'onHand'),
    figure(t('inCirculation'), String(p.inCirculation), 'inCirculation'),
    figure(t('issued'), String(p.issuedTotal), 'issued'),
    figure(t('returned'), String(p.returnedTotal), 'returned'),
    figure(t('writtenOff'), String(p.writtenOff), 'writtenOff'),
    figure(t('lossRate'), p.lossRateBps === 'not_meaningful' ? t('notMeaningful') : `${(p.lossRateBps / 100).toFixed(2)}%`, 'lossRate'),
  );
}
function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['position-h', 'positionH'], ['q-item-l', 'item'], ['q-branch-l', 'branch'], ['q-show-text', 'show'],
    ['register-h', 'registerH'], ['i-item-l', 'item'], ['i-name-l', 'name'], ['i-kind-l', 'kind'], ['i-charge-l', 'charge'], ['i-tax-l', 'tax'], ['i-deposit-l', 'deposit'], ['i-returnable-l', 'returnable'], ['i-save-text', 'register'],
    ['move-h', 'moveH'], ['m-item-l', 'item'], ['m-branch-l', 'branch'], ['m-kind-l', 'move'], ['m-qty-l', 'qty'], ['m-ref-l', 'reference'], ['m-record-text', 'recordMove']]) $(id).textContent = t(key);
  if (api !== null) { fillSelect('i-kind', api.kinds, 'k_'); fillSelect('m-kind', api.moves, 'm_'); }
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
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else {
  $('position').hidden = false;
  $('q-show').addEventListener('click', () => { void showPosition(); });
  if (may.move) {
    $('register').hidden = false; $('move').hidden = false;
    $('i-save').addEventListener('click', async () => {
      const out = await session.register({ packagingId: $('i-item').value, name: $('i-name').value, kind: $('i-kind').value, returnable: $('i-returnable').checked, chargeRupees: $('i-charge').value, taxPercent: $('i-tax').value, depositRupees: $('i-deposit').value });
      $('i-status').textContent = api.outcomeWords(lang, out);
    });
    $('m-record').addEventListener('click', async () => {
      const out = await session.move({ packagingId: $('m-item').value, branchId: $('m-branch').value, kind: $('m-kind').value, qty: $('m-qty').value, reference: $('m-ref').value });
      $('m-status').textContent = api.outcomeWords(lang, out);
      if (out.result === 'ok' && position !== null && position.packagingId === $('m-item').value.trim()) await showPosition();
    });
  }
}
