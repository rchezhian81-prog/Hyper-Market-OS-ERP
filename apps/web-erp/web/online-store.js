// The online store — the owner's and the manager's page (R4 · B23 · A26 · WF-16). It shows exactly what head office
// answered: the shop's details each with its value or "not set" (the grievance officer stays "not set" until the owner
// names one, OB-223, and the store cannot be published until then), each product's listing with every missing duty,
// another seller's goods refused (A26), the complaint clock, the GST line, the owner's return windows by category and
// every online return's steps. Every action is re-checked by head office; a refusal is shown as it said it.
// No prompt/confirm/alert; nothing on a timer.

const el = (id) => document.getElementById(id);
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';

const WORDS = {
  en: {
    title: 'Online store', langName: 'தமிழ்',
    lead: 'What every product online must show before payment, whose goods may be sold online, the complaint clock and online returns. A missing detail reads "not set".',
    hDetails: 'The shop\'s details on every listing', hListings: 'Products online', hComplaints: 'Online complaints (48 hours to acknowledge, one month to resolve)', hReturns: 'Online returns',
    legalName: 'Legal name', address: 'Address', gstin: 'GSTIN', returnTerms: 'Return and refund terms', grievanceOfficerName: 'Grievance officer', grievanceOfficerContact: 'Grievance officer contact',
    reason: 'Why (needed)', save: 'Save', publishStore: 'Publish the online store', notSet: 'not set',
    storeOpen: 'The online store is published.', storeNotOpen: 'The online store cannot be published yet:',
    listed: 'Online', notListed: 'Not online', publishable: 'Ready to publish', missing: 'Missing', publish: 'Publish online', withdraw: 'Withdraw', withdrawReason: 'Why withdraw',
    ack: 'Acknowledge by', resolveBy: 'Resolve by', ownerException: 'Owner exception', noComplaints: 'No online complaints.',
    awaiting_acknowledgement: 'Awaiting acknowledgement', acknowledgement_overdue: 'Not acknowledged in 48 hours', acknowledged: 'Acknowledged', redress_overdue: 'Not resolved within one month', resolved: 'Resolved',
    windows: 'Return window by category (days after delivery)', nonReturnable: 'Products that cannot be returned (comma between; "none" for none; blank leaves it not set)', policyReason: 'Why (needed)',
    policyNotSet: 'Return windows: not set. Non-returnable list: not set. No return can be judged until both are set (OB-213).', policyIs: 'Return windows:', listIs: 'Not returnable:', none: 'none',
    noReturns: 'No online returns.', book: 'Book collection', collectOn: 'Collect on', collected: 'Collected', receive: 'Received — count', counted: 'Count', dispose: 'Where it goes',
    sellable: 'Back to sellable', quarantine: 'Quarantine', waste: 'Waste', dispReason: 'Reason (needed for waste)', setDisposition: 'Choose', refund: 'Refund what came back', refundId: 'Refund reference', approvalId: 'Approval id (second person)',
    requested: 'Requested', collection_scheduled: 'Collection booked', received: 'Received', refund_waiting: 'Refund waiting for the bank', refunded: 'Refunded', refund_refused: 'Refund refused by the bank', stageCollected: 'Collected',
    done: 'Recorded', refused: 'Not recorded', unreachable: 'Head office could not be reached. Nothing was recorded — try again.', cannotRead: 'The online store could not be read from head office. Nothing here is current.',
    needReason: 'Write the reason first.',
  },
  ta: {
    title: 'ஆன்லைன் கடை', langName: 'English',
    lead: 'பணம் செலுத்தும் முன் ஒவ்வொரு ஆன்லைன் பொருளும் காட்ட வேண்டியவை, யாருடைய பொருட்கள் ஆன்லைனில் விற்கலாம், புகார் நேரம் மற்றும் ஆன்லைன் திருப்பி அனுப்புதல். இல்லாத விவரம் "அமைக்கப்படவில்லை" எனக் காட்டும்.',
    hDetails: 'ஒவ்வொரு பட்டியலிலும் கடையின் விவரங்கள்', hListings: 'ஆன்லைன் பொருட்கள்', hComplaints: 'ஆன்லைன் புகார்கள் (ஏற்க 48 மணி நேரம், தீர்க்க ஒரு மாதம்)', hReturns: 'ஆன்லைன் திருப்பி அனுப்புதல்',
    legalName: 'சட்டப் பெயர்', address: 'முகவரி', gstin: 'GSTIN', returnTerms: 'திருப்பி அனுப்புதல் மற்றும் பணம் திருப்பும் விதிமுறைகள்', grievanceOfficerName: 'குறைதீர்ப்பு அலுவலர்', grievanceOfficerContact: 'குறைதீர்ப்பு அலுவலர் தொடர்பு',
    reason: 'ஏன் (தேவை)', save: 'சேமி', publishStore: 'ஆன்லைன் கடையை வெளியிடு', notSet: 'அமைக்கப்படவில்லை',
    storeOpen: 'ஆன்லைன் கடை வெளியிடப்பட்டுள்ளது.', storeNotOpen: 'ஆன்லைன் கடையை இன்னும் வெளியிட முடியாது:',
    listed: 'ஆன்லைனில்', notListed: 'ஆன்லைனில் இல்லை', publishable: 'வெளியிடத் தயார்', missing: 'இல்லாதவை', publish: 'ஆன்லைனில் வெளியிடு', withdraw: 'திரும்பப் பெறு', withdrawReason: 'ஏன் திரும்பப் பெறுகிறீர்கள்',
    ack: 'ஏற்க வேண்டிய நேரம்', resolveBy: 'தீர்க்க வேண்டிய நேரம்', ownerException: 'உரிமையாளர் விதிவிலக்கு', noComplaints: 'ஆன்லைன் புகார்கள் இல்லை.',
    awaiting_acknowledgement: 'ஏற்புக்காகக் காத்திருக்கிறது', acknowledgement_overdue: '48 மணி நேரத்தில் ஏற்கப்படவில்லை', acknowledged: 'ஏற்கப்பட்டது', redress_overdue: 'ஒரு மாதத்தில் தீர்க்கப்படவில்லை', resolved: 'தீர்க்கப்பட்டது',
    windows: 'பிரிவு வாரியாகத் திருப்பி அனுப்பும் காலம் (விநியோகத்திற்குப் பின் நாட்கள்)', nonReturnable: 'திருப்பி அனுப்ப முடியாத பொருட்கள் (காற்புள்ளியால் பிரிக்கவும்; ஒன்றும் இல்லையெனில் "none"; காலியாக விட்டால் அமைக்கப்படாது)', policyReason: 'ஏன் (தேவை)',
    policyNotSet: 'திருப்பி அனுப்பும் காலம்: அமைக்கப்படவில்லை. திருப்ப முடியாதவை பட்டியல்: அமைக்கப்படவில்லை. இரண்டும் அமைக்கப்படும் வரை எந்தத் திருப்பி அனுப்புதலையும் தீர்மானிக்க முடியாது (OB-213).', policyIs: 'திருப்பி அனுப்பும் காலம்:', listIs: 'திருப்ப முடியாதவை:', none: 'இல்லை',
    noReturns: 'ஆன்லைன் திருப்பி அனுப்புதல்கள் இல்லை.', book: 'சேகரிப்பை முன்பதிவு செய்', collectOn: 'சேகரிக்கும் நாள்', collected: 'சேகரிக்கப்பட்டது', receive: 'பெறப்பட்டது — எண்ணிக்கை', counted: 'எண்ணிக்கை', dispose: 'எங்கே செல்கிறது',
    sellable: 'மீண்டும் விற்பனைக்கு', quarantine: 'தனிமைப்படுத்து', waste: 'கழிவு', dispReason: 'காரணம் (கழிவுக்குத் தேவை)', setDisposition: 'தேர்ந்தெடு', refund: 'திரும்பி வந்ததற்குப் பணம் திருப்பு', refundId: 'பணம் திருப்பும் குறிப்பு', approvalId: 'ஒப்புதல் எண் (இரண்டாம் நபர்)',
    requested: 'கேட்கப்பட்டது', collection_scheduled: 'சேகரிப்பு முன்பதிவு', received: 'பெறப்பட்டது', refund_waiting: 'பணம் திருப்புதல் வங்கிக்காகக் காத்திருக்கிறது', refunded: 'பணம் திருப்பப்பட்டது', refund_refused: 'வங்கி மறுத்தது', stageCollected: 'சேகரிக்கப்பட்டது',
    done: 'பதிவு செய்யப்பட்டது', refused: 'பதிவு செய்யப்படவில்லை', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. எதுவும் பதிவு செய்யப்படவில்லை — மீண்டும் முயலவும்.', cannotRead: 'ஆன்லைன் கடையைத் தலைமை அலுவலகத்திலிருந்து படிக்க முடியவில்லை. இங்குள்ளவை தற்போதையவை அல்ல.',
    needReason: 'முதலில் காரணத்தை எழுதுங்கள்.',
  },
};
const t = (key) => WORDS[lang]?.[key] ?? WORDS.en[key] ?? key;
const DETAIL_KEYS = ['legalName', 'address', 'gstin', 'returnTerms', 'grievanceOfficerName', 'grievanceOfficerContact'];
const STAGE_WORD = { requested: 'requested', collection_scheduled: 'collection_scheduled', collected: 'stageCollected', received: 'received', refund_waiting: 'refund_waiting', refunded: 'refunded', refund_refused: 'refund_refused' };
const STAGE_TONE = { refunded: 'ok', refund_waiting: 'degraded', refund_refused: 'error' };

let view = { details: null, listings: null, complaints: null, returns: null, readFailed: false };

function tell(ok, text) { const r = el('result'); r.hidden = false; r.className = `result tone-${ok ? 'ok' : 'error'}`; r.textContent = text; }
const refusal = (out) => `${t('refused')}: ${out.answer?.error?.whatHappened ?? out.status} ${out.answer?.error?.nextSafeAction ?? ''}`.trim();
const newKey = (what) => `online-${what}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
async function post(path, body, what) {
  try {
    const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'idempotency-key': newKey(what) }, body: JSON.stringify(body) });
    const out = { ok: res.ok, status: res.status, answer: await res.json().catch(() => ({})) };
    if (out.ok) tell(true, t('done')); else tell(false, refusal(out));
    return out;
  } catch { tell(false, t('unreachable')); return { ok: false }; }
}
async function read(path) { const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store' }); if (!res.ok) throw new Error(String(res.status)); return res.json(); }

function field(labelKey, control) { const label = document.createElement('label'); const span = document.createElement('span'); span.textContent = t(labelKey); label.append(span, control); return label; }
function input(type, cls) { const i = document.createElement('input'); i.type = type; if (cls) i.className = cls; return i; }
function button(key, cls, onClick) { const b = document.createElement('button'); b.type = 'button'; b.className = `act ${cls ?? ''}`.trim(); b.textContent = t(key); b.addEventListener('click', onClick); return b; }
function row(tone, headText, stateText) {
  const li = document.createElement('li'); li.className = `row tone-${tone}`;
  const head = document.createElement('div'); head.className = 'head';
  const h = document.createElement('span'); h.className = 'headline'; h.textContent = headText;
  const s = document.createElement('span'); s.className = 'state'; s.textContent = stateText;
  head.append(h, s); li.append(head);
  return li;
}
function facts(li, items) { const f = document.createElement('div'); f.className = 'facts'; for (const x of items) { const s = document.createElement('span'); s.textContent = x; f.append(s); } li.append(f); return f; }
const shown = (v) => (v === 'not set' ? t('notSet') : v);

function paintDetails() {
  const d = view.details;
  el('details').replaceChildren(...(d === null ? [] : DETAIL_KEYS.flatMap((k) => {
    const dt = document.createElement('dt'); dt.textContent = t(k);
    const dd = document.createElement('dd'); dd.dataset.field = k; dd.textContent = shown(d.details[k]);
    if (d.details[k] === 'not set') dd.className = 'unset';
    return [dt, dd];
  })));
  el('store-state').textContent = d === null ? '' : d.onlineStore.published !== null && d.onlineStore.publishable ? t('storeOpen') : `${t('storeNotOpen')} ${d.onlineStore.refusal ?? ''}`;
  el('tcs').textContent = d?.tcs ?? '';
}

function paintListings() {
  const rows = view.listings?.listings ?? [];
  el('listings').replaceChildren(...rows.map((l) => {
    const li = row(l.listed ? 'ok' : l.publishable ? 'idle' : 'error', `${l.name} (${l.productId})`, l.listed ? t('listed') : t('notListed'));
    li.dataset.product = l.productId;
    facts(li, l.publishable ? [t('publishable')] : [l.refusal, `${t('missing')}: ${l.missing.join(', ')}`]);
    const form = document.createElement('form');
    if (l.listed) {
      const why = input('text', 'reason');
      form.append(field('withdrawReason', why), button('withdraw', 'quiet withdraw', async () => {
        if (why.value.trim() === '') { tell(false, t('needReason')); return; }
        await post(`/v1/online-store/listings/${encodeURIComponent(l.productId)}`, { action: 'withdraw', reason: why.value.trim() }, `withdraw-${l.productId}`); await refresh();
      }));
    } else {
      form.append(button('publish', 'publish', async () => { await post(`/v1/online-store/listings/${encodeURIComponent(l.productId)}`, { action: 'publish' }, `publish-${l.productId}`); await refresh(); }));
    }
    li.append(form);
    return li;
  }));
}

function paintComplaints() {
  const c = view.complaints;
  el('complaints-say').textContent = c === null ? '' : c.count === 0 ? t('noComplaints') : c.detail;
  el('complaints').replaceChildren(...(c?.complaints ?? []).map((x) => {
    const li = row(x.ownerException ? 'error' : x.state === 'acknowledgement_overdue' ? 'degraded' : x.state === 'resolved' ? 'ok' : 'idle', x.caseId, t(x.state));
    li.dataset.case = x.caseId; li.dataset.state = x.state;
    facts(li, [`${t('ack')}: ${x.acknowledgeBy}`, `${t('resolveBy')}: ${x.resolveBy}`, ...(x.ownerException ? [t('ownerException')] : [])]);
    return li;
  }));
}

function paintReturns() {
  const r = view.returns;
  const p = r?.policy;
  const windows = p === undefined ? {} : p.windowDaysByCategory;
  el('policy-say').textContent = p === undefined ? '' : Object.keys(windows).length === 0 && p.nonReturnable === 'not set' ? t('policyNotSet')
    : `${t('policyIs')} ${Object.keys(windows).length === 0 ? t('notSet') : Object.entries(windows).map(([k, v]) => `${k} ${v}`).join(', ')}. ${t('listIs')} ${p.nonReturnable === 'not set' ? t('notSet') : p.nonReturnable.length === 0 ? t('none') : p.nonReturnable.join(', ')}.`;
  el('returns').replaceChildren(...(r?.returns ?? []).map((x) => {
    const li = row(STAGE_TONE[x.stage] ?? 'idle', `${x.returnId} — ${x.orderId}`, t(STAGE_WORD[x.stage] ?? x.stage));
    li.dataset.return = x.returnId; li.dataset.stage = x.stage;
    facts(li, x.lines.map((l) => `${l.productId}: ${l.requestedMinor}${l.receivedMinor === undefined ? '' : ` → ${l.receivedMinor}`}${l.disposition === undefined ? '' : ` (${t(l.disposition)})`}`));
    const form = document.createElement('form');
    const act = (path, body, what) => async () => { await post(`/v1/online-returns/${encodeURIComponent(x.returnId)}/${path}`, body(), what); await refresh(); };
    if (x.stage === 'requested' || x.stage === 'collection_scheduled') {
      const on = input('date', 'collect-on');
      form.append(field('collectOn', on), button('book', 'quiet book', act('collection', () => ({ collectOn: on.value }), `book-${x.returnId}`)));
    }
    if (x.stage === 'collection_scheduled') form.append(button('collected', 'quiet collected', act('collected', () => ({}), `collected-${x.returnId}`)));
    if (x.stage === 'collected') {
      const counts = x.lines.map((l) => { const n = input('number', 'count'); n.min = '0'; n.max = String(l.requestedMinor); n.value = String(l.requestedMinor); n.dataset.product = l.productId; form.append(field('counted', n)); return n; });
      form.append(button('receive', 'quiet receive', act('received', () => ({ lines: counts.map((n) => ({ productId: n.dataset.product, receivedMinor: Number(n.value) })) }), `receive-${x.returnId}`)));
    }
    if (x.receivedAt !== undefined) {
      for (const l of x.lines.filter((y) => (y.receivedMinor ?? 0) > 0 && y.disposition === undefined)) {
        const pick = document.createElement('select'); pick.className = 'disposition'; pick.dataset.product = l.productId;
        for (const d of ['sellable', 'quarantine', 'waste']) { const o = document.createElement('option'); o.value = d; o.textContent = t(d); pick.append(o); }
        const why = input('text', 'disp-reason');
        form.append(field('dispose', pick), field('dispReason', why), button('setDisposition', 'quiet dispose', act(`lines/${encodeURIComponent(l.productId)}/disposition`, () => ({ disposition: pick.value, ...(why.value.trim() === '' ? {} : { reason: why.value.trim() }) }), `dispose-${x.returnId}-${l.productId}`)));
      }
      if (x.lines.some((y) => (y.receivedMinor ?? 0) > 0 && y.refundId === undefined)) {
        const rid = input('text', 'refund-id'); const aid = input('text', 'approval-id');
        form.append(field('refundId', rid), field('approvalId', aid), button('refund', 'refund', act('refund', () => ({ refundId: rid.value.trim(), ...(aid.value.trim() === '' ? {} : { approvalId: aid.value.trim() }) }), `refund-${x.returnId}`)));
      }
    }
    if (form.childElementCount > 0) li.append(form);
    return li;
  }));
  if ((r?.returns ?? []).length === 0 && r !== null) { const li = document.createElement('li'); li.className = 'row'; li.textContent = t('noReturns'); el('returns').append(li); }
}

function paint() {
  el('title').textContent = t('title'); el('lead').textContent = t('lead'); el('lang').textContent = t('langName');
  el('whoami').textContent = window.onlineStoreData?.userId ?? '';
  el('h-details').textContent = t('hDetails'); el('h-listings').textContent = t('hListings'); el('h-complaints').textContent = t('hComplaints'); el('h-returns').textContent = t('hReturns');
  for (const k of DETAIL_KEYS) el(`l-${k}`).textContent = t(k);
  el('l-reason').textContent = t('reason'); el('save-details').textContent = t('save'); el('publish-store').textContent = t('publishStore');
  el('l-windows').textContent = t('windows'); el('l-nonreturnable').textContent = t('nonReturnable'); el('l-preason').textContent = t('policyReason'); el('save-policy').textContent = t('save');
  el('state').hidden = !view.readFailed; el('state').textContent = view.readFailed ? t('cannotRead') : '';
  paintDetails(); paintListings(); paintComplaints(); paintReturns();
}

async function refresh() {
  try {
    const [details, listings, complaints, returns] = await Promise.all([read('/v1/online-store/details'), read('/v1/online-store/listings'), read('/v1/online-store/complaints'), read('/v1/online-returns')]);
    view = { details, listings, complaints, returns, readFailed: false };
  } catch {
    view = { details: null, listings: null, complaints: null, returns: null, readFailed: true };
  }
  paint();
}

el('details-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const reason = el('d-reason').value.trim();
  if (reason === '') { tell(false, t('needReason')); return; }
  const body = { reason };
  for (const k of DETAIL_KEYS) { const v = el(`d-${k}`).value.trim(); if (v !== '') body[k] = v; }
  const out = await post('/v1/online-store/details', body, 'details');
  if (out.ok) for (const k of [...DETAIL_KEYS, 'reason']) el(`d-${k}`).value = '';
  await refresh();
});
el('publish-store').addEventListener('click', async () => { await post('/v1/online-store/publish', {}, 'publish-store'); await refresh(); });
el('policy-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const reason = el('p-reason').value.trim();
  if (reason === '') { tell(false, t('needReason')); return; }
  const windowDaysByCategory = {};
  for (const part of el('p-windows').value.split(',').map((s) => s.trim()).filter((s) => s !== '')) {
    const [k, v] = part.split('=').map((s) => s.trim());
    windowDaysByCategory[k] = Number(v);
  }
  // Blank leaves the list "not set"; the word "none" says, on purpose, that every product may be returned.
  const typed = el('p-nonreturnable').value.trim();
  const list = typed === '' ? undefined : typed.toLowerCase() === 'none' ? [] : typed.split(',').map((s) => s.trim()).filter((s) => s !== '');
  await post('/v1/online-returns/policy', { windowDaysByCategory, ...(list === undefined ? {} : { nonReturnable: list }), reason }, 'policy');
  await refresh();
});
el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
void refresh();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
