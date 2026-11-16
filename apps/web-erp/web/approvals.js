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

// W1 (P-08): until head office has answered, this page does NOT know what is waiting — it never says "nothing is
// waiting" before it has asked. `inboxRead`: 'reading' → 'read' (head office answered) or 'unread' (it could not be asked).
let inboxRead = window.approvals ? 'reading' : 'unread';
const W = {
  en: { cardWaiting: 'Waiting for you', cardMineWaiting: 'You asked — still waiting', cardMineDone: 'You asked — decided', cardNote: 'requests',
    reading: 'Reading what is waiting for you from head office…', unread: 'Head office could not be asked, so what is waiting for you is not known. Nothing was decided.',
    notKnownYet: 'Not known yet', required: 'required', needReason: 'Write your reason first — the person who asked will read it.' },
  ta: { cardWaiting: 'உங்களுக்காகக் காத்திருப்பவை', cardMineWaiting: 'நீங்கள் கேட்டவை — இன்னும் காத்திருக்கின்றன', cardMineDone: 'நீங்கள் கேட்டவை — முடிவானவை', cardNote: 'கோரிக்கைகள்',
    reading: 'உங்களுக்காகக் காத்திருப்பவற்றைத் தலைமை அலுவலகத்திலிருந்து படிக்கிறது…', unread: 'தலைமை அலுவலகத்திடம் கேட்க முடியவில்லை, எனவே உங்களுக்காகக் காத்திருப்பவை தெரியவில்லை. எதுவும் முடிவு செய்யப்படவில்லை.',
    notKnownYet: 'இன்னும் தெரியவில்லை', required: 'கட்டாயம்', needReason: 'முதலில் உங்கள் காரணத்தை எழுதுங்கள் — கேட்டவர் அதைப் படிப்பார்.' },
};
const w = (key) => W[lang]?.[key] ?? W.en[key];
const office = () => window.sreOffice ?? null;
document.addEventListener('sre:chrome', () => paint());

/** Where a request stands, as the shared status chip (the tone's shape and its words — never colour alone). */
function statusNode(status) {
  const o = office();
  const tone = ['ok', 'degraded', 'error', 'idle', 'pending', 'unknown'].includes(status.tone) ? status.tone : 'idle';
  const node = o ? o.chip(tone, status.label) : Object.assign(document.createElement('span'), { textContent: status.label });
  node.classList.add('status');
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
  // OB-420: who alone may decide it (a floor-device review: the named security reviewer), or that nobody can yet.
  if (r.whoDecides) { const who = statusNode(r.whoDecides); who.classList.add('who-decides'); li.append(who); }

  if (r.details.length > 0) {
    const details = document.createElement('div'); details.className = 'details';
    const dl = document.createElement('span'); dl.className = 'details-label'; dl.textContent = `${t('detailsLabel')}:`;
    details.append(dl, ...r.details.map((d) => { const kv = document.createElement('span'); kv.className = 'kv'; kv.textContent = `${d.label}: ${d.value}`; return kv; }));
    li.append(details);
  }

  if (waitingForMe) {
    const decideBox = document.createElement('div'); decideBox.className = 'decide';
    const inputId = `reason-${r.requestId}`;
    // W1: the shared form field — its name, "(required)" in words, and the message beside it when it is left blank
    const field = document.createElement('div'); field.className = 'sre-field';
    const label = document.createElement('label'); label.htmlFor = inputId; label.className = 'sre-field-label'; label.textContent = t('reasonLabel');
    const req = document.createElement('span'); req.className = 'sre-req'; req.textContent = ` (${w('required')})`; label.append(req);
    const input = document.createElement('input'); input.type = 'text'; input.id = inputId; input.className = 'reason sre-input'; input.autocomplete = 'off'; input.maxLength = 300;
    input.required = true; input.setAttribute('aria-required', 'true');
    input.placeholder = t('reasonPlaceholder');
    const msg = document.createElement('span'); msg.className = 'sre-field-msg'; msg.id = `${inputId}-msg`; msg.hidden = true;
    input.setAttribute('aria-describedby', msg.id);
    field.append(label, input, msg);
    const buttons = document.createElement('div'); buttons.className = 'buttons';
    const approve = document.createElement('button'); approve.type = 'button'; approve.className = 'act approve sre-btn sre-btn-primary'; approve.textContent = t('approveBtn'); approve.dataset.requestId = r.requestId;
    const reject = document.createElement('button'); reject.type = 'button'; reject.className = 'act reject sre-btn sre-btn-danger'; reject.textContent = t('rejectBtn'); reject.dataset.requestId = r.requestId;
    // A decision is a HUMAN write that runs ONLY on this explicit click, never on load.
    approve.addEventListener('click', () => { void decide(r.requestId, 'approved', input, [approve, reject]); });
    reject.addEventListener('click', () => { void decide(r.requestId, 'rejected', input, [approve, reject]); });
    buttons.append(approve, reject);
    decideBox.append(field, buttons);
    li.append(decideBox);
  }
  return li;
}

/** An empty list in the shared look: what is (not) there in words, and that empty is not the same as "all clear". */
function emptyRow(text) {
  const li = document.createElement('li'); li.className = 'row empty';
  const o = office();
  if (o) li.append(o.state(null, 'empty', { title: text }));
  else { const s = document.createElement('span'); s.textContent = text; li.append(s); }
  return li;
}

/** The inbox at a glance (W1): three summary cards — "Not known" until head office has answered. */
function paintCards(view) {
  const o = office();
  if (!o) return;
  const read = inboxRead === 'read' && view.mayUse;
  const mineWaiting = view.mine.filter((r) => r.approvalStatus === 'waiting').length;
  const mineDone = view.mine.length - mineWaiting;
  o.cards(el('approval-cards'), [
    { label: w('cardWaiting'), value: read ? view.waitingCount : null, note: read ? w('cardNote') : w('notKnownYet'), tone: read && view.waitingCount > 0 ? 'pending' : undefined, icon: 'badge-check' },
    { label: w('cardMineWaiting'), value: read ? mineWaiting : null, note: read ? w('cardNote') : w('notKnownYet'), icon: 'clock' },
    { label: w('cardMineDone'), value: read ? mineDone : null, note: read ? w('cardNote') : w('notKnownYet'), icon: 'circle-check' },
  ]);
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

  const known = inboxRead === 'read' || !view.mayUse;
  el('waiting-count').textContent = !known ? w(inboxRead === 'reading' ? 'reading' : 'unread') : view.waitingCount === 0 ? t('nothingWaiting') : `${view.waitingCount} ${t('waitingCount')}`;
  paintCards(view);
  el('waiting-heading').textContent = t('waitingHeading');
  el('waiting').setAttribute('aria-label', t('waitingHeading'));
  // A reason being typed survives a repaint (a language switch, a re-read) — the words are the checker's, not the page's.
  const typed = new Map([...document.querySelectorAll('#waiting input.reason')].map((i) => [i.id, i.value]));
  el('waiting').replaceChildren(...view.waiting.map((r) => requestNode(r, true)));
  for (const [id, value] of typed) { const input = document.getElementById(id); if (input) input.value = value; }

  const state = el('state');
  if (view.waiting.length === 0) {
    state.hidden = false;
    // W1 (P-08): before head office answers this is "reading" or "could not be asked" — never "nothing is waiting"
    const o = office();
    const kind = !known ? (inboxRead === 'reading' ? 'loading' : 'offline') : !view.mayUse ? 'denied' : 'empty';
    const words = !known ? w(inboxRead === 'reading' ? 'reading' : 'unread') : view.screenState.label;
    if (o) { state.className = 'state-box'; state.replaceChildren(o.state(null, kind, { title: words })); }
    else {
      state.className = `state tone-${view.screenState.tone}`;
      el('state-icon').textContent = view.screenState.icon;
      el('state-text').textContent = words;
    }
    state.setAttribute('aria-label', words);
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
    const msg = document.getElementById(`${input.id}-msg`);
    if (msg) { msg.hidden = outcome.kind !== 'needs_reason'; msg.textContent = outcome.kind === 'needs_reason' ? w('needReason') : ''; }
    if (outcome.kind === 'needs_reason') { input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
    input.removeAttribute('aria-invalid');
    if (outcome.kind === 'decided') input.value = '';
    if (outcome.kind !== 'lost_link' && outcome.kind !== 'nobody_named' && outcome.kind !== 'not_permitted') await refresh();
  } finally {
    for (const b of buttons) b.disabled = false;
  }
}

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); el('sample').textContent = t('sampleData'); /* U3 · OB-699: the stand-in's own line follows the toggle */ });

el('sample').hidden = window.approvalsSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the live inbox (a GET — read-only). Offline or refused, the page keeps its current view and the stale strip
// already says the page is what the box last told it.
async function refresh() {
  const api = window.approvals;
  if (!api || typeof api.refresh !== 'function') return;
  const inbox = await api.refresh();
  if (inbox) { inboxRead = 'read'; session = api.present(inbox); } else if (inboxRead !== 'read') inboxRead = 'unread';
  paint();
}
refresh();

// ── D-042 (fix batch 4a): purchase orders waiting for their second person ─────────────────────────────────────────────
// Read live from head office as the person signed in (window.ordersToIssue, tested in orders-to-issue-session.ts). Each
// order shows its supplier, every item by name with how many, the agreed price and the value, and the total. "Issue this
// order" runs only on an explicit click, with a written reason, through the Budget tab's own path; it is not offered on
// an order the person raised, nor to anyone who may not issue orders. Head office still decides (limit, budget, holds).
const orders = window.ordersToIssue ?? null;
let ordersRead = null;
const ow = (key) => {
  const words = window.ordersToIssueWords;
  return words ? (words[lang]?.[key] ?? words.en[key]) : key;
};
const rupees = (minor) => `₹${Math.floor(Math.abs(minor) / 100).toLocaleString('en-IN')}.${String(Math.abs(minor) % 100).padStart(2, '0')}`;

function orderNode(o) {
  const li = document.createElement('li');
  li.className = `row tone-${o.overBudget ? 'error' : 'degraded'}`;
  li.dataset.po = o.poId;
  const head = document.createElement('div'); head.className = 'head';
  const headline = document.createElement('span'); headline.className = 'headline'; headline.textContent = `${o.number} · ${o.supplierName}`;
  const value = document.createElement('span'); value.className = 'value'; value.textContent = rupees(o.totalMinor);
  head.append(headline, value);
  const facts = document.createElement('div'); facts.className = 'facts';
  facts.append(fact(ow('supplier'), o.supplierName), fact(ow('raisedBy'), o.raisedBy), fact(ow('total'), rupees(o.totalMinor)));
  const table = document.createElement('table'); table.className = 'lines';
  const thead = document.createElement('tr');
  for (const [k, num] of [['item', false], ['qty', true], ['price', true], ['value', true]]) { const th = document.createElement('th'); th.textContent = ow(k); if (num) th.className = 'num'; thead.append(th); }
  table.append(thead);
  for (const l of o.lines) {
    const tr = document.createElement('tr'); tr.dataset.product = l.productId;
    const per = l.per > 1 ? `${l.per} ${l.uom}` : l.uom === 'ea' ? '' : l.uom;
    const cells = [[l.name, false], [l.quantity, true], [`${rupees(l.unitCostMinor)}${per ? ` ${ow('perUnit')} ${per}` : ''}`, true], [rupees(l.valueMinor), true]];
    for (const [text, num] of cells) { const td = document.createElement('td'); td.textContent = text; if (num) td.className = 'num'; tr.append(td); }
    table.append(tr);
  }
  li.append(head, facts, table);
  if (o.overBudget) { const why = document.createElement('div'); why.className = 'summary-line over-budget'; why.textContent = ow('overBudget'); li.append(why); }
  if (o.raisedByViewer || !orders.mayIssue) {
    const note = document.createElement('div'); note.className = 'facts not-yours'; note.textContent = o.raisedByViewer ? ow('yours') : ow('notYours');
    li.append(note);
    return li;
  }
  const box = document.createElement('div'); box.className = 'decide';
  const inputId = `issue-reason-${o.poId}`;
  const field = document.createElement('div'); field.className = 'sre-field';
  const label = document.createElement('label'); label.htmlFor = inputId; label.className = 'sre-field-label'; label.textContent = ow('reason');
  const input = document.createElement('input'); input.type = 'text'; input.id = inputId; input.className = 'issue-reason sre-input'; input.autocomplete = 'off'; input.maxLength = 300; input.required = true;
  field.append(label, input);
  box.append(field);
  let over = null;
  if (o.overBudget) {
    const f2 = document.createElement('div'); f2.className = 'sre-field';
    const l2 = document.createElement('label'); l2.htmlFor = `over-reason-${o.poId}`; l2.className = 'sre-field-label'; l2.textContent = ow('overReason');
    over = document.createElement('input'); over.type = 'text'; over.id = `over-reason-${o.poId}`; over.className = 'over-reason sre-input'; over.autocomplete = 'off'; over.maxLength = 300;
    f2.append(l2, over); box.append(f2);
  }
  const buttons = document.createElement('div'); buttons.className = 'buttons';
  const go = document.createElement('button'); go.type = 'button'; go.className = 'act issue sre-btn sre-btn-primary'; go.textContent = ow('issue'); go.dataset.po = o.poId;
  const status = document.createElement('p'); status.className = 'issue-status'; status.setAttribute('role', 'status'); status.id = `issue-status-${o.poId}`;
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const outcome = await orders.issue(o, input.value, over === null ? undefined : over.value);
      status.textContent = orders.outcomeWords(lang, outcome);
      if (outcome.kind === 'needs_reason') { input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
      if (outcome.kind === 'issued') {
        paintResult({ tone: 'ok', icon: '✓', label: `${o.number}: ${status.textContent}`, announcement: '' });
        await readOrders();
      }
    } finally { go.disabled = false; }
  });
  buttons.append(go);
  box.append(buttons, status);
  li.append(box);
  return li;
}

function paintOrders() {
  if (orders === null) return;
  el('orders-to-issue').hidden = false;
  el('orders-heading').textContent = ow('heading');
  el('orders').setAttribute('aria-label', ow('heading'));
  const state = el('orders-state');
  if (ordersRead === null) { state.textContent = ow('reading'); el('orders').replaceChildren(); return; }
  if (ordersRead.state !== 'read') { state.textContent = ow(ordersRead.state === 'not_your_role' ? 'notYourRole' : 'unreachable'); el('orders').replaceChildren(); return; }
  state.textContent = ordersRead.orders.length === 0 ? ow('none') : '';
  el('orders').replaceChildren(...ordersRead.orders.map(orderNode));
}

async function readOrders() {
  if (orders === null) return;
  paintOrders();
  ordersRead = await orders.read();
  paintOrders();
}
document.addEventListener('sre:chrome', () => paintOrders());
el('lang').addEventListener('click', () => paintOrders());
void readOrders();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
