// Bill findings and attendance flags (OB-609 · P-03 · P-08) — the page over head office's sale findings and attendance-mark
// routes. The session (apps/web-erp/src/findings-session.ts, in the bundle as window.findings) does every call and every rule;
// this page lays out what it is told. It reads head office as it opens (GETs only); nothing is written. Every word this page
// adds has a Tamil twin; head office's own sentences stay in English (OB-553).

const $ = (id) => document.getElementById(id);
const api = window.findings ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, sales: false, attendance: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));

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
const setShopDate = (id, iso) => { const n = $(id); if (n === null) return; if (shopDates.has(id)) n.closest('.sre-date')?.sreSetDate?.(iso); else n.value = iso; };
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }

let bills = null; let billsOutcome = null; // head office's last answer, or why there is none
let marks = null; let marksOutcome = null;
let billsAt = null; let marksAt = null; // when head office answered (OB-607: shown at the shop's clock)
// UI-3: the source lines and the shared office parts (window.sreOffice, from the chrome — painted again on `sre:chrome`).
const UI3 = {
  en: { sCovers: 'This store · the findings head office holds on its bills · read at {time}', aCovers: 'This store · attendance marks of {day} · read at {time}', marks: 'Marks read', flagged: 'With a flag' },
  ta: { sCovers: 'இந்தக் கடை · பில்கள் மீது தலைமை அலுவலகத்தில் உள்ள கண்டறிதல்கள் · படித்த நேரம் {time}', aCovers: 'இந்தக் கடை · {day} வருகைப் பதிவுகள் · படித்த நேரம் {time}', marks: 'படித்த பதிவுகள்', flagged: 'எச்சரிக்கை உள்ளவை' },
};
const u3 = (k) => UI3[lang][k] ?? UI3.en[k];
const office = () => window.sreOffice ?? null;
const shopTime = (at) => (at === null ? '' : window.sreShopDay?.dateTimeOf(at) ?? at);
/** An empty list that is not an all-clear: the shared "nothing yet" state, saying what it covered (P-08). */
function emptyItem(title, detail) {
  const o = office();
  if (o === null) return text('li', title, 'meta');
  const li = document.createElement('li'); o.state(li, 'empty', { title, detail }); return li;
}
document.addEventListener('sre:chrome', () => { paint(); });

function paintBills() {
  $('s-rows').replaceChildren(); $('s-counts').textContent = ''; $('s-covers').textContent = ''; $('s-cards').replaceChildren();
  if (billsOutcome !== null) { $('s-status').textContent = api.outcomeWords(lang, billsOutcome); return; }
  if (bills === null) return;
  $('s-status').textContent = '';
  $('s-counts').textContent = `${bills.critical} · ${bills.material} · ${bills.informational}  (${t('counts')})`;
  $('s-covers').textContent = u3('sCovers').split('{time}').join(shopTime(billsAt));
  office()?.cards($('s-cards'), [
    { label: t('critical'), value: bills.critical, tone: bills.critical > 0 ? 'error' : undefined, icon: 'circle-alert' },
    { label: t('material'), value: bills.material, tone: bills.material > 0 ? 'pending' : undefined, icon: 'triangle-alert' },
    { label: t('informational'), value: bills.informational, icon: 'circle-help' },
  ]);
  if (bills.findings.length === 0) { $('s-rows').append(emptyItem(t('salesNone'), $('s-covers').textContent)); return; }
  $('s-rows').replaceChildren(...bills.findings.map((f) => {
    const li = document.createElement('li');
    li.className = f.severity === 'critical' ? 'tone-error' : 'tone-degraded';
    li.dataset.severity = f.severity; li.dataset.kind = f.kind; li.dataset.sale = f.saleId;
    const head = document.createElement('div'); head.className = 'head';
    head.append(text('span', `${f.severity === 'critical' ? '✕' : '⚠'} ${t(f.severity)}`, 'chip'), text('span', `${t('bill')} ${f.saleId}`, 'meta'));
    li.append(head, text('p', f.detail));
    const facts = [];
    if (f.productId !== undefined) facts.push(`${t('product')}: ${f.productId}`);
    if (f.differenceMinor !== undefined) facts.push(`${t('difference')}: ${api.rupees(f.differenceMinor)}`);
    if (facts.length > 0) li.append(text('p', facts.join(' · '), 'meta'));
    if (f.ownerAction !== '') li.append(text('p', `${t('todo')} ${f.ownerAction}`, 'meta'));
    return li;
  }));
}

function paintMarks() {
  $('a-rows').replaceChildren(); $('a-counts').textContent = ''; $('a-covers').textContent = ''; $('a-cards').replaceChildren();
  if (marksOutcome !== null) { $('a-status').textContent = api.outcomeWords(lang, marksOutcome); return; }
  if (marks === null) return;
  $('a-status').textContent = '';
  $('a-counts').textContent = `${marks.marksRead} ${t('marksRead')} ${marks.flagged.length}`;
  $('a-covers').textContent = u3('aCovers').split('{day}').join(marks.date).split('{time}').join(shopTime(marksAt));
  office()?.cards($('a-cards'), [
    { label: u3('marks'), value: marks.marksRead, icon: 'list' },
    { label: u3('flagged'), value: marks.flagged.length, tone: marks.flagged.length > 0 ? 'pending' : undefined, icon: 'triangle-alert' },
  ]);
  if (marks.flagged.length === 0) { $('a-rows').append(emptyItem(t('attNone'), $('a-covers').textContent)); return; }
  $('a-rows').replaceChildren(...marks.flagged.map((m) => {
    const li = document.createElement('li'); li.className = 'tone-degraded';
    li.dataset.mark = m.markId; li.dataset.person = m.employeeId; li.dataset.flags = m.flags.join(' ');
    const head = document.createElement('div'); head.className = 'head';
    head.append(text('h4', `${m.name} (${m.employeeId})`), text('span', `${t(m.kind)} · ${api.moment(m.at)}`, 'meta'));
    li.append(head, ...m.flags.map((f) => text('p', `⚠ ${api.flagWords(lang, f)}`, 'chip')));
    if (m.flaggedOnArrival.length > 0) li.append(text('p', `${t('flaggedOnArrival')} ${m.flaggedOnArrival.map((f) => api.flagWords(lang, f)).join(', ')}`, 'meta'));
    return li;
  }));
}

function paint() {
  repaintShopDates();
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  document.title = `SRE ${t('title')}`;
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['sales-h', 'salesH'], ['sales-lead', 'salesLead'], ['s-reload-text', 'reload'], ['att-h', 'attendanceH'], ['att-lead', 'attendanceLead'],
    ['a-day-l', 'day'], ['a-show-text', 'show']]) { const n = $(id); if (n) n.textContent = t(key); }
  paintBills(); paintMarks();
}

async function loadBills() {
  $('s-status').textContent = t('reading');
  const out = await session.bills();
  if (out.result === 'ok') { bills = out.value; billsOutcome = null; billsAt = new Date().toISOString(); } else { bills = null; billsOutcome = out; }
  paintBills();
}
async function loadMarks(event) {
  event?.preventDefault();
  $('a-status').textContent = t('reading');
  const out = await session.attendance(dateOf('a-day'));
  if (out.result === 'ok') { marks = out.value; marksOutcome = null; marksAt = new Date().toISOString(); } else { marks = null; marksOutcome = out; }
  paintMarks();
}

for (const [id, name] of [['s-reload', 'refresh-cw'], ['a-show', 'search']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.sales && !may.attendance) $('page-status').textContent = t('cannotRead');
else {
  if (may.sales) { $('sales').hidden = false; $('s-reload').addEventListener('click', () => { void loadBills(); }); void loadBills(); }
  if (may.attendance) {
    $('attendance').hidden = false;
    setShopDate('a-day', session.today());
    $('a-ask').addEventListener('submit', (e) => { void loadMarks(e); });
    void loadMarks();
  }
}
// the chrome loads after this script: its shared date fields replace the plain ones once it is there
document.addEventListener('sre:chrome', () => { shopDate('a-day', { en: wordsIn('en', 'day'), ta: wordsIn('ta', 'day') }); paint(); }, { once: true });
