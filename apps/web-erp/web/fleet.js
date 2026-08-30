// Device fleet manager — the view layer. Every rule lives in the TESTED session model
// (apps/web-erp/src/fleet-session.ts), attached as window.fleetSession, built on packages/ui + packages/a11y.
// This file only draws what the session hands it: the shop's tills, scanners, scales and kiosks with their
// health — the ones that need a look first (cannot trade, then must-update, then gone-quiet), each with a
// status that is never a bare colour (an icon + a word ride with it), and the fleet at a glance.
//
// A manager who holds the right permission can also CHANGE a device from here — block a broken one, retire an
// old one, or bring one back. The click never calls the network (hard rule #1): the session commits a
// deterministic command to the offline OUTBOX (window.fleetOutbox), which survives a reload and a lost
// connection (§31); the authenticated delivery of that command to the registry is the follow-up increment. A
// change always needs a short reason (kept with it — an append-only "why"), captured on an on-screen sheet.
// No prompt/confirm/alert — every affordance is real DOM.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: { title: 'Devices', langName: 'தமிழ்',
      lead: 'Sample fleet. Connect the store computer to see the shop’s own tills, scanners, scales and kiosks.',
      tileTotal: 'Devices', tileTrading: 'Trading', tileMustUpgrade: 'Must update', tileBlocked: 'Blocked', tileSilent: 'Gone quiet',
      attentionLead: 'need a look', allWell: 'Every device is up to date and checking in.',
      versionLabel: 'Version', lastSeenLabel: 'Last seen', branchLabel: 'Branch', neverSeen: 'never checked in',
      canManage: 'You can register, block or retire a device.',
      sampleData: 'Sample data — this is not your shop.',
      staleShell: 'No connection to the store computer. This page is what it was last told, at', nobodyNamed: '' },
    ta: { title: 'சாதனங்கள்', langName: 'English',
      lead: 'மாதிரி கடற்படை. கடையின் சொந்த இயந்திரங்களைப் பார்க்க கடை கணினியை இணைக்கவும்.',
      tileTotal: 'சாதனங்கள்', tileTrading: 'வர்த்தகம்', tileMustUpgrade: 'புதுப்பிக்க வேண்டும்', tileBlocked: 'தடுக்கப்பட்டது', tileSilent: 'அமைதி',
      attentionLead: 'கவனம் தேவை', allWell: 'ஒவ்வொரு சாதனமும் புதுப்பித்து தகவல் அனுப்புகிறது.',
      versionLabel: 'பதிப்பு', lastSeenLabel: 'கடைசியாக பார்த்தது', branchLabel: 'கிளை', neverSeen: 'ஒருபோதும் தெரிவிக்கவில்லை',
      canManage: 'நீங்கள் ஒரு சாதனத்தை பதிவு செய்யலாம், தடுக்கலாம் அல்லது நீக்கலாம்.',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
      staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', nobodyNamed: '' },
  };
  const dev = (deviceId, label, kind, branchId, version, lastSeen, tone, icon, statusLabel, needsAttention, silent) => ({
    deviceId, label, kind, branchId, version, lastSeen,
    status: { tone, icon, label: statusLabel, announcement: `${label}: ${statusLabel}`, needsAttention },
    needsAttention, silent, detail: '', actions: [], // a sample cannot be changed — buttons appear with real data
  });
  const devices = (l) => l === 'ta'
    ? [dev('till-03', 'பில்லிங் 3', 'till', 'main', '2.0.4', '2026-08-29 09:12', 'error', '⚠', 'வர்த்தகத்திற்கு முன் புதுப்பிக்க வேண்டும்', true, false),
       dev('scan-07', 'கை ஸ்கேனர் 7', 'handheld', 'main', '1.6.0', '2026-08-27 18:40', 'degraded', '↑', 'புதுப்பிப்பு உள்ளது · அமைதியாகிவிட்டது', true, true),
       dev('till-01', 'பில்லிங் 1', 'till', 'main', '2.1.0', '2026-08-29 09:20', 'ok', '✓', 'புதுப்பித்தது', false, false)]
    : [dev('till-03', 'Till 3', 'till', 'main', '2.0.4', '2026-08-29 09:12', 'error', '⚠', 'Must update before trading', true, false),
       dev('scan-07', 'Handheld 7', 'handheld', 'main', '1.6.0', '2026-08-27 18:40', 'degraded', '↑', 'Update available · Gone quiet', true, true),
       dev('till-01', 'Till 1', 'till', 'main', '2.1.0', '2026-08-29 09:20', 'ok', '✓', 'Up to date', false, false)];
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => {
      const d = devices(l);
      return {
        screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
        devices: d,
        summary: { total: 3, trading: 3, blocked: 0, mustUpgrade: 1, silent: 1, byVersion: { '2.1.0': 1, '2.0.4': 1, '1.6.0': 1 } },
        attentionCount: d.filter((x) => x.needsAttention).length,
        total: d.length, mayManage: true, nobodyNamed: false,
      };
    },
  };
}

const real = window.fleetSession;
const session = real ?? sampleSession();
const t = (key) => session.text(lang, key);
let attentionOnly = false;
const VIEW_WORDS = {
  en: { filterAll: 'Show all', filterAttention: 'Only the ones that need a look' },
  ta: { filterAll: 'அனைத்தையும் காட்டு', filterAttention: 'கவனம் தேவைப்படுபவை மட்டும்' },
};
const vw = (key) => VIEW_WORDS[lang]?.[key] ?? VIEW_WORDS.en[key] ?? key;

// Shell chrome for the change flow (the domain button labels come from the session as a.label).
const ACTION_WORDS = {
  en: {
    reasonPrompt: 'Give a short reason — it is kept with this change.', reasonPlaceholder: 'e.g. screen cracked',
    confirm: 'Confirm', cancel: 'Cancel', pending: 'waiting to send',
    refMissingReason: 'Please give a short reason.',
    refAlreadyQueued: 'That change is already waiting to send.',
    refNotPermitted: 'You do not have permission to change devices.',
    refNoOutbox: 'This screen cannot save changes right now.',
    refDefault: 'That change cannot be made right now.',
    sampleChange: 'This is sample data — connect the store computer to change a real device.',
  },
  ta: {
    reasonPrompt: 'ஒரு சிறு காரணம் தரவும் — இது இந்த மாற்றத்துடன் வைக்கப்படும்.', reasonPlaceholder: 'எ.கா. திரை உடைந்தது',
    confirm: 'உறுதிசெய்', cancel: 'ரத்து', pending: 'அனுப்பக் காத்திருக்கிறது',
    refMissingReason: 'ஒரு சிறு காரணம் தரவும்.',
    refAlreadyQueued: 'அந்த மாற்றம் ஏற்கனவே அனுப்பக் காத்திருக்கிறது.',
    refNotPermitted: 'சாதனங்களை மாற்ற உங்களுக்கு அனுமதி இல்லை.',
    refNoOutbox: 'இந்தத் திரை இப்போது மாற்றங்களைச் சேமிக்க முடியாது.',
    refDefault: 'அந்த மாற்றத்தை இப்போது செய்ய முடியாது.',
    sampleChange: 'இது மாதிரித் தகவல் — உண்மையான சாதனத்தை மாற்ற கடை கணினியை இணைக்கவும்.',
  },
};
const aw = (key) => ACTION_WORDS[lang]?.[key] ?? ACTION_WORDS.en[key] ?? key;
const REFUSAL = {
  missing_reason: 'refMissingReason', already_queued: 'refAlreadyQueued',
  not_permitted: 'refNotPermitted', no_outbox: 'refNoOutbox',
};

/** The action a manager is being asked to confirm, or null when the sheet is closed. */
let pendingAction = null;

function tileNode(count, labelKey, cls) {
  const div = document.createElement('div');
  div.className = count > 0 && cls ? `tile ${cls}` : 'tile';
  const b = document.createElement('b'); b.textContent = String(count);
  const span = document.createElement('span'); span.textContent = t(labelKey);
  div.append(b, span);
  return div;
}

function rowNode(d) {
  const li = document.createElement('li');
  li.className = `row tone-${d.status.tone}`;

  const head = document.createElement('div');
  head.className = 'head';
  const name = document.createElement('span'); name.className = 'name'; name.textContent = d.label;
  const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = d.kind;
  head.append(name, kind);
  li.append(head);

  const status = document.createElement('div');
  status.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = d.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = d.status.label;
  status.append(icon, slabel);
  status.setAttribute('aria-label', d.status.announcement || d.status.label);
  li.append(status);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const v = document.createElement('span'); v.textContent = `${t('versionLabel')}: ${d.version}`; meta.append(v);
  const s = document.createElement('span'); s.textContent = `${t('lastSeenLabel')}: ${d.lastSeen}`; meta.append(s);
  const br = document.createElement('span'); br.textContent = `${t('branchLabel')}: ${d.branchId}`; meta.append(br);
  li.append(meta);

  const actions = d.actions ?? [];
  if (actions.length > 0) {
    const bar = document.createElement('div');
    bar.className = 'actions';
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `act act-${a.change}`;
      btn.textContent = a.label;
      btn.disabled = !a.enabled;
      btn.addEventListener('click', () => openSheet(a, d.label));
      bar.append(btn);
      if (a.note) { const n = document.createElement('span'); n.className = 'act-note'; n.textContent = a.note; bar.append(n); }
    }
    li.append(bar);
  }

  return li;
}

/** Open the on-screen reason sheet for a change (never a browser prompt). */
function openSheet(action, deviceLabel) {
  pendingAction = action;
  el('sheet-title').textContent = `${action.label} — ${deviceLabel}`;
  el('reason').value = '';
  el('reason').placeholder = aw('reasonPlaceholder');
  el('sheet-prompt').textContent = aw('reasonPrompt');
  el('sheet-confirm').textContent = aw('confirm');
  el('sheet-cancel').textContent = aw('cancel');
  el('sheet-msg').textContent = '';
  el('sheet').hidden = false;
  el('reason').focus();
}

function closeSheet() { pendingAction = null; el('sheet').hidden = true; }

function confirmSheet() {
  if (pendingAction === null) return;
  if (typeof session.requestDeviceChange !== 'function') { el('sheet-msg').textContent = aw('sampleChange'); return; }
  const result = session.requestDeviceChange({
    deviceId: pendingAction.deviceId, change: pendingAction.change,
    reason: el('reason').value, at: new Date().toISOString(),
  });
  if (result.ok) { closeSheet(); paint(); }
  else { el('sheet-msg').textContent = aw(REFUSAL[result.reason] ?? 'refDefault'); }
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.fleetData?.userId ?? '';
  el('lang').textContent = t('langName');
  el('filter').textContent = attentionOnly ? vw('filterAll') : vw('filterAttention');
  el('filter').setAttribute('aria-pressed', attentionOnly ? 'true' : 'false');

  const s = view.summary;
  el('tiles').replaceChildren(
    tileNode(s.total, 'tileTotal', ''),
    tileNode(s.trading, 'tileTrading', 'good'),
    tileNode(s.mustUpgrade, 'tileMustUpgrade', 'attention'),
    tileNode(s.blocked, 'tileBlocked', 'bad'),
    tileNode(s.silent, 'tileSilent', 'attention'),
  );

  el('attention-count').textContent = view.attentionCount === 0
    ? t('allWell')
    : `${view.attentionCount} ${t('attentionLead')}`;
  el('attention-count').className = view.attentionCount === 0 ? 'count' : 'count attention';

  const manage = el('manage');
  manage.hidden = !view.mayManage;
  manage.textContent = view.mayManage ? t('canManage') : '';

  // How many changes are queued and waiting for a connection — never a silent backlog (P-08).
  const pending = el('pending');
  const waiting = (() => { try { return window.fleetOutbox?.unsentCount?.() ?? 0; } catch { return 0; } })();
  pending.hidden = waiting === 0;
  pending.textContent = waiting === 0 ? '' : `${waiting} ${aw('pending')}`;

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  const shown = attentionOnly ? view.devices.filter((d) => d.needsAttention) : view.devices;
  el('rows').replaceChildren(...shown.map(rowNode));

  const state = el('state');
  if (shown.length === 0) {
    state.hidden = false;
    state.className = `state tone-${view.screenState.tone}`;
    el('state-icon').textContent = view.screenState.icon;
    el('state-text').textContent = attentionOnly && view.total > 0 ? t('allWell') : view.screenState.label;
  } else {
    state.hidden = true;
  }
}

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; if (pendingAction !== null) closeSheet(); paint(); paintStale(); });
el('filter').addEventListener('click', () => { attentionOnly = !attentionOnly; paint(); });
el('sheet-confirm').addEventListener('click', confirmSheet);
el('sheet-cancel').addEventListener('click', closeSheet);

el('sample').hidden = real !== undefined;
el('sample').textContent = t('sampleData');
paint();

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
