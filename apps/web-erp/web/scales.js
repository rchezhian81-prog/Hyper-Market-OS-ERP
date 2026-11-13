// Weighing scales — the page over head office's scale register (OB-154 "A" · B6 · B7 · L2). It holds no rule: the session
// (apps/web-erp/src/scales-session.ts, in the bundle as window.scales) reads and writes head office's own routes in the
// signed-in person's session, refuses only a blank field or a malformed date before a POST, and hands every refusal back
// in head office's words. A later stamp date needs a second person: head office says so, the page offers "ask", and the
// approved change is saved from "Waiting for approval". Nothing is written on open; after each act everything is read
// again. Every word has a Tamil twin and follows the toggle.

const $ = (id) => document.getElementById(id);
const u2bLang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
// A date a shop person reads — dd/mm/yyyy in the chrome's shared field, while the page goes on sending ISO (`dateOf`).
const shopDates = new Map();
function repaintShopDates() { const l = u2bLang(); for (const [id, words] of shopDates) { const lab = document.getElementById(id)?.closest('.sre-field')?.querySelector('.sre-field-label'); if (lab && lab.firstChild) lab.firstChild.textContent = words[l] ?? words.en; } }
function shopDate(id, words, opts = {}) {
  // U5: the chrome's own adapter (`sreOffice.shopDate`) swaps the box for the shared dd/mm/yyyy field under the same id; the
  // page reads ISO back with `dateOf` and remembers which fields it swapped.
  const office = window.sreOffice;
  if (!office || typeof office.shopDate !== 'function') { document.addEventListener('sre:chrome', () => shopDate(id, words, opts), { once: true }); return; }
  if (shopDates.has(id)) return;
  if (office.shopDate(id, words, opts) !== null) shopDates.set(id, words);
}
const dateOf = (id) => (shopDates.has(id) ? (window.sreOffice.dateValue(id) ?? '') : (document.getElementById(id)?.value ?? ''));
/** Put an ISO day on a field the page sets itself (today, a row being edited): the shared field shows it in the shop's form. */
function setShopDate(id, iso) { const n = document.getElementById(id); if (n === null) return; if (shopDates.has(id)) n.closest('.sre-date')?.sreSetDate?.(iso); else n.value = iso; }
// ── U2b (UI/UX gap audit G14): the shared date fields' labels follow the language toggle like the page's own words
new MutationObserver(() => { repaintShopDates(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
// ── U2b end
const api = window.scales ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, manage: false };

let lang = 'en';
const t = (k, slots) => (api === null ? k : api.words(lang, k, slots));
let reg = null; // Register | null
let loaded = false; // head office has answered once (ok or refused) — the register's state is then known, not "loading"
const FIELDS = [['assetId', 'f-asset'], ['storeId', 'f-store'], ['lanes', 'f-lanes'], ['approvalNo', 'f-approval-no'], ['capacityGrams', 'f-capacity'], ['lastStampedOn', 'f-stamped'], ['reverificationDueOn', 'f-valid'], ['certificateRef', 'f-certificate']];
const DATE_FIELDS = new Set(['f-stamped', 'f-valid']);
const form = () => Object.fromEntries(FIELDS.map(([k, id]) => [k, DATE_FIELDS.has(id) ? dateOf(id) : $(id).value]));

function say(el, out, good) {
  el.className = `status ${out.result === 'ok' ? 'good' : 'err'}`;
  el.textContent = out.result === 'ok' ? good : api.outcomeWords(lang, out);
}

// ── U5 · G17 (UI/UX gap audit): every list on this page is the chrome's register part (`sreOffice.table`) — search, sort
// with its direction in words, paging, a count line, rows that stack on a phone. The old `<tbody id>` is kept as the
// register's body id so the records' data attributes read the same. Before the chrome has loaded the host waits for it.
const registers = new Map();
function register(hostId, opts) {
  const host = $(hostId); const o = window.sreOffice;
  if (host === null) return null;
  if (!o || typeof o.table !== 'function') {
    if (!registers.has(hostId)) { registers.set(hostId, null); document.addEventListener('sre:chrome', () => { registers.delete(hostId); register(hostId, opts); }, { once: true }); }
    return null;
  }
  let c = registers.get(hostId) ?? null;
  if (c === null || !c.connected()) { c = o.table(host, opts); registers.set(hostId, c); }
  else if (opts.state) c.setState(opts.state, opts.stateOpts ?? {}); else c.setRows(opts.rows ?? null);
  return c;
}
const chip = (tone, label) => { const o = window.sreOffice; if (o && typeof o.chip === 'function') return o.chip(tone, label); const s = document.createElement('span'); s.className = 'sre-chip'; s.dataset.tone = tone; s.textContent = typeof label === 'string' ? label : (label?.en ?? ''); return s; };

// U7 (Group C2 · notes-P4): the summary figures are the chrome's summary cards (`sreOffice.cards`) — a figure head office
// has not given reads "Not known", never a dash, and a figure that needs a person carries the card's tone (shape + words
// stay with the label). The parts keep the page's ids (`p-`, `k-`, `v-`). Off the box the page's own panels stay.
function summaryCards(rows) {
  const o = window.sreOffice; const host = document.querySelector('.panels');
  if (!o || typeof o.cards !== 'function' || host === null) return false;
  o.cards(host, rows.map(([k, value, wordKey, attention]) => ({ label: W(wordKey), value: value === null || value === undefined ? null : String(value), ...(attention ? { tone: 'degraded' } : {}), ids: { card: `p-${k}`, label: `k-${k}`, value: `v-${k}` } })));
  return true;
}
function paintSummary() {
  const s = api.summarise(reg);
  $('as-of').textContent = reg === null ? '' : t('asOf', { day: reg.asOf });
  if (summaryCards([['scales', s.scales, 'sumScales'], ['lapsed', s.lapsed, 'sumLapsed', (s.lapsed ?? 0) > 0], ['soon', s.soon, 'sumSoon'], ['waiting', s.waiting, 'sumWaiting']])) return;
  for (const [k, v] of [['scales', s.scales], ['lapsed', s.lapsed], ['soon', s.soon], ['waiting', s.waiting]]) $(`v-${k}`).textContent = v === null ? '—' : String(v);
  $('p-lapsed').classList.toggle('attention', (s.lapsed ?? 0) > 0);
  $('as-of').textContent = reg === null ? '' : t('asOf', { day: reg.asOf });
}

const W = (k) => ({ en: api === null ? k : api.words('en', k), ta: api === null ? k : api.words('ta', k) });
const LEVEL_TONE = { lapsed: 'error', due_soon: 'degraded', current: 'ok', waiting: 'pending' };
const nameOf = (kind, id) => { const o = window.sreOffice; const key = id ?? ''; return o && typeof o.nameOf === 'function' && key !== '' ? (o.nameOf(kind, key) || key) : key; };
function paintRegister() {
  const rows = reg?.scales ?? [];
  const c = register('scale-host', {
    id: 'scales', label: W('tabRegister'), bodyId: 'scale-rows', sortable: true, pageSize: 10,
    rowKey: (s) => s.assetId, rowData: (s) => ({ asset: s.assetId, level: s.verification.level }),
    columns: [
      { key: 'assetId', label: W('colScale') },
      { key: 'storeId', label: W('colStore'), value: (s) => nameOf('store', s.storeId), filter: true },
      { key: 'lanes', label: W('colLanes'), value: (s) => s.laneIds.join(', ') },
      { key: 'lastStampedOn', label: W('colStamped'), value: (s) => s.lastStampedOn },
      { key: 'reverificationDueOn', label: W('colValid'), value: (s) => s.reverificationDueOn },
      { key: 'certificateRef', label: W('colCertificate'), value: (s) => s.certificateRef ?? t('noCertificate') },
      // the stamp's state as the one chip (tone by level) with head office's words beside it
      { key: 'state', label: W('colState'), value: (s) => api.stampWords(lang, s), render: (s) => { const f = document.createDocumentFragment(); f.append(chip(LEVEL_TONE[s.verification.level] ?? 'unknown', api.stampWords(lang, s))); return f; } },
      { key: 'by', label: W('colBy'), value: (s) => (s.approvedBy ? `${nameOf('person', s.setBy)} · ${nameOf('person', s.approvedBy)}` : nameOf('person', s.setBy)) },
      ...(may.manage ? [{ key: 'edit', label: W('tabEdit'), sort: false, render: (s) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'sre-btn sre-btn-quiet'; b.dataset.act = 'edit'; b.textContent = t('tabEdit'); b.addEventListener('click', (e) => { e.stopPropagation(); edit(s); }); return b; } }] : []),
    ],
    rows: reg === null ? null : rows,
    ...(reg === null && loaded ? { state: 'unknown' } : {}),
    empty: { title: W('noScales') },
  });
  // a tap on the row itself still opens "Add or update" with the scale as it stands (the Edit button is the named way)
  if (c !== null && may.manage && !$('scale-host').dataset.wired) {
    $('scale-host').dataset.wired = '1';
    $('scale-host').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-asset]'); if (tr === null || e.target.closest('button')) return; const s = (reg?.scales ?? []).find((x) => x.assetId === tr.dataset.asset); if (s) edit(s); });
  }
}

function paintRequests() {
  const list = $('request-rows');
  list.replaceChildren();
  const rows = reg?.requests ?? [];
  $('no-requests').hidden = reg === null || rows.length > 0;
  $('no-requests').textContent = t('noRequests');
  for (const r of rows) {
    const li = document.createElement('li');
    li.dataset.requestId = r.requestId; li.dataset.status = r.status;
    const head = document.createElement('strong');
    head.textContent = t('reqLine', { asset: r.details.assetId, valid: r.details.reverificationDueOn, certificate: r.details.certificateRef });
    const state = document.createElement('span');
    state.textContent = api.requestWords(lang, r);
    li.append(head, state);
    if (r.status === 'approved' && may.manage) {
      const status = document.createElement('p'); status.className = 'status'; status.setAttribute('role', 'status');
      const b = document.createElement('button'); b.classList.add('sre-btn'); b.type = 'button'; b.textContent = t('saveApproved'); b.dataset.act = 'save-approved';
      b.addEventListener('click', async () => {
        const out = await session.saveApproved(r);
        say(status, out, t('saved'));
        if (out.result === 'ok') { say($('page-status'), out, t('saved')); await load(); showTab('register'); }
      });
      li.append(b, status);
    }
    list.append(li);
  }
}

function paintWords() {
  document.title = `SRE ${t('title')}`;
  const pairs = [['title', 'title'], ['page-h', 'title'], ['lead', 'lead'],
    ['k-scales', 'sumScales'], ['k-lapsed', 'sumLapsed'], ['k-soon', 'sumSoon'], ['k-waiting', 'sumWaiting'],
    ['tab-register', 'tabRegister'], ['tab-edit', 'tabEdit'], ['tab-requests', 'tabRequests'],
    ['register-h', 'tabRegister'], ['register-lead', 'registerLead'], ['edit-h', 'tabEdit'], ['edit-lead', 'editLead'], ['requests-h', 'tabRequests'], ['requests-lead', 'requestsLead'],
    ['l-f-asset', 'fAsset'], ['l-f-store', 'fStore'], ['l-f-lanes', 'fLanes'], ['l-f-approval-no', 'fApprovalNo'], ['l-f-capacity', 'fCapacity'], ['l-f-stamped', 'fStamped'], ['l-f-valid', 'fValid'], ['l-f-certificate', 'fCertificate'],
    ['f-save', 'save'], ['f-ask', 'ask']];
  for (const [id, k] of pairs) { const el = $(id); if (el) el.textContent = t(k); }
  $('lang').textContent = t('lang');
  // Only what this person may do is offered; head office re-checks it anyway.
  $('tab-edit').hidden = !may.manage;
  $('tab-requests').hidden = !may.manage;
  const nobody = $('nobody');
  nobody.hidden = may.named;
  nobody.textContent = t('nobody');
  const status = $('page-status');
  if (may.named && !may.read) { status.className = 'status err'; status.textContent = t('cannotRead'); }
  else if (reg !== null && !may.manage) { status.className = 'status'; status.textContent = t('readOnly'); }
}

function paintAll() { paintWords(); paintSummary(); paintRegister(); paintRequests(); }

function showTab(which) {
  for (const id of ['register', 'edit', 'requests']) {
    $(`view-${id}`).hidden = which !== id;
    if (which === id) $(`tab-${id}`).setAttribute('aria-current', 'page'); else $(`tab-${id}`).removeAttribute('aria-current');
  }
}

function edit(s) {
  const f = api.formOf(s);
  for (const [k, id] of FIELDS) { if (DATE_FIELDS.has(id)) setShopDate(id, f[k]); else $(id).value = f[k]; }
  $('f-ask').hidden = true;
  $('edit-status').textContent = '';
  showTab('edit');
  $('f-valid').focus();
}

async function load() {
  if (session === null || !may.named || !may.read) return;
  const out = await session.load();
  loaded = true;
  if (out.result === 'ok') reg = out.value; else say($('page-status'), out, '');
  paintAll();
}

for (const id of ['register', 'edit', 'requests']) $(`tab-${id}`).addEventListener('click', () => showTab(id));

$('f-save').addEventListener('click', async () => {
  const out = await session.save(form());
  say($('edit-status'), out, t('saved'));
  // A later stamp date: head office asks for a second person — the page offers exactly that.
  $('f-ask').hidden = !(out.result === 'refused' && out.code === 'scale_stamp_change_needs_approval');
  if (out.result === 'ok') { say($('page-status'), out, t('saved')); await load(); showTab('register'); }
});

$('f-ask').addEventListener('click', async () => {
  const out = await session.ask(form());
  say($('edit-status'), out, t('asked'));
  if (out.result === 'ok') { $('f-ask').hidden = true; say($('page-status'), out, t('asked')); await load(); showTab('requests'); }
});

$('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintAll();
});

paintAll();
void load();

// The shell is cached so the page still opens without a network (it then says so, and reads nothing).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}

// ── U2b (G14): a date a shop person reads — the stamp dates on the shared dd/mm field, ISO sent as before
if (api !== null) {
  shopDate('f-stamped', { en: api.words('en', 'fStamped'), ta: api.words('ta', 'fStamped') });
  shopDate('f-valid', { en: api.words('en', 'fValid'), ta: api.words('ta', 'fValid') });
}
// U7: the summary figures become the chrome's cards as soon as the chrome is there.
document.addEventListener('sre:chrome', () => { if (api !== null) paintSummary(); }, { once: true });
