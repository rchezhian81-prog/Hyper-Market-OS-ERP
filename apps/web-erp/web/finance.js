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
// No `prompt`, `confirm` or `alert`; the banner does not fade.

const el = (id) => document.getElementById(id);

const inr = (minor) =>
  '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Words ───────────────────────────────────────────────────────────────────

const WORDS = {
  en: {
    staleShell: 'No connection to the store computer. This page is what it was last told, at',
    title: 'Finance',
    month: 'The month', queue: 'What the accounts have not taken',
    totalsLead: "Every figure is stated twice: what this shop's own record says, and what the accounts actually received. They are worked out separately and must agree exactly.",
    queueLead: 'A posting waiting in the queue is money the accounts have never seen. A refused one is money they would not take. Neither counts as received, and nothing here is ever thrown away.',
    blockersTitle: 'What is stopping this month closing',
    closeMonth: 'Close the month',
    closeNote: 'Nothing is closed until every figure agrees and nothing is outstanding. A closed month is never edited — a correction is a new entry in the open one.',
    deadTitle: 'Refused outright',
    ourRecord: 'our record', theAccounts: 'the accounts', difference: 'difference',
    agrees: 'agrees exactly', doesNotAgree: 'DOES NOT AGREE',
    nothingBlocking: 'Nothing is stopping this month closing.',
    noTotals: 'There is nothing to compare yet.',
    accepted: 'accepted by the accounts', waiting: 'still waiting', refused: 'refused',
    noDead: 'The accounts have refused nothing.',
    alreadyClosed: 'This month is closed.', closedBy: 'closed by',
    reopenTitle: 'Reopen this month', reopenReasonLabel: 'Why does it need reopening?',
    reopenApproverLabel: 'Who is approving it (not you)', reopenIt: 'Reopen the month',
    signable: 'These figures agree exactly and nothing is outstanding. They can be signed.',
    notSignable: 'These figures do NOT agree, or something is outstanding. Do not sign them.',
    ok: 'OK', read: 'Please read this', done: 'Closed',
    nobodyNamed: 'This store box has not been told who is using this screen. Nothing can be closed — a month close carries the name of whoever closed it, and a CA signs after them.',
    sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:',
    title: 'நிதி',
    month: 'இந்த மாதம்', queue: 'கணக்கு எடுத்துக் கொள்ளாதவை',
    totalsLead: 'ஒவ்வொரு எண்ணும் இரண்டு முறை சொல்லப்படுகிறது: கடையின் சொந்தப் பதிவு என்ன சொல்கிறது, கணக்குகள் உண்மையில் என்ன பெற்றன. இவை தனித்தனியாகக் கணக்கிடப்பட்டு சரியாகப் பொருந்த வேண்டும்.',
    queueLead: 'வரிசையில் காத்திருக்கும் பதிவு என்பது கணக்குகள் இதுவரை பார்க்காத பணம். மறுக்கப்பட்டது அவை எடுக்க மறுத்த பணம். இரண்டும் பெறப்பட்டதாகக் கணக்கிடப்படாது, இங்கு எதுவும் தூக்கி எறியப்படாது.',
    blockersTitle: 'இந்த மாதம் மூட எது தடையாக உள்ளது',
    closeMonth: 'மாதத்தை மூடு',
    closeNote: 'ஒவ்வொரு எண்ணும் பொருந்தி, நிலுவை எதுவும் இல்லாத வரை எதுவும் மூடப்படாது. மூடிய மாதம் திருத்தப்படாது — திருத்தம் என்பது திறந்த மாதத்தில் ஒரு புதிய பதிவு.',
    deadTitle: 'முற்றிலும் மறுக்கப்பட்டவை',
    ourRecord: 'நமது பதிவு', theAccounts: 'கணக்குகள்', difference: 'வித்தியாசம்',
    agrees: 'சரியாகப் பொருந்துகிறது', doesNotAgree: 'பொருந்தவில்லை',
    nothingBlocking: 'இந்த மாதம் மூட எந்தத் தடையும் இல்லை.',
    noTotals: 'ஒப்பிட இன்னும் எதுவும் இல்லை.',
    accepted: 'கணக்குகள் ஏற்றுக்கொண்டது', waiting: 'இன்னும் காத்திருக்கிறது', refused: 'மறுக்கப்பட்டது',
    noDead: 'கணக்குகள் எதையும் மறுக்கவில்லை.',
    alreadyClosed: 'இந்த மாதம் மூடப்பட்டுள்ளது.', closedBy: 'மூடியவர்',
    reopenTitle: 'இந்த மாதத்தை மீண்டும் திற', reopenReasonLabel: 'ஏன் மீண்டும் திறக்க வேண்டும்?',
    reopenApproverLabel: 'யார் அனுமதிக்கிறார்கள் (நீங்கள் அல்ல)', reopenIt: 'மாதத்தை மீண்டும் திற',
    signable: 'இந்த எண்கள் சரியாகப் பொருந்துகின்றன, நிலுவை எதுவும் இல்லை. கையெழுத்திடலாம்.',
    notSignable: 'இந்த எண்கள் பொருந்தவில்லை, அல்லது ஏதோ நிலுவையில் உள்ளது. கையெழுத்திட வேண்டாம்.',
    ok: 'சரி', read: 'இதைப் படிக்கவும்', done: 'மூடப்பட்டது',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைப் பெட்டிக்குத் தெரியவில்லை. எதையும் மூட முடியாது — மாத முடிப்பு அதைச் செய்தவரின் பெயரைச் சுமக்கும்.',
    sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

/** Why a month could not be closed — one entry per `CloseRefusal`, both languages. */
const CLOSE_REFUSAL_WORDS = {
  nobody_is_named_at_this_desk: {
    en: 'This store computer has not been told who is using this screen.',
    ta: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
  },
  the_shop_has_not_told_us_what_it_took: {
    en: 'The shop has not said what it took this month, so there is nothing to check the accounts against.',
    ta: 'இந்த மாதம் கடை என்ன வசூலித்தது என்று சொல்லவில்லை. எனவே கணக்குகளை எதனுடன் ஒப்பிடுவது என்பதே இல்லை.',
  },
  blocked: {
    en: 'This month cannot close yet. Everything stopping it is listed below.',
    ta: 'இந்த மாதத்தை இன்னும் மூட முடியாது. தடையாக உள்ள அனைத்தும் கீழே பட்டியலிடப்பட்டுள்ளன.',
  },
};

/** Why a month could not be reopened — one entry per `ReopenRefusal`, both languages. */
const REOPEN_REFUSAL_WORDS = {
  nobody_is_named_at_this_desk: {
    en: 'This store computer has not been told who is using this screen.',
    ta: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
  },
  not_closed: {
    en: 'This month is not closed, so there is nothing to reopen.',
    ta: 'இந்த மாதம் மூடப்படவில்லை. எனவே மீண்டும் திறக்க எதுவும் இல்லை.',
  },
  needs_a_different_person: {
    en: 'The person reopening a month cannot be the person approving it.',
    ta: 'மாதத்தை மீண்டும் திறப்பவரே அதை அனுமதிப்பவராக இருக்க முடியாது.',
  },
  needs_a_reason: {
    en: 'Reopening a signed month needs a reason.',
    ta: 'கையெழுத்திட்ட மாதத்தை மீண்டும் திறக்க ஒரு காரணம் தேவை.',
  },
};

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

/** A stand-in with the same surface as the bundled session, announced whenever it is in use. */
function sampleSession() {
  return {
    period: () => ({
      period: '—', totals: undefined, allReconcile: false,
      posted: { acceptedMinor: 0, acceptedCount: 0, pendingMinor: 0, pendingCount: 0, deadLetteredMinor: 0, deadLetteredCount: 0 },
      deadLettered: [], unsentSyncCount: 0, openExceptionCount: 0, closed: false,
    }),
    evidence: () => ({ signable: false, why: 'this is sample data' }),
    close: () => ({ ok: false, refusal: 'nobody_is_named_at_this_desk', detail: 'this is sample data' }),
    reopen: () => ({ ok: false, refusal: 'nobody_is_named_at_this_desk', detail: 'this is sample data' }),
  };
}

const real = window.financeSession;
const session = real ?? sampleSession();

// ── The banner ──────────────────────────────────────────────────────────────

function tell(title, message, good = false) {
  el('banner-title').textContent = title;
  el('banner-text').textContent = message;
  el('banner').classList.toggle('good', good === true);
  el('banner').hidden = false;
  el('banner-ok').textContent = t('ok');
  el('banner-ok').focus();
}
el('banner-ok').addEventListener('click', () => { el('banner').hidden = true; });

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
  if (view.closed) stopping.push({ kind: 'already_closed', detail: `${t('closedBy')} ${view.closedBy ?? ''}` });
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

/**
 * Reopening a signed month.
 *
 * On the screen rather than left to a database edit, and shown ONLY once the month is closed —
 * because the whole control is that a signed set of accounts does not change on one person's
 * say-so, and a control with no surface is a control somebody works around.
 */
el('reopen').addEventListener('click', () => {
  const outcome = session.reopen({
    reason: el('reopen-reason').value,
    approvedBy: el('reopen-approver').value.trim(),
  });
  if (!outcome.ok) {
    tell(t('read'), `${words(REOPEN_REFUSAL_WORDS, outcome.refusal)} ${outcome.detail}`);
    return;
  }
  tell(t('done'), outcome.detail, true);
  renderTotals();
});

el('close-month').addEventListener('click', () => {
  const outcome = session.close();
  if (!outcome.ok) {
    const extra = (outcome.result?.blockers ?? []).map((b) => b.detail).join(' · ');
    tell(t('read'), `${words(CLOSE_REFUSAL_WORDS, outcome.refusal)} ${extra || outcome.detail}`);
    renderTotals();
    return;
  }
  tell(t('done'), outcome.result.detail, true);
  renderTotals();
});

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
  el('close-month').textContent = t('closeMonth');
  el('close-note').textContent = t('closeNote');
  el('queue-title').textContent = t('queue');
  el('queue-lead').textContent = t('queueLead');
  el('dead-title').textContent = t('deadTitle');
  el('sample').textContent = t('sampleData');

  el('reopen-title').textContent = t('reopenTitle');
  el('reopen-reason-label').textContent = t('reopenReasonLabel');
  el('reopen-approver-label').textContent = t('reopenApproverLabel');
  el('reopen').textContent = t('reopenIt');
  // Only offered once the month is actually closed — there is nothing to reopen otherwise.
  el('reopen-box').hidden = !session.period().closed;

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
});

// ── Boot ────────────────────────────────────────────────────────────────────

el('sample').hidden = real !== undefined;
paintChrome();
show('totals');

function paintStale() {
  const at = window.shellCachedAt;
  const strip = el('stale');
  if (!strip) return;
  strip.hidden = at === undefined;
  if (at === undefined) return;
  strip.textContent = `${t('staleShell')} ${new Date(at).toLocaleString()}`;
}
paintStale();
el('lang').addEventListener('click', paintStale);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
