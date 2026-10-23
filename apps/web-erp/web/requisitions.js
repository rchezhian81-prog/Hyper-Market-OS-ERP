// Requisitions and quotes — the page over head office's M06-FR-02 / WF-03 routes. The session
// (apps/web-erp/src/requisitions-session.ts, in the bundle as window.requisitions) asks head office; this page only shows
// its answers: the requisitions, the quotes recorded against one, head office's like-for-like comparison (cheapest and
// fastest marked on head office's own rows), and the order PROPOSED from a chosen quote — a second person issues it on
// the Buying page. Every word has a Tamil twin (in the session's copy); every button carries its icon beside its word.

const $ = (id) => document.getElementById(id);
const api = window.requisitions ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, raise: false };

let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
let rows = [];
let open = null; // the requisition opened
let comparison = null;
let newLines = [{ productId: '', quantity: '' }];

/** A button's word with its icon beside it — the icon never the only signal. */
function label(button, icon, key) {
  const parts = [];
  if (typeof window.sreIcon === 'function') { const i = window.sreIcon(icon, 18); if (i) parts.push(i); }
  parts.push(document.createTextNode(t(key)));
  button.replaceChildren(...parts);
}

function say(text, err = false) { $('page-status').className = err ? 'status err' : 'status'; $('page-status').textContent = text; }
const sourceWords = (r) => r.source === undefined ? t('typed') : r.source.kind === 'replenishment' ? `${t('fromReplenishment')} (${r.source.storeId ?? ''})` : t('fromDrafts');

function paintList() {
  $('none').hidden = rows.length > 0; $('none').textContent = t('none');
  $('list').replaceChildren(...rows.map((r) => {
    const tr = document.createElement('tr');
    tr.dataset.requisition = r.requisitionId;
    const cells = [r.requisitionId, r.lines.map((l) => `${l.productId} × ${l.quantity}`).join(', '), r.raisedBy ?? '—', sourceWords(r)].map((v) => { const td = document.createElement('td'); td.textContent = v; return td; });
    const td = document.createElement('td');
    const b = document.createElement('button'); b.type = 'button'; b.className = 'quiet open'; label(b, 'search', 'open');
    b.addEventListener('click', () => { void openRequisition(r); });
    td.append(b); tr.append(...cells, td);
    return tr;
  }));
}

function paintNewLines() {
  $('new-lines').replaceChildren(...newLines.map((l, i) => {
    const wrap = document.createElement('div'); wrap.className = 'form-row';
    for (const [key, field] of [['product', 'productId'], ['quantity', 'quantity']]) {
      const lab = document.createElement('label'); const span = document.createElement('span'); span.textContent = t(key);
      const input = document.createElement('input'); input.value = l[field]; input.id = `new-${field}-${i}`; input.autocomplete = 'off';
      if (field === 'quantity') input.inputMode = 'numeric';
      input.addEventListener('input', () => { newLines[i] = { ...newLines[i], [field]: input.value }; });
      lab.htmlFor = input.id; lab.append(span, input); wrap.append(lab);
    }
    return wrap;
  }));
}

function paintQuoteLines() {
  if (open === null) { $('quote-lines').replaceChildren(); return; }
  $('quote-lines').replaceChildren(...open.lines.map((l, i) => {
    const wrap = document.createElement('div'); wrap.className = 'form-row'; wrap.dataset.product = l.productId;
    const name = document.createElement('p'); name.className = 'muted'; name.textContent = `${l.productId} × ${l.quantity}`;
    wrap.append(name);
    for (const [key, field] of [['unitCost', 'unit'], ['leadDays', 'lead']]) {
      const lab = document.createElement('label'); const span = document.createElement('span'); span.textContent = t(key);
      const input = document.createElement('input'); input.id = `q-${field}-${i}`; input.autocomplete = 'off'; input.inputMode = 'decimal';
      lab.htmlFor = input.id; lab.append(span, input); wrap.append(lab);
    }
    return wrap;
  }));
}

function chip(icon, key) {
  if (typeof window.sreIcon?.withWord === 'function') { const c = window.sreIcon.withWord(icon, t(key)); c.classList.add('chip', 'best'); return c; }
  const s = document.createElement('span'); s.className = 'chip best'; s.textContent = t(key); return s;
}

function paintComparison() {
  const has = comparison !== null && comparison.lines.some((l) => l.offers.length > 0);
  $('no-quotes').hidden = has; $('no-quotes').textContent = t('noQuotes');
  const list = comparison === null ? [] : api.offerRows(comparison);
  $('cmp').replaceChildren(...list.map((o) => {
    const tr = document.createElement('tr'); tr.dataset.quote = o.quoteId; tr.dataset.product = o.productId;
    const cells = [o.productId, `${o.supplierId} (${o.quoteId})`, api.rupees(o.unitMinor), api.rupees(o.lineMinor), `${o.leadTimeDays} ${t('days')}`].map((v) => { const td = document.createElement('td'); td.textContent = v; return td; });
    const marks = document.createElement('td');
    if (!o.comparable) marks.textContent = `${t('notComparable')}${o.reason === undefined ? '' : ` — ${o.reason}`}`;
    if (o.cheapest) marks.append(chip('trending-down', 'cheapest'));
    if (o.fastest) marks.append(' ', chip('truck', 'fastest'));
    tr.append(...cells, marks);
    return tr;
  }));
  const parts = [];
  if (comparison?.cheapestOverall) parts.push(`${t('cheapestOverall')}: ${comparison.cheapestOverall.supplierId} (${comparison.cheapestOverall.quoteId})`);
  if (comparison?.fastestOverall) parts.push(`${t('fastestOverall')}: ${comparison.fastestOverall.supplierId} (${comparison.fastestOverall.quoteId})`);
  for (const tot of comparison?.totals ?? []) parts.push(`${tot.supplierId}: ${t('total')} ${api.rupees(tot.totalCost.minor)}, ${t('slowestLine')} ${tot.maxLeadTimeDays} ${t('days')}`);
  $('overall').textContent = parts.join(' · ');
  const incomplete = comparison?.incompleteQuotes ?? [];
  $('incomplete').hidden = incomplete.length === 0; $('incomplete').textContent = `${t('incomplete')} ${incomplete.join(', ')}`;
  const options = (comparison?.totals ?? []).map((tot) => { const o = document.createElement('option'); o.value = `${tot.supplierId}|${tot.quoteId}`; o.textContent = `${tot.supplierId} (${tot.quoteId}) · ${api.rupees(tot.totalCost.minor)}`; return o; });
  $('order-quote').replaceChildren(...options);
}

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title-text', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['list-h', 'worklist'], ['th-id', 'id'], ['th-lines', 'lines'], ['th-by', 'raisedBy'], ['th-from', 'from'],
    ['raise-h', 'raise'], ['l-new-id', 'newId'], ['quote-h', 'quotes'], ['l-quote-id', 'quoteId'], ['l-quote-supplier', 'supplier'], ['cmp-h', 'comparison'],
    ['th-product', 'product'], ['th-supplier', 'supplier'], ['th-unit', 'unitCost'], ['th-line', 'total'], ['th-lead', 'leadDays'], ['order-h', 'order'], ['l-order-quote', 'chooseQuote'],
    ['l-order-store', 'deliverTo'], ['l-order-id', 'poId']]) $(id).textContent = t(k);
  label($('add-line'), 'list-plus', 'addLine'); label($('raise'), 'clipboard-list', 'raiseIt'); label($('record-quote'), 'receipt-text', 'recordQuote'); label($('raise-order'), 'send', 'raiseOrder');
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.requisitionsData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  $('raise-section').hidden = !may.raise;
  for (const id of ['record-quote', 'raise-order']) $(id).disabled = !may.raise;
  $('open-section').hidden = open === null;
  if (open !== null) $('open-h').textContent = `${t('id')} ${open.requisitionId} · ${open.lines.map((l) => `${l.productId} × ${l.quantity}`).join(', ')}`;
  paintList(); paintNewLines(); paintQuoteLines(); paintComparison();
}

async function refresh() {
  const out = await session.list();
  if (out.result === 'ok') rows = [...out.value]; else say(api.outcomeWords(lang, out), true);
  paint();
}

async function openRequisition(r) {
  open = r;
  const out = await session.comparison(r.requisitionId);
  comparison = out.result === 'ok' ? out.value : null;
  if (out.result !== 'ok') say(api.outcomeWords(lang, out), true);
  paint();
}

$('add-line').addEventListener('click', () => { newLines = [...newLines, { productId: '', quantity: '' }]; paint(); });
$('raise').addEventListener('click', async () => {
  const out = await session.raise($('new-id').value, newLines);
  if (out.result !== 'ok') { say(api.outcomeWords(lang, out), true); return; }
  say(t('raised')); $('new-id').value = ''; newLines = [{ productId: '', quantity: '' }];
  await refresh();
  await openRequisition(out.value);
});
$('record-quote').addEventListener('click', async () => {
  if (open === null) return;
  const lines = open.lines.map((l, i) => ({ productId: l.productId, unitRupees: $(`q-unit-${i}`).value, leadDays: $(`q-lead-${i}`).value }));
  const out = await session.recordQuote(open.requisitionId, $('quote-id').value, $('quote-supplier').value, lines);
  if (out.result !== 'ok') { say(api.outcomeWords(lang, out), true); return; }
  say(t('quoted')); $('quote-id').value = ''; $('quote-supplier').value = '';
  await openRequisition(open);
});
$('raise-order').addEventListener('click', async () => {
  if (open === null || comparison === null) return;
  const [supplierId, quoteId] = ($('order-quote').value || '|').split('|');
  const out = await session.raiseOrder({ requisitionId: open.requisitionId, poId: $('order-id').value, supplierId, quoteId, deliverTo: $('order-store').value, comparison });
  if (out.result !== 'ok') { say(api.outcomeWords(lang, out), true); return; }
  say(`${t('proposed')} (${out.value.order.poId} · ${api.rupees(out.value.order.totalMinor)})`);
});
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (may.named && !may.read) say(t('cannotRead'), true);
else if (may.read) void refresh();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
