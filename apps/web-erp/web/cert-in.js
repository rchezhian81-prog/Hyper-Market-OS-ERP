// CERT-In reports and capacity (Round 4c · M35-FR-04) — the page over head office's CERT-In clock and capacity report. The
// session (apps/web-erp/src/cert-in-capacity-session.ts, in the bundle as window.certIn) does every call and every rule;
// this page lays out what it is told. It reads as it opens; every record is an explicit press. Every word this page adds has
// a Tamil twin; head office's own sentences stay in English (OB-553).

const $ = (id) => document.getElementById(id);
const api = window.certIn ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, classify: false, plan: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
const nk = (v) => (v === null ? t('notKnown') : String(v));

let clocks = null; let open = []; let capacity = null;

function paintClocks() {
  const ul = $('clocks'); ul.replaceChildren();
  if (clocks === null) return;
  if (clocks.length === 0) { ul.append(text('li', t('noClocks'), 'meta')); return; }
  for (const c of clocks) {
    const li = document.createElement('li'); li.dataset.incident = c.incidentId; li.dataset.state = c.state; li.className = c.state;
    const head = document.createElement('div'); head.className = 'head';
    head.append(text('h4', `${c.incidentId} — ${c.category}`), text('span', t(`state_${c.state}`), 'meta'));
    li.append(head);
    if (c.reportBy !== null) li.append(text('p', `${t('reportBy')} ${api.moment(c.reportBy)}${c.minutesLeft === null ? '' : ` · ${Math.abs(c.minutesLeft)} ${c.minutesLeft >= 0 ? t('minutesLeft') : t('minutesOver')}`}`, 'meta'));
    li.append(text('p', `${t('decidedBy')} ${c.classifiedBy} · ${t('why')}: ${c.reason}`, 'meta'));
    if (c.report !== null) li.append(text('p', `${t('reportedAt')} ${api.moment(c.report.reportedAt)} · ${t('reference')} ${c.report.reference} · ${t('channel')} ${c.report.channel}`, 'meta'));
    ul.append(li);
  }
}

function paintIncidents() {
  const sel = $('c-incident'); const was = sel.value;
  sel.replaceChildren(...open.map((i) => { const o = document.createElement('option'); o.value = i.incidentId; o.textContent = `${i.incidentId} — ${i.title} (${i.severity})`; return o; }));
  if (open.length === 0) { const o = document.createElement('option'); o.value = ''; o.textContent = t('noOpen'); sel.append(o); }
  if (was !== '') sel.value = was;
}

function paintCapacity() {
  const ul = $('cap-rows'); ul.replaceChildren();
  if (capacity === null) return;
  for (const r of capacity.rows) {
    const li = document.createElement('li'); li.dataset.measure = r.measure; li.dataset.verdict = r.verdict; li.className = r.verdict;
    const head = document.createElement('div'); head.className = 'head';
    head.append(text('h4', t(`m_${r.measure}`)), text('span', t(r.verdict), 'meta'));
    li.append(head, text('p', `${t('peak')}: ${nk(r.measuredPeak)} · ${t('twice')}: ${nk(r.twicePeak)} · ${t('target')}: ${nk(r.target12Months)} · ${t('provisioned')}: ${r.provisioned === null ? t('notSet') : r.provisioned}`, 'meta'), text('p', r.why, 'meta'));
    ul.append(li);
  }
  const box = $('p-measures');
  if (box.childElementCount === 0) {
    for (const m of api.measures) {
      const l = document.createElement('label'); l.htmlFor = `p-${m}`; const s = text('span', ''); s.dataset.measure = m; l.append(s);
      const i = document.createElement('input'); i.id = `p-${m}`; i.inputMode = 'numeric'; i.autocomplete = 'off'; l.append(i); box.append(l);
    }
  }
  for (const s of box.querySelectorAll('span[data-measure]')) s.textContent = `${t('provisioned')}: ${t(`m_${s.dataset.measure}`)}`;
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  document.title = `SRE ${t('title')}`;
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['cert-h', 'certH'], ['cert-lead', 'certLead'], ['classify-h', 'classifyH'], ['c-incident-l', 'incident'], ['c-reportable-l', 'reportable'], ['c-yes', 'yes'], ['c-no', 'no'],
    ['c-category-l', 'category'], ['c-noticed-l', 'noticedAt'], ['c-reason-l', 'reason'], ['c-save-text', 'classify'], ['report-h', 'reportH'], ['r-incident-l', 'incident'], ['r-at-l', 'reportedAt'],
    ['r-reference-l', 'reference'], ['r-channel-l', 'channel'], ['r-save-text', 'report'], ['cap-h', 'capH'], ['cap-lead', 'capLead'], ['plan-h', 'planH'], ['p-growth-l', 'growth'], ['p-save-text', 'savePlan']]) $(id).textContent = t(key);
  paintClocks(); paintIncidents(); paintCapacity();
}

async function loadCert() {
  $('cert-status').textContent = t('reading');
  const [c, i] = await Promise.all([session.clocks(), session.openIncidents()]);
  if (c.result === 'ok') { clocks = c.value; $('cert-status').textContent = ''; } else { clocks = null; $('cert-status').textContent = api.outcomeWords(lang, c); }
  open = i.result === 'ok' ? i.value : [];
  paintClocks(); paintIncidents();
}
async function loadCapacity() {
  $('cap-status').textContent = t('reading');
  const out = await session.capacity();
  if (out.result === 'ok') { capacity = out.value; $('cap-status').textContent = ''; } else { capacity = null; $('cap-status').textContent = api.outcomeWords(lang, out); }
  paintCapacity();
}

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
$('classify-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('classify-status').textContent = t('reading');
  const out = await session.classify({ incidentId: $('c-incident').value, reportable: $('c-reportable').value === 'yes', category: $('c-category').value, reason: $('c-reason').value, noticedAt: $('c-noticed').value });
  $('classify-status').textContent = out.result === 'ok' ? t('classified') : api.outcomeWords(lang, out);
  if (out.result === 'ok') { $('r-incident').value = $('c-incident').value; void loadCert(); }
});
$('report-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('report-status').textContent = t('reading');
  const out = await session.report({ incidentId: $('r-incident').value, reportedAt: $('r-at').value, reference: $('r-reference').value, channel: $('r-channel').value });
  $('report-status').textContent = out.result === 'ok' ? t('reported') : api.outcomeWords(lang, out);
  if (out.result === 'ok') void loadCert();
});
$('plan-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('plan-status').textContent = t('reading');
  const prov = Object.fromEntries(api.measures.map((m) => [m, $(`p-${m}`).value]));
  const out = await session.savePlan($('p-growth').value, prov);
  $('plan-status').textContent = out.result === 'ok' ? t('planSaved').replace('{v}', String(out.value.version)) : api.outcomeWords(lang, out);
  if (out.result === 'ok') void loadCapacity();
});
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else {
  $('cert').hidden = false; $('capacity').hidden = false;
  if (may.classify) $('classify').hidden = false;
  if (may.plan) $('plan').hidden = false;
  void loadCert(); void loadCapacity();
}
