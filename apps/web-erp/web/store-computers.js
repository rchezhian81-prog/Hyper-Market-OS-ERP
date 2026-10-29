// Store computers — the page over head office's store computer bindings, findings and the "replaced" act (round 26 ·
// OB-99 · OB-97 · OB-98). It holds no rule: the session (apps/web-erp/src/store-computers-session.ts, in the bundle as
// window.storeComputers) reads and writes head office's own routes in the signed-in person's session, refuses only blank
// input or a short reason before a POST, and hands every refusal back in head office's words. What the person may do is
// head office's own answer on the bindings read — the owner and head office staff with all stores act; others read.
// Nothing is written on open; after each act everything is read again. Every word has a Tamil twin and follows the toggle.

const $ = (id) => document.getElementById(id);
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
function button(text, act, onClick) { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.dataset.act = act; b.addEventListener('click', onClick); return b; }

function paintBindings() {
  const body = $('binding-rows');
  body.replaceChildren();
  const rows = board?.bindings ?? [];
  $('no-bindings').hidden = board === null || rows.length > 0;
  $('no-bindings').textContent = t('noBindings');
  for (const b of rows) {
    const tr = document.createElement('tr');
    tr.dataset.store = b.storeId; tr.dataset.prefix = b.prefix; tr.dataset.computer = b.computer; tr.dataset.via = b.via;
    tr.append(cell(b.storeId), cell(b.prefix), cell(b.computer), cell(b.via === 'replacement' ? t('viaReplaced') : t('viaFirst')), cell(when(b.since)));
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
    tr.append(cell(u.storeId), cell(u.prefix), cell(u.day), cell(String(u.count)), cell(api.unusedWords(lang, u)));
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
    tr.append(cell(z.storeId), cell(z.computer ?? ''), cell(z.machineTimeZone), cell(`${z.shopTimeZone}${z.shopTimeZoneFrom === 'shop_default' ? ` ${t('zoneDefault')}` : ''}`), cell(api.zoneWords(lang, z)), cell(when(z.lastReportAt)));
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
    head.textContent = `${api.findingWords(lang, f)} — ${f.storeId} · ${f.prefix}`;
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
    head.textContent = `${d.prefix} · ${d.storeId}: ${d.fromComputer} → ${d.toComputer}`;
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
