// EPR registers (R4 · B20 · B21 · B22 · OB-212). The plastic the shop's own brand put on the market in a financial year,
// per packaging category, to the gram, with the file for the CPCB portal — nothing is filed automatically; the
// registration number, exemption and brand-owner answers, each "not confirmed" until the CA or consultant confirms it;
// and the take-back register: what customers brought back for disposal (never saleable), what was handed over to
// registered recyclers, and every exception. A take-back is recorded and take-back stock handed over from here; head
// office decides whether it stands and its refusal is shown as it said it ("recycler not registered"). No
// prompt/confirm/alert; nothing on a timer.

const el = (id) => document.getElementById(id);
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';

const WORDS = {
  en: {
    title: 'EPR registers', langName: 'தமிழ்',
    lead: 'The plastic put on the market by the shop\'s own brand, and what customers bring back for disposal. These are registers and yearly figures only: the CA or EPR consultant decides what is filed on the CPCB portal.',
    settingsHeading: 'Registration and brand-owner answers', confirmed: 'Confirmed', notConfirmed: 'Not confirmed', confirmedBy: 'Confirmed by',
    plasticHeading: 'Plastic packaging put on the market (own brand)', fy: 'Financial year', show: 'Show', csv: 'Download file for the CPCB portal',
    filing: 'Nothing is filed automatically. Upload the file on the CPCB portal only if the CA or EPR consultant says the shop must file.',
    grams: 'g', units: 'units', products: 'product(s)', incomplete: 'Incomplete — the exceptions below are not counted',
    noException: 'Every own-brand product has its packaging declared.',
    takebackHeading: 'Take-back register (e-waste and batteries)', onHand: 'On hand', takenBack: 'Taken back', handedOver: 'Handed over',
    notSaleable: 'Not saleable', battery: 'Battery', e_waste: 'E-waste', noStock: 'Nothing is held in the take-back location.',
    stockException: 'Count differs', assetException: 'Disposed asset with no e-waste handover', noTakebackException: 'No take-back exceptions.',
    recordHeading: 'Record a take-back', kind: 'Kind', description: 'What was brought back', weight: 'Weight (grams)', batteryType: 'Battery type', recordGo: 'Record take-back',
    handoverHeading: 'Hand over take-back stock to a recycler', recycler: 'Recycler', note: 'Handover note number', handoverGo: 'Hand over',
    unregistered: 'no registration number', recorded: 'Recorded', refused: 'Not recorded',
    needFields: 'Fill in what was brought back, its weight in whole grams and — for a battery — its type.',
    needHandover: 'Choose the recycler and fill in the weight, the battery type for a battery, and the handover note number.',
    unreachable: 'Head office could not be reached. Nothing was recorded — try again.',
    cannotRead: 'The EPR registers could not be read from head office. Nothing here is current.',
    noFy: 'Write the financial year like 2026-27.',
  },
  ta: {
    title: 'EPR பதிவேடுகள்', langName: 'English',
    lead: 'கடையின் சொந்த பிராண்ட் சந்தைக்கு அனுப்பிய பிளாஸ்டிக், மற்றும் வாடிக்கையாளர்கள் அகற்றுவதற்காகத் திருப்பிக் கொண்டுவருபவை. இவை பதிவேடுகளும் ஆண்டு எண்களும் மட்டுமே: CPCB இணையதளத்தில் எதைத் தாக்கல் செய்வது என்பதை CA அல்லது EPR ஆலோசகர் முடிவு செய்வார்.',
    settingsHeading: 'பதிவு மற்றும் பிராண்ட் உரிமையாளர் பதில்கள்', confirmed: 'உறுதிசெய்யப்பட்டது', notConfirmed: 'உறுதிசெய்யப்படவில்லை', confirmedBy: 'உறுதிசெய்தவர்',
    plasticHeading: 'சந்தைக்கு அனுப்பிய பிளாஸ்டிக் பொதி (சொந்த பிராண்ட்)', fy: 'நிதியாண்டு', show: 'காட்டு', csv: 'CPCB இணையதளத்திற்கான கோப்பைப் பதிவிறக்கு',
    filing: 'எதுவும் தானாகத் தாக்கல் செய்யப்படாது. கடை தாக்கல் செய்ய வேண்டும் என்று CA அல்லது EPR ஆலோசகர் சொன்னால் மட்டுமே CPCB இணையதளத்தில் கோப்பைப் பதிவேற்றுங்கள்.',
    grams: 'கி', units: 'அலகுகள்', products: 'பொருள்(கள்)', incomplete: 'முழுமையில்லை — கீழே உள்ள விதிவிலக்குகள் கணக்கிடப்படவில்லை',
    noException: 'ஒவ்வொரு சொந்த பிராண்ட் பொருளுக்கும் பொதி அறிவிக்கப்பட்டுள்ளது.',
    takebackHeading: 'திரும்பப் பெறும் பதிவேடு (மின்கழிவு மற்றும் பேட்டரிகள்)', onHand: 'கையிருப்பு', takenBack: 'திரும்பப் பெற்றது', handedOver: 'ஒப்படைத்தது',
    notSaleable: 'விற்பனைக்கு அல்ல', battery: 'பேட்டரி', e_waste: 'மின்கழிவு', noStock: 'திரும்பப் பெறும் இடத்தில் எதுவும் இல்லை.',
    stockException: 'எண்ணிக்கை வேறுபடுகிறது', assetException: 'மின்கழிவு ஒப்படைப்பு இல்லாமல் அகற்றப்பட்ட சொத்து', noTakebackException: 'திரும்பப் பெறுதலில் விதிவிலக்குகள் இல்லை.',
    recordHeading: 'திரும்பப் பெறுதலைப் பதிவு செய்', kind: 'வகை', description: 'திரும்பக் கொண்டுவரப்பட்டது', weight: 'எடை (கிராம்)', batteryType: 'பேட்டரி வகை', recordGo: 'திரும்பப் பெறுதலைப் பதிவு செய்',
    handoverHeading: 'திரும்பப் பெற்ற சரக்கை மறுசுழற்சியாளரிடம் ஒப்படை', recycler: 'மறுசுழற்சியாளர்', note: 'ஒப்படைப்புச் சீட்டு எண்', handoverGo: 'ஒப்படை',
    unregistered: 'பதிவு எண் இல்லை', recorded: 'பதிவு செய்யப்பட்டது', refused: 'பதிவு செய்யப்படவில்லை',
    needFields: 'திரும்பக் கொண்டுவரப்பட்டது, அதன் எடை (முழு கிராம்) மற்றும் பேட்டரி என்றால் அதன் வகையை நிரப்புங்கள்.',
    needHandover: 'மறுசுழற்சியாளரைத் தேர்ந்தெடுத்து எடை, பேட்டரி வகை மற்றும் ஒப்படைப்புச் சீட்டு எண்ணை நிரப்புங்கள்.',
    unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. எதுவும் பதிவு செய்யப்படவில்லை — மீண்டும் முயலவும்.',
    cannotRead: 'EPR பதிவேடுகளைத் தலைமை அலுவலகத்திலிருந்து படிக்க முடியவில்லை. இங்குள்ளவை தற்போதையவை அல்ல.',
    noFy: 'நிதியாண்டை 2026-27 போல எழுதுங்கள்.',
  },
};
const t = (key) => WORDS[lang]?.[key] ?? WORDS.en[key] ?? key;

let settings = null;
let plastic = null;
let takeBack = null;
let recyclers = [];
let readFailed = false;
/** One key per form while head office's answer is lost — a retry is then the same record, never two. */
const pendingKeys = new Map();

function tell(ok, text) {
  const r = el('result');
  r.hidden = false;
  r.className = `result tone-${ok ? 'ok' : 'error'}`;
  r.textContent = text;
}

function chip(tone, word) {
  if (window.sreIcon && typeof window.sreIcon.chip === 'function') return window.sreIcon.chip({ tone, label: word });
  const s = document.createElement('span'); s.textContent = word; return s;
}

function row(tone, headline, stateWord, facts, data = {}) {
  const li = document.createElement('li');
  li.className = `row tone-${tone}`;
  for (const [k, v] of Object.entries(data)) li.dataset[k] = v;
  const head = document.createElement('div'); head.className = 'head';
  const h = document.createElement('span'); h.className = 'headline'; h.textContent = headline;
  head.append(h);
  if (stateWord !== undefined) { const st = document.createElement('span'); st.className = 'state'; st.append(chip(tone, stateWord)); head.append(st); }
  const f = document.createElement('div'); f.className = 'facts';
  for (const x of facts) { const s = document.createElement('span'); s.textContent = x; f.append(s); }
  li.append(head, f);
  return li;
}

function panel(key, label, value) {
  const p = document.createElement('div'); p.className = 'panel'; p.dataset.panel = key;
  const k = document.createElement('span'); k.className = 'k'; k.textContent = label;
  const v = document.createElement('span'); v.className = 'v'; v.textContent = value;
  p.append(k, v);
  return p;
}

const stockWord = (s) => (s.kind === 'battery' ? `${t('battery')} — ${s.batteryType}` : t('e_waste'));

function paint() {
  document.title = `SRE ${t('title')}`;
  el('who').firstChild.textContent = `${t('title')} `;
  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('lang').textContent = t('langName');
  el('whoami').textContent = window.eprData?.userId ?? '';
  for (const [id, key] of [['settings-heading', 'settingsHeading'], ['plastic-heading', 'plasticHeading'], ['l-fy', 'fy'], ['show', 'show'], ['csv', 'csv'], ['filing', 'filing'],
    ['takeback-heading', 'takebackHeading'], ['record-heading', 'recordHeading'], ['l-kind', 'kind'], ['l-description', 'description'], ['l-weight', 'weight'], ['l-type', 'batteryType'], ['record-go', 'recordGo'],
    ['handover-heading', 'handoverHeading'], ['l-ho-kind', 'kind'], ['l-recycler', 'recycler'], ['l-ho-weight', 'weight'], ['l-ho-type', 'batteryType'], ['l-note', 'note'], ['handover-go', 'handoverGo']]) el(id).textContent = t(key);
  for (const sel of [el('tb-kind'), el('ho-kind')]) for (const o of sel.options) o.textContent = t(o.value);

  const state = el('state');
  state.hidden = !readFailed;
  state.textContent = readFailed ? t('cannotRead') : '';

  el('settings').replaceChildren(...(readFailed || settings === null ? [] : settings.map((s) => row(
    s.status === 'confirmed' ? 'ok' : 'degraded', s.label, t(s.status === 'confirmed' ? 'confirmed' : 'notConfirmed'),
    [s.value ?? '—', ...(s.confirmation ? [`${t('confirmedBy')}: ${s.confirmation}`] : [])], { key: s.key, status: s.status },
  ))));

  const cats = readFailed || plastic === null ? [] : plastic.categories;
  el('panels').replaceChildren(...cats.map((c) => panel(c.category, c.label, `${c.totalGrams.toLocaleString('en-IN')} ${t('grams')} · ${c.units} ${t('units')}`)));
  el('csv').disabled = plastic === null || readFailed;
  const ex = readFailed || plastic === null ? [] : plastic.exceptions;
  el('plastic-exceptions').replaceChildren(...(plastic === null || readFailed ? [] : ex.length === 0
    ? [row('ok', t('noException'), undefined, [])]
    : [row('error', t('incomplete'), undefined, []), ...ex.map((e) => row('error', e.productId, undefined, [e.detail], { product: e.productId, kind: e.kind }))]));

  el('takeback-words').textContent = takeBack?.words ?? '';
  const stock = readFailed || takeBack === null ? [] : takeBack.stock;
  el('stock').replaceChildren(...(takeBack === null || readFailed ? [] : stock.length === 0 ? [row('idle', t('noStock'), undefined, [])] : stock.map((s) => row(
    'idle', stockWord(s), t('notSaleable'),
    [`${t('onHand')}: ${s.onHandGrams} ${t('grams')}`, `${t('takenBack')}: ${s.takenBackGrams} ${t('grams')}`, `${t('handedOver')}: ${s.handedOverGrams} ${t('grams')}`],
    { stock: s.stockKey, onHand: String(s.onHandGrams) },
  ))));
  const tex = takeBack === null || readFailed ? null : takeBack.exceptions;
  el('takeback-exceptions').replaceChildren(...(tex === null ? [] : tex.count === 0 ? [row('ok', t('noTakebackException'), undefined, [])] : [
    ...tex.stock.map((e) => row('error', t('stockException'), undefined, [e.detail], { exception: e.stockKey })),
    ...tex.assets.map((a) => row('error', t('assetException'), undefined, [a.detail], { exception: a.assetId })),
  ]));

  const pick = el('ho-recycler');
  const chosen = pick.value;
  pick.replaceChildren(...recyclers.map((r) => {
    const o = document.createElement('option'); o.value = r.recyclerId;
    o.textContent = r.registered ? `${r.name} — ${r.registrationNumber}` : `${r.name} (${t('unregistered')})`;
    return o;
  }));
  if (recyclers.some((r) => r.recyclerId === chosen)) pick.value = chosen;
}

async function get(path) {
  const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

async function refresh() {
  const fy = el('fy').value.trim();
  try {
    const [s, tb, rc, p] = await Promise.all([
      get('/v1/compliance/epr/settings'), get('/v1/compliance/epr/take-back'), get('/v1/compliance/epr/recyclers'),
      /^\d{4}-\d{2}$/.test(fy) ? get(`/v1/compliance/epr/plastic/${encodeURIComponent(fy)}`) : Promise.resolve(null),
    ]);
    settings = s.settings; takeBack = tb; recyclers = rc.recyclers; plastic = p; readFailed = false;
  } catch {
    settings = null; takeBack = null; recyclers = []; plastic = null; readFailed = true;
  }
  paint();
}

async function post(path, body, slot) {
  const key = pendingKeys.get(slot) ?? `epr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  pendingKeys.set(slot, key);
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
  const answer = await res.json().catch(() => ({}));
  pendingKeys.delete(slot);
  return { ok: res.ok, answer, status: res.status };
}
const refusal = (out) => `${t('refused')}: ${out.answer?.error?.whatHappened ?? out.status}`;
const newId = (what) => `${what}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

async function recordTakeBack(event) {
  event.preventDefault();
  const kind = el('tb-kind').value;
  const description = el('tb-description').value.trim();
  const weightGrams = Number(el('tb-weight').value);
  const batteryType = el('tb-type').value.trim();
  if (description === '' || !Number.isInteger(weightGrams) || weightGrams <= 0 || (kind === 'battery' && batteryType === '')) { tell(false, t('needFields')); return; }
  const body = { kind, description, weightGrams, ...(kind === 'battery' ? { batteryType } : {}) };
  const slot = `tb:${JSON.stringify(body)}`;
  const id = pendingKeys.has(slot) ? pendingKeys.get(`${slot}:id`) : newId('tb');
  pendingKeys.set(`${slot}:id`, id);
  try {
    const out = await post(`/v1/compliance/epr/take-backs/${encodeURIComponent(id)}`, body, slot);
    if (out.ok) { pendingKeys.delete(`${slot}:id`); tell(true, `${t('recorded')}: ${description} — ${weightGrams} ${t('grams')}`); } else tell(false, refusal(out));
  } catch {
    tell(false, t('unreachable'));
  }
  await refresh();
}

async function handOver(event) {
  event.preventDefault();
  const kind = el('ho-kind').value;
  const recyclerId = el('ho-recycler').value;
  const weightGrams = Number(el('ho-weight').value);
  const batteryType = el('ho-type').value.trim();
  const note = el('ho-note').value.trim();
  if (recyclerId === '' || note === '' || !Number.isInteger(weightGrams) || weightGrams <= 0 || (kind === 'battery' && batteryType === '')) { tell(false, t('needHandover')); return; }
  const line = { description: kind === 'battery' ? `${batteryType} batteries` : 'take-back e-waste', weightGrams, ...(kind === 'battery' ? { batteryType } : {}) };
  const body = { to: { kind: 'recycler', recyclerId }, kind, lines: [line], note };
  const slot = `ho:${JSON.stringify(body)}`;
  const id = pendingKeys.has(slot) ? pendingKeys.get(`${slot}:id`) : newId('ho');
  pendingKeys.set(`${slot}:id`, id);
  try {
    const out = await post(`/v1/compliance/epr/take-back-stock/${encodeURIComponent(id)}/out`, body, slot);
    if (out.ok) { pendingKeys.delete(`${slot}:id`); tell(true, `${t('recorded')}: ${weightGrams} ${t('grams')} → ${out.answer.handover.registrationNumber}`); } else tell(false, refusal(out));
  } catch {
    tell(false, t('unreachable'));
  }
  await refresh();
}

let lastFileUrl = null;
function downloadCsv() {
  if (plastic === null) return;
  if (lastFileUrl !== null) URL.revokeObjectURL(lastFileUrl); // the previous file's link, now that it was taken
  lastFileUrl = URL.createObjectURL(new Blob([plastic.csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = lastFileUrl;
  a.download = `epr-plastic-${plastic.financialYear}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
}

el('ask').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!/^\d{4}-\d{2}$/.test(el('fy').value.trim())) { tell(false, t('noFy')); return; }
  void refresh();
});
el('csv').addEventListener('click', downloadCsv);
el('record').addEventListener('submit', (event) => { void recordTakeBack(event); });
el('handover').addEventListener('submit', (event) => { void handOver(event); });
el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
const asked = new URLSearchParams(location.search).get('fy');
if (asked !== null && /^\d{4}-\d{2}$/.test(asked)) el('fy').value = asked;
paint();
void refresh();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
