// Customer cases — the service desk's THIN CLIENT (WF-17 · M21-FR-03/04 · A05 · P-05 · hard rule 5).
//
// It holds no rule. Every case, SLA clock, draft, decision and root cause is head office's, read live from /v1/service
// under the signed-in person's own session; every act (open, ask the assistant, approve, send, resolve, record a root
// cause) is a POST the cloud re-checks against that person's permissions. The assistant only DRAFTS: its words appear
// as a draft a named person approves, edits or rejects, and only a person sends the approved words — by phone, in
// person or by email (no SMS/WhatsApp provider is connected; the server refuses those by name). Each POST carries its
// own idempotency key, so a double click is one act. Every word has a Tamil twin and follows the one language toggle.

const $ = (id) => document.getElementById(id);
const who = window.serviceDeskData && typeof window.serviceDeskData === 'object' ? window.serviceDeskData : null;
const perms = new Set(Array.isArray(who?.permissions) ? who.permissions : []);
const mayAct = perms.has('service.case.manage');

const WORDS = {
  en: {
    title: 'Customer cases', casesH: 'Open and recent cases', casesLede: 'Breaching cases first. Pick one to work it.',
    case: 'Case', kind: 'Kind', priority: 'Priority', state: 'State', first: 'First reply', resolution: 'Resolution',
    openH: 'Open a case', caseNo: 'Case number', customer: 'Customer code', order: 'Order (optional)', said: 'What the customer said', openCase: 'Open the case',
    complaint: 'Complaint', enquiry: 'Enquiry', warranty: 'Warranty', lost_and_found: 'Lost and found',
    low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent',
    open: 'open', waiting_on_customer: 'waiting on the customer', resolved: 'resolved', closed: 'closed',
    within: 'within time', at_risk: 'at risk', breached: 'breached', met: 'met', paused: 'paused',
    caseH: 'Case', firstClock: 'First reply', resolutionClock: 'Resolution', aboutOrder: 'about order', openedAt: 'opened',
    draftsH: 'Reply', draftsLede: 'The assistant drafts from the case\'s own records. Nothing reaches the customer until a person approves it and a person sends it.',
    askNote: 'A note for the assistant (optional)', askDraft: 'Ask the assistant for a reply',
    drafted: 'The assistant drafted a reply — read it, then approve, edit or reject it.', notDrafted: 'The assistant did not draft a reply:',
    stopped: 'The assistant is switched off or out of budget — write the reply yourself.',
    draftBy: 'Drafted by the assistant from', records: 'record(s)', notDecided: 'Waiting for a person to decide.',
    approve: 'Approve', editApprove: 'Edit and approve', reject: 'Reject', editLabel: 'Your words (edit before approving)',
    approvedBy: 'Approved by', rejectedBy: 'Rejected by', send: 'Send it', channel: 'How you reached the customer',
    phone: 'Phone', in_person: 'In person', email: 'Email', sentBy: 'Sent by', via: 'by',
    resolveH: 'Resolve', resolutionL: 'How it was resolved', resolve: 'Resolve the case',
    rcH: 'Root cause', rcLede: 'Why it happened, once it is resolved — so it does not happen again.', rcCause: 'Cause', rcNote: 'What happened', rcPrevent: 'What will stop it (optional)', rcSave: 'Record the root cause',
    summaryH: 'Why cases happen', summaryLede: 'Resolved cases by root cause — and the resolved ones nobody has explained yet.',
    noRootCause: 'Resolved with no root cause yet:', allExplained: 'Every resolved case has a root cause.', cases: 'case(s)', complaints: 'complaint(s)',
    done: 'Done.', refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.',
    nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.', readOnly: 'You may read the cases; working them needs the service-desk role.',
    none: 'No cases yet.', loading: 'Reading the cases from head office…',
    product_quality: 'Product quality', stock_availability: 'Out of stock', pricing_or_billing: 'Price or bill', delivery: 'Delivery', staff_conduct: 'Staff conduct', store_process: 'Store process', system_or_app: 'System or app', customer_misunderstanding: 'Customer misunderstanding', other: 'Other',
  },
  ta: {
    title: 'வாடிக்கையாளர் வழக்குகள்', casesH: 'திறந்த மற்றும் சமீபத்திய வழக்குகள்', casesLede: 'காலம் மீறியவை முதலில். ஒன்றைத் தேர்ந்தெடுத்து வேலை செய்யுங்கள்.',
    case: 'வழக்கு', kind: 'வகை', priority: 'முன்னுரிமை', state: 'நிலை', first: 'முதல் பதில்', resolution: 'தீர்வு',
    openH: 'வழக்கைத் திற', caseNo: 'வழக்கு எண்', customer: 'வாடிக்கையாளர் குறியீடு', order: 'ஆர்டர் (விருப்பம்)', said: 'வாடிக்கையாளர் சொன்னது', openCase: 'வழக்கைத் திற',
    complaint: 'புகார்', enquiry: 'விசாரணை', warranty: 'உத்தரவாதம்', lost_and_found: 'தொலைந்ததும் கண்டெடுத்ததும்',
    low: 'குறைவு', normal: 'சாதாரணம்', high: 'அதிகம்', urgent: 'அவசரம்',
    open: 'திறந்துள்ளது', waiting_on_customer: 'வாடிக்கையாளருக்காகக் காத்திருக்கிறது', resolved: 'தீர்ந்தது', closed: 'மூடப்பட்டது',
    within: 'நேரத்திற்குள்', at_risk: 'ஆபத்தில்', breached: 'மீறப்பட்டது', met: 'நிறைவேறியது', paused: 'இடைநிறுத்தம்',
    caseH: 'வழக்கு', firstClock: 'முதல் பதில்', resolutionClock: 'தீர்வு', aboutOrder: 'ஆர்டர் பற்றி', openedAt: 'திறந்தது',
    draftsH: 'பதில்', draftsLede: 'உதவியாளர் வழக்கின் சொந்தப் பதிவுகளிலிருந்து வரைகிறார். ஒருவர் ஒப்புதல் அளித்து, ஒருவர் அனுப்பும் வரை வாடிக்கையாளருக்கு எதுவும் செல்லாது.',
    askNote: 'உதவியாளருக்கு ஒரு குறிப்பு (விருப்பம்)', askDraft: 'உதவியாளரிடம் பதில் கேள்',
    drafted: 'உதவியாளர் ஒரு பதிலை வரைந்துள்ளார் — படித்து, ஒப்புதல், திருத்தம் அல்லது நிராகரிப்பு செய்யுங்கள்.', notDrafted: 'உதவியாளர் பதில் வரையவில்லை:',
    stopped: 'உதவியாளர் நிறுத்தப்பட்டுள்ளார் அல்லது செலவு வரம்பு தீர்ந்தது — பதிலை நீங்களே எழுதுங்கள்.',
    draftBy: 'உதவியாளர் வரைந்தது — ஆதாரம்', records: 'பதிவு(கள்)', notDecided: 'ஒருவர் முடிவு செய்யக் காத்திருக்கிறது.',
    approve: 'ஒப்புதல்', editApprove: 'திருத்தி ஒப்புதல்', reject: 'நிராகரி', editLabel: 'உங்கள் வார்த்தைகள் (ஒப்புதலுக்கு முன் திருத்துங்கள்)',
    approvedBy: 'ஒப்புதல் அளித்தவர்', rejectedBy: 'நிராகரித்தவர்', send: 'அனுப்பு', channel: 'வாடிக்கையாளரை எப்படித் தொடர்பு கொண்டீர்கள்',
    phone: 'தொலைபேசி', in_person: 'நேரில்', email: 'மின்னஞ்சல்', sentBy: 'அனுப்பியவர்', via: 'வழியாக',
    resolveH: 'தீர்வு', resolutionL: 'எப்படித் தீர்க்கப்பட்டது', resolve: 'வழக்கைத் தீர்',
    rcH: 'மூல காரணம்', rcLede: 'தீர்ந்த பிறகு, ஏன் நடந்தது — மீண்டும் நடக்காமல் இருக்க.', rcCause: 'காரணம்', rcNote: 'என்ன நடந்தது', rcPrevent: 'எது தடுக்கும் (விருப்பம்)', rcSave: 'மூல காரணத்தைப் பதிவு செய்',
    summaryH: 'வழக்குகள் ஏன் நடக்கின்றன', summaryLede: 'மூல காரணப்படி தீர்ந்த வழக்குகள் — விளக்கப்படாதவையும்.',
    noRootCause: 'மூல காரணம் இல்லாமல் தீர்ந்தவை:', allExplained: 'தீர்ந்த ஒவ்வொரு வழக்கிற்கும் மூல காரணம் உள்ளது.', cases: 'வழக்கு(கள்)', complaints: 'புகார்(கள்)',
    done: 'முடிந்தது.', refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.', readOnly: 'நீங்கள் வழக்குகளைப் படிக்கலாம்; அவற்றில் வேலை செய்ய சேவை மேசைப் பங்கு தேவை.',
    none: 'இன்னும் வழக்குகள் இல்லை.', loading: 'தலைமை அலுவலகத்திலிருந்து வழக்குகளைப் படிக்கிறது…',
    product_quality: 'பொருளின் தரம்', stock_availability: 'இருப்பு இல்லை', pricing_or_billing: 'விலை அல்லது பில்', delivery: 'டெலிவரி', staff_conduct: 'ஊழியர் நடத்தை', store_process: 'கடை நடைமுறை', system_or_app: 'அமைப்பு அல்லது செயலி', customer_misunderstanding: 'வாடிக்கையாளர் தவறான புரிதல்', other: 'மற்றவை',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key] ?? key;
const CAUSES = ['product_quality', 'stock_availability', 'pricing_or_billing', 'delivery', 'staff_conduct', 'store_process', 'system_or_app', 'customer_misunderstanding', 'other'];
const key = (what) => ((crypto.randomUUID && crypto.randomUUID()) || `${what}-${Date.now()}-${Math.random()}`);

let cases = [];
let picked = null;
let pickedSla = null;
let drafts = [];
let summary = null;

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
  for (const [id, k] of [['title', 'title'], ['cases-h', 'casesH'], ['cases-lede', 'casesLede'], ['th-case', 'case'], ['th-kind', 'kind'], ['th-priority', 'priority'], ['th-state', 'state'], ['th-first', 'first'], ['th-resolution', 'resolution'],
    ['open-h', 'openH'], ['l-new-id', 'caseNo'], ['l-new-kind', 'kind'], ['l-new-priority', 'priority'], ['l-new-customer', 'customer'], ['l-new-order', 'order'], ['l-new-summary', 'said'], ['open-case', 'openCase'],
    ['o-complaint', 'complaint'], ['o-enquiry', 'enquiry'], ['o-warranty', 'warranty'], ['o-lost_and_found', 'lost_and_found'], ['o-low', 'low'], ['o-normal', 'normal'], ['o-high', 'high'], ['o-urgent', 'urgent'],
    ['l-first-clock', 'firstClock'], ['l-resolution-clock', 'resolutionClock'], ['drafts-h', 'draftsH'], ['drafts-lede', 'draftsLede'], ['l-ask-note', 'askNote'], ['ask-draft', 'askDraft'],
    ['resolve-h', 'resolveH'], ['l-resolution', 'resolutionL'], ['resolve', 'resolve'], ['rc-h', 'rcH'], ['rc-lede', 'rcLede'], ['l-rc-cause', 'rcCause'], ['l-rc-note', 'rcNote'], ['l-rc-prevent', 'rcPrevent'], ['rc-save', 'rcSave'],
    ['summary-h', 'summaryH'], ['summary-lede', 'summaryLede']]) {
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
  for (const id of ['open-case', 'ask-draft', 'resolve', 'rc-save']) $(id).disabled = !mayAct;
  $('open-section').hidden = !mayAct;
}

const worst = (c) => (c.firstResponse?.status === 'breached' || c.resolution?.status === 'breached' ? 0 : c.firstResponse?.status === 'at_risk' || c.resolution?.status === 'at_risk' ? 1 : 2);

function renderCases() {
  const body = $('case-rows');
  body.replaceChildren();
  const ordered = [...cases].sort((a, b) => worst(a) - worst(b) || a.caseId.localeCompare(b.caseId));
  for (const c of ordered) {
    const tr = document.createElement('tr');
    tr.className = 'pick';
    tr.tabIndex = 0;
    tr.dataset.caseId = c.caseId;
    tr.setAttribute('aria-selected', String(picked?.caseId === c.caseId));
    const cell = (text, cls) => { const td = document.createElement('td'); if (cls) { const b = document.createElement('span'); b.className = `badge ${cls}`; b.textContent = text; td.append(b); } else td.textContent = text; return td; };
    tr.append(cell(c.caseId), cell(t(c.kind)), cell(t(c.priority)), cell(t(c.state)), cell(t(c.firstResponse.status), c.firstResponse.status), cell(t(c.resolution.status), c.resolution.status));
    const open = () => { void pick(c.caseId); };
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    body.append(tr);
  }
  $('cases-status').textContent = cases.length === 0 ? t('none') : '';
}

function renderCase() {
  const section = $('case-section');
  section.hidden = picked === null;
  if (picked === null) return;
  $('case-h').textContent = `${t('caseH')} ${picked.caseId}`;
  $('case-facts').textContent = `${t(picked.kind)} · ${t(picked.priority)} · ${t(picked.state)}`;
  for (const [id, clock] of [['first-badge', pickedSla?.firstResponse], ['resolution-badge', pickedSla?.resolution]]) {
    const b = $(id);
    b.className = `badge ${clock?.status ?? ''}`;
    b.textContent = clock === undefined ? '…' : t(clock.status);
  }
  const resolved = picked.state === 'resolved' || picked.state === 'closed';
  $('resolve').disabled = !mayAct || resolved;
  $('rc-save').disabled = !mayAct || !resolved;
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
        const b = document.createElement('button'); b.type = 'button'; b.textContent = t(label); if (cls) b.className = cls; b.disabled = !mayAct;
        b.addEventListener('click', async () => {
          const body = decision === 'edited_and_approved' ? { decision, finalText: edit.value } : { decision };
          const out = await post(`/v1/service/cases/${encodeURIComponent(picked.caseId)}/drafts/${encodeURIComponent(d.draftId)}/decision`, body);
          say($('draft-status'), out);
          await pick(picked.caseId);
        });
        return b;
      };
      row.append(btn('approve', '', 'approved'), btn('editApprove', 'secondary', 'edited_and_approved'), btn('reject', 'secondary', 'rejected'));
      box.append(p, edit, row);
    } else if (d.decision.sendable) {
      const p = document.createElement('p'); p.textContent = `${t('approvedBy')} ${d.decision.approvedBy}`;
      const sel = document.createElement('select'); sel.setAttribute('aria-label', t('channel'));
      for (const c of ['phone', 'in_person', 'email']) { const o = document.createElement('option'); o.value = c; o.textContent = t(c); sel.append(o); }
      const b = document.createElement('button'); b.type = 'button'; b.textContent = t('send'); b.disabled = !mayAct; b.className = 'send';
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
  missing.className = `status ${summary.resolvedWithoutRootCause.length === 0 ? 'good' : 'err'}`;
  missing.textContent = summary.resolvedWithoutRootCause.length === 0 ? t('allExplained') : `${t('noRootCause')} ${summary.resolvedWithoutRootCause.join(', ')}`;
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

async function loadCases() {
  $('cases-status').textContent = t('loading');
  try {
    cases = (await getJson('/v1/service/cases')).cases;
    summary = await getJson('/v1/service/root-causes');
  } catch {
    cases = []; summary = null;
    $('cases-status').textContent = t('unreachable');
    return;
  }
  if (picked !== null) picked = { ...picked, ...(cases.find((c) => c.caseId === picked.caseId) ?? {}) };
  renderCases();
  renderCase();
  renderSummary();
}

$('open-case').addEventListener('click', async () => {
  const caseId = $('new-id').value.trim();
  const body = { kind: $('new-kind').value, priority: $('new-priority').value, customerRef: $('new-customer').value.trim(), summary: $('new-summary').value.trim(), assignedTo: who?.userId ?? '' };
  const orderRef = $('new-order').value.trim();
  const out = await post(`/v1/service/cases/${encodeURIComponent(caseId)}`, orderRef === '' ? body : { ...body, orderRef });
  say($('open-status'), out);
  if (out.ok) { await loadCases(); await pick(caseId); }
});

$('ask-draft').addEventListener('click', async () => {
  if (picked === null) return;
  const note = $('ask-note').value.trim();
  const draftId = `d-${Date.now().toString(36)}`;
  const out = await post(`/v1/service/cases/${encodeURIComponent(picked.caseId)}/ai-drafts`, note === '' ? { draftId } : { draftId, note });
  const el = $('draft-status');
  if (out.ok && out.body?.drafted === true) say(el, out, t('drafted'));
  else if (out.ok) { el.className = 'status err'; el.textContent = `${t('notDrafted')} ${out.body?.detail ?? ''}`; }
  else if (out.status === 503 || out.status === 429) { el.className = 'status err'; el.textContent = t('stopped'); }
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
  renderCases();
  renderCase();
  renderSummary();
});

paintWords();
if (who !== null) void loadCases();
else $('cases-status').textContent = t('nobody');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
