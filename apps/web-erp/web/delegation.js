// Delegation — the THIN CLIENT over head office's delegation register (M02-FR-03 · §28 · hard rule 4). It holds no
// rule: no self-delegation, no chains, no open end, never more than the lender holds, a separate authoriser — all are
// head office's tested engine (`/v1/access/delegations`), and every refusal is shown in its words. The authoriser is
// the signed-in person (head office takes it from the session, never from the page). Each POST carries its own
// idempotency key; afterwards the register is read again. Every word has a Tamil twin and follows the one toggle.

const $ = (id) => document.getElementById(id);
const who = window.delegationData && typeof window.delegationData === 'object' ? window.delegationData : null;
const perms = new Set(Array.isArray(who?.permissions) ? who.permissions : []);
const mayRead = perms.has('approvals.delegation.read');
const mayLend = perms.has('approvals.delegation.grant');
const KINDS = ['refund', 'price_change', 'purchase_order', 'stock_adjustment', 'day_reopen'];

const WORDS = {
  en: {
    title: 'Delegation', listH: 'Authority lent right now',
    listLede: 'Who is approving for whom, for what and until when. A delegation ends on its own on its last day; end one early here.',
    lendH: 'Lend someone\'s authority while they are away',
    lendLede: 'Never share a login. The colleague approves as themselves, under this delegation; you — a different person — authorise it.',
    from: 'Whose authority (the person away)', to: 'Lent to', fromDate: 'From', untilDate: 'Until (last day)', cap: 'Up to ₹ per decision (optional)',
    kinds: 'For these decisions', reason: 'Why', lend: 'Lend this authority', end: 'End it today',
    refund: 'Refunds', price_change: 'Price changes', purchase_order: 'Purchase orders', stock_adjustment: 'Stock corrections', day_reopen: 'Reopening a closed day',
    active: 'Lent now', expiring: 'Ends soon', expired: 'Ended', revoked: 'Ended early',
    lendsTo: 'lends to', until: 'until', daysLeft: 'days left',
    lent: 'Lent — head office recorded it, authorised by you.', ended: 'Ended — it no longer lets anyone approve.',
    needAll: 'Fill in whose authority, to whom, both dates, at least one kind of decision and why.', badCap: 'Write the cap in rupees, like 2000 or 2000.50.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.',
    none: 'No authority is lent right now.', reading: 'Reading the delegations from head office…', cannotRead: 'Your role cannot read delegations.',
    nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.',
  },
  ta: {
    title: 'அதிகாரப் பகிர்வு', listH: 'இப்போது வழங்கப்பட்ட அதிகாரம்',
    listLede: 'யார் யாருக்காக, எதற்கு, எப்போது வரை அனுமதிக்கிறார். ஒரு பகிர்வு தன் கடைசி நாளில் தானாக முடியும்; முன்னதாக முடிக்க இங்கே.',
    lendH: 'ஒருவர் இல்லாதபோது அவரது அதிகாரத்தை வழங்கு',
    lendLede: 'உள்நுழைவை ஒருபோதும் பகிராதீர்கள். சக ஊழியர் தம் பெயரிலேயே, இந்தப் பகிர்வின் கீழ் அனுமதிப்பார்; வேறொருவரான நீங்கள் அங்கீகரிக்கிறீர்கள்.',
    from: 'யாருடைய அதிகாரம் (இல்லாதவர்)', to: 'யாருக்கு', fromDate: 'இருந்து', untilDate: 'வரை (கடைசி நாள்)', cap: 'ஒரு முடிவுக்கு ₹ வரம்பு (விருப்பம்)',
    kinds: 'இந்த முடிவுகளுக்கு', reason: 'ஏன்', lend: 'இந்த அதிகாரத்தை வழங்கு', end: 'இன்றே முடி',
    refund: 'பணத்திருப்பம்', price_change: 'விலை மாற்றம்', purchase_order: 'கொள்முதல் ஆணை', stock_adjustment: 'இருப்புத் திருத்தம்', day_reopen: 'மூடிய நாளை மீண்டும் திறத்தல்',
    active: 'இப்போது வழங்கப்பட்டது', expiring: 'விரைவில் முடியும்', expired: 'முடிந்தது', revoked: 'முன்னதாக முடிக்கப்பட்டது',
    lendsTo: 'வழங்குகிறார்', until: 'வரை', daysLeft: 'நாட்கள் மீதம்',
    lent: 'வழங்கப்பட்டது — உங்கள் அங்கீகாரத்துடன் தலைமை அலுவலகம் பதிவு செய்தது.', ended: 'முடிக்கப்பட்டது — இனி யாரும் இதன் மூலம் அனுமதிக்க முடியாது.',
    needAll: 'யாருடைய அதிகாரம், யாருக்கு, இரண்டு தேதிகள், குறைந்தது ஒரு முடிவு வகை, காரணம் — அனைத்தையும் நிரப்புங்கள்.', badCap: 'வரம்பை ரூபாயில் எழுதுங்கள், உதா. 2000 அல்லது 2000.50.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
    none: 'இப்போது எந்த அதிகாரமும் வழங்கப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து பகிர்வுகளைப் படிக்கிறது…', cannotRead: 'உங்கள் பங்கால் பகிர்வுகளைப் படிக்க முடியாது.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.',
  },
};
let lang = 'en';
const t = (k) => WORDS[lang][k] ?? WORDS.en[k] ?? k;
const idem = () => ((crypto.randomUUID && crypto.randomUUID()) || `dlg-${Date.now()}-${Math.random()}`);

let rows = null;

async function post(path, body) {
  try {
    const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': idem() }, body: JSON.stringify(body ?? {}) });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}
function say(el, out, good) {
  el.className = `status ${out.ok ? 'good' : 'err'}`;
  el.textContent = out.ok ? good : out.status === 0 ? t('unreachable') : `${t('refused')} ${out.body?.error?.whatHappened ?? out.status}`;
}

/** Rupees as typed → whole paise, or undefined when it is not a plain amount. */
function paiseOf(text) {
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return undefined;
  const [r, p = ''] = text.split('.');
  return Number(r) * 100 + Number(p.padEnd(2, '0'));
}

function render() {
  const list = $('rows');
  list.replaceChildren();
  if (!mayRead) { $('list-status').textContent = who === null ? '' : t('cannotRead'); return; }
  if (rows === null) return;
  if (rows.length === 0) { const li = document.createElement('li'); li.className = 'muted'; li.textContent = t('none'); list.append(li); return; }
  for (const r of rows) {
    const li = document.createElement('li');
    li.className = `lend state-${r.state}`;
    li.dataset.delegation = r.delegationId;
    const head = document.createElement('div'); head.className = 'head';
    const line = document.createElement('span'); line.textContent = `${r.fromUserId} ${t('lendsTo')} ${r.toUserId}`;
    const state = document.createElement('span'); state.className = 'state'; state.dataset.state = r.state; state.textContent = t(r.state);
    head.append(line, state);
    const facts = document.createElement('p'); facts.className = 'facts';
    facts.textContent = `${t('until')} ${r.untilDate}${r.state === 'active' || r.state === 'expiring' ? ` · ${r.daysRemaining} ${t('daysLeft')}` : ''} · ${r.detail}`;
    li.append(head, facts);
    if (mayLend && (r.state === 'active' || r.state === 'expiring')) {
      const end = document.createElement('button'); end.type = 'button'; end.textContent = t('end'); end.dataset.act = 'end';
      end.addEventListener('click', async () => {
        const out = await post(`/v1/access/delegations/${encodeURIComponent(r.delegationId)}/revoke`, {});
        say($('list-status'), out, t('ended'));
        await load();
      });
      li.append(end);
    }
    list.append(li);
  }
}

function paintWords() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title', 'title'], ['list-h', 'listH'], ['list-lede', 'listLede'], ['lend-h', 'lendH'], ['lend-lede', 'lendLede'], ['l-from', 'from'], ['l-to', 'to'], ['l-from-date', 'fromDate'], ['l-until-date', 'untilDate'], ['l-cap', 'cap'], ['l-kinds', 'kinds'], ['l-reason', 'reason'], ['lend', 'lend'], ...KINDS.map((k) => [`k-${k}`, k])]) {
    const el = $(id);
    if (el) el.textContent = t(k);
  }
  $('lend-section').hidden = !mayLend;
  const nobody = $('nobody');
  nobody.hidden = who !== null;
  nobody.textContent = t('nobody');
}

async function load() {
  if (!mayRead) { render(); return; }
  try {
    const res = await fetch('/v1/access/delegations', { headers: { accept: 'application/json' }, credentials: 'same-origin' });
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    rows = Array.isArray(body.rows) ? body.rows : [];
    if ($('list-status').textContent === t('reading')) $('list-status').textContent = '';
  } catch {
    rows = null;
    $('list-status').className = 'status err';
    $('list-status').textContent = t('unreachable');
  }
  render();
}

$('lend').addEventListener('click', async () => {
  const fromUserId = $('from').value.trim();
  const toUserId = $('to').value.trim();
  const fromDate = $('from-date').value;
  const untilDate = $('until-date').value;
  const reason = $('reason').value.trim();
  const subjectTypes = [...document.querySelectorAll('input[name="kind"]:checked')].map((i) => i.value);
  const status = $('lend-status');
  if (fromUserId === '' || toUserId === '' || fromDate === '' || untilDate === '' || reason === '' || subjectTypes.length === 0) {
    status.className = 'status err'; status.textContent = t('needAll'); return;
  }
  const capText = $('cap').value.trim();
  const capMinor = capText === '' ? null : paiseOf(capText);
  if (capMinor === undefined) { status.className = 'status err'; status.textContent = t('badCap'); return; }
  const cap = capMinor === null ? null : { minor: capMinor, currency: 'INR' };
  const delegationId = `dlg-${fromUserId}-${toUserId}-${fromDate}-${Date.now().toString(36)}`;
  // The lender's own approver record: whose authority it is. Head office replaces its branches with where the lender
  // genuinely holds the authority, and refuses a delegation wider than that; the authoriser is this session.
  const out = await post(`/v1/access/delegations/${encodeURIComponent(delegationId)}`, {
    fromUserId, toUserId, fromDate, untilDate, subjectTypes, reason,
    granter: { userId: fromUserId, branchScope: 'all', authorityLimit: cap },
    ...(cap === null ? {} : { valueCap: cap }),
  });
  say(status, out, t('lent'));
  await load();
});

$('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintWords();
  render();
});

paintWords();
if (who !== null) { $('list-status').textContent = t('reading'); void load(); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
