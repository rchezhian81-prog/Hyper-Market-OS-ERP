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
const u2bRepaints = [];
const repaintPickers = () => { for (const f of u2bRepaints) f(); };
/** Mount the picker on an input the page built itself (no id needed); the id a pick gives lands in the input. */
function pickableEl(input, kind, titleKey, extra = {}) {
  // U5: the chrome's own adapter (`sreOffice.pickable`) draws the "Choose…" button (#<id>-pick) and the name beside (#<id>-name);
  // this page keeps only its title words and the per-field options. The typed code stays the fallback (never a dead end).
  const office = window.sreOffice;
  if (!office || typeof office.pickable !== 'function') return;
  office.pickable(input, kind, { en: u2bWords.en[titleKey] ?? titleKey, ta: u2bWords.ta[titleKey] ?? titleKey }, extra);
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
let loaded = false; // head office has answered once (ok or refused)
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


// U2 · G16 (UI/UX gap audit): a NAME where an id was shown — the store's name, the store computer's name, the time zone in
// words — through the chrome (`sreOffice.nameOf`); the id itself when no name is known, never blank.
const nameOf = (kind, id) => { const o = window.sreOffice; const key = id ?? ''; return o && typeof o.nameOf === 'function' && key !== '' ? (o.nameOf(kind, key) || key) : key; };
function button(text, act, onClick) { const b = document.createElement('button'); b.classList.add('sre-btn'); b.type = 'button'; b.textContent = text; b.dataset.act = act; b.addEventListener('click', onClick); return b; }

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
const W = (k) => ({ en: api === null ? k : api.words('en', k), ta: api === null ? k : api.words('ta', k) });

function paintBindings() {
  const rows = board?.bindings ?? [];
  const c = register('binding-host', {
    id: 'bindings', label: W('tabBindings'), bodyId: 'binding-rows', sortable: true, pageSize: 10,
    rowKey: (b) => `${b.storeId}:${b.prefix}`, rowData: (b) => ({ store: b.storeId, prefix: b.prefix, computer: b.computer, via: b.via }),
    columns: [
      { key: 'storeId', label: W('colStore'), filter: true, value: (b) => nameOf('store', b.storeId) },
      { key: 'prefix', label: W('colPrefix') },
      { key: 'computer', label: W('colComputer'), value: (b) => nameOf('person', b.computer) },
      { key: 'via', label: W('colVia'), value: (b) => (b.via === 'replacement' ? t('viaReplaced') : t('viaFirst')) },
      { key: 'since', label: W('colSince'), value: (b) => when(b.since) },
      ...(you().mayReplace ? [{ key: 'replace', label: W('replace'), sort: false, render: (b) => { const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'sre-btn sre-btn-quiet'; btn.dataset.act = 'replace'; btn.textContent = t('replace'); btn.addEventListener('click', (e) => { e.stopPropagation(); openReplace(b); }); return btn; } }] : []),
    ],
    rows: board === null ? null : rows,
    ...(board === null && loaded ? { state: 'unknown' } : {}),
    empty: { title: W('noBindings') },
  });
  // a tap on the row itself still opens the drawer for this till, the old store computer already filled in
  if (c !== null && !$('binding-host').dataset.wired) {
    $('binding-host').dataset.wired = '1';
    $('binding-host').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-prefix]'); if (tr === null || e.target.closest('button') || !you().mayReplace) return; const b = (board?.bindings ?? []).find((x) => x.storeId === tr.dataset.store && x.prefix === tr.dataset.prefix); if (b) openReplace(b); });
  }
}

// Round 27 · OB-100: numbers taken and never used, per store, till and day — information only (no action here).
function paintUnused() {
  const rows = board?.unused ?? [];
  register('unused-host', {
    id: 'unused', label: W('unusedH'), bodyId: 'unused-rows', sortable: true, pageSize: 10,
    rowKey: (u) => `${u.storeId}:${u.prefix}:${u.day}`, rowData: (u) => ({ store: u.storeId, prefix: u.prefix, day: u.day, count: String(u.count) }),
    columns: [
      { key: 'storeId', label: W('colStore'), filter: true, value: (u) => nameOf('store', u.storeId) },
      { key: 'prefix', label: W('colPrefix') },
      { key: 'day', label: W('colDay') },
      { key: 'count', label: W('colCount'), sort: 'number', align: 'end' },
      { key: 'numbers', label: W('colNumbers'), value: (u) => api.unusedWords(lang, u) },
    ],
    rows: board === null ? null : rows,
    ...(board === null && loaded ? { state: 'unknown' } : {}),
    empty: { title: W('noUnused') },
  });
}

// R3 · P-08: each store computer's own time zone against the shop's, from its latest health report.
function paintZones() {
  const rows = board?.zones ?? [];
  register('zone-host', {
    id: 'zones', label: W('zonesH'), bodyId: 'zone-rows', sortable: true, pageSize: 10,
    rowKey: (z) => z.storeId, rowData: (z) => ({ store: z.storeId, verdict: z.verdict }),
    columns: [
      { key: 'storeId', label: W('colStore'), value: (z) => nameOf('store', z.storeId) },
      { key: 'computer', label: W('colComputer'), value: (z) => nameOf('person', z.computer ?? '') },
      { key: 'zone', label: W('colZone'), value: (z) => nameOf('zone', z.machineTimeZone) },
      { key: 'shopZone', label: W('colShopZone'), value: (z) => `${nameOf('zone', z.shopTimeZone)}${z.shopTimeZoneFrom === 'shop_default' ? ` ${t('zoneDefault')}` : ''}` },
      // the verdict as the one chip, head office's sentence beside it
      { key: 'says', label: W('colZoneSays'), filter: true, value: (z) => api.zoneWords(lang, z), render: (z) => { const f = document.createDocumentFragment(); f.append(chip(z.verdict === 'differs' ? 'error' : z.verdict === 'same' ? 'ok' : 'unknown', api.zoneWords(lang, z))); return f; } },
      { key: 'reported', label: W('colReported'), value: (z) => when(z.lastReportAt) },
    ],
    rows: board === null ? null : rows,
    ...(board === null && loaded ? { state: 'unknown' } : {}),
    empty: { title: W('noZones') },
  });
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
  loaded = true;
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
