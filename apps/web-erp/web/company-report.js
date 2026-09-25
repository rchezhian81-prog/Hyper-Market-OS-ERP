// Company-wide report drill-down — the THIN CLIENT (M01 / M29 / D13, owner decision).
//
// It holds no consolidation engine and no money maths. It asks the backend for a roll-up, then shows it
// honestly: the total, a freshness badge (fresh / stale / missing — never stale shown as fresh), the branches
// that are missing or withheld by the viewer's scope, whether the node reconciles to its children, and the
// per-branch drill-down. Export fetches an open CSV from the one authorised export path. In production the
// backend is the cloud reporting API running the production `consolidate`; in the browser E2E it is a local
// Node server running the same engine.

const $ = (id) => document.getElementById(id);

const familyEl = $('family');
const scopeEl = $('scope');

const MONEY_KEYS = new Set(['grossMinor', 'netMinor', 'marginMinor', 'refundMinor', 'commissionMinor']);

// Paise (minor units) → a readable ₹ figure, without any rounding of the stored integer.
const rupees = (minor) => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const LABELS = {
  grossMinor: 'Gross', netMinor: 'Net', marginMinor: 'Margin',
  refundMinor: 'Refunds', commissionMinor: 'Commission', count: 'Count',
};

const BRANCH_NAMES = { 'br-1': 'Anna Nagar', 'br-2': 'T. Nagar', 'br-3': 'Velachery' };
const branchName = (id) => BRANCH_NAMES[id] ?? id;
const named = (ids) => ids.map((id) => `${branchName(id)} (${id})`).join(', ');

async function getJson(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  return res.json();
}

function renderKpis(measures) {
  const box = $('kpis');
  box.textContent = '';
  const keys = Object.keys(measures);
  if (keys.length === 0) {
    const p = document.createElement('p');
    p.className = 'lede';
    p.textContent = 'No branch has reported for this view.';
    box.appendChild(p);
    return;
  }
  for (const key of keys) {
    const card = document.createElement('div');
    card.className = 'kpi';
    const k = document.createElement('div');
    k.className = 'k';
    k.textContent = LABELS[key] ?? key;
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
  const word = state === 'fresh' ? 'Up to date' : state === 'stale' ? 'Some data is stale' : 'Some data is missing';
  const ta = state === 'fresh' ? 'புதியது' : state === 'stale' ? 'பழையது' : 'விடுபட்டது';
  el.textContent = `${word} / ${ta}`;
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
    tr.appendChild(cell(c.lastRefreshAt ? new Date(c.lastRefreshAt).toISOString().slice(0, 16).replace('T', ' ') : 'never synced'));
    rows.appendChild(tr);
  }
}

function query() {
  const scope = scopeEl.value;
  const params = new URLSearchParams({ node: 'co-1', family: familyEl.value, period: '2026-09' });
  if (scope !== 'all') params.set('scope', scope);
  return params;
}

async function load() {
  const report = await getJson(`/consolidation?${query().toString()}`);
  renderFreshness(report.freshness);
  renderKpis(report.measures || {});
  renderContributors(report.contributors || []);

  const missing = $('missing');
  if ((report.missingBranches || []).length > 0) {
    missing.className = 'flag err';
    missing.textContent = `Missing — not reported yet: ${named(report.missingBranches)}. The total is incomplete.`;
  } else {
    missing.className = 'flag ok';
    missing.textContent = 'Every expected branch has reported.';
  }

  const withheld = $('withheld');
  if ((report.withheldByScope || []).length > 0) {
    withheld.className = 'flag warn';
    withheld.textContent = `Withheld from your view: ${named(report.withheldByScope)}. The total above is your branch only.`;
  } else {
    withheld.className = 'flag';
    withheld.textContent = '';
  }

  const reconcile = $('reconcile');
  reconcile.className = report.reconciles ? 'flag ok' : 'flag err';
  reconcile.textContent = report.reconciles
    ? 'Reconciles: the total equals the sum of the branches shown.'
    : 'Does NOT reconcile — a branch is missing, so the total is not the whole company.';

  // Reset any prior export preview when the view changes.
  $('export-status').textContent = '';
  $('export-status').className = 'status';
  $('download').hidden = true;
  $('preview').hidden = true;
}

$('export').addEventListener('click', async () => {
  const scope = scopeEl.value;
  const params = new URLSearchParams({ node: 'co-1', family: familyEl.value, period: '2026-09' });
  if (scope !== 'all') params.set('scope', scope);
  const res = await fetch(`/consolidation/export?${params.toString()}`, { headers: { accept: 'text/csv' } });
  const status = $('export-status');
  if (!res.ok) {
    status.className = 'status err';
    status.textContent = 'You are not allowed to export this report.';
    return;
  }
  const csv = await res.text();
  const dataRows = csv.trim().split('\n').length - 1; // minus the header
  status.className = 'status good';
  status.textContent = `Exported ${dataRows} branch row(s). / ${dataRows} கிளை வரிசைகள் ஏற்றப்பட்டன.`;
  const preview = $('preview');
  preview.hidden = false;
  preview.textContent = csv;
  const link = $('download');
  link.href = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
  link.hidden = false;
});

familyEl.addEventListener('change', () => { void load(); });
scopeEl.addEventListener('change', () => { void load(); });

void load();
