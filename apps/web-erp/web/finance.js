// Finance — the view layer. Every rule lives in the TESTED session model
// (`apps/web-erp/src/finance-session.ts`), attached as `window.financeSession`.
//
// ── The decision this screen is built around ────────────────────────────────
//
// **Every figure is shown twice, side by side.** What this shop's own record says, and what the
// accounts actually received. They are worked out separately and must agree exactly — and where
// they do not, the difference is shown in the space between them rather than summarised into a
// verdict somebody reads instead of the numbers.
//
// A CA signs this. The screen is written for the person putting their name to it, not for the
// person pressing the button.
//
// ── And the two that follow ─────────────────────────────────────────────────
//
// **The queue sits beside the totals, never inside them.** A posting waiting in the queue is money
// the accounts have never seen. Folding it in would make both sides agree — the same number
// computed twice — and the month would close, reconciled and signed, with the accounts empty.
//
// **Nothing on this screen can discard a refused posting.** They are listed in full, with the
// reason the accounts gave (hard rule #6).
//
// **A month is closed and reopened at head office, by two people (ADR-0024 · §28).** The closer asks
// for the signature here; someone who may sign a month (the accountant or the CA) approves it on
// their own Approvals page; only then does "Close the month" send the close, naming that approval.
// Reopening is the same, for exactly the written reason. No name is typed anywhere on this page, and
// a page that is not connected to head office closes and reopens nothing — it says so.
//
// No `prompt`, `confirm` or `alert`; the banner does not fade.

const el = (id) => document.getElementById(id);

const inr = (minor) =>
  '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Words ───────────────────────────────────────────────────────────────────

const WORDS = {
  en: {
    title: 'Finance',
    month: 'The month', queue: 'What the accounts have not taken',
    totalsLead: "Every figure is stated twice: what this shop's own record says, and what the accounts actually received. They are worked out separately and must agree exactly.",
    queueLead: 'A posting waiting in the queue is money the accounts have never seen. A refused one is money they would not take. Neither counts as received, and nothing here is ever thrown away.',
    blockersTitle: 'What is stopping this month closing',
    closeTitle: 'Close and sign this month',
    closeLead: 'Closing a month needs the signature of someone who may sign a month — the accountant or the CA, never you. When the figures agree, press “Ask for the signature”. Once they approve it on their Approvals page, press “Close the month”.',
    closeWhyLabel: 'A note for the person signing (optional)',
    askClose: 'Ask for the signature',
    closeMonth: 'Close the month',
    closeNote: 'Nothing is closed until every figure agrees and nothing is outstanding. A closed month is never edited — a correction is a new entry in the open one.',
    deadTitle: 'Refused outright',
    ourRecord: 'our record', theAccounts: 'the accounts', difference: 'difference',
    agrees: 'agrees exactly', doesNotAgree: 'DOES NOT AGREE',
    nothingBlocking: 'Nothing is stopping this month closing.',
    noTotals: 'There is nothing to compare yet.',
    accepted: 'accepted by the accounts', waiting: 'still waiting', refused: 'refused',
    noDead: 'The accounts have refused nothing.',
    alreadyClosed: 'This month is closed.', closedBy: 'closed by', signedBy: 'signed by',
    reopenTitle: 'Reopen this month', reopenReasonLabel: 'Why does it need reopening?',
    reopenLead: 'A signed month reopens only with the approval of someone who may sign a month — the accountant or the CA, never you. Write why and press “Ask for approval”. Once they approve it on their Approvals page, press “Reopen the month” with the same reason.',
    askReopen: 'Ask for approval', reopenIt: 'Reopen the month', yourRequest: 'Your request',
    signable: 'These figures agree exactly and nothing is outstanding. They can be signed.',
    notSignable: 'These figures do NOT agree, or something is outstanding. Do not sign them.',
    ok: 'OK', read: 'Please read this', done: 'Closed and signed', reopened: 'Reopened', waitingTitle: 'Waiting for approval',
    nobodyNamed: 'This store box has not been told who is using this screen. Nothing can be closed — a month close carries the name of whoever closed it, and a CA signs after them.',
    sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    title: 'நிதி',
    month: 'இந்த மாதம்', queue: 'கணக்கு எடுத்துக் கொள்ளாதவை',
    totalsLead: 'ஒவ்வொரு எண்ணும் இரண்டு முறை சொல்லப்படுகிறது: கடையின் சொந்தப் பதிவு என்ன சொல்கிறது, கணக்குகள் உண்மையில் என்ன பெற்றன. இவை தனித்தனியாகக் கணக்கிடப்பட்டு சரியாகப் பொருந்த வேண்டும்.',
    queueLead: 'வரிசையில் காத்திருக்கும் பதிவு என்பது கணக்குகள் இதுவரை பார்க்காத பணம். மறுக்கப்பட்டது அவை எடுக்க மறுத்த பணம். இரண்டும் பெறப்பட்டதாகக் கணக்கிடப்படாது, இங்கு எதுவும் தூக்கி எறியப்படாது.',
    blockersTitle: 'இந்த மாதம் மூட எது தடையாக உள்ளது',
    closeTitle: 'இந்த மாதத்தை மூடிக் கையெழுத்திடு',
    closeLead: 'மாதத்தை மூட, மாதத்திற்குக் கையெழுத்திடக்கூடியவரின் கையெழுத்து தேவை — கணக்காளர் அல்லது பட்டயக் கணக்காளர் (CA), ஒருபோதும் நீங்கள் அல்ல. எண்கள் பொருந்தும்போது “கையெழுத்து கேள்” அழுத்தவும். அவர் தனது அனுமதிகள் பக்கத்தில் அனுமதித்ததும், “மாதத்தை மூடு” அழுத்தவும்.',
    closeWhyLabel: 'கையெழுத்திடுபவருக்கு ஒரு குறிப்பு (விருப்பமானால்)',
    askClose: 'கையெழுத்து கேள்',
    closeMonth: 'மாதத்தை மூடு',
    closeNote: 'ஒவ்வொரு எண்ணும் பொருந்தி, நிலுவை எதுவும் இல்லாத வரை எதுவும் மூடப்படாது. மூடிய மாதம் திருத்தப்படாது — திருத்தம் என்பது திறந்த மாதத்தில் ஒரு புதிய பதிவு.',
    deadTitle: 'முற்றிலும் மறுக்கப்பட்டவை',
    ourRecord: 'நமது பதிவு', theAccounts: 'கணக்குகள்', difference: 'வித்தியாசம்',
    agrees: 'சரியாகப் பொருந்துகிறது', doesNotAgree: 'பொருந்தவில்லை',
    nothingBlocking: 'இந்த மாதம் மூட எந்தத் தடையும் இல்லை.',
    noTotals: 'ஒப்பிட இன்னும் எதுவும் இல்லை.',
    accepted: 'கணக்குகள் ஏற்றுக்கொண்டது', waiting: 'இன்னும் காத்திருக்கிறது', refused: 'மறுக்கப்பட்டது',
    noDead: 'கணக்குகள் எதையும் மறுக்கவில்லை.',
    alreadyClosed: 'இந்த மாதம் மூடப்பட்டுள்ளது.', closedBy: 'மூடியவர்', signedBy: 'கையெழுத்திட்டவர்',
    reopenTitle: 'இந்த மாதத்தை மீண்டும் திற', reopenReasonLabel: 'ஏன் மீண்டும் திறக்க வேண்டும்?',
    reopenLead: 'கையெழுத்திட்ட மாதம், மாதத்திற்குக் கையெழுத்திடக்கூடியவரின் அனுமதியுடன் மட்டுமே மீண்டும் திறக்கும் — கணக்காளர் அல்லது பட்டயக் கணக்காளர் (CA), ஒருபோதும் நீங்கள் அல்ல. ஏன் என்று எழுதி “அனுமதி கேள்” அழுத்தவும். அவர் தனது அனுமதிகள் பக்கத்தில் அனுமதித்ததும், அதே காரணத்துடன் “மாதத்தை மீண்டும் திற” அழுத்தவும்.',
    askReopen: 'அனுமதி கேள்', reopenIt: 'மாதத்தை மீண்டும் திற', yourRequest: 'உங்கள் கோரிக்கை',
    signable: 'இந்த எண்கள் சரியாகப் பொருந்துகின்றன, நிலுவை எதுவும் இல்லை. கையெழுத்திடலாம்.',
    notSignable: 'இந்த எண்கள் பொருந்தவில்லை, அல்லது ஏதோ நிலுவையில் உள்ளது. கையெழுத்திட வேண்டாம்.',
    ok: 'சரி', read: 'இதைப் படிக்கவும்', done: 'மூடிக் கையெழுத்திடப்பட்டது', reopened: 'மீண்டும் திறக்கப்பட்டது', waitingTitle: 'அனுமதிக்காகக் காத்திருக்கிறது',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைப் பெட்டிக்குத் தெரியவில்லை. எதையும் மூட முடியாது — மாத முடிப்பு அதைச் செய்தவரின் பெயரைச் சுமக்கும்.',
    sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

/** What is stopping a close — one entry per `CloseBlocker`, both languages. */
const BLOCKER_WORDS = {
  control_totals_do_not_reconcile: {
    en: 'The two sides of a figure do not agree.',
    ta: 'ஒரு எண்ணின் இரு பக்கங்களும் பொருந்தவில்லை.',
  },
  dead_lettered_postings: {
    en: 'The accounts refused a posting. That is money they have never seen.',
    ta: 'கணக்குகள் ஒரு பதிவை மறுத்தன. அது அவை பார்க்காத பணம்.',
  },
  unsent_sync_items: {
    en: 'Sales on this shop computer have not reached head office.',
    ta: 'இந்தக் கடைக் கணினியில் உள்ள விற்பனைகள் தலைமை அலுவலகத்தை அடையவில்லை.',
  },
  open_exceptions: {
    en: 'There are differences nobody has explained yet.',
    ta: 'இன்னும் யாரும் விளக்காத வித்தியாசங்கள் உள்ளன.',
  },
  already_closed: {
    en: 'This month is already closed.',
    ta: 'இந்த மாதம் ஏற்கனவே மூடப்பட்டுள்ளது.',
  },
};

const words = (map, key) => (map[key]?.[lang] ?? map[key]?.en ?? String(key).replace(/_/g, ' '));

/** A stand-in with the same surface as the bundled session, announced whenever it is in use. It is connected to
 *  nothing, so it asks nothing, closes nothing and reopens nothing — and says so. */
function sampleSession() {
  return {
    period: () => ({
      period: '—', totals: undefined, allReconcile: false,
      posted: { acceptedMinor: 0, acceptedCount: 0, pendingMinor: 0, pendingCount: 0, deadLetteredMinor: 0, deadLetteredCount: 0 },
      deadLettered: [], unsentSyncCount: 0, openExceptionCount: 0, closed: false,
    }),
    evidence: () => ({ signable: false, why: 'this is sample data' }),
    close: () => ({ ok: false, refusal: 'nobody_is_named_at_this_desk', detail: 'this is sample data' }),
    connected: false,
    askToClose: async () => ({ kind: 'not_connected' }),
    closeWithApproval: async () => ({ kind: 'not_connected' }),
    askToReopen: async () => ({ kind: 'not_connected' }),
    reopenWithApproval: async () => ({ kind: 'not_connected' }),
    yourRequests: async () => ({ state: 'not_connected', close: null, reopen: null, closeAsked: false, reopenReason: null }),
    presentAskOutcome: (l) => sampleWords(l),
    presentUseOutcome: (l) => sampleWords(l),
  };
}

/** The sample view's one answer to closing or reopening: it is connected to nothing. */
const SAMPLE_NOT_CONNECTED = {
  en: 'This is sample data and is not connected to head office. Closing and reopening a month happen at head office, with a second person’s approval — nothing was asked and nothing was changed.',
  ta: 'இது மாதிரித் தகவல், தலைமை அலுவலகத்துடன் இணைக்கப்படவில்லை. மாதத்தை மூடுவதும் மீண்டும் திறப்பதும் தலைமை அலுவலகத்தில், இரண்டாம் நபரின் அனுமதியுடன் நடக்கும் — எதுவும் கேட்கப்படவில்லை, எதுவும் மாற்றப்படவில்லை.',
};
const sampleWords = (l) => {
  const label = SAMPLE_NOT_CONNECTED[l] ?? SAMPLE_NOT_CONNECTED.en;
  return { tone: 'error', icon: '✕', label, announcement: label, needsAttention: true };
};

const real = window.financeSession;
const session = real ?? sampleSession();

// ── The banner ──────────────────────────────────────────────────────────────

/** The banner: `good` for done, `'pending'` for waiting on a second person, anything else needs reading. */
function tell(title, message, good = false) {
  el('banner-title').textContent = title;
  el('banner-text').textContent = message;
  el('banner').classList.toggle('good', good === true);
  el('banner').classList.toggle('pending', good === 'pending');
  el('banner').hidden = false;
  el('banner-ok').textContent = t('ok');
  el('banner-ok').focus();
}
el('banner-ok').addEventListener('click', () => { el('banner').hidden = true; });

/**
 * Say what happened to an ask, a close or a reopen — in the model's own words (both languages, tested),
 * with a title that matches: done, waiting, or please read.
 */
function tellMonth(action, kind, presented) {
  if (kind === 'done') {
    tell(action === 'close' ? t('done') : t('reopened'), presented.label, true);
  } else if (kind === 'asked' || kind === 'waiting') {
    tell(t('waitingTitle'), presented.label, 'pending');
  } else {
    tell(t('read'), presented.label);
  }
}

/** Run a click's work once: the button is disabled while head office answers, so a double tap asks once. */
async function busy(id, work) {
  const button = el(id);
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try { await work(); } finally { button.disabled = false; button.removeAttribute('aria-busy'); }
}

// ── Navigation ──────────────────────────────────────────────────────────────

const VIEWS = ['totals', 'queue'];

function show(name) {
  for (const view of VIEWS) el(`view-${view}`).hidden = view !== name;
  for (const tab of VIEWS) el(`tab-${tab}`).setAttribute('aria-current', tab === name ? 'page' : 'false');
}
for (const name of VIEWS) el(`tab-${name}`).addEventListener('click', () => { show(name); });

// ── The month ───────────────────────────────────────────────────────────────

function renderTotals() {
  const view = session.period();

  // The verdict, in words. A CA reads this line and then checks the numbers under it — never
  // instead of them, which is why every figure is still shown in full below.
  const verdict = el('verdict');
  const pack = session.evidence();
  verdict.className = `verdict ${pack.signable ? 'signable' : 'not-signable'}`;
  verdict.textContent = pack.signable ? t('signable') : (pack.why ?? t('notSignable'));

  const list = el('totals-list');
  if (view.totals === undefined) {
    // NOT an empty list. An empty list of totals reconciles vacuously, and that is exactly how a
    // month closes on nothing at all.
    list.replaceChildren(emptyLine(view.whyNoTotals ?? t('noTotals')));
  } else {
    list.replaceChildren(...view.totals.map(totalRow));
  }

  const blockers = el('blockers');
  const stopping = stoppingNow(view);
  blockers.replaceChildren(...(stopping.length === 0
    ? [emptyLine(t('nothingBlocking'))]
    : stopping.map((b) => {
      const row = document.createElement('div');
      row.className = 'row blocker';
      const what = document.createElement('span');
      what.className = 'what';
      const name = document.createElement('strong');
      name.textContent = words(BLOCKER_WORDS, b.kind);
      const sub = document.createElement('small');
      sub.textContent = b.detail;
      what.append(name, sub);
      row.append(what);
      return row;
    })));
}

/** What is stopping the close, read from the view rather than by attempting one. */
function stoppingNow(view) {
  const stopping = [];
  if (view.closed) {
    const signed = view.signedBy === undefined ? '' : ` · ${t('signedBy')} ${view.signedBy}`;
    stopping.push({ kind: 'already_closed', detail: `${t('closedBy')} ${view.closedBy ?? ''}${signed}` });
  }
  if (view.totals === undefined || !view.allReconcile) {
    const differing = (view.totals ?? []).filter((t2) => !t2.reconciles);
    stopping.push({
      kind: 'control_totals_do_not_reconcile',
      detail: differing.length > 0 ? differing.map((d) => d.detail).join(' · ') : (view.whyNoTotals ?? ''),
    });
  }
  if (view.deadLettered.length > 0) {
    stopping.push({ kind: 'dead_lettered_postings', detail: `${view.deadLettered.length} · ${inr(view.posted.deadLetteredMinor)}` });
  }
  if (view.unsentSyncCount > 0) stopping.push({ kind: 'unsent_sync_items', detail: String(view.unsentSyncCount) });
  if (view.openExceptionCount > 0) stopping.push({ kind: 'open_exceptions', detail: String(view.openExceptionCount) });
  return stopping;
}

function totalRow(total) {
  const row = document.createElement('div');
  row.className = `row ${total.reconciles ? 'reconciles' : 'differs'}`;

  const what = document.createElement('span');
  what.className = 'what';
  const name = document.createElement('strong');
  // Words as well as the colour: this is a page somebody signs.
  name.textContent = `${total.name} — ${total.reconciles ? t('agrees') : t('doesNotAgree')}`;

  // Both sides, side by side, with the difference between them. Never one number and a verdict.
  const sides = document.createElement('span');
  sides.className = 'sides';
  const ours = document.createElement('span');
  ours.textContent = inr(total.ledgerMinor);
  const oursLabel = document.createElement('small');
  oursLabel.textContent = t('ourRecord');
  ours.prepend(oursLabel);
  const theirs = document.createElement('span');
  theirs.textContent = inr(total.postedMinor);
  const theirsLabel = document.createElement('small');
  theirsLabel.textContent = t('theAccounts');
  theirs.prepend(theirsLabel);
  sides.append(ours, theirs);

  const method = document.createElement('small');
  // How each side was worked out, so a CA can re-derive it without asking anybody.
  method.textContent = total.reconciles
    ? total.method
    : `${t('difference')} ${inr(total.differenceMinor)} · ${total.method}`;

  what.append(name, sides, method);
  row.append(what);
  return row;
}

// ── Closing and reopening: at head office, by two people (ADR-0024 · §28) ───

/** Whether the closer has asked for this month's signature — then "Close the month" is the one main action. */
let closeAsked = false;
/** The reason a reopen was last asked with — "Reopen the month" sends exactly that reason. */
let reopenAskedFor = null;

/** Which box shows (close while open, reopen once closed) and which button is the main action. */
function paintMonthSteps() {
  el('close-box').hidden = session.period().closed;
  // Only offered once the month is actually closed — there is nothing to reopen otherwise.
  el('reopen-box').hidden = !session.period().closed;
  el('ask-close').classList.toggle('primary', !closeAsked);
  el('close-month').classList.toggle('primary', closeAsked);
  const asked = reopenAskedFor !== null && reopenAskedFor === el('reopen-reason').value.trim();
  el('ask-reopen').classList.toggle('primary', !asked);
}

/** One line under a step saying where the person's own request stands — icon and words, never colour alone. */
function paintRequest(id, presented) {
  const line = el(id);
  if (presented === null) { line.hidden = true; line.replaceChildren(); return; }
  const chip = document.createElement('span');
  chip.className = 'sre-chip';
  chip.dataset.tone = presented.tone;
  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = presented.icon;
  const text = document.createElement('span');
  text.textContent = `${t('yourRequest')}: ${presented.label}`;
  chip.append(icon, text);
  line.replaceChildren(chip);
  line.hidden = false;
}

/** Read where the person's own requests for this month stand (a GET — read only), and show it. */
async function refreshRequests() {
  const mine = await session.yourRequests(lang);
  paintRequest('close-request', mine.close);
  paintRequest('reopen-request', mine.reopen);
  // Head office's list is the word on what was asked; with no answer, what this page saw is kept.
  if (mine.state === 'read') {
    closeAsked = mine.closeAsked;
    reopenAskedFor = mine.reopenReason === null ? null : mine.reopenReason.trim();
  }
  // A reopen still in play carries its reason: put it back in the box, so "Reopen the month" sends exactly it.
  if (mine.reopenReason !== null && el('reopen-reason').value.trim() === '') el('reopen-reason').value = mine.reopenReason;
  paintMonthSteps();
}

/** After any close or reopen step: the month as it now stands, and where the person's requests stand. */
async function afterMonthStep() {
  renderTotals();
  paintMonthSteps();
  await refreshRequests();
}

// Ask for the signature — the closer's OWN request, in their own session, for exactly this month. Nothing is closed.
el('ask-close').addEventListener('click', () => {
  void busy('ask-close', async () => {
    const outcome = await session.askToClose(lang, el('close-why').value);
    if (outcome.kind === 'asked') { closeAsked = true; el('close-why').value = ''; }
    tellMonth('close', outcome.kind, session.presentAskOutcome(lang, 'close', outcome));
    await afterMonthStep();
  });
});

// Close the month — head office closes it naming the closer's own APPROVED request. Never a typed signer.
el('close-month').addEventListener('click', () => {
  void busy('close-month', async () => {
    const outcome = await session.closeWithApproval();
    if (outcome.kind === 'done') closeAsked = false;
    tellMonth('close', outcome.kind, session.presentUseOutcome(lang, 'close', outcome));
    await afterMonthStep();
  });
});

/**
 * Reopening a signed month.
 *
 * On the screen rather than left to a database edit, and shown ONLY once the month is closed —
 * because the whole control is that a signed set of accounts does not change on one person's
 * say-so, and a control with no surface is a control somebody works around.
 */
el('ask-reopen').addEventListener('click', () => {
  void busy('ask-reopen', async () => {
    const reason = el('reopen-reason').value;
    const outcome = await session.askToReopen(lang, reason);
    // The reason STAYS in the box: the reopen sends exactly the reason that was approved.
    if (outcome.kind === 'asked') reopenAskedFor = reason.trim();
    tellMonth('reopen', outcome.kind, session.presentAskOutcome(lang, 'reopen', outcome));
    await afterMonthStep();
  });
});

el('reopen').addEventListener('click', () => {
  void busy('reopen', async () => {
    const outcome = await session.reopenWithApproval(el('reopen-reason').value);
    if (outcome.kind === 'done') { reopenAskedFor = null; el('reopen-reason').value = ''; }
    tellMonth('reopen', outcome.kind, session.presentUseOutcome(lang, 'reopen', outcome));
    await afterMonthStep();
  });
});

el('reopen-reason').addEventListener('input', () => { paintMonthSteps(); });

// ── The queue ───────────────────────────────────────────────────────────────

function renderQueue() {
  const view = session.period();

  const box = el('queue-summary');
  box.replaceChildren();
  for (const [label, value, count] of [
    [t('accepted'), view.posted.acceptedMinor, view.posted.acceptedCount],
    [t('waiting'), view.posted.pendingMinor, view.posted.pendingCount],
    [t('refused'), view.posted.deadLetteredMinor, view.posted.deadLetteredCount],
  ]) {
    const line = document.createElement('small');
    line.textContent = `${label}: ${inr(value)} (${count})`;
    box.append(line);
  }

  el('dead-list').replaceChildren(...(view.deadLettered.length === 0
    ? [emptyLine(t('noDead'))]
    : view.deadLettered.map((posting) => {
      const row = document.createElement('div');
      row.className = 'row dead';
      const what = document.createElement('span');
      what.className = 'what';
      const name = document.createElement('strong');
      name.textContent = `${posting.journalRef} — ${inr(posting.debitMinor)}`;
      const sub = document.createElement('small');
      // The reason the accounts gave, kept verbatim. Nothing here can discard it.
      sub.textContent = `${posting.lastFailure ?? ''} · ${posting.attempts} attempt(s)`;
      what.append(name, sub);
      row.append(what);
      return row;
    })));
}

function emptyLine(text) {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  return p;
}

// ── Language and chrome ─────────────────────────────────────────────────────

function paintChrome() {
  el('who').firstChild.textContent = `${t('title')} `;
  el('whoami').textContent = window.financeData?.userId ?? '';
  el('tab-totals').textContent = t('month');
  el('tab-queue').textContent = t('queue');
  el('totals-title').textContent = `${t('month')} ${window.financeData?.period ?? ''}`;
  el('totals-lead').textContent = t('totalsLead');
  el('blockers-title').textContent = t('blockersTitle');
  el('close-title').textContent = t('closeTitle');
  el('close-lead').textContent = t('closeLead');
  el('close-why-label').textContent = t('closeWhyLabel');
  el('ask-close').textContent = t('askClose');
  el('close-month').textContent = t('closeMonth');
  el('close-note').textContent = t('closeNote');
  el('queue-title').textContent = t('queue');
  el('queue-lead').textContent = t('queueLead');
  el('dead-title').textContent = t('deadTitle');
  el('sample').textContent = t('sampleData');

  el('reopen-title').textContent = t('reopenTitle');
  el('reopen-lead').textContent = t('reopenLead');
  el('reopen-reason-label').textContent = t('reopenReasonLabel');
  el('ask-reopen').textContent = t('askReopen');
  el('reopen').textContent = t('reopenIt');
  paintMonthSteps();

  const nobody = el('nobody');
  nobody.hidden = window.financeData?.userId !== undefined;
  nobody.textContent = nobody.hidden ? '' : t('nobodyNamed');

  renderTotals();
  renderQueue();
}

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintChrome();
  // Where the person's requests stand, in the language they now read.
  void refreshRequests();
});

// ── Boot ────────────────────────────────────────────────────────────────────

el('sample').hidden = real !== undefined;
paintChrome();
show('totals');
// Where the person's own requests for this month stand — a read only; a page not connected to head office reads nothing.
void refreshRequests();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
