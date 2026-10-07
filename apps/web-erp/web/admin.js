// Admin and security — the view layer. Every rule lives in the TESTED session model
// (`apps/web-erp/src/admin-session.ts`), attached as `window.adminSession`.
//
// ── The decision this screen is built around ────────────────────────────────
//
// **Outside access is the first tab, not a settings page three levels down.** Somebody who is not
// part of this business being inside a customer's live data is the most serious thing this screen
// has to say, and a live session is drawn as loudly as the product knows how.
//
// ── And the ones that follow ────────────────────────────────────────────────
//
// **A grant that has expired is not access**, and that is decided from the clock every time this
// renders — never from a stored flag, because a flag has to be turned off by something and that
// something is exactly what did not exist.
//
// **A second person's approval is that person's own signed-in act, never a name typed into a box**
// (audit PA-03). Outside access is head office's two-step lifecycle: the support person files their
// own request from their own sign-in; the OWNER approves (for fewer minutes if they wish — never more
// than asked), rejects, or ends a live session early, HERE, in their own session. There is no box on
// this page for a requester, a scope list or an approver — and nothing here files a request.
//
// The approve, reject and end presses are HUMAN writes that run ONLY on an explicit click, never on
// load; the session refuses the cheap things before any POST, and the audited POSTs live in the
// injected port (browser-entry). No `prompt`, `confirm` or `alert`; no fetch here.

const el = (id) => document.getElementById(id);

// ── Words ───────────────────────────────────────────────────────────────────

const WORDS = {
  en: {
    title: 'Admin and security',
    support: 'Outside access', people: 'Who can get in', fleet: 'Tills and devices', records: 'Records kept',
    supportLead: 'Anybody outside this business who has been let into your live data. Access is granted for a set time and for named things only — never everything, and never open-ended.',
    peopleLead: 'Every account, and anything about it worth a second look.',
    fleetLead: 'What this shop runs on, and whether each one is allowed to take a sale.',
    recordsLead: 'What the rules say may eventually be deleted, and what a legal hold stops being deleted. Nothing on this screen deletes anything.',
    liveNow: 'IN YOUR DATA NOW', ended: 'finished', minutesLeft: 'minutes left',
    maySee: 'may see', actions: 'things done', approvedByLabel: 'approved by',
    noSupport: 'Nobody outside this business has been let in.',
    noAccounts: 'This screen has not been told about any accounts.',
    nothingFlagged: 'nothing to look at',
    devicesTotal: 'devices', trading: 'can take a sale', blocked: 'blocked', mustUpgrade: 'must be updated',
    silent: 'not reported in',
    noPolicy: 'This shop has not set a minimum version, so NOTHING is being enforced on any device. That is not the same as every device being up to date.',
    noRetention: 'This shop has not decided how long to keep anything, so nothing has been worked out. That is not the same as nothing being due for deletion.',
    heldBy: 'held', keep: 'keep', noRecords: 'Nothing to review.',
    nobodyNamed: 'This store computer has not been told who is using this screen, so nothing can be decided here — letting somebody into a customer’s live data carries the name of the person who decided it.',
    sampleData: 'Sample data — this is not your shop.',
    // The sample stand-in's outside-access words (the bundled session carries the real ones).
    sampleNotConnected: 'This is sample data and is not connected to head office — nothing is shown as waiting and nothing can be decided here.',
    sessionsTitle: 'Who has been let in',
    requestsNote: 'A support person files their own request, from their own sign-in. Nobody types a request, or an approver, on this screen.',
  },
  ta: {
    title: 'நிர்வாகமும் பாதுகாப்பும்',
    support: 'வெளியாட்கள் அணுகல்', people: 'யார் உள்ளே வர முடியும்', fleet: 'பில்லிங் இயந்திரங்கள்', records: 'வைத்திருக்கும் பதிவுகள்',
    supportLead: 'உங்கள் நேரடித் தகவலுக்குள் அனுமதிக்கப்பட்ட, இந்த வணிகத்திற்கு வெளியே உள்ள எவரும். அணுகல் ஒரு குறிப்பிட்ட நேரத்திற்கும் குறிப்பிட்ட விஷயங்களுக்கும் மட்டுமே — எல்லாவற்றுக்கும் அல்ல, முடிவில்லாமலும் அல்ல.',
    peopleLead: 'ஒவ்வொரு கணக்கும், அதில் இரண்டாவது முறை பார்க்க வேண்டியவையும்.',
    fleetLead: 'இந்தக் கடை எதில் இயங்குகிறது, ஒவ்வொன்றும் விற்பனை செய்ய அனுமதிக்கப்பட்டுள்ளதா.',
    recordsLead: 'விதிகளின்படி எது நீக்கப்படலாம், சட்டப்பூர்வ தடை எதை நீக்கவிடாது. இந்தத் திரை எதையும் நீக்காது.',
    liveNow: 'இப்போது உங்கள் தகவலுக்குள்', ended: 'முடிந்தது', minutesLeft: 'நிமிடங்கள் உள்ளன',
    maySee: 'பார்க்கலாம்', actions: 'செய்யப்பட்டவை', approvedByLabel: 'அனுமதித்தவர்',
    noSupport: 'இந்த வணிகத்திற்கு வெளியே உள்ள யாரும் அனுமதிக்கப்படவில்லை.',
    noAccounts: 'எந்தக் கணக்கு பற்றியும் இந்தத் திரைக்குச் சொல்லப்படவில்லை.',
    nothingFlagged: 'பார்க்க எதுவும் இல்லை',
    devicesTotal: 'சாதனங்கள்', trading: 'விற்பனை செய்யலாம்', blocked: 'தடுக்கப்பட்டது', mustUpgrade: 'புதுப்பிக்க வேண்டும்',
    silent: 'தகவல் அனுப்பவில்லை',
    noPolicy: 'இந்தக் கடை குறைந்தபட்ச பதிப்பை நிர்ணயிக்கவில்லை. எனவே எந்தச் சாதனத்திலும் எதுவும் அமல்படுத்தப்படவில்லை. எல்லா சாதனங்களும் புதுப்பித்த நிலையில் உள்ளன என்பது இதன் பொருள் அல்ல.',
    noRetention: 'எதை எவ்வளவு காலம் வைத்திருப்பது என்று இந்தக் கடை முடிவு செய்யவில்லை. எனவே எதுவும் கணக்கிடப்படவில்லை. நீக்க எதுவும் இல்லை என்பது இதன் பொருள் அல்ல.',
    heldBy: 'தடை உள்ளது', keep: 'வைத்திரு', noRecords: 'பரிசீலிக்க எதுவும் இல்லை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை, எனவே இங்கே எதையும் முடிவு செய்ய முடியாது — வாடிக்கையாளரின் நேரடித் தகவலுக்குள் ஒருவரை அனுமதிப்பது, அதை முடிவு செய்தவரின் பெயரைச் சுமக்கும்.',
    sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
    sampleNotConnected: 'இது மாதிரித் தகவல்; தலைமை அலுவலகத்துடன் இணைக்கப்படவில்லை — காத்திருப்பதாக எதுவும் காட்டப்படவில்லை, இங்கே எதையும் முடிவு செய்ய முடியாது.',
    sessionsTitle: 'உள்ளே அனுமதிக்கப்பட்டவர்கள்',
    requestsNote: 'உதவி நிபுணர் தனது சொந்த உள்நுழைவிலிருந்து தானே கோரிக்கையைப் பதிவு செய்கிறார். இந்தத் திரையில் யாரும் கோரிக்கையையோ அனுமதிப்பவரின் பெயரையோ தட்டச்சு செய்வதில்லை.',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

/** What a device may do — one entry per `DeviceVerdict`, both languages. */
const VERDICT_WORDS = {
  ok: { en: 'up to date', ta: 'புதுப்பித்த நிலையில்' },
  upgrade_available: { en: 'an update is available', ta: 'புதுப்பிப்பு உள்ளது' },
  upgrade_required: { en: 'must be updated before it can sell', ta: 'விற்பனைக்கு முன் புதுப்பிக்க வேண்டும்' },
  blocked: { en: 'BLOCKED — cannot take a sale', ta: 'தடுக்கப்பட்டது — விற்பனை செய்ய முடியாது' },
  unknown: { en: 'this device is not known', ta: 'இந்தச் சாதனம் தெரியவில்லை' },
};

const words = (map, key) => (map[key]?.[lang] ?? map[key]?.en ?? String(key).replace(/_/g, ' '));

/**
 * A stand-in with the same surface as the bundled session, announced whenever it is in use. It is not
 * connected to head office: it shows nothing as waiting and decides nothing — and says so.
 */
function sampleSession() {
  const notConnected = (l) => ({
    tone: 'idle', icon: 'ℹ', label: WORDS[l].sampleNotConnected, announcement: WORDS[l].sampleNotConnected, needsAttention: false,
  });
  return {
    connected: false,
    text: (l, key) => WORDS[l]?.[key] ?? WORDS.en[key] ?? '',
    access: () => [],
    support: () => [],
    outside: (l) => ({
      connected: false, source: notConnected(l), mayDecide: false, cannotDecide: null, waitingKnown: false, waiting: [], sessions: [], liveCount: 0,
    }),
    refreshSupport: async () => ({ kind: 'not_connected' }),
    decideSupport: async () => ({ kind: 'not_connected' }),
    endSupport: async () => ({ kind: 'not_connected' }),
    presentDecideOutcome: (l) => notConnected(l),
    presentEndOutcome: (l) => notConnected(l),
    fleet: () => ({ summary: undefined, verdicts: [], policyKnown: false }),
    retention: () => undefined,
  };
}

const real = window.adminSession;
const session = real ?? sampleSession();
/** The outside-access words — the session's own bilingual copy. */
const st = (key) => session.text(lang, key);
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (whole, name) => values[name] ?? whole);

// ── Navigation ──────────────────────────────────────────────────────────────

const VIEWS = ['support', 'people', 'fleet', 'records'];

function show(name) {
  for (const view of VIEWS) el(`view-${view}`).hidden = view !== name;
  for (const tab of VIEWS) el(`tab-${tab}`).setAttribute('aria-current', tab === name ? 'page' : 'false');
}
for (const name of VIEWS) el(`tab-${name}`).addEventListener('click', () => { show(name); });

function emptyLine(text) {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  return p;
}

/** Paint a status line (tone + icon + words — never colour alone). */
function paintLine(id, presentation) {
  const line = el(id);
  line.hidden = false;
  line.className = `${line.classList.contains('source') ? 'source' : 'result'} tone-${presentation.tone}`;
  el(`${id}-icon`).textContent = presentation.icon;
  el(`${id}-text`).textContent = presentation.label;
  line.setAttribute('aria-label', presentation.announcement || presentation.label);
}

// ── Outside access ──────────────────────────────────────────────────────────

/** The last answer on screen, as a way to say it again — so switching language re-says it in the other one. */
let lastSaid = null;
function say(present) {
  lastSaid = present;
  paintLine('support-result', present(lang));
}

/** One request waiting for the owner's decision: who, why, what, for how long — and, for the owner, the decision. */
function waitingNode(request, view) {
  const li = document.createElement('li');
  li.className = 'wait';
  li.dataset.requestId = request.requestId;

  const what = document.createElement('div');
  what.className = 'what';
  const name = document.createElement('strong');
  name.textContent = `${request.requesterName} — ${fill(st('askedFor'), { minutes: String(request.askedMinutes) })}`;
  const why = document.createElement('small');
  why.textContent = `${st('whyLabel')}: ${request.reason}`;
  const scopes = document.createElement('small');
  // What they want to see, always shown. Blanket access cannot be asked for, so this is never empty.
  scopes.textContent = `${st('wantsToSee')}: ${request.scopes.join(', ')}`;
  const asked = document.createElement('small');
  asked.textContent = `${st('askedBy')}: ${request.requesterName} (${request.requesterId}) · ${st('askedAt')}: ${request.askedAt}`;
  what.append(name, why, scopes, asked);
  li.append(what);

  if (request.ownRequest) {
    // §28: the person who asked never decides it. Shown, never offered.
    const own = document.createElement('p');
    own.className = 'own';
    own.textContent = st('ownRequestRow');
    li.append(own);
    return li;
  }
  if (!view.mayDecide) return li;

  const decide = document.createElement('div');
  decide.className = 'decide';
  const inputId = `minutes-${request.requestId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const label = document.createElement('label');
  label.htmlFor = inputId;
  label.textContent = fill(st('shorterLabel'), { minutes: String(request.askedMinutes) });
  const input = document.createElement('input');
  input.type = 'text';
  input.id = inputId;
  input.className = 'minutes';
  input.inputMode = 'numeric';
  input.autocomplete = 'off';
  input.dataset.requestId = request.requestId;
  const buttons = document.createElement('div');
  buttons.className = 'buttons';
  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'approve';
  approve.textContent = st('approveBtn');
  const reject = document.createElement('button');
  reject.type = 'button';
  reject.className = 'reject';
  reject.textContent = st('rejectBtn');
  // A decision is a HUMAN write that runs ONLY on these explicit clicks, never on load — and names nobody: head
  // office takes the signed-in person as the one who decided.
  approve.addEventListener('click', () => { void busy([approve, reject], () => decideNow(request.requestId, 'approved', input)); });
  reject.addEventListener('click', () => { void busy([approve, reject], () => decideNow(request.requestId, 'rejected', input)); });
  buttons.append(approve, reject);
  decide.append(label, input, buttons);
  li.append(decide);
  return li;
}

/** One support session — live ones drawn as loudly as this product knows how. */
function sessionNode(view, mayDecide) {
  const row = document.createElement('div');
  // Live is drawn as loudly as this product knows how — somebody outside the business is in
  // the data right now, and that is the most serious thing this screen has to say.
  row.className = `row ${view.active ? 'live' : 'over'}`;
  const what = document.createElement('span');
  what.className = 'what';
  const name = document.createElement('strong');
  name.textContent = view.active
    ? `${view.session.requesterName} — ${t('liveNow')} (${view.minutesLeft} ${t('minutesLeft')})`
    : `${view.session.requesterName} — ${t('ended')}`;

  const scopes = document.createElement('small');
  // What they may touch, always shown. Blanket access cannot be granted, so this is never empty.
  scopes.textContent = `${t('maySee')}: ${view.scopes.join(', ')}`;
  const window_ = document.createElement('small');
  const finish = view.active ? '' : ` · ${view.endedAt !== null
    ? fill(st('endedEarlyAt'), { at: view.endedAt })
    : fill(st('ranOutAt'), { at: view.until })}`;
  window_.textContent = `${fill(st('windowWords'), { from: view.from, until: view.until })}${finish}`;
  const detail = document.createElement('small');
  detail.textContent = `${view.session.reason} · ${t('approvedByLabel')} ${view.session.approvedBy}`
    + ` · ${view.actionCount} ${t('actions')}`;

  what.append(name, scopes, window_, detail);
  row.append(what);
  if (view.active && mayDecide) {
    const end = document.createElement('button');
    end.type = 'button';
    end.className = 'danger end';
    end.textContent = st('endBtn');
    end.addEventListener('click', () => { void busy([end], () => endNow(view.session.sessionId)); });
    row.append(end);
  }
  return row;
}

function renderSupport() {
  const view = session.outside(lang);

  paintLine('support-source', view.source);
  el('support-check').hidden = !view.connected;
  el('support-check').textContent = st('checkAgainBtn');

  // Waiting requests are head office's alone: with no head office behind the page, the section is not drawn at all.
  el('support-decisions').hidden = !view.connected;
  el('waiting-title').textContent = st('waitingTitle');
  el('waiting-lead').textContent = st('waitingLead');
  const cannot = el('cannot-decide');
  // Said whenever there is something this person would otherwise act on: a waiting request, or a live session to end.
  cannot.hidden = view.cannotDecide === null || (view.waiting.length === 0 && view.liveCount === 0);
  cannot.textContent = view.cannotDecide ?? '';
  const nothing = el('nothing-waiting');
  // "Nobody is waiting" only when head office SAID so — before it answers, the list is not known, not empty (P-08).
  nothing.hidden = !view.waitingKnown || view.waiting.length > 0;
  nothing.textContent = st('nothingWaiting');
  // Minutes being typed survive a repaint (a language switch, a re-read) — the figure is the owner's, not the page's.
  const typed = new Map([...document.querySelectorAll('#waiting-list input.minutes')].map((i) => [i.dataset.requestId, i.value]));
  el('waiting-list').replaceChildren(...view.waiting.map((request) => waitingNode(request, view)));
  for (const input of document.querySelectorAll('#waiting-list input.minutes')) {
    const before = typed.get(input.dataset.requestId);
    if (before !== undefined) input.value = before;
  }

  el('sessions-title').textContent = st('sessionsTitle');
  el('support-list').replaceChildren(...(view.sessions.length === 0
    ? [emptyLine(t('noSupport'))]
    : view.sessions.map((s) => sessionNode(s, view.mayDecide))));
  el('requests-note').textContent = st('requestsNote');
}

/** One press at a time: the buttons are disabled while their step runs, so a double press never decides twice. */
async function busy(buttons, step) {
  if (buttons.some((b) => b.disabled)) return;
  for (const b of buttons) b.disabled = true;
  try { await step(); } finally { for (const b of buttons) b.disabled = false; }
}

// Approve or reject — ONLY from an explicit click. The session refuses the cheap things (nobody named, no authority,
// not connected, minutes longer than asked) before any POST; head office decides the rest, and the list is read again.
async function decideNow(requestId, decision, input) {
  const outcome = await session.decideSupport(requestId, decision, input.value);
  say((l) => session.presentDecideOutcome(l, outcome));
  if (outcome.kind === 'approved' || outcome.kind === 'rejected') input.value = '';
  renderSupport();
  if (outcome.kind === 'minutes_unreadable' || outcome.kind === 'longer_than_asked') {
    const again = [...document.querySelectorAll('#waiting-list input.minutes')].find((i) => i.dataset.requestId === requestId);
    again?.focus();
  }
}

// End a live session early — ONLY from an explicit click, in the owner's own session.
async function endNow(sessionId) {
  const outcome = await session.endSupport(sessionId);
  say((l) => session.presentEndOutcome(l, outcome));
  renderSupport();
}

/** Read head office's state (a GET — writes nothing). Offline, the page says so and keeps what it last knew. */
async function refreshSupport() {
  if (!session.connected) return;
  await session.refreshSupport();
  renderSupport();
}

el('support-check').addEventListener('click', () => { void busy([el('support-check')], refreshSupport); });

// ── Who can get in ──────────────────────────────────────────────────────────

function renderPeople() {
  const rows = session.access();
  el('people-list').replaceChildren(...(rows.length === 0
    ? [emptyLine(t('noAccounts'))]
    : rows.map((account) => {
      const row = document.createElement('div');
      row.className = `row ${account.flags.length > 0 ? 'flagged' : 'clean'}`;
      const what = document.createElement('span');
      what.className = 'what';
      const name = document.createElement('strong');
      name.textContent = `${account.fullName} (${account.username})`;
      const sub = document.createElement('small');
      // The flags in words — never a coloured dot on its own.
      sub.textContent = account.flags.length > 0 ? account.flags.join(' · ') : t('nothingFlagged');
      what.append(name, sub);
      row.append(what);
      return row;
    })));
}

// ── Tills and devices ───────────────────────────────────────────────────────

function renderFleet() {
  const fleet = session.fleet();
  const box = el('fleet-summary');
  box.replaceChildren();

  if (!fleet.policyKnown) {
    // Judging a fleet against a minimum nobody set would report it compliant with a rule the
    // shop never made. Said out loud instead.
    box.append(emptyLine(t('noPolicy')));
    el('fleet-list').replaceChildren();
    return;
  }
  const s = fleet.summary;
  for (const [label, value] of [
    [t('devicesTotal'), s.total], [t('trading'), s.trading],
    [t('blocked'), s.blocked], [t('mustUpgrade'), s.mustUpgrade], [t('silent'), s.silent],
  ]) {
    const line = document.createElement('small');
    line.textContent = `${label}: ${value}`;
    box.append(line);
  }

  el('fleet-list').replaceChildren(...fleet.verdicts.map((decision) => {
    const row = document.createElement('div');
    row.className = `row ${decision.mayTrade ? 'clean' : 'flagged'}`;
    const what = document.createElement('span');
    what.className = 'what';
    const name = document.createElement('strong');
    name.textContent = decision.deviceId;
    const sub = document.createElement('small');
    sub.textContent = `${words(VERDICT_WORDS, decision.verdict)} · ${decision.detail}`;
    what.append(name, sub);
    row.append(what);
    return row;
  }));
}

// ── Records kept ────────────────────────────────────────────────────────────

function renderRecords() {
  const plan = session.retention();
  if (plan === undefined) {
    // A shop that has never decided is not a shop with nothing to delete.
    el('records-list').replaceChildren(emptyLine(t('noRetention')));
    return;
  }
  el('records-list').replaceChildren(...(plan.decisions.length === 0
    ? [emptyLine(t('noRecords'))]
    : plan.decisions.map((decision) => {
      const row = document.createElement('div');
      row.className = `row ${decision.outcome === 'legal_hold' ? 'held' : 'clean'}`;
      const what = document.createElement('span');
      what.className = 'what';
      const name = document.createElement('strong');
      name.textContent = `${decision.objectType} ${decision.objectId}`;
      const sub = document.createElement('small');
      sub.textContent = decision.explanation;
      what.append(name, sub);
      row.append(what);
      return row;
    })));
}

// ── Language and chrome ─────────────────────────────────────────────────────

function paintChrome() {
  el('who').firstChild.textContent = `${t('title')} `;
  el('whoami').textContent = window.adminData?.userId ?? '';
  for (const [id, key] of [
    ['tab-support', 'support'], ['tab-people', 'people'], ['tab-fleet', 'fleet'], ['tab-records', 'records'],
    ['support-title', 'support'], ['support-lead', 'supportLead'],
    ['people-title', 'people'], ['people-lead', 'peopleLead'],
    ['fleet-title', 'fleet'], ['fleet-lead', 'fleetLead'],
    ['records-title', 'records'], ['records-lead', 'recordsLead'],
    ['sample', 'sampleData'],
  ]) {
    el(id).textContent = t(key);
  }

  const nobody = el('nobody');
  nobody.hidden = window.adminData?.userId !== undefined;
  nobody.textContent = nobody.hidden ? '' : t('nobodyNamed');

  renderSupport();
  renderPeople();
  renderFleet();
  renderRecords();
}

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintChrome();
  // The answer already on screen is said again in the language just chosen.
  if (lastSaid !== null) paintLine('support-result', lastSaid(lang));
});

// ── Boot ────────────────────────────────────────────────────────────────────

el('sample').hidden = real !== undefined;
paintChrome();
show('support');
// Head office's waiting requests and sessions — a GET, read once the page is up. Nothing is written on load.
void refreshSupport();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
