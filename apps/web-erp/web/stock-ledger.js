// Stock ledger — the view layer (U6 · §27 Inventory "Ledger" · M08-FR-01). Every word and the one request live in the TESTED
// session model (apps/web-erp/src/stock-ledger-session.ts, window.stockLedgerSession); this file draws what it is told on the
// shared office parts (window.sreOffice: pickable, shopDate, cards, table, state, chip) and sends the person's ask through it.

const $ = (id) => document.getElementById(id);
const session = window.stockLedgerSession ?? null;
let lang = 'en';
const t = (k) => (session === null ? k : session.text(lang, k));
const both = (k) => (session === null ? { en: k, ta: k } : { en: session.text('en', k), ta: session.text('ta', k) });
const office = () => (window.sreOffice && typeof window.sreOffice.table === 'function' ? window.sreOffice : null);

let ledger = null; // head office's last answer
let outcome = null; // why there is none

function say(el, out, good) {
  const s = session.say(lang, out, good);
  el.className = `status ${s.tone}`;
  el.textContent = s.words;
}
/** The signed-in person's own store, from the chrome — '' when not known. */
function myStore() {
  const o = window.sreOffice;
  const me = o && typeof o.me === 'function' ? o.me() : null;
  return (me && me.storeId) || (window.sreDirectory && window.sreDirectory.store && window.sreDirectory.store.id) || '';
}
const nameOf = (kind, id) => { const o = window.sreOffice; const n = o && typeof o.nameOf === 'function' ? o.nameOf(kind, id) : null; return n && n !== id ? `${n} (${id})` : id; };
const dateOf = (id) => { const o = window.sreOffice; return o && typeof o.dateOf === 'function' ? (o.dateOf(id) ?? '') : ($(id)?.value ?? ''); };

function paintFigures() {
  const o = office();
  const figures = $('figures-section');
  if (ledger === null) { figures.hidden = true; return; }
  figures.hidden = false;
  if (o === null) { $('cards').textContent = ledger.places.map((p) => `${nameOf('place', p.locationId)}: ${p.onHandMinor}`).join(' · '); return; }
  const uom = ledger.lines[0]?.uom ?? '';
  o.cards($('cards'), [
    ...ledger.places.map((p) => ({ label: `${t('onHandH')} ${t('onHandAt')} ${nameOf('place', p.locationId)}`, value: session.lineView(lang, { effect: 1, quantityMinor: p.onHandMinor, uom, balanceAfterMinor: p.onHandMinor }).balance, icon: 'package', tone: p.onHandMinor < 0 ? 'error' : undefined })),
    { label: t('movementsShown'), value: ledger.count, icon: 'list' },
    { label: t('cameIn'), value: `+${ledger.inMinor}`, tone: 'ok' },
    { label: t('wentOut'), value: `−${ledger.outMinor}`, tone: 'idle' },
    { label: t('everH'), value: ledger.movementsEver },
  ]);
  $('covers').textContent = t('covers');
  $('as-at').textContent = `${t('asAt')} ${session.shopMomentOf(ledger.asAt)}`;
}

function paintLines() {
  const o = office();
  const host = $('lines');
  const sec = $('lines-section');
  if (outcome !== null) {
    sec.hidden = false; host.replaceChildren();
    if (o !== null) o.state(host, o.stateOf(outcome), { title: session.say(lang, outcome).words }); else host.textContent = session.say(lang, outcome).words;
    return;
  }
  if (ledger === null) { sec.hidden = true; host.replaceChildren(); return; }
  sec.hidden = false; host.replaceChildren();
  if (ledger.lines.length === 0) {
    const never = ledger.movementsEver === 0;
    if (o !== null) o.state(host, 'empty', { title: t(never ? 'neverMoved' : 'empty'), detail: t(never ? 'neverMovedDetail' : 'emptyDetail') }); else host.textContent = t(never ? 'neverMoved' : 'empty');
    return;
  }
  if (o === null) { host.replaceChildren(...ledger.lines.map((l) => { const v = session.lineView(lang, l); const p = document.createElement('p'); p.textContent = `${v.when} · ${v.kindWord} · ${v.quantity} · ${v.balance}`; return p; })); return; }
  const rows = ledger.lines.map((l) => session.lineView(lang, l));
  o.table(host, {
    id: 'ledger', label: both('linesH'), rows, pageSize: 20, sortable: true,
    rowKey: (r) => r.movementId, rowData: (r) => ({ movement: r.movementId, kind: r.kind, effect: r.effect > 0 ? 'in' : 'out' }),
    columns: [
      { key: 'when', label: both('colWhen'), sort: 'text' },
      { key: 'kindWord', label: both('colKind'), sort: 'text', render: (r) => o.chip(r.tone, r.kindWord) },
      { key: 'quantity', label: both('colQty'), align: 'end', sort: false },
      { key: 'balance', label: both('colBalance'), align: 'end', sort: false },
      { key: 'locationId', label: both('colPlace'), sort: 'text', value: (r) => nameOf('place', r.locationId) },
      { key: 'batchWord', label: both('colBatch'), sort: false },
      { key: 'reasonWord', label: both('colReason'), sort: false },
      { key: 'enteredBy', label: both('colBy'), sort: 'text', value: (r) => nameOf('person', r.enteredBy) },
      { key: 'approvedWord', label: both('colApproved'), sort: false, value: (r) => (r.approvedBy === null ? r.approvedWord : nameOf('person', r.approvedBy)) },
    ],
    empty: { title: t('empty'), detail: t('emptyDetail') },
  });
}

async function show() {
  outcome = null;
  $('ask-status').className = 'status'; $('ask-status').textContent = t('reading');
  const out = await session.read({ productId: $('product').value, locationId: $('place').value, fromIso: dateOf('from'), toIso: dateOf('to') });
  if (out.result === 'ok') { ledger = out.ledger; $('ask-status').textContent = ''; }
  else { ledger = null; outcome = out.result === 'invalid' ? null : out; say($('ask-status'), out); }
  paintFigures(); paintLines();
}

function paintWords() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['who', 'title'], ['page-h', 'title'], ['lede', 'lede'], ['ask-h', 'title'], ['l-product', 'product'], ['l-place', 'place'], ['l-from', 'from'], ['l-to', 'to'], ['show', 'show'], ['figures-h', 'onHandH'], ['lines-h', 'linesH']]) {
    const el = $(id); if (el) el.textContent = t(k);
  }
  $('all-places').textContent = `${t('place')}: ${t('allPlaces')} — ${t('choose')}`;
  const nobody = $('nobody');
  nobody.hidden = !(session === null || session.nobody);
  nobody.textContent = t('nobody');
  if (session !== null && !session.nobody && !session.may.read) { $('ask-status').className = 'status err'; $('ask-status').textContent = t('cannotRead'); $('show').disabled = true; $('show').title = t('cannotRead'); }
  $('ask-section').hidden = session === null || session.nobody;
}

function mountParts() {
  const o = window.sreOffice;
  if (!o || typeof o.pickable !== 'function') return;
  o.pickable('product', 'product', both('whichProduct'), { allowCode: true });
  o.pickable('place', 'place', both('whichPlace'), { allowCode: true, scope: () => ({ storeId: myStore() }) });
  if (typeof o.shopDate === 'function') { o.shopDate('from', both('from')); o.shopDate('to', both('to')); }
}

if (session !== null) {
  $('show').addEventListener('click', () => { void show(); });
  $('ask').addEventListener('submit', (e) => { e.preventDefault(); void show(); });
  $('lang').addEventListener('click', () => {
    lang = lang === 'en' ? 'ta' : 'en';
    document.documentElement.lang = lang;
    paintWords(); paintFigures(); paintLines();
  });
}
paintWords();
document.addEventListener('sre:chrome', () => { mountParts(); paintFigures(); paintLines(); }, { once: true });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
