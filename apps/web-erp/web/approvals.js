// Approvals — the view layer (ADR-0024 · M02-FR-03 · §28). Every rule lives in the TESTED session model
// (apps/web-erp/src/approvals-session.ts), attached as window.approvalsSession, built on packages/ui. This file only
// draws what the session hands it: WAITING FOR YOU (each request in plain words — the action, the summary, who asked,
// why, when, the amount, exactly what will happen — with a reason box and Approve / Reject), and WHAT YOU ASKED FOR
// (each of this person's own requests with where it stands, in words). A decision runs ONLY on an explicit click,
// never on load, and always with a written reason; afterwards the inbox is read again. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: { title: 'Approvals', langName: 'தமிழ்',
      lead: 'Sample approvals. Connect the store computer to see what is waiting for you.',
      waitingHeading: 'Waiting for you', waitingCount: 'waiting for you', nothingWaiting: 'Nothing is waiting for you to approve.',
      mineHeading: 'What you asked for', nothingAsked: 'You have not asked for any approvals.',
      askedByLabel: 'Asked by', whyLabel: 'Why', whenLabel: 'When', amountLabel: 'Amount', detailsLabel: 'Exactly what will happen', aboutLabel: 'About',
      reasonLabel: 'Your reason (the person who asked will read it)', reasonPlaceholder: 'For example: checked the prices against the supplier’s letter.',
      approveBtn: 'Approve', rejectBtn: 'Reject', sampleData: 'Sample data — this is not your shop.', nobodyNamed: '' },
    ta: { title: 'அனுமதிகள்', langName: 'English',
      lead: 'மாதிரி அனுமதிகள். உங்களுக்காகக் காத்திருப்பவற்றைப் பார்க்க கடை கணினியை இணைக்கவும்.',
      waitingHeading: 'உங்களுக்காகக் காத்திருப்பவை', waitingCount: 'உங்களுக்காகக் காத்திருக்கின்றன', nothingWaiting: 'நீங்கள் அனுமதிக்க எதுவும் காத்திருக்கவில்லை.',
      mineHeading: 'நீங்கள் கேட்டவை', nothingAsked: 'நீங்கள் எந்த அனுமதியும் கேட்கவில்லை.',
      askedByLabel: 'கேட்டவர்', whyLabel: 'ஏன்', whenLabel: 'எப்போது', amountLabel: 'தொகை', detailsLabel: 'சரியாக என்ன நடக்கும்', aboutLabel: 'எதைப் பற்றி',
      reasonLabel: 'உங்கள் காரணம் (கேட்டவர் இதைப் படிப்பார்)', reasonPlaceholder: 'உதாரணம்: விநியோகஸ்தரின் கடிதத்துடன் விலைகளைச் சரிபார்த்தேன்.',
      approveBtn: 'அனுமதி', rejectBtn: 'மறு', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', nobodyNamed: '' },
  };
  const NO_LINK = {
    en: 'No connection — nothing was decided. This is a sample view.',
    ta: 'இணைப்பு இல்லை — எதுவும் முடிவு செய்யப்படவில்லை. இது மாதிரிக் காட்சி.',
  };
  const waitingRow = (l) => ({
    requestId: 'sample-areq-1', kind: 'data_import_commit',
    label: l === 'ta' ? 'மொத்த இறக்குமதியைப் பயன்படுத்துதல்' : 'Apply a bulk import',
    summary: 'Load 120 rows (Products (SKU, name, price)) as "sept-prices"', subjectRef: 'sept-prices',
    requestedBy: 'u-buyer', reason: l === 'ta' ? 'செப்டம்பர் விலைப் பட்டியல்' : 'September price list from the supplier',
    requestedAt: '', when: '', amount: null,
    details: [{ key: 'jobId', label: l === 'ta' ? 'ஏற்றத்தின் பெயர்' : 'Load name', value: 'sept-prices' }],
    status: { tone: 'degraded', icon: '…', label: l === 'ta' ? 'உங்கள் முடிவுக்காகக் காத்திருக்கிறது' : 'Waiting for your decision', announcement: '', needsAttention: true },
    approvalStatus: 'waiting',
  });
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => ({
      screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
      mayUse: true, nobodyNamed: false, waiting: [waitingRow(l)], mine: [], waitingCount: 1, asAt: null,
    }),
    decide: async () => ({ kind: 'lost_link' }),
    presentDecideOutcome: (l) => ({ tone: 'degraded', icon: '⚠', label: NO_LINK[l] ?? NO_LINK.en, announcement: NO_LINK[l] ?? NO_LINK.en, needsAttention: true }),
  };
}

let session = window.approvalsSession ?? sampleSession();
const t = (key) => session.text(lang, key);

function statusNode(status) {
  const node = document.createElement('span');
  node.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = status.icon;
  const words = document.createElement('span'); words.textContent = status.label;
  node.append(icon, words);
  node.setAttribute('aria-label', status.announcement || status.label);
  return node;
}

function fact(label, value) {
  const s = document.createElement('span');
  s.textContent = `${label}: ${value}`;
  return s;
}

/** One request — the action in plain words, the summary, the facts, and exactly what will happen. */
function requestNode(r, waitingForMe) {
  const li = document.createElement('li');
  li.className = `row tone-${r.status.tone}`;
  li.dataset.requestId = r.requestId;

  const head = document.createElement('div'); head.className = 'head';
  const headline = document.createElement('span'); headline.className = 'headline'; headline.textContent = r.label;
  head.append(headline);
  if (r.amount !== null) { const value = document.createElement('span'); value.className = 'value'; value.textContent = r.amount; head.append(value); }

  const summary = document.createElement('div'); summary.className = 'summary-line'; summary.textContent = r.summary;

  const facts = document.createElement('div'); facts.className = 'facts';
  if (waitingForMe) facts.append(fact(t('askedByLabel'), r.requestedBy));
  facts.append(fact(t('whyLabel'), r.reason));
  if (r.when) facts.append(fact(t('whenLabel'), r.when));
  if (r.amount !== null) facts.append(fact(t('amountLabel'), r.amount));
  if (r.subjectRef) facts.append(fact(t('aboutLabel'), r.subjectRef));

  li.append(head, summary, statusNode(r.status), facts);

  if (r.details.length > 0) {
    const details = document.createElement('div'); details.className = 'details';
    const dl = document.createElement('span'); dl.className = 'details-label'; dl.textContent = `${t('detailsLabel')}:`;
    details.append(dl, ...r.details.map((d) => { const kv = document.createElement('span'); kv.className = 'kv'; kv.textContent = `${d.label}: ${d.value}`; return kv; }));
    li.append(details);
  }

  if (waitingForMe) {
    const decide = document.createElement('div'); decide.className = 'decide';
    const inputId = `reason-${r.requestId}`;
    const label = document.createElement('label'); label.htmlFor = inputId; label.textContent = t('reasonLabel');
    const input = document.createElement('input'); input.type = 'text'; input.id = inputId; input.className = 'reason'; input.autocomplete = 'off'; input.maxLength = 300;
    input.placeholder = t('reasonPlaceholder');
    const buttons = document.createElement('div'); buttons.className = 'buttons';
    const approve = document.createElement('button'); approve.type = 'button'; approve.className = 'act approve'; approve.textContent = t('approveBtn'); approve.dataset.requestId = r.requestId;
    const reject = document.createElement('button'); reject.type = 'button'; reject.className = 'act reject'; reject.textContent = t('rejectBtn'); reject.dataset.requestId = r.requestId;
    // A decision is a HUMAN write that runs ONLY on this explicit click, never on load.
    approve.addEventListener('click', () => { void decide(r.requestId, 'approved', input, [approve, reject]); });
    reject.addEventListener('click', () => { void decide(r.requestId, 'rejected', input, [approve, reject]); });
    buttons.append(approve, reject);
    decide.append(label, input, buttons);
    li.append(decide);
  }
  return li;
}

function emptyRow(text) {
  const li = document.createElement('li'); li.className = 'row tone-idle';
  const s = document.createElement('span'); s.textContent = text; li.append(s);
  return li;
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.approvalsData?.userId ?? '';
  el('lang').textContent = t('langName');

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  el('waiting-count').textContent = view.waitingCount === 0 ? t('nothingWaiting') : `${view.waitingCount} ${t('waitingCount')}`;
  el('waiting-heading').textContent = t('waitingHeading');
  el('waiting').setAttribute('aria-label', t('waitingHeading'));
  // A reason being typed survives a repaint (a language switch, a re-read) — the words are the checker's, not the page's.
  const typed = new Map([...document.querySelectorAll('#waiting input.reason')].map((i) => [i.id, i.value]));
  el('waiting').replaceChildren(...view.waiting.map((r) => requestNode(r, true)));
  for (const [id, value] of typed) { const input = document.getElementById(id); if (input) input.value = value; }

  const state = el('state');
  if (view.waiting.length === 0) {
    state.hidden = false;
    state.className = `state tone-${view.screenState.tone}`;
    el('state-icon').textContent = view.screenState.icon;
    el('state-text').textContent = view.screenState.label;
    state.setAttribute('aria-label', view.screenState.announcement || view.screenState.label);
  } else {
    state.hidden = true;
  }

  const mineHeading = el('mine-heading');
  mineHeading.hidden = !view.mayUse;
  mineHeading.textContent = t('mineHeading');
  el('mine').hidden = !view.mayUse;
  el('mine').setAttribute('aria-label', t('mineHeading'));
  el('mine').replaceChildren(...(view.mine.length === 0 ? [emptyRow(t('nothingAsked'))] : view.mine.map((r) => requestNode(r, false))));
}

function paintResult(presentation) {
  const result = el('result');
  result.hidden = false;
  result.className = `result tone-${presentation.tone}`;
  el('result-icon').textContent = presentation.icon;
  el('result-text').textContent = presentation.label;
  result.setAttribute('aria-label', presentation.announcement || presentation.label);
}

// Approve or reject — ONLY from an explicit click. The session refuses a blank reason (and anything not waiting for
// this person) before any POST; the server is the gate on the rest. Afterwards the inbox is READ again (a GET), so a
// decided request leaves "Waiting for you" because head office says so — never because the page assumed it.
async function decide(requestId, decision, input, buttons) {
  for (const b of buttons) b.disabled = true;
  try {
    const outcome = await session.decide(requestId, decision, input.value);
    paintResult(session.presentDecideOutcome(lang, outcome));
    if (outcome.kind === 'needs_reason') { input.focus(); return; }
    if (outcome.kind === 'decided') input.value = '';
    if (outcome.kind !== 'lost_link' && outcome.kind !== 'nobody_named' && outcome.kind !== 'not_permitted') await refresh();
  } finally {
    for (const b of buttons) b.disabled = false;
  }
}

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });

el('sample').hidden = window.approvalsSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the live inbox (a GET — read-only). Offline or refused, the page keeps its current view and the stale strip
// already says the page is what the box last told it.
async function refresh() {
  const api = window.approvals;
  if (!api || typeof api.refresh !== 'function') return;
  const inbox = await api.refresh();
  if (inbox) { session = api.present(inbox); paint(); }
}
refresh();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
