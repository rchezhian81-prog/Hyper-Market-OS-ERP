// Offer results (Round 4a · M05-FR-03 · M05-FR-04): a THIN CLIENT over head office's offer register, each offer's rule,
// what it did against a baseline and its Stop. The results are head office's own fold of the banked bills, the average
// buying cost and the suppliers' funding journals; where a cost is missing the verdict is "Not known", by name, never
// costed at zero. Stop is the offer-launcher's act (promotion.launch): from now the offer never applies, wherever its
// window says. An offer is defined and started on the Products page's Offer tab. Every word has a Tamil twin; nothing is
// written on open.

const $ = (id) => document.getElementById(id);
const who = window.offerResultsData && typeof window.offerResultsData === 'object' ? window.offerResultsData : null;
const perms = new Set(Array.isArray(who?.permissions) ? who.permissions : []);
const named = typeof who?.userId === 'string' && who.userId !== '';
const mayRead = perms.has('promotion.read');
const mayStop = perms.has('promotion.launch');
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';

const WORDS = {
  en: {
    lang: 'தமிழ்', title: 'Offer results',
    lead: 'Every offer head office holds and what each one did: units and margin against the days before it, with the money suppliers gave towards it. An offer is defined and started on the Products page (Offer tab); here it is measured, and stopped when it should end early.',
    kActive: 'Running now', kDraft: 'Recorded, not started', kStopped: 'Stopped', listH: 'Offers',
    cId: 'Offer', cKind: 'Kind', cOn: 'On', cDates: 'Dates', cStatus: 'Where it stands', noOffers: 'No offer has been recorded yet.',
    draft: 'Recorded — not started', active: 'Running', stopped: 'Stopped', ended: 'Ended',
    percent_off: 'Percent off', amount_off: 'Amount off', buy_x_get_y: 'Buy and get free', multibuy: 'Multibuy', bundle_price: 'Bundle price', member_price: 'Member price', mix_match: 'Mix and match', bank_offer: 'Bank offer',
    group: 'group {g}', basket: 'the whole basket', recordH: 'Offer {id}',
    ruleLine: '{kind} on {on}, {from} to {to}.{coupon}{member}{group}{cap}', couponPart: ' Coupon {c}.', memberPart: ' Members only.', groupPart: ' Does not stack with others in “{g}”.', capPart: ' At most {n} times a bill.',
    bFrom: 'Compare with the days from', bTo: 'to', measure: 'Measure the offer', baselineSaid: 'Compared with {from} to {to} ({how}).', byReader: 'the days you chose', justBefore: 'the same number of days just before it started',
    kUnits: 'Units: offer · before', kUplift: 'Extra units', kMargin: 'Margin kept, with supplier money', kFunding: 'Supplier money received', kVerdict: 'Worth doing?',
    yes: 'Yes', no: 'No', notKnown: 'Not known', notMeasured: 'Not measured: {why}.', marginNotKnown: 'Not known — no buying cost for {list}',
    sWhy: 'Why stop it', stop: 'Stop this offer now', stoppedOk: 'Stopped. From now it does not apply at any till or in the app (from the next store pack).', needWhy: 'Write why first.',
    // U1 · OB-698: the consequence-and-confirm sheet before a running offer is stopped
    confirmTitle: 'Stop the offer {name} now',
    confirmDetail: 'From the next store pack no till and not the app charges it. A stopped offer cannot be restarted — a new one is defined on the Products page. Its results stay on record.',
    confirmAuthority: 'In your name, with the reason you wrote. Head office refuses it if your role may not stop offers.',
    confirmLabel: 'Stop this offer', confirmUnavailable: 'The confirm step could not open, so nothing was sent. Reload the page and try again.',
    refused: 'Head office refused:', unreachable: 'Head office could not be reached. Nothing was changed — try again.', noRight: 'This account may not read offers.',
    readOnly: 'You can read the offers and their results. Stopping one is for those who launch offers.', nobody: 'Nobody is signed in on this computer, so nothing can be shown.',
  },
  ta: {
    lang: 'English', title: 'சலுகை முடிவுகள்',
    lead: 'தலைமை அலுவலகம் வைத்திருக்கும் ஒவ்வொரு சலுகையும், அது செய்ததும்: அதற்கு முந்தைய நாட்களுடன் ஒப்பிட்டு அலகுகளும் லாபமும், விநியோகஸ்தர்கள் அதற்குக் கொடுத்த பணத்துடன். சலுகை பொருட்கள் பக்கத்தில் (சலுகை தாவல்) வரையறுத்துத் தொடங்கப்படுகிறது; இங்கே அளக்கப்படுகிறது, முன்கூட்டியே முடிக்க வேண்டுமெனில் நிறுத்தப்படுகிறது.',
    kActive: 'இப்போது நடப்பவை', kDraft: 'பதியப்பட்டவை, தொடங்கவில்லை', kStopped: 'நிறுத்தப்பட்டவை', listH: 'சலுகைகள்',
    cId: 'சலுகை', cKind: 'வகை', cOn: 'எதற்கு', cDates: 'தேதிகள்', cStatus: 'நிலை', noOffers: 'இன்னும் எந்தச் சலுகையும் பதியப்படவில்லை.',
    draft: 'பதியப்பட்டது — தொடங்கவில்லை', active: 'நடக்கிறது', stopped: 'நிறுத்தப்பட்டது', ended: 'முடிந்தது',
    percent_off: 'சதவீதத் தள்ளுபடி', amount_off: 'தொகைத் தள்ளுபடி', buy_x_get_y: 'வாங்கினால் இலவசம்', multibuy: 'பல வாங்கல்', bundle_price: 'தொகுப்பு விலை', member_price: 'உறுப்பினர் விலை', mix_match: 'கலந்து பொருத்து', bank_offer: 'வங்கிச் சலுகை',
    group: 'குழு {g}', basket: 'முழுக் கூடை', recordH: 'சலுகை {id}',
    ruleLine: '{on} மீது {kind}, {from} முதல் {to} வரை.{coupon}{member}{group}{cap}', couponPart: ' கூப்பன் {c}.', memberPart: ' உறுப்பினர்களுக்கு மட்டும்.', groupPart: ' “{g}”-இல் உள்ள மற்றவற்றுடன் சேராது.', capPart: ' ஒரு பில்லுக்கு அதிகபட்சம் {n} முறை.',
    bFrom: 'இந்த நாட்களுடன் ஒப்பிடு: முதல்', bTo: 'வரை', measure: 'சலுகையை அள', baselineSaid: '{from} முதல் {to} வரையுடன் ஒப்பிடப்பட்டது ({how}).', byReader: 'நீங்கள் தேர்ந்த நாட்கள்', justBefore: 'அது தொடங்குவதற்கு முந்தைய அதே எண்ணிக்கை நாட்கள்',
    kUnits: 'அலகுகள்: சலுகை · முன்', kUplift: 'கூடுதல் அலகுகள்', kMargin: 'விநியோகஸ்தர் பணத்துடன் கிடைத்த லாபம்', kFunding: 'பெற்ற விநியோகஸ்தர் பணம்', kVerdict: 'பயனுள்ளதா?',
    yes: 'ஆம்', no: 'இல்லை', notKnown: 'தெரியவில்லை', notMeasured: 'அளக்கப்படவில்லை: {why}.', marginNotKnown: 'தெரியவில்லை — {list}-க்கு வாங்கும் விலை இல்லை',
    sWhy: 'ஏன் நிறுத்துகிறீர்கள்', stop: 'இந்தச் சலுகையை இப்போதே நிறுத்து', stoppedOk: 'நிறுத்தப்பட்டது. இனி எந்தக் கவுண்டரிலும் செயலியிலும் பொருந்தாது (அடுத்த கடைப் பொதியிலிருந்து).', needWhy: 'முதலில் ஏன் என்று எழுதுங்கள்.',
    confirmTitle: '{name} சலுகை இப்போதே நிறுத்தப்படும்',
    confirmDetail: 'அடுத்த கடைப் பொதியிலிருந்து எந்தக் கவுண்டரும் செயலியும் அதை வசூலிக்காது. நிறுத்திய சலுகையை மீண்டும் தொடங்க முடியாது — பொருட்கள் பக்கத்தில் புதியது வரையறுக்கப்படும். அதன் முடிவுகள் பதிவில் இருக்கும்.',
    confirmAuthority: 'நீங்கள் எழுதிய காரணத்துடன், உங்கள் பெயரில். சலுகைகளை நிறுத்தும் உரிமை உங்கள் பங்கிற்கு இல்லையெனில் தலைமை அலுவலகம் மறுக்கும்.',
    confirmLabel: 'இந்தச் சலுகையை நிறுத்து', confirmUnavailable: 'உறுதிப்படுத்தும் திரையைத் திறக்க முடியவில்லை, எனவே எதுவும் அனுப்பப்படவில்லை. பக்கத்தைப் புதுப்பித்து மீண்டும் முயற்சிக்கவும்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. எதுவும் மாற்றப்படவில்லை — மீண்டும் முயலவும்.', noRight: 'இந்தக் கணக்கு சலுகைகளைப் படிக்க முடியாது.',
    readOnly: 'சலுகைகளையும் அவற்றின் முடிவுகளையும் நீங்கள் படிக்கலாம். ஒன்றை நிறுத்துவது சலுகைகளைத் தொடங்குபவர்களுக்கு.', nobody: 'இந்தக் கணினியில் யாரும் உள்நுழையவில்லை, எனவே எதையும் காட்ட முடியாது.',
  },
};
const t = (k) => WORDS[lang]?.[k] ?? WORDS.en[k] ?? k;

// U5 (G17): every list stands on the chrome's register part — built once per host, fed by setRows, repainted on the
// language toggle by the chrome itself (the column words are pairs). A row's first cell is a button, so a keyboard reaches
// it; a click anywhere on the row opens the same record (the tests and a mouse click the row).
const pair = (k) => ({ en: WORDS.en[k] ?? k, ta: (WORDS.ta ?? {})[k] ?? WORDS.en[k] ?? k });
const tables = {};
function register(host, spec) {
  if (!window.sreOffice) return null; // the chrome's parts arrive after this script
  const have = tables[spec.id];
  if (have && have.connected()) return have;
  tables[spec.id] = window.sreOffice.table(host, spec);
  return tables[spec.id];
}
function rowLink(text) { const b = document.createElement('button'); b.type = 'button'; b.className = 'sre-btn sre-btn-quiet sre-row-link'; b.textContent = text; return b; }
function onRow(host, attr, open) {
  host.addEventListener('click', (e) => { const tr = e.target.closest(`tr[data-${attr}]`); if (tr && host.contains(tr)) open(tr.dataset[attr]); });
}
const wordsIn = (l, k) => WORDS[l]?.[k] ?? WORDS.en[k] ?? k;

// U2 · G14 (UI/UX gap audit): a date a shop person reads — dd/mm/yyyy in the chrome's shared field (`sreOffice.dateField`),
// while the page goes on sending ISO (`dateOf`). Before the chrome has loaded, or off the box, the field stays as it was.
// U7 (Group C2): the shared dd/mm/yyyy field is the chrome's ONE copy (`sreOffice.shopDate`) — its label, "(required)"
// and hint follow the language toggle inside the chrome; the page keeps its element ids and reads ISO back through
// `sreOffice.dateOf`. Before the chrome has loaded, or off the box, the plain field stays, so the page is never dead.
const shopDates = new Set();
function shopDate(id, words, opts = {}) {
  const o = window.sreOffice;
  if (!o || typeof o.shopDate !== 'function') { document.addEventListener('sre:chrome', () => shopDate(id, words, opts), { once: true }); return; }
  if (shopDates.has(id)) return;
  if (o.shopDate(id, words, opts) !== null) shopDates.add(id);
}
const dateOf = (id) => { const o = window.sreOffice; return shopDates.has(id) && o && typeof o.dateOf === 'function' ? (o.dateOf(id) ?? '') : (document.getElementById(id)?.value ?? ''); };
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
const rupees = (minor) => `₹${(minor / 100).toFixed(2)}`;
// A date as the shop reads it: a calendar date stays as written; an instant is read on the shop's own clock (India), never its UTC date.
const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(v)));

const newKey = () => `offer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
const say = (el, out, good) => tell(el, out.ok, out.ok ? good : out.status === 0 ? t('unreachable') : `${t('refused')} ${out.body?.error?.whatHappened ?? out.status}`);

// U1 · OB-698 (design system §1.3, §27.1): a money/stock click asks the shared consequence-and-confirm sheet first.
// `null` = the person went back (nothing is sent); 'unavailable' = the sheet could not open (said, never silent).
async function confirmFirst(spec) {
  const office = window.sreOffice;
  if (!office || typeof office.confirm !== 'function') return 'unavailable';
  const answer = await office.confirm(spec);
  return answer && answer.ok === true ? answer : null;
}

let offers = null;
let open = null;
let result = null;
onRow($('rows-host'), 'id', (id) => { const p = (offers ?? []).find((x) => x.id === id); if (!p) return; open = p; result = null; paint(); $('record-status').textContent = ''; });
const standing = (p) => (p.status === 'active' && Date.parse(p.endsAt) < Date.now() ? 'ended' : p.status);
const onWords = (p) => (Array.isArray(p.productIds) && p.productIds.length > 0 ? p.productIds.join(', ') : typeof p.group === 'string' ? fill(t('group'), { g: p.group }) : t('basket'));

function paintList() {
  const reg = register($('rows-host'), {
    id: 'offers', label: pair('listH'), pageSize: 10, sortable: true, bodyId: 'rows',
    columns: [
      { key: 'id', label: pair('cId'), value: (p) => p.id, render: (p) => rowLink(p.id) },
      { key: 'kind', label: pair('cKind'), value: (p) => t(p.kind) },
      { key: 'on', label: pair('cOn'), value: (p) => onWords(p) },
      { key: 'dates', label: pair('cDates'), value: (p) => `${day(p.startsAt)} – ${day(p.endsAt)}` },
      // G13: where the offer stands is the one record chip (its tone and both languages' words)
      { key: 'status', label: pair('cStatus'), value: (p) => t(standing(p)), render: (p) => window.sreOffice.recordChip(standing(p) === 'ended' ? 'expired' : standing(p), pair(standing(p))) },
    ],
    rowKey: (p) => p.id, rowData: (p) => ({ id: p.id, status: standing(p) }),
    empty: { title: pair('noOffers') },
  });
  if (reg === null) return;
  if (offers === null) reg.setState('unknown'); else reg.setRows(offers);
  const count = (s) => (offers ?? []).filter((p) => standing(p) === s).length;
  // the figures are summary cards: head office's counts, or "Not known" (the part's own word) until it answers
  window.sreOffice.cards($('figures'), [['kActive', 'active', 'tag'], ['kDraft', 'draft', 'clock'], ['kStopped', 'stopped', 'square']].map(([k, st, icon]) => ({ label: pair(k), value: offers === null ? null : String(count(st)), icon })));
}

function paintRecord() {
  $('record').hidden = open === null;
  if (open === null) return;
  const p = open;
  $('record-h').textContent = fill(t('recordH'), { id: p.id });
  $('rule').textContent = fill(t('ruleLine'), {
    kind: t(p.kind), on: onWords(p), from: day(p.startsAt), to: day(p.endsAt),
    coupon: typeof p.requiresCoupon === 'string' ? fill(t('couponPart'), { c: p.requiresCoupon }) : '', member: p.requiresMember === true ? t('memberPart') : '',
    group: typeof p.exclusiveGroup === 'string' ? fill(t('groupPart'), { g: p.exclusiveGroup }) : '', cap: Number.isInteger(p.maxApplications) ? fill(t('capPart'), { n: p.maxApplications }) : '',
  });
  const r = result;
  const w = r?.windows;
  // the measured result as summary cards — a figure head office could not measure is "Not known", never a dash
  window.sreOffice.cards($('result-panels'), [
    { label: pair('kUnits'), value: w === undefined ? null : `${w.offer.units} · ${w.baseline.units}`, icon: 'package' },
    { label: pair('kUplift'), value: r?.measured === true ? `${r.upliftUnits} (${(r.upliftBp / 100).toFixed(1)}%)` : null, icon: 'chart-column' },
    { label: pair('kMargin'), value: r?.measured === true ? rupees(r.incrementalMargin.minor) : null, icon: 'indian-rupee' },
    { label: pair('kFunding'), value: r !== null && typeof r.fundingReceivedMinor === 'number' ? rupees(r.fundingReceivedMinor ?? 0) : null, icon: 'wallet' },
    { label: pair('kVerdict'), value: r?.measured === true ? (r.worthDoing ? t('yes') : t('no')) : null, tone: r?.measured === true ? (r.worthDoing ? 'ok' : 'degraded') : undefined, icon: 'check' },
  ]);
  $('baseline-say').textContent = w === undefined ? '' : fill(t('baselineSaid'), { from: day(w.baseline.from), to: day(w.baseline.to), how: r.baselineChosenBy === 'the_reader' ? t('byReader') : t('justBefore') });
  $('result-say').textContent = r === null ? '' : r.measured === true ? r.detail ?? '' : Array.isArray(r.marginNotKnownFor) && r.marginNotKnownFor.length > 0 ? fill(t('marginNotKnown'), { list: r.marginNotKnownFor.join(', ') }) : fill(t('notMeasured'), { why: r.why ?? '' });
  $('stop-row').hidden = !mayStop || standing(p) !== 'active';
}

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['list-h', 'listH'],
     ['l-b-from', 'bFrom'], ['l-b-to', 'bTo'], ['measure', 'measure'],
    ['l-s-why', 'sWhy'], ['stop', 'stop']]) { const el = $(id); if (el) el.textContent = t(k); }
  $('lang').textContent = t('lang');
  $('nobody').hidden = named; $('nobody').textContent = t('nobody');
  paintList(); paintRecord();
}

async function load() {
  const out = await call('GET', '/v1/promotions');
  offers = out.ok && Array.isArray(out.body?.promotions) ? out.body.promotions : null;
  const st = $('page-status');
  if (!out.ok) say(st, out, ''); else if (!mayStop) { st.className = 'status'; st.textContent = t('readOnly'); } else st.textContent = '';
  if (open !== null) open = (offers ?? []).find((p) => p.id === open.id) ?? open;
  paint();
}

$('measure').addEventListener('click', async () => {
  if (open === null) return;
  const from = dateOf('b-from'); const to = dateOf('b-to');
  const q = from !== '' && to !== '' ? `?${new URLSearchParams({ baselineFrom: from, baselineTo: to })}` : '';
  const out = await call('GET', `/v1/promotions/${encodeURIComponent(open.id)}/results${q}`);
  if (!out.ok) { result = null; paintRecord(); say($('record-status'), out, ''); return; }
  result = out.body; $('record-status').textContent = '';
  paintRecord();
});
$('stop').addEventListener('click', async () => {
  const st = $('record-status');
  const why = $('s-why').value.trim();
  if (why === '') { tell(st, false, t('needWhy')); return; }
  if (open === null) return;
  // U1 · OB-698: the consequence-and-confirm sheet before a running offer stops — Go back sends nothing.
  const name = open.name ?? open.id;
  const answer = await confirmFirst({ title: { en: String(WORDS.en.confirmTitle).replace('{name}', name), ta: String(WORDS.ta.confirmTitle).replace('{name}', name) }, detail: { en: WORDS.en.confirmDetail, ta: WORDS.ta.confirmDetail }, authority: { en: WORDS.en.confirmAuthority, ta: WORDS.ta.confirmAuthority }, confirmLabel: { en: WORDS.en.confirmLabel, ta: WORDS.ta.confirmLabel }, tone: 'danger' });
  if (answer === 'unavailable') { tell(st, false, t('confirmUnavailable')); return; }
  if (answer === null) return;
  const out = await call('POST', `/v1/promotions/${encodeURIComponent(open.id)}/stop`, { reason: why });
  if (!out.ok) { say(st, out, ''); return; }
  $('s-why').value = '';
  await load();
  tell($('record-status'), true, t('stoppedOk'));
});
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });

paint();
if (named && !mayRead) tell($('page-status'), false, t('noRight'));
if (named && mayRead) void load();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* the page still opens; it is not kept for offline use */ });
}
// the chrome loads after this script: its shared date fields replace the plain ones once it is there
document.addEventListener('sre:chrome', () => { shopDate('b-from', { en: wordsIn('en', 'bFrom'), ta: wordsIn('ta', 'bFrom') }); shopDate('b-to', { en: wordsIn('en', 'bTo'), ta: wordsIn('ta', 'bTo') }); paint(); }, { once: true });
// U5: the chrome's parts arrive after this script (sre-chrome.js is the page's last script) — paint again once they are here.
document.addEventListener('sre:chrome', () => { paint(); }, { once: true });
