// GST and cess rates (Round 4a · M03-FR-03 · A6 · A7 · re-audit G-1): a THIN CLIENT over head office's effective-dated GST
// rate and compensation-cess schedules per HSN class. The classes listed are the ones head office's products carry; any
// other class can be opened by its code. The first rate of a class is set by the person who keeps the catalogue; a CHANGE
// waits for a Finance approver (the accountant or the owner — never the asker), asked here for exactly that change and
// decided on the approver's own Approvals page; then it is recorded naming that approval. Every word has a Tamil twin;
// nothing is written on open.

const $ = (id) => document.getElementById(id);
const who = window.taxRatesData && typeof window.taxRatesData === 'object' ? window.taxRatesData : null;
const perms = new Set(Array.isArray(who?.permissions) ? who.permissions : []);
const named = typeof who?.userId === 'string' && who.userId !== '';
const mayRead = perms.has('catalogue.pack.read');
const mayEdit = perms.has('catalogue.pack.publish');
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';

// U2 · G10 (UI/UX gap audit): a refusal says what happened, that nothing was changed, and the next safe action — the
// chrome's shared words (apps/web-erp/src/refusal-words.ts), never a raw code or HTTP status. The page's own prefix with
// head office's sentence stands in only until the chrome has loaded.
const refusalLine = (status, err) => {
  const office = window.sreOffice;
  if (office && typeof office.refusalWords === 'function') return office.refusalWords({ status, code: err?.code, whatHappened: err?.whatHappened, nextSafeAction: err?.nextSafeAction });
  const said = `${err?.whatHappened ?? ''} ${err?.nextSafeAction ?? ''}`.trim();
  return said === '' ? t('refused') : `${t('refused')} ${said}`;
};

const WORDS = {
  en: {
    lang: 'தமிழ்', title: 'GST and cess rates',
    lead: 'The GST rate and the compensation cess each tax class carries, and from when. A rate is never overwritten: a change is a new rate from a later date, and it waits for a Finance approver (the accountant or the owner) before it counts.',
    kClasses: 'Tax classes in use', kNoRate: 'With no GST rate today', kCess: 'With a cess today',
    listH: 'Tax classes', listLead: 'The classes head office\'s products carry. Open one to see every rate it has had and to record a new one.',
    cHsn: 'HSN', cProducts: 'Products', cGst: 'GST today', cCess: 'Cess today', cNext: 'Next change', hsn: 'HSN code (4 to 8 digits)', open: 'Open this class',
    recordH: 'HSN {hsn}', gstH: 'GST rate', cessH: 'Compensation cess', from: 'From (date)', rate: 'Rate (%)', saveGst: 'Record the GST rate',
    adv: 'Ad valorem (%)', spec: 'Specific (₹ per block, 0 for none)', per: 'Block (units, e.g. 1000 sticks)', saveCess: 'Record the cess',
    why: 'Why (for the Finance approver)', ask: 'Ask Finance to approve',
    noRate: 'No rate', noCess: 'none', none: 'none', gstLine: '{rate}% from {from}', cessLine: '{adv}%{spec} from {from}', specPart: ' + ₹{spec} per {per}',
    noPeriods: 'Nothing recorded yet.', saved: 'Recorded.', savedWith: 'Recorded with the approval of {by}.',
    needApproval: 'This is a tax change, so a Finance approver must approve exactly it first: {why} Write why, press “Ask Finance to approve”, and once they approve it on their Approvals page, press the same “Record” button again.',
    asked: 'Asked. It waits for the accountant or the owner on their Approvals page; nothing is recorded until then.', waiting: 'Still waiting for the Finance approver. Nothing was recorded.',
    rejected: 'The Finance approver rejected it: {why}', needWhy: 'Write the reason first.', needHsn: 'Write an HSN code of 4 to 8 digits.', needFigures: 'Write the date and the figures first.',
    refused: 'Head office refused:', unreachable: 'Head office could not be reached. Nothing was recorded — try again.', cannotRead: 'The rates could not be read from head office.',
    readOnly: 'You can read the rates. A new rate is recorded by the person who keeps the catalogue and approved by Finance.', noRight: 'This account may not read the tax classes.',
    nobody: 'Nobody is signed in on this computer, so nothing can be shown.', notKnown: 'Not known', products: '{n}',
  },
  ta: {
    lang: 'English', title: 'GST மற்றும் செஸ் விகிதங்கள்',
    lead: 'ஒவ்வொரு வரி வகுப்பும் கொண்ட GST விகிதமும் இழப்பீட்டு செஸ்ஸும், எப்போதிலிருந்து என்பதும். விகிதம் ஒருபோதும் மேலெழுதப்படாது: மாற்றம் பிந்தைய தேதியிலிருந்து புதிய விகிதம்; அது கணக்கில் வருமுன் நிதி ஒப்புதலாளர் (கணக்காளர் அல்லது உரிமையாளர்) ஒப்புக்கொள்ள வேண்டும்.',
    kClasses: 'பயன்பாட்டில் உள்ள வரி வகுப்புகள்', kNoRate: 'இன்று GST விகிதம் இல்லாதவை', kCess: 'இன்று செஸ் உள்ளவை',
    listH: 'வரி வகுப்புகள்', listLead: 'தலைமை அலுவலகப் பொருட்கள் கொண்டுள்ள வகுப்புகள். அது பெற்ற ஒவ்வொரு விகிதத்தையும் பார்க்கவும் புதியதைப் பதியவும் ஒன்றைத் திறக்கவும்.',
    cHsn: 'HSN', cProducts: 'பொருட்கள்', cGst: 'இன்றைய GST', cCess: 'இன்றைய செஸ்', cNext: 'அடுத்த மாற்றம்', hsn: 'HSN குறியீடு (4 முதல் 8 இலக்கங்கள்)', open: 'இந்த வகுப்பைத் திற',
    recordH: 'HSN {hsn}', gstH: 'GST விகிதம்', cessH: 'இழப்பீட்டு செஸ்', from: 'தொடங்கும் தேதி', rate: 'விகிதம் (%)', saveGst: 'GST விகிதத்தைப் பதி',
    adv: 'மதிப்பு அடிப்படை (%)', spec: 'குறிப்பிட்டது (ஒரு தொகுதிக்கு ₹, இல்லையெனில் 0)', per: 'தொகுதி (அலகுகள், எ.கா. 1000 சிகரெட்டுகள்)', saveCess: 'செஸ்ஸைப் பதி',
    why: 'ஏன் (நிதி ஒப்புதலாளருக்கு)', ask: 'நிதி ஒப்புதல் கேள்',
    noRate: 'விகிதம் இல்லை', noCess: 'இல்லை', none: 'இல்லை', gstLine: '{rate}% {from} முதல்', cessLine: '{adv}%{spec} {from} முதல்', specPart: ' + {per}-க்கு ₹{spec}',
    noPeriods: 'இன்னும் எதுவும் பதியப்படவில்லை.', saved: 'பதியப்பட்டது.', savedWith: '{by} அவர்களின் ஒப்புதலுடன் பதியப்பட்டது.',
    needApproval: 'இது வரி மாற்றம், எனவே நிதி ஒப்புதலாளர் இதையே முதலில் ஒப்புக்கொள்ள வேண்டும்: {why} ஏன் என்று எழுதி “நிதி ஒப்புதல் கேள்” அழுத்துங்கள்; அவர் தனது ஒப்புதல்கள் பக்கத்தில் ஒப்புக்கொண்டதும் அதே “பதி” பொத்தானை மீண்டும் அழுத்துங்கள்.',
    asked: 'கேட்கப்பட்டது. கணக்காளர் அல்லது உரிமையாளரின் ஒப்புதல்கள் பக்கத்தில் காத்திருக்கிறது; அதுவரை எதுவும் பதியப்படாது.', waiting: 'நிதி ஒப்புதலாளர் இன்னும் முடிவு செய்யவில்லை. எதுவும் பதியப்படவில்லை.',
    rejected: 'நிதி ஒப்புதலாளர் நிராகரித்தார்: {why}', needWhy: 'முதலில் காரணத்தை எழுதுங்கள்.', needHsn: '4 முதல் 8 இலக்க HSN குறியீட்டை எழுதுங்கள்.', needFigures: 'முதலில் தேதியையும் எண்களையும் எழுதுங்கள்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. எதுவும் பதியப்படவில்லை — மீண்டும் முயலவும்.', cannotRead: 'விகிதங்களைத் தலைமை அலுவலகத்திலிருந்து படிக்க முடியவில்லை.',
    readOnly: 'விகிதங்களை நீங்கள் படிக்கலாம். புதிய விகிதத்தைப் பட்டியலைப் பராமரிப்பவர் பதிகிறார், நிதி ஒப்புக்கொள்கிறது.', noRight: 'இந்தக் கணக்கு வரி வகுப்புகளைப் படிக்க முடியாது.',
    nobody: 'இந்தக் கணினியில் யாரும் உள்நுழையவில்லை, எனவே எதையும் காட்ட முடியாது.', notKnown: 'தெரியவில்லை', products: '{n}',
  },
};
const t = (k) => WORDS[lang]?.[k] ?? WORDS.en[k] ?? k;

// U2 · G14 (UI/UX gap audit): a date a shop person reads — dd/mm/yyyy in the chrome's shared field (`sreOffice.dateField`),
// while the page goes on sending ISO (`dateOf`). Before the chrome has loaded, or off the box, the field stays as it was.
const wordsIn = (l, k) => WORDS[l]?.[k] ?? WORDS.en[k] ?? k;
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
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
const pct = (bps) => (bps / 100).toFixed(2).replace(/\.?0+$/, '');
// The shop's date (India) — which period is in force today is read from head office's own schedule against it.
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const newKey = () => `tax-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
async function call(method, path, body) {
  try {
    const res = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json', 'idempotency-key': newKey() } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  } catch { return { ok: false, status: 0, body: null }; }
}
const tell = (el, ok, text) => { el.className = `status ${ok ? 'good' : 'err'}`; el.textContent = text; };
const say = (el, out, good) => tell(el, out.ok, out.ok ? good : out.status === 0 ? t('unreachable') : refusalLine(out.status, out.body?.error));
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}
async function ownApproval(kind, subjectRef, details) {
  const out = await call('GET', '/v1/approvals/requests');
  if (!out.ok) return {};
  const mine = (Array.isArray(out.body?.mine) ? out.body.mine : []).filter((r) => r.kind === kind && r.subjectRef === subjectRef && canonical(r.details) === canonical(details));
  const newest = (rows) => rows.slice().sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))[0];
  const approved = newest(mine.filter((r) => r.status === 'approved'));
  if (approved !== undefined) return { approvalId: approved.requestId, decidedBy: approved.decidedBy };
  if (mine.some((r) => r.status === 'waiting')) return { waiting: true };
  const last = newest(mine);
  return last?.status === 'rejected' ? { rejected: last.decisionReason ?? '' } : {};
}

let classes = null;   // [{ hsn, products, gst: [...], cess: [...] }]
let open = null;      // the class on the record panel
let pending = null;   // { kind, details, summary } the last record needed approval for
const inForce = (periods, day) => [...periods].filter((p) => p.effectiveFrom <= day).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)).at(-1);
const nextOf = (periods, day) => [...periods].filter((p) => p.effectiveFrom > day).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0];
const gstWords = (p) => fill(t('gstLine'), { rate: pct(p.rateBps), from: p.effectiveFrom });
const cessWords = (p) => fill(t('cessLine'), { adv: pct(p.advaloremBps), spec: p.specificPerQuantityMinor > 0 ? fill(t('specPart'), { spec: (p.specificPerQuantityMinor / 100).toFixed(2), per: p.perQuantity }) : '', from: p.effectiveFrom });

async function readClass(hsn) {
  const [g, c] = await Promise.all([call('GET', `/v1/catalogue/tax-classes/${encodeURIComponent(hsn)}/rates`), call('GET', `/v1/catalogue/tax-classes/${encodeURIComponent(hsn)}/cess`)]);
  return { hsn, gst: g.ok && Array.isArray(g.body?.schedule) ? g.body.schedule : null, cess: c.ok && Array.isArray(c.body?.schedule) ? c.body.schedule : null, failed: !g.ok ? g : !c.ok ? c : null };
}

function paintList() {
  // U2b (G5): the classes head office's products carry are offered on the HSN field — the code stays, it is the class
  if (Array.isArray(classes)) $('hsn-list').replaceChildren(...classes.map((c) => Object.assign(document.createElement('option'), { value: c.hsn, label: `${c.hsn} · ${c.products} ${t('cProducts')}` })));
  const day = today();
  const tbody = $('rows'); tbody.replaceChildren();
  for (const k of classes ?? []) {
    const tr = document.createElement('tr'); tr.dataset.id = k.hsn; tr.tabIndex = 0;
    const g = k.gst === null ? undefined : inForce(k.gst, day); const c = k.cess === null ? undefined : inForce(k.cess, day);
    const next = [...(k.gst === null ? [] : [nextOf(k.gst, day)].filter(Boolean).map((p) => `GST ${gstWords(p)}`)), ...(k.cess === null ? [] : [nextOf(k.cess, day)].filter(Boolean).map((p) => `${t('cessH')} ${cessWords(p)}`))];
    const cells = [[k.hsn, false], [String(k.products), false],
      [k.gst === null ? t('notKnown') : g === undefined ? t('noRate') : `${pct(g.rateBps)}%`, k.gst === null || g === undefined],
      [k.cess === null ? t('notKnown') : c === undefined || (c.advaloremBps === 0 && c.specificPerQuantityMinor === 0) ? t('noCess') : cessWords(c), k.cess === null],
      [next.length === 0 ? t('none') : next.join(' · '), false]];
    for (const [v, warn] of cells) { const td = document.createElement('td'); td.textContent = v; if (warn) td.className = 'unknown'; tr.append(td); }
    const go = () => { $('hsn').value = k.hsn; void openClass(k.hsn); };
    tr.addEventListener('click', go); tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    tbody.append(tr);
  }
  const unknown = (el, known, v) => { el.textContent = known ? String(v) : t('notKnown'); el.classList.toggle('unknown', !known); };
  unknown($('v-classes'), classes !== null, classes?.length ?? 0);
  unknown($('v-norate'), classes !== null && classes.every((k) => k.gst !== null), (classes ?? []).filter((k) => k.gst !== null && inForce(k.gst, day) === undefined).length);
  unknown($('v-cess'), classes !== null && classes.every((k) => k.cess !== null), (classes ?? []).filter((k) => { const c = k.cess === null ? undefined : inForce(k.cess, day); return c !== undefined && (c.advaloremBps > 0 || c.specificPerQuantityMinor > 0); }).length);
}

function paintRecord() {
  $('record').hidden = open === null;
  if (open === null) return;
  $('record-h').textContent = fill(t('recordH'), { hsn: open.hsn });
  const list = (periods, words) => (periods === null ? [Object.assign(document.createElement('li'), { textContent: t('notKnown') })]
    : periods.length === 0 ? [Object.assign(document.createElement('li'), { textContent: t('noPeriods') })]
      : [...periods].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)).map((p) => { const li = document.createElement('li'); li.dataset.from = p.effectiveFrom; li.textContent = words(p); return li; }));
  $('gst-list').replaceChildren(...list(open.gst, gstWords));
  $('cess-list').replaceChildren(...list(open.cess, cessWords));
  for (const id of ['g-from', 'g-rate', 'g-save', 'c-from', 'c-adv', 'c-spec', 'c-per', 'c-save', 'why']) $(id).disabled = !mayEdit;
  whyDisabled($('g-save'), mayEdit ? '' : 'role'); whyDisabled($('c-save'), mayEdit ? '' : 'role');
  $('ask').hidden = pending === null || !mayEdit;
}

function paint() {
  repaintShopDates();
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['k-classes', 'kClasses'], ['k-norate', 'kNoRate'], ['k-cess', 'kCess'], ['list-h', 'listH'], ['list-lead', 'listLead'],
    ['c-hsn', 'cHsn'], ['c-products', 'cProducts'], ['c-gst', 'cGst'], ['c-cess', 'cCess'], ['c-next', 'cNext'], ['l-hsn', 'hsn'], ['open', 'open'], ['gst-h', 'gstH'], ['cess-h', 'cessH'],
    ['l-g-from', 'from'], ['l-g-rate', 'rate'], ['g-save', 'saveGst'], ['l-c-from', 'from'], ['l-c-adv', 'adv'], ['l-c-spec', 'spec'], ['l-c-per', 'per'], ['c-save', 'saveCess'], ['l-why', 'why'], ['ask', 'ask']]) { const el = $(id); if (el) el.textContent = t(k); }
  $('lang').textContent = t('lang');
  $('nobody').hidden = named; $('nobody').textContent = t('nobody');
  paintList(); paintRecord();
}

async function load() {
  const out = await call('GET', '/v1/catalogue/products');
  if (!out.ok) { say($('page-status'), out, ''); classes = null; paint(); return; }
  const counts = new Map();
  for (const p of out.body?.products ?? []) if (typeof p.taxClass === 'string' && p.taxClass.trim() !== '') counts.set(p.taxClass.trim(), (counts.get(p.taxClass.trim()) ?? 0) + 1);
  const read = await Promise.all([...counts.keys()].sort().map(readClass));
  classes = read.map((k) => ({ ...k, products: counts.get(k.hsn) ?? 0 }));
  const st = $('page-status');
  if (read.some((k) => k.failed !== null)) say(st, read.find((k) => k.failed !== null).failed, '');
  else if (!mayEdit) { st.className = 'status'; st.textContent = t('readOnly'); } else st.textContent = '';
  paint();
}

async function openClass(hsn) {
  if (!/^\d{4,8}$/.test(hsn)) { tell($('page-status'), false, t('needHsn')); return; }
  const k = await readClass(hsn);
  open = { ...k, products: classes?.find((c) => c.hsn === hsn)?.products ?? 0 };
  pending = null;
  $('record-status').textContent = '';
  if (k.failed !== null) say($('record-status'), k.failed, '');
  paint();
  $('record').scrollIntoView({ block: 'nearest' });
}

/** Record one period; a change waiting on Finance is asked for EXACTLY what was sent. */
async function record(kind, path, body, details, summary) {
  const st = $('record-status');
  // The last answer never stands for this one: cleared the moment this record starts, so "Recorded." on screen is always
  // THIS record's word (a stale one let the next change be typed while this one was still refreshing — and the refresh
  // then hid that change's "Ask Finance to approve"; found by the browser suite, 6 Nov 2026).
  st.className = 'status'; st.textContent = '';
  const found = await ownApproval(kind, open.hsn, details);
  if (found.waiting === true) { tell(st, false, t('waiting')); return; }
  const out = await call('POST', path, { ...body, ...(found.approvalId === undefined ? {} : { approvalId: found.approvalId }) });
  const needs = out.body?.error?.code === 'tax_change_needs_finance_approval' || out.body?.error?.code === 'cess_change_needs_finance_approval';
  if (!out.ok && needs) {
    pending = { kind, details, summary };
    paintRecord();
    tell(st, false, found.rejected !== undefined ? fill(t('rejected'), { why: found.rejected }) : fill(t('needApproval'), { why: out.body.error.whatHappened }));
    return;
  }
  pending = null;
  if (!out.ok) { say(st, out, ''); paintRecord(); return; }
  const hsn = open.hsn;
  await load(); await openClass(hsn);
  tell($('record-status'), true, found.decidedBy === undefined ? t('saved') : fill(t('savedWith'), { by: found.decidedBy }));
}

$('pick').addEventListener('submit', (e) => { e.preventDefault(); void openClass($('hsn').value.trim()); });
$('g-save').addEventListener('click', () => {
  const from = dateOf('g-from'); const rate = $('g-rate').value.trim();
  if (open === null || from === '' || rate === '') { tell($('record-status'), false, t('needFigures')); return; }
  const rateBps = Math.round(Number(rate) * 100);
  const body = { rateBps: Number.isFinite(rateBps) ? rateBps : rate };
  void record('tax_rate_change', `/v1/catalogue/tax-classes/${encodeURIComponent(open.hsn)}/rates/${encodeURIComponent(from)}`, body, { ...body, hsnCode: open.hsn, effectiveFrom: from }, `GST on HSN ${open.hsn}: ${rate}% from ${from}`);
});
$('c-save').addEventListener('click', () => {
  const from = dateOf('c-from'); const adv = $('c-adv').value.trim(); const spec = $('c-spec').value.trim() || '0'; const per = $('c-per').value.trim() || '1';
  if (open === null || from === '' || adv === '') { tell($('record-status'), false, t('needFigures')); return; }
  const num = (v, scale) => { const n = Math.round(Number(v) * scale); return Number.isFinite(n) ? n : v; };
  const body = { advaloremBps: num(adv, 100), specificPerQuantityMinor: num(spec, 100), perQuantity: num(per, 1) };
  void record('cess_rate_change', `/v1/catalogue/tax-classes/${encodeURIComponent(open.hsn)}/cess/${encodeURIComponent(from)}`, body, { ...body, hsnCode: open.hsn, effectiveFrom: from }, `Cess on HSN ${open.hsn}: ${adv}% + ₹${spec} per ${per} from ${from}`);
});
$('ask').addEventListener('click', async () => {
  const st = $('record-status');
  const why = $('why').value.trim();
  if (why === '') { tell(st, false, t('needWhy')); return; }
  if (pending === null || open === null) return;
  const out = await call('POST', '/v1/approvals/requests', { kind: pending.kind, subjectRef: open.hsn, details: pending.details, valueMinor: null, summary: pending.summary, reason: why });
  if (out.ok) { pending = null; paintRecord(); tell(st, true, t('asked')); } else say(st, out, '');
});
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });

paint();
if (named && !mayRead) tell($('page-status'), false, t('noRight'));
if (named && mayRead) void load();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* the page still opens; it is not kept for offline use */ });
}

/** A greyed button says why (U1 · G3 · design system §4 "disabled state explains why"): the reason is the button's tooltip
 *  and the words beside it, in the reader's language. `why` is 'role' (your role may not), 'offline' (head office cannot
 *  be reached), a page's own { en, ta } pair or sentence; '' takes the words away. */
function whyWords() {
  return {
  role: { en: 'Your role may not do this.', ta: 'உங்கள் பங்குக்கு இதைச் செய்ய அனுமதி இல்லை.' },
  offline: { en: 'Head office cannot be reached, so this cannot be done now.', ta: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை, எனவே இப்போது இதைச் செய்ய முடியாது.' },
  };
}
function whyDisabled(btn, why) {
  const tongue = document.documentElement.lang === 'ta' ? 'ta' : 'en';
  const words = why === '' || why === undefined || why === null ? '' : typeof why === 'string' ? (whyWords()[why]?.[tongue] ?? why) : (why[tongue] ?? why.en);
  let note = btn.nextElementSibling;
  if (!(note && note.classList.contains('sre-why'))) {
    note = document.createElement('small'); note.className = 'sre-why';
    note.id = `${btn.id || `b${Math.random().toString(36).slice(2, 7)}`}-why`;
    btn.after(note);
  }
  note.textContent = words; note.hidden = words === '';
  if (words === '') { btn.removeAttribute('title'); btn.removeAttribute('aria-describedby'); } else { btn.title = words; btn.setAttribute('aria-describedby', note.id); }
}
// the chrome loads after this script: its shared date fields replace the plain ones once it is there
document.addEventListener('sre:chrome', () => { shopDate('g-from', { en: wordsIn('en', 'from'), ta: wordsIn('ta', 'from') }); shopDate('c-from', { en: wordsIn('en', 'from'), ta: wordsIn('ta', 'from') }); paint(); }, { once: true });
