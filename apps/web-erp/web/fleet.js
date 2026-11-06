// Device fleet manager — the view layer. Every rule lives in the TESTED session model
// (apps/web-erp/src/fleet-session.ts), attached as window.fleetSession, built on packages/ui + packages/a11y.
// This file only draws what the session hands it: the shop's tills, scanners, scales and kiosks with their
// health — the ones that need a look first (cannot trade, then must-update, then gone-quiet), each with a
// status that is never a bare colour (an icon + a word ride with it), and the fleet at a glance.
//
// A manager who holds the right permission can also CHANGE a device from here — block a broken one, retire an
// old one, or bring one back. The click never calls the network (hard rule #1): the session commits a
// deterministic command to the offline OUTBOX (window.fleetOutbox), which survives a reload and a lost
// connection (§31). A change always needs a short reason (kept with it — an append-only "why"), captured on an
// on-screen sheet. The EXPLICIT "Send now" action then delivers the queued changes to the registry — the
// session drains the outbox through an operator-authenticated port (the person's own session, never a service
// token), acknowledging what the cloud accepts, holding a lost-link change for retry, and dead-lettering a
// refusal for a person. Nothing auto-delivers (P-05), and the shell itself never opens a socket.
// No prompt/confirm/alert — every affordance is real DOM.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: { title: 'Tills & devices', langName: 'தமிழ்',
      lead: 'Sample fleet. Connect the store computer to see the shop’s own tills, scanners, scales and kiosks.',
      tileTotal: 'Devices', tileTrading: 'Trading', tileMustUpgrade: 'Must update', tileBlocked: 'Blocked', tileSilent: 'Gone quiet',
      attentionLead: 'need a look', allWell: 'Every device is up to date and checking in.',
      noneRegistered: 'Not known — no till or device is registered yet, so nothing can be checked. A till is registered when it is installed on the store computer (owner guide: installing a till).',
      versionLabel: 'Version', lastSeenLabel: 'Last seen', branchLabel: 'Branch', neverSeen: 'never checked in',
      canManage: 'You can register, block or retire a device.',
      sampleData: 'Sample data — this is not your shop.',
      nobodyNamed: '' },
    ta: { title: 'கல்லாக்களும் சாதனங்களும்', langName: 'English',
      lead: 'மாதிரி கடற்படை. கடையின் சொந்த இயந்திரங்களைப் பார்க்க கடை கணினியை இணைக்கவும்.',
      tileTotal: 'சாதனங்கள்', tileTrading: 'வர்த்தகம்', tileMustUpgrade: 'புதுப்பிக்க வேண்டும்', tileBlocked: 'தடுக்கப்பட்டது', tileSilent: 'அமைதி',
      attentionLead: 'கவனம் தேவை', allWell: 'ஒவ்வொரு சாதனமும் புதுப்பித்து தகவல் அனுப்புகிறது.',
      noneRegistered: 'தெரியாது — எந்தக் கல்லாவும் சாதனமும் இன்னும் பதிவு செய்யப்படவில்லை, எனவே எதையும் சரிபார்க்க முடியாது. கல்லா கடைக் கணினியில் நிறுவப்படும்போது பதிவு செய்யப்படுகிறது (உரிமையாளர் வழிகாட்டி: கல்லா நிறுவுதல்).',
      versionLabel: 'பதிப்பு', lastSeenLabel: 'கடைசியாக பார்த்தது', branchLabel: 'கிளை', neverSeen: 'ஒருபோதும் தெரிவிக்கவில்லை',
      canManage: 'நீங்கள் ஒரு சாதனத்தை பதிவு செய்யலாம், தடுக்கலாம் அல்லது நீக்கலாம்.',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
      nobodyNamed: '' },
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
// W6 · M33-FR-04: the fleet is head office's answer to this page's own read (window.fleetHealth, the bundled port — this file
// never calls the network). Until it has answered, or when it cannot, the page says so and shows no counts: an empty list is
// never "all well" (P-08).
const healthPort = real === undefined ? undefined : window.fleetHealth;
let healthRead = { state: 'not_read_yet' };
const healthLine = () => (healthPort === undefined ? null : healthPort.line(lang, healthRead));
function readHealth() {
  if (healthPort === undefined) return;
  healthPort.read().then((r) => { healthRead = r; paint(); }, () => { healthRead = { state: 'unreachable' }; paint(); });
}
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
    send: 'Send now', sending: 'Sending…',
    sent: 'sent', stillWaiting: 'still waiting', couldNotSend: 'could not be sent — a person should check',
    // Round 4c: register a till or device (the register form).
    registerH: 'Register a till or device',
    registerLead: 'A till nobody registered is a till nobody is accountable for. The change waits here until you press "Send now"; head office records who registered it.',
    regId: 'Device id (for a till, its lane id)', regKind: 'Kind', regLabel: 'Name people will see', regStore: 'Store', regVersion: 'App version (optional)', regBtn: 'Register it',
    regQueued: 'Waiting to send — press "Send now".', refMissingDetails: 'Give the device id, its kind, a name and the store.',
    kind_pos_lane: 'Till', kind_handheld: 'Handheld', kind_scale: 'Weighing scale', kind_printer: 'Printer', kind_kiosk: 'Kiosk', kind_mobile: 'Phone',
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
    send: 'இப்போது அனுப்பு', sending: 'அனுப்புகிறது…',
    sent: 'அனுப்பப்பட்டது', stillWaiting: 'இன்னும் காத்திருக்கிறது', couldNotSend: 'அனுப்ப முடியவில்லை — ஒருவர் சரிபார்க்க வேண்டும்',
    registerH: 'ஒரு கல்லா அல்லது சாதனத்தைப் பதிவு செய்',
    registerLead: 'யாரும் பதிவு செய்யாத கல்லாவுக்கு யாரும் பொறுப்பல்ல. "இப்போது அனுப்பு" அழுத்தும் வரை மாற்றம் இங்கே காத்திருக்கும்; யார் பதிவு செய்தார் என்பதைத் தலைமை அலுவலகம் பதிவு செய்யும்.',
    regId: 'சாதன அடையாளம் (கல்லாவுக்கு அதன் வரிசை அடையாளம்)', regKind: 'வகை', regLabel: 'மக்கள் பார்க்கும் பெயர்', regStore: 'கடை', regVersion: 'செயலிப் பதிப்பு (விருப்பம்)', regBtn: 'பதிவு செய்',
    regQueued: 'அனுப்பக் காத்திருக்கிறது — "இப்போது அனுப்பு" அழுத்துங்கள்.', refMissingDetails: 'சாதன அடையாளம், வகை, ஒரு பெயர், கடை ஆகியவற்றைத் தாருங்கள்.',
    kind_pos_lane: 'கல்லா', kind_handheld: 'கைக்கருவி', kind_scale: 'எடைத் தராசு', kind_printer: 'அச்சுப்பொறி', kind_kiosk: 'கியோஸ்க்', kind_mobile: 'கைபேசி',
  },
};
const aw = (key) => ACTION_WORDS[lang]?.[key] ?? ACTION_WORDS.en[key] ?? key;
const REFUSAL = {
  missing_reason: 'refMissingReason', already_queued: 'refAlreadyQueued',
  not_permitted: 'refNotPermitted', no_outbox: 'refNoOutbox', missing_details: 'refMissingDetails',
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
      btn.className = `act act-${a.change} sre-btn`;
      btn.textContent = a.label;
      btn.disabled = !a.enabled; whyDisabled(btn, a.enabled ? '' : (a.note ?? 'role'));
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

  const hl = healthLine();
  el('health').hidden = hl === null;
  if (hl !== null) {
    el('health').className = `vx-status tone-${hl.tone}`;
    el('health-icon').textContent = hl.tone === 'ok' ? '✓' : '?';
    el('health-text').textContent = hl.text;
  }
  const known = hl === null || hl.known;
  el('tiles').hidden = !known;
  const s = view.summary;
  el('tiles').replaceChildren(
    tileNode(s.total, 'tileTotal', ''),
    tileNode(s.trading, 'tileTrading', 'good'),
    tileNode(s.mustUpgrade, 'tileMustUpgrade', 'attention'),
    tileNode(s.blocked, 'tileBlocked', 'bad'),
    tileNode(s.silent, 'tileSilent', 'attention'),
  );

  // U0 (P-08): an empty register is NOT a healthy fleet — with nothing registered the line says "Not known" and why,
  // in the warn tone; "every device is up to date" is said only of devices that exist. Not read at all → nothing said.
  el('attention-count').textContent = !known ? '' : view.total === 0 ? t('noneRegistered')
    : view.attentionCount === 0 ? t('allWell')
    : `${view.attentionCount} ${t('attentionLead')}`;
  el('attention-count').className = view.total === 0 ? 'count unknown' : view.attentionCount === 0 ? 'count' : 'count attention';

  const manage = el('manage');
  manage.hidden = !view.mayManage;
  manage.textContent = view.mayManage ? t('canManage') : '';

  // How many changes are queued and waiting for a connection — never a silent backlog (P-08).
  const waiting = (() => { try { return window.fleetOutbox?.unsentCount?.() ?? 0; } catch { return 0; } })();
  const canSend = waiting > 0 && typeof session.deliver === 'function';
  el('pending-count').textContent = waiting === 0 ? '' : `${waiting} ${aw('pending')}`;
  el('send').hidden = !canSend;
  el('send').textContent = aw('send');
  el('pending').hidden = waiting === 0 && el('deliver-msg').textContent === '';

  // Round 4c: the register form — for a person who may change the fleet, on a real (not sample) session.
  el('register').hidden = !(view.mayManage && typeof session.requestDeviceChange === 'function' && real !== undefined);
  for (const [id, key] of [['register-h', 'registerH'], ['register-lead', 'registerLead'], ['reg-id-l', 'regId'], ['reg-kind-l', 'regKind'], ['reg-label-l', 'regLabel'], ['reg-store-l', 'regStore'], ['reg-version-l', 'regVersion'], ['reg-btn', 'regBtn']]) el(id).textContent = aw(key);
  const kindSel = el('reg-kind'); const kindWas = kindSel.value;
  kindSel.replaceChildren(...['pos_lane', 'handheld', 'scale', 'printer', 'kiosk', 'mobile'].map((k) => { const o = document.createElement('option'); o.value = k; o.textContent = aw(`kind_${k}`); return o; }));
  if (kindWas !== '') kindSel.value = kindWas;

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  const shown = attentionOnly ? view.devices.filter((d) => d.needsAttention) : view.devices;
  el('rows').replaceChildren(...shown.map(rowNode));

  const state = el('state');
  if (shown.length === 0 && !known) {
    state.hidden = true; // the health line above already says why the fleet is not known
  } else if (shown.length === 0) {
    state.hidden = false;
    state.className = `state tone-${view.screenState.tone}`;
    el('state-icon').textContent = view.screenState.icon;
    el('state-text').textContent = attentionOnly && view.total > 0 ? t('allWell') : view.screenState.label;
  } else {
    state.hidden = true;
  }
}

// ── R10-A · OB-540: handheld work done on a withdrawn or too-old app version ──────────────────────────────────────────
// Head office's register, read through the store computer by the bundled port (window.fleetVersionExceptions) — this file
// never calls the network. Read-only. Every way the read can fail is said in words, never an empty "all well" (P-08).
const vxPort = window.fleetVersionExceptions;
let vxRead = { state: 'not_read_yet' };
const VX_NOT_SERVED = {
  en: { heading: 'Handheld work on a withdrawn or too-old app version', text: 'Not known — this page was not opened from the store computer, so head office\'s list cannot be read here.' },
  ta: { heading: 'திரும்பப் பெற்ற அல்லது மிகப் பழைய செயலிப் பதிப்பில் கைக்கருவி செய்த பணி', text: 'தெரியாது — இந்தப் பக்கம் கடைக் கணினியிலிருந்து திறக்கப்படவில்லை, எனவே தலைமை அலுவலகப் பட்டியலை இங்கே படிக்க முடியாது.' },
};

function vxRowNode(r, labels) {
  const li = document.createElement('li');
  li.className = 'row vx-row';
  const dl = document.createElement('dl');
  for (const [label, value] of [[labels.kind, r.kind], [labels.version, r.version], [labels.what, r.what], [labels.when, r.when], [labels.finding, r.finding]]) {
    const dt = document.createElement('dt'); dt.textContent = label;
    const dd = document.createElement('dd'); dd.textContent = value;
    dl.append(dt, dd);
  }
  li.append(dl);
  if (r.detail) { const p = document.createElement('p'); p.className = 'vx-detail'; p.textContent = r.detail; li.append(p); }
  return li;
}

function paintVx() {
  if (vxPort === undefined) {
    const words = VX_NOT_SERVED[lang] ?? VX_NOT_SERVED.en;
    el('vx-h').textContent = words.heading; el('vx-lead').textContent = '';
    el('vx-status').className = 'vx-status tone-unknown'; el('vx-icon').textContent = '?'; el('vx-text').textContent = words.text;
    el('vx-asat').hidden = true; el('vx-info').hidden = true; el('vx-rows').replaceChildren();
    return;
  }
  const v = vxPort.view(lang, vxRead);
  el('vx-h').textContent = v.heading; el('vx-lead').textContent = v.lead;
  el('vx-status').className = `vx-status tone-${v.tone}`; el('vx-icon').textContent = v.icon; el('vx-text').textContent = v.status;
  el('vx-asat').hidden = v.asAt === null; el('vx-asat').textContent = v.asAt ?? '';
  el('vx-info').hidden = v.informational === null; el('vx-info').textContent = v.informational ?? '';
  el('vx-rows').replaceChildren(...v.rows.map((r) => vxRowNode(r, v.labels)));
}

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; if (pendingAction !== null) closeSheet(); paint(); paintVx(); });
el('filter').addEventListener('click', () => { attentionOnly = !attentionOnly; paint(); });
el('sheet-confirm').addEventListener('click', confirmSheet);
// Round 4c: register a till or device — queued in the outbox like every fleet change, sent on "Send now".
el('register-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (typeof session.requestDeviceChange !== 'function') { el('reg-status').textContent = aw('sampleChange'); return; }
  const version = el('reg-version').value.trim();
  const result = session.requestDeviceChange({
    deviceId: el('reg-id').value.trim(), change: 'register', at: new Date().toISOString(),
    register: { branchId: el('reg-store').value.trim(), kind: el('reg-kind').value, label: el('reg-label').value.trim(), ...(version === '' ? {} : { appVersion: version }) },
  });
  el('reg-status').textContent = result.ok ? aw('regQueued') : aw(REFUSAL[result.reason] ?? 'refDefault');
  if (result.ok) paint();
});
el('sheet-cancel').addEventListener('click', closeSheet);

// The EXPLICIT delivery action (P-05 — a person sends; nothing auto-delivers). The session drains the outbox
// through the operator-authenticated port; the shell only shows the result. It never calls the network itself.
el('send').addEventListener('click', async () => {
  if (typeof session.deliver !== 'function') return;
  const btn = el('send');
  btn.disabled = true; btn.textContent = aw('sending');
  try {
    const report = await session.deliver();
    const parts = [];
    if (report.delivered.length > 0) parts.push(`${report.delivered.length} ${aw('sent')}`);
    if (report.held.length > 0) parts.push(`${report.held.length} ${aw('stillWaiting')}`);
    if (report.refused.length > 0) parts.push(`${report.refused.length} ${aw('couldNotSend')}`);
    el('deliver-msg').textContent = parts.join(' · ');
  } finally {
    btn.disabled = false;
    paint(); // repaint: acknowledged/dead-lettered changes now show their new state on each device
    readHealth(); // W6: and read head office's fleet again, so a change it accepted shows as it now stands
  }
});

el('sample').hidden = real !== undefined;
el('sample').textContent = t('sampleData');
paint();
paintVx();
readHealth();
if (vxPort !== undefined) {
  vxPort.read().then((read) => { vxRead = read; paintVx(); }, () => { vxRead = { state: 'unreachable' }; paintVx(); });
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}

/** A greyed button says why (U1 · G3 · design system §4 "disabled state explains why"): the reason is the button's tooltip
 *  and the words beside it, in the reader's language. `why` is 'role' (your role may not), 'offline' (head office cannot
 *  be reached), a page's own { en, ta } pair or sentence; '' takes the words away. */
function whyWords() {
  return {
  role: { en: 'Your role may not do this.', ta: 'உங்கள் பங்குக்கு இதைச் செய்ய அனுமதி இல்லை.' },
  offline: { en: 'Head office cannot be reached, so this cannot be done now.', ta: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை, எனவே இப்போது இதைச் செய்ய முடியாது.' },
  };
}
function whyDisabled(btn, why) {
  const tongue = document.documentElement.lang === 'ta' ? 'ta' : 'en';
  const words = why === '' || why === undefined || why === null ? '' : typeof why === 'string' ? (whyWords()[why]?.[tongue] ?? why) : (why[tongue] ?? why.en);
  let note = btn.nextElementSibling;
  if (!(note && note.classList.contains('sre-why'))) {
    note = document.createElement('small'); note.className = 'sre-why';
    note.id = `${btn.id || `b${Math.random().toString(36).slice(2, 7)}`}-why`;
    btn.after(note);
  }
  note.textContent = words; note.hidden = words === '';
  if (words === '') { btn.removeAttribute('title'); btn.removeAttribute('aria-describedby'); } else { btn.title = words; btn.setAttribute('aria-describedby', note.id); }
}
