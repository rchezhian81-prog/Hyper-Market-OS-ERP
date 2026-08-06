// Owner command centre — the view layer. It renders the brief and the approvals produced by the
// TESTED model (`apps/owner-app/src/owner-session.ts`, bundled as `window.ownerSession`) and holds
// no business logic of its own: no KPI maths, no alert grouping, no priority rules, no decision
// about whether data is fresh enough to act on.
//
// ── What this file exists to hold ───────────────────────────────────────────
//
// **1. The age of the data is put in front of the decision, not in a badge above it.** The owner
// is remote and every figure here is historical by construction. Reading yesterday's numbers on
// eleven-hour-old data is fine; approving ₹8 lakh on it is not. So when the data is stale the
// approve panel carries the age in words and the owner has to act through it — one deliberate tap,
// and the model records that they were told.
//
// **2. Nothing is a dead end.** The previous version of this screen answered a tapped alert with
// `window.alert('t-1\nt-2')` — a system dialog containing raw ids. Every tap now opens something
// real: a figure opens the sales behind it, an approval opens the decision.
//
// **3. Sample figures announce themselves.** They used to render as if they were the shop's, down
// to plausible rupee totals. An owner acting on a number that came from nowhere is worse than an
// owner with no number at all.
//
// **4. Tamil is complete.** The old language button set `document.documentElement.lang` and
// changed not one word on the screen — a toggle that says "translated" and is not.
//
// Nothing here fetches. What the phone was last told is all there is (§31).

const el = (id) => document.getElementById(id);

/** Exact minor units in, rupees out. The model never sees a float. */
const inr = (minor) =>
  '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Words ───────────────────────────────────────────────────────────────────

const WORDS = {
  en: {
    staleShell: 'No connection. These figures are what this phone was last given, at',
    today: 'Today', needsAttention: 'Needs your attention', todaysNumbers: "Today's numbers",
    waitingForYou: 'Waiting for you', alerts: 'Alerts', lookAgain: 'Look at these again',
    decidedNotSent: 'Decided, not yet sent', nothingToDecide: 'Nothing needs a decision right now.',
    noAlerts: 'No alerts today.', nothingWaiting: 'Nothing is waiting for you.',
    live: 'Live · synced', notLive: 'NOT LIVE — last synced', neverSynced: 'No data has ever reached this phone',
    justNow: 'just now', minutesAgo: 'min ago', hoursAgo: 'hours ago',
    sales: 'Sales', margin: 'Margin', bills: 'Bills', averageBasket: 'Average basket',
    tapToSee: 'Tap to see every sale', approve: 'Approve', reject: 'Reject', cancel: 'Cancel',
    close: 'Close', ok: 'OK', total: 'Total', askedBy: 'asked for by', noValue: 'no value',
    whyApprove: 'Why are you approving this?', whyReject: 'Why are you rejecting this?',
    read: 'Please read this', decided: 'Decided', willSend: 'It will be sent as soon as there is a signal.',
    staleWarning: 'These numbers are not live. The shop has been open since this data left, so what you are approving may already have changed. Tap a reason only if you still want to decide now.',
    exception: 'Exception', approval: 'Approval',
    transactions: 'transactions', drillNote: 'Every sale behind this figure — not a sample.',
    countIsAnswer: 'The number of bills is the answer here; the money beside each one is what that bill was worth.',
    noDataTitle: 'This phone has nothing to show',
    noDataBody: 'No figures have reached it yet. Nothing is wrong with the shop — this app has simply not been given any data. It will fill in as soon as it syncs.',
    cannotDecideNoData: 'Nothing has ever synced from this branch, so there is no basis for a decision at all. This is not something to acknowledge and carry on from.',
    sampleData: 'Sample figures — this is not your shop.',
    queuedOne: 'decision waiting to be sent', queuedMany: 'decisions waiting to be sent',
    changedSince: 'This changed after you decided it', withdrawnSince: 'This is no longer waiting for anybody',
    youSaid: 'You said', itNowSays: 'It now says', discard: 'Remove it from my list',
    branchNotThere: 'That shop is not on this phone.',
  },
  ta: {
    staleShell: 'இணைப்பு இல்லை. இந்த எண்கள் இந்த ஃபோனுக்குக் கடைசியாகக் கொடுக்கப்பட்டவை:',
    today: 'இன்று', needsAttention: 'உங்கள் கவனம் தேவை', todaysNumbers: 'இன்றைய எண்கள்',
    waitingForYou: 'உங்களுக்காகக் காத்திருப்பவை', alerts: 'எச்சரிக்கைகள்', lookAgain: 'இவற்றை மீண்டும் பாருங்கள்',
    decidedNotSent: 'முடிவு செய்யப்பட்டது, இன்னும் அனுப்பப்படவில்லை', nothingToDecide: 'இப்போது எந்த முடிவும் தேவையில்லை.',
    noAlerts: 'இன்று எச்சரிக்கை எதுவும் இல்லை.', nothingWaiting: 'உங்களுக்காக எதுவும் காத்திருக்கவில்லை.',
    live: 'நேரலை · ஒத்திசைவு', notLive: 'நேரலை அல்ல — கடைசி ஒத்திசைவு', neverSynced: 'இந்த ஃபோனுக்கு இதுவரை எந்தத் தகவலும் வரவில்லை',
    justNow: 'இப்போதுதான்', minutesAgo: 'நிமிடங்களுக்கு முன்', hoursAgo: 'மணி நேரத்திற்கு முன்',
    sales: 'விற்பனை', margin: 'லாபம்', bills: 'பில்கள்', averageBasket: 'சராசரி கூடை',
    tapToSee: 'ஒவ்வொரு விற்பனையையும் பார்க்கத் தட்டவும்', approve: 'ஒப்புதல்', reject: 'மறு', cancel: 'ரத்து',
    close: 'மூடு', ok: 'சரி', total: 'மொத்தம்', askedBy: 'கேட்டவர்', noValue: 'மதிப்பு இல்லை',
    whyApprove: 'ஏன் ஒப்புதல் அளிக்கிறீர்கள்?', whyReject: 'ஏன் மறுக்கிறீர்கள்?',
    read: 'இதைப் படிக்கவும்', decided: 'முடிவு பதிவாகியது', willSend: 'சிக்னல் கிடைத்தவுடன் அனுப்பப்படும்.',
    staleWarning: 'இந்த எண்கள் நேரலை அல்ல. இந்தத் தகவல் வந்த பிறகும் கடை திறந்திருந்தது. எனவே நீங்கள் ஒப்புதல் அளிப்பது ஏற்கனவே மாறியிருக்கலாம். இப்போதே முடிவு செய்ய விரும்பினால் மட்டும் ஒரு காரணத்தைத் தட்டவும்.',
    exception: 'விதிவிலக்கு', approval: 'ஒப்புதல்',
    transactions: 'பரிவர்த்தனைகள்', drillNote: 'இந்த எண்ணுக்குப் பின்னால் உள்ள ஒவ்வொரு விற்பனையும் — மாதிரி அல்ல.',
    countIsAnswer: 'இங்கே பில்களின் எண்ணிக்கையே பதில்; ஒவ்வொன்றின் பக்கத்தில் உள்ள தொகை அந்தப் பில்லின் மதிப்பு.',
    noDataTitle: 'இந்த ஃபோனில் காட்ட எதுவும் இல்லை',
    noDataBody: 'இதுவரை எந்த எண்ணும் வரவில்லை. கடையில் எந்தப் பிரச்சனையும் இல்லை — இந்த ஆப்-க்கு தகவல் தரப்படவில்லை. ஒத்திசைவு ஆனவுடன் நிரம்பும்.',
    cannotDecideNoData: 'இந்தக் கிளையிலிருந்து இதுவரை எந்தத் தகவலும் வரவில்லை. எனவே முடிவெடுக்க எந்த அடிப்படையும் இல்லை. இதை ஒப்புக்கொண்டு தொடர முடியாது.',
    sampleData: 'மாதிரி எண்கள் — இது உங்கள் கடை அல்ல.',
    queuedOne: 'முடிவு அனுப்பக் காத்திருக்கிறது', queuedMany: 'முடிவுகள் அனுப்பக் காத்திருக்கின்றன',
    changedSince: 'நீங்கள் முடிவு செய்த பிறகு இது மாறிவிட்டது', withdrawnSince: 'இது இனி யாருக்கும் காத்திருக்கவில்லை',
    youSaid: 'நீங்கள் சொன்னது', itNowSays: 'இப்போது உள்ளது', discard: 'என் பட்டியலிலிருந்து நீக்கு',
    branchNotThere: 'அந்தக் கடை இந்த ஃபோனில் இல்லை.',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

/**
 * Words for every refusal the model can return — one entry per `OWNER_DECIDE_REFUSALS`.
 *
 * A guardrail walks the model's list against this map in both languages. An owner reading
 * `stale_data_not_acknowledged` off a phone taps the button again, harder.
 */
const REFUSAL_WORDS = {
  request_not_found: { en: 'That is no longer waiting for you. Somebody else may have decided it.', ta: 'அது இனி உங்களுக்காகக் காத்திருக்கவில்லை. வேறு ஒருவர் முடிவு செய்திருக்கலாம்.' },
  unknown_reason_code: { en: 'That reason cannot be used for this decision.', ta: 'இந்த முடிவுக்கு அந்தக் காரணத்தைப் பயன்படுத்த முடியாது.' },
  stale_data_not_acknowledged: { en: 'These numbers are not live. Read the warning on the panel before deciding.', ta: 'இந்த எண்கள் நேரலை அல்ல. முடிவெடுப்பதற்கு முன் பேனலில் உள்ள எச்சரிக்கையைப் படிக்கவும்.' },
  no_data_at_all: { en: 'Nothing has ever synced from this branch, so there is nothing to decide on.', ta: 'இந்தக் கிளையிலிருந்து இதுவரை எதுவும் வரவில்லை. எனவே முடிவெடுக்க எதுவும் இல்லை.' },
  self_approval_forbidden: { en: 'You asked for this yourself, so somebody else has to decide it.', ta: 'இதை நீங்களே கேட்டீர்கள். எனவே வேறு ஒருவர் முடிவு செய்ய வேண்டும்.' },
  reason_required: { en: 'A reason has to be recorded with every decision.', ta: 'ஒவ்வொரு முடிவுக்கும் ஒரு காரணம் பதிவு செய்யப்பட வேண்டும்.' },
  out_of_scope: { en: 'This shop is not yours to decide for.', ta: 'இந்தக் கடைக்கு நீங்கள் முடிவு செய்ய முடியாது.' },
  exceeds_authority: { en: 'This is above your own approval limit.', ta: 'இது உங்கள் ஒப்புதல் வரம்பைத் தாண்டியது.' },
};

/** Words for each reason code the model offers. Guarded against the model's own catalogue. */
const REASON_WORDS = {
  within_policy: { en: 'It is within policy', ta: 'இது கொள்கைக்கு உட்பட்டது' },
  checked_with_supplier: { en: 'I checked with the supplier', ta: 'சப்ளையரிடம் சரிபார்த்தேன்' },
  checked_the_stock: { en: 'I checked the stock myself', ta: 'இருப்பை நானே சரிபார்த்தேன்' },
  owner_instructed: { en: 'I have decided this', ta: 'இதை நான் முடிவு செய்துவிட்டேன்' },
  price_looks_wrong: { en: 'The price looks wrong', ta: 'விலை தவறாகத் தெரிகிறது' },
  not_enough_evidence: { en: 'Not enough proof', ta: 'போதுமான ஆதாரம் இல்லை' },
  against_policy: { en: 'Against policy', ta: 'கொள்கைக்கு எதிரானது' },
  ask_the_owner_first: { en: 'Ask me again with more detail', ta: 'மேலும் விவரத்துடன் மீண்டும் கேளுங்கள்' },
};

/** What a request is about. An unknown type is shown as itself rather than hidden. */
const SUBJECT_WORDS = {
  price_change: { en: 'Price change', ta: 'விலை மாற்றம்' },
  stock_adjustment: { en: 'Stock adjustment', ta: 'இருப்புத் திருத்தம்' },
  refund: { en: 'Refund', ta: 'திரும்பப் பணம்' },
  purchase_order: { en: 'Purchase order', ta: 'கொள்முதல் ஆர்டர்' },
  day_reopen: { en: 'Reopen a closed day', ta: 'முடிக்கப்பட்ட நாளைத் திறத்தல்' },
  write_off: { en: 'Write-off', ta: 'எழுதித் தள்ளல்' },
};

/** The four figures on the brief, and which model KPI each reads. */
const KPI_TILES = [
  { kpi: 'grossSales', label: 'sales', from: (k) => inr(k.grossSalesMinor) },
  { kpi: 'margin', label: 'margin', from: (k) => inr(k.marginMinor) },
  { kpi: 'baskets', label: 'bills', from: (k) => String(k.basketCount) },
  { kpi: 'averageBasket', label: 'averageBasket', from: (k) => inr(k.avgBasketMinor) },
];

const words = (map, key) => (map[key]?.[lang] ?? map[key]?.en ?? String(key).replace(/_/g, ' '));

/**
 * Sample figures with the same surface as the bundled `OwnerSession`, so the layout is runnable
 * and reviewable before real data arrives.
 *
 * It deliberately shows **stale** data with an approval waiting, because that is the path worth
 * rehearsing: a demo on live numbers would never show the warning that this screen exists to put
 * in front of a decision. Whenever this stand-in is in use the header says so.
 */
function sampleSession() {
  const approvals = [
    { id: 'a1', subjectType: 'purchase_order', subjectRef: 'PO-9912 · Rice, 200 bags', requestedBy: 'Karthik (buying)', valueMinor: 812_000_00 },
    { id: 'a2', subjectType: 'price_change', subjectRef: 'Toor dal 1kg', requestedBy: 'Karthik (buying)', valueMinor: 45_000 },
  ];
  const sales = [
    { saleId: 'S-1041', contributesMinor: 295_00, tender: 'upi', units: 7 },
    { saleId: 'S-1039', contributesMinor: 118_00, tender: 'cash', units: 3 },
    { saleId: 'S-1044', contributesMinor: 59_00, tender: 'card', units: 2 },
  ];
  const gross = sales.reduce((sum, s) => sum + s.contributesMinor, 0);
  const decided = new Set();
  return {
    branches: () => [{
      branchId: 'b1', name: 'SRE Hyper Market',
      freshness: { state: 'stale', ageSeconds: 39_600, lastSyncedAt: null, asOf: '' },
    }],
    currentBranchId: () => 'b1',
    viewBranch: () => true,
    brief: () => ({
      asOf: '',
      kpis: { grossSalesMinor: gross, marginMinor: 148_00, basketCount: sales.length, avgBasketMinor: Math.round(gross / sales.length) },
      freshness: { state: 'stale', ageSeconds: 39_600, lastSyncedAt: null, asOf: '' },
      headline: '3 bills today, ₹472.00 taken, margin ₹148.00 (31.4%). These numbers are NOT live — the branch has not synced recently.',
      attention: [{ rank: 1, source: 'approval', sentence: 'Approval waiting: purchase order from Karthik for ₹8,12,000.00.', ref: 'a1' }],
      alerts: [{ kind: 'void', severity: 'escalate', count: 9, totalValueMinor: 0, linkedTxnIds: ['t-1', 't-2', 't-3'], sentence: 'Urgent: voided bills over the limit — 3 transactions.' }],
      approvals: approvals.filter((a) => !decided.has(a.id)),
    }),
    drill: (kpi) => ({ kpi, lines: sales, totalMinor: gross, countIsTheAnswer: kpi === 'baskets' }),
    decide: ({ requestId, acknowledgeStale }) => {
      if (acknowledgeStale !== true) return { ok: false, refusal: 'stale_data_not_acknowledged' };
      decided.add(requestId);
      return { ok: true, decision: { request: { id: requestId } }, queuedCount: decided.size };
    },
    queued: () => [...decided].map((id) => ({ request: { id } })),
    reconcileQueued: () => ({ stillValid: [], needsAnotherLook: [] }),
    discardQueued: () => true,
  };
}

const real = window.ownerSession;
const session = real ?? sampleSession();
const REASONS = window.ownerReasons ?? {
  approved: ['within_policy', 'checked_with_supplier', 'checked_the_stock', 'owner_instructed'],
  rejected: ['price_looks_wrong', 'not_enough_evidence', 'against_policy', 'ask_the_owner_first'],
};

// ── The banner ──────────────────────────────────────────────────────────────

/** Say something the owner must read, and keep saying it. No timer — same rule as the till. */
function tell(title, message, good = false) {
  el('banner-title').textContent = title;
  el('banner-text').textContent = message;
  el('banner').classList.toggle('good', good === true);
  el('banner').hidden = false;
  el('banner-ok').textContent = t('ok');
  el('banner-ok').focus();
}
el('banner-ok').addEventListener('click', () => { el('banner').hidden = true; });

// ── How old, in words ───────────────────────────────────────────────────────

/**
 * The age of the data as a person would say it.
 *
 * A phone showing "39600s" is a phone whose freshness indicator nobody reads, and an unread
 * freshness indicator is the same as not having one.
 */
function ageInWords(seconds) {
  if (seconds === null || seconds === undefined) return '';
  if (seconds < 60) return t('justNow');
  if (seconds < 3600) return `${Math.round(seconds / 60)} ${t('minutesAgo')}`;
  return `${Math.round(seconds / 360) / 10} ${t('hoursAgo')}`;
}

function renderFreshness(freshness) {
  const dot = el('fresh-dot');
  const text = el('fresh-text');
  dot.className = 'dot ' + (freshness.state === 'fresh' ? '' : freshness.state);
  // Words as well as a colour, and the state in the class so the words carry weight too.
  text.className = freshness.state === 'fresh' ? '' : freshness.state;
  text.textContent = freshness.state === 'missing'
    ? t('neverSynced')
    : `${freshness.state === 'stale' ? t('notLive') : t('live')} ${ageInWords(freshness.ageSeconds)}`;
}

// ── Rendering ───────────────────────────────────────────────────────────────

function renderBranches() {
  const branches = session.branches();
  // One shop is not a choice, so the switcher is not shown for one shop.
  el('branches').hidden = branches.length < 2;
  el('branches').replaceChildren(...branches.map((branch) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = branch.name;
    const age = document.createElement('span');
    age.className = 'age';
    // Each shop carries its own freshness. One branch syncing does not make the others current.
    age.textContent = branch.freshness.state === 'missing'
      ? t('neverSynced')
      : ageInWords(branch.freshness.ageSeconds);
    button.appendChild(age);
    button.setAttribute('aria-current', branch.branchId === session.currentBranchId() ? 'page' : 'false');
    button.addEventListener('click', () => {
      if (!session.viewBranch(branch.branchId)) { tell(t('read'), t('branchNotThere')); return; }
      render();
    });
    return button;
  }));
}

function renderAttention(items) {
  const host = el('attention');
  if (items.length === 0) {
    const none = document.createElement('p');
    none.className = 'empty';
    none.textContent = t('nothingToDecide');
    host.replaceChildren(none);
    return;
  }
  host.replaceChildren(...items.map((item) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'card' + (item.source === 'approval' ? ' approval' : item.sentence.startsWith('Urgent') ? ' urgent' : '');
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = `#${item.rank} · ${item.source === 'approval' ? t('approval') : t('exception')}`;
    const body = document.createElement('span');
    body.textContent = item.sentence;
    card.append(rank, body);
    // Tapping goes to the thing itself. The old version opened a system dialog with a raw id in
    // it, which is a dead end wearing the clothes of an action.
    card.addEventListener('click', () => {
      if (item.source === 'approval') {
        const request = session.brief().approvals.find((a) => a.id === item.ref);
        if (request) openDecide(request);
        return;
      }
      const alert = session.brief().alerts.find((a) => `${a.kind}:${a.severity}` === item.ref);
      if (alert) showAlert(alert);
    });
    return card;
  }));
}

function renderKpis(kpis) {
  el('kpis').replaceChildren(...KPI_TILES.map((tile) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'kpi';
    for (const [cls, text] of [['label', t(tile.label)], ['value', tile.from(kpis)], ['more', t('tapToSee')]]) {
      const part = document.createElement('div');
      part.className = cls;
      part.textContent = text;
      button.appendChild(part);
    }
    // Every figure drills to its source in one tap (M29-FR-02, QG-02 budget of ≤3).
    button.addEventListener('click', () => openDrill(tile.kpi, t(tile.label)));
    return button;
  }));
}

function renderAlerts(alerts) {
  const host = el('alerts');
  if (alerts.length === 0) {
    const none = document.createElement('p');
    none.className = 'empty';
    none.textContent = t('noAlerts');
    host.replaceChildren(none);
    return;
  }
  host.replaceChildren(...alerts.map((alert) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'alert';
    const line = document.createElement('span');
    line.textContent = alert.sentence;
    const drill = document.createElement('span');
    drill.className = 'drill';
    drill.textContent = `${alert.linkedTxnIds.length} ${t('transactions')}`;
    row.append(line, drill);
    row.addEventListener('click', () => showAlert(alert));
    return row;
  }));
}

function showAlert(alert) {
  // The transactions behind the alert, in the panel rather than a system dialog.
  el('drill-title').textContent = alert.sentence;
  el('drill-total-label').textContent = t('transactions');
  el('drill-total').textContent = String(alert.linkedTxnIds.length);
  el('drill-note').textContent = '';
  el('drill-lines').replaceChildren(...alert.linkedTxnIds.map((txnId) => {
    const row = document.createElement('div');
    row.className = 'drill-line';
    const id = document.createElement('span');
    id.textContent = txnId;
    row.append(id);
    return row;
  }));
  el('drill-close').textContent = t('close');
  el('drill').hidden = false;
}

function renderApprovals(approvals) {
  const host = el('approvals');
  if (approvals.length === 0) {
    const none = document.createElement('p');
    none.className = 'empty';
    none.textContent = t('nothingWaiting');
    host.replaceChildren(none);
    return;
  }
  host.replaceChildren(...approvals.map((request) => {
    const box = document.createElement('div');
    box.className = 'row';

    const what = document.createElement('div');
    what.className = 'what';
    what.textContent = `${words(SUBJECT_WORDS, request.subjectType)} · ${request.subjectRef}`;

    const value = document.createElement('div');
    value.className = 'value';
    value.textContent = request.valueMinor === null ? t('noValue') : inr(request.valueMinor);

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${t('askedBy')} ${request.requestedBy}`;

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    for (const [decision, label, cls] of [
      ['approved', t('approve'), 'primary'], ['rejected', t('reject'), 'danger'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = cls;
      button.textContent = label;
      button.addEventListener('click', () => openDecide(request, decision));
      actions.appendChild(button);
    }

    box.append(what, value, meta, actions);
    return box;
  }));
}

function renderQueued() {
  const queued = session.queued();
  el('queued-section').hidden = queued.length === 0;
  el('queued').textContent =
    `${queued.length} ${queued.length === 1 ? t('queuedOne') : t('queuedMany')}. ${t('willSend')}`;
}

/**
 * Decisions that went out of date while they waited (§31.1).
 *
 * Above everything else on the screen, because a ₹40,000 approval that quietly applied to a
 * ₹90,000 request is the exact failure a maker-checker exists to prevent. They are never sent and
 * never dropped on their own — the owner looks again.
 */
function renderRecheck() {
  const { needsAnotherLook } = session.reconcileQueued();
  el('recheck-section').hidden = needsAnotherLook.length === 0;
  el('recheck').replaceChildren(...needsAnotherLook.map((item) => {
    const box = document.createElement('div');
    box.className = 'row recheck';

    const why = document.createElement('div');
    why.className = 'why';
    why.textContent = item.reason === 'request_changed' ? t('changedSince') : t('withdrawnSince');

    const said = document.createElement('div');
    said.className = 'what';
    said.textContent = `${t('youSaid')}: ${item.decision.request.status === 'approved' ? t('approve') : t('reject')}`;

    box.append(why, said);

    if (item.nowIs !== null) {
      const nowIs = document.createElement('div');
      nowIs.className = 'meta';
      nowIs.textContent = `${t('itNowSays')}: ${words(SUBJECT_WORDS, item.nowIs.subjectType)} · ${item.nowIs.subjectRef} · ${item.nowIs.valueMinor === null ? t('noValue') : inr(item.nowIs.valueMinor)}`;
      box.append(nowIs);
    }

    const discard = document.createElement('button');
    discard.type = 'button';
    discard.className = 'wide';
    discard.textContent = t('discard');
    // Only ever after it has been shown. Removing it before that is the silent drop.
    discard.addEventListener('click', () => { session.discardQueued(item.decision.request.id); render(); });
    box.append(discard);
    return box;
  }));
}

// ── Deciding ────────────────────────────────────────────────────────────────

/**
 * Open the decision panel.
 *
 * **The staleness warning lives in here**, next to the reasons, so the age of the data is in front
 * of the owner at the moment of the decision rather than in a badge they scrolled past on the way
 * down. Tapping a reason with that warning showing IS the acknowledgement, and the model records
 * that it happened.
 */
function openDecide(request, decision = 'approved') {
  const freshness = session.brief().freshness;
  el('decide-title').textContent = decision === 'approved' ? t('whyApprove') : t('whyReject');
  el('decide-what').textContent =
    `${words(SUBJECT_WORDS, request.subjectType)} · ${request.subjectRef} · ` +
    `${request.valueMinor === null ? t('noValue') : inr(request.valueMinor)}`;

  const stale = freshness.state === 'stale';
  el('decide-stale').hidden = freshness.state === 'fresh';
  el('decide-stale').textContent = freshness.state === 'missing'
    ? t('cannotDecideNoData')
    : `${t('notLive')} ${ageInWords(freshness.ageSeconds)}. ${t('staleWarning')}`;

  const codes = decision === 'approved' ? REASONS.approved : REASONS.rejected;
  el('decide-reasons').replaceChildren(...(freshness.state === 'missing' ? [] : codes.map((code) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = words(REASON_WORDS, code);
    button.addEventListener('click', () => {
      el('decide').hidden = true;
      submit(request, decision, code, stale);
    });
    return button;
  })));

  el('decide-cancel').textContent = t('cancel');
  el('decide').hidden = false;
}
el('decide-cancel').addEventListener('click', () => { el('decide').hidden = true; });

function submit(request, decision, reasonCode, acknowledgeStale) {
  const outcome = session.decide({ requestId: request.id, decision, reasonCode, acknowledgeStale });
  if (outcome.ok) {
    tell(t('decided'), `${words(SUBJECT_WORDS, request.subjectType)} · ${request.subjectRef}. ${t('willSend')}`, true);
  } else {
    // The refusal names a rule, so it is shown in words. A screen that quietly did nothing would
    // have the owner tapping the same button harder.
    tell(t('read'), words(REFUSAL_WORDS, outcome.refusal));
  }
  render();
}

// ── Drilling ────────────────────────────────────────────────────────────────

/**
 * Every sale behind a figure — all of them, never a sample.
 *
 * A drill-through that shows a selection is how a figure and its evidence come to disagree, and
 * the disagreement is only ever found by the person being asked to act on it.
 */
function openDrill(kpi, label) {
  const drill = session.drill(kpi);
  el('drill-title').textContent = label;
  el('drill-total-label').textContent = drill.countIsTheAnswer ? t('bills') : t('total');
  el('drill-total').textContent = drill.countIsTheAnswer ? String(drill.lines.length) : inr(drill.totalMinor);
  el('drill-note').textContent = drill.countIsTheAnswer ? t('countIsAnswer') : t('drillNote');
  el('drill-lines').replaceChildren(...drill.lines.map((line) => {
    const row = document.createElement('div');
    row.className = 'drill-line';
    const id = document.createElement('span');
    id.textContent = `${line.saleId} · ${line.tender}`;
    const amount = document.createElement('span');
    amount.textContent = inr(line.contributesMinor);
    row.append(id, amount);
    return row;
  }));
  el('drill-close').textContent = t('close');
  el('drill').hidden = false;
}
el('drill-close').addEventListener('click', () => { el('drill').hidden = true; });

// ── Paint ───────────────────────────────────────────────────────────────────

function paintChrome() {
  el('attention-title').textContent = t('needsAttention');
  el('kpis-title').textContent = t('todaysNumbers');
  el('approvals-title').textContent = t('waitingForYou');
  el('alerts-title').textContent = t('alerts');
  el('recheck-title').textContent = t('lookAgain');
  el('queued-title').textContent = t('decidedNotSent');
  el('sample').textContent = t('sampleData');
}

function render() {
  const brief = session.brief();
  el('headline').textContent = brief.headline;
  renderFreshness(brief.freshness);
  renderBranches();
  renderRecheck();
  renderAttention(brief.attention);
  renderKpis(brief.kpis);
  renderApprovals(brief.approvals);
  renderAlerts(brief.alerts);
  renderQueued();
}

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintChrome();
  render();
});

// Sample figures must announce themselves.
el('sample').hidden = real !== undefined;

// A decision the phone could not save is said out loud, not swallowed (P-08).
const queueProblem = window.ownerQueueProblem;
el('queue-problem').hidden = !queueProblem;
if (queueProblem) el('queue-problem').textContent = queueProblem;

paintChrome();

if (real === undefined && window.ownerData !== undefined) {
  // The bundle is there, data arrived, and still no session — the payload carried no branches.
  // Say so plainly rather than rendering a screen of zeros that reads as a quiet day.
  el('headline').textContent = `${t('noDataTitle')} — ${t('noDataBody')}`;
} else {
  render();
}

// ── The shell's own honesty about where this page came from ─────────────────
//
// The service worker keeps a copy of the last page the store box actually served, so this screen
// still opens when the box cannot be reached. That copy carries the time it was taken, and this
// says so. **A cached page shown as a live one is the fault this product exists to refuse** — it
// is not a stale label on a screen, it is somebody acting on figures from this morning believing
// they are from this minute (P-08).
function paintStale() {
  const at = window.shellCachedAt;
  const strip = el('stale');
  if (!strip) return;
  strip.hidden = at === undefined;
  if (at === undefined) return;
  // The device's own local time, because the person reading it is standing in the shop.
  strip.textContent = `${t('staleShell')} ${new Date(at).toLocaleString()}`;
}
paintStale();
el('lang').addEventListener('click', paintStale);

// The shell existed and nothing ever registered it, so nothing was ever cached and every one of
// these screens fell back to its sample data the moment the box was unreachable.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
