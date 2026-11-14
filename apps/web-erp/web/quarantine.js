// Quarantine — the view layer (U6 · §27 Inventory "Quarantine" · M07-FR-03 · M10-FR-02 · §28). Every word, every request and
// every cheap check live in the TESTED session model (apps/web-erp/src/quarantine-session.ts, window.quarantineSession); this
// file draws what it is told on the shared office parts (window.sreOffice) and sends a person's click through it — a hold or a
// release behind the shared confirm sheet (OB-698: stock stops or starts being sellable) — then reads head office again.

const $ = (id) => document.getElementById(id);
const session = window.quarantineSession ?? null;
let lang = 'en';
const t = (k) => (session === null ? k : session.text(lang, k));
const both = (k) => (session === null ? { en: k, ta: k } : { en: session.text('en', k), ta: session.text('ta', k) });
const office = () => (window.sreOffice && typeof window.sreOffice.table === 'function' ? window.sreOffice : null);

let register = null; // head office's last answer
let outcome = null; // why there is none

function say(el, out, good) { const s = session.say(lang, out, good); el.className = `status ${s.tone}`; el.textContent = s.words; }
const nameOf = (kind, id) => { const o = window.sreOffice; const n = o && typeof o.nameOf === 'function' ? o.nameOf(kind, id) : null; return n && n !== id ? `${n} (${id})` : id; };
/** U1 · G3: a greyed button says why (title + the line beside it), never a dead end. */
function whyDisabled(btn, words) {
  btn.disabled = words !== '';
  btn.title = words;
  let note = btn.nextElementSibling;
  if (!(note && note.classList.contains('sre-why'))) { note = document.createElement('small'); note.className = 'sre-why'; note.id = `${btn.id}-why`; btn.after(note); }
  note.textContent = words; note.hidden = words === '';
  if (words !== '') btn.setAttribute('aria-describedby', note.id); else btn.removeAttribute('aria-describedby');
}
// U1 · OB-698: a stock click asks the shared consequence-and-confirm sheet first. `null` = went back; 'unavailable' = no sheet.
async function confirmFirst(spec) {
  const o = window.sreOffice;
  if (!o || typeof o.confirm !== 'function') return 'unavailable';
  const answer = await o.confirm(spec);
  return answer && answer.ok === true ? answer : null;
}

function paintCards() {
  const o = office();
  if (register === null || o === null) { $('cards').replaceChildren(); $('covers').textContent = ''; $('as-at').textContent = ''; return; }
  const c = register.counts;
  o.cards($('cards'), [
    { label: both('batchesHeld'), value: c.batchesHeld, tone: c.batchesHeld > 0 ? 'pending' : undefined, icon: 'package' },
    { label: both('batchesFailed'), value: c.batchesFailed, tone: c.batchesFailed > 0 ? 'error' : undefined, icon: 'triangle-alert' },
    { label: both('receiptLines'), value: c.receiptLines, tone: c.receiptLines > 0 ? 'pending' : undefined, icon: 'truck' },
    { label: both('releasedN'), value: c.released, icon: 'check' },
  ]);
  $('covers').textContent = t('covers');
  $('as-at').textContent = `${t('asAt')} ${session.shopMomentOf(register.asAt)}`;
}

function stateOrNull(host) {
  const o = office();
  if (outcome !== null) { host.replaceChildren(); if (o !== null) o.state(host, o.stateOf(outcome), { title: session.say(lang, outcome).words }); else host.textContent = session.say(lang, outcome).words; return true; }
  if (register === null) { host.replaceChildren(); if (o !== null) o.state(host, 'loading'); return true; }
  if (o === null) return true;
  return false;
}

async function release(batchId) {
  const spec = { title: both('confirmReleaseTitle'), detail: both('confirmReleaseDetail'), authority: both('authorityRelease'), confirmLabel: both('release'), tone: 'primary' };
  for (const k of ['title', 'detail']) for (const l of ['en', 'ta']) spec[k][l] = spec[k][l].split('{batch}').join(batchId);
  const answer = await confirmFirst(spec);
  if (answer === 'unavailable') { $('holds-status').className = 'status err'; $('holds-status').textContent = t('confirmUnavailable'); return; }
  if (answer === null) return;
  const out = await session.release(batchId);
  say($('holds-status'), out, 'releasedNow');
  if (out.result === 'ok') await load();
}

function paintHolds() {
  const host = $('holds');
  if (stateOrNull(host)) return;
  const o = office();
  const rows = register.holds.map((h) => session.holdView(lang, h));
  host.replaceChildren();
  if (rows.length === 0) { o.state(host, 'empty', { title: t('emptyHolds'), detail: t('emptyHoldsDetail') }); return; }
  o.table(host, {
    id: 'holds', label: both('holdsH'), rows, pageSize: 10, sortable: true,
    rowKey: (r) => r.batchId, rowData: (r) => ({ batch: r.batchId, status: r.status }),
    columns: [
      { key: 'batchId', label: both('batch'), sort: 'text' },
      { key: 'productId', label: both('product'), sort: 'text', value: (r) => nameOf('product', r.productId) },
      { key: 'stateWord', label: both('state'), sort: 'text', render: (r) => o.recordChip(r.status, r.stateWord) },
      { key: 'reason', label: both('reason'), sort: false },
      { key: 'since', label: both('since'), sort: 'text' },
      { key: 'heldBy', label: both('heldBy'), sort: 'text', value: (r) => (r.equipmentWord !== null ? `${t('equipment')}: ${r.equipmentWord}` : nameOf('person', r.heldBy)) },
      { key: 'act', label: both('release'), sort: false, render: (r) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'sre-btn sre-btn-quiet'; b.id = `rel-${r.batchId}`; b.textContent = t('release'); b.dataset.act = 'release';
        b.addEventListener('click', () => { void release(r.batchId); });
        const wrap = document.createElement('span'); wrap.append(b);
        if (!session.may.release) { whyDisabled(b, t('cannotRelease')); }
        return wrap;
      } },
    ],
    empty: { title: t('emptyHolds'), detail: t('emptyHoldsDetail') },
  });
}

function paintLines() {
  const host = $('lines');
  if (stateOrNull(host)) return;
  const o = office();
  const rows = register.lines.map((l) => session.lineView(lang, l));
  host.replaceChildren();
  if (rows.length === 0) { o.state(host, 'empty', { title: t('emptyLines'), detail: t('emptyLinesDetail') }); return; }
  o.table(host, {
    id: 'lines', label: both('linesH'), rows, pageSize: 10, sortable: true,
    rowKey: (r) => `${r.grnId}:${r.lineId}`, rowData: (r) => ({ grn: r.grnId, line: r.lineId, product: r.productId }),
    columns: [
      { key: 'number', label: both('receipt'), sort: 'text' },
      { key: 'productId', label: both('product'), sort: 'text', value: (r) => nameOf('product', r.productId) },
      { key: 'quantity', label: both('quantity'), align: 'end', sort: false },
      { key: 'conditionWord', label: both('condition'), sort: 'text', render: (r) => o.chip('pending', r.conditionWord) },
      { key: 'warehouseId', label: both('place'), sort: 'text', value: (r) => nameOf('place', r.warehouseId) },
      { key: 'batchWord', label: both('batch'), sort: false },
      { key: 'expiryWord', label: both('expiry'), sort: false },
      { key: 'since', label: both('since'), sort: 'text' },
      { key: 'receivedBy', label: both('receivedBy'), sort: 'text', value: (r) => nameOf('person', r.receivedBy) },
    ],
    empty: { title: t('emptyLines'), detail: t('emptyLinesDetail') },
  });
}

function paintReleased() {
  const host = $('released');
  if (stateOrNull(host)) return;
  const o = office();
  const rows = register.released.map((h) => session.holdView(lang, h));
  host.replaceChildren();
  if (rows.length === 0) { o.state(host, 'empty', { title: t('emptyReleased'), detail: t('emptyReleasedDetail') }); return; }
  o.table(host, {
    id: 'released', label: both('releasedH'), rows, pageSize: 10, sortable: true,
    rowKey: (r) => r.batchId, rowData: (r) => ({ batch: r.batchId, status: r.status }),
    columns: [
      { key: 'batchId', label: both('batch'), sort: 'text' },
      { key: 'productId', label: both('product'), sort: 'text', value: (r) => nameOf('product', r.productId) },
      { key: 'stateWord', label: both('state'), sort: 'text', render: (r) => o.recordChip(r.status, r.stateWord) },
      { key: 'releasedWhen', label: both('releasedAt'), sort: 'text', value: (r) => r.releasedWhen ?? '—' },
      { key: 'releasedBy', label: both('releasedBy'), sort: 'text', value: (r) => (r.releasedBy === undefined ? '—' : nameOf('person', r.releasedBy)) },
    ],
    empty: { title: t('emptyReleased'), detail: t('emptyReleasedDetail') },
  });
}

function paintAll() { paintCards(); paintHolds(); paintLines(); paintReleased(); }

async function load() {
  if (session === null || session.nobody || !session.may.read) return;
  outcome = null;
  const out = await session.read();
  if (out.result === 'ok') { register = out.register; $('read-status').textContent = ''; $('read-status').className = 'status'; }
  else { register = null; outcome = out; say($('read-status'), out); }
  paintAll();
}

async function hold() {
  $('new-status').className = 'status'; $('new-status').textContent = '';
  const form = { batchId: $('batch').value, productId: $('product').value, reason: $('reason').value };
  // The cheap checks first (the session says what is missing); the sheet only once there is something to send.
  if (form.batchId.trim() === '' || form.productId.trim() === '' || form.reason.trim() === '') { say($('new-status'), { result: 'invalid', key: form.batchId.trim() === '' ? 'needBatch' : form.productId.trim() === '' ? 'needProduct' : 'needReason' }); return; }
  const product = nameOf('product', form.productId.trim());
  const spec = { title: both('confirmHoldTitle'), detail: both('confirmHoldDetail'), authority: both('authorityHold'), confirmLabel: both('hold'), tone: 'danger' };
  for (const k of ['title', 'detail']) for (const l of ['en', 'ta']) spec[k][l] = spec[k][l].split('{batch}').join(form.batchId.trim()).split('{product}').join(product);
  const answer = await confirmFirst(spec);
  if (answer === 'unavailable') { $('new-status').className = 'status err'; $('new-status').textContent = t('confirmUnavailable'); return; }
  if (answer === null) return;
  const out = await session.hold(form);
  say($('new-status'), out, out.result === 'ok' && out.alreadyHeld ? 'alreadyHeld' : 'heldNow');
  if (out.result === 'ok') { $('batch').value = ''; $('reason').value = ''; await load(); }
}

function paintWords() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['who', 'title'], ['page-h', 'title'], ['lede', 'lede'], ['new-h', 'newH'], ['new-lede', 'newLede'], ['l-batch', 'batch'], ['l-product', 'product'], ['l-reason', 'reason'], ['hold', 'hold'],
    ['holds-h', 'holdsH'], ['holds-lede', 'holdsLede'], ['lines-h', 'linesH'], ['lines-lede', 'linesLede'], ['released-h', 'releasedH'], ['released-lede', 'releasedLede']]) {
    const el = $(id); if (el) el.textContent = t(k);
  }
  const nobody = $('nobody');
  nobody.hidden = !(session === null || session.nobody);
  nobody.textContent = t('nobody');
  const signed = session !== null && !session.nobody;
  // P-07: the hold form is offered only to a person who may place a hold; the register itself stays readable.
  $('new-section').hidden = !(signed && session.may.hold);
  if (signed && !session.may.read) { $('read-status').className = 'status err'; $('read-status').textContent = t('cannotRead'); }
}

function mountParts() {
  const o = window.sreOffice;
  if (!o || typeof o.pickable !== 'function') return;
  o.pickable('product', 'product', both('whichProduct'), { allowCode: true });
}

if (session !== null) {
  $('hold').addEventListener('click', () => { void hold(); });
  $('new').addEventListener('submit', (e) => { e.preventDefault(); void hold(); });
  $('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paintWords(); paintAll(); });
}
paintWords();
document.addEventListener('sre:chrome', () => { mountParts(); paintAll(); void load(); }, { once: true });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
