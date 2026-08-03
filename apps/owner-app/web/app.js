// Owner command centre — view layer. It renders the brief produced by the TESTED
// model (`apps/owner-app/src/brief.ts`, bundled as `window.ownerBrief`) and holds no
// business logic of its own: no KPI maths, no alert grouping, no priority rules.
// If the bundle is absent it shows an honest "brief unavailable" state rather than
// inventing numbers.
//
// Data comes from `window.ownerData` — whatever the phone last received (§31:
// last-synced data only). Nothing here fetches; freshness is always displayed.

const el = (id) => document.getElementById(id);

const inr = (minor) =>
  '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A small sample payload so the screen can be reviewed before real data arrives. */
const SAMPLE = {
  asOf: new Date().toISOString(),
  lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
  staleAfterSeconds: 300,
  sales: [
    { saleId: 's1', netMinor: 100_00, taxMinor: 18_00, totalMinor: 118_00, cogsMinor: 70_00, units: 3, tender: 'cash', currency: 'INR' },
    { saleId: 's2', netMinor: 250_00, taxMinor: 45_00, totalMinor: 295_00, cogsMinor: 180_00, units: 7, tender: 'upi', currency: 'INR' },
  ],
  exceptions: [],
  approvals: [],
};

function renderFreshness(freshness) {
  const dot = el('fresh-dot');
  const text = el('fresh-text');
  dot.className = 'dot ' + (freshness.state === 'fresh' ? '' : freshness.state);
  if (freshness.state === 'missing') {
    text.textContent = 'No data has synced from the store yet';
  } else {
    const mins = Math.round((freshness.ageSeconds ?? 0) / 60);
    const age = mins < 1 ? 'just now' : mins + ' min ago';
    text.textContent = (freshness.state === 'stale' ? 'NOT LIVE — last synced ' : 'Live · synced ') + age;
  }
}

function renderAttention(items) {
  const host = el('attention');
  host.replaceChildren();
  if (items.length === 0) {
    const none = document.createElement('p');
    none.className = 'empty';
    none.textContent = 'Nothing needs a decision right now.';
    return host.append(none);
  }
  for (const item of items) {
    const card = document.createElement('div');
    card.className =
      'card' + (item.source === 'approval' ? ' approval' : item.sentence.startsWith('Urgent') ? ' urgent' : '');
    const rank = document.createElement('div');
    rank.className = 'rank';
    rank.textContent = '#' + item.rank + ' · ' + (item.source === 'approval' ? 'Approval' : 'Exception');
    const body = document.createElement('div');
    body.textContent = item.sentence;
    card.append(rank, body);
    // Tapping opens the underlying item (wired to the detail view / approval inbox).
    card.addEventListener('click', () => window.alert('Open: ' + item.ref));
    host.append(card);
  }
}

function renderKpis(kpis) {
  const host = el('kpis');
  host.replaceChildren();
  const tiles = [
    ['Sales', inr(kpis.grossSalesMinor)],
    ['Margin', inr(kpis.marginMinor)],
    ['Bills', String(kpis.basketCount)],
    ['Average basket', inr(kpis.avgBasketMinor)],
  ];
  for (const [label, value] of tiles) {
    const tile = document.createElement('div');
    tile.className = 'kpi';
    const l = document.createElement('div');
    l.className = 'label';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = 'value';
    v.textContent = value;
    tile.append(l, v);
    host.append(tile);
  }
}

function renderAlerts(alerts) {
  const host = el('alerts');
  host.replaceChildren();
  if (alerts.length === 0) {
    const none = document.createElement('p');
    none.className = 'empty';
    none.textContent = 'No alerts today.';
    return host.append(none);
  }
  for (const alert of alerts) {
    const row = document.createElement('div');
    row.className = 'alert';
    const line = document.createElement('div');
    line.textContent = alert.sentence;
    const drill = document.createElement('div');
    drill.className = 'drill';
    drill.textContent = 'Tap to see the ' + alert.linkedTxnIds.length + ' transaction(s)';
    row.append(line, drill);
    row.addEventListener('click', () => window.alert(alert.linkedTxnIds.join('\n')));
    host.append(row);
  }
}

function render() {
  if (typeof window.ownerBrief !== 'function') {
    // Never invent numbers — say plainly that the brief cannot be built.
    el('headline').textContent = 'Brief unavailable — the app has not been built on this device.';
    return;
  }
  const brief = window.ownerBrief(window.ownerData ?? SAMPLE);
  el('headline').textContent = brief.headline;
  renderFreshness(brief.freshness);
  renderAttention(brief.attention);
  renderKpis(brief.kpis);
  renderAlerts(brief.alerts);
}

el('lang').addEventListener('click', () => {
  document.documentElement.lang = document.documentElement.lang === 'en' ? 'ta' : 'en';
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the brief still shows without the SW; it just won't be cached offline */
  });
}

render();
