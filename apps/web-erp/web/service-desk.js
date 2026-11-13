// Customer cases — the service desk's THIN CLIENT (WF-17 · M21-FR-03/04 · A05 · P-05 · hard rule 5).
//
// It holds no rule. Every case, SLA clock, draft, decision and root cause is head office's, read live from /v1/service
// under the signed-in person's own session; every act (open, ask the assistant, approve, send, resolve, record a root
// cause) is a POST the cloud re-checks against that person's permissions. The assistant only DRAFTS: its words appear
// as a draft a named person approves, edits or rejects, and only a person sends the approved words — by phone, in
// person or by email (no SMS/WhatsApp provider is connected; the server refuses those by name). Each POST carries its
// own idempotency key, so a double click is one act. Every word has a Tamil twin and follows the one language toggle.

const $ = (id) => document.getElementById(id);

// ── U2 (UI/UX gap audit G5 · P-07): a thing is PICKED by name through the chrome's picker, never typed as a code ───────
// The field keeps the id the page sends (the typed code stays possible when the list cannot be read — head office down,
// no right — so the form is never a dead end, P-01 · P-08); the chrome's sheet finds it by name, code or barcode and the
// name is shown beside the field. Mounted when the chrome is there (a page that paints first listens for `sre:chrome`).
const pickWords = {
  en: { choose: 'Choose…', pickProduct: 'Which product?', pickPlace: 'Which place in the store?', pickPerson: 'Which person?', pickStore: 'Which store?', pickCustomer: 'Which customer?', pickApproval: 'Which approval?' },
  ta: { choose: 'தேர்ந்தெடு…', pickProduct: 'எந்தப் பொருள்?', pickPlace: 'கடையில் எந்த இடம்?', pickPerson: 'எந்த நபர்?', pickStore: 'எந்தக் கடை?', pickCustomer: 'எந்த வாடிக்கையாளர்?', pickApproval: 'எந்த அனுமதி?' },
};
const pickRepaints = [];
const repaintPickers = () => { for (const f of pickRepaints) f(); };
function pickable(inputId, kind, titleKey, extra = {}) {
  // U5: the chrome's own adapter (`sreOffice.pickable`, U2's page copy folded into the chrome) — "Choose…" beside the
  // page's input, the id in the input, the name beside it, the typed code kept, the label following the toggle.
  const office = window.sreOffice;
  if (!office || typeof office.pickable !== 'function') { document.addEventListener('sre:chrome', () => pickable(inputId, kind, titleKey, extra), { once: true }); return; }
  office.pickable(inputId, kind, { en: pickWords.en[titleKey], ta: pickWords.ta[titleKey] }, extra);
}
const who = window.serviceDeskData && typeof window.serviceDeskData === 'object' ? window.serviceDeskData : null;
const perms = new Set(Array.isArray(who?.permissions) ? who.permissions : []);
const mayAct = perms.has('service.case.manage');

const WORDS = {
  en: {
    title: 'Customer cases', casesH: 'Open and recent cases', casesLede: 'Breaching cases first. Pick one to work it.',
    case: 'Case', kind: 'Kind', priority: 'Priority', state: 'State', first: 'First reply', resolution: 'Resolution',
    openH: 'Open a case', caseNo: 'Case (its reference is given by the shop)', customer: 'Customer', order: 'Order (optional)', said: 'What the customer said', openCase: 'Open the case',
    complaint: 'Complaint', enquiry: 'Enquiry', warranty: 'Warranty', lost_and_found: 'Lost and found',
    low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent',
    open: 'open', waiting_on_customer: 'waiting on the customer', resolved: 'resolved', closed: 'closed',
    within: 'within time', at_risk: 'at risk', breached: 'breached', met: 'met', paused: 'paused',
    caseH: 'Case', firstClock: 'First reply', resolutionClock: 'Resolution', aboutOrder: 'about order', openedAt: 'opened',
    draftsH: 'Reply', draftsLede: 'The assistant drafts from the case\'s own records. Nothing reaches the customer until a person approves it and a person sends it.',
    askNote: 'A note for the assistant (optional)', askDraft: 'Ask the assistant for a reply',
    drafted: 'The assistant drafted a reply — read it, then approve, edit or reject it.', notDrafted: 'The assistant did not draft a reply:',
    stopped: 'The assistant is switched off or out of budget — write the reply yourself.',
    noPricing: 'The assistant cannot run: no model pricing is set for this shop yet — write the reply yourself.',
    // OB-561 (owner, 31 Oct 2026): live AI stays off until Release 8 (OB-382) — the plain reason, before any technical one.
    offUntilR8: 'The assistants are off until Release 8 — the owner decided this on 31 October 2026. No reply is drafted by an assistant yet; write the reply yourself.',
    draftBy: 'Drafted by the assistant from', records: 'record(s)', notDecided: 'Waiting for a person to decide.',
    approve: 'Approve', editApprove: 'Edit and approve', reject: 'Reject', editLabel: 'Your words (edit before approving)',
    approvedBy: 'Approved by', rejectedBy: 'Rejected by', send: 'Send it', channel: 'How you reached the customer',
    phone: 'Phone', in_person: 'In person', email: 'Email', sentBy: 'Sent by', via: 'by',
    reachedBy: 'How the customer reached us', notSaid: 'Not said', approveSend: 'Approve and send by', cameBy: 'came by',
    resolveH: 'Resolve', resolutionL: 'How it was resolved', resolve: 'Resolve the case',
    rcH: 'Root cause', rcLede: 'Why it happened, once it is resolved — so it does not happen again.', rcCause: 'Cause', rcNote: 'What happened', rcPrevent: 'What will stop it (optional)', rcSave: 'Record the root cause',
    summaryH: 'Why cases happen', summaryLede: 'Resolved cases by root cause — and the resolved ones nobody has explained yet.',
    noRootCause: 'Resolved with no root cause yet:', allExplained: 'Every resolved case has a root cause.', noneResolved: 'No case has been resolved yet, so there is no root cause to record.', cases: 'case(s)', complaints: 'complaint(s)',
    reportH: 'How the service is doing — every case', reportLede: 'Head office\'s count across all cases: how many were dealt with in time, which are late and must go up now, and what customers said.',
    rCases: 'Cases', rResolved: 'resolved', rMet: 'resolved within time', rBreached: 'past their time', rFirst: 'Not answered in time (first reply)',
    rEscalate: 'Late and still open — escalate now:', rNothingToEscalate: 'No open case is past its time.', rCsat: 'Satisfaction (out of 5)', rOfCases: 'of cases replied',
    rNoCsat: 'No customer has rated a case yet — there is no satisfaction score.', rUnreachable: 'The service report could not be read from head office.',
    done: 'Done.', refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.',
    nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.', readOnly: 'You may read the cases; working them needs the service-desk role.',
    none: 'No cases yet — head office holds no case for this shop.', loading: 'Reading the cases from head office…',
    product_quality: 'Product quality', stock_availability: 'Out of stock', pricing_or_billing: 'Price or bill', delivery: 'Delivery', staff_conduct: 'Staff conduct', store_process: 'Store process', system_or_app: 'System or app', customer_misunderstanding: 'Customer misunderstanding', other: 'Other',
  },
  ta: {
    title: 'வாடிக்கையாளர் வழக்குகள்', casesH: 'திறந்த மற்றும் சமீபத்திய வழக்குகள்', casesLede: 'காலம் மீறியவை முதலில். ஒன்றைத் தேர்ந்தெடுத்து வேலை செய்யுங்கள்.',
    case: 'வழக்கு', kind: 'வகை', priority: 'முன்னுரிமை', state: 'நிலை', first: 'முதல் பதில்', resolution: 'தீர்வு',
    openH: 'வழக்கைத் திற', caseNo: 'வழக்கு (அதன் குறிப்பு கடை வழங்கியது)', customer: 'வாடிக்கையாளர்', order: 'ஆர்டர் (விருப்பம்)', said: 'வாடிக்கையாளர் சொன்னது', openCase: 'வழக்கைத் திற',
    complaint: 'புகார்', enquiry: 'விசாரணை', warranty: 'உத்தரவாதம்', lost_and_found: 'தொலைந்ததும் கண்டெடுத்ததும்',
    low: 'குறைவு', normal: 'சாதாரணம்', high: 'அதிகம்', urgent: 'அவசரம்',
    open: 'திறந்துள்ளது', waiting_on_customer: 'வாடிக்கையாளருக்காகக் காத்திருக்கிறது', resolved: 'தீர்ந்தது', closed: 'மூடப்பட்டது',
    within: 'நேரத்திற்குள்', at_risk: 'ஆபத்தில்', breached: 'மீறப்பட்டது', met: 'நிறைவேறியது', paused: 'இடைநிறுத்தம்',
    caseH: 'வழக்கு', firstClock: 'முதல் பதில்', resolutionClock: 'தீர்வு', aboutOrder: 'ஆர்டர் பற்றி', openedAt: 'திறந்தது',
    draftsH: 'பதில்', draftsLede: 'உதவியாளர் வழக்கின் சொந்தப் பதிவுகளிலிருந்து வரைகிறார். ஒருவர் ஒப்புதல் அளித்து, ஒருவர் அனுப்பும் வரை வாடிக்கையாளருக்கு எதுவும் செல்லாது.',
    askNote: 'உதவியாளருக்கு ஒரு குறிப்பு (விருப்பம்)', askDraft: 'உதவியாளரிடம் பதில் கேள்',
    drafted: 'உதவியாளர் ஒரு பதிலை வரைந்துள்ளார் — படித்து, ஒப்புதல், திருத்தம் அல்லது நிராகரிப்பு செய்யுங்கள்.', notDrafted: 'உதவியாளர் பதில் வரையவில்லை:',
    stopped: 'உதவியாளர் நிறுத்தப்பட்டுள்ளார் அல்லது செலவு வரம்பு தீர்ந்தது — பதிலை நீங்களே எழுதுங்கள்.',
    noPricing: 'உதவியாளரை இயக்க முடியாது: இந்தக் கடைக்கு மாதிரி விலை (model pricing) இன்னும் அமைக்கப்படவில்லை — பதிலை நீங்களே எழுதுங்கள்.',
    offUntilR8: 'உதவியாளர்கள் வெளியீடு 8 வரை அணைக்கப்பட்டுள்ளனர் — இது 31 அக்டோபர் 2026 அன்று உரிமையாளர் எடுத்த முடிவு. இப்போது எந்தப் பதிலையும் உதவியாளர் வரைவதில்லை; பதிலை நீங்களே எழுதுங்கள்.',
    draftBy: 'உதவியாளர் வரைந்தது — ஆதாரம்', records: 'பதிவு(கள்)', notDecided: 'ஒருவர் முடிவு செய்யக் காத்திருக்கிறது.',
    approve: 'ஒப்புதல்', editApprove: 'திருத்தி ஒப்புதல்', reject: 'நிராகரி', editLabel: 'உங்கள் வார்த்தைகள் (ஒப்புதலுக்கு முன் திருத்துங்கள்)',
    approvedBy: 'ஒப்புதல் அளித்தவர்', rejectedBy: 'நிராகரித்தவர்', send: 'அனுப்பு', channel: 'வாடிக்கையாளரை எப்படித் தொடர்பு கொண்டீர்கள்',
    phone: 'தொலைபேசி', in_person: 'நேரில்', email: 'மின்னஞ்சல்', sentBy: 'அனுப்பியவர்', via: 'வழியாக',
    reachedBy: 'வாடிக்கையாளர் எப்படித் தொடர்பு கொண்டார்', notSaid: 'சொல்லப்படவில்லை', approveSend: 'ஒப்புதல் அளித்து அனுப்பு —', cameBy: 'வந்த வழி',
    resolveH: 'தீர்வு', resolutionL: 'எப்படித் தீர்க்கப்பட்டது', resolve: 'வழக்கைத் தீர்',
    rcH: 'மூல காரணம்', rcLede: 'தீர்ந்த பிறகு, ஏன் நடந்தது — மீண்டும் நடக்காமல் இருக்க.', rcCause: 'காரணம்', rcNote: 'என்ன நடந்தது', rcPrevent: 'எது தடுக்கும் (விருப்பம்)', rcSave: 'மூல காரணத்தைப் பதிவு செய்',
    summaryH: 'வழக்குகள் ஏன் நடக்கின்றன', summaryLede: 'மூல காரணப்படி தீர்ந்த வழக்குகள் — விளக்கப்படாதவையும்.',
    noRootCause: 'மூல காரணம் இல்லாமல் தீர்ந்தவை:', allExplained: 'தீர்ந்த ஒவ்வொரு வழக்கிற்கும் மூல காரணம் உள்ளது.', noneResolved: 'இன்னும் எந்த வழக்கும் தீர்க்கப்படவில்லை, எனவே பதிவு செய்ய மூல காரணம் எதுவும் இல்லை.', cases: 'வழக்கு(கள்)', complaints: 'புகார்(கள்)',
    reportH: 'சேவை எப்படி உள்ளது — எல்லா வழக்குகளும்', reportLede: 'எல்லா வழக்குகளிலும் தலைமை அலுவலகத்தின் கணக்கு: நேரத்தில் தீர்ந்தவை எத்தனை, தாமதமாகி இப்போதே மேலே அனுப்ப வேண்டியவை எவை, வாடிக்கையாளர்கள் என்ன சொன்னார்கள்.',
    rCases: 'வழக்குகள்', rResolved: 'தீர்ந்தவை', rMet: 'நேரத்திற்குள் தீர்ந்தவை', rBreached: 'நேரம் மீறியவை', rFirst: 'நேரத்தில் பதில் இல்லாதவை (முதல் பதில்)',
    rEscalate: 'தாமதமாகி இன்னும் திறந்துள்ளவை — இப்போதே மேலே அனுப்புங்கள்:', rNothingToEscalate: 'நேரம் மீறிய திறந்த வழக்கு எதுவும் இல்லை.', rCsat: 'திருப்தி (5-க்கு)', rOfCases: 'வழக்குகளில் பதில் வந்தவை',
    rNoCsat: 'இன்னும் எந்த வாடிக்கையாளரும் மதிப்பிடவில்லை — திருப்தி மதிப்பெண் இல்லை.', rUnreachable: 'சேவை அறிக்கையைத் தலைமை அலுவலகத்திலிருந்து படிக்க முடியவில்லை.',
    done: 'முடிந்தது.', refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.', readOnly: 'நீங்கள் வழக்குகளைப் படிக்கலாம்; அவற்றில் வேலை செய்ய சேவை மேசைப் பங்கு தேவை.',
    none: 'இன்னும் வழக்குகள் இல்லை — இந்தக் கடைக்கு தலைமை அலுவலகத்தில் வழக்கு எதுவும் இல்லை.', loading: 'தலைமை அலுவலகத்திலிருந்து வழக்குகளைப் படிக்கிறது…',
    product_quality: 'பொருளின் தரம்', stock_availability: 'இருப்பு இல்லை', pricing_or_billing: 'விலை அல்லது பில்', delivery: 'டெலிவரி', staff_conduct: 'ஊழியர் நடத்தை', store_process: 'கடை நடைமுறை', system_or_app: 'அமைப்பு அல்லது செயலி', customer_misunderstanding: 'வாடிக்கையாளர் தவறான புரிதல்', other: 'மற்றவை',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key] ?? key;
/** The ways a person can reply today (no SMS/WhatsApp provider is connected — head office refuses those by name). */
const CHANNELS = ['phone', 'in_person', 'email'];
const CAUSES = ['product_quality', 'stock_availability', 'pricing_or_billing', 'delivery', 'staff_conduct', 'store_process', 'system_or_app', 'customer_misunderstanding', 'other'];
const key = (what) => ((crypto.randomUUID && crypto.randomUUID()) || `${what}-${Date.now()}-${Math.random()}`);

let cases = [];
let picked = null;
let pickedSla = null;
let drafts = [];
let summary = null;
let report = null;

async function getJson(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}
/** One act at head office. Answers { ok, body } — the refusal's own words when it is refused, never a guess. */
async function post(path, body, idem) {
  try {
    const res = await fetch(path, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': idem ?? key('act') },
      body: JSON.stringify(body ?? {}),
    });
    const out = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body: out };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}
const say = (el, outcome, good) => {
  el.className = `status ${outcome.ok ? 'good' : 'err'}`;
  el.textContent = outcome.ok ? (good ?? t('done'))
    : outcome.status === 0 ? t('unreachable') : `${t('refused')} ${outcome.body?.error?.whatHappened ?? outcome.status}`;
};

function paintWords() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title', 'title'], ['off-r8', 'offUntilR8'], ['cases-h', 'casesH'], ['cases-lede', 'casesLede'],     ['open-h', 'openH'], ['l-new-id', 'caseNo'], ['l-new-kind', 'kind'], ['l-new-priority', 'priority'], ['l-new-customer', 'customer'], ['l-new-order', 'order'], ['l-new-channel', 'reachedBy'], ['o-ch-none', 'notSaid'], ['o-ch-phone', 'phone'], ['o-ch-in_person', 'in_person'], ['o-ch-email', 'email'], ['l-new-summary', 'said'], ['open-case', 'openCase'],
    ['o-complaint', 'complaint'], ['o-enquiry', 'enquiry'], ['o-warranty', 'warranty'], ['o-lost_and_found', 'lost_and_found'], ['o-low', 'low'], ['o-normal', 'normal'], ['o-high', 'high'], ['o-urgent', 'urgent'],
    ['l-first-clock', 'firstClock'], ['l-resolution-clock', 'resolutionClock'], ['drafts-h', 'draftsH'], ['drafts-lede', 'draftsLede'], ['l-ask-note', 'askNote'], ['ask-draft', 'askDraft'],
    ['resolve-h', 'resolveH'], ['l-resolution', 'resolutionL'], ['resolve', 'resolve'], ['rc-h', 'rcH'], ['rc-lede', 'rcLede'], ['l-rc-cause', 'rcCause'], ['l-rc-note', 'rcNote'], ['l-rc-prevent', 'rcPrevent'], ['rc-save', 'rcSave'],
    ['summary-h', 'summaryH'], ['summary-lede', 'summaryLede'], ['report-h', 'reportH'], ['report-lede', 'reportLede']]) {
    const el = $(id);
    if (el) el.textContent = t(k);
  }
  const sel = $('rc-cause');
  const was = sel.value;
  sel.replaceChildren(...CAUSES.map((c) => { const o = document.createElement('option'); o.value = c; o.textContent = t(c); return o; }));
  if (was) sel.value = was;
  const nobody = $('nobody');
  nobody.hidden = mayAct;
  nobody.textContent = who === null ? t('nobody') : t('readOnly');
  for (const btn of ['open-case', 'ask-draft', 'resolve', 'rc-save']) { $(btn).disabled = !mayAct; whyDisabled($(btn), mayAct ? '' : 'role'); }
  $('open-section').hidden = !mayAct;
}

const worst = (c) => (c.firstResponse?.status === 'breached' || c.resolution?.status === 'breached' ? 0 : c.firstResponse?.status === 'at_risk' || c.resolution?.status === 'at_risk' ? 1 : 2);

// U5 (G13): an SLA clock's state as the chrome's chip — the tone's shape and the word, never a coloured dot.
const SLA_TONE = { breached: 'error', at_risk: 'degraded', within: 'ok', met: 'ok', paused: 'idle' };
function slaChip(status) {
  const o = window.sreOffice;
  const words = t(status);
  if (o && typeof o.chip === 'function') return o.chip(SLA_TONE[status] ?? 'idle', words);
  const span = document.createElement('span'); span.textContent = words; return span;
}
function stateChip(state) {
  const o = window.sreOffice;
  if (o && typeof o.recordChip === 'function') return o.recordChip(state, { en: WORDS.en[state] ?? state, ta: WORDS.ta[state] ?? state });
  const span = document.createElement('span'); span.textContent = t(state); return span;
}
/** The list's state (reading / nothing / refused / unreachable) as the shared state part — never a plain line. */
let lastCasesState = null; // repainted in the reader's language on the toggle
function casesState(kind, title) {
  lastCasesState = kind === null ? null : { kind, key: { empty: 'none', loading: 'loading', offline: 'unreachable', denied: 'nobody' }[kind] };
  const host = $('cases-status'); const o = window.sreOffice;
  if (kind === null) { host.replaceChildren(); host.hidden = true; return; }
  host.hidden = false;
  if (o && typeof o.state === 'function') o.state(host, kind, { title, detail: '' }); else host.textContent = title;
}
let caseRegister = null;
function renderCases() {
  const ordered = [...cases].sort((a, b) => worst(a) - worst(b) || a.caseId.localeCompare(b.caseId));
  const o = window.sreOffice;
  const host = $('cases-register');
  if (o && typeof o.table === 'function') {
    // U5 (G17): the cases on the chrome's register — breaching first as head office orders them, searchable, sortable by any
    // column, 10 a page; a row is picked with a tap or Enter (the whole row, 44px).
    const columns = [
      { key: 'caseId', label: { en: WORDS.en.case, ta: WORDS.ta.case }, sort: 'text' },
      { key: 'kind', label: { en: WORDS.en.kind, ta: WORDS.ta.kind }, sort: 'text', filter: true, value: (c) => t(c.kind) },
      { key: 'priority', label: { en: WORDS.en.priority, ta: WORDS.ta.priority }, sort: 'text', filter: true, value: (c) => t(c.priority) },
      { key: 'state', label: { en: WORDS.en.state, ta: WORDS.ta.state }, sort: 'text', filter: true, value: (c) => t(c.state), render: (c) => stateChip(c.state) },
      { key: 'first', label: { en: WORDS.en.first, ta: WORDS.ta.first }, sort: 'text', value: (c) => t(c.firstResponse.status), render: (c) => slaChip(c.firstResponse.status) },
      { key: 'resolution', label: { en: WORDS.en.resolution, ta: WORDS.ta.resolution }, sort: 'text', value: (c) => t(c.resolution.status), render: (c) => slaChip(c.resolution.status) },
    ];
    if (caseRegister === null || !host.contains(document.getElementById('service-cases-table'))) {
      caseRegister = o.table(host, { id: 'service-cases', label: { en: WORDS.en.casesH, ta: WORDS.ta.casesH }, bodyId: 'case-rows', pageSize: 10, sortable: true, rowKey: (c) => c.caseId, rowData: (c) => ({ caseId: c.caseId }), rows: ordered, columns,
        empty: { title: { en: WORDS.en.none, ta: WORDS.ta.none }, detail: '' } });
      // the register redraws its body on every sort / page, so a row is picked through the host (which stays)
      const rowOf = (e) => e.target?.closest?.('#case-rows tr[data-case-id]');
      host.addEventListener('click', (e) => { const tr = rowOf(e); if (tr) void pick(tr.dataset.caseId); });
      host.addEventListener('keydown', (e) => { const tr = rowOf(e); if (tr && e.key === 'Enter') void pick(tr.dataset.caseId); });
    } else caseRegister.setRows(ordered);
    for (const tr of host.querySelectorAll('#case-rows tr[data-case-id]')) { tr.tabIndex = 0; tr.setAttribute('aria-selected', String(picked?.caseId === tr.dataset.caseId)); }
  }
  casesState(cases.length === 0 ? 'empty' : null, t('none'));
}

function renderCase() {
  const section = $('case-section');
  section.hidden = picked === null;
  if (picked === null) return;
  $('case-h').textContent = `${t('caseH')} ${picked.caseId}`;
  // U5 (G16): the customer's NAME beside the code, as head office's directory holds it (the code alone when it holds none).
  const customer = typeof picked.customerRef === 'string' && picked.customerRef !== '' ? ` · ${t('customer')}: ${customerNames[picked.customerRef] ? `${customerNames[picked.customerRef]} (${picked.customerRef})` : picked.customerRef}` : '';
  $('case-facts').textContent = `${t(picked.kind)} · ${t(picked.priority)} · ${t(picked.state)}${CHANNELS.includes(picked.channel) ? ` · ${t('cameBy')} ${t(picked.channel)}` : ''}${customer}`;
  for (const [id, clock] of [['first-badge', pickedSla?.firstResponse], ['resolution-badge', pickedSla?.resolution]]) {
    const b = $(id);
    b.dataset.status = clock?.status ?? '';
    if (clock === undefined) b.textContent = '…'; else b.replaceChildren(slaChip(clock.status));
  }
  const resolved = picked.state === 'resolved' || picked.state === 'closed';
  $('resolve').disabled = !mayAct || resolved; whyDisabled($('resolve'), !mayAct ? 'role' : resolved ? { en: 'This case is already resolved.', ta: 'இந்த வழக்கு ஏற்கனவே தீர்க்கப்பட்டது.' } : '');
  $('rc-save').disabled = !mayAct || !resolved; whyDisabled($('rc-save'), !mayAct ? 'role' : !resolved ? { en: 'Resolve the case first.', ta: 'முதலில் வழக்கைத் தீர்க்கவும்.' } : '');
  const list = $('draft-list');
  list.replaceChildren();
  for (const d of drafts) {
    const box = document.createElement('div');
    box.className = 'draft';
    box.dataset.draftId = d.draftId;
    const meta = document.createElement('p');
    meta.className = 'muted';
    meta.textContent = `${d.draftId} — ${t('draftBy')} ${d.evidenceCount} ${t('records')}`;
    const quote = document.createElement('blockquote');
    quote.textContent = d.decision?.text ?? d.text;
    box.append(meta, quote);
    if (d.sent) {
      const p = document.createElement('p');
      p.className = 'status good';
      p.textContent = `${t('sentBy')} ${d.sent.sentBy} ${t('via')} ${t(d.sent.channel)} · ${t('approvedBy')} ${d.sent.approvedBy}`;
      box.append(p);
    } else if (d.decision === null) {
      const p = document.createElement('p'); p.textContent = t('notDecided');
      const edit = document.createElement('textarea'); edit.value = d.text; edit.setAttribute('aria-label', t('editLabel'));
      const row = document.createElement('div'); row.className = 'row';
      const btn = (label, cls, decision) => {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = t(label); if (cls) b.className = `${cls} sre-btn`; b.disabled = !mayAct; whyDisabled(b, mayAct ? '' : 'role');
        b.addEventListener('click', async () => {
          const body = decision === 'edited_and_approved' ? { decision, finalText: edit.value } : { decision };
          const out = await post(`/v1/service/cases/${encodeURIComponent(picked.caseId)}/drafts/${encodeURIComponent(d.draftId)}/decision`, body);
          say($('draft-status'), out);
          await pick(picked.caseId);
        });
        return b;
      };
      row.append(btn('approve', '', 'approved'), btn('editApprove', 'secondary', 'edited_and_approved'), btn('reject', 'secondary', 'rejected'));
      // OB-390 · crm-service.md "open and reply to a case ≤3": when the case says how the customer reached the shop, the
      // reply goes back that way by default — one press approves the words shown (a named person, P-05) and records the
      // reply sent by that channel. Two acts at head office, each re-checked; if the send is refused the approval stands,
      // the refusal is shown, and the draft offers "Send it" with the channel to choose.
      if (CHANNELS.includes(picked.channel)) {
        const both = document.createElement('button'); both.type = 'button'; both.className = 'approve-send sre-btn'; both.disabled = !mayAct; whyDisabled(both, mayAct ? '' : 'role');
        both.textContent = `${t('approveSend')} ${t(picked.channel)}`;
        both.addEventListener('click', async () => {
          const base = `/v1/service/cases/${encodeURIComponent(picked.caseId)}/drafts/${encodeURIComponent(d.draftId)}`;
          const decided = await post(`${base}/decision`, { decision: 'approved' });
          const out = decided.ok ? await post(`${base}/send`, { channel: picked.channel }) : decided;
          say($('draft-status'), out);
          await pick(picked.caseId);
          await loadCases();
        });
        row.prepend(both);
      }
      box.append(p, edit, row);
    } else if (d.decision.sendable) {
      const p = document.createElement('p'); p.textContent = `${t('approvedBy')} ${d.decision.approvedBy}`;
      const sel = document.createElement('select'); sel.setAttribute('aria-label', t('channel'));
      for (const c of CHANNELS) { const o = document.createElement('option'); o.value = c; o.textContent = t(c); sel.append(o); }
      // OB-390: the case's own channel is chosen already; the person may still pick another.
      if (CHANNELS.includes(picked.channel)) sel.value = picked.channel;
      const b = document.createElement('button'); b.type = 'button'; b.textContent = t('send'); b.disabled = !mayAct; b.className = 'send sre-btn'; whyDisabled(b, mayAct ? '' : 'role');
      b.addEventListener('click', async () => {
        const out = await post(`/v1/service/cases/${encodeURIComponent(picked.caseId)}/drafts/${encodeURIComponent(d.draftId)}/send`, { channel: sel.value });
        say($('draft-status'), out);
        await pick(picked.caseId);
        await loadCases();
      });
      box.append(p, sel, b);
    } else {
      const p = document.createElement('p'); p.className = 'muted'; p.textContent = `${t('rejectedBy')} ${d.decision.approvedBy}`;
      box.append(p);
    }
    list.append(box);
  }
}

function renderSummary() {
  const ul = $('rc-summary');
  ul.replaceChildren();
  if (summary === null) return;
  for (const row of summary.byCause) {
    const li = document.createElement('li');
    li.textContent = `${t(row.cause)}: ${row.cases} ${t('cases')} (${row.complaints} ${t('complaints')})`;
    ul.append(li);
  }
  const missing = $('rc-missing');
  // U0 (P-08): "every resolved case has a root cause" is a claim about resolved cases — with none resolved it is not said.
  const resolved = summary.byCause.reduce((n, row) => n + Number(row.cases ?? 0), 0) + summary.resolvedWithoutRootCause.length;
  const unexplained = summary.resolvedWithoutRootCause.length > 0;
  // U5: "no case resolved yet" is the shared empty state; a finding about the resolved cases stays a status line.
  const o = window.sreOffice;
  if (!unexplained && resolved === 0 && o && typeof o.state === 'function') { missing.className = ''; o.state(missing, 'empty', { title: t('noneResolved'), detail: '' }); return; }
  missing.className = `status ${unexplained ? 'err' : 'good'}`;
  missing.textContent = unexplained ? `${t('noRootCause')} ${summary.resolvedWithoutRootCause.join(', ')}` : resolved === 0 ? t('noneResolved') : t('allExplained'); // never a claim about no cases
}

// W4 · M21-FR-04: head office's service report over every case — the figures exactly as it sends them, nothing worked out here.
function renderReport() {
  const ul = $('service-report');
  ul.replaceChildren();
  if (report === null) return;
  const line = (k, words) => { const li = document.createElement('li'); li.dataset.r = k; li.textContent = words; ul.append(li); };
  line('cases', `${t('rCases')}: ${report.cases} · ${t('rResolved')} ${report.resolved} · ${t('rMet')} ${report.met ?? 0} · ${t('rBreached')} ${report.breached}`);
  line('first', `${t('rFirst')}: ${report.firstResponseBreached}`);
  const late = Array.isArray(report.escalateNow) ? report.escalateNow : [];
  line('escalate', late.length === 0 ? t('rNothingToEscalate') : `${t('rEscalate')} ${late.join(', ')}`);
  line('csat', report.csatHundredths === 'no_responses' ? t('rNoCsat')
    : `${t('rCsat')}: ${(report.csatHundredths / 100).toFixed(2)}${report.responseRateBps === 'not_meaningful' ? '' : ` · ${(report.responseRateBps / 100).toFixed(1)}% ${t('rOfCases')}`}`);
}

async function loadReport() {
  try {
    report = await getJson('/v1/service/report');
    $('report-status').textContent = '';
  } catch {
    report = null;
    $('report-status').textContent = t('rUnreachable');
  }
  renderReport();
}

async function pick(caseId) {
  picked = cases.find((c) => c.caseId === caseId) ?? { caseId };
  try {
    const [sla, list] = await Promise.all([getJson(`/v1/service/cases/${encodeURIComponent(caseId)}/sla`), getJson(`/v1/service/cases/${encodeURIComponent(caseId)}/drafts`)]);
    pickedSla = sla;
    picked = { ...picked, state: sla.state };
    drafts = list.drafts;
  } catch {
    pickedSla = null; drafts = [];
  }
  renderCases();
  renderCase();
}

let customerNames = {};
async function loadCustomerNames() {
  try {
    const out = await getJson('/v1/customer/overview');
    const names = {};
    for (const c of Array.isArray(out?.customers) ? out.customers : []) if (typeof c.customerRef === 'string' && typeof c.name === 'string' && c.name !== '') names[c.customerRef] = c.name;
    customerNames = names;
  } catch { customerNames = {}; }
}
async function loadCases() {
  casesState('loading', t('loading'));
  void loadCustomerNames().then(() => { if (picked !== null) renderCase(); });
  try {
    cases = (await getJson('/v1/service/cases')).cases;
    summary = await getJson('/v1/service/root-causes');
  } catch {
    cases = []; summary = null;
    renderCases();
    casesState('offline', t('unreachable'));
    return;
  }
  if (picked !== null) picked = { ...picked, ...(cases.find((c) => c.caseId === picked.caseId) ?? {}) };
  renderCases();
  renderCase();
  if (mayAct && $('new-id').value.trim() === '') proposeCaseNumber();
  renderSummary();
  void loadReport();
}

/** U2: the case number is GIVEN by the page — the shop's day and the next free number in head office's own list — never
 *  typed by the desk. Head office refuses a number that exists; then the next one is proposed. */
function proposeCaseNumber() {
  // OB-606: the SHOP's day, never the UTC date of "now"; without the bundle's shop day no number is proposed (the open refuses).
  const shopDay = window.sreShopDay && typeof window.sreShopDay.today === 'function' ? window.sreShopDay.today() : null;
  if (shopDay === null) return;
  const day = shopDay.replace(/-/g, '');
  const prefix = `C-${day}-`;
  const taken = new Set(cases.map((c) => c.caseId));
  let n = 1;
  while (taken.has(`${prefix}${String(n).padStart(3, '0')}`)) n += 1;
  $('new-id').value = `${prefix}${String(n).padStart(3, '0')}`;
}

$('open-case').addEventListener('click', async () => {
  if ($('new-id').value.trim() === '') proposeCaseNumber();
  const caseId = $('new-id').value.trim();
  const body = { kind: $('new-kind').value, priority: $('new-priority').value, customerRef: $('new-customer').value.trim(), summary: $('new-summary').value.trim(), assignedTo: who?.userId ?? '' };
  const orderRef = $('new-order').value.trim();
  const channel = $('new-channel').value;
  const out = await post(`/v1/service/cases/${encodeURIComponent(caseId)}`, { ...body, ...(orderRef === '' ? {} : { orderRef }), ...(channel === '' ? {} : { channel }) });
  say($('open-status'), out);
  if (out.ok) { await loadCases(); await pick(caseId); $('new-id').value = ''; proposeCaseNumber(); }
  else if (out.status === 409) { $('new-id').value = ''; proposeCaseNumber(); }
});
// U2: the customer is picked by name; the number is proposed, never typed.
pickable('new-customer', 'customer', 'pickCustomer', { idOf: (p) => String(p.id ?? '') });

$('ask-draft').addEventListener('click', async () => {
  if (picked === null) return;
  const note = $('ask-note').value.trim();
  const draftId = `d-${Date.now().toString(36)}`;
  const out = await post(`/v1/service/cases/${encodeURIComponent(picked.caseId)}/ai-drafts`, note === '' ? { draftId } : { draftId, note });
  const el = $('draft-status');
  if (out.ok && out.body?.drafted === true) say(el, out, t('drafted'));
  else if (out.ok) { el.className = 'status err'; el.textContent = `${t('notDrafted')} ${out.body?.detail ?? ''}`; }
  // Round B: no model pricing set for this shop is said as that, not as "switched off or out of budget".
  // OB-561: the plain reason first — the assistants are off until Release 8 — then head office's technical one.
  else if (out.status === 503 || out.status === 429) { el.className = 'status err'; el.textContent = `${t('offUntilR8')} ${out.body?.error?.code === 'no_pricing' ? t('noPricing') : t('stopped')}`; }
  else say(el, out);
  await pick(picked.caseId);
});

$('resolve').addEventListener('click', async () => {
  if (picked === null) return;
  const out = await post(`/v1/service/cases/${encodeURIComponent(picked.caseId)}/resolution`, { resolution: $('resolution').value.trim() });
  say($('resolve-status'), out);
  await loadCases();
  await pick(picked.caseId);
});

$('rc-save').addEventListener('click', async () => {
  if (picked === null) return;
  const prevent = $('rc-prevent').value.trim();
  const body = { cause: $('rc-cause').value, note: $('rc-note').value.trim(), ...(prevent === '' ? {} : { preventiveAction: prevent }) };
  const out = await post(`/v1/service/cases/${encodeURIComponent(picked.caseId)}/root-cause`, body);
  say($('rc-status'), out);
  await loadCases();
});

// The one language toggle (the chrome paints its label): every word on the page follows, the data does not change.
$('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintWords();
  const was = lastCasesState;
  renderCases();
  if (was !== null && was.kind !== 'empty') casesState(was.kind, t(was.key)); // a "reading…" / "cannot be reached" line follows the toggle
  renderCase();
  renderSummary();
  repaintPickers();
  renderReport();
});

paintWords();
if (who !== null) void loadCases();
else casesState('denied', t('nobody'));

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
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
