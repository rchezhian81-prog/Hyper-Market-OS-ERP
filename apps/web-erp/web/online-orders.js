// Online orders — the desk's view of one online order and its next steps, the payments waiting on the bank, the stock held
// for orders, the app's buffer and a channel comparison (W3 · M18-FR-01/02/04 · D05-FR-03). The session
// (apps/web-erp/src/online-orders-session.ts, in the bundle as window.onlineOrders) asks head office; this page shows its
// answers. Only the steps head office's lifecycle allows are offered; head office refuses any other by name. Every state is
// an icon AND words; every word has a Tamil twin. No prompt/confirm/alert; nothing on a timer.

const $ = (id) => document.getElementById(id);

/** A greyed button says why (U1 · G3 · design system §4 "disabled state explains why"): the reason is the button's tooltip
 *  and the words beside it, in the reader's language. `why` is 'role' (your role may not), 'offline' (head office cannot
 *  be reached), a page's own { en, ta } pair or sentence; '' takes the words away. */
const WHY_WORDS = {
  role: { en: 'Your role may not do this.', ta: 'உங்கள் பங்குக்கு இதைச் செய்ய அனுமதி இல்லை.' },
  offline: { en: 'Head office cannot be reached, so this cannot be done now.', ta: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை, எனவே இப்போது இதைச் செய்ய முடியாது.' },
};
function whyDisabled(btn, why) {
  const tongue = document.documentElement.lang === 'ta' ? 'ta' : 'en';
  const words = why === '' || why === undefined || why === null ? '' : typeof why === 'string' ? (WHY_WORDS[why]?.[tongue] ?? why) : (why[tongue] ?? why.en);
  let note = btn.nextElementSibling;
  if (!(note && note.classList.contains('sre-why'))) {
    note = document.createElement('small'); note.className = 'sre-why';
    note.id = `${btn.id || `b${Math.random().toString(36).slice(2, 7)}`}-why`;
    btn.after(note);
  }
  note.textContent = words; note.hidden = words === '';
  if (words === '') { btn.removeAttribute('title'); btn.removeAttribute('aria-describedby'); } else { btn.title = words; btn.setAttribute('aria-describedby', note.id); }
}
const api = window.onlineOrders ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, move: false, backorder: false, settle: false, reservations: false, availability: false, buffer: false };

let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
let order = null;
let pay = null;
let held = null;
let avail = null;
let rec = null;

const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
for (const [id, name] of [['show-order', 'search'], ['show-pay', 'clock'], ['show-res', 'boxes'], ['show-avail', 'package-check'], ['set-buffer', 'circle-check'], ['compare', 'arrow-up-down']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }

function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function bad(where, out) { $(where).className = 'status err'; $(where).textContent = `⚠ ${api.outcomeWords(lang, out)}${out.badLine ? ` ${out.badLine}` : ''}`; }
function good(where, words) { $(where).className = 'status good'; $(where).textContent = `✓ ${words}`; }
const stateWords = (s) => t(`st_${s}`);
const qty = (l) => `${l.quantityMinor} × ${l.productId}`;

function paintOrder() {
  if (order === null) { $('order').replaceChildren(); return; }
  const o = order;
  const finished = (api.nextSteps[o.state] ?? []).length === 0;
  const li = document.createElement('li'); li.className = `row tone-${o.state === 'cancelled' ? 'degraded' : finished ? 'ok' : 'idle'}`; li.dataset.order = o.orderId; li.dataset.state = o.state;
  li.append(text('strong', `${finished ? '✓' : '○'} ${o.orderId} — ${t('stateK')}: ${stateWords(o.state)}`, 'state-line'));
  const facts = document.createElement('div'); facts.className = 'facts';
  facts.append(text('span', `${t('storeK')}: ${o.locationId}`, 'store'));
  facts.append(text('span', `${t('linesK')}: ${o.lines.map(qty).join(', ')}`, 'lines'));
  facts.append(text('span', o.reservations.length === 0 ? t('heldNone') : `${t('heldK')}: ${o.reservations.map(qty).join(', ')}`, 'held'));
  facts.append(text('span', o.backorders === undefined ? t('backUnknown') : o.backorders.length === 0 ? t('backNone')
    : `⚠ ${t('backK')}: ${o.backorders.flatMap((b) => b.lines).map((l) => `${l.shortfallMinor} × ${l.productId}`).join(', ')}`, 'backorders'));
  facts.append(text('span', o.payment === undefined ? t('payUnknown') : `${t('payK')}: ${t(`pay_${o.payment.state}`)}`, 'payment'));
  li.append(facts);
  const steps = document.createElement('div'); steps.className = 'steps';
  const next = api.nextSteps[o.state] ?? [];
  if (next.length === 0) steps.append(text('span', t('noNext'), 'facts'));
  for (const ev of next) {
    const b = document.createElement('button'); b.type = 'button'; b.className = `${ev === 'cancel' ? 'quiet ' : ''}step step-${ev}`; b.dataset.event = ev;
    const i = icon(ev === 'cancel' ? 'x' : 'circle-check'); if (i !== null) b.append(i);
    b.append(text('span', t(`ev_${ev}`)));
    b.disabled = !may.move; whyDisabled(b, may.move ? '' : 'role');
    b.addEventListener('click', () => { void move(ev); });
    steps.append(b);
  }
  if (!finished && (o.backorders ?? []).length === 0) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'quiet backorder';
    b.append(text('span', t('backorder'))); b.disabled = !may.backorder; whyDisabled(b, may.backorder ? '' : 'role');
    b.addEventListener('click', () => { void backorder(); });
    steps.append(b);
  }
  li.append(steps);
  $('order').replaceChildren(li);
}

function paintPay() {
  if (pay === null) { $('pay').replaceChildren(); return; }
  if (pay.length === 0) { $('pay').replaceChildren(text('li', `✓ ${t('noPay')}`, 'row tone-ok')); return; }
  $('pay').replaceChildren(...pay.map((p) => {
    const li = document.createElement('li'); li.className = 'row tone-degraded'; li.dataset.payment = p.orderId;
    li.append(text('strong', `⏱ ${t('payWaiting')} — ${p.orderId} · ${api.rupees(p.amountMinor)}`));
    li.append(text('span', `${api.moment(p.recordedAt)}${p.reason ? ` · ${p.reason}` : ''}`, 'facts'));
    const form = document.createElement('div'); form.className = 'row-form';
    const label = document.createElement('label'); const input = document.createElement('input'); input.className = 'statement'; input.autocomplete = 'off';
    label.append(text('span', t('statement')), input);
    const mk = (result, words, iconName) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = `quiet settle-${result} sre-btn sre-btn-quiet`;
      const i = icon(iconName); if (i !== null) b.append(i);
      b.append(text('span', words)); b.disabled = !may.settle; whyDisabled(b, may.settle ? '' : 'role');
      b.addEventListener('click', () => { void settle(p.orderId, result, input.value); });
      return b;
    };
    form.append(label, mk('authorised', t('paid'), 'circle-check'), mk('declined', t('declined'), 'x'));
    li.append(form);
    return li;
  }));
}

function paintHeld() {
  if (held === null) { $('res').replaceChildren(); return; }
  if (held.outstanding.length === 0) { $('res').replaceChildren(text('li', `✓ ${t('resNone')}`, 'row tone-ok')); return; }
  const late = new Set(held.expired.map((r) => r.reservationId));
  $('res').replaceChildren(...held.outstanding.map((r) => {
    const li = document.createElement('li'); li.className = `row tone-${late.has(r.reservationId) ? 'degraded' : 'idle'}`; li.dataset.reservation = r.reservationId; li.dataset.order = r.orderId;
    li.append(text('strong', `${late.has(r.reservationId) ? '⚠' : '○'} ${r.orderId} — ${qty(r)}`));
    li.append(text('span', `${api.moment(r.heldUntil)}${late.has(r.reservationId) ? ` · ${t('expired')}` : ''}`, 'facts'));
    return li;
  }));
}

function paintAvail() {
  if (avail === null) { $('avail').replaceChildren(); return; }
  $('avail').replaceChildren(...avail.rows.map((r) => {
    const unset = (r.flags ?? []).includes('buffer_not_set');
    const li = document.createElement('li'); li.className = `row tone-${unset ? 'idle' : 'ok'}`; li.dataset.product = r.productId;
    li.append(text('strong', `${r.productId} — ${t('appMay')}: ${r.appMayPromiseMinor}`, 'may'));
    li.append(text('span', `${t('onHand')} ${r.onHandMinor} · ${t('promised')} ${r.promisedMinor} · ${unset ? `○ ${t('notSetBuf')}` : `${t('keptBack')} ${r.bufferMinor}`}`, 'facts'));
    return li;
  }));
}

function paintRec() {
  if (rec === null) { $('rec').replaceChildren(); return; }
  const head = text('li', `${rec.reconciles ? '✓' : '⚠'} ${rec.channel}: ${rec.reconciles ? t('recOk') : t('recBad')} ${t('recMatched')} ${rec.matched} (${api.rupees(rec.matchedValueMinor)})${rec.reconciles ? '' : ` · ${t('recAtRisk')} ${api.rupees(rec.atRiskValueMinor)}`}`, `row tone-${rec.reconciles ? 'ok' : 'degraded'} summary`);
  $('rec').replaceChildren(head, ...rec.discrepancies.map((d) => {
    const li = document.createElement('li'); li.className = 'row tone-degraded'; li.dataset.order = d.orderId; li.dataset.kind = d.kind;
    li.append(text('strong', `⚠ ${d.orderId} — ${t(`k_${d.kind}`)}`));
    const parts = [];
    if (d.channelValueMinor !== undefined) parts.push(`${t('theirs')}: ${api.rupees(d.channelValueMinor)}`);
    if (d.ledgerValueMinor !== undefined) parts.push(`${t('ours')}: ${api.rupees(d.ledgerValueMinor)}`);
    if (parts.length > 0) li.append(text('span', parts.join(' · '), 'facts'));
    return li;
  }));
}

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title-text', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['order-h', 'orderH'], ['l-order-id', 'orderId'], ['show-order-text', 'showOrder'],
    ['pay-h', 'payH'], ['show-pay-text', 'showPay'], ['res-h', 'resH'], ['l-res-store', 'store'], ['show-res-text', 'showRes'],
    ['buf-h', 'bufH'], ['buf-lead', 'bufLead'], ['l-buf-store', 'store'], ['show-avail-text', 'showAvail'], ['l-buf-product', 'product'], ['l-buf-units', 'units'], ['l-buf-reason', 'bufReason'], ['set-buffer-text', 'setBuffer'],
    ['rec-h', 'recH'], ['l-rec-channel', 'channel'], ['l-rec-theirs', 'channelList'], ['l-rec-ours', 'ledgerList'], ['compare-text', 'compare']]) $(id).textContent = t(k);
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.onlineOrdersData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  for (const id of ['show-order', 'order-id', 'show-pay', 'compare', 'rec-channel', 'rec-theirs', 'rec-ours']) $(id).disabled = !may.read;
  for (const id of ['show-order', 'show-pay', 'compare']) whyDisabled($(id), may.read ? '' : 'role');
  for (const id of ['show-res', 'res-store']) $(id).disabled = !may.reservations;
  whyDisabled($('show-res'), may.reservations ? '' : 'role');
  for (const id of ['show-avail']) $(id).disabled = !may.availability;
  whyDisabled($('show-avail'), may.availability ? '' : 'role');
  for (const id of ['set-buffer', 'buf-product', 'buf-units', 'buf-reason']) $(id).disabled = !may.buffer;
  whyDisabled($('set-buffer'), may.buffer ? '' : 'role');
  $('buf-store').disabled = !may.availability && !may.buffer;
  paintOrder(); paintPay(); paintHeld(); paintAvail(); paintRec();
}

async function showOrder() {
  const out = await session.order($('order-id').value);
  if (out.result !== 'ok') { order = null; bad('order-status', out); paintOrder(); return; }
  order = out.value; $('order-status').className = 'status'; $('order-status').textContent = '';
  paintOrder();
}
async function move(ev) {
  const out = await session.move(order.orderId, ev);
  if (out.result !== 'ok') { bad('order-status', out); return; }
  const r = out.value;
  const words = `${t('moved')} ${r.orderId} — ${stateWords(r.from)} → ${stateWords(r.state)}.${ev === 'cancel' ? ` ${r.released.length === 0 ? t('nothingReleased') : `${t('released')} ${r.released.map(qty).join(', ')}`}` : ''}`;
  await showOrder();
  good('order-status', words);
}
async function backorder() {
  const out = await session.backorder(order.orderId);
  if (out.result !== 'ok') { bad('order-status', out); return; }
  const words = out.value.outcome === 'nothing_to_backorder' ? t('nothingToBackorder') : `${t('backorderSaved')} ${out.value.lines.map((l) => `${l.shortfallMinor} × ${l.productId}`).join(', ')}`;
  await showOrder();
  good('order-status', words);
}
async function showPay() {
  const out = await session.pendingPayments();
  if (out.result !== 'ok') { pay = null; bad('pay-status', out); paintPay(); return; }
  pay = out.value; $('pay-status').className = 'status'; $('pay-status').textContent = '';
  paintPay();
}
async function settle(orderId, result, statementRef) {
  const out = await session.settle(orderId, result, statementRef);
  if (out.result !== 'ok') { bad('pay-status', out); return; }
  await showPay();
  good('pay-status', `${t('settled')} ${orderId} — ${t(`pay_${out.value.payment.state}`)}`);
}
async function showHeld() {
  const out = await session.reservations($('res-store').value);
  if (out.result !== 'ok') { held = null; bad('res-status', out); paintHeld(); return; }
  held = out.value; $('res-status').className = 'status'; $('res-status').textContent = '';
  paintHeld();
}
async function showAvail() {
  const out = await session.availability($('buf-store').value);
  if (out.result !== 'ok') { avail = null; bad('buf-status', out); paintAvail(); return; }
  avail = out.value; $('buf-status').className = 'status'; $('buf-status').textContent = '';
  paintAvail();
}
async function setBuffer() {
  const out = await session.setBuffer({ locationId: $('buf-store').value, productId: $('buf-product').value, units: $('buf-units').value, reason: $('buf-reason').value });
  if (out.result !== 'ok') { bad('buf-status', out); return; }
  const b = out.value.buffer;
  const words = `${t('bufSaved')} ${b.productId ?? t('allProducts')} — ${b.bufferMinor}`;
  $('buf-units').value = ''; $('buf-reason').value = '';
  if (may.availability) await showAvail();
  good('buf-status', words);
}
async function compare() {
  const out = await session.reconcile({ channel: $('rec-channel').value, channelList: $('rec-theirs').value, ledgerList: $('rec-ours').value });
  if (out.result !== 'ok') { rec = null; bad('rec-status', out); paintRec(); return; }
  rec = out.value; $('rec-status').className = 'status'; $('rec-status').textContent = '';
  paintRec();
}

$('show-order').addEventListener('click', () => { void showOrder(); });
$('show-pay').addEventListener('click', () => { void showPay(); });
$('show-res').addEventListener('click', () => { void showHeld(); });
$('show-avail').addEventListener('click', () => { void showAvail(); });
$('set-buffer').addEventListener('click', () => { void setBuffer(); });
$('compare').addEventListener('click', () => { void compare(); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
if (api !== null && api.storeId) { $('res-store').value = api.storeId; $('buf-store').value = api.storeId; }
paint();
if (may.named && !may.read) { $('page-status').className = 'status err'; $('page-status').textContent = `⚠ ${t('cannotRead')}`; }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
