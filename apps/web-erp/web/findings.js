// Bill findings and attendance flags (OB-609 · P-03 · P-08) — the page over head office's sale findings and attendance-mark
// routes. The session (apps/web-erp/src/findings-session.ts, in the bundle as window.findings) does every call and every rule;
// this page lays out what it is told. It reads head office as it opens (GETs only); nothing is written. Every word this page
// adds has a Tamil twin; head office's own sentences stay in English (OB-553).
// U5 (UI/UX gap audit, lane 3 HARD, 7 Nov 2026): the findings are counted by kind and each kind is a register on the shared
// office parts (window.sreOffice: cards, table, state, chip) — never 48 identical cards in one column.

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
document.addEventListener('sre:chrome', () => { paint(); });

/** The product link a finding carries: the product's page, with the product's name where the box knows it. */
function productLink(productId) {
  const o = office();
  const a = document.createElement('a');
  // the page is served at /findings/, so the product's page is its sibling (the form Product checks uses)
  a.href = `../product-details/?product=${encodeURIComponent(productId)}`;
  a.className = 'sre-btn sre-btn-quiet'; // a 44px target (design system §1.8), as a row action, never a bare text link
  const name = o && typeof o.nameOf === 'function' ? o.nameOf('product', productId) : productId;
  a.textContent = name && name !== productId ? `${name} (${productId})` : productId;
  a.title = t('openProduct');
  return a;
}
const severityTone = (severity) => (severity === 'critical' ? 'error' : 'pending');
const kindName = (kind) => (api === null ? kind : api.kindWords(lang, kind));

/** The sales section: the counts, one card per kind, then one register per kind — never a wall of identical cards (U5). */
function paintBills() {
  const o = office();
  $('s-counts').textContent = ''; $('s-covers').textContent = ''; $('s-cards').replaceChildren(); $('s-kinds').replaceChildren(); $('s-groups').replaceChildren();
  $('s-kinds-h').textContent = ''; $('s-note').textContent = '';
  if (billsOutcome !== null) {
    $('s-status').textContent = api.outcomeWords(lang, billsOutcome);
    if (o !== null) o.state($('s-groups'), o.stateOf(billsOutcome), { title: api.outcomeWords(lang, billsOutcome), detail: t('notReadDetail') });
    return;
  }
  if (bills === null) { $('s-status').textContent = ''; if (o !== null) o.state($('s-groups'), 'loading'); return; }
  $('s-status').textContent = '';
  $('s-counts').textContent = `${bills.critical} · ${bills.material} · ${bills.informational}  (${t('counts')})`;
  $('s-covers').textContent = u3('sCovers').split('{time}').join(shopTime(billsAt));
  $('s-note').textContent = t('headOfficeEnglish');
  if (o === null) { $('s-groups').replaceChildren(...bills.findings.map((f) => text('p', `${t(f.severity)} · ${t('bill')} ${f.saleId} · ${f.detail}`, 'meta'))); return; }
  o.cards($('s-cards'), [
    { label: t('critical'), value: bills.critical, tone: bills.critical > 0 ? 'error' : undefined, icon: 'circle-alert' },
    { label: t('material'), value: bills.material, tone: bills.material > 0 ? 'pending' : undefined, icon: 'triangle-alert' },
    { label: t('informational'), value: bills.informational, icon: 'circle-help' },
  ]);
  if (bills.findings.length === 0) { o.state($('s-groups'), 'empty', { title: t('salesNone'), detail: t('salesEmptyDetail') }); return; }
  const groups = api.groupFindings(bills.findings);
  $('s-kinds-h').textContent = t('byKind');
  const kinds = o.cards($('s-kinds'), groups.map((g) => ({
    label: kindName(g.kind), value: g.count, tone: severityTone(g.worst), icon: g.worst === 'critical' ? 'circle-alert' : 'triangle-alert', href: `#kind-${g.kind}`,
    note: g.critical > 0 ? `${g.critical} ${t('critical').toLowerCase()} · ${g.material} ${t('material').toLowerCase()}` : t('groupMaterial'),
  })));
  kinds.querySelectorAll('.sre-summary-card').forEach((card, i) => { card.dataset.kind = groups[i].kind; });
  $('s-groups').replaceChildren(...groups.map((g) => {
    const sec = document.createElement('section'); sec.className = 'group'; sec.id = `kind-${g.kind}`; sec.dataset.kind = g.kind;
    sec.setAttribute('aria-labelledby', `kind-${g.kind}-h`);
    const h = document.createElement('h4'); h.id = `kind-${g.kind}-h`;
    h.append(document.createTextNode(`${kindName(g.kind)} · ${g.count} ${g.count === 1 ? t('findingOne') : t('findingsN')}`), o.chip(severityTone(g.worst), t(g.worst)));
    sec.append(h);
    if (!api.knowsKind(g.kind)) sec.append(text('p', t('kindUnknown'), 'meta'));
    const host = document.createElement('div'); sec.append(host);
    o.table(host, {
      id: `f-${g.kind}`, label: kindName(g.kind), rows: g.findings, pageSize: 10,
      rowKey: (f) => f.saleId, rowData: (f) => ({ sale: f.saleId, severity: f.severity, kind: f.kind }),
      columns: [
        { key: 'severity', label: t('severity'), sort: 'text', value: (f) => t(f.severity), render: (f) => o.chip(severityTone(f.severity), t(f.severity)) },
        { key: 'saleId', label: t('bill'), sort: 'text' },
        { key: 'productId', label: t('product'), render: (f) => (f.productId === undefined ? null : productLink(f.productId)) },
        { key: 'differenceMinor', label: t('difference'), sort: 'number', align: 'end', value: (f) => (f.differenceMinor === undefined ? null : api.rupees(f.differenceMinor)) },
        { key: 'detail', label: t('whatHappened') },
        { key: 'ownerAction', label: t('whatToDo'), value: (f) => (f.ownerAction === '' ? null : f.ownerAction) },
      ],
      empty: { title: t('salesNone'), detail: t('salesEmptyDetail') },
    });
    return sec;
  }));
}

/** The attendance section: the counts, then the flagged marks as a register (U5). */
function paintMarks() {
  const o = office();
  $('a-table').replaceChildren(); $('a-counts').textContent = ''; $('a-covers').textContent = ''; $('a-cards').replaceChildren();
  if (marksOutcome !== null) {
    $('a-status').textContent = api.outcomeWords(lang, marksOutcome);
    if (o !== null) o.state($('a-table'), o.stateOf(marksOutcome), { title: api.outcomeWords(lang, marksOutcome), detail: t('notReadDetail') });
    return;
  }
  if (marks === null) { $('a-status').textContent = ''; if (o !== null) o.state($('a-table'), 'loading'); return; }
  $('a-status').textContent = '';
  $('a-counts').textContent = `${marks.marksRead} ${t('marksRead')} ${marks.flagged.length}`;
  $('a-covers').textContent = u3('aCovers').split('{day}').join(marks.date).split('{time}').join(shopTime(marksAt));
  if (o === null) { $('a-table').replaceChildren(...marks.flagged.map((m) => text('p', `${m.name} (${m.employeeId}) · ${t(m.kind)} · ${api.moment(m.at)} · ${m.flags.map((f) => api.flagWords(lang, f)).join(', ')}`, 'meta'))); return; }
  o.cards($('a-cards'), [
    { label: u3('marks'), value: marks.marksRead, icon: 'list' },
    { label: u3('flagged'), value: marks.flagged.length, tone: marks.flagged.length > 0 ? 'pending' : undefined, icon: 'triangle-alert' },
  ]);
  if (marks.flagged.length === 0) { o.state($('a-table'), 'empty', { title: t('attNone'), detail: t('attEmptyDetail') }); return; }
  o.table($('a-table'), {
    id: 'a-flags', label: t('attendanceH'), rows: marks.flagged, pageSize: 10,
    rowKey: (m) => m.markId, rowData: (m) => ({ mark: m.markId, person: m.employeeId, flags: m.flags.join(' ') }),
    columns: [
      { key: 'name', label: t('person'), sort: 'text', value: (m) => `${m.name} (${m.employeeId})` },
      { key: 'kind', label: t('mark'), sort: 'text', value: (m) => t(m.kind) },
      { key: 'at', label: t('at'), sort: 'text', value: (m) => api.moment(m.at) },
      { key: 'flags', label: t('flags'), render: (m) => { const w = document.createElement('span'); w.className = 'sre-chips'; for (const f of m.flags) w.append(o.chip('pending', api.flagWords(lang, f))); return w; } },
      { key: 'flaggedOnArrival', label: t('flaggedOnArrival'), value: (m) => (m.flaggedOnArrival.length === 0 ? null : m.flaggedOnArrival.map((f) => api.flagWords(lang, f)).join(', ')) },
    ],
    empty: { title: t('attNone'), detail: t('attEmptyDetail') },
  });
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
