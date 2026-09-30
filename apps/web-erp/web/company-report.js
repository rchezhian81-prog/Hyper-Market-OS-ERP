// Company-wide report drill-down — the THIN CLIENT (M01 / M29 / D13, owner decision).
//
// It holds no consolidation engine and no money maths. It asks the backend for a roll-up, then shows it
// honestly: the total, a freshness badge (fresh / stale / missing — never stale shown as fresh), the branches
// that are missing or withheld by the viewer's scope, whether the node reconciles to its children, and the
// per-branch drill-down. Export fetches an open CSV from the one authorised export path. In production the
// backend is the cloud reporting API running the production `consolidate`; in the browser E2E it is a local
// Node server running the same engine.
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
    fresh: 'Up to date', stale: 'Some data is stale', missing: 'Some data is missing',
    noBranch: 'No branch has reported for this view.',
    unreachable: 'Head office cannot be reached from here — nothing on this page is current.',
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
    fresh: 'புதியது', stale: 'சில தரவு பழையது', missing: 'சில தரவு விடுபட்டுள்ளது',
    noBranch: 'இந்தப் பார்வைக்கு எந்தக் கிளையும் அறிக்கை அளிக்கவில்லை.',
    unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — இந்தப் பக்கத்தில் எதுவும் தற்போதையது அல்ல.',
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

const MONEY_KEYS = new Set(['grossMinor', 'netMinor', 'marginMinor', 'refundMinor', 'commissionMinor']);
const LABEL_KEYS = { grossMinor: 'gross', netMinor: 'net', marginMinor: 'margin', refundMinor: 'refunds', commissionMinor: 'commission', count: 'count' };

// Paise (minor units) → a readable ₹ figure, without any rounding of the stored integer.
const rupees = (minor) => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const BRANCH_NAMES = { 'br-1': 'Anna Nagar', 'br-2': 'T. Nagar', 'br-3': 'Velachery' };
const branchName = (id) => BRANCH_NAMES[id] ?? id;
const named = (ids) => ids.map((id) => `${branchName(id)} (${id})`).join(', ');

async function getJson(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`head office answered ${res.status}`);
  return res.json();
}

// ── The page's own words, repainted on every language change ────────────────────────────────────
function paintWords() {
  const set = (id, key) => { $(id).textContent = t(key); };
  set('title', 'title'); set('lede', 'lede'); set('report-label', 'report'); set('opt-sales', 'sales'); set('opt-returns', 'returns');
  set('scope-label', 'viewAs'); set('opt-all', 'wholeCompany');
  $('opt-br-1').textContent = `${branchName('br-1')} — ${t('branchOnly')}`;
  $('opt-br-2').textContent = `${branchName('br-2')} — ${t('branchOnly')}`;
  set('tot-h', 'total'); set('drill-h', 'byBranch'); set('drill-lede', 'drillLede');
  set('th-branch', 'branch'); set('th-gross', 'gross'); set('th-net', 'net'); set('th-refreshed', 'lastRefreshed');
  set('exp-h', 'export'); set('exp-lede', 'exportLede'); set('export', 'exportCsv'); set('download', 'download'); set('foot', 'foot');
  $('preview').setAttribute('aria-label', t('csvPreview'));
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
    tr.appendChild(cell(c.lastRefreshAt ? new Date(c.lastRefreshAt).toISOString().slice(0, 16).replace('T', ' ') : t('neverSynced')));
    rows.appendChild(tr);
  }
}

function renderReport() {
  if (last === null) return;
  if (last === 'unreachable') {
    // Head office could not be reached, or did not answer with a report. Said, rather than a blank page
    // that reads as "nothing to report" or a thrown error nobody sees (P-08).
    const missing = $('missing');
    missing.className = 'flag err';
    missing.textContent = t('unreachable');
    renderKpis({});
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
  const params = new URLSearchParams({ node: 'co-1', family: familyEl.value, period: '2026-09' });
  if (scope !== 'all') params.set('scope', scope);
  return params;
}

async function load() {
  try {
    last = await getJson(`/consolidation?${query().toString()}`);
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
  const res = await fetch(`/consolidation/export?${query().toString()}`, { headers: { accept: 'text/csv' } });
  if (!res.ok) {
    exportOutcome = { ok: false };
    renderExport();
    return;
  }
  const csv = await res.text();
  const dataRows = csv.trim().split('\n').length - 1; // minus the header
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

// The one language toggle (the chrome paints its label): every word on the page follows, the data does not change.
$('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintWords();
  renderReport();
  renderExport();
});

paintWords();
void load();
