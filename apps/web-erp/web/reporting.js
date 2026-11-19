// Reports — the view layer. Every rule lives in the TESTED session model
// (`apps/web-erp/src/reporting-session.ts`), attached as `window.reportingSession`.
//
// ── The decision this screen is built around ────────────────────────────────
//
// **The reports this shop cannot run have a tab of their own, as prominent as the ones it can.**
// A reporting screen listing only what works looks finished: somebody asks for shrinkage, finds
// nothing, and concludes either that the shop has none or that the software forgot. Neither
// reading can be corrected by anybody looking at the screen.
//
// So every report D13 names is listed, and one that cannot be produced says which fact the shop is
// not recording — in the shop's own words, because the person reading it is the person who can
// decide to start recording it.
//
// ── And the two that follow ─────────────────────────────────────────────────
//
// **No number without the moment it was true.** The as-at sits under every figure, and a stale one
// is coloured AND says so in words — colour alone is unreadable to one man in twelve, and this is a
// screen people quote from.
//
// **A figure that cannot be computed says why, in the space where the number would have been.** It
// is never a zero and never a blank.
//
// No `prompt`, `confirm` or `alert`; the banner does not fade.

const el = (id) => document.getElementById(id);

const inr = (minor) =>
  '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Words ───────────────────────────────────────────────────────────────────

const WORDS = {
  en: {
    title: 'Reports',
    reports: 'Reports', cannotRun: 'Cannot be run yet', whatNext: 'What to record next',
    reportsLead: 'Everything this shop can report on today. Every number says when it was true.',
    blockedLead: 'These are listed on purpose. Each one says why: either the shop is not recording a fact yet, or this version of the software cannot work it out yet. Running them and showing nought would be worse than not offering them.',
    backlogLead: 'Start recording these and the reports beside them start working. Ordered by how many each one unlocks on its own.',
    rowsTitle: 'The rows behind these figures', noRows: 'No rows behind this one.',
    exportIt: 'Write this out to a file',
    exportNote: 'The file carries its own column list, and personal data is removed unless you are allowed to see it.',
    back: 'Back to the list', run: 'Run',
    notAvailable: 'Not available', unlocks: 'reports start working',
    nothingBlocked: 'Every report this shop needs can be run.',
    nothingToRecord: 'Nothing else needs recording — every report works.',
    nothingYouCanDo: 'Nothing else you record will unlock a report in this version. The ones still listed as unavailable are waiting on us, not on the shop.',
    noReports: 'This screen has not been told what this shop records, so it can run nothing.',
    live: 'current', lagging: 'a few minutes behind, catching up',
    stale: 'too old to make a decision on',
    lastSpoke: 'Head office last spoke to this shop', neverSpoke: 'Head office has never sent anything to this shop',
    minutesAgo: 'minutes ago', asAt: 'as at', neverHeard: 'never — nothing has arrived yet',
    exported: 'File written', exportedNote: 'rows, with the column list beside them.',
    ok: 'OK', read: 'Please read this',
    sampleData: 'Sample data — this is not your shop.',
    // W1: the summary cards, the report finder and the rows register
    cardReady: 'Reports you can run', cardBlocked: 'Cannot be run yet', cardBacklog: 'Facts to start recording', cardNote: 'from what this shop records',
    findReport: 'Find a report', noReportMatches: 'No report matches those words.', rowsLabel: 'The rows behind this report',
    notFed: 'This page has not been told what this shop records, so it does not know which reports can run. Nothing is shown as ready or as clear.',
    // UI-3: what a report covers, and its chart
    covers: 'Store {store} · trading day {day} · read from the store computer at {time}', notToldStore: 'not told',
    chartBy: 'By', chartTaken: 'Taken', chartUnits: 'Items sold', chartToday: 'today',
    // Batch 18b · O1 / O3: the period picker, what a report covers, and a department's items
    periodLabel: 'Period', p_today: 'Today', p_yesterday: 'Yesterday', p_this_week: 'This week (Monday to today)', p_last_week: 'Last week (Monday to Sunday)',
    p_this_month: 'This month', p_last_month: 'Last month', p_custom: 'From – to (choose the days)', periodFrom: 'From', periodTo: 'To', periodShow: 'Show',
    periodToday: 'today, {day}', periodRange: '{from} to {to}', periodOne: '{day}',
    coversPeriod: 'Store {store} · {period} · read from the store computer at {time}',
    periodNotKnownBefore: 'Not known before {day} — this store computer holds sales from that day, so the figures start there.',
    periodStopsAtToday: 'The period runs past today; the figures stop at today.',
    periodNotKnown: 'Not known for this period — {why}.',
    periodRefused: 'The period asked for could not be read ({why}). These are today\'s figures.',
    periodBadDates: 'Choose both days as day/month/year, the first on or before the second.',
    periodShowing: 'Showing: {period}',
    itemsIn: 'Items in {dept}', itemCol: 'Item', itemsCol: 'Items', weighedCol: 'Weighed', takenCol: 'Taken', marginCol: 'Margin', marginPctCol: 'Margin %',
    itemsLabel: 'Each item in this department', noItems: 'This store computer did not send the items for this department.',
  },
  ta: {
    title: 'அறிக்கைகள்',
    reports: 'அறிக்கைகள்', cannotRun: 'இன்னும் இயக்க முடியாதவை', whatNext: 'அடுத்து என்ன பதிவு செய்ய வேண்டும்',
    reportsLead: 'இன்று இந்தக் கடை என்ன அறிக்கை தர முடியும். ஒவ்வொரு எண்ணும் அது எப்போது உண்மையாக இருந்தது என்று சொல்லும்.',
    blockedLead: 'இவை வேண்டுமென்றே பட்டியலிடப்பட்டுள்ளன. ஒவ்வொன்றும் காரணத்தைச் சொல்கிறது: கடை ஒரு தகவலைப் பதிவு செய்யவில்லை, அல்லது இந்தப் பதிப்பால் இன்னும் அதைக் கணக்கிட முடியவில்லை. பூஜ்ஜியம் காட்டுவது இதைவிட மோசம்.',
    backlogLead: 'இவற்றைப் பதிவு செய்யத் தொடங்கினால் பக்கத்தில் உள்ள அறிக்கைகள் வேலை செய்யத் தொடங்கும். ஒவ்வொன்றும் தனியாக எத்தனை அறிக்கைகளைத் திறக்கிறது என்ற வரிசையில்.',
    rowsTitle: 'இந்த எண்களுக்குப் பின்னால் உள்ள வரிகள்', noRows: 'இதற்குப் பின்னால் வரிகள் இல்லை.',
    exportIt: 'இதை ஒரு கோப்பாக எழுது',
    exportNote: 'கோப்பு அதன் சொந்த நெடுவரிசைப் பட்டியலைக் கொண்டு வரும். அனுமதி இல்லாவிட்டால் தனிப்பட்ட தகவல் நீக்கப்படும்.',
    back: 'பட்டியலுக்குத் திரும்பு', run: 'இயக்கு',
    notAvailable: 'கிடைக்கவில்லை', unlocks: 'அறிக்கைகள் வேலை செய்யத் தொடங்கும்',
    nothingBlocked: 'இந்தக் கடைக்குத் தேவையான எல்லா அறிக்கைகளையும் இயக்க முடியும்.',
    nothingToRecord: 'வேறு எதுவும் பதிவு செய்யத் தேவையில்லை — எல்லா அறிக்கைகளும் வேலை செய்கின்றன.',
    nothingYouCanDo: 'நீங்கள் வேறு எதைப் பதிவு செய்தாலும் இந்தப் பதிப்பில் புதிய அறிக்கை திறக்காது. இன்னும் கிடைக்காதவை எங்களை நம்பியுள்ளன, கடையை அல்ல.',
    noReports: 'இந்தக் கடை என்ன பதிவு செய்கிறது என்று இந்தத் திரைக்குத் தெரியவில்லை. எனவே எதையும் இயக்க முடியாது.',
    live: 'தற்போதையது', lagging: 'சில நிமிடங்கள் பின்தங்கியுள்ளது, பிடிக்கிறது',
    stale: 'முடிவு எடுக்க முடியாத அளவுக்குப் பழையது',
    lastSpoke: 'தலைமை அலுவலகம் கடைசியாகப் பேசியது', neverSpoke: 'தலைமை அலுவலகம் இந்தக் கடைக்கு இதுவரை எதுவும் அனுப்பவில்லை',
    minutesAgo: 'நிமிடங்களுக்கு முன்', asAt: 'இந்த நேரத்தில்', neverHeard: 'ஒருபோதும் இல்லை — இன்னும் எதுவும் வரவில்லை',
    exported: 'கோப்பு எழுதப்பட்டது', exportedNote: 'வரிகள், நெடுவரிசைப் பட்டியலுடன்.',
    ok: 'சரி', read: 'இதைப் படிக்கவும்',
    sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
    cardReady: 'இயக்கக்கூடிய அறிக்கைகள்', cardBlocked: 'இன்னும் இயக்க முடியாதவை', cardBacklog: 'பதிவு செய்யத் தொடங்க வேண்டியவை', cardNote: 'இந்தக் கடை பதிவு செய்வதிலிருந்து',
    findReport: 'ஒரு அறிக்கையைத் தேடு', noReportMatches: 'அந்தச் சொற்களுக்குப் பொருந்தும் அறிக்கை இல்லை.', rowsLabel: 'இந்த அறிக்கைக்குப் பின்னால் உள்ள வரிகள்',
    notFed: 'இந்தக் கடை என்ன பதிவு செய்கிறது என்று இந்தப் பக்கத்திற்குச் சொல்லப்படவில்லை, எனவே எந்த அறிக்கைகள் இயங்கும் என்று தெரியாது. எதுவும் தயார் என்றோ சரி என்றோ காட்டப்படவில்லை.',
    covers: 'கடை {store} · வணிக நாள் {day} · கடை கணினியிலிருந்து படித்த நேரம் {time}', notToldStore: 'சொல்லப்படவில்லை',
    chartBy: 'வாரியாக', chartTaken: 'வசூல்', chartUnits: 'விற்ற பொருட்கள்', chartToday: 'இன்று',
    periodLabel: 'காலம்', p_today: 'இன்று', p_yesterday: 'நேற்று', p_this_week: 'இந்த வாரம் (திங்கள் முதல் இன்று வரை)', p_last_week: 'கடந்த வாரம் (திங்கள் முதல் ஞாயிறு வரை)',
    p_this_month: 'இந்த மாதம்', p_last_month: 'கடந்த மாதம்', p_custom: 'தேதி முதல் – வரை (நாட்களைத் தேர்வு செய்க)', periodFrom: 'முதல்', periodTo: 'வரை', periodShow: 'காட்டு',
    periodToday: 'இன்று, {day}', periodRange: '{from} முதல் {to} வரை', periodOne: '{day}',
    coversPeriod: 'கடை {store} · {period} · கடை கணினியிலிருந்து படித்த நேரம் {time}',
    periodNotKnownBefore: '{day} க்கு முன் தெரியவில்லை — இந்தக் கடை கணினியில் அந்த நாளிலிருந்துதான் விற்பனை உள்ளது, எனவே எண்கள் அங்கிருந்து தொடங்குகின்றன.',
    periodStopsAtToday: 'காலம் இன்றைக்குப் பின்னும் நீள்கிறது; எண்கள் இன்றுடன் நிற்கின்றன.',
    periodNotKnown: 'இந்தக் காலத்திற்குத் தெரியவில்லை — {why}.',
    periodRefused: 'கேட்ட காலத்தைப் படிக்க முடியவில்லை ({why}). இவை இன்றைய எண்கள்.',
    periodBadDates: 'இரண்டு நாட்களையும் நாள்/மாதம்/ஆண்டு எனத் தேர்வு செய்க; முதலாவது இரண்டாவதற்கு முன் அல்லது அதே நாள்.',
    periodShowing: 'காட்டப்படுவது: {period}',
    itemsIn: '{dept} இல் உள்ள பொருட்கள்', itemCol: 'பொருள்', itemsCol: 'பொருட்கள்', weighedCol: 'எடை', takenCol: 'வசூல்', marginCol: 'லாப வரம்பு', marginPctCol: 'லாப வரம்பு %',
    itemsLabel: 'இந்தத் துறையின் ஒவ்வொரு பொருளும்', noItems: 'இந்தத் துறையின் பொருட்களைக் கடை கணினி அனுப்பவில்லை.',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

/** Why a report could not be run — one entry per `RunRefusal`, in both languages. */
const RUN_REFUSAL_WORDS = {
  no_such_report: {
    en: 'There is no report by that name.',
    ta: 'அந்தப் பெயரில் அறிக்கை எதுவும் இல்லை.',
  },
  this_shop_does_not_record_that_yet: {
    en: 'This shop does not record what that report needs yet. Showing it as nought would be a number somebody acts on.',
    ta: 'அந்த அறிக்கைக்குத் தேவையானதை இந்தக் கடை இன்னும் பதிவு செய்யவில்லை. பூஜ்ஜியம் காட்டினால் அதை ஒருவர் நம்பி முடிவெடுப்பார்.',
  },
  // A different problem with a different owner: the shop has done its part and the software has
  // not. Saying "this shop does not record that" here would put a job on the owner's list that no
  // amount of work in the shop can ever finish.
  this_version_cannot_produce_that_yet: {
    en: 'This shop records everything that report needs. This version of the software cannot work it out yet — that is our job, not yours.',
    ta: 'அந்த அறிக்கைக்குத் தேவையான எல்லாவற்றையும் இந்தக் கடை பதிவு செய்கிறது. இந்தப் பதிப்பால் இன்னும் அதைக் கணக்கிட முடியவில்லை — அது எங்கள் வேலை, உங்களுடையது அல்ல.',
  },
};

/** How current a figure is — one entry per `Staleness`, in both languages. */
const STALENESS_WORDS = {
  live: { en: 'current', ta: 'தற்போதையது' },
  lagging: { en: 'a few minutes behind, catching up', ta: 'சில நிமிடங்கள் பின்தங்கியுள்ளது' },
  stale: { en: 'too old to make a decision on', ta: 'முடிவு எடுக்க முடியாத அளவுக்குப் பழையது' },
};

const words = (map, key) => (map[key]?.[lang] ?? map[key]?.en ?? String(key).replace(/_/g, ' '));

/** A stand-in with the same surface as the bundled session, announced whenever it is in use. */
function sampleSession() {
  return {
    catalogue: () => [],
    backlog: () => [],
    freshness: () => ({ lastSyncedAt: null, asOf: '', ageSeconds: null, state: 'missing' }),
    run: () => ({ ok: false, refusal: 'no_such_report', detail: 'this is sample data', missing: [] }),
    export: () => ({ ok: false, detail: 'this is sample data' }),
  };
}

const real = window.reportingSession;
// U3 (OB-699, 7 Nov 2026): a report's name and purpose and a figure's name are the product's own words — carried in both
// languages from the catalogue and the one figure-name table (the bundle hands the table's reader to this page); a
// finding ("why" a report cannot run) stays as head office or the box said it.
const reportName = (r) => (lang === 'ta' && typeof r.nameTa === 'string' && r.nameTa !== '' ? r.nameTa : r.name);
const reportAnswers = (r) => (lang === 'ta' && typeof r.answersTa === 'string' && r.answersTa !== '' ? r.answersTa : r.answers);
const figureName = (name) => (typeof window.figureNameIn === 'function' ? window.figureNameIn(lang, name) : name);
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

const VIEWS = ['reports', 'blocked', 'backlog', 'report'];
const TABS = ['reports', 'blocked', 'backlog'];

function show(name) {
  for (const view of VIEWS) el(`view-${view}`).hidden = view !== name;
  for (const tab of TABS) el(`tab-${tab}`).setAttribute('aria-current', tab === name ? 'page' : 'false');
}
for (const name of TABS) el(`tab-${name}`).addEventListener('click', () => { show(name); });
el('back').addEventListener('click', () => { show('reports'); });

// ── How current everything here is ──────────────────────────────────────────

function renderFreshness() {
  const strip = el('freshness');
  // D-10 (OB-773 · P-08): a page showing the SAMPLE has no freshness of its own — "head office has never sent anything"
  // over sample figures contradicts the sample line and the store-copy line. The sample line (and the chrome's word
  // under it) says the one true thing; this strip stays out of it.
  strip.hidden = real === undefined;
  if (real === undefined) return;
  const state = session.freshness();
  strip.className = `freshness ${state.state}`;
  // A number quoted three hours after the sync stopped looks exactly like a live one, so this sits
  // at the very top of the page rather than beside any one figure.
  strip.textContent = state.ageSeconds === null
    ? t('neverSpoke')
    : `${t('lastSpoke')} ${Math.round(state.ageSeconds / 60)} ${t('minutesAgo')}`;
}

// ── The catalogue ───────────────────────────────────────────────────────────

let openReportId = null;

function renderCatalogue() {
  const all = session.catalogue();
  const ready = all.filter((e) => e.availability.available);
  const blocked = all.filter((e) => !e.availability.available);
  // W1 (P-08): a page the store computer did not feed knows nothing — it says so in every list and every card, and never
  // "every report can be run" or "nothing else needs recording" (that would be an all-clear it was never given).
  const fed = real !== undefined;
  paintCards(fed ? ready.length : null, fed ? blocked.length : null, fed ? session.backlog().length : null);
  if (!fed) {
    for (const id of ['reports-list', 'blocked-list', 'backlog-list']) el(id).replaceChildren(emptyLine(t('notFed')));
    return;
  }

  el('reports-list').replaceChildren(...(ready.length === 0
    ? [emptyLine(t('noReports'))]
    : ready.map((entry) => reportRow(entry, true))));

  el('blocked-list').replaceChildren(...(blocked.length === 0
    ? [emptyLine(t('nothingBlocked'))]
    : blocked.map((entry) => reportRow(entry, false))));

  const backlog = session.backlog();
  // An empty backlog means two very different things, and reading the wrong one is the kind of
  // mistake nobody on the screen can correct: either every report works, or this shop has already
  // recorded everything the reports it CAN run need, and the ones still missing are waiting on us.
  const nothingLeft = blocked.length === 0 ? t('nothingToRecord') : t('nothingYouCanDo');
  el('backlog-list').replaceChildren(...(backlog.length === 0
    ? [emptyLine(nothingLeft)]
    : backlog.map((row) => {
      const item = document.createElement('div');
      item.className = 'row blocked';
      const what = document.createElement('span');
      what.className = 'what';
      const name = document.createElement('strong');
      // The producer in the shop's own language. "no waste_events producer" tells nobody anything.
      name.textContent = row.producer.replace(/_/g, ' ');
      const sub = document.createElement('small');
      sub.textContent = `${row.unlocks} ${t('unlocks')}: ${row.reports.join(', ')}`;
      what.append(name, sub);
      item.append(what);
      return item;
    })));
}

function emptyLine(text) {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  return p;
}

// ── W1: the shared summary cards and the report finder (window.sreOffice, from the chrome) ───────────────────────
const office = () => window.sreOffice ?? null;
let cardCounts = [null, null, null];
function paintCards(ready, blocked, backlog) {
  cardCounts = [ready, blocked, backlog];
  const o = office();
  if (!o) return;
  o.cards(el('report-cards'), [
    { label: t('cardReady'), value: ready, note: t('cardNote'), tone: ready === null ? undefined : 'ok', icon: 'chart-column' },
    { label: t('cardBlocked'), value: blocked, note: t('cardNote'), tone: blocked ? 'pending' : undefined, icon: 'circle-help' },
    { label: t('cardBacklog'), value: backlog, note: t('cardNote'), icon: 'list-plus' },
  ]);
}
document.addEventListener('sre:chrome', () => { paintPeriod(); paintCards(...cardCounts); if (openReportId !== null) { const o = session.run(openReportId); if (o.ok) renderReport(o); } });
/** The report finder: every word typed must be in a report's name or what it answers; the list says when none match. */
function findReports() {
  const words = el('find-report').value.trim().toLowerCase().split(/\s+/).filter((w) => w !== '');
  let shown = 0;
  for (const row of el('reports-list').querySelectorAll('.row')) {
    const hit = words.every((w) => row.textContent.toLowerCase().includes(w));
    row.hidden = !hit;
    if (hit) shown += 1;
  }
  const none = el('find-none');
  none.hidden = words.length === 0 || shown > 0;
  none.textContent = t('noReportMatches');
}
el('find-report').addEventListener('input', findReports);

function reportRow(entry, ready) {
  const row = document.createElement('div');
  // Three states, not two. A report waiting on us looks different from one waiting on the shop,
  // because only one of them is something the person reading this can do anything about.
  row.className = `row ${ready ? 'ready' : entry.availability.blockedBy === 'this_version_cannot_produce_it' ? 'ours' : 'blocked'}`;

  const what = document.createElement('span');
  what.className = 'what';
  const name = document.createElement('strong');
  name.textContent = reportName(entry.report);
  const sub = document.createElement('small');
  // A blocked report says WHICH fact is missing, not "no data".
  sub.textContent = ready ? reportAnswers(entry.report) : entry.availability.why;
  what.append(name, sub);
  row.append(what);

  if (ready) {
    const open = document.createElement('button'); open.classList.add('sre-btn');
    open.type = 'button';
    open.textContent = t('run');
    open.addEventListener('click', () => { openReport(entry.report.id); });
    row.append(open);
  }
  return row;
}

// ── One report ──────────────────────────────────────────────────────────────

function openReport(reportId) {
  const outcome = session.run(reportId);
  if (!outcome.ok) {
    tell(t('read'), `${words(RUN_REFUSAL_WORDS, outcome.refusal)} ${outcome.detail}`);
    return;
  }
  openReportId = reportId;
  show('report');
  renderReport(outcome);
}

// ── UI-3: what a report covers, and its chart ─────────────────────────────────────────────────────────────────────
// OB-607: a moment at the SHOP's clock (the zone the store computer served), never the reader's device clock or raw UTC.
const shopTime = (at) => (at ? window.sreShopDay?.dateTimeOf(at) || at : '');
const fillIn = (text, values) => Object.entries(values).reduce((w, [k, v]) => w.split(`{${k}}`).join(String(v)), text);
function coversLine() {
  const d = window.reportingData ?? {};
  // Batch 18b · O1: EXACTLY the period the figures cover, and what is not known in it.
  if (real !== undefined && typeof session.period === 'function') {
    return fillIn(t('coversPeriod'), { store: d.storeName || d.branchId || d.storeId || t('notToldStore'), period: periodWords(session.period()), time: shopTime(d.now) || t('notToldStore') });
  }
  return fillIn(t('covers'), { store: d.storeName || d.branchId || d.storeId || t('notToldStore'), day: d.tradingDay || t('notToldStore'), time: shopTime(d.now) || t('notToldStore') });
}

// ── Batch 18b · O1 (M29-FR-02): Reports for a past day, week or month ─────────────────────────────────────────────────
// The picker asks the store computer for the period in the page's own address (`?period=last_week&from=…&to=…`); the store
// computer works the figures out from its own sales log (no internet needed) and says exactly which days they cover. The
// week runs Monday to Sunday (OB-869).
const PRESETS = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'custom'];
const dayWords = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso ?? '') ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : (iso ?? ''));
const isoOf = (d) => d.toISOString().slice(0, 10);
const dayAt = (iso) => new Date(`${iso}T00:00:00Z`);
const addDays = (iso, n) => { const d = dayAt(iso); d.setUTCDate(d.getUTCDate() + n); return isoOf(d); };
/** A preset's days, from the shop's own today (the trading day the store computer served). */
function presetDays(preset, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today ?? '')) return null;
  const weekday = (dayAt(today).getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  const monday = addDays(today, -weekday);
  const first = `${today.slice(0, 8)}01`;
  const lastMonthEnd = addDays(first, -1);
  switch (preset) {
    case 'today': return { from: today, to: today };
    case 'yesterday': return { from: addDays(today, -1), to: addDays(today, -1) };
    case 'this_week': return { from: monday, to: today };
    case 'last_week': return { from: addDays(monday, -7), to: addDays(monday, -1) };
    case 'this_month': return { from: first, to: today };
    case 'last_month': return { from: `${lastMonthEnd.slice(0, 8)}01`, to: lastMonthEnd };
    default: return null;
  }
}
const PAGE_QUERY = new URLSearchParams(location.search);
const askedPreset = () => (PRESETS.includes(PAGE_QUERY.get('period') ?? '') ? PAGE_QUERY.get('period') : (PAGE_QUERY.get('from') ? 'custom' : 'today'));
function periodWords(cover) {
  if (!cover) return '';
  const preset = askedPreset();
  const named = preset !== 'custom' && preset !== 'today' ? ` (${t(`p_${preset}`)})` : '';
  const parts = [];
  if (cover.todayOnly) parts.push(fillIn(t('periodToday'), { day: dayWords(cover.asked.from) }));
  else {
    const span = cover.covered ?? cover.asked;
    parts.push(`${span.from === span.to ? fillIn(t('periodOne'), { day: dayWords(span.from) }) : fillIn(t('periodRange'), { from: dayWords(span.from), to: dayWords(span.to) })}${named}`);
  }
  if (cover.refused) parts.push(fillIn(t('periodRefused'), { why: cover.refused }));
  if (cover.covered === null) parts.push(fillIn(t('periodNotKnown'), { why: cover.notKnownWhy ?? '' }));
  if (cover.notKnownBefore) parts.push(fillIn(t('periodNotKnownBefore'), { day: dayWords(cover.notKnownBefore) }));
  if (cover.stopsAtToday) parts.push(t('periodStopsAtToday'));
  return parts.join(' ');
}
function paintPeriod() {
  const host = el('period-bar');
  if (!host) return;
  host.hidden = real === undefined;
  if (real === undefined) return;
  el('period-label').textContent = t('periodLabel');
  const pick = el('period-pick');
  const chosen = pick.dataset.painted === '1' ? pick.value : askedPreset();
  pick.replaceChildren(...PRESETS.map((p) => { const o = document.createElement('option'); o.value = p; o.textContent = t(`p_${p}`); return o; }));
  pick.value = chosen;
  pick.dataset.painted = '1';
  el('period-show').textContent = t('periodShow');
  const custom = el('period-custom');
  custom.hidden = pick.value !== 'custom';
  const o = office();
  const today = window.reportingData?.tradingDay ?? '';
  const asked = session.period?.()?.asked ?? { from: today, to: today };
  for (const [id, key, value] of [['period-from', 'periodFrom', PAGE_QUERY.get('from') ?? asked.from], ['period-to', 'periodTo', PAGE_QUERY.get('to') ?? asked.to]]) {
    const holder = el(`${id}-host`);
    if (holder.dataset.painted === '1') continue;
    if (o && typeof o.dateField === 'function') {
      holder.replaceChildren(o.dateField({ id, label: { en: WORDS.en[key], ta: WORDS.ta[key] }, max: today || undefined, value }));
      holder.dataset.painted = '1';
    } else if (!el(id)) {
      const l = document.createElement('label'); l.htmlFor = id; l.textContent = t(key);
      const i = document.createElement('input'); i.type = 'date'; i.id = id; i.className = 'sre-input'; i.value = value; if (today) i.max = today;
      holder.replaceChildren(l, i);
    }
  }
  el('period-says').textContent = fillIn(t('periodShowing'), { period: periodWords(session.period?.()) });
}
function chosenDays() {
  const pick = el('period-pick').value;
  if (pick !== 'custom') return presetDays(pick, window.reportingData?.tradingDay ?? '');
  const o = office();
  const read = (id) => (o && typeof o.dateOf === 'function' ? o.dateOf(id) : null) ?? (el(id)?.value || null);
  const from = read('period-from');
  const to = read('period-to');
  return from && to && from <= to ? { from, to } : null;
}
function showPeriod() {
  const pick = el('period-pick').value;
  if (pick === 'today') { location.search = ''; return; }
  const days = chosenDays();
  if (days === null) { el('period-says').textContent = t('periodBadDates'); return; }
  const q = new URLSearchParams({ period: pick, from: days.from, to: days.to });
  location.search = `?${q.toString()}`;
}
el('period-pick').addEventListener('change', () => { el('period-custom').hidden = el('period-pick').value !== 'custom'; });
el('period-show').addEventListener('click', showPeriod);

/**
 * The reports whose point is a comparison or a figure over time get a chart, drawn from the report's OWN rows (never a
 * second sum). `columns` = over time, in order; `bars` = a comparison, largest first as the report already orders it.
 */
const CHARTS = {
  sales_by_hour: { kind: 'columns', key: 'key', value: 'totalMinor', money: true },
  day_on_day: { kind: 'columns', key: 'tradingDay', value: 'totalMinor', money: true, oldestFirst: true },
  sales_by_cashier: { kind: 'bars', key: 'key', value: 'totalMinor', money: true },
  tender_mix: { kind: 'bars', key: 'key', value: 'totalMinor', money: true },
  units_by_category: { kind: 'bars', key: 'department', value: 'units', money: false },
};
// D-057: a department report that carries the money its lines took is drawn in rupees, largest first.
const DEPARTMENT_MONEY = { kind: 'bars', key: 'department', value: 'takenMinor', money: true };
function renderReportChart(outcome) {
  const host = el('report-chart');
  host.replaceChildren();
  const how = outcome.report.id === 'units_by_category' && outcome.rows.some((r) => r.takenMinor !== undefined) ? DEPARTMENT_MONEY : CHARTS[outcome.report.id];
  if (how === undefined || window.sreCharts === undefined) return;
  const number = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const rows = (how.oldestFirst ? [...outcome.rows].sort((a, b) => String(a[how.key]).localeCompare(String(b[how.key]))) : outcome.rows).map((r) => {
    const value = number(r[how.value]);
    const label = String(r[how.key]);
    return {
      key: String(r[how.key]), label, value,
      ...(value === null ? {} : { text: how.money ? inr(value) : String(value) }),
      ...(how.oldestFirst && r[how.key] === window.reportingData?.tradingDay ? { mark: t('chartToday') } : {}),
    };
  });
  window.sreCharts.draw(host, {
    id: outcome.report.id, kind: how.kind, title: reportName(outcome.report),
    covers: coversLine(),
    labelHeading: t('chartBy'), valueHeading: how.money ? t('chartTaken') : t('chartUnits'), rows,
  }, lang);
}

function renderReport(outcome) {
  el('report-title').textContent = reportName(outcome.report);
  el('report-answers').textContent = reportAnswers(outcome.report);
  el('report-covers').textContent = coversLine();
  renderReportChart(outcome);
  el('rows-title').textContent = t('rowsTitle');
  el('export').textContent = t('exportIt');
  el('export-note').textContent = t('exportNote');
  el('back').textContent = t('back');

  el('report-figures').replaceChildren(...outcome.result.figures.map(figureBox));

  if (outcome.rows.length === 0) {
    el('report-rows').replaceChildren(emptyLine(t('noRows')));
    return;
  }
  // W1: the rows as the shared register — search, sort (numbers as numbers), pages of 25, a column choice. Every key
  // any row carries is a column (see below); the register adds nothing and drops nothing.
  const o = office();
  if (o) {
    const keys = [];
    for (const row of outcome.rows) for (const key of Object.keys(row)) if (!keys.includes(key)) keys.push(key);
    const numeric = (k) => outcome.rows.every((r) => r[k] === undefined || r[k] === null || r[k] === '' || Number.isFinite(Number(r[k])));
    // Batch 18b · O3 (M29-FR-02 drill-through): "What is selling, by department" opens a department to show each item.
    const drill = outcome.report.id === 'units_by_category' && typeof session.departmentItems === 'function' && outcome.rows.some((r) => r.takenMinor !== undefined);
    o.table(el('report-rows'), {
      id: 'report', label: t('rowsLabel'), pageSize: 25, rows: outcome.rows,
      ...(drill ? { rowData: (r) => ({ department: r.department }), drawer: { title: (r) => fillIn(t('itemsIn'), { dept: r.department }), body: (r) => departmentItemsBody(r.department) } } : {}),
      // D-057: a column holding money (…Minor) is shown in rupees, sorted by its number; known columns read as words.
      columns: keys.map((k) => ({
        key: k, label: columnLabel(k), sort: numeric(k) ? 'number' : 'text', align: numeric(k) || /Minor$/.test(k) ? 'end' : undefined,
        value: (r) => (r[k] === undefined ? '' : r[k]),
        ...(/Minor$/.test(k) ? { render: (r) => (r[k] === undefined || r[k] === '' || !Number.isFinite(Number(r[k])) ? (r[k] ?? '') : inr(Number(r[k]))) } : {}),
      })),
    });
    return;
  }
  const table = document.createElement('table');
  // Every key any row carries, not just the first row's. A report where one column is absent from
  // the first bill and present on the rest would otherwise drop that column from the whole table,
  // and a table that is quietly one column narrower is one somebody reconciles against and cannot
  // explain.
  const columns = [];
  for (const row of outcome.rows) {
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  }
  const head = document.createElement('tr');
  for (const column of columns) {
    const th = document.createElement('th');
    th.textContent = column;
    head.append(th);
  }
  table.append(head);
  for (const row of outcome.rows) {
    const tr = document.createElement('tr');
    for (const column of columns) {
      const td = document.createElement('td');
      td.textContent = row[column] ?? '';
      tr.append(td);
    }
    table.append(tr);
  }
  el('report-rows').replaceChildren(table);
}

/** Batch 18b · O3: one department's items — quantity, kg, rupees and margin ("Not known" where an item has no cost, D-057). */
const kgOf = (grams) => `${Math.trunc(grams / 1000)}.${String(grams % 1000).padStart(3, '0')} kg`;
function departmentItemsBody(department) {
  const box = document.createElement('div');
  box.className = 'dept-items';
  const covers = document.createElement('p'); covers.className = 'report-covers'; covers.textContent = coversLine();
  box.append(covers);
  const items = session.departmentItems(department);
  const o = office();
  if (!Array.isArray(items) || o === null) { box.append(emptyLine(t('noItems'))); return box; }
  const host = document.createElement('div');
  box.append(host);
  o.table(host, {
    id: 'dept-items', label: { en: WORDS.en.itemsLabel, ta: WORDS.ta.itemsLabel }, pageSize: 25, sortable: true, rows: items,
    rowKey: (i) => i.productId, rowData: (i) => ({ product: i.productId }),
    columns: [
      { key: 'name', label: { en: WORDS.en.itemCol, ta: WORDS.ta.itemCol }, sort: 'text', value: (i) => i.name },
      { key: 'items', label: { en: WORDS.en.itemsCol, ta: WORDS.ta.itemsCol }, sort: 'number', align: 'end', value: (i) => i.items },
      { key: 'grams', label: { en: WORDS.en.weighedCol, ta: WORDS.ta.weighedCol }, sort: 'number', align: 'end', value: (i) => i.grams, render: (i) => (i.grams === 0 ? '—' : kgOf(i.grams)) },
      { key: 'takenMinor', label: { en: WORDS.en.takenCol, ta: WORDS.ta.takenCol }, sort: 'number', align: 'end', value: (i) => i.takenMinor, render: (i) => inr(i.takenMinor) },
      { key: 'marginMinor', label: { en: WORDS.en.marginCol, ta: WORDS.ta.marginCol }, sort: 'number', align: 'end', value: (i) => (i.marginMinor === undefined ? null : i.marginMinor), render: (i) => (i.marginMinor === undefined ? (/^Not known for this period/.test(i.marginNotKnown ?? '') ? 'Not known for this period' : (i.marginNotKnown ?? 'Not known')) : inr(i.marginMinor)) },
      { key: 'marginBps', label: { en: WORDS.en.marginPctCol, ta: WORDS.ta.marginPctCol }, sort: 'number', align: 'end', value: (i) => (i.marginBps === undefined ? null : i.marginBps), render: (i) => (i.marginBps === undefined ? '—' : `${(i.marginBps / 100).toFixed(1)}%`) },
    ],
  });
  return box;
}

/** D-057: the column headings a person reads (English and Tamil); any other key is shown as the report names it. */
const COLUMN_WORDS = {
  department: { en: 'Department', ta: 'துறை' }, takenMinor: { en: 'Taken', ta: 'வசூல்' }, items: { en: 'Items', ta: 'பொருட்கள்' },
  weighed: { en: 'Weighed', ta: 'எடை' }, units: { en: 'Items sold', ta: 'விற்ற பொருட்கள்' }, totalMinor: { en: 'Taken', ta: 'வசூல்' },
  // D-057: the margin per department (before GST, at the average buying cost), and as a share of what it took before GST.
  marginMinor: { en: 'Margin', ta: 'லாப வரம்பு' }, marginPercent: { en: 'Margin %', ta: 'லாப வரம்பு %' },
};
function columnLabel(k) { return COLUMN_WORDS[k]?.[lang] ?? COLUMN_WORDS[k]?.en ?? k; }

function figureBox(f) {
  const box = document.createElement('div');
  const unavailable = f.valueMinor === undefined;
  box.className = `figure ${unavailable ? 'unavailable' : f.staleness}`;

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = figureName(f.name);

  const value = document.createElement('span');
  if (unavailable) {
    // In the space where the number would have been, so it cannot be skimmed past. Never a zero,
    // never a blank — "Waste: ₹0" is a number somebody puts in a board pack.
    value.className = 'value none';
    // A reason that already begins "Not known —" (D-057's margin) says it itself; it is not prefixed a second time.
    value.textContent = /^Not known\b/.test(f.notAvailableBecause) ? f.notAvailableBecause : `${t('notAvailable')} — ${f.notAvailableBecause}`;
  } else {
    value.className = 'value';
    value.textContent = f.unit === 'minor_currency'
      ? inr(f.valueMinor)
      : f.unit === 'basis_points'
        ? `${(f.valueMinor / 100).toFixed(2)}%`
        : String(f.valueMinor);
  }

  const asat = document.createElement('span');
  asat.className = 'asat';
  // Words as well as the colour on the border: one man in twelve cannot tell the two apart, and
  // this is a screen people quote from.
  // UI-3 (OB-607): the moment at the shop's clock, not the raw universal-time stamp.
  asat.textContent = `${t('asAt')} ${f.asAt ? shopTime(f.asAt) : t('neverHeard')} · ${words(STALENESS_WORDS, f.staleness)}`;

  box.append(name, value, asat);
  return box;
}

el('export').addEventListener('click', () => {
  if (openReportId === null) return;
  const result = session.export(openReportId);
  if (!('csv' in result)) { tell(t('read'), result.detail); return; }
  tell(
    t('exported'),
    `${result.audit.rowCount} ${t('exportedNote')}`
      + (result.audit.redactedColumns.length > 0 ? ` (${result.audit.redactedColumns.join(', ')})` : ''),
    true,
  );
});

// ── Language ────────────────────────────────────────────────────────────────

function paintChrome() {
  el('who').firstChild.textContent = `${t('title')} `;
  // D-10: who is looking — the page's own payload, else the person the store computer signed in (its menu names them).
  el('whoami').textContent = window.reportingData?.userId ?? window.sreNavigation?.userId ?? '';
  el('tab-reports').textContent = t('reports');
  el('tab-blocked').textContent = t('cannotRun');
  el('tab-backlog').textContent = t('whatNext');
  el('reports-title').textContent = t('reports');
  el('reports-lead').textContent = t('reportsLead');
  el('find-report-label').textContent = t('findReport');
  el('find-report').placeholder = t('findReport');
  el('blocked-title').textContent = t('cannotRun');
  el('blocked-lead').textContent = t('blockedLead');
  el('backlog-title').textContent = t('whatNext');
  el('backlog-lead').textContent = t('backlogLead');
  el('sample').textContent = t('sampleData');
  paintPeriod();
  renderFreshness();
  renderCatalogue();
  findReports();
  if (openReportId !== null) {
    const outcome = session.run(openReportId);
    if (outcome.ok) renderReport(outcome);
  }
}

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintChrome();
});

// ── Boot ────────────────────────────────────────────────────────────────────

el('sample').hidden = real !== undefined;
paintChrome();
show('reports');

// ── The shell's own honesty about where this page came from ─────────────────
//

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
