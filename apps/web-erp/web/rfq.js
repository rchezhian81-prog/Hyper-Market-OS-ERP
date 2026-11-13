// Requests for quotation — the page over head office's RFQ routes (U6 · M06-FR-02 · M24-FR-01). The session
// (apps/web-erp/src/rfq-session.ts, in the bundle as window.rfq) does every call and every rule; this page lays out what it is
// told on the shared office parts (window.sreOffice: cards, table, state, chip, pickable, shopDate). Every word has a Tamil
// twin; head office's own sentences stay in English (OB-553).

const $ = (id) => document.getElementById(id);
const api = window.rfq ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, send: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const both = (k) => (api === null ? { en: k, ta: k } : { en: api.words('en', k), ta: api.words('ta', k) });
/** A greyed button says why (U1 · design system §4): the words sit in a small line after it, in the reader's language. */
function whyDisabled(btn, why) {
  const words = why === '' || why === undefined || why === null ? '' : typeof why === 'string' ? why : (why[lang] ?? why.en);
  let note = btn.nextElementSibling;
  if (!(note && note.classList.contains('sre-why'))) { note = document.createElement('small'); note.className = 'sre-why'; note.id = `${btn.id}-why`; btn.after(note); }
  note.textContent = words; note.hidden = words === '';
  if (words === '') btn.removeAttribute('aria-describedby'); else btn.setAttribute('aria-describedby', note.id);
}
const office = () => window.sreOffice ?? null;
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
const shopDayOf = (value) => window.sreShopDay?.dateOf(value) ?? value;
const shopTime = (at) => (at === null ? '' : window.sreShopDay?.dateTimeOf(at) ?? at);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }

let requisitions = null; let register = null; let registerOutcome = null; let registerAt = null;
let asked = []; // the supplier ids added to the request, kept across repaints

/** The register of requests sent: counts as cards, then one register with search, sort and paging (U5 parts). */
function paintRegister() {
  const o = office();
  $('r-covers').textContent = ''; $('r-cards').replaceChildren(); $('r-note').textContent = '';
  if (registerOutcome !== null) {
    $('r-status').textContent = api.outcomeWords(lang, registerOutcome);
    if (o !== null) o.state($('r-table'), o.stateOf(registerOutcome), { title: t('notKnown'), detail: t('notKnownDetail') });
    return;
  }
  if (register === null) { $('r-status').textContent = ''; if (o !== null) o.state($('r-table'), 'loading'); return; }
  $('r-status').textContent = '';
  $('r-covers').textContent = t('covers').split('{time}').join(shopTime(registerAt));
  $('r-note').textContent = t('headOfficeEnglish');
  if (o === null) { $('r-table').replaceChildren(...register.rfqs.map((r) => text('p', `${r.rfqId} · ${r.requisitionId} · ${r.answered}/${r.asked} · ${t(`state_${r.state}`)}`, 'meta'))); return; }
  o.cards($('r-cards'), [
    { label: both('state_open'), value: register.counts.open, tone: register.counts.open > 0 ? 'pending' : undefined, icon: 'clock' },
    { label: both('state_overdue'), value: register.counts.overdue, tone: register.counts.overdue > 0 ? 'error' : undefined, icon: 'circle-alert' },
    { label: both('state_answered'), value: register.counts.answered, tone: register.counts.answered > 0 ? 'ok' : undefined, icon: 'circle-check' },
  ]);
  if (register.rfqs.length === 0) { o.state($('r-table'), 'empty', { title: t('none'), detail: t('noneDetail') }); return; }
  const nameOf = (id) => { const n = o.nameOf('supplier', id); return n && n !== id ? `${n} (${id})` : id; };
  const personOf = (id) => { const n = o.nameOf('person', id); return n && n !== id ? n : id; };
  o.table($('r-table'), {
    id: 'rfqs', label: both('registerH'), rows: register.rfqs, pageSize: 10, sortable: true,
    rowKey: (r) => r.rfqId, rowData: (r) => ({ rfq: r.rfqId, requisition: r.requisitionId, state: r.state }),
    columns: [
      { key: 'rfqId', label: both('rfq'), sort: 'text' },
      { key: 'requisitionId', label: both('requisition'), sort: 'text' },
      { key: 'answered', label: both('answered'), sort: 'number', align: 'end', value: (r) => `${r.answered} / ${r.asked}` },
      { key: 'dueOn', label: both('due'), sort: 'text', value: (r) => o.dateWords(r.dueOn) },
      { key: 'state', label: both('state'), sort: 'text', filter: true, value: (r) => t(`state_${r.state}`), render: (r) => o.chip(api.stateTone(r.state), t(`state_${r.state}`)) },
      { key: 'sentBy', label: both('sentBy'), sort: 'text', value: (r) => personOf(r.sentBy) },
      { key: 'sentAt', label: both('sentOn'), sort: 'text', value: (r) => shopDayOf(r.sentAt) },
    ],
    drawer: {
      title: (r) => `${t('rfq')} ${r.rfqId}`,
      body: (r) => {
        const box = document.createElement('div');
        box.append(o.facts([[both('requisition'), r.requisitionId], [both('due'), o.dateWords(r.dueOn)], [both('sentBy'), personOf(r.sentBy)], [both('sentOn'), shopDayOf(r.sentAt)], ...(r.note ? [[both('note'), r.note]] : [])]));
        const ul = document.createElement('ul'); ul.className = 'asked';
        for (const s of r.suppliers) {
          const li = document.createElement('li'); li.dataset.supplier = s.supplierId; li.dataset.answered = String(s.answered);
          li.append(text('span', nameOf(s.supplierId)), o.chip(s.answered ? 'ok' : 'pending', s.answered ? `${t('answeredYes')} · ${t('quoteOn')} ${s.quoteId}` : t('answeredNo')));
          ul.append(li);
        }
        box.append(ul);
        const a = document.createElement('a'); a.className = 'sre-btn'; a.href = `../requisitions/?requisition=${encodeURIComponent(r.requisitionId)}`; a.textContent = t('compare');
        box.append(a);
        return box;
      },
    },
    empty: { title: t('none'), detail: t('noneDetail') },
  });
}

/** The send form: the requisition's lines under the choice, the suppliers added one by one, the day, the note. */
function paintSend() {
  const o = office();
  // The shared picker and date field take over their own labels once the chrome is there, so a label may be gone by then.
  const say = (id, words) => { const n = $(id); if (n) n.textContent = words; };
  say('send-h', t('sendH')); say('s-req-l', t('requisition')); say('s-supplier-l', t('supplier'));
  say('s-add-text', t('addSupplier')); say('s-asked-l', t('suppliers')); say('s-due-l', t('dueOn'));
  say('s-note-l', t('note')); say('s-send-text', t('send'));
  const sel = $('s-req'); const kept = sel.value;
  const opts = [new Option(t('chooseRequisition'), '')];
  for (const r of requisitions ?? []) opts.push(new Option(`${r.requisitionId} — ${api.linesText(r)}`, r.requisitionId));
  sel.replaceChildren(...opts);
  if ([...sel.options].some((x) => x.value === kept)) sel.value = kept;
  const chosen = (requisitions ?? []).find((r) => r.requisitionId === sel.value);
  $('s-lines').textContent = requisitions !== null && requisitions.length === 0 ? t('noRequisitions') : chosen ? `${t('lines')}: ${api.linesText(chosen)}` : '';
  const ul = $('s-asked'); ul.replaceChildren();
  if (asked.length === 0) ul.append(text('li', t('nobodyAsked'), 'meta'));
  for (const id of asked) {
    const li = document.createElement('li'); li.dataset.supplier = id;
    const name = o !== null ? o.nameOf('supplier', id) : id;
    li.append(text('span', name && name !== id ? `${name} (${id})` : id));
    const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'sre-btn sre-btn-quiet'; rm.textContent = t('remove'); rm.setAttribute('aria-label', `${t('remove')} ${id}`);
    rm.addEventListener('click', () => { asked = asked.filter((x) => x !== id); paintSend(); });
    li.append(rm); ul.append(li);
  }
  const can = may.send && chosen !== undefined && asked.length > 0;
  $('s-send').disabled = !can;
  whyDisabled($('s-send'), can ? '' : !may.send ? t('cannotSend') : chosen === undefined ? t('needRequisition') : t('needSupplier'));
}

function paint() {
  $('title-text').textContent = t('title'); document.title = `SRE ${t('title')}`; $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  $('r-h').textContent = t('registerH'); $('r-reload-text').textContent = t('refresh');
  paintSend(); paintRegister();
}

async function loadRegister() {
  $('r-status').textContent = t('reading');
  const out = await session.register();
  if (out.result === 'ok') { register = out.value; registerOutcome = null; registerAt = new Date().toISOString(); } else { register = null; registerOutcome = out; }
  paintRegister();
}
async function loadRequisitions() {
  const out = await session.requisitions();
  requisitions = out.result === 'ok' ? out.value : [];
  paintSend();
}
function addAsked() {
  const out = api.addSupplier(asked, $('s-supplier').value);
  if (!out.ok) { $('s-status').textContent = t(out.why); return; }
  asked = out.list; $('s-supplier').value = ''; const n = $('s-supplier-name'); if (n) n.textContent = ''; $('s-status').textContent = ''; paintSend();
}
async function send() {
  const o = office();
  $('s-status').textContent = t('reading');
  const dueOn = o !== null && typeof o.dateOf === 'function' ? o.dateOf('s-due') : ($('s-due').value || null);
  const out = await session.send({ requisitionId: $('s-req').value, supplierIds: asked, dueOn, note: $('s-note').value });
  if (out.result !== 'ok') { $('s-status').textContent = api.outcomeWords(lang, out); return; }
  $('s-status').textContent = t('sent'); asked = []; $('s-note').value = ''; paintSend(); await loadRegister();
}

for (const [id, name] of [['r-reload', 'refresh-cw'], ['s-send', 'send'], ['s-add', 'plus']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
$('s-req').addEventListener('change', () => { paintSend(); });
$('s-add').addEventListener('click', () => { addAsked(); });
$('s-supplier').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addAsked(); } });
$('s-send').addEventListener('click', () => { void send(); });
$('r-reload').addEventListener('click', () => { void loadRegister(); });
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else {
  $('register').hidden = false;
  if (may.send) $('send').hidden = false; else $('page-status').textContent = t('cannotSend');
  void loadRegister(); void loadRequisitions();
}
// the chrome loads after this script: the picker and the shared date field take the plain inputs once it is there
document.addEventListener('sre:chrome', () => {
  const o = office(); if (o === null) return;
  if (typeof o.pickable === 'function') o.pickable('s-supplier', 'supplier', both('supplier'), { onPick: () => { addAsked(); } });
  if (typeof o.shopDate === 'function') o.shopDate('s-due', both('dueOn'), { required: true });
  paint();
}, { once: true });
document.addEventListener('sre:chrome', () => { paint(); });
