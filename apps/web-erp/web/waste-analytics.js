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

// U2 · G14 (UI/UX gap audit): a date a shop person reads — dd/mm/yyyy in the chrome's shared field (`sreOffice.dateField`),
// while the page goes on sending ISO (`dateOf`). Before the chrome has loaded, or off the box, the field stays as it was.
const wordsIn = (l, k) => (api === null ? k : api.words(l, k)); // the page's own words, for either language (null off the box)
const shopDates = new Map();
/** The shared fields' labels follow the language toggle like the page's own words do. */
function repaintShopDates() { const l = document.documentElement.lang === 'ta' ? 'ta' : 'en'; for (const [id, words] of shopDates) { const lab = $(id)?.closest('.sre-field')?.querySelector('.sre-field-label'); if (lab && lab.firstChild) lab.firstChild.textContent = words[l] ?? words.en; } }
function shopDate(id, words, opts = {}) {
  const office = window.sreOffice; const input = $(id);
  if (!office || typeof office.dateField !== 'function' || input === null || shopDates.has(id)) return;
  // a value already on the plain field is carried over — ISO as the page set it, or dd/mm/yyyy as a person typed it
  const typed = input.value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(typed) ? typed : (typeof office.parseShopDate === 'function' ? office.parseShopDate(typed) : null);
  const field = office.dateField({ id, label: words, required: opts.required === true, ...(iso ? { value: iso } : {}), ...(opts.hint ? { hint: opts.hint } : {}) });
  (input.closest('label') ?? input).replaceWith(field);
  shopDates.set(id, words);
}
const dateOf = (id) => (shopDates.has(id) ? (window.sreOffice.dateValue(id) ?? '') : ($(id)?.value ?? ''));
let report = null;

function table(caption, lines, keyWords, prefix) {
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
  const odd = $(`${prefix}-odd`);
  odd.hidden = b === null || b.unclassified.events === 0;
  odd.textContent = b === null ? '' : t('waUnclassified', { n: b.unclassified.events });
  const reason = (k) => api.reasonWords(lang, k);
  $(`${prefix}-tables`).replaceChildren(...(b === null ? [] : b.events === 0
    ? [Object.assign(document.createElement('p'), { className: 'muted', textContent: t('waNone') })]
    : [table(t('waByReason'), b.byReason, reason, `${prefix}-reason`), table(t('waByDept'), b.byDepartment, reason, `${prefix}-dept`), table(t('waBySku'), b.bySku, (k) => k, `${prefix}-sku`)]));
}

function paint() {
  repaintShopDates();
  document.title = `SRE ${t('waTitle')}`;
  for (const [id, k] of [['title-text', 'waTitle'], ['page-h', 'waTitle'], ['lead', 'waLead'], ['l-from', 'waFrom'], ['l-to', 'waTo'], ['show', 'waShow'], ['wo-h', 'waWriteOffs'], ['wr-h', 'waRecords'], ['wo-k-total', 'waTotal'], ['wr-k-total', 'waTotal']]) { const n = $(id); if (n) n.textContent = t(k); }
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.storeOpsData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  paintBreakdown('wo', report?.writeOffs ?? null);
  paintBreakdown('wr', report?.wasteRecords ?? null);
}

async function show(event) {
  event?.preventDefault();
  const out = await session.wasteAnalytics(dateOf('from'), dateOf('to'));
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
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (may.named && !may.readWaste) { $('page-status').className = 'status err'; $('page-status').textContent = t('cannotRead'); $('show').disabled = true; }
else if (may.named) void show();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
// the chrome loads after this script: its shared date fields replace the plain ones once it is there
document.addEventListener('sre:chrome', () => { shopDate('from', { en: wordsIn('en', 'waFrom'), ta: wordsIn('ta', 'waFrom') }); shopDate('to', { en: wordsIn('en', 'waTo'), ta: wordsIn('ta', 'waTo') }); paint(); }, { once: true });
