// Admin and security — the view layer. Every rule lives in the TESTED session model
// (`apps/web-erp/src/admin-session.ts`), attached as `window.adminSession`.
//
// ── The decision this screen is built around ────────────────────────────────
//
// **Outside access is the first tab, not a settings page three levels down.** Somebody who is not
// part of this business being inside a customer's live data is the most serious thing this screen
// has to say, and a live session is drawn as loudly as the product knows how.
//
// ── And the two that follow ─────────────────────────────────────────────────
//
// **A grant that has expired is not access**, and that is decided from the clock every time this
// renders — never from a stored flag, because a flag has to be turned off by something and that
// something is exactly what did not exist.
//
// **Blanket access cannot be asked for.** The scopes box is not optional decoration: an empty one
// is refused by the rule, in the shop's words, rather than quietly granting everything.
//
// No `prompt`, `confirm` or `alert`; the banner does not fade.

const el = (id) => document.getElementById(id);

// ── Words ───────────────────────────────────────────────────────────────────

const WORDS = {
  en: {
    staleShell: 'No connection to the store computer. This page is what it was last told, at',
    title: 'Admin and security',
    support: 'Outside access', people: 'Who can get in', fleet: 'Tills and devices', records: 'Records kept',
    supportLead: 'Anybody outside this business who has been let into your live data. Access is granted for a set time and for named things only — never everything, and never open-ended.',
    peopleLead: 'Every account, and anything about it worth a second look.',
    fleetLead: 'What this shop runs on, and whether each one is allowed to take a sale.',
    recordsLead: 'What the rules say may eventually be deleted, and what a legal hold stops being deleted. Nothing on this screen deletes anything.',
    grantTitle: 'Let somebody in', whoInLabel: 'Who needs access',
    grantReasonLabel: 'What are they looking at, and why',
    scopesLabel: 'Exactly what they may see (one per line)',
    minutesLabel: 'For how many minutes', approverLabel: 'Who approves it (not them)',
    grant: 'Let them in',
    grantNote: 'This is somebody outside your business seeing your real data. It ends by itself when the time runs out.',
    liveNow: 'IN YOUR DATA NOW', ended: 'finished', minutesLeft: 'minutes left',
    maySee: 'may see', actions: 'things done', approvedBy: 'approved by',
    noSupport: 'Nobody outside this business has been let in.',
    noAccounts: 'This screen has not been told about any accounts.',
    nothingFlagged: 'nothing to look at',
    devicesTotal: 'devices', trading: 'can take a sale', blocked: 'blocked', mustUpgrade: 'must be updated',
    silent: 'not reported in',
    noPolicy: 'This shop has not set a minimum version, so NOTHING is being enforced on any device. That is not the same as every device being up to date.',
    noRetention: 'This shop has not decided how long to keep anything, so nothing has been worked out. That is not the same as nothing being due for deletion.',
    heldBy: 'held', keep: 'keep', noRecords: 'Nothing to review.',
    ok: 'OK', read: 'Please read this', done: 'Access granted',
    nobodyNamed: 'This store box has not been told who is using this screen. Nobody can be let in — letting somebody into a customer’s live data carries the name of whoever let them in.',
    sampleData: 'Sample data — this is not your shop.',
  },
  ta: {
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:',
    title: 'நிர்வாகமும் பாதுகாப்பும்',
    support: 'வெளியாட்கள் அணுகல்', people: 'யார் உள்ளே வர முடியும்', fleet: 'பில்லிங் இயந்திரங்கள்', records: 'வைத்திருக்கும் பதிவுகள்',
    supportLead: 'உங்கள் நேரடித் தகவலுக்குள் அனுமதிக்கப்பட்ட, இந்த வணிகத்திற்கு வெளியே உள்ள எவரும். அணுகல் ஒரு குறிப்பிட்ட நேரத்திற்கும் குறிப்பிட்ட விஷயங்களுக்கும் மட்டுமே — எல்லாவற்றுக்கும் அல்ல, முடிவில்லாமலும் அல்ல.',
    peopleLead: 'ஒவ்வொரு கணக்கும், அதில் இரண்டாவது முறை பார்க்க வேண்டியவையும்.',
    fleetLead: 'இந்தக் கடை எதில் இயங்குகிறது, ஒவ்வொன்றும் விற்பனை செய்ய அனுமதிக்கப்பட்டுள்ளதா.',
    recordsLead: 'விதிகளின்படி எது நீக்கப்படலாம், சட்டப்பூர்வ தடை எதை நீக்கவிடாது. இந்தத் திரை எதையும் நீக்காது.',
    grantTitle: 'ஒருவரை உள்ளே அனுமதி', whoInLabel: 'யாருக்கு அணுகல் தேவை',
    grantReasonLabel: 'அவர்கள் எதைப் பார்க்கிறார்கள், ஏன்',
    scopesLabel: 'அவர்கள் என்ன பார்க்கலாம் (ஒரு வரிக்கு ஒன்று)',
    minutesLabel: 'எத்தனை நிமிடங்களுக்கு', approverLabel: 'யார் அனுமதிக்கிறார்கள் (அவர்கள் அல்ல)',
    grant: 'உள்ளே அனுமதி',
    grantNote: 'இது உங்கள் வணிகத்திற்கு வெளியே உள்ள ஒருவர் உங்கள் உண்மையான தகவலைப் பார்ப்பது. நேரம் முடிந்தவுடன் தானாகவே முடிந்துவிடும்.',
    liveNow: 'இப்போது உங்கள் தகவலுக்குள்', ended: 'முடிந்தது', minutesLeft: 'நிமிடங்கள் உள்ளன',
    maySee: 'பார்க்கலாம்', actions: 'செய்யப்பட்டவை', approvedBy: 'அனுமதித்தவர்',
    noSupport: 'இந்த வணிகத்திற்கு வெளியே உள்ள யாரும் அனுமதிக்கப்படவில்லை.',
    noAccounts: 'எந்தக் கணக்கு பற்றியும் இந்தத் திரைக்குச் சொல்லப்படவில்லை.',
    nothingFlagged: 'பார்க்க எதுவும் இல்லை',
    devicesTotal: 'சாதனங்கள்', trading: 'விற்பனை செய்யலாம்', blocked: 'தடுக்கப்பட்டது', mustUpgrade: 'புதுப்பிக்க வேண்டும்',
    silent: 'தகவல் அனுப்பவில்லை',
    noPolicy: 'இந்தக் கடை குறைந்தபட்ச பதிப்பை நிர்ணயிக்கவில்லை. எனவே எந்தச் சாதனத்திலும் எதுவும் அமல்படுத்தப்படவில்லை. எல்லா சாதனங்களும் புதுப்பித்த நிலையில் உள்ளன என்பது இதன் பொருள் அல்ல.',
    noRetention: 'எதை எவ்வளவு காலம் வைத்திருப்பது என்று இந்தக் கடை முடிவு செய்யவில்லை. எனவே எதுவும் கணக்கிடப்படவில்லை. நீக்க எதுவும் இல்லை என்பது இதன் பொருள் அல்ல.',
    heldBy: 'தடை உள்ளது', keep: 'வைத்திரு', noRecords: 'பரிசீலிக்க எதுவும் இல்லை.',
    ok: 'சரி', read: 'இதைப் படிக்கவும்', done: 'அணுகல் வழங்கப்பட்டது',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைப் பெட்டிக்குத் தெரியவில்லை. யாரையும் உள்ளே அனுமதிக்க முடியாது — வாடிக்கையாளரின் நேரடித் தகவலுக்குள் ஒருவரை அனுமதிப்பது அனுமதித்தவரின் பெயரைச் சுமக்கும்.',
    sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];

/** Why access could not be granted — one entry per `GrantRefusal`, both languages. */
const GRANT_REFUSAL_WORDS = {
  nobody_is_named_at_this_desk: {
    en: 'This store computer has not been told who is using this screen.',
    ta: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
  },
  refused_by_policy: {
    en: 'The rules refused this. Nobody was let in.',
    ta: 'விதிகள் இதை மறுத்தன. யாரும் உள்ளே அனுமதிக்கப்படவில்லை.',
  },
};

/** What a device may do — one entry per `DeviceVerdict`, both languages. */
const VERDICT_WORDS = {
  ok: { en: 'up to date', ta: 'புதுப்பித்த நிலையில்' },
  upgrade_available: { en: 'an update is available', ta: 'புதுப்பிப்பு உள்ளது' },
  upgrade_required: { en: 'must be updated before it can sell', ta: 'விற்பனைக்கு முன் புதுப்பிக்க வேண்டும்' },
  blocked: { en: 'BLOCKED — cannot take a sale', ta: 'தடுக்கப்பட்டது — விற்பனை செய்ய முடியாது' },
  unknown: { en: 'this device is not known', ta: 'இந்தச் சாதனம் தெரியவில்லை' },
};

const words = (map, key) => (map[key]?.[lang] ?? map[key]?.en ?? String(key).replace(/_/g, ' '));

/** A stand-in with the same surface as the bundled session, announced whenever it is in use. */
function sampleSession() {
  return {
    access: () => [],
    support: () => [],
    grant: () => ({ ok: false, refusal: 'nobody_is_named_at_this_desk', detail: 'this is sample data' }),
    fleet: () => ({ summary: undefined, verdicts: [], policyKnown: false }),
    retention: () => undefined,
  };
}

const real = window.adminSession;
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

// ── Outside access ──────────────────────────────────────────────────────────

function renderSupport() {
  const list = session.support();
  el('support-list').replaceChildren(...(list.length === 0
    ? [emptyLine(t('noSupport'))]
    : list.map((view) => {
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
      const detail = document.createElement('small');
      detail.textContent = `${view.session.reason} · ${t('approvedBy')} ${view.session.approvedBy}`
        + ` · ${view.actionCount} ${t('actions')}`;

      what.append(name, scopes, detail);
      row.append(what);
      return row;
    })));
}

el('grant').addEventListener('click', () => {
  const scopes = el('scopes').value.split('\n').map((s) => s.trim()).filter((s) => s !== '');
  const requesterId = el('who-in').value.trim();
  const outcome = session.grant({
    request: {
      requestId: `SUP-${requesterId}-${el('minutes').value}`,
      requesterId,
      requesterName: requesterId,
      reason: el('grant-reason').value,
      // Never defaulted to everything. An empty list is refused by the rule, in the shop's words.
      scopes,
      tenantId: window.adminData?.storeId ?? '',
      minutes: Number(el('minutes').value.replace(/[^0-9]/g, '') || '0'),
      at: window.adminData?.now ?? '',
    },
    approval: {
      subjectRef: `SUP-${requesterId}-${el('minutes').value}`,
      status: 'approved',
      decidedBy: el('approver').value.trim(),
    },
  });
  if (!outcome.ok) {
    tell(t('read'), `${words(GRANT_REFUSAL_WORDS, outcome.refusal)} ${outcome.detail}`);
    return;
  }
  tell(t('done'), `${outcome.view.minutesLeft} ${t('minutesLeft')} · ${t('maySee')}: ${outcome.view.scopes.join(', ')}`, true);
  renderSupport();
});

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
    ['grant-title', 'grantTitle'], ['who-in-label', 'whoInLabel'],
    ['grant-reason-label', 'grantReasonLabel'], ['scopes-label', 'scopesLabel'],
    ['minutes-label', 'minutesLabel'], ['approver-label', 'approverLabel'],
    ['grant', 'grant'], ['grant-note', 'grantNote'], ['sample', 'sampleData'],
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
});

// ── Boot ────────────────────────────────────────────────────────────────────

el('sample').hidden = real !== undefined;
paintChrome();
show('support');

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
