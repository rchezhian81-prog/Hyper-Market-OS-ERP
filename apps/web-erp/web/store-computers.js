// Store computers — the page over head office's store computer bindings, findings and the "replaced" act (round 26 ·
// OB-99 · OB-97 · OB-98). It holds no rule: the session (apps/web-erp/src/store-computers-session.ts, in the bundle as
// window.storeComputers) reads and writes head office's own routes in the signed-in person's session, refuses only blank
// input or a short reason before a POST, and hands every refusal back in head office's words. What the person may do is
// head office's own answer on the bindings read — the owner and head office staff with all stores act; others read.
// Nothing is written on open; after each act everything is read again. Every word has a Tamil twin and follows the toggle.

const $ = (id) => document.getElementById(id);
// ── U2b (UI/UX gap audit G5 · G14 · P-07): a thing is PICKED by name through the chrome's picker, never typed as a code,
// and a date is written as the shop writes it (dd/mm/yyyy) through the chrome's shared field. The field keeps the id the
// page sends (the typed code stays possible when the list cannot be read — head office down, no right — so the form is
// never a dead end, P-01 · P-08); the chrome's sheet finds the thing by name, code or barcode and the name is shown beside
// the field. Mounted when the chrome is there (a page that paints first listens for `sre:chrome`); off the box nothing
// changes. The same six-line pattern as the U2 pages (store-tasks, delegation, floor-heat-map).
const u2bWords = Object.freeze({ en: { choose: 'Choose…', pickProduct: 'Which product?', pickPlace: 'Which place in the store?', pickPerson: 'Which person?', pickStore: 'Which store?', pickCustomer: 'Which customer?', pickApproval: 'Which approval?', pickSupplier: 'Which supplier?', yourStore: 'your store' }, ta: { choose: 'தேர்ந்தெடு…', pickProduct: 'எந்தப் பொருள்?', pickPlace: 'கடையில் எந்த இடம்?', pickPerson: 'எந்த நபர்?', pickStore: 'எந்தக் கடை?', pickCustomer: 'எந்த வாடிக்கையாளர்?', pickApproval: 'எந்த அனுமதி?', pickSupplier: 'எந்த விநியோகஸ்தர்?', yourStore: 'உங்கள் கடை' } }); // one line on purpose: a page's own word tables start a line with `en: {`
const u2bLang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const u2bWord = (k) => u2bWords[u2bLang()][k] ?? u2bWords.en[k];
const u2bRepaints = [];
const repaintPickers = () => { for (const f of u2bRepaints) f(); };
/** Mount the picker on an input the page built itself (no id needed); the id a pick gives lands in the input. */
function pickableEl(input, kind, titleKey, extra = {}) {
  if (!input || input.dataset.pickable === 'on') return;
  const office = window.sreOffice;
  if (!office || typeof office.pick !== 'function') { document.addEventListener('sre:chrome', () => pickableEl(input, kind, titleKey, extra), { once: true }); return; }
  input.dataset.pickable = 'on';
  const row = document.createElement('div'); row.className = 'pick-row';
  input.replaceWith(row); row.append(input);
  const btn = document.createElement('button'); btn.type = 'button'; if (input.id) btn.id = `${input.id}-pick`; btn.className = 'sre-btn sre-btn-quiet pick';
  const name = document.createElement('span'); if (input.id) name.id = `${input.id}-name`; name.className = 'pick-name';
  row.append(btn, name);
  const paint = () => { btn.textContent = u2bWord('choose'); btn.setAttribute('aria-label', `${u2bWord('choose')} ${u2bWord(titleKey)}`); };
  paint(); u2bRepaints.push(paint);
  btn.addEventListener('click', async () => {
    const k = typeof extra.kindOf === 'function' ? extra.kindOf() : kind;
    const tk = typeof extra.titleOf === 'function' ? extra.titleOf() : titleKey;
    const picked = await office.pick({ kind: k, title: { en: u2bWords.en[tk], ta: u2bWords.ta[tk] }, allowCode: true, ...(typeof extra.scope === 'function' ? { scope: extra.scope() } : {}), ...(typeof extra.filter === 'function' ? { filter: extra.filter } : {}) });
    if (!picked || picked.ok !== true) return;
    const id = typeof extra.idOf === 'function' ? extra.idOf(picked) : String(picked.id ?? '');
    if (typeof extra.append === 'function') extra.append(input, id); else input.value = id;
    name.textContent = typeof picked.name === 'string' && picked.name !== id ? picked.name : '';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (typeof extra.onPick === 'function') extra.onPick(picked);
  });
  input.addEventListener('input', () => { name.textContent = ''; });
}
function pickable(inputId, kind, titleKey, extra = {}) {
  const input = document.getElementById(inputId);
  if (!input) return;
  if (!window.sreOffice || typeof window.sreOffice.pick !== 'function') { document.addEventListener('sre:chrome', () => pickable(inputId, kind, titleKey, extra), { once: true }); return; }
  pickableEl(input, kind, titleKey, extra);
}
// the pickers' words follow the language toggle like the page's own words
new MutationObserver(() => { repaintPickers(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
// ── U2b end
const api = window.storeComputers ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false };

let lang = 'en';
const t = (k, slots) => (api === null ? k : api.words(lang, k, slots));
// OB-607: a moment is shown at the SHOP's clock (its zone, as the store computer told the page) — never the UTC clock.
const when = (iso) => (typeof iso === 'string' ? window.sreShopDay?.dateTimeOf(iso) ?? '' : '');

let board = null; // Board | null
let tab = 'bindings';
const you = () => board?.you ?? { mayReplace: false, mayAcknowledge: false };

function say(el, out, good) {
  el.className = `status ${out.result === 'ok' ? 'good' : 'err'}`;
  el.textContent = out.result === 'ok' ? good : api.outcomeWords(lang, out);
}

function paintSummary() {
  const s = api.summarise(board);
  for (const [k, v] of [['bindings', s.bindings], ['replaced', s.replaced], ['needs', s.needs], ['waiting', s.waiting], ['unused', s.unused], ['zones', s.zones]]) $(`v-${k}`).textContent = v === null || v === undefined ? '—' : String(v);
  $('p-needs').classList.toggle('attention', (s.needs ?? 0) > 0);
  $('p-zones').classList.toggle('attention', (s.zones ?? 0) > 0);
}

function cell(text) { const td = document.createElement('td'); td.textContent = text; return td; }

// U2 · G16 (UI/UX gap audit): a NAME where an id was shown — the store's name, the store computer's name, the time zone in
// words — through the chrome (`sreOffice.nameOf`); the id itself when no name is known, never blank.
const nameOf = (kind, id) => { const o = window.sreOffice; const key = id ?? ''; return o && typeof o.nameOf === 'function' && key !== '' ? (o.nameOf(kind, key) || key) : key; };
function button(text, act, onClick) { const b = document.createElement('button'); b.classList.add('sre-btn'); b.type = 'button'; b.textContent = text; b.dataset.act = act; b.addEventListener('click', onClick); return b; }

function paintBindings() {
  const body = $('binding-rows');
  body.replaceChildren();
  const rows = board?.bindings ?? [];
  $('no-bindings').hidden = board === null || rows.length > 0;
  $('no-bindings').textContent = t('noBindings');
  for (const b of rows) {
    const tr = document.createElement('tr');
    tr.dataset.store = b.storeId; tr.dataset.prefix = b.prefix; tr.dataset.computer = b.computer; tr.dataset.via = b.via;
    tr.append(cell(nameOf('store', b.storeId)), cell(b.prefix), cell(nameOf('person', b.computer)), cell(b.via === 'replacement' ? t('viaReplaced') : t('viaFirst')), cell(when(b.since)));
    if (you().mayReplace) {
      // Open the drawer for this till, the old store computer already filled in.
      tr.tabIndex = 0;
      const open = () => openReplace(b);
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    }
    body.append(tr);
  }
}

// Round 27 · OB-100: numbers taken and never used, per store, till and day — information only (no action here).
function paintUnused() {
  const body = $('unused-rows');
  body.replaceChildren();
  const rows = board?.unused ?? [];
  $('no-unused').hidden = board === null || rows.length > 0;
  $('no-unused').textContent = t('noUnused');
  for (const u of rows) {
    const tr = document.createElement('tr');
    tr.dataset.store = u.storeId; tr.dataset.prefix = u.prefix; tr.dataset.day = u.day; tr.dataset.count = String(u.count);
    tr.append(cell(nameOf('store', u.storeId)), cell(u.prefix), cell(u.day), cell(String(u.count)), cell(api.unusedWords(lang, u)));
    body.append(tr);
  }
}

// R3 · P-08: each store computer's own time zone against the shop's — a wrong one is said in words (P-08), wrong ones first.
function paintZones() {
  const body = $('zone-rows');
  body.replaceChildren();
  const rows = board?.zones ?? [];
  $('no-zones').hidden = board === null || rows.length > 0;
  $('no-zones').textContent = t('noZones');
  for (const z of rows) {
    const tr = document.createElement('tr');
    tr.dataset.store = z.storeId; tr.dataset.verdict = z.verdict;
    if (z.verdict === 'differs') tr.className = 'attention';
    tr.append(cell(nameOf('store', z.storeId)), cell(nameOf('person', z.computer ?? '')), cell(nameOf('zone', z.machineTimeZone)), cell(`${nameOf('zone', z.shopTimeZone)}${z.shopTimeZoneFrom === 'shop_default' ? ` ${t('zoneDefault')}` : ''}`), cell(api.zoneWords(lang, z)), cell(when(z.lastReportAt)));
    body.append(tr);
  }
}

function paintFindings() {
  const list = $('finding-rows');
  list.replaceChildren();
  const rows = board?.findings ?? [];
  $('no-findings').hidden = board === null || rows.length > 0;
  $('no-findings').textContent = t('noFindings');
  for (const f of rows) {
    const li = document.createElement('li');
    li.dataset.kind = f.kind; li.dataset.store = f.storeId; li.dataset.prefix = f.prefix;
    const head = document.createElement('strong');
    head.textContent = `${api.findingWords(lang, f)} — ${nameOf('store', f.storeId)} · ${f.prefix}`;
    const detail = document.createElement('span');
    detail.textContent = f.detail;
    li.append(head, detail);
    if (you().mayAcknowledge && api.acknowledgeable(f)) {
      const reason = document.createElement('input');
      reason.placeholder = t('ackReason'); reason.setAttribute('aria-label', t('ackReason')); reason.dataset.role = 'ack-reason';
      const status = document.createElement('p'); status.className = 'status'; status.setAttribute('role', 'status');
      li.append(reason, button(t('acknowledge'), 'acknowledge', async () => {
        const out = await session.acknowledge(f, reason.value);
        say(status, out, t('acknowledged'));
        if (out.result === 'ok') { say($('page-status'), out, t('acknowledged')); await load(); }
      }), status);
    }
    list.append(li);
  }
}

function paintRequests() {
  const list = $('request-rows');
  list.replaceChildren();
  const requests = board?.requests ?? [];
  for (const r of requests) {
    const li = document.createElement('li');
    li.dataset.requestId = r.requestId; li.dataset.status = r.status;
    const d = r.details;
    const head = document.createElement('strong');
    head.textContent = `${d.prefix} · ${nameOf('store', d.storeId)}: ${nameOf('person', d.fromComputer)} → ${nameOf('person', d.toComputer)}`;
    const state = document.createElement('span');
    state.textContent = `${api.requestWords(lang, r)} — ${d.reason}`;
    li.append(head, state);
    if (r.status === 'approved' && you().mayReplace) {
      const status = document.createElement('p'); status.className = 'status'; status.setAttribute('role', 'status');
      li.append(button(t('send'), 'send', async () => {
        const out = await session.send(r);
        say(status, out, out.result === 'ok' ? t('sent', { prefix: d.prefix, to: d.toComputer }) : '');
        if (out.result === 'ok') { say($('page-status'), out, t('sent', { prefix: d.prefix, to: d.toComputer })); await load(); }
      }), status);
    }
    list.append(li);
  }
  const acts = $('act-rows');
  acts.replaceChildren(...(board?.replacements ?? []).map((m) => {
    const li = document.createElement('li');
    li.dataset.replacement = m.replacementId;
    li.textContent = t('actLine', { prefix: m.prefix, store: m.storeId, from: m.from, to: m.to, by: m.requestedBy, approver: m.approvedBy, at: when(m.at) });
    return li;
  }));
  $('no-requests').hidden = board === null || requests.length + (board?.replacements ?? []).length > 0;
  $('no-requests').textContent = t('noRequests');
}

function paintWords() {
  document.title = `SRE ${t('title')}`;
  const pairs = [['title', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['open-replace', 'replace'],
    ['k-bindings', 'sumBindings'], ['k-replaced', 'sumReplaced'], ['k-needs', 'sumNeeds'], ['k-waiting', 'sumWaiting'], ['k-unused', 'sumUnused'],
    ['k-zones', 'sumZones'], ['zones-h', 'zonesH'], ['zones-lead', 'zonesLead'], ['c-z-store', 'colStore'], ['c-z-computer', 'colComputer'], ['c-z-zone', 'colZone'], ['c-z-shop', 'colShopZone'], ['c-z-says', 'colZoneSays'], ['c-z-reported', 'colReported'],
    ['unused-h', 'unusedH'], ['unused-lead', 'unusedLead'], ['c-u-store', 'colStore'], ['c-u-prefix', 'colPrefix'], ['c-u-day', 'colDay'], ['c-u-count', 'colCount'], ['c-u-numbers', 'colNumbers'],
    ['tab-bindings', 'tabBindings'], ['tab-findings', 'tabFindings'], ['tab-requests', 'tabRequests'],
    ['bindings-h', 'tabBindings'], ['bindings-lead', 'bindingsLead'], ['findings-h', 'tabFindings'], ['findings-lead', 'findingsLead'], ['requests-h', 'tabRequests'], ['requests-lead', 'requestsLead'],
    ['c-store', 'colStore'], ['c-prefix', 'colPrefix'], ['c-computer', 'colComputer'], ['c-via', 'colVia'], ['c-since', 'colSince'],
    ['replace-h', 'replace'], ['l-f-store', 'fStore'], ['l-f-prefix', 'fPrefix'], ['l-f-from', 'fFrom'], ['l-f-to', 'fTo'], ['l-f-reason', 'fReason'], ['f-ask', 'ask'], ['f-cancel', 'cancel']];
  for (const [id, k] of pairs) { const el = $(id); if (el) el.textContent = t(k); }
  $('lang').textContent = t('lang');
  $('open-replace').hidden = !you().mayReplace;
  const nobody = $('nobody');
  nobody.hidden = may.named;
  nobody.textContent = t('nobody');
  const status = $('page-status');
  if (may.named && !may.read) { status.className = 'status err'; status.textContent = t('cannotRead'); }
  else if (board !== null && !you().mayReplace && !you().mayAcknowledge) { status.className = 'status'; status.textContent = t('notYours'); }
}

function paintAll() { paintWords(); paintSummary(); paintBindings(); paintUnused(); paintZones(); paintFindings(); paintRequests(); }

function showTab(which) {
  tab = which;
  for (const id of ['bindings', 'findings', 'requests']) {
    $(`view-${id}`).hidden = which !== id;
    if (which === id) $(`tab-${id}`).setAttribute('aria-current', 'page'); else $(`tab-${id}`).removeAttribute('aria-current');
  }
}

async function load() {
  if (session === null || !may.named || !may.read) return;
  const out = await session.load();
  if (out.result === 'ok') board = out.value; else say($('page-status'), out, '');
  paintAll();
}

function openReplace(b) {
  $('replace-status').textContent = '';
  $('f-store').value = b?.storeId ?? '';
  $('f-prefix').value = b?.prefix ?? '';
  $('f-from').value = b?.computer ?? '';
  $('replace-sheet').hidden = false;
  (b === undefined ? $('f-store') : $('f-to')).focus();
}

$('open-replace').addEventListener('click', () => openReplace(undefined));
$('f-cancel').addEventListener('click', () => { $('replace-sheet').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('replace-sheet').hidden = true; });
for (const id of ['bindings', 'findings', 'requests']) $(`tab-${id}`).addEventListener('click', () => showTab(id));

$('f-ask').addEventListener('click', async () => {
  const out = await session.ask({ storeId: $('f-store').value, prefix: $('f-prefix').value, fromComputer: $('f-from').value, toComputer: $('f-to').value, reason: $('f-reason').value });
  say($('replace-status'), out, t('asked'));
  if (out.result === 'ok') {
    $('f-to').value = ''; $('f-reason').value = '';
    $('replace-sheet').hidden = true;
    say($('page-status'), out, t('asked'));
    await load();
    showTab('requests');
  }
});

$('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintAll();
});

paintWords();
showTab(tab);
if (may.named && may.read) { $('page-status').textContent = t('reading'); void load().then(() => { if ($('page-status').textContent === t('reading')) $('page-status').textContent = ''; paintWords(); }); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}

// ── U2b (G5): the store is picked by name
pickable('f-store', 'store', 'pickStore');
