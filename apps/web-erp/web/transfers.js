// Transfers — the view layer (WF-07 · M09-FR-03). Every rule lives at head office; every word and every request lives in
// the TESTED session model (apps/web-erp/src/transfers-session.ts), attached as window.transfersSession. This file draws
// the register and the record drawer and sends a person's click — send it, count it in, settle the shortfall — once, in
// their own session, then reads head office again. Nothing is priced here: the cost is head office's.

/** OB-31: a held quantity (the unit's smallest step) as a person reads it — 2500 of a kg product reads "2.500 kg". */
const qtyText = (n, uom) => (window.sreQuantity?.label ? window.sreQuantity.label(n, uom ?? '') : `${n} ${uom ?? ''}`.trim());
const $ = (id) => document.getElementById(id);
const session = window.transfersSession ?? null;
let lang = 'en';
const t = (k) => (session === null ? k : session.text(lang, k));

// U1 · OB-698 (design system §1.3, §27.1): a stock-moving click asks the shared consequence-and-confirm sheet first.
// `null` = the person went back (nothing is sent); 'unavailable' = the sheet could not open (said, never silent).
async function confirmFirst(spec) {
  const office = window.sreOffice;
  if (!office || typeof office.confirm !== 'function') return 'unavailable';
  const answer = await office.confirm(spec);
  return answer && answer.ok === true ? answer : null;
}

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

// U5 · G17: the chrome's shared parts — the office (window.sreOffice) may load after this page, so each part is drawn
// when it is there (`sre:chrome`), and the page keeps working with words alone until then.
const office = () => window.sreOffice ?? null;
const whenChrome = (fn) => { if (window.sreOffice) fn(); else document.addEventListener('sre:chrome', fn, { once: true }); };
const both = (k) => ({ en: session.text('en', k), ta: session.text('ta', k) });
let register = null;

/** The four figures as summary cards: a count the page has not read yet is "Not known", never a dash. */
function paintPanels() {
  const o = office(); if (!o || session === null) return;
  const n = (f) => (rows === null ? null : rows.filter(f).length);
  const short = n((r) => r.shortfallOpen);
  o.cards($('panels'), [
    { label: both('proposed'), value: n((r) => r.transfer.state === 'proposed'), tone: 'pending' },
    { label: both('in_transit'), value: n((r) => r.transfer.state === 'in_transit'), tone: 'pending' },
    { label: both('received'), value: n((r) => r.transfer.state === 'received'), tone: 'ok' },
    { label: both('shortOpen'), value: short, tone: short === null ? undefined : short > 0 ? 'degraded' : 'ok' },
  ]);
}

/** The register, drawn once on the chrome's shared part: the row's state as the one chip, "View" opens this page's drawer. */
function ensureRegister() {
  const o = office(); if (!o || session === null || register !== null) return register;
  const linesText = (r) => session.rowView(lang, r).lines.map((l) => `${l.productId} × ${qtyText(l.quantityMinor, l.uom)}`).join(', ');
  register = o.table($('register'), {
    id: 'transfers', label: both('registerH'), pageSize: 10, sortable: true, rows: null,
    rowKey: (r) => r.transfer.transferId,
    rowData: (r) => ({ transfer: r.transfer.transferId, state: r.transfer.state }),
    empty: { title: both('empty'), detail: both('registerLede') },
    columns: [
      { key: 'transfer', label: both('colTransfer'), value: (r) => r.transfer.transferId },
      { key: 'route', label: both('colRoute'), value: (r) => session.rowView(lang, r).route },
      { key: 'lines', label: both('colLines'), sort: false, value: linesText },
      { key: 'state', label: both('colState'), filter: true, value: (r) => session.rowView(lang, r).stateWord,
        render: (r) => { const v = session.rowView(lang, r); const cell = node('span', { className: 'state-cell' }, o.recordChip(v.state, v.stateWord)); if (v.flags.length > 0) cell.append(node('span', { className: 'muted', textContent: ` · ${v.flags.join(' · ')}` })); return cell; } },
      { key: 'view', label: both('view'), sort: false, value: () => '', render: (r) => { const look = node('button', { type: 'button', className: 'sre-btn sre-btn-quiet', textContent: t('view'), dataset: { act: 'view' } }); look.addEventListener('click', () => { openDrawer(r.transfer.transferId); }); return look; } },
    ],
  });
  return register;
}

function paintRegister() {
  paintPanels();
  if (ensureRegister() === null) return;
  register.setRows(rows);
}

async function loadList() {
  if (session === null || session.nobody) return;
  if (!session.may.read) { $('list-status').className = 'status'; $('list-status').textContent = t('cannotRead'); ensureRegister()?.setState('denied', { detail: both('cannotRead') }); return; }
  const out = await session.list();
  if (out.result === 'ok') { rows = out.rows; if ($('list-status').textContent === t('reading')) $('list-status').textContent = ''; paintRegister(); }
  else { rows = null; say($('list-status'), out); paintPanels(); const o = office(); if (ensureRegister() !== null) register.setState(o.stateOf(out), { detail: session.say(lang, out, false).words }); }
  paintDrawer();
}

function paintDrawer() {
  if (currentId === null) return;
  const row = rows?.find((r) => r.transfer.transferId === currentId);
  $('d-title').textContent = currentId;
  if (row === undefined) return;
  const v = session.rowView(lang, row);
  // U1 · L: where it stands as a chip from the one icon set — the tone's shape AND the word, never colour alone.
  const chipTone = v.tone === 'degraded' ? 'pending' : v.tone;
  const chip = window.sreIcon && typeof window.sreIcon.chip === 'function' ? window.sreIcon.chip({ tone: chipTone, label: v.stateWord }) : node('span', { className: 'sre-chip', textContent: v.stateWord });
  $('d-state').replaceChildren(chip, ...(v.flags.length === 0 ? [] : [node('span', { textContent: ` · ${v.flags.join(' · ')}` })]));
  $('d-state').dataset.state = v.state;
  $('d-route').textContent = v.route;
  $('d-people').textContent = v.people.join(' · ');
  $('d-lines').replaceChildren(...v.lines.map((l) => node('li', { dataset: { product: l.productId } },
    node('b', { textContent: `${l.productId}${l.batchId === null ? '' : ` (${l.batchId})`} — ${qtyText(l.quantityMinor, l.uom)}` }),
    node('span', { className: 'muted', textContent: l.cost === null ? t('costUnknown') : `${t('costEach')} ${l.cost}` }))));

  $('d-dispatch-box').hidden = !(v.canDispatch && session.may.move);
  $('d-cancel-box').hidden = !(v.canCancel && session.may.move);
  $('d-receive-box').hidden = !(v.canReceive && session.may.move);
  $('d-receive-lines').replaceChildren(...v.lines.map((l, i) => node('li', { dataset: { product: l.productId } },
    node('b', { textContent: `${l.productId} — ${t('sent')} ${qtyText(l.quantityMinor, l.uom)}` }),
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
    ['d-lines-h', 'linesH'], ['d-dispatch-note', 'dispatchNote'], ['d-dispatch', 'dispatch'],
    ['d-cancel-h', 'cancelH'], ['d-cancel-note', 'cancelNote'], ['l-d-cancel-reason', 'cancelReason'], ['d-cancel', 'cancel'], ['d-receive-h', 'receiveH'], ['d-receive-note', 'receiveNote'], ['d-receive', 'receive'],
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
    $('d-status').textContent = ''; $('d-status').className = 'status';
    // U1 · OB-698: the consequence-and-confirm sheet before stock leaves the store — Go back sends nothing.
    const row = currentRow();
    if (row === undefined) return;
    const v = session.rowView(lang, row);
    const linesText = v.lines.map((l) => `${l.productId} × ${qtyText(l.quantityMinor, l.uom)}`).join(', ');
    const spec = (l) => ({
      title: session.text(l, 'confirmSendTitle').replace('{lines}', linesText).replace('{route}', session.rowView(l, row).route),
      detail: session.text(l, 'confirmSendDetail'), authority: session.text(l, 'confirmSendAuthority'), confirmLabel: session.text(l, 'confirmSendLabel'),
    });
    const answer = await confirmFirst({ title: { en: spec('en').title, ta: spec('ta').title }, detail: { en: spec('en').detail, ta: spec('ta').detail }, authority: { en: spec('en').authority, ta: spec('ta').authority }, confirmLabel: { en: spec('en').confirmLabel, ta: spec('ta').confirmLabel }, tone: 'primary' });
    if (answer === 'unavailable') { $('d-status').className = 'status err'; $('d-status').textContent = t('confirmUnavailable'); return; }
    if (answer === null) return;
    const out = await session.dispatch(currentId); await loadList(); say($('d-status'), out); });
  $('d-cancel').addEventListener('click', async () => {
    $('d-status').textContent = ''; $('d-status').className = 'status';
    const out = await session.cancel(currentId, $('d-cancel-reason').value);
    if (out.result !== 'invalid') { $('d-cancel-reason').value = ''; await loadList(); }
    say($('d-status'), out);
  });
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
    if (register !== null) register.repaint();
  });
}

paintWords();
whenChrome(() => { paintRegister(); });
if (session !== null && !session.nobody) { $('list-status').textContent = t('reading'); void loadList(); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
