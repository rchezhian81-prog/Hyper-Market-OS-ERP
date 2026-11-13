// Quotations (OB-506 · M12-FR-02) — the page over head office's retail-quotation routes. The session
// (apps/web-erp/src/quotations-session.ts, in the bundle as window.quotations) does every call; this page lays out what it is
// told. Nothing is read on open; every write is a click. Every word has a Tamil twin; every button its icon.

const $ = (id) => document.getElementById(id);

// ── U2 (UI/UX gap audit G5 · P-07): a thing is PICKED by name through the chrome's picker, never typed as a code ───────
// The field keeps the id the page sends (the typed code stays possible when the list cannot be read — head office down,
// no right — so the form is never a dead end, P-01 · P-08); the chrome's sheet finds it by name, code or barcode and the
// name is shown beside the field. Mounted when the chrome is there (a page that paints first listens for `sre:chrome`).
const pickWords = {
  en: { choose: 'Choose…', pickProduct: 'Which product?', pickPlace: 'Which place in the store?', pickPerson: 'Which person?', pickStore: 'Which store?', pickCustomer: 'Which customer?', pickApproval: 'Which approval?' },
  ta: { choose: 'தேர்ந்தெடு…', pickProduct: 'எந்தப் பொருள்?', pickPlace: 'கடையில் எந்த இடம்?', pickPerson: 'எந்த நபர்?', pickStore: 'எந்தக் கடை?', pickCustomer: 'எந்த வாடிக்கையாளர்?', pickApproval: 'எந்த அனுமதி?' },
};
const pickRepaints = [];
const repaintPickers = () => { for (const f of pickRepaints) f(); };
function pickable(inputId, kind, titleKey, extra = {}) {
  // U5: the chrome's own adapter (`sreOffice.pickable`, U2's page copy folded into the chrome).
  const office = window.sreOffice;
  if (!office || typeof office.pickable !== 'function') { document.addEventListener('sre:chrome', () => pickable(inputId, kind, titleKey, extra), { once: true }); return; }
  office.pickable(inputId, kind, { en: pickWords.en[titleKey], ta: pickWords.ta[titleKey] }, extra);
}
// A date a shop person reads (dd/mm/yyyy, the shop's calendar) through the chrome's shared field; read back as ISO.
/** The shared date fields' labels follow the language toggle like the page's own words do (OB-699). */
const dateLabels = new Map();
function repaintDateLabels() { const l = document.documentElement.lang === 'ta' ? 'ta' : 'en'; for (const [id, words] of dateLabels) { const w = words(); const lab = document.getElementById(id)?.closest('.sre-field')?.querySelector('.sre-field-label'); if (lab && lab.firstChild) lab.firstChild.textContent = w[l] ?? w.en; } }
function dateable(inputId, label, extra = {}) {
  // U5: the chrome's own `shopDate` adapter — the page's date box becomes the shared dd/mm/yyyy field under the same id.
  const office = window.sreOffice;
  if (!office || typeof office.shopDate !== 'function') { document.addEventListener('sre:chrome', () => dateable(inputId, label, extra), { once: true }); return; }
  office.shopDate(inputId, typeof label === 'function' ? label() : label, { required: extra.required !== false, ...(extra.min ? { min: extra.min } : {}) });
}
const dateOf = (fieldId) => {
  const f = document.getElementById(fieldId);
  if (f && f.tagName === 'INPUT' && f.type === 'date') return f.value;
  const office = window.sreOffice;
  return office && typeof office.dateValue === 'function' ? (office.dateValue(fieldId) ?? '') : (f && 'value' in f ? f.value : '');
};
const api = window.quotations ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, write: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, iconName, quiet) {
  const b = document.createElement('button'); b.type = 'button'; if (quiet) b.className = 'quiet sre-btn sre-btn-quiet';
  const i = icon(iconName); if (i !== null) b.append(i);
  b.append(text('span', words)); return b;
}
let lines = [];
/** The person's own store, as the store computer or head office names it — filled in, never typed first (U2). */
function fillStore() {
  if ($('q-store').value !== '') return;
  const fromBox = window.quotationsData && typeof window.quotationsData.storeId === 'string' ? window.quotationsData.storeId : '';
  const me = window.sreOffice && typeof window.sreOffice.me === 'function' ? window.sreOffice.me() : null;
  const mine = fromBox !== '' ? fromBox : me && typeof me.storeId === 'string' ? me.storeId : '';
  if (mine !== '') $('q-store').value = mine;
}
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

// U5 (G16): the customer's NAME beside the code on each line, as head office holds it (the code alone when it holds none).
let customerNames = {};
const customerWords = (ref) => (customerNames[ref] ? `${customerNames[ref]} (${ref})` : ref);
async function loadCustomerNames() { if (session === null || typeof session.customerNames !== 'function') return; customerNames = await session.customerNames(); }
function paintRows() {
  $('rows').replaceChildren();
  if (rows === null) return;
  if (rows.items.length === 0) { $('rows').append(text('li', t('none'), 'meta')); return; }
  if (rows.kind === 'follow') {
    $('rows').replaceChildren(...rows.items.map((q) => {
      const li = text('li', `${t('number')} ${q.quotationId} · ${customerWords(q.customerRef)} · ${api.rupees(q.valueMinor)} · ${q.daysLeft < 0 ? t('lapsed') : `${q.daysLeft} ${t('daysLeft')}`}`, q.daysLeft <= 1 ? 'attention' : '');
      li.dataset.quotation = q.quotationId; return li;
    }));
    return;
  }
  $('rows').replaceChildren(...rows.items.map((q) => {
    const li = document.createElement('li'); li.dataset.quotation = q.quotationId; li.dataset.state = q.state;
    li.append(text('div', `${t('number')} ${q.quotationId} · ${customerWords(q.customerRef)} · ${api.rupees(q.totalMinor)} · ${t(`s_${q.state}`)}`));
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
  for (const [elId, key] of [['make-h', 'makeH'], ['q-store-l', 'store'], ['q-customer-l', 'customer'], ['q-until-l', 'validUntil'], ['l-code-l', 'lineCode'], ['l-qty-l', 'lineQty'],
    ['l-price-l', 'linePrice'], ['l-add-text', 'addLine'], ['lines-h', 'linesH'], ['q-approval-l', 'approval'], ['q-make-text', 'make'], ['q-ask-text', 'askApproval'],
    ['list-h', 'listH'], ['s-state-l', 'state'], ['s-show-text', 'show'], ['s-follow-text', 'followUp']]) { const el = $(elId); if (el) el.textContent = t(key); } // U2: the date field's own label is the chrome's
  if (session !== null && session.needsOwner && session.needsOwner()) $('q-ask-text').textContent = t('askOwner'); // R9-A · OB-532
  if (session !== null && session.needsAccountant && session.needsAccountant()) $('q-ask-text').textContent = t('askAccountant'); // R10-A · OB-542
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
  if (Object.keys(customerNames).length === 0) await loadCustomerNames();
  rows = { kind: 'list', items: out.value.quotations }; $('s-status').textContent = ''; paintRows();
}

for (const [id, name] of [['l-add', 'list-plus'], ['q-make', 'check'], ['q-ask', 'badge-check'], ['s-show', 'list'], ['s-follow', 'clock']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); repaintPickers(); repaintDateLabels(); });
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
    // U2: the store is the signed-in person's own (changeable); the customer, the item and the approval are picked by
    // name; the date is the shared dd/mm field. The ids sent are exactly what they were.
    fillStore();
    document.addEventListener('sre:chrome', fillStore, { once: true });
    pickable('q-store', 'store', 'pickStore');
    pickable('q-customer', 'customer', 'pickCustomer', { idOf: (p) => String(p.id ?? '') });
    pickable('l-code', 'product', 'pickProduct', { idOf: (p) => String(p.code ?? p.id ?? '') });
    pickable('q-approval', 'approval', 'pickApproval', { scope: () => ($('q-store').value === '' ? {} : { storeId: $('q-store').value }) });
    dateable('q-until', () => ({ en: api.words('en', 'validUntil'), ta: api.words('ta', 'validUntil') }));
    dateLabels.set('q-until', () => ({ en: api.words('en', 'validUntil'), ta: api.words('ta', 'validUntil') }));
    $('l-add').addEventListener('click', async () => {
      const out = await session.line({ code: $('l-code').value, qty: $('l-qty').value, priceRupees: $('l-price').value });
      if (out.result !== 'ok') { $('l-status').textContent = api.outcomeWords(lang, out); return; }
      lines = [...lines, out.value]; $('l-status').textContent = ''; $('l-code').value = ''; $('l-qty').value = ''; $('l-price').value = ''; paintLines();
    });
    $('q-make').addEventListener('click', async () => {
      $('q-number').hidden = true;
      const out = await session.make({ storeId: $('q-store').value, customerRef: $('q-customer').value, validUntil: dateOf('q-until'), approvalId: $('q-approval').value, lines });
      $('q-status').textContent = api.outcomeWords(lang, out);
      // R8-B · OB-525: a price below its floor — offer to ask a second person for exactly this quotation.
      $('q-ask').hidden = session.belowFloor() === undefined; $('q-ask-status').textContent = '';
      // R9-A · OB-532: a product whose floor head office does not know — only the OWNER may approve; the button says so.
      // R10-A · OB-542: the OWNER's own quotation on such a product — the ACCOUNTANT approves; the button says so.
      $('q-ask-text').textContent = t(session.needsOwner() ? 'askOwner' : session.needsAccountant() ? 'askAccountant' : 'askApproval');
      if (out.result === 'ok') { $('q-number').hidden = false; $('q-number').textContent = out.value.quotationId; lines = []; paintLines(); }
    });
    $('q-ask').addEventListener('click', async () => {
      const out = await session.askApproval();
      $('q-ask-status').textContent = api.outcomeWords(lang, out);
    });
  }
}
