// Weighing scales — the page over head office's scale register (OB-154 "A" · B6 · B7 · L2). It holds no rule: the session
// (apps/web-erp/src/scales-session.ts, in the bundle as window.scales) reads and writes head office's own routes in the
// signed-in person's session, refuses only a blank field or a malformed date before a POST, and hands every refusal back
// in head office's words. A later stamp date needs a second person: head office says so, the page offers "ask", and the
// approved change is saved from "Waiting for approval". Nothing is written on open; after each act everything is read
// again. Every word has a Tamil twin and follows the toggle.

const $ = (id) => document.getElementById(id);
const api = window.scales ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, manage: false };

let lang = 'en';
const t = (k, slots) => (api === null ? k : api.words(lang, k, slots));
let reg = null; // Register | null
const FIELDS = [['assetId', 'f-asset'], ['storeId', 'f-store'], ['lanes', 'f-lanes'], ['approvalNo', 'f-approval-no'], ['capacityGrams', 'f-capacity'], ['lastStampedOn', 'f-stamped'], ['reverificationDueOn', 'f-valid'], ['certificateRef', 'f-certificate']];
const form = () => Object.fromEntries(FIELDS.map(([k, id]) => [k, $(id).value]));

function say(el, out, good) {
  el.className = `status ${out.result === 'ok' ? 'good' : 'err'}`;
  el.textContent = out.result === 'ok' ? good : api.outcomeWords(lang, out);
}
function cell(text) { const td = document.createElement('td'); td.textContent = text; return td; }

function paintSummary() {
  const s = api.summarise(reg);
  for (const [k, v] of [['scales', s.scales], ['lapsed', s.lapsed], ['soon', s.soon], ['waiting', s.waiting]]) $(`v-${k}`).textContent = v === null ? '—' : String(v);
  $('p-lapsed').classList.toggle('attention', (s.lapsed ?? 0) > 0);
  $('as-of').textContent = reg === null ? '' : t('asOf', { day: reg.asOf });
}

function paintRegister() {
  const body = $('scale-rows');
  body.replaceChildren();
  const rows = reg?.scales ?? [];
  $('no-scales').hidden = reg === null || rows.length > 0;
  $('no-scales').textContent = t('noScales');
  for (const s of rows) {
    const tr = document.createElement('tr');
    tr.dataset.asset = s.assetId; tr.dataset.level = s.verification.level;
    tr.append(cell(s.assetId), cell(s.storeId), cell(s.laneIds.join(', ')), cell(s.lastStampedOn), cell(s.reverificationDueOn),
      cell(s.certificateRef ?? t('noCertificate')), cell(api.stampWords(lang, s)), cell(s.approvedBy ? `${s.setBy} · ${s.approvedBy}` : s.setBy));
    if (may.manage) {
      // Open "Add or update" with this scale as it stands on the register.
      tr.tabIndex = 0;
      const open = () => edit(s);
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    }
    body.append(tr);
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
      const b = document.createElement('button'); b.type = 'button'; b.textContent = t('saveApproved'); b.dataset.act = 'save-approved';
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
    ['c-scale', 'colScale'], ['c-store', 'colStore'], ['c-lanes', 'colLanes'], ['c-stamped', 'colStamped'], ['c-valid', 'colValid'], ['c-certificate', 'colCertificate'], ['c-state', 'colState'], ['c-by', 'colBy'],
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
  for (const [k, id] of FIELDS) $(id).value = f[k];
  $('f-ask').hidden = true;
  $('edit-status').textContent = '';
  showTab('edit');
  $('f-valid').focus();
}

async function load() {
  if (session === null || !may.named || !may.read) return;
  const out = await session.load();
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
