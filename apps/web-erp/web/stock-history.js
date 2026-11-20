// Stock history — the view of four sections (batch 20b): EARLIER WRITE-OFFS on Waste & write-off (S2), EARLIER COUNTS and
// their accuracy on Stock counts (S3), WHAT THE EMPTY SHELVES COST on Stock health (S4), SUGGESTED TRANSFERS on Transfers
// (S5). Every word and every read live in the TESTED session model (apps/web-erp/src/stock-history-session.ts, attached as
// window.pastWriteOffsSession / countHistorySession / stockoutSession / transferSuggestionsSession and window.stockHistory).
// This file draws the section the page has a host for, reads only when a person presses Show (or opens the section), and
// lists with the chrome's shared list. "Start this transfer" only FILLS the page's own Start-a-transfer form — it sends
// nothing (P-05). No prompt/confirm/alert.

const $ = (id) => document.getElementById(id);
const SH = window.stockHistory ?? null;
const office = () => window.sreOffice ?? null;
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const w = (k) => SH.words(lang(), k);
const both = (k) => ({ en: SH.words('en', k), ta: SH.words('ta', k) });
const nameOf = (kind, id) => { const o = office(); return o && typeof o.nameOf === 'function' && id ? (o.nameOf(kind, id) || id) : (id ?? ''); };
// The shop's today (OB-607: the shop's clock, never this device's UTC date); India time when the chrome's clock is not there.
const today = () => (window.sreShopDay && typeof window.sreShopDay.today === 'function' ? window.sreShopDay.today() : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()));
const daysBefore = (iso, n) => { const d = new Date(`${iso}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const repainters = [];

function node(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'dataset') Object.assign(n.dataset, v); else if (k in n) n[k] = v; else n.setAttribute(k, v); }
  n.append(...kids);
  return n;
}

/** A dd/mm/yyyy field from the chrome (a plain date box until it is there), and its ISO value back. */
function dateBox(host, id, key, value) {
  const o = office();
  if (o && typeof o.dateField === 'function') { host.replaceChildren(o.dateField({ id, label: both(key), max: today(), value })); return; }
  const l = node('label', { htmlFor: id, textContent: w(key) });
  const i = node('input', { type: 'date', id, className: 'sre-input', value });
  host.replaceChildren(l, i);
  repainters.push(() => { l.textContent = w(key); });
}
const dateOf = (id) => { const o = office(); return (o && typeof o.dateOf === 'function' ? o.dateOf(id) : null) ?? ($(id)?.value || ''); };

function say(el, text, good) { el.textContent = text; el.className = `status ${good ? 'good' : text === '' ? '' : 'err'}`; }

/** The common frame: heading, lede, the controls, a status line, the summary cards, the list. */
function frame(section, prefix, headKey, ledeKey) {
  const h = node('h3', { id: `${prefix}-h` });
  const lede = node('p', { className: 'lede', id: `${prefix}-lede` });
  const controls = node('div', { className: 'sh-controls', id: `${prefix}-controls` });
  const status = node('p', { className: 'status', id: `${prefix}-status`, role: 'status', 'aria-live': 'polite' });
  const cards = node('div', { id: `${prefix}-cards`, role: 'status', 'aria-live': 'polite' });
  const extra = node('div', { id: `${prefix}-extra` });
  const list = node('div', { id: `${prefix}-list`, 'aria-labelledby': `${prefix}-h` });
  section.setAttribute('aria-labelledby', `${prefix}-h`);
  section.replaceChildren(h, lede, controls, status, cards, extra, list);
  repainters.push(() => { h.textContent = w(headKey); if (typeof ledeKey === 'function') lede.textContent = ledeKey(); else lede.textContent = w(ledeKey); });
  return { controls, status, cards, extra, list };
}

function paintCards(host, cards) {
  const o = office();
  if (o && typeof o.cards === 'function') { o.cards(host, cards.map((c) => ({ label: c.label, value: c.value, ...(c.note ? { note: c.note } : {}), ids: { value: `${host.id}-${c.key}` } }))); return; }
  host.replaceChildren(...cards.map((c) => node('p', { id: `${host.id}-${c.key}`, textContent: `${c.label}: ${c.value}${c.note ? ` (${c.note})` : ''}` })));
}

function register(host, opts) {
  const o = office();
  if (!o || typeof o.table !== 'function') return null;
  return o.table(host, { pageSize: 25, sortable: true, rows: null, ...opts });
}

// ── S2 · earlier write-offs (Waste & write-off) ──────────────────────────────────────────────────────────────────
function writeOffs(section) {
  const api = window.pastWriteOffsSession;
  const f = frame(section, 'wo', 'woH', 'woLede');
  const fromHost = node('div', { className: 'sh-day' }); const toHost = node('div', { className: 'sh-day' });
  const itemLabel = node('label', { htmlFor: 'wo-item' }); const item = node('input', { id: 'wo-item', type: 'text', autocomplete: 'off', className: 'sre-input' });
  const show = node('button', { id: 'wo-show', type: 'button', className: 'sre-btn sre-btn-secondary' });
  f.controls.append(fromHost, toHost, node('div', { className: 'field' }, itemLabel, item), show);
  dateBox(fromHost, 'wo-from', 'from', daysBefore(today(), 29)); dateBox(toHost, 'wo-to', 'to', today());
  const o = office(); if (o && typeof o.pickable === 'function') o.pickable(item, 'product', both('woItem'));
  let current = null; let table = null;
  const draw = () => {
    if (current === null) return;
    const v = current;
    paintCards(f.cards, [
      { key: 'count', label: w('woCount'), value: String(v.count) },
      { key: 'total', label: w('woTotal'), value: SH.rupees(v.totalLossMinor) },
      { key: 'days', label: w('woDays'), value: `${SH.dayWords(v.from)} – ${SH.dayWords(v.to)}` },
    ]);
    f.extra.replaceChildren(...api.kindLines(lang(), v).map((t) => node('p', { className: 'muted sh-kind', textContent: t })));
    if (table === null) table = register(f.list, {
      id: 'past-write-offs', label: both('woH'),
      rowKey: (r) => r.id, rowData: (r) => ({ writeOff: r.documentNumber ?? '', kind: r.lossType }),
      columns: [
        { key: 'date', label: both('colDate'), value: (r) => SH.dayWords(r.shopDate) },
        { key: 'number', label: both('colNumber'), value: (r) => r.documentNumber ?? w('noNumber') },
        { key: 'item', label: both('colItem'), value: (r) => nameOf('product', r.productId) },
        { key: 'qty', label: both('colQty'), align: 'end', sort: false, value: (r) => SH.qty(r.qtyRemoved, r.uom, lang()) },
        { key: 'kind', label: both('colKind'), filter: true, value: (r) => api.kindWord(lang(), r.lossType) },
        { key: 'value', label: both('colValue'), align: 'end', value: (r) => `${SH.rupees(r.valueMinor)}${r.valueStated ? ` (${w('statedValue')})` : ''}` },
        { key: 'raised', label: both('colRaised'), value: (r) => nameOf('person', r.raisedBy) },
        { key: 'approved', label: both('colApproved'), value: (r) => (r.approvedBy ? nameOf('person', r.approvedBy) : w('notNeeded')) },
      ],
    });
    if (table !== null) { table.setRows(v.rows); table.repaint(); }
    say(f.status, v.rows.length === 0 ? w('woNone') : '', true);
  };
  const read = async () => {
    show.disabled = true; say(f.status, w('reading'), true);
    try {
      const out = await api.read(dateOf('wo-from'), dateOf('wo-to'), item.value);
      if (out.kind === 'ok') { current = out.value; draw(); } else say(f.status, SH.failureWords(lang(), out, 'woCannot', window.wasteData), false);
    } finally { show.disabled = false; }
  };
  repainters.push(() => { itemLabel.textContent = w('woItem'); show.textContent = w('show'); draw(); });
  show.addEventListener('click', () => { void read(); });
}

// ── S3 · earlier counts and their accuracy (Stock counts) ────────────────────────────────────────────────────────
function counts(section) {
  const api = window.countHistorySession;
  const f = frame(section, 'ch', 'chH', 'chLede');
  const fromHost = node('div', { className: 'sh-day' }); const toHost = node('div', { className: 'sh-day' });
  const show = node('button', { id: 'ch-show', type: 'button', className: 'sre-btn sre-btn-secondary' });
  f.controls.append(fromHost, toHost, show);
  dateBox(fromHost, 'ch-from', 'from', daysBefore(today(), 29)); dateBox(toHost, 'ch-to', 'to', today());
  let current = null; let table = null;
  const draw = () => {
    if (current === null) return;
    const v = current;
    paintCards(f.cards, api.cards(lang(), v.accuracy));
    const uomOf = (r) => r.uom ?? v.uoms[r.productId] ?? null;
    if (table === null) table = register(f.list, {
      id: 'past-counts', label: both('chH'),
      rowKey: (r) => r.countId, rowData: (r) => ({ count: r.documentNumber ?? '', direction: r.varianceMinor === 0 ? 'matched' : r.varianceMinor < 0 ? 'short' : 'over' }),
      columns: [
        { key: 'date', label: both('colDate'), value: (r) => SH.dayWords(r.shopDate) },
        { key: 'number', label: both('colNumber'), value: (r) => r.documentNumber ?? w('noNumber') },
        { key: 'item', label: both('colItem'), value: (r) => nameOf('product', r.productId) },
        { key: 'place', label: both('colPlace'), value: (r) => nameOf('place', r.locationId) },
        { key: 'counted', label: both('colCounted'), align: 'end', sort: false, value: (r) => SH.qty(r.countedMinor, uomOf(r), lang()) },
        { key: 'record', label: both('colRecord'), align: 'end', sort: false, value: (r) => SH.qty(r.expectedMinor, uomOf(r), lang()) },
        { key: 'difference', label: both('colDifference'), align: 'end', filter: true, value: (r) => `${api.direction(lang(), r)}${r.varianceMinor === 0 ? '' : ` ${api.difference(lang(), r, uomOf(r))}`}` },
        { key: 'value', label: both('colValue'), align: 'end', value: (r) => (r.varianceMinor === 0 ? SH.rupees(0) : r.valueMinor === null ? w('notKnown') : SH.rupees(r.valueMinor)) },
        { key: 'approval', label: both('colApproval'), filter: true, value: (r) => (r.requiredApproval ? w('yes') : w('no')) },
        { key: 'counter', label: both('colCounter'), value: (r) => nameOf('person', r.counterId) },
      ],
    });
    if (table !== null) { table.setRows(v.rows); table.repaint(); }
    say(f.status, v.rows.length === 0 ? w('chNone') : '', true);
  };
  const read = async () => {
    show.disabled = true; say(f.status, w('reading'), true);
    try {
      const out = await api.read(dateOf('ch-from'), dateOf('ch-to'));
      if (out.kind === 'ok') { current = out.value; draw(); } else say(f.status, SH.failureWords(lang(), out, 'chCannot', window.countsData), false);
    } finally { show.disabled = false; }
  };
  repainters.push(() => { show.textContent = w('show'); draw(); });
  show.addEventListener('click', () => { void read(); });
}

// ── S4 · what the empty shelves cost (Stock health) ──────────────────────────────────────────────────────────────
function stockout(section) {
  const api = window.stockoutSession;
  let days = 28;
  const f = frame(section, 'so', 'soH', () => SH.fill(w('soLede'), { days }));
  const pickLabel = node('label', { htmlFor: 'so-days' });
  const pick = node('select', { id: 'so-days', className: 'sre-input' }, ...SH.periods.map((d) => node('option', { value: String(d), textContent: String(d) })));
  pick.value = '28';
  const show = node('button', { id: 'so-show', type: 'button', className: 'sre-btn sre-btn-secondary' });
  f.controls.append(node('div', { className: 'field' }, pickLabel, pick), show);
  const basisH = node('h4', { id: 'so-basis-h' }); const basis = node('ul', { id: 'so-basis', className: 'sh-basis' });
  f.extra.append(basisH, basis);
  let current = null; let table = null;
  const draw = () => {
    basisH.textContent = w('soBasisH');
    basis.replaceChildren(...api.basis(lang()).map((t) => node('li', { textContent: t })));
    if (current === null) return;
    const v = current;
    paintCards(f.cards, api.cards(lang(), v));
    const uomOf = (r) => v.uoms[r.productId] ?? null;
    if (table === null) table = register(f.list, {
      id: 'stockout-estimate', label: both('soH'),
      rowKey: (r) => `${r.productId}@${r.locationId}`, rowData: (r) => ({ product: r.productId, known: String(r.lostMarginMinor !== null) }),
      columns: [
        { key: 'item', label: both('colItem'), value: (r) => nameOf('product', r.productId) },
        { key: 'place', label: both('colPlace'), value: (r) => nameOf('place', r.locationId) },
        { key: 'daysEmpty', label: both('colDaysEmpty'), align: 'end', value: (r) => api.rowWords(lang(), r, uomOf(r)).daysEmpty },
        { key: 'normal', label: both('colNormal'), align: 'end', sort: false, value: (r) => api.rowWords(lang(), r, uomOf(r)).normal },
        { key: 'lostSales', label: both('colLostSales'), align: 'end', sort: false, value: (r) => api.rowWords(lang(), r, uomOf(r)).lostSales },
        { key: 'lostMargin', label: both('colLostMargin'), align: 'end', value: (r) => api.rowWords(lang(), r, uomOf(r)).lostMargin },
        { key: 'onHand', label: both('colOnHand'), align: 'end', sort: false, value: (r) => api.rowWords(lang(), r, uomOf(r)).onHand },
        { key: 'why', label: both('colWhy'), value: (r) => api.rowWords(lang(), r, uomOf(r)).why },
      ],
    });
    if (table !== null) { table.setRows(v.rows); table.repaint(); }
    say(f.status, v.rows.length === 0 ? w('soNone') : '', true);
  };
  const read = async () => {
    days = Number(pick.value) || 28;
    show.disabled = true; say(f.status, w('reading'), true);
    try {
      const out = await api.read(days);
      if (out.kind === 'ok') { current = out.value; draw(); } else say(f.status, SH.failureWords(lang(), out, 'tsCannot', window.stockHealthData), false);
      repaintAll();
    } finally { show.disabled = false; }
  };
  repainters.push(() => { pickLabel.textContent = w('soDays'); show.textContent = w('show'); draw(); });
  show.addEventListener('click', () => { void read(); });
}

// ── S5 · suggested transfers (Transfers) ─────────────────────────────────────────────────────────────────────────
function transfers(section) {
  const api = window.transferSuggestionsSession;
  const f = frame(section, 'ts', 'tsH', 'tsLede');
  const show = node('button', { id: 'ts-show', type: 'button', className: 'sre-btn' });
  f.controls.append(show);
  let current = null; let table = null;
  const start = (r) => {
    const form = api.startForm(r);
    const fill = (id, value) => { const el = $(id); if (el) { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); } };
    fill('s-from', form.fromLocationId); fill('s-to', form.toLocationId); fill('s-item', form.productId);
    const qty = $('s-qty'); if (qty) qty.value = '';
    say(f.status, SH.fill(w('tsFilled'), { from: nameOf('place', form.fromLocationId), to: nameOf('place', form.toLocationId), item: nameOf('product', form.productId) }), true);
    $('start-box')?.scrollIntoView({ block: 'start' });
    qty?.focus();
  };
  const draw = () => {
    if (current === null) return;
    const v = current;
    const uomOf = (r) => v.uoms[r.productId] ?? null;
    if (table === null) table = register(f.list, {
      id: 'transfer-suggestions', label: both('tsH'),
      rowKey: (r) => `${r.productId}@${r.fromLocationId}>${r.toLocationId}`, rowData: (r) => ({ product: r.productId, from: r.fromLocationId, to: r.toLocationId }),
      columns: [
        { key: 'item', label: both('colItem'), value: (r) => nameOf('product', r.productId) },
        { key: 'to', label: both('colNeededAt'), value: (r) => nameOf('place', r.toLocationId) },
        { key: 'from', label: both('colTakeFrom'), value: (r) => nameOf('place', r.fromLocationId) },
        { key: 'where', label: both('colWhere'), filter: true, value: (r) => api.whereWord(lang(), r.fromKind) },
        { key: 'held', label: both('colHeld'), align: 'end', sort: false, value: (r) => SH.qty(r.heldAtSourceMinor, uomOf(r), lang()) },
        { key: 'sold', label: both('colSold'), align: 'end', sort: false, value: (r) => SH.qty(r.soldHereLast7DaysMinor, uomOf(r), lang()) },
        { key: 'start', label: both('colStart'), sort: false, value: () => '', render: (r) => { const b = node('button', { type: 'button', className: 'sre-btn sre-btn-quiet ts-start', textContent: w('tsStart'), dataset: { act: 'start' } }); b.addEventListener('click', () => start(r)); return b; } },
      ],
    });
    if (table !== null) { table.setRows(v.rows); table.repaint(); }
    say(f.status, v.rows.length === 0 ? w('tsNone') : '', true);
  };
  const read = async () => {
    show.disabled = true; say(f.status, w('reading'), true);
    try {
      const out = await api.read();
      if (out.kind === 'ok') { current = out.value; draw(); } else say(f.status, SH.failureWords(lang(), out, 'tsCannot', window.transfersData), false);
    } finally { show.disabled = false; }
  };
  repainters.push(() => { show.textContent = w('tsShow'); draw(); });
  show.addEventListener('click', () => { void read(); });
}

function repaintAll() { for (const fn of repainters) fn(); }

const PARTS = [
  ['past-write-offs', 'pastWriteOffsSession', writeOffs],
  ['past-counts', 'countHistorySession', counts],
  ['stockout', 'stockoutSession', stockout],
  ['transfer-suggestions', 'transferSuggestionsSession', transfers],
];
function boot(force = false) {
  if (SH === null) return;
  // The sections are drawn on the chrome's shared parts (dates, list, cards): wait for it, and draw plainly if it never comes.
  if (!force && office() === null) return;
  for (const [id, sessionKey, draw] of PARTS) {
    const section = $(`${id}-section`);
    const api = window[sessionKey];
    if (!section || section.dataset.drawn === '1' || !api || !api.may) continue;
    section.dataset.drawn = '1';
    section.hidden = false;
    draw(section);
  }
  repaintAll();
}
boot();
setTimeout(() => boot(true), 3000);
// The page's one language switch flips the page first; these sections follow (one language at a time — OB-855).
$('lang')?.addEventListener('click', () => { setTimeout(repaintAll, 0); });
document.addEventListener('sre:chrome', () => { boot(); repaintAll(); });
