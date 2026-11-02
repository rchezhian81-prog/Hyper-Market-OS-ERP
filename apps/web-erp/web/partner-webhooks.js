// Partner webhooks (W3 · D14-FR-06 · M32-FR-01/02 · §30.1 · P-08 · hard rules #4 and #6): a THIN CLIENT over head office's
// outbound webhooks. It lists every partner subscription with its delivered, waiting and dead-lettered messages; sets up a
// new one only with a SECOND person's approval (OB-72: any other admin, never the maker) — asked here for exactly this
// subscription and given on the approver's own Approvals page; switches one off; reads every message since a date; and
// sends a dead letter again — a NEW series of attempts, the old attempts kept, the dead letter never deleted. The connector
// queues' waiting and dead-lettered messages are read here too (a corrected message is a new one; nothing is purged). The
// signing secret is never typed: only its vault:// name (#4). Every word has a Tamil twin; nothing is written on open.

const $ = (id) => document.getElementById(id);
const who = window.partnerWebhooksData && typeof window.partnerWebhooksData === 'object' ? window.partnerWebhooksData : null;
const perms = new Set(Array.isArray(who?.permissions) ? who.permissions : []);
const named = typeof who?.userId === 'string' && who.userId !== '';
const mayRead = perms.has('platform.health.read');
const mayEdit = perms.has('platform.setup.write');
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';

const WORDS = {
  en: {
    lang: 'தமிழ்', title: 'Partner webhooks',
    lead: 'What head office sends to partners when something happens in the shop (a sale, a stock move). Each message is signed and retried; one that cannot get through becomes a dead letter — kept, never deleted, and sent again only by a person.',
    kSubs: 'Subscriptions', kDead: 'Dead letters', kSender: 'Sender', senderNone: 'Not configured — messages wait', refresh: 'Refresh', drain: 'Send what is due now',
    listH: 'Subscriptions', listLead: 'Open one to see its dead letters and every message it was sent.', none: 'No partner is subscribed yet.',
    cId: 'Subscription', cPartner: 'Partner', cEvents: 'Events', cState: 'State', cDelivered: 'Delivered', cWaiting: 'Waiting', cDead: 'Dead letters', on: 'On', offWord: 'Switched off',
    recordH: 'Subscription {id}', fPartner: 'Partner: {v}', fUrl: 'Sends to: {v}', fEvents: 'Events: {v}', fKey: 'Signed with the secret named: {v}', fTries: 'Attempts before a dead letter: {v}',
    fVersion: 'Version {v}, set by {by} on {at}', fApproved: 'Approved by {v}', fFrom: 'Sends what happened from {v}', off: 'Switch it off',
    deadH: 'Dead letters', deadLead: 'A message the partner refused, or that ran out of attempts. Sending it again starts a new series of attempts; the old ones stay on the record.', noDead: 'No dead letters.',
    deadLine: '{type} of {at} — {attempts} attempt(s): {detail}', again: 'Send it again', sentAgain: 'Put back in the queue (series {series}). It goes with the next send.',
    reconH: 'Every message since', reconFrom: 'From (date)', recon: 'Read the messages', reconTotals: '{all} message(s): {delivered} delivered, {pending} waiting, {dead} dead letter(s).',
    msgLine: '{type} of {at} — {status}{detail}', stDelivered: 'delivered', stPending: 'waiting', stDead: 'dead letter',
    newH: 'Subscribe a partner', newLead: 'A second person with setup rights must approve exactly this subscription before head office sends anything. The partner\'s address must be public https. Type the vault name of the signing secret — never the secret itself.',
    sId: 'Subscription name (letters, digits, dashes)', sPartner: 'Partner', sUrl: 'Partner\'s https address', sKey: 'Signing secret\'s vault name (never the secret)', sTries: 'Attempts before it is a dead letter (1 to 20)',
    sEvents: 'Events to send', save: 'Set up the subscription', why: 'Why (for the second person)', ask: 'Ask a second person to approve',
    needFields: 'Fill in the name, the partner, the https address, the vault name and at least one event.', badId: 'A subscription name is letters, digits and dashes only.',
    needApproval: 'A second person must approve this subscription first: {why} Write why, press “Ask a second person to approve”, and once they approve it on their Approvals page, press “Set up the subscription” again.',
    asked: 'Asked. It waits for a second person on their Approvals page; nothing is set up until then.', waiting: 'Still waiting for the second person. Nothing was set up.', rejected: 'The second person rejected it: {why}', needWhy: 'Write the reason first.',
    saved: 'Set up, approved by {by}.', unchanged: 'Nothing changed — it is already set up exactly so.', offDone: 'Switched off. It is kept, with who and when; nothing more is sent.',
    drained: 'Sent: {n} message(s) handled.', qH: 'Connector queues', qLead: 'Messages waiting to go to an outside system (Tally, the GST portal…) and the ones that became dead letters. A dead letter stays here; it is corrected by a new message, never deleted.',
    qId: 'Connector', qRead: 'Read its queue', qTotals: '{pending} waiting, {dead} dead letter(s).', qLine: '{state}: {kind} {id} — {attempts} attempt(s){err}', qWaiting: 'Waiting', qDeadWord: 'Dead letter', needConnector: 'Type the connector\'s name.',
    refused: 'Head office refused:', unreachable: 'Head office could not be reached. Nothing was changed — try again.', readOnly: 'You can read the subscriptions. Setting one up, switching it off or sending again needs setup rights.',
    noRight: 'This account may not read the partner webhooks.', nobody: 'Nobody is signed in on this computer, so nothing can be shown.', notKnown: 'Not known',
  },
  ta: {
    lang: 'English', title: 'கூட்டாளர் வெப்ஹூக்குகள்',
    lead: 'கடையில் ஏதாவது நடக்கும்போது (விற்பனை, சரக்கு நகர்வு) தலைமை அலுவலகம் கூட்டாளர்களுக்கு அனுப்புவது. ஒவ்வொரு செய்தியும் கையொப்பமிடப்பட்டு மீண்டும் முயலப்படுகிறது; சேர முடியாதது தேங்கிய செய்தியாகிறது — வைக்கப்படும், ஒருபோதும் நீக்கப்படாது, ஒருவர் மட்டுமே மீண்டும் அனுப்புவார்.',
    kSubs: 'சந்தாக்கள்', kDead: 'தேங்கிய செய்திகள்', kSender: 'அனுப்புநர்', senderNone: 'அமைக்கப்படவில்லை — செய்திகள் காத்திருக்கின்றன', refresh: 'புதுப்பி', drain: 'உரியதை இப்போது அனுப்பு',
    listH: 'சந்தாக்கள்', listLead: 'அதன் தேங்கிய செய்திகளையும் அனுப்பிய ஒவ்வொரு செய்தியையும் பார்க்க ஒன்றைத் திறக்கவும்.', none: 'இன்னும் எந்தக் கூட்டாளரும் சந்தா செய்யவில்லை.',
    cId: 'சந்தா', cPartner: 'கூட்டாளர்', cEvents: 'நிகழ்வுகள்', cState: 'நிலை', cDelivered: 'சேர்ந்தவை', cWaiting: 'காத்திருப்பவை', cDead: 'தேங்கியவை', on: 'இயக்கத்தில்', offWord: 'அணைக்கப்பட்டது',
    recordH: 'சந்தா {id}', fPartner: 'கூட்டாளர்: {v}', fUrl: 'அனுப்பும் முகவரி: {v}', fEvents: 'நிகழ்வுகள்: {v}', fKey: 'கையொப்ப ரகசியத்தின் பெயர்: {v}', fTries: 'தேங்கும் முன் முயற்சிகள்: {v}',
    fVersion: 'பதிப்பு {v}, {by} {at} அன்று அமைத்தார்', fApproved: '{v} ஒப்புக்கொண்டார்', fFrom: '{v} முதல் நடந்ததை அனுப்புகிறது', off: 'இதை அணை',
    deadH: 'தேங்கிய செய்திகள்', deadLead: 'கூட்டாளர் மறுத்த அல்லது முயற்சிகள் தீர்ந்த செய்தி. மீண்டும் அனுப்பினால் புதிய முயற்சித் தொடர் தொடங்கும்; பழையவை பதிவில் இருக்கும்.', noDead: 'தேங்கிய செய்திகள் இல்லை.',
    deadLine: '{type} ({at}) — {attempts} முயற்சி: {detail}', again: 'மீண்டும் அனுப்பு', sentAgain: 'வரிசையில் மீண்டும் சேர்க்கப்பட்டது (தொடர் {series}). அடுத்த அனுப்புதலில் செல்லும்.',
    reconH: 'அன்று முதல் ஒவ்வொரு செய்தியும்', reconFrom: 'தொடங்கும் தேதி', recon: 'செய்திகளைப் படி', reconTotals: '{all} செய்திகள்: {delivered} சேர்ந்தன, {pending} காத்திருக்கின்றன, {dead} தேங்கின.',
    msgLine: '{type} ({at}) — {status}{detail}', stDelivered: 'சேர்ந்தது', stPending: 'காத்திருக்கிறது', stDead: 'தேங்கியது',
    newH: 'கூட்டாளரைச் சந்தா செய்', newLead: 'தலைமை அலுவலகம் எதையும் அனுப்பும் முன் அமைப்பு உரிமையுள்ள இரண்டாவது நபர் இந்தச் சந்தாவையே ஒப்புக்கொள்ள வேண்டும். கூட்டாளர் முகவரி பொது https ஆக இருக்க வேண்டும். கையொப்ப ரகசியத்தின் பெட்டகப் பெயரை மட்டும் எழுதவும் — ரகசியத்தை ஒருபோதும் அல்ல.',
    sId: 'சந்தாப் பெயர் (எழுத்து, எண், கோடு)', sPartner: 'கூட்டாளர்', sUrl: 'கூட்டாளரின் https முகவரி', sKey: 'கையொப்ப ரகசியத்தின் பெட்டகப் பெயர் (ரகசியம் அல்ல)', sTries: 'தேங்கும் முன் முயற்சிகள் (1 முதல் 20)',
    sEvents: 'அனுப்ப வேண்டிய நிகழ்வுகள்', save: 'சந்தாவை அமை', why: 'ஏன் (இரண்டாவது நபருக்கு)', ask: 'இரண்டாவது நபரின் ஒப்புதல் கேள்',
    needFields: 'பெயர், கூட்டாளர், https முகவரி, பெட்டகப் பெயர், குறைந்தது ஒரு நிகழ்வு ஆகியவற்றை நிரப்பவும்.', badId: 'சந்தாப் பெயரில் எழுத்து, எண், கோடு மட்டுமே.',
    needApproval: 'முதலில் இரண்டாவது நபர் இந்தச் சந்தாவை ஒப்புக்கொள்ள வேண்டும்: {why} ஏன் என்று எழுதி “இரண்டாவது நபரின் ஒப்புதல் கேள்” அழுத்துங்கள்; அவர் ஒப்புதல்கள் பக்கத்தில் ஒப்புக்கொண்டதும் “சந்தாவை அமை” மீண்டும் அழுத்துங்கள்.',
    asked: 'கேட்கப்பட்டது. இரண்டாவது நபரின் ஒப்புதல்கள் பக்கத்தில் காத்திருக்கிறது; அதுவரை எதுவும் அமைக்கப்படாது.', waiting: 'இரண்டாவது நபர் இன்னும் முடிவு செய்யவில்லை. எதுவும் அமைக்கப்படவில்லை.', rejected: 'இரண்டாவது நபர் நிராகரித்தார்: {why}', needWhy: 'முதலில் காரணத்தை எழுதுங்கள்.',
    saved: 'அமைக்கப்பட்டது, {by} ஒப்புக்கொண்டார்.', unchanged: 'எதுவும் மாறவில்லை — ஏற்கனவே இப்படியே அமைக்கப்பட்டுள்ளது.', offDone: 'அணைக்கப்பட்டது. யார், எப்போது என்பதுடன் வைக்கப்பட்டுள்ளது; இனி எதுவும் அனுப்பப்படாது.',
    drained: 'அனுப்பப்பட்டது: {n} செய்திகள் கையாளப்பட்டன.', qH: 'இணைப்பு வரிசைகள்', qLead: 'வெளி அமைப்புக்கு (டேலி, GST தளம்…) செல்லக் காத்திருக்கும் செய்திகளும் தேங்கியவையும். தேங்கிய செய்தி இங்கேயே இருக்கும்; புதிய செய்தியால் திருத்தப்படும், நீக்கப்படாது.',
    qId: 'இணைப்பு', qRead: 'வரிசையைப் படி', qTotals: '{pending} காத்திருக்கின்றன, {dead} தேங்கின.', qLine: '{state}: {kind} {id} — {attempts} முயற்சி{err}', qWaiting: 'காத்திருக்கிறது', qDeadWord: 'தேங்கியது', needConnector: 'இணைப்பின் பெயரை எழுதுங்கள்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. எதுவும் மாற்றப்படவில்லை — மீண்டும் முயலவும்.', readOnly: 'சந்தாக்களை நீங்கள் படிக்கலாம். அமைக்க, அணைக்க அல்லது மீண்டும் அனுப்ப அமைப்பு உரிமை தேவை.',
    noRight: 'இந்தக் கணக்கு கூட்டாளர் வெப்ஹூக்குகளைப் படிக்க முடியாது.', nobody: 'இந்தக் கணினியில் யாரும் உள்நுழையவில்லை, எனவே எதையும் காட்ட முடியாது.', notKnown: 'தெரியவில்லை',
  },
};
const t = (k) => WORDS[lang]?.[k] ?? WORDS.en[k] ?? k;
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
const day = (iso) => (typeof iso === 'string' ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) : '');

const newKey = () => `pwh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
async function call(method, path, body) {
  try {
    const res = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json', 'idempotency-key': newKey() } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  } catch { return { ok: false, status: 0, body: null }; }
}
const tell = (el, ok, text) => { el.className = `status ${ok ? 'good' : 'err'}`; el.textContent = text; };
const say = (el, out, good) => tell(el, out.ok, out.ok ? good : out.status === 0 ? t('unreachable') : `${t('refused')} ${out.body?.error?.whatHappened ?? out.status}`);
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}
/** My own request for exactly these details: approved (its id), waiting, rejected — or nothing yet. */
async function ownApproval(kind, subjectRef, details) {
  const out = await call('GET', '/v1/approvals/requests');
  if (!out.ok) return {};
  const mine = (Array.isArray(out.body?.mine) ? out.body.mine : []).filter((r) => r.kind === kind && r.subjectRef === subjectRef && canonical(r.details) === canonical(details));
  const newest = (rows) => rows.slice().sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))[0];
  const approved = newest(mine.filter((r) => r.status === 'approved' && r.usedBy === undefined));
  if (approved !== undefined) return { approvalId: approved.requestId, decidedBy: approved.decidedBy };
  if (mine.some((r) => r.status === 'waiting')) return { waiting: true };
  const last = newest(mine);
  return last?.status === 'rejected' ? { rejected: last.decisionReason ?? '' } : {};
}

let register = null;  // GET /v1/integration/outbound-webhooks
let open = null;      // the subscription on the record panel
let pending = null;   // { subscriptionId, details } the last set-up needed approval for

function paintList() {
  const tbody = $('rows'); tbody.replaceChildren();
  const subs = register?.subscriptions ?? [];
  for (const s of subs) {
    const tr = document.createElement('tr'); tr.dataset.id = s.subscriptionId; tr.tabIndex = 0;
    const cells = [[s.subscriptionId, false], [s.partnerId, false], [s.eventTypes.join(', '), false], [s.active ? t('on') : t('offWord'), !s.active],
      [String(s.totals.delivered), false], [String(s.totals.pending), false], [String(s.totals.deadLettered), s.totals.deadLettered > 0]];
    for (const [v, warn] of cells) { const td = document.createElement('td'); td.textContent = v; if (warn) td.className = 'warn'; tr.append(td); }
    const go = () => { void openSub(s.subscriptionId); };
    tr.addEventListener('click', go); tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    tbody.append(tr);
  }
  $('none').hidden = register === null || subs.length > 0; $('none').textContent = t('none');
  const known = (el, ok, v, warn = false) => { el.textContent = ok ? String(v) : t('notKnown'); el.classList.toggle('unknown', !ok); el.classList.toggle('warn', ok && warn); };
  known($('v-subs'), register !== null, subs.length);
  known($('v-dead'), register !== null, register?.deadLettered ?? 0, (register?.deadLettered ?? 0) > 0);
  known($('v-sender'), register !== null, register?.transport === 'none' ? t('senderNone') : register?.transport, register?.transport === 'none');
  const box = $('s-events');
  const had = new Set([...box.querySelectorAll('input:checked')].map((i) => i.value));
  box.querySelectorAll('label').forEach((l) => l.remove());
  for (const ev of register?.publishedEvents ?? []) {
    const l = document.createElement('label'); const i = document.createElement('input'); i.type = 'checkbox'; i.value = ev; i.checked = had.has(ev); i.disabled = !mayEdit;
    l.append(i, document.createTextNode(ev)); box.append(l);
  }
}

function li(text, button) { const el = document.createElement('li'); const span = document.createElement('span'); span.textContent = text; el.append(span); if (button) el.append(button); return el; }

function paintRecord() {
  $('record').hidden = open === null;
  if (open === null) return;
  const s = open.sub;
  $('record-h').textContent = fill(t('recordH'), { id: s.subscriptionId });
  $('facts').replaceChildren(...[
    fill(t('fPartner'), { v: s.partnerId }), fill(t('fUrl'), { v: s.url }), fill(t('fEvents'), { v: s.eventTypes.join(', ') }), fill(t('fKey'), { v: s.signingKeyRef }),
    fill(t('fTries'), { v: s.maxAttempts }), fill(t('fVersion'), { v: s.version, by: s.setBy, at: day(s.setAt) }), ...(s.approvedBy ? [fill(t('fApproved'), { v: s.approvedBy })] : []),
    fill(t('fFrom'), { v: day(s.deliverFrom) }), s.active ? t('on') : t('offWord'),
  ].map((x) => li(x)));
  $('off').hidden = !s.active || !mayEdit;
  const dead = open.dead ?? [];
  $('dead-list').replaceChildren(...(open.dead === null ? [li(t('notKnown'))] : dead.length === 0 ? [li(t('noDead'))] : dead.map((d) => {
    let b;
    if (mayEdit) { b = document.createElement('button'); b.type = 'button'; b.textContent = t('again'); b.dataset.message = d.messageId; b.addEventListener('click', () => { void sendAgain(d.messageId); }); }
    const row = li(fill(t('deadLine'), { type: d.type, at: day(d.occurredAt), attempts: d.attempts, detail: d.detail ?? '' }), b); row.dataset.message = d.messageId; return row;
  })));
  const r = open.recon;
  $('recon-totals').textContent = r ? fill(t('reconTotals'), { all: r.totals.all, delivered: r.totals.delivered, pending: r.totals.pending, dead: r.totals.deadLettered }) : '';
  $('recon-list').replaceChildren(...(r ? r.messages.map((m) => li(fill(t('msgLine'), { type: m.type, at: day(m.occurredAt), status: m.status === 'delivered' ? t('stDelivered') : m.status === 'dead_lettered' ? t('stDead') : t('stPending'), detail: m.detail ? ` (${m.detail})` : '' }))) : []));
}

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['k-subs', 'kSubs'], ['k-dead', 'kDead'], ['k-sender', 'kSender'], ['refresh', 'refresh'], ['drain', 'drain'],
    ['list-h', 'listH'], ['list-lead', 'listLead'], ['c-id', 'cId'], ['c-partner', 'cPartner'], ['c-events', 'cEvents'], ['c-state', 'cState'], ['c-delivered', 'cDelivered'], ['c-waiting', 'cWaiting'], ['c-dead', 'cDead'],
    ['off', 'off'], ['dead-h', 'deadH'], ['dead-lead', 'deadLead'], ['recon-h', 'reconH'], ['l-recon-from', 'reconFrom'], ['recon', 'recon'],
    ['new-h', 'newH'], ['new-lead', 'newLead'], ['l-s-id', 'sId'], ['l-s-partner', 'sPartner'], ['l-s-url', 'sUrl'], ['l-s-key', 'sKey'], ['l-s-tries', 'sTries'], ['l-s-events', 'sEvents'],
    ['s-save', 'save'], ['l-s-why', 'why'], ['s-ask', 'ask'], ['q-h', 'qH'], ['q-lead', 'qLead'], ['l-q-id', 'qId'], ['q-read', 'qRead']]) { const el = $(id); if (el) el.textContent = t(k); }
  $('lang').textContent = t('lang');
  $('nobody').hidden = named; $('nobody').textContent = t('nobody');
  $('new').hidden = !mayEdit;
  $('drain').hidden = !mayEdit;
  $('s-ask').hidden = pending === null;
  paintList(); paintRecord();
}

async function load() {
  const out = await call('GET', '/v1/integration/outbound-webhooks');
  const st = $('page-status');
  if (!out.ok) { register = null; say(st, out, ''); paint(); return; }
  register = out.body;
  if (!mayEdit) { st.className = 'status'; st.textContent = t('readOnly'); } else if (st.classList.contains('err')) st.textContent = '';
  paint();
  if (open !== null) await openSub(open.sub.subscriptionId, true);
  const h = await call('GET', '/v1/integration/health');
  const ids = (Array.isArray(h.body?.adapters) ? h.body.adapters : []).map((a) => a.adapterId).filter((x) => typeof x === 'string');
  $('q-known').replaceChildren(...ids.map((id) => Object.assign(document.createElement('option'), { value: id })));
}

async function openSub(id, quiet = false) {
  const sub = register?.subscriptions.find((s) => s.subscriptionId === id);
  if (sub === undefined) return;
  const dead = await call('GET', `/v1/integration/outbound-webhooks/${encodeURIComponent(id)}/dead-letters`);
  open = { sub, dead: dead.ok && Array.isArray(dead.body?.deadLetters) ? dead.body.deadLetters : null, recon: open?.sub.subscriptionId === id ? open.recon : null };
  if (!quiet) $('record-status').textContent = '';
  if (!dead.ok) say($('record-status'), dead, '');
  paint();
  if (!quiet) $('record').scrollIntoView({ block: 'nearest' });
}

async function sendAgain(messageId) {
  const id = open.sub.subscriptionId;
  const out = await call('POST', `/v1/integration/outbound-webhooks/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/redeliver`, {});
  if (!out.ok) { say($('record-status'), out, ''); return; }
  await load();
  tell($('record-status'), true, fill(t('sentAgain'), { series: out.body?.series ?? '' }));
}

function subscriptionBody() {
  const id = $('s-id').value.trim(); const partnerId = $('s-partner').value.trim(); const url = $('s-url').value.trim(); const name = $('s-key').value.trim().replace(/^vault:\/\//, '');
  const eventTypes = [...$('s-events').querySelectorAll('input:checked')].map((i) => i.value).sort();
  const tries = Number($('s-tries').value.trim() || '8');
  if (id === '' || partnerId === '' || url === '' || name === '' || eventTypes.length === 0) return { error: t('needFields') };
  if (!/^[A-Za-z0-9-]{1,60}$/.test(id)) return { error: t('badId') };
  return { id, body: { partnerId, url, eventTypes, signingKeyRef: `vault://${name}`, maxAttempts: Number.isInteger(tries) ? tries : $('s-tries').value } };
}

$('s-save').addEventListener('click', async () => {
  const st = $('new-status');
  const made = subscriptionBody();
  if (made.error !== undefined) { tell(st, false, made.error); return; }
  const details = { ...made.body, subscriptionId: made.id };
  const found = await ownApproval(register?.approvalKind ?? 'partner_webhook_subscription', made.id, details);
  if (found.waiting === true) { tell(st, false, t('waiting')); return; }
  const out = await call('POST', `/v1/integration/outbound-webhooks/${encodeURIComponent(made.id)}`, { ...made.body, ...(found.approvalId === undefined ? {} : { approvalId: found.approvalId }) });
  if (!out.ok && out.body?.error?.code === 'partner_subscription_needs_approval') {
    pending = { subscriptionId: made.id, details, summary: `Partner ${made.body.partnerId}: ${made.body.eventTypes.join(', ')} to ${made.body.url}` };
    paint();
    tell(st, false, found.rejected !== undefined ? fill(t('rejected'), { why: found.rejected }) : fill(t('needApproval'), { why: out.body.error.whatHappened }));
    return;
  }
  pending = null;
  if (!out.ok) { say(st, out, ''); paint(); return; }
  await load();
  tell(st, true, out.body?.unchanged === true ? t('unchanged') : fill(t('saved'), { by: out.body?.subscription?.approvedBy ?? found.decidedBy ?? '' }));
});
$('s-ask').addEventListener('click', async () => {
  const st = $('new-status');
  const why = $('s-why').value.trim();
  if (why === '') { tell(st, false, t('needWhy')); return; }
  if (pending === null) return;
  const out = await call('POST', '/v1/approvals/requests', { kind: register?.approvalKind ?? 'partner_webhook_subscription', subjectRef: pending.subscriptionId, details: pending.details, valueMinor: null, summary: pending.summary, reason: why });
  if (out.ok) { pending = null; paint(); tell(st, true, t('asked')); } else say(st, out, '');
});
$('off').addEventListener('click', async () => {
  const out = await call('POST', `/v1/integration/outbound-webhooks/${encodeURIComponent(open.sub.subscriptionId)}/deactivate`, {});
  if (!out.ok) { say($('record-status'), out, ''); return; }
  await load();
  tell($('record-status'), true, t('offDone'));
});
$('recon').addEventListener('click', async () => {
  const from = $('recon-from').value;
  const q = from === '' ? '' : `?from=${encodeURIComponent(new Date(`${from}T00:00:00+05:30`).toISOString())}`;
  const out = await call('GET', `/v1/integration/outbound-webhooks/${encodeURIComponent(open.sub.subscriptionId)}/reconciliation${q}`);
  if (!out.ok) { say($('record-status'), out, ''); return; }
  open = { ...open, recon: out.body };
  paintRecord();
});
$('drain').addEventListener('click', async () => {
  const out = await call('POST', '/v1/integration/outbound-deliveries/drain', {});
  if (!out.ok) { say($('page-status'), out, ''); return; }
  await load();
  tell($('page-status'), true, fill(t('drained'), { n: Array.isArray(out.body?.outcome) ? out.body.outcome.length : 0 }));
});
$('refresh').addEventListener('click', () => { void load(); });
$('q-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('q-id').value.trim(); const st = $('q-status');
  if (id === '') { tell(st, false, t('needConnector')); return; }
  const [p, d] = await Promise.all([call('GET', `/v1/integration/connectors/${encodeURIComponent(id)}/queue/pending`), call('GET', `/v1/integration/connectors/${encodeURIComponent(id)}/queue/dead-letters`)]);
  if (!p.ok || !d.ok) { say(st, !p.ok ? p : d, ''); return; }
  st.textContent = '';
  const line = (m, state) => li(fill(t('qLine'), { state, kind: m.kind, id: m.messageId, attempts: m.attempts, err: m.lastError ? `: ${m.lastError}` : '' }));
  $('q-totals').textContent = fill(t('qTotals'), { pending: p.body.count, dead: d.body.count });
  $('q-list').replaceChildren(...d.body.deadLetters.map((m) => line(m, t('qDeadWord'))), ...p.body.pending.map((m) => line(m, t('qWaiting'))));
});
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });

paint();
if (named && !mayRead) tell($('page-status'), false, t('noRight'));
if (named && mayRead) void load();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* the page still opens; it is not kept for offline use */ });
}
