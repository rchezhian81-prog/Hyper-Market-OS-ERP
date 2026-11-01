// Waste analytics — the page over head office's D-5 analytics (OB-154 · OB-159). A read only: the session
// (apps/web-erp/src/store-ops-session.ts, in the bundle as window.storeOps) asks head office for a window and the page
// shows write-offs and waste records side by side — never added together — by reason (the six on the closed list), by
// department and by product. An event whose reason is not on the list is counted and said, never dropped. Nothing is
// written. Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const api = window.storeOps ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, readWaste: false };

let lang = 'en';
const t = (k, slots) => (api === null ? k : api.words(lang, k, slots));
let report = null;
// UI-3: the source line and the "by reason" chart — the page's own words for them, in both languages.
const UI3 = {
  en: { covers: 'This store · from {from} to {to} · head office answered at {time}', byReason: 'Lost, by reason', reason: 'Reason', value: 'Value lost', byDay: 'Lost, by shop day', day: 'Day', events: 'recorded', nothingRecorded: 'nothing recorded', trendNote: 'A day with no bar is a day with nothing recorded — not a day nobody checked.', trendNotRead: 'The day-by-day trend could not be read from head office, so it is not drawn.', tooLong: 'The trend covers at most 92 days; choose a shorter window to see it.', offList: 'Reason not on the list', eventsCard: 'Events recorded' },
  ta: { covers: 'இந்தக் கடை · {from} முதல் {to} வரை · தலைமை அலுவலகம் பதிலளித்த நேரம் {time}', byReason: 'காரண வாரியாக இழப்பு', reason: 'காரணம்', value: 'இழந்த மதிப்பு', byDay: 'கடை நாள் வாரியாக இழப்பு', day: 'நாள்', events: 'பதிவுகள்', nothingRecorded: 'எதுவும் பதிவாகவில்லை', trendNote: 'பட்டை இல்லாத நாள் எதுவும் பதிவாகாத நாள் — யாரும் சரிபார்க்காத நாள் அல்ல.', trendNotRead: 'நாள் வாரியான போக்கைத் தலைமை அலுவலகத்திலிருந்து படிக்க முடியவில்லை, எனவே வரையப்படவில்லை.', tooLong: 'போக்கு அதிகபட்சம் 92 நாட்கள்; பார்க்கச் சிறிய காலத்தைத் தேர்ந்தெடுக்கவும்.', offList: 'பட்டியலில் இல்லாத காரணம்', eventsCard: 'பதிவான நிகழ்வுகள்' },
};
const u3 = (k) => UI3[lang][k] ?? UI3.en[k];
const fillIn = (text, values) => Object.entries(values).reduce((w, [k, v]) => w.split(`{${k}}`).join(String(v)), text);
let asked = null; // the window asked for, and when head office answered (OB-607: at the shop's clock)
let trend = null; // OB-641: the window by the shop's day, as head office answered (null = not read)
let trendWhy = ''; // why no trend is drawn (a word key), '' when it is drawn
const coversLine = () => (asked === null ? '' : fillIn(u3('covers'), { from: asked.from, to: asked.to, time: window.sreShopDay?.dateTimeOf(asked.at) ?? asked.at }));

// UI-3: the shared office parts (window.sreOffice, from the chrome — painted again on `sre:chrome`).
const office = () => window.sreOffice ?? null;
function table(caption, lines, keyWords, prefix) {
  const o = office();
  if (o !== null) {
    // The shared register: search, sort (money and quantities as numbers), every line head office sent — none dropped.
    const host = document.createElement('div');
    host.dataset.breakdown = prefix;
    o.table(host, {
      id: prefix, label: caption, pageSize: 25, rowKey: (l) => l.key, rows: [...lines],
      columns: [
        { key: 'key', label: t('waColWhat'), sort: 'text', value: (l) => keyWords(l.key) },
        { key: 'valueMinor', label: t('waColValue'), sort: 'number', align: 'end', render: (l) => api.rupees(l.valueMinor) },
        { key: 'qty', label: t('waColQty'), sort: 'number', align: 'end' },
        { key: 'shareBps', label: t('waColShare'), sort: 'number', align: 'end', render: (l) => api.percent(l.shareBps) },
      ],
    });
    const head = document.createElement('h4'); head.textContent = caption;
    const box = document.createElement('div'); box.append(head, host);
    return box;
  }
  const wrap = document.createElement('div'); wrap.className = 'table-wrap';
  const tbl = document.createElement('table'); tbl.dataset.breakdown = prefix;
  const cap = document.createElement('caption'); cap.textContent = caption; tbl.append(cap);
  const thead = document.createElement('thead'); const hr = document.createElement('tr');
  for (const k of ['waColWhat', 'waColValue', 'waColQty', 'waColShare']) { const th = document.createElement('th'); th.textContent = t(k); hr.append(th); }
  thead.append(hr);
  const tbody = document.createElement('tbody');
  for (const l of lines) {
    const tr = document.createElement('tr'); tr.dataset.key = l.key;
    for (const text of [keyWords(l.key), api.rupees(l.valueMinor), String(l.qty), api.percent(l.shareBps)]) { const td = document.createElement('td'); td.textContent = text; tr.append(td); }
    tbody.append(tr);
  }
  tbl.append(thead, tbody); wrap.append(tbl);
  return wrap;
}

function paintBreakdown(prefix, b) {
  $(`${prefix}-total`).textContent = b === null ? '—' : `${api.rupees(b.totalValueMinor)} · ${t('waEvents', { n: b.events })}`;
  // UI-3: the totals as the shared cards — "Not known" until head office has answered, never a nought.
  const o = office();
  $(`${prefix}-panels`).hidden = o !== null;
  if (o !== null) {
    o.cards($(`${prefix}-cards`), [
      { label: t('waTotal'), value: b === null ? null : api.rupees(b.totalValueMinor), note: coversLine(), tone: b !== null && b.events > 0 ? 'pending' : undefined, icon: 'indian-rupee' },
      { label: u3('eventsCard'), value: b === null ? null : b.events, note: b === null ? '' : t('waEvents', { n: b.events }), icon: 'list' },
      { label: u3('offList'), value: b === null ? null : b.unclassified.events, tone: b !== null && b.unclassified.events > 0 ? 'error' : undefined, icon: 'circle-help' },
    ]);
  }
  const odd = $(`${prefix}-odd`);
  odd.hidden = b === null || b.unclassified.events === 0;
  odd.textContent = b === null ? '' : t('waUnclassified', { n: b.unclassified.events });
  const reason = (k) => api.reasonWords(lang, k);
  // OB-641: the trend — this kind of waste by the shop's day, from head office's own by-day read.
  const trendHost = $(`${prefix}-trend`);
  trendHost.replaceChildren();
  if (b !== null && window.sreCharts !== undefined) {
    if (trend === null) {
      const p = document.createElement('p'); p.className = 'muted'; p.textContent = trendWhy === '' ? '' : u3(trendWhy); if (trendWhy !== '') trendHost.append(p);
    } else {
      const kind = prefix === 'wo' ? 'writeOffs' : 'wasteRecords';
      window.sreCharts.draw(trendHost, {
        id: `${prefix}-trend`, kind: 'columns', title: `${$(`${prefix}-h`).textContent} — ${u3('byDay')}`, covers: `${coversLine()} · ${u3('trendNote')}`,
        labelHeading: u3('day'), valueHeading: u3('value'),
        rows: trend.days.map((d) => ({
          key: d.day, label: `${d.day.slice(8, 10)}/${d.day.slice(5, 7)}`, value: d[kind].valueMinor,
          text: d[kind].events === 0 ? `${api.rupees(0)} · ${u3('nothingRecorded')}` : `${api.rupees(d[kind].valueMinor)} · ${d[kind].events} ${u3('events')}`,
        })),
      }, lang);
    }
  }
  // UI-3: the reasons as a chart — head office's own lines, each bar with its rupees in words; the tables below stay.
  const chartHost = $(`${prefix}-chart`);
  chartHost.replaceChildren();
  if (b !== null && b.events > 0 && window.sreCharts !== undefined) {
    window.sreCharts.draw(chartHost, {
      id: `${prefix}-reason`, kind: 'bars', title: `${$(`${prefix}-h`).textContent} — ${u3('byReason')}`, covers: coversLine(),
      labelHeading: u3('reason'), valueHeading: u3('value'),
      rows: [...b.byReason].sort((x, y) => y.valueMinor - x.valueMinor).map((l) => ({ key: l.key, label: reason(l.key), value: l.valueMinor, text: `${api.rupees(l.valueMinor)} · ${api.percent(l.shareBps)}` })),
    }, lang);
  }
  $(`${prefix}-tables`).replaceChildren(...(b === null ? [] : b.events === 0
    ? [Object.assign(document.createElement('p'), { className: 'muted', textContent: t('waNone') })]
    : [table(t('waByReason'), b.byReason, reason, `${prefix}-reason`), table(t('waByDept'), b.byDepartment, reason, `${prefix}-dept`), table(t('waBySku'), b.bySku, (k) => k, `${prefix}-sku`)]));
}

function paint() {
  document.title = `SRE ${t('waTitle')}`;
  for (const [id, k] of [['title-text', 'waTitle'], ['page-h', 'waTitle'], ['lead', 'waLead'], ['l-from', 'waFrom'], ['l-to', 'waTo'], ['show', 'waShow'], ['wo-h', 'waWriteOffs'], ['wr-h', 'waRecords'], ['wo-k-total', 'waTotal'], ['wr-k-total', 'waTotal']]) $(id).textContent = t(k);
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.storeOpsData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  $('wa-covers').textContent = report === null ? '' : coversLine();
  paintBreakdown('wo', report?.writeOffs ?? null);
  paintBreakdown('wr', report?.wasteRecords ?? null);
}

async function show(event) {
  event?.preventDefault();
  const window_ = { from: $('from').value, to: $('to').value };
  const out = await session.wasteAnalytics(window_.from, window_.to);
  asked = { ...window_, at: new Date().toISOString() };
  // OB-641: the same window by the shop's day — a second read; when it cannot be had, the page says so and draws no trend.
  const days = (Date.parse(`${window_.to}T00:00:00Z`) - Date.parse(`${window_.from}T00:00:00Z`)) / 86_400_000 + 1;
  if (out.result === 'ok' && days > 92) { trend = null; trendWhy = 'tooLong'; }
  else if (out.result === 'ok') {
    const tr = await session.wasteTrend(window_.from, window_.to);
    trend = tr.result === 'ok' ? tr.value : null;
    trendWhy = tr.result === 'ok' ? '' : 'trendNotRead';
  } else { trend = null; trendWhy = ''; }
  if (out.result === 'ok') { report = out.value; $('page-status').className = 'status'; $('page-status').textContent = ''; }
  else { report = null; $('page-status').className = 'status err'; $('page-status').textContent = api.outcomeWords(lang, out); }
  paint();
}

// The window opens on this month so far — the SHOP's today and month (never the browser's own date, which is still
// yesterday in the shop from 18:30 UTC on a browser set to UTC); a person changes it and asks again.
const today = api === null ? '' : api.todayAtShop();
$('to').value = today;
$('from').value = today === '' ? '' : `${today.slice(0, 7)}-01`;
$('ask').addEventListener('submit', (e) => { void show(e); });
document.addEventListener('sre:chrome', () => { paint(); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (may.named && !may.readWaste) { $('page-status').className = 'status err'; $('page-status').textContent = t('cannotRead'); $('show').disabled = true; }
else if (may.named) void show();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
