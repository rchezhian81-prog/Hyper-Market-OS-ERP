// Standing orders — blanket purchase orders (M06-FR-02 · §28 · QG-02) — the page over head office's own agreements. The
// session (apps/web-erp/src/blanket-orders-session.ts, in the bundle as window.blanketOrders) does every call; this page lays
// out what it is told. Nothing is read on open; every write is a click. Every word has a Tamil twin; every button its icon.

const $ = (id) => document.getElementById(id);

// ── U2b (UI/UX gap audit G5 · P-07): a thing is PICKED by name through the chrome's picker, never typed as a code ───────
// The field keeps the id the page sends (the typed code stays possible when the list cannot be read — head office down,
// no right — so the form is never a dead end, P-01 · P-08); the chrome's sheet finds it by name, code or barcode and the
// name is shown beside the field. Mounted when the chrome is there (a page that paints first listens for `sre:chrome`).
// (one line on purpose: the page's own `  en: {` / `  ta: {` blocks stay the first ones the screen guardrails find)
const pickWords = { en: { choose: 'Choose…', pickProduct: 'Which product?', pickSupplier: 'Which supplier?', pickStore: 'Which store?', pickCustomer: 'Which customer?' }, ta: { choose: 'தேர்ந்தெடு…', pickProduct: 'எந்தப் பொருள்?', pickSupplier: 'எந்த விநியோகஸ்தர்?', pickStore: 'எந்தக் கடை?', pickCustomer: 'எந்த வாடிக்கையாளர்?' } };
const pw = (k) => pickWords[document.documentElement.lang === 'ta' ? 'ta' : 'en'][k] ?? pickWords.en[k];
const pickRepaints = [];
const repaintPickers = () => { for (const f of pickRepaints) f(); };
function pickable(inputId, kind, titleKey, extra = {}) {
  const input = document.getElementById(inputId);
  if (!input || input.dataset.pickable === 'on') return;
  const office = window.sreOffice;
  if (!office || typeof office.pick !== 'function') { document.addEventListener('sre:chrome', () => pickable(inputId, kind, titleKey, extra), { once: true }); return; }
  input.dataset.pickable = 'on';
  const row = document.createElement('div'); row.className = 'pick-row';
  input.replaceWith(row); row.append(input);
  const btn = document.createElement('button'); btn.type = 'button'; btn.id = `${inputId}-pick`; btn.className = 'sre-btn sre-btn-quiet pick';
  const name = document.createElement('span'); name.id = `${inputId}-name`; name.className = 'pick-name';
  row.append(btn, name);
  // the kind may depend on the form (a store price picks a store, a customer price a customer); null = no list exists, so no button
  const kindNow = () => (typeof kind === 'function' ? kind() : kind);
  const titleNow = () => (typeof titleKey === 'function' ? titleKey() : titleKey);
  const paint = () => { btn.hidden = kindNow() === null; btn.textContent = pw('choose'); btn.setAttribute('aria-label', `${pw('choose')} ${pw(titleNow())}`); };
  paint(); pickRepaints.push(paint);
  btn.addEventListener('click', async () => {
    const k = kindNow(); if (k === null) return;
    const tk = titleNow();
    const picked = await office.pick({ kind: k, title: { en: pickWords.en[tk], ta: pickWords.ta[tk] }, allowCode: true, ...(typeof extra.scope === 'function' ? { scope: extra.scope() } : {}), ...(typeof extra.filter === 'function' ? { filter: extra.filter } : {}) });
    if (!picked || picked.ok !== true) return;
    input.value = typeof extra.idOf === 'function' ? extra.idOf(picked) : String(picked.id ?? '');
    name.textContent = typeof picked.name === 'string' && picked.name !== input.value ? picked.name : '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (typeof extra.onPick === 'function') extra.onPick(picked);
  });
  input.addEventListener('input', (e) => { if (e.isTrusted) name.textContent = ''; });
}
/** The signed-in person's own store, filled in while the field is empty (changeable; the id stays what the page sends). */
function prefillStore(inputId) {
  const fill = () => {
    const input = document.getElementById(inputId); if (!input || input.value.trim() !== '') return;
    const me = typeof window.sreOffice?.me === 'function' ? window.sreOffice.me() : null;
    const id = me?.storeId ?? window.sreDirectory?.store?.id ?? '';
    if (id !== '') { input.value = id; input.dispatchEvent(new Event('change', { bubbles: true })); }
  };
  if (window.sreOffice && typeof window.sreOffice.me === 'function') fill(); else document.addEventListener('sre:chrome', fill, { once: true });
}
const api = window.blanketOrders ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, propose: false, approve: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));

// U2 · G14 (UI/UX gap audit): a date a shop person reads — dd/mm/yyyy in the chrome's shared field (`sreOffice.dateField`),
// while the page goes on sending ISO (`dateOf`). Before the chrome has loaded, or off the box, the field stays as it was.
const wordsIn = (l, k) => (api === null ? k : api.words(l, k)); // the page's own words, for either language (null off the box)
const shopDates = new Map();
/** The shared fields' labels follow the language toggle like the page's own words do. */
function repaintShopDates() { const l = document.documentElement.lang === 'ta' ? 'ta' : 'en'; for (const [id, words] of shopDates) { const lab = $(id)?.closest('.sre-field')?.querySelector('.sre-field-label'); if (lab && lab.firstChild) lab.firstChild.textContent = words[l] ?? words.en; } }
function shopDate(id, words, opts = {}) {
  const office = window.sreOffice; const input = $(id);
  if (!office || typeof office.dateField !== 'function' || input === null || shopDates.has(id)) return;
  // a value already on the plain field is carried over — ISO as the page set it, or dd/mm/yyyy as a person typed it
  const typed = input.value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(typed) ? typed : (typeof office.parseShopDate === 'function' ? office.parseShopDate(typed) : null);
  const field = office.dateField({ id, label: words, required: opts.required === true, ...(iso ? { value: iso } : {}), ...(opts.hint ? { hint: opts.hint } : {}) });
  (input.closest('label') ?? input).replaceWith(field);
  shopDates.set(id, words);
}
const dateOf = (id) => (shopDates.has(id) ? (window.sreOffice.dateValue(id) ?? '') : ($(id)?.value ?? ''));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, iconName, cls) { const b = document.createElement('button'); b.classList.add('sre-btn'); b.type = 'button'; if (cls) b.className = cls; const i = icon(iconName); if (i !== null) b.append(i); b.append(text('span', words)); return b; }
const say = (id, out) => { $(id).textContent = api.outcomeWords(lang, out); };
let list = null;

function agreementRow(v) {
  const a = v.agreement; const d = v.drawdown;
  const li = document.createElement('li'); li.dataset.agreement = a.agreementId; li.dataset.status = a.status;
  if (a.status === 'proposed' || v.expired) li.className = 'attention';
  const state = a.status === 'proposed' ? `⏳ ${t('proposed')}` : v.expired ? `✕ ${t('expired')}` : v.validToday ? `✓ ${t('validToday')}` : `○ ${t('notInForce')}`;
  li.append(text('strong', `${a.agreementId} · ${t('supplier')} ${a.supplierId} · ${a.validFrom} – ${a.validTo} · ${state}`));
  li.append(text('span', `${t('ceiling')} ${api.rupees(d.ceilingMinor)} · ${t('issued')} ${api.rupees(d.issuedMinor)} · ${t('pending')} ${api.rupees(d.pendingMinor)} · ${t('remaining')} ${api.rupees(d.remainingMinor)} · ${t('releases')} ${d.releases}`, 'figures'));
  for (const p of d.byProduct) {
    const cost = a.lines.find((l) => l.productId === p.productId)?.agreedUnitCost.minor;
    li.append(text('span', `${t('product')} ${p.productId}${cost === undefined ? '' : ` @ ${api.rupees(cost)}`} · ${t('released')} ${p.releasedQty}${p.maxQty === null ? ` · ${t('noLimit')}` : ` / ${t('maxQty')} ${p.maxQty} · ${p.remainingQty} ${t('left')}`}`, 'meta'));
  }
  li.append(text('span', `${t('proposedBy')} ${a.proposedBy}${a.approvedBy === null ? '' : ` · ${t('approvedBy')} ${a.approvedBy}`}`, 'meta'));
  if (a.status === 'proposed' && may.approve) {
    const acts = document.createElement('div'); acts.className = 'acts';
    const lab = document.createElement('label'); lab.append(text('span', t('reason'))); const why = document.createElement('input'); why.className = 'approve-why'; why.autocomplete = 'off'; lab.append(why);
    const b = button(t('approve'), 'check'); b.dataset.act = 'approve';
    b.addEventListener('click', async () => { const out = await session.approve(a.agreementId, why.value); say('l-status', out); if (out.result === 'ok') await showList(); });
    acts.append(lab, b); li.append(acts);
  }
  return li;
}
function paintList() {
  const ul = $('list-rows'); ul.replaceChildren();
  if (list === null) return;
  if (list.agreements.length === 0) ul.append(text('li', `○ ${t('none')}`));
  for (const v of list.agreements) ul.append(agreementRow(v));
}
function paint() {
  repaintShopDates();
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['list-h', 'listH'], ['l-show-text', 'show'], ['propose-h', 'proposeH'], ['p-supplier-l', 'supplier'], ['p-ceiling-l', 'ceilingRs'], ['p-from-l', 'validFrom'], ['p-to-l', 'validTo'],
    ['p-deliver-l', 'deliverTo'], ['p-lines-l', 'lines'], ['p-propose-text', 'propose']]) { const n = $(id); if (n) n.textContent = t(key); }
  paintList();
}
async function showList() {
  const out = await session.list();
  if (out.result !== 'ok') { list = null; say('l-status', out); paintList(); return; }
  list = out.value; $('l-status').textContent = list.awaitingApprovalCount > 0 ? `⏳ ${list.awaitingApprovalCount} ${t('waiting')}` : ''; paintList();
}

for (const [id, name] of [['l-show', 'search'], ['p-propose', 'send']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); repaintPickers(); });
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else {
  $('list').hidden = false;
  $('l-show').addEventListener('click', () => { void showList(); });
  if (may.propose) {
    $('propose').hidden = false;
    $('p-propose').addEventListener('click', async () => {
      const out = await session.propose({ supplierId: $('p-supplier').value, ceilingRupees: $('p-ceiling').value, validFrom: dateOf('p-from'), validTo: dateOf('p-to'), deliverTo: $('p-deliver').value, lines: $('p-lines').value });
      say('p-status', out);
      if (out.result === 'ok') await showList();
    });
  }
}
// the chrome loads after this script: its shared date fields replace the plain ones once it is there
document.addEventListener('sre:chrome', () => { shopDate('p-from', { en: wordsIn('en', 'validFrom'), ta: wordsIn('ta', 'validFrom') }); shopDate('p-to', { en: wordsIn('en', 'validTo'), ta: wordsIn('ta', 'validTo') }); paint(); }, { once: true });

pickable('p-supplier', 'supplier', 'pickSupplier');
pickable('p-deliver', 'store', 'pickStore');
prefillStore('p-deliver');
