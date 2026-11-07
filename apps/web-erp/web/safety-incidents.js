// Safety incidents (W3 · D11-FR-06) — the page over head office's facility safety-incident routes. The session
// (apps/web-erp/src/safety-incidents-session.ts, in the bundle as window.safetyIncidents) does every call and every rule;
// this page lays out what it is told. It reads the store's incidents as it opens; recording and closing are explicit
// presses. Every word this page adds has a Tamil twin; head office's own sentences stay in English (OB-553).

const $ = (id) => document.getElementById(id);
const api = window.safetyIncidents ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, record: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
const when = (iso) => (api === null ? iso : api.moment(iso));

let rows = null;

function paintOptions() {
  for (const [id, values, prefix] of [['r-kind', api?.kinds ?? [], 'k_'], ['r-severity', api?.severities ?? [], 's_']]) {
    const sel = $(id); const was = sel.value;
    sel.replaceChildren(...values.map((v) => { const o = document.createElement('option'); o.value = v; o.textContent = t(`${prefix}${v}`); return o; }));
    if (was !== '') sel.value = was;
  }
}

function field(id, words, control) { const l = document.createElement('label'); l.htmlFor = id; control.id = id; l.append(text('span', words), control); return l; }

function paintList() {
  $('rows').replaceChildren();
  if (rows === null) return;
  if (rows.length === 0) $('rows').append(text('li', t('none'), 'meta'));
  for (const r of rows) {
    const li = document.createElement('li'); li.dataset.incident = r.incidentId; li.dataset.open = String(r.open);
    li.append(text('h4', `${r.open ? `⚠ ${t('open')}` : `✓ ${t('closed')}`} · ${t(`k_${r.kind}`)} · ${t(`s_${r.severity}`)} · ${when(r.occurredAt)}`),
      text('p', `${r.description} · ${t('reportedByWord')} ${r.reportedBy} · ${r.evidence} ${t('evidenceCount')}${r.assetId === null ? '' : ` · ${r.assetId}`}`, 'meta'));
    if (!r.open && r.actionTaken !== null) li.append(text('p', `${t('action')}: ${r.actionTaken}${r.closedAt === null ? '' : ` · ${when(r.closedAt)}`}`, 'meta'));
    if (r.open && may.record) {
      const form = document.createElement('form'); form.className = 'acts';
      const action = document.createElement('input'); action.autocomplete = 'off'; action.maxLength = 1000; action.className = 'c-action';
      const on = document.createElement('input'); on.type = 'date'; on.className = 'c-authority';
      const status = text('p', '', 'status'); status.setAttribute('role', 'status');
      const b = document.createElement('button'); b.type = 'submit'; b.className = 'quiet sre-btn sre-btn-quiet'; b.textContent = t('close');
      form.append(field(`c-action-${r.incidentId}`, t('actionTaken'), action));
      if (r.severity === 'reportable') form.append(field(`c-on-${r.incidentId}`, t('authorityOn'), on));
      form.append(b, status);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        status.textContent = t('reading');
        const out = await session.close(r.incidentId, action.value, on.value);
        status.textContent = out.result === 'ok' ? t('closedNow') : api.outcomeWords(lang, out);
        if (out.result === 'ok') void load();
      });
      li.append(form);
    }
    $('rows').append(li);
  }
}

function paint() {
  document.title = `SRE ${t('title')}`;
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['pick-h', 'store'], ['s-store-l', 'store'], ['s-read-text', 'read'], ['raise-h', 'raiseH'], ['r-kind-l', 'kind'], ['r-severity-l', 'severity'], ['r-when-l', 'occurredAt'], ['r-who-l', 'reportedBy'], ['r-what-l', 'description'], ['r-evidence-l', 'evidence'], ['r-asset-l', 'asset'], ['r-raise-text', 'raise'], ['list-h', 'listH']]) $(id).textContent = t(key);
  paintOptions(); paintList();
}

async function load() {
  $('list-status').textContent = t('reading');
  const out = await session.list($('s-store').value);
  if (out.result === 'ok') { rows = out.value; $('list-status').textContent = ''; } else { rows = null; $('list-status').textContent = api.outcomeWords(lang, out); }
  paintList();
}

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
$('pick-form').addEventListener('submit', (e) => { e.preventDefault(); void load(); });
$('raise-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('raise-status').textContent = t('reading');
  const out = await session.raise({ branchId: $('s-store').value, kind: $('r-kind').value, severity: $('r-severity').value, occurredAt: $('r-when').value, reportedBy: $('r-who').value, description: $('r-what').value, evidence: $('r-evidence').value, assetId: $('r-asset').value });
  $('raise-status').textContent = out.result === 'ok' ? t('raised') : api.outcomeWords(lang, out);
  if (out.result === 'ok') void load();
});
paint();
if (api?.storeId) $('s-store').value = api.storeId;
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else {
  $('pick').hidden = false; $('list').hidden = false;
  if (may.record) $('raise').hidden = false; else $('page-status').textContent = t('cannotRecord');
  if ($('s-store').value.trim() !== '') void load();
}
