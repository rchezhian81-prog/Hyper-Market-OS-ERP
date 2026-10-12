// Transfers — the view layer (WF-07 · M09-FR-03). Every rule lives at head office; every word and every request lives in
// the TESTED session model (apps/web-erp/src/transfers-session.ts), attached as window.transfersSession. This file draws
// the register and the record drawer and sends a person's click — send it, count it in, settle the shortfall — once, in
// their own session, then reads head office again. Nothing is priced here: the cost is head office's.

const $ = (id) => document.getElementById(id);
const session = window.transfersSession ?? null;
let lang = 'en';
const t = (k) => (session === null ? k : session.text(lang, k));

let rows = null;
let currentId = null;

function say(el, out, good) {
  const s = session.say(lang, out, good);
  el.className = `status ${s.tone}`;
  el.textContent = s.words;
}
const node = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids.filter((x) => x !== null && x !== undefined));
  return el;
};

function paintPanels() {
  const n = (f) => (rows === null ? '–' : String(rows.filter(f).length));
  $('n-proposed').textContent = n((r) => r.transfer.state === 'proposed');
  $('n-in_transit').textContent = n((r) => r.transfer.state === 'in_transit');
  $('n-received').textContent = n((r) => r.transfer.state === 'received');
  $('n-short').textContent = n((r) => r.shortfallOpen);
  for (const [id, k] of [['p-proposed', 'proposed'], ['p-in_transit', 'in_transit'], ['p-received', 'received'], ['p-short', 'shortOpen']]) $(id).textContent = t(k);
}

function paintRegister() {
  const body = $('register').querySelector('tbody');
  body.replaceChildren();
  paintPanels();
  if (rows === null) return;
  if (rows.length === 0) { body.append(node('tr', {}, node('td', { colSpan: 5, className: 'muted', textContent: t('empty') }))); return; }
  for (const r of rows) {
    const v = session.rowView(lang, r);
    const look = node('button', { type: 'button', className: 'quiet', textContent: t('view'), dataset: { act: 'view' } });
    look.addEventListener('click', () => { openDrawer(v.transferId); });
    body.append(node('tr', { className: `tone-${v.tone}`, dataset: { transfer: v.transferId, state: v.state } },
      node('td', { textContent: v.transferId }), node('td', { textContent: v.route }),
      node('td', { textContent: v.lines.map((l) => `${l.productId} ×${l.quantityMinor} ${l.uom}`).join(', ') }),
      node('td', { textContent: [v.stateWord, ...v.flags].join(' · ') }), node('td', {}, look)));
  }
}

async function loadList() {
  if (session === null || session.nobody) return;
  if (!session.may.read) { $('list-status').className = 'status'; $('list-status').textContent = t('cannotRead'); return; }
  const out = await session.list();
  if (out.result === 'ok') { rows = out.rows; if ($('list-status').textContent === t('reading')) $('list-status').textContent = ''; }
  else { rows = null; say($('list-status'), out); }
  paintRegister();
  paintDrawer();
}

function paintDrawer() {
  if (currentId === null) return;
  const row = rows?.find((r) => r.transfer.transferId === currentId);
  $('d-title').textContent = currentId;
  if (row === undefined) return;
  const v = session.rowView(lang, row);
  $('d-state').textContent = [v.stateWord, ...v.flags].join(' · ');
  $('d-state').dataset.state = v.state;
  $('d-route').textContent = v.route;
  $('d-people').textContent = v.people.join(' · ');
  $('d-lines').replaceChildren(...v.lines.map((l) => node('li', { dataset: { product: l.productId } },
    node('b', { textContent: `${l.productId}${l.batchId === null ? '' : ` (${l.batchId})`} — ${l.quantityMinor} ${l.uom}` }),
    node('span', { className: 'muted', textContent: l.cost === null ? t('costUnknown') : `${t('costEach')} ${l.cost}` }))));

  $('d-dispatch-box').hidden = !(v.canDispatch && session.may.move);
  $('d-receive-box').hidden = !(v.canReceive && session.may.move);
  $('d-receive-lines').replaceChildren(...v.lines.map((l, i) => node('li', { dataset: { product: l.productId } },
    node('b', { textContent: `${l.productId} — ${t('sent')} ${l.quantityMinor} ${l.uom}` }),
    node('input', { className: 'arrived', inputMode: 'numeric', autocomplete: 'off', 'aria-label': `${t('arrived')}: ${l.productId}`, placeholder: t('arrived'), dataset: { index: String(i) } }))));

  $('d-short-box').hidden = v.shortfall.length === 0;
  const resolving = v.canResolve && session.may.resolve;
  $('d-short').replaceChildren(...v.shortfall.map((s, i) => {
    const li = node('li', { className: v.canResolve ? 'tone-error' : 'tone-ok', dataset: { product: s.productId } },
      node('b', { textContent: `${s.productId} — ${s.quantityMinor} ${t('missing')} · ${t('worth')} ${s.worth}` }));
    if (resolving) {
      const at = node('select', { className: 'found-at', 'aria-label': `${t('foundAt')}: ${s.productId}`, dataset: { index: String(i) } },
        node('option', { value: 'destination', textContent: t('destination') }), node('option', { value: 'source', textContent: t('source') }));
      li.append(node('div', { className: 'inline' },
        node('input', { className: 'found', inputMode: 'numeric', value: '0', autocomplete: 'off', 'aria-label': `${t('foundQty')}: ${s.productId}`, dataset: { index: String(i) } }), at));
    }
    return li;
  }));
  if (row.transfer.shortfallResolution !== undefined) {
    for (const l of row.transfer.shortfallResolution.lines) {
      $('d-short').append(node('li', { className: 'muted', textContent: `${l.productId}: ${l.foundMinor} ${t('found').toLowerCase()} · ${l.lostMinor} ${t('lost')} (${session.rupees(l.lostValueMinor)}) — ${row.transfer.shortfallResolution.note}` }));
    }
  }
  $('d-resolve-box').hidden = !resolving;
}

function openDrawer(id) {
  currentId = id;
  $('d-status').textContent = '';
  $('d-note').value = '';
  $('drawer').hidden = false;
  paintDrawer();
  $('d-close').focus();
}
const currentRow = () => rows?.find((r) => r.transfer.transferId === currentId);

function paintWords() {
  document.title = `SRE ${t('title')}`;
  const map = [['who', 'title'], ['title', 'title'], ['lede', 'lede'], ['reg-h', 'registerH'], ['reg-lede', 'registerLede'], ['c-transfer', 'colTransfer'], ['c-route', 'colRoute'], ['c-lines', 'colLines'], ['c-state', 'colState'],
    ['d-lines-h', 'linesH'], ['d-dispatch-note', 'dispatchNote'], ['d-dispatch', 'dispatch'], ['d-receive-h', 'receiveH'], ['d-receive-note', 'receiveNote'], ['d-receive', 'receive'],
    ['d-short-h', 'shortH'], ['d-resolve-h', 'resolveH'], ['d-resolve-note', 'resolveNote'], ['l-d-reason-code', 'reasonCode'], ['l-d-note', 'note'], ['d-resolve', 'resolve']];
  for (const [id, k] of map) { const el = $(id); if (el) el.textContent = t(k); }
  $('d-close').setAttribute('aria-label', t('close'));
  const sel = $('d-reason-code');
  const was = sel.value;
  sel.replaceChildren(...['miscount', 'theft_suspected', 'damaged', 'expired', 'found', 'other'].map((c) => node('option', { value: c, textContent: t(c) })));
  if (was !== '') sel.value = was;
  if (session !== null && !session.nobody && !session.may.read) { $('list-status').className = 'status'; $('list-status').textContent = t('cannotRead'); }
  const nobody = $('nobody');
  nobody.hidden = !(session === null || session.nobody);
  nobody.textContent = t('nobody');
}

if (session !== null) {
  $('d-dispatch').addEventListener('click', async () => {
    $('d-status').textContent = ''; $('d-status').className = 'status'; const out = await session.dispatch(currentId); await loadList(); say($('d-status'), out); });
  $('d-receive').addEventListener('click', async () => {
    $('d-status').textContent = ''; $('d-status').className = 'status';
    const row = currentRow();
    if (row === undefined) return;
    const arrived = row.transfer.lines.map((_, i) => $('d-receive-lines').querySelector(`input.arrived[data-index="${i}"]`)?.value ?? '');
    const out = await session.receive(row.transfer, arrived);
    if (out.result !== 'invalid') await loadList();
    say($('d-status'), out);
  });
  $('d-resolve').addEventListener('click', async () => {
    $('d-status').textContent = ''; $('d-status').className = 'status';
    const row = currentRow();
    if (row === undefined) return;
    const found = row.shortfall.map((_, i) => ({
      text: $('d-short').querySelector(`input.found[data-index="${i}"]`)?.value ?? '0',
      at: $('d-short').querySelector(`select.found-at[data-index="${i}"]`)?.value === 'source' ? 'source' : 'destination',
    }));
    const out = await session.resolve(row, { reasonCode: $('d-reason-code').value, note: $('d-note').value, found });
    if (out.result !== 'invalid') await loadList();
    say($('d-status'), out);
  });
  $('d-close').addEventListener('click', () => { $('drawer').hidden = true; currentId = null; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('drawer').hidden) { $('drawer').hidden = true; currentId = null; } });
  $('lang').addEventListener('click', () => {
    lang = lang === 'en' ? 'ta' : 'en';
    document.documentElement.lang = lang;
    paintWords();
    paintRegister();
    paintDrawer();
  });
}

paintWords();
paintPanels();
if (session !== null && !session.nobody) { $('list-status').textContent = t('reading'); void loadList(); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
