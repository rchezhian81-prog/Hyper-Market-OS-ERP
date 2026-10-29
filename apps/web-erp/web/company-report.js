// Company-wide report drill-down — the THIN CLIENT (M01 / M29 / D13, owner decision).
//
// It holds no consolidation engine and no money maths. It asks the backend for a roll-up, then shows it
// honestly: the total, a freshness badge (fresh / stale / missing — never stale shown as fresh), the branches
// that are missing or withheld by the viewer's scope, whether the node reconciles to its children, and the
// per-branch drill-down. Export asks head office for an open CSV through the one authorised export path. Both go to
// the PRODUCTION routes (audit EA-04) — `GET /v1/consolidation` and `POST /v1/consolidation/export` on the same origin,
// under the signed-in person's own session — where the server decides their branch scope and logs every export.
// OB-391 (owner, 26 Oct 2026): the company and its branches — their ids AND their names — are head office's own
// (`GET /v1/org/nodes`), never written into this page: no practice branch, no fixed company node. The company is the
// one head office holds (or the one the page address names, ?node=…); the month comes from ?period=YYYY-MM and
// defaults to this one. When head office cannot tell the page its company, the page says so and shows no figure.
//
// Every word on this page has a Tamil twin and follows the one language toggle (Stage G slice 5c · NFR-08); the
// data the backend answers with (branch ids, numbers, the CSV) is shown as it is.

const $ = (id) => document.getElementById(id);

const WORDS = {
  en: {
    title: 'Company report', lede: 'One number for the whole company, and the honest truth about how current it is.',
    report: 'Report', sales: 'Sales', returns: 'Returns', viewAs: 'View as', wholeCompany: 'Whole company',
    branchOnly: 'branch only', total: 'Company total', byBranch: 'By branch',
    drillLede: 'Drill from the total to the branches that make it up — worst first.',
    branch: 'Branch', gross: 'Gross', net: 'Net', margin: 'Margin', refunds: 'Refunds', commission: 'Commission', count: 'Count',
    lastRefreshed: 'Last refreshed', neverSynced: 'never synced', export: 'Export',
    exportLede: 'Take the numbers out as an open spreadsheet file (CSV). Only what your view allows.',
    exportCsv: 'Export CSV', download: 'Download the file', csvPreview: 'CSV preview',
    foot: 'Every export is authorised and logged; a branch view never carries another branch\'s rows.',
    servedHere: 'Opened on the store computer: every figure here is head office\'s live answer — the store computer keeps no copy of it.',
    fresh: 'Up to date', stale: 'Some data is stale', missing: 'Some data is missing',
    noBranch: 'No branch has reported for this view.',
    unreachable: 'Head office cannot be reached from here — nothing on this page is current.',
    company: 'Company', noCompany: 'Head office has no company set up yet, so there is nothing to add up.',
    orgRefused: 'Head office would not tell this page the company\'s branches for your sign-in, so it shows no figure.',
    missingBranches: 'Missing — not reported yet:', incomplete: 'The total is incomplete.',
    allReported: 'Every expected branch has reported.',
    withheld: 'Withheld from your view:', yourBranchOnly: 'The total above is your branch only.',
    reconciles: 'Reconciles: the total equals the sum of the branches shown.',
    notReconciles: 'Does NOT reconcile — a branch is missing, so the total is not the whole company.',
    notAllowed: 'You are not allowed to export this report.', exported: 'Exported', branchRows: 'branch row(s).',
  },
  ta: {
    title: 'நிறுவன அறிக்கை', lede: 'முழு நிறுவனத்திற்கும் ஒரே எண் — அது எவ்வளவு புதியது என்ற உண்மையுடன்.',
    report: 'அறிக்கை', sales: 'விற்பனை', returns: 'திரும்பியவை', viewAs: 'பார்வை', wholeCompany: 'முழு நிறுவனம்',
    branchOnly: 'கிளை மட்டும்', total: 'நிறுவன மொத்தம்', byBranch: 'கிளை வாரியாக',
    drillLede: 'மொத்தத்திலிருந்து அதை உருவாக்கும் கிளைகளுக்குச் செல்லுங்கள் — மோசமானது முதலில்.',
    branch: 'கிளை', gross: 'மொத்தம்', net: 'நிகரம்', margin: 'லாப விகிதம்', refunds: 'திருப்பங்கள்', commission: 'கமிஷன்', count: 'எண்ணிக்கை',
    lastRefreshed: 'கடைசியாகப் புதுப்பித்தது', neverSynced: 'ஒருபோதும் ஒத்திசைக்கப்படவில்லை', export: 'ஏற்றுமதி',
    exportLede: 'எண்களை திறந்த விரிதாள் கோப்பாக (CSV) எடுங்கள். உங்கள் பார்வை அனுமதிப்பதை மட்டும்.',
    exportCsv: 'CSV ஏற்றுமதி', download: 'கோப்பைப் பதிவிறக்கு', csvPreview: 'CSV முன்னோட்டம்',
    foot: 'ஒவ்வொரு ஏற்றுமதியும் அங்கீகரிக்கப்பட்டு பதிவு செய்யப்படுகிறது; ஒரு கிளைப் பார்வை மற்றொரு கிளையின் வரிசைகளை ஒருபோதும் கொண்டிருக்காது.',
    servedHere: 'கடை கணினியில் திறக்கப்பட்டது: இங்குள்ள ஒவ்வொரு எண்ணும் தலைமை அலுவலகத்தின் நேரடிப் பதில் — கடை கணினி அதன் நகலை வைத்திருப்பதில்லை.',
    fresh: 'புதியது', stale: 'சில தரவு பழையது', missing: 'சில தரவு விடுபட்டுள்ளது',
    noBranch: 'இந்தப் பார்வைக்கு எந்தக் கிளையும் அறிக்கை அளிக்கவில்லை.',
    unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — இந்தப் பக்கத்தில் எதுவும் தற்போதையது அல்ல.',
    company: 'நிறுவனம்', noCompany: 'தலைமை அலுவலகத்தில் இன்னும் எந்த நிறுவனமும் அமைக்கப்படவில்லை; கூட்ட எதுவும் இல்லை.',
    orgRefused: 'உங்கள் உள்நுழைவுக்கு நிறுவனத்தின் கிளைகளைத் தலைமை அலுவலகம் இந்தப் பக்கத்துக்குச் சொல்லவில்லை; அதனால் எந்த எண்ணும் காட்டப்படவில்லை.',
    missingBranches: 'விடுபட்டவை — இன்னும் அறிக்கை அளிக்கவில்லை:', incomplete: 'மொத்தம் முழுமையற்றது.',
    allReported: 'எதிர்பார்த்த ஒவ்வொரு கிளையும் அறிக்கை அளித்துள்ளது.',
    withheld: 'உங்கள் பார்வையிலிருந்து மறைக்கப்பட்டவை:', yourBranchOnly: 'மேலே உள்ள மொத்தம் உங்கள் கிளை மட்டும்.',
    reconciles: 'சரிக்கட்டுகிறது: மொத்தம் காட்டப்பட்ட கிளைகளின் கூட்டுத்தொகைக்குச் சமம்.',
    notReconciles: 'சரிக்கட்டவில்லை — ஒரு கிளை விடுபட்டுள்ளது, எனவே மொத்தம் முழு நிறுவனமல்ல.',
    notAllowed: 'இந்த அறிக்கையை ஏற்றுமதி செய்ய உங்களுக்கு அனுமதி இல்லை.', exported: 'ஏற்றப்பட்டது', branchRows: 'கிளை வரிசை(கள்).',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

const familyEl = $('family');
const scopeEl = $('scope');
const companyEl = $('company');

const MONEY_KEYS = new Set(['grossMinor', 'netMinor', 'marginMinor', 'refundMinor', 'commissionMinor']);
const LABEL_KEYS = { grossMinor: 'gross', netMinor: 'net', marginMinor: 'margin', refundMinor: 'refunds', commissionMinor: 'commission', count: 'count' };

// Paise (minor units) → a readable ₹ figure, without any rounding of the stored integer.
const rupees = (minor) => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// OB-391: every name is head office's (GET /v1/org/nodes); an id head office did not name is shown as the id itself.
let org = { companies: [], branches: [], names: new Map() };
const branchName = (id) => org.names.get(id) ?? id;
const named = (ids) => ids.map((id) => (org.names.has(id) ? `${branchName(id)} (${id})` : id)).join(', ');

class Refused extends Error { constructor(status) { super(`head office answered ${status}`); this.status = status; } }
async function getJson(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
  if (!res.ok) throw new Refused(res.status);
  return res.json();
}

// The month, from the page address; it defaults to the current one. The company comes from head office (below).
const PAGE = new URLSearchParams(window.location.search);
const ASKED_NODE = PAGE.get('node');
// OB-606: the SHOP's month (its zone, as the store computer told the page) — never this device's own month.
const PERIOD = /^\d{4}-\d{2}$/.test(PAGE.get('period') || '') ? PAGE.get('period') : (window.sreShopDay === undefined ? '' : window.sreShopDay.thisMonth());
let NODE = null;

/** Head office's company structure: the companies, the branches of each, and every node's name. */
async function loadOrg() {
  const body = await getJson('/v1/org/nodes');
  const nodes = (Array.isArray(body && body.nodes) ? body.nodes : []).filter((n) => n && typeof n.nodeId === 'string');
  const live = (n) => n.status !== 'closed';
  const byName = (a, b) => String(a.name ?? a.nodeId).localeCompare(String(b.name ?? b.nodeId));
  org = {
    companies: nodes.filter((n) => n.kind === 'company' && live(n)).sort(byName),
    branches: nodes.filter((n) => n.kind === 'branch' && live(n)).sort(byName),
    names: new Map(nodes.filter((n) => typeof n.name === 'string' && n.name.trim() !== '').map((n) => [n.nodeId, n.name])),
  };
}
const branchesOf = (companyId) => org.branches.filter((b) => (b.companyId ?? b.parentId) === companyId);

/** The scope list: the whole company, then each of ITS branches by head office's name. */
function paintScopes() {
  const keep = scopeEl.value;
  const all = document.createElement('option');
  all.value = 'all'; all.id = 'opt-all'; all.textContent = t('wholeCompany');
  const options = [all, ...(NODE === null ? [] : branchesOf(NODE)).map((b) => {
    const o = document.createElement('option');
    o.value = b.nodeId; o.textContent = `${branchName(b.nodeId)} — ${t('branchOnly')}`;
    return o;
  })];
  scopeEl.replaceChildren(...options);
  scopeEl.value = options.some((o) => o.value === keep) ? keep : 'all';
}
function paintCompanies() {
  $('company-wrap').hidden = org.companies.length < 2;
  companyEl.replaceChildren(...org.companies.map((c) => {
    const o = document.createElement('option');
    o.value = c.nodeId; o.textContent = branchName(c.nodeId);
    return o;
  }));
  if (NODE !== null) companyEl.value = NODE;
}

// ── The page's own words, repainted on every language change ────────────────────────────────────
function paintWords() {
  const set = (id, key) => { $(id).textContent = t(key); };
  set('title', 'title'); set('lede', 'lede'); set('report-label', 'report'); set('opt-sales', 'sales'); set('opt-returns', 'returns');
  set('scope-label', 'viewAs'); set('company-label', 'company');
  paintScopes();
  set('tot-h', 'total'); set('drill-h', 'byBranch'); set('drill-lede', 'drillLede');
  set('th-branch', 'branch'); set('th-gross', 'gross'); set('th-net', 'net'); set('th-refreshed', 'lastRefreshed');
  set('exp-h', 'export'); set('exp-lede', 'exportLede'); set('export', 'exportCsv'); set('download', 'download'); set('foot', 'foot');
  $('preview').setAttribute('aria-label', t('csvPreview'));
  // OB-391: on the store computer the page is told only who is looking (window.companyReportData); it says so.
  const served = window.companyReportData && window.companyReportData.servedBy === 'store_computer';
  $('served').hidden = !served;
  $('served').textContent = served ? t('servedHere') : '';
}

// ── What head office answered, painted in the reader's language ─────────────────────────────────
let last = null; // the last report, so a language change repaints without asking head office again
let exportOutcome = null;

function renderKpis(measures) {
  const box = $('kpis');
  box.textContent = '';
  const keys = Object.keys(measures);
  if (keys.length === 0) {
    const p = document.createElement('p');
    p.className = 'lede';
    p.textContent = t('noBranch');
    box.appendChild(p);
    return;
  }
  for (const key of keys) {
    const card = document.createElement('div');
    card.className = 'kpi';
    const k = document.createElement('div');
    k.className = 'k';
    k.textContent = LABEL_KEYS[key] ? t(LABEL_KEYS[key]) : key;
    const v = document.createElement('div');
    v.className = 'v';
    v.dataset['measure'] = key;
    v.textContent = MONEY_KEYS.has(key) ? rupees(measures[key]) : String(measures[key]);
    card.append(k, v);
    box.appendChild(card);
  }
}

function renderFreshness(freshness) {
  const el = $('freshness');
  const state = (freshness && freshness.state) || 'missing';
  el.className = `badge ${state}`;
  el.textContent = t(state === 'fresh' ? 'fresh' : state === 'stale' ? 'stale' : 'missing');
}

function renderContributors(contributors) {
  const rows = $('rows');
  rows.textContent = '';
  for (const c of contributors) {
    const tr = document.createElement('tr');
    tr.dataset['branch'] = c.branchId;
    const cell = (text) => {
      const td = document.createElement('td');
      td.textContent = text;
      return td;
    };
    tr.appendChild(cell(`${branchName(c.branchId)} (${c.branchId})`));
    tr.appendChild(cell(rupees(c.measures.grossMinor ?? 0)));
    tr.appendChild(cell(rupees(c.measures.netMinor ?? 0)));
    // OB-607: when it last synced, at the shop's clock — never the UTC clock of the moment.
    tr.appendChild(cell(c.lastRefreshAt ? window.sreShopDay?.dateTimeOf(c.lastRefreshAt) ?? '' : t('neverSynced')));
    rows.appendChild(tr);
  }
}

function renderReport() {
  if (last === null) return;
  if (last === 'unreachable' || last === 'no_company' || last === 'org_refused') {
    // Head office could not be reached, has no company, or would not name its branches for this sign-in. Said, rather
    // than a blank page that reads as "nothing to report" or a thrown error nobody sees (P-08).
    const missing = $('missing');
    missing.className = 'flag err';
    missing.textContent = t(last === 'unreachable' ? 'unreachable' : last === 'no_company' ? 'noCompany' : 'orgRefused');
    renderKpis({});
    $('rows').textContent = '';
    return;
  }
  const report = last;
  renderFreshness(report.freshness);
  renderKpis(report.measures || {});
  renderContributors(report.contributors || []);

  const missing = $('missing');
  if ((report.missingBranches || []).length > 0) {
    missing.className = 'flag err';
    missing.textContent = `${t('missingBranches')} ${named(report.missingBranches)}. ${t('incomplete')}`;
  } else {
    missing.className = 'flag ok';
    missing.textContent = t('allReported');
  }

  const withheld = $('withheld');
  if ((report.withheldByScope || []).length > 0) {
    withheld.className = 'flag warn';
    withheld.textContent = `${t('withheld')} ${named(report.withheldByScope)}. ${t('yourBranchOnly')}`;
  } else {
    withheld.className = 'flag';
    withheld.textContent = '';
  }

  const reconcile = $('reconcile');
  reconcile.className = report.reconciles ? 'flag ok' : 'flag err';
  reconcile.textContent = report.reconciles ? t('reconciles') : t('notReconciles');
}

function renderExport() {
  const status = $('export-status');
  if (exportOutcome === null) { status.textContent = ''; status.className = 'status'; return; }
  if (exportOutcome.ok) {
    status.className = 'status good';
    status.textContent = `${t('exported')} ${exportOutcome.rows} ${t('branchRows')}`;
  } else {
    status.className = 'status err';
    status.textContent = t('notAllowed');
  }
}

function query() {
  const scope = scopeEl.value;
  const params = new URLSearchParams({ node: NODE ?? '', family: familyEl.value, period: PERIOD });
  if (scope !== 'all') params.set('scope', scope);
  return params;
}

async function load() {
  if (NODE === null) { renderReport(); return; }
  try {
    last = await getJson(`/v1/consolidation?${query().toString()}`);
  } catch {
    last = 'unreachable';
  }
  renderReport();
  // Reset any prior export preview when the view changes.
  exportOutcome = null;
  renderExport();
  $('download').hidden = true;
  $('preview').hidden = true;
}

$('export').addEventListener('click', async () => {
  if (NODE === null) return;
  // One authorised, logged export at head office (EA-04): the server re-runs the roll-up in the reader's own scope.
  const q = query();
  const body = { node: q.get('node'), family: q.get('family'), period: q.get('period'), ...(q.has('scope') ? { scope: q.get('scope') } : {}) };
  let res;
  try {
    res = await fetch('/v1/consolidation/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': (crypto.randomUUID && crypto.randomUUID()) || `export-${Date.now()}` },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
  } catch {
    res = null;
  }
  if (res === null || !res.ok) {
    exportOutcome = { ok: false };
    renderExport();
    return;
  }
  const out = await res.json();
  const csv = String(out.csv ?? '');
  const dataRows = typeof out.rows === 'number' ? out.rows : csv.trim().split('\n').length - 1; // minus the header
  exportOutcome = { ok: true, rows: dataRows };
  renderExport();
  const preview = $('preview');
  preview.hidden = false;
  preview.textContent = csv;
  const link = $('download');
  link.href = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
  link.hidden = false;
});

familyEl.addEventListener('change', () => { void load(); });
scopeEl.addEventListener('change', () => { void load(); });
companyEl.addEventListener('change', () => { NODE = companyEl.value; scopeEl.value = 'all'; paintScopes(); void load(); });

// The one language toggle (the chrome paints its label): every word on the page follows, the data does not change.
$('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintWords();
  renderReport();
  renderExport();
});

// Boot: head office's company structure first — the company, its branches and their names — then the roll-up.
async function boot() {
  paintWords();
  try {
    await loadOrg();
  } catch (e) {
    last = e instanceof Refused && (e.status === 401 || e.status === 403) ? 'org_refused' : 'unreachable';
    renderReport();
    return;
  }
  const asked = ASKED_NODE === null ? null : org.companies.find((c) => c.nodeId === ASKED_NODE) ?? null;
  NODE = (asked ?? org.companies[0] ?? null)?.nodeId ?? null;
  if (NODE === null) { last = 'no_company'; renderReport(); return; }
  paintCompanies();
  paintScopes();
  await load();
}

if ('serviceWorker' in navigator) {
  // OB-391: served by the store computer like every office page; the worker keeps the page's shell (never a figure).
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
void boot();
