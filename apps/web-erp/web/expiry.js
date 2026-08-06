// Expiry and recall — the view layer. Every rule lives in the TESTED session model
// (`apps/web-erp/src/expiry-session.ts`), attached as `window.expirySession`.
//
// ── The decision this screen is built around ────────────────────────────────
//
// **A recall shows how much is still in customers' homes, not how much is on the shelf.** The shelf
// figure is the easy one and it is the one that makes a recall look finished. The number that
// matters is what went out and has not come back, and it sits at the top of every open recall in
// the largest text on the page.
//
// ── And the two that follow ─────────────────────────────────────────────────
//
// **An empty expiry list means one of two things**, and they are opposite: nothing is going out of
// date, or this shop does not record batch dates at all. The screen says which. "Nothing expiring"
// on a shop that has never recorded an expiry date is the most reassuring wrong sentence here.
//
// **A recall cannot be closed by pressing a button.** It needs evidence of what was done with the
// stock, and if stock is unaccounted for it needs a second note saying why it is being closed
// anyway — because in a real recall some of it has been eaten and is never coming back, and that is
// a decision somebody signs rather than a default.
//
// No `prompt`, `confirm` or `alert`; the banner does not fade.

const el = (id) => document.getElementById(id);

// ── Words ───────────────────────────────────────────────────────────────────

const WORDS = {
  en: {
    staleShell: 'No connection to the store computer. This page is what it was last told, at',
    title: 'Expiry and recall',
    goingOut: 'Going out of date', recalls: 'Recalls',
    expiryLead: 'Earliest first. Expired stock is thrown away; stock close to its date is marked down while it can still sell.',
    recallLead: 'Open ones first. A recall is not finished when it is started — it is finished when the stock is accounted for and written down.',
    startTitle: 'Start a recall', batchLabel: 'Batch code on the packaging',
    reasonLabel: 'Why (supplier notice, complaint, test result)', start: 'Start the recall',
    startNote: 'This stops the item being sold at every till, including with the internet down.',
    listTitle: 'Recalls in this shop',
    dispose: 'THROW AWAY — past its date', markdown: 'Mark it down — sells until',
    daysLeft: 'days left', daysAgo: 'days past its date', units: 'units',
    nothingExpiring: 'Nothing is close to its date.',
    noBatches: 'This shop does not record batch dates yet, so nothing can be checked. An empty list here would mean nothing is going out of date, and that is not what this is.',
    noRecalls: 'No recalls have been started in this shop.',
    stillOut: 'still out there', sold: 'sold on', canContact: 'buyers we can contact',
    cannotContact: 'buyers we cannot', received: 'received', open: 'OPEN', closed: 'closed',
    closeIt: 'Close this recall', evidenceLabel: 'What was actually done with the stock',
    recoveredLabel: 'Got back', disposedLabel: 'Destroyed',
    acceptLabel: 'If some is still out there, why are you closing it?',
    ok: 'OK', read: 'Please read this', done: 'Done',
    nobodyNamed: 'This store box has not been told who is using this screen. Nothing can be started or closed — a recall carries the name of whoever ran it.',
    sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:',
    title: 'காலாவதி மற்றும் திரும்பப் பெறுதல்',
    goingOut: 'காலாவதி ஆகப் போகிறவை', recalls: 'திரும்பப் பெறுதல்கள்',
    expiryLead: 'முதலில் அவசரமானவை. காலாவதி ஆனவை தூக்கி எறியப்படும்; தேதி நெருங்குபவை விற்கும் வரை விலை குறைக்கப்படும்.',
    recallLead: 'திறந்தவை முதலில். தொடங்கியவுடன் திரும்பப் பெறுதல் முடிந்துவிடாது — பொருள் கணக்கில் வந்து எழுதப்பட்டால்தான் முடியும்.',
    startTitle: 'திரும்பப் பெறுதலைத் தொடங்கு', batchLabel: 'பொதியில் உள்ள batch குறியீடு',
    reasonLabel: 'ஏன் (சப்ளையர் அறிவிப்பு, புகார், சோதனை முடிவு)', start: 'திரும்பப் பெறுதலைத் தொடங்கு',
    startNote: 'இது எல்லா பில்லிங் கவுன்டரிலும் விற்பனையை நிறுத்தும் — இணையம் இல்லாவிட்டாலும்.',
    listTitle: 'இந்தக் கடையில் திரும்பப் பெறுதல்கள்',
    dispose: 'தூக்கி எறி — தேதி முடிந்தது', markdown: 'விலை குறை — இந்த தேதி வரை விற்கும்',
    daysLeft: 'நாட்கள் உள்ளன', daysAgo: 'நாட்கள் தேதி முடிந்தது', units: 'அலகுகள்',
    nothingExpiring: 'எதுவும் தேதி நெருங்கவில்லை.',
    noBatches: 'இந்தக் கடை இன்னும் batch தேதிகளைப் பதிவு செய்யவில்லை. எனவே எதையும் சரிபார்க்க முடியாது. காலி பட்டியல் என்றால் எதுவும் காலாவதி ஆகவில்லை என்று பொருள் — அது இங்கு உண்மை அல்ல.',
    noRecalls: 'இந்தக் கடையில் திரும்பப் பெறுதல் எதுவும் தொடங்கப்படவில்லை.',
    stillOut: 'இன்னும் வெளியே உள்ளது', sold: 'விற்கப்பட்டது', canContact: 'தொடர்பு கொள்ளக்கூடிய வாடிக்கையாளர்கள்',
    cannotContact: 'தொடர்பு கொள்ள முடியாதவர்கள்', received: 'பெறப்பட்டது', open: 'திறந்துள்ளது', closed: 'மூடப்பட்டது',
    closeIt: 'இதை மூடு', evidenceLabel: 'பொருளுக்கு உண்மையில் என்ன செய்யப்பட்டது',
    recoveredLabel: 'திரும்பப் பெற்றது', disposedLabel: 'அழிக்கப்பட்டது',
    acceptLabel: 'சில இன்னும் வெளியே இருந்தால், ஏன் இதை மூடுகிறீர்கள்?',
    ok: 'சரி', read: 'இதைப் படிக்கவும்', done: 'முடிந்தது',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று இந்தக் கடைப் பெட்டிக்குத் தெரியவில்லை. எதையும் தொடங்கவோ மூடவோ முடியாது — திரும்பப் பெறுதல் அதை நடத்தியவரின் பெயரைச் சுமக்கும்.',
    sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

/** Why a recall could not be started — one entry per `StartRefusal`, both languages. */
const START_REFUSAL_WORDS = {
  nobody_is_named_at_this_desk: {
    en: 'This store computer has not been told who is using this screen.',
    ta: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
  },
  no_such_batch: {
    en: 'This store computer has no batch with that code.',
    ta: 'அந்தக் குறியீட்டைக் கொண்ட batch கடைக் கணினியில் இல்லை.',
  },
  already_recalled: {
    en: 'That batch is already recalled. Starting it twice would split the evidence across two records.',
    ta: 'அந்த batch ஏற்கனவே திரும்பப் பெறப்படுகிறது. இரண்டு முறை தொடங்கினால் ஆதாரம் இரண்டாகப் பிரியும்.',
  },
  needs_a_reason: {
    en: 'A recall needs a reason.',
    ta: 'திரும்பப் பெறுதலுக்கு ஒரு காரணம் தேவை.',
  },
};

/** Why a recall could not be closed — one entry per `CloseRefusal`, both languages. */
const CLOSE_REFUSAL_WORDS = {
  nobody_is_named_at_this_desk: {
    en: 'This store computer has not been told who is using this screen.',
    ta: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
  },
  no_such_recall: {
    en: 'There is no recall by that name.',
    ta: 'அந்தப் பெயரில் திரும்பப் பெறுதல் இல்லை.',
  },
  already_closed: {
    en: 'This recall is already closed. Reopening it would be a new record, never an edit of this one.',
    ta: 'இது ஏற்கனவே மூடப்பட்டது. மீண்டும் திறப்பது ஒரு புதிய பதிவாகும், இதன் திருத்தம் அல்ல.',
  },
  needs_evidence: {
    en: 'Closing a recall needs evidence of what was actually done with the stock.',
    ta: 'மூடுவதற்கு, பொருளுக்கு உண்மையில் என்ன செய்யப்பட்டது என்ற ஆதாரம் தேவை.',
  },
  stock_not_accounted_for: {
    en: 'Some of this batch went out and has not been accounted for. Closing now needs a note saying why.',
    ta: 'இந்த batch-இல் சில வெளியே சென்று கணக்கில் வரவில்லை. இப்போது மூட ஒரு காரணக் குறிப்பு தேவை.',
  },
};

const words = (map, key) => (map[key]?.[lang] ?? map[key]?.en ?? String(key).replace(/_/g, ' '));

/** A stand-in with the same surface as the bundled session, announced whenever it is in use. */
function sampleSession() {
  return {
    actionList: () => [],
    wouldAllocate: () => ({ requiredQty: 0, allocated: [], allocatedQty: 0, shortfallQty: 0, fullyAllocated: true }),
    recalls: () => [],
    start: () => ({ ok: false, refusal: 'nobody_is_named_at_this_desk', detail: 'this is sample data' }),
    close: () => ({ ok: false, refusal: 'nobody_is_named_at_this_desk', detail: 'this is sample data' }),
  };
}

const real = window.expirySession;
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

const VIEWS = ['expiry', 'recall'];

function show(name) {
  for (const view of VIEWS) el(`view-${view}`).hidden = view !== name;
  for (const tab of VIEWS) el(`tab-${tab}`).setAttribute('aria-current', tab === name ? 'page' : 'false');
}
for (const name of VIEWS) el(`tab-${name}`).addEventListener('click', () => { show(name); });

// ── Going out of date ───────────────────────────────────────────────────────

function renderExpiry() {
  const list = session.actionList();

  // The two empty states are opposite, and only one of them is good news.
  const noBatches = el('no-batches');
  const untracked = window.expiryData !== undefined && window.expiryData.batches === undefined;
  noBatches.hidden = !untracked;
  noBatches.textContent = untracked ? t('noBatches') : '';

  el('expiry-list').replaceChildren(...(list.length === 0
    ? [emptyLine(untracked ? t('noBatches') : t('nothingExpiring'))]
    : list.map((item) => {
      const row = document.createElement('div');
      row.className = `row ${item.status}`;
      const what = document.createElement('span');
      what.className = 'what';
      const name = document.createElement('strong');
      name.textContent = `${item.name} — ${item.qty} ${t('units')}`;
      const sub = document.createElement('small');
      // Words as well as colour, always: one man in twelve cannot tell the two borders apart.
      sub.textContent = item.status === 'expired'
        ? `${t('dispose')} (${Math.abs(item.daysToExpiry)} ${t('daysAgo')}) · ${item.batchId}`
        : `${t('markdown')} ${item.expiry} (${item.daysToExpiry} ${t('daysLeft')}) · ${item.batchId}`;
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

// ── Recalls ─────────────────────────────────────────────────────────────────

el('start').addEventListener('click', () => {
  const outcome = session.start({
    recallId: `RC-${el('batch').value.trim()}-${Date.now()}`,
    batchId: el('batch').value.trim(),
    reason: el('reason').value,
  });
  if (!outcome.ok) {
    tell(t('read'), `${words(START_REFUSAL_WORDS, outcome.refusal)} ${outcome.detail}`);
    return;
  }
  // The number that matters, said first and said plainly.
  tell(t('done'), `${outcome.view.stillOutThere} ${t('stillOut')}. ${outcome.view.identifiedCustomers} ${t('canContact')}, ${outcome.view.anonymousSales} ${t('cannotContact')}.`, true);
  el('batch').value = '';
  el('reason').value = '';
  renderRecalls();
});

function renderRecalls() {
  const list = session.recalls();
  el('recall-list').replaceChildren(...(list.length === 0
    ? [emptyLine(t('noRecalls'))]
    : list.map(recallRow)));
}

function recallRow(view) {
  const row = document.createElement('div');
  row.className = `row ${view.open ? 'open' : 'closed'}`;

  const what = document.createElement('span');
  what.className = 'what';
  const name = document.createElement('strong');
  // The still-out figure is the headline, not the shelf figure. The shelf one is the easy one and
  // it is the one that makes a recall look finished.
  name.textContent = view.open
    ? `${view.name} — ${view.stillOutThere} ${t('stillOut')}`
    : `${view.name} — ${t('closed')}`;
  const sub = document.createElement('small');
  sub.textContent = `${view.open ? t('open') : t('closed')} · ${t('received')} ${view.trace.receivedQty} · ${t('sold')} ${view.trace.issuedQty}`
    + ` · ${view.identifiedCustomers} ${t('canContact')}, ${view.anonymousSales} ${t('cannotContact')}`
    + ` · ${view.recall.reason}`;
  what.append(name, sub);
  row.append(what);

  if (view.open) {
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = t('closeIt');
    close.addEventListener('click', () => { openCloseForm(view, row); });
    row.append(close);
  }
  return row;
}

/** The closure form, opened in place. Never a dialog — a dialog cannot be read in Tamil. */
function openCloseForm(view, row) {
  const form = document.createElement('div');
  form.className = 'what';

  const evidence = document.createElement('textarea');
  evidence.id = `evidence-${view.recall.recallId}`;
  evidence.setAttribute('aria-label', t('evidenceLabel'));
  const recovered = document.createElement('input');
  recovered.type = 'text';
  recovered.inputMode = 'numeric';
  recovered.id = `recovered-${view.recall.recallId}`;
  recovered.setAttribute('aria-label', t('recoveredLabel'));
  recovered.value = '0';
  const disposed = document.createElement('input');
  disposed.type = 'text';
  disposed.inputMode = 'numeric';
  disposed.id = `disposed-${view.recall.recallId}`;
  disposed.setAttribute('aria-label', t('disposedLabel'));
  disposed.value = '0';
  const accept = document.createElement('textarea');
  accept.id = `accept-${view.recall.recallId}`;
  accept.setAttribute('aria-label', t('acceptLabel'));

  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'danger';
  go.textContent = t('closeIt');
  go.addEventListener('click', () => {
    const outcome = session.close({
      recallId: view.recall.recallId,
      evidence: evidence.value,
      recoveredQty: Number(recovered.value.replace(/[^0-9]/g, '') || '0'),
      disposedQty: Number(disposed.value.replace(/[^0-9]/g, '') || '0'),
      acceptUnrecovered: accept.value,
    });
    if (!outcome.ok) {
      tell(t('read'), `${words(CLOSE_REFUSAL_WORDS, outcome.refusal)} ${outcome.detail}`);
      return;
    }
    tell(t('done'), outcome.recall.closure.evidence, true);
    renderRecalls();
  });

  const label = (text, node) => {
    const wrap = document.createElement('label');
    wrap.textContent = text;
    wrap.setAttribute('for', node.id);
    return wrap;
  };
  form.append(
    label(t('evidenceLabel'), evidence), evidence,
    label(t('recoveredLabel'), recovered), recovered,
    label(t('disposedLabel'), disposed), disposed,
    label(t('acceptLabel'), accept), accept,
    go,
  );
  row.append(form);
}

// ── Language and chrome ─────────────────────────────────────────────────────

function paintChrome() {
  el('who').firstChild.textContent = `${t('title')} `;
  el('whoami').textContent = window.expiryData?.userId ?? '';
  el('tab-expiry').textContent = t('goingOut');
  el('tab-recall').textContent = t('recalls');
  el('expiry-title').textContent = t('goingOut');
  el('expiry-lead').textContent = t('expiryLead');
  el('recall-title').textContent = t('recalls');
  el('recall-lead').textContent = t('recallLead');
  el('start-title').textContent = t('startTitle');
  el('batch-label').textContent = t('batchLabel');
  el('reason-label').textContent = t('reasonLabel');
  el('start').textContent = t('start');
  el('start-note').textContent = t('startNote');
  el('list-title').textContent = t('listTitle');
  el('sample').textContent = t('sampleData');

  const nobody = el('nobody');
  nobody.hidden = window.expiryData?.userId !== undefined;
  nobody.textContent = nobody.hidden ? '' : t('nobodyNamed');

  renderExpiry();
  renderRecalls();
}

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintChrome();
});

// ── Boot ────────────────────────────────────────────────────────────────────

el('sample').hidden = real !== undefined;
paintChrome();
show('expiry');

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
