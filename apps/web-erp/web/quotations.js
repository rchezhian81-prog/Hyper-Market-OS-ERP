// Quotations (OB-506 · M12-FR-02) — the page over head office's retail-quotation routes. The session
// (apps/web-erp/src/quotations-session.ts, in the bundle as window.quotations) does every call; this page lays out what it is
// told. Nothing is read on open; every write is a click. Every word has a Tamil twin; every button its icon.

const $ = (id) => document.getElementById(id);
const api = window.quotations ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, write: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, iconName, quiet) {
  const b = document.createElement('button'); b.type = 'button'; if (quiet) b.className = 'quiet';
  const i = icon(iconName); if (i !== null) b.append(i);
  b.append(text('span', words)); return b;
}
let lines = [];
let rows = null; // { kind: 'list' | 'follow', items }

function paintLines() {
  $('lines').replaceChildren(...lines.map((l, i) => {
    const li = text('li', `${l.description} × ${l.quantity} · ${api.rupees(l.unitPriceMinor)} ${t('each')}`);
    li.dataset.product = l.productId;
    const rm = button(t('removeLine'), 'trash', true);
    rm.addEventListener('click', () => { lines = lines.filter((_, j) => j !== i); paintLines(); });
    li.append(rm); return li;
  }));
  if (lines.length === 0) $('lines').append(text('li', t('noLines'), 'meta'));
  $('lines-total').textContent = `${t('total')}: ${api.rupees(lines.reduce((s, l) => s + l.unitPriceMinor * l.quantity, 0))}`;
}

async function voidOne(id, reasonInput, status) {
  const out = await session.void(id, reasonInput.value);
  status.textContent = api.outcomeWords(lang, out);
  if (out.result === 'ok') await showList();
}

function paintRows() {
  $('rows').replaceChildren();
  if (rows === null) return;
  if (rows.items.length === 0) { $('rows').append(text('li', t('none'), 'meta')); return; }
  if (rows.kind === 'follow') {
    $('rows').replaceChildren(...rows.items.map((q) => {
      const li = text('li', `${t('number')} ${q.quotationId} · ${q.customerRef} · ${api.rupees(q.valueMinor)} · ${q.daysLeft < 0 ? t('lapsed') : `${q.daysLeft} ${t('daysLeft')}`}`, q.daysLeft <= 1 ? 'attention' : '');
      li.dataset.quotation = q.quotationId; return li;
    }));
    return;
  }
  $('rows').replaceChildren(...rows.items.map((q) => {
    const li = document.createElement('li'); li.dataset.quotation = q.quotationId; li.dataset.state = q.state;
    li.append(text('div', `${t('number')} ${q.quotationId} · ${q.customerRef} · ${api.rupees(q.totalMinor)} · ${t(`s_${q.state}`)}`));
    li.append(text('div', `${q.storeId} · ${t('until')} ${q.validUntil} · ${t('by')} ${q.issuedBy}${q.convertedSaleId ? ` · ${t('rungOn')} ${q.convertedSaleId}` : ''}${q.withdrawReason ? ` · ${t('voidedBecause')} ${q.withdrawReason}` : ''}`, 'meta'));
    // R8-B · OB-523: each cancelled bill that freed it again — who, why, which bill.
    for (const r of q.releases ?? []) li.append(text('div', `${t('freedFrom')} ${r.saleId} · ${r.reason} · ${t('by')} ${r.freedBy}`, 'meta freed'));
    li.append(text('div', q.lines.map((l) => `${l.description} × ${l.quantityMinor} @ ${api.rupees(l.unitPriceMinor)}`).join('; '), 'meta'));
    if (may.write && q.state === 'issued') {
      const acts = document.createElement('div'); acts.className = 'acts';
      const reason = document.createElement('input'); reason.placeholder = t('voidReason'); reason.setAttribute('aria-label', t('voidReason')); reason.dataset.act = 'reason';
      const status = text('p', '', 'status'); status.setAttribute('role', 'status');
      const v = button(t('void'), 'x', true); v.dataset.act = 'void';
      v.addEventListener('click', () => { void voidOne(q.quotationId, reason, status); });
      acts.append(reason, v); li.append(acts, status);
    }
    return li;
  }));
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['make-h', 'makeH'], ['q-store-l', 'store'], ['q-customer-l', 'customer'], ['q-until-l', 'validUntil'], ['l-code-l', 'lineCode'], ['l-qty-l', 'lineQty'],
    ['l-price-l', 'linePrice'], ['l-add-text', 'addLine'], ['lines-h', 'linesH'], ['q-approval-l', 'approval'], ['q-make-text', 'make'], ['q-ask-text', 'askApproval'],
    ['list-h', 'listH'], ['s-state-l', 'state'], ['s-show-text', 'show'], ['s-follow-text', 'followUp']]) $(id).textContent = t(key);
  if (api !== null) {
    const sel = $('s-state'); const keep = sel.value;
    sel.replaceChildren(...api.states.map((s) => { const o = document.createElement('option'); o.value = s; o.textContent = t(`s_${s}`); return o; }));
    sel.value = keep;
    paintLines();
  }
  paintRows();
}

async function showList() {
  const out = await session.list($('s-state').value);
  if (out.result !== 'ok') { rows = null; paintRows(); $('s-status').textContent = api.outcomeWords(lang, out); return; }
  rows = { kind: 'list', items: out.value.quotations }; $('s-status').textContent = ''; paintRows();
}

for (const [id, name] of [['l-add', 'list-plus'], ['q-make', 'check'], ['q-ask', 'badge-check'], ['s-show', 'list'], ['s-follow', 'clock']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else {
  $('list').hidden = false;
  $('s-show').addEventListener('click', () => { void showList(); });
  $('s-follow').addEventListener('click', async () => {
    const out = await session.followUp();
    if (out.result !== 'ok') { rows = null; paintRows(); $('s-status').textContent = api.outcomeWords(lang, out); return; }
    rows = { kind: 'follow', items: out.value.quotations }; $('s-status').textContent = ''; paintRows();
  });
  if (may.write) {
    $('make').hidden = false;
    $('q-until').value = api.validUntil();
    $('l-add').addEventListener('click', async () => {
      const out = await session.line({ code: $('l-code').value, qty: $('l-qty').value, priceRupees: $('l-price').value });
      if (out.result !== 'ok') { $('l-status').textContent = api.outcomeWords(lang, out); return; }
      lines = [...lines, out.value]; $('l-status').textContent = ''; $('l-code').value = ''; $('l-qty').value = ''; $('l-price').value = ''; paintLines();
    });
    $('q-make').addEventListener('click', async () => {
      $('q-number').hidden = true;
      const out = await session.make({ storeId: $('q-store').value, customerRef: $('q-customer').value, validUntil: $('q-until').value, approvalId: $('q-approval').value, lines });
      $('q-status').textContent = api.outcomeWords(lang, out);
      // R8-B · OB-525: a price below its floor — offer to ask a second person for exactly this quotation.
      $('q-ask').hidden = session.belowFloor() === undefined; $('q-ask-status').textContent = '';
      if (out.result === 'ok') { $('q-number').hidden = false; $('q-number').textContent = out.value.quotationId; lines = []; paintLines(); }
    });
    $('q-ask').addEventListener('click', async () => {
      const out = await session.askApproval();
      $('q-ask-status').textContent = api.outcomeWords(lang, out);
    });
  }
}
