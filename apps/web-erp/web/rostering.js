// Manager rostering — the view layer (M25-FR-01, API-11). Every rule lives in the TESTED session model
// (apps/web-erp/src/rostering-session.ts), attached as window.rosteringSession, built on packages/ui over the
// cloud's tested rosterGaps fold. This file only draws what the session hands it: the roster GAPS (worst first,
// each with the shift, the role, how short it is, and — for a manager — who can fill it), then a "put someone
// on a short shift" form. Assigning is a HUMAN decision that runs ONLY on an explicit click, never on load; on
// success the worklist is re-read (a GET) so the filled gap drops off. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: {
      title: 'Roster gaps', langName: 'தமிழ்',
      lead: 'Sample gaps. Connect the store computer to see the roster for your own shop.',
      gapsHeading: 'To fill', gapCount: 'to fill', allStaffed: 'No gaps — every required role on every shift is covered.',
      notKnown: 'This store computer has not been told the roster yet, so it cannot say what is short.',
      shiftLabel: 'Shift', roleLabel: 'Role', shortLabel: 'Short by', nobodyWord: 'Nobody', shortWord: 'Short',
      assignHeading: 'Put someone on a short shift', whoLabel: 'Who to put on', assignBtn: 'Assign to the shift',
      noEligible: 'Nobody active holds this role who is not already on this shift — this gap cannot be filled from here.',
      assignRecorded: 'Assigned.', assignRefused: 'Could not assign — the person must be active, hold the role, and not already be on the shift; or you do not have permission to change the roster.',
      assignLostLink: 'No connection — not saved. Try again.',
      scrReady: 'Showing the roster gaps', scrEmpty: 'No gaps — every required role on every shift is covered.',
      stateNotPermitted: 'You do not have permission to see the roster.', noManage: 'You can see the gaps, but changing the roster needs manager permission.',
      nobodyNamed: 'This store computer has not been told who is using this screen.',
      staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
    },
    ta: {
      title: 'பணிப்பட்டியல் இடைவெளிகள்', langName: 'English',
      lead: 'மாதிரி இடைவெளிகள். உங்கள் கடையின் பணிப்பட்டியலைப் பார்க்க கடை கணினியை இணைக்கவும்.',
      gapsHeading: 'நிரப்ப வேண்டியவை', gapCount: 'நிரப்ப', allStaffed: 'இடைவெளி இல்லை — ஒவ்வொரு ஷிப்டிலும் தேவையான பணிகள் அனைத்தும் நிரப்பப்பட்டுள்ளன.',
      notKnown: 'பணிப்பட்டியல் இன்னும் கடைக் கணினிக்குச் சொல்லப்படவில்லை, எனவே என்ன குறைவு என்று சொல்ல முடியாது.',
      shiftLabel: 'ஷிப்ட்', roleLabel: 'பணி', shortLabel: 'குறைவு', nobodyWord: 'யாரும் இல்லை', shortWord: 'குறைவு',
      assignHeading: 'குறைவான ஷிப்டில் ஒருவரை வை', whoLabel: 'யாரை வைப்பது', assignBtn: 'ஷிப்டில் ஒதுக்கு',
      noEligible: 'இந்தப் பணியை வகிக்கும், இந்த ஷிப்டில் ஏற்கனவே இல்லாத, செயலில் உள்ள ஆள் யாரும் இல்லை — இந்த இடைவெளியை இங்கிருந்து நிரப்ப முடியாது.',
      assignRecorded: 'ஒதுக்கப்பட்டது.', assignRefused: 'ஒதுக்க முடியவில்லை — நபர் செயலில் இருக்க வேண்டும், பணியை வகிக்க வேண்டும், ஏற்கனவே ஷிப்டில் இருக்கக்கூடாது; அல்லது பணிப்பட்டியலை மாற்ற உங்களுக்கு அனுமதி இல்லை.',
      assignLostLink: 'இணைப்பு இல்லை — சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
      scrReady: 'பணிப்பட்டியல் இடைவெளிகளைக் காட்டுகிறது', scrEmpty: 'இடைவெளி இல்லை — ஒவ்வொரு ஷிப்டிலும் தேவையான பணிகள் அனைத்தும் நிரப்பப்பட்டுள்ளன.',
      stateNotPermitted: 'பணிப்பட்டியலைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.', noManage: 'இடைவெளிகளைப் பார்க்கலாம், ஆனால் பணிப்பட்டியலை மாற்ற மேலாளர் அனுமதி தேவை.',
      nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
      staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
    },
  };
  const sampleGap = (l) => ({
    shiftId: 'S-1', role: 'cashier', startsAt: '2026-09-27T06:00:00.000Z', needed: 1, assigned: 0, short: 1,
    severityWord: l === 'ta' ? 'யாரும் இல்லை' : 'Nobody',
    detail: l === 'ta' ? '2026-09-27 06:00 — cashier பணியில் யாரும் இல்லை' : '2026-09-27 06:00 has NOBODY rostered as cashier',
    eligible: [{ employeeId: 'e-sample', label: l === 'ta' ? 'ஆஷா' : 'Asha' }],
    status: { tone: 'error', icon: '✕', label: (l === 'ta' ? 'யாரும் இல்லை' : 'Nobody') + ' · cashier', announcement: 'nobody', needsAttention: true },
    needsAttention: true,
  });
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => ({
      screenState: { tone: 'error', icon: '✕', label: '', announcement: '', needsAttention: true },
      gaps: [sampleGap(l)], gapCount: 1, nobodyNamed: false, mayManage: true,
    }),
    assign: async () => 'lost_link',
    presentAssignResult: (l, result) => ({ tone: result === 'assigned' ? 'ok' : result === 'lost_link' ? 'degraded' : 'error', icon: result === 'assigned' ? '✓' : result === 'lost_link' ? '⚠' : '✕', label: '', announcement: '', needsAttention: result !== 'assigned' }),
  };
}

let session = window.rosteringSession ?? sampleSession();
const t = (key) => session.text(lang, key);
let currentGaps = [];

/** A stable key for a gap in the assign dropdown — a shift can be short of more than one role. */
const gapKey = (g) => `${g.shiftId}␟${g.role}`;

function rowNode(r) {
  const li = document.createElement('li');
  li.className = `row tone-${r.status.tone}`;

  const head = document.createElement('div');
  head.className = 'head';
  const headline = document.createElement('span'); headline.className = 'headline'; headline.textContent = r.detail;
  const value = document.createElement('span'); value.className = 'value'; value.textContent = `${t('shortLabel')}: ${r.short}`;
  head.append(headline, value);

  const status = document.createElement('span');
  status.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = r.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = r.status.label;
  status.append(icon, slabel);
  status.setAttribute('aria-label', r.status.announcement || r.status.label);

  const facts = document.createElement('div'); facts.className = 'facts';
  const shift = document.createElement('span'); shift.textContent = `${t('shiftLabel')}: ${r.shiftId}`;
  const role = document.createElement('span'); role.textContent = `${t('roleLabel')}: ${r.role}`;
  facts.append(shift, role);

  li.append(head, status, facts);
  return li;
}

/** Repopulate the "who" dropdown from the currently-selected gap's eligible staff. */
function paintEligible() {
  const key = el('assign-gap').value;
  const gap = currentGaps.find((g) => gapKey(g) === key);
  const who = el('assign-who');
  const eligible = gap ? gap.eligible : [];
  who.replaceChildren(...eligible.map((e) => {
    const o = document.createElement('option'); o.value = e.employeeId; o.textContent = e.label; return o;
  }));
  // No eligible person means this gap cannot be filled from here — say so, and do not offer the button.
  const none = eligible.length === 0;
  el('assign').disabled = none;
  if (none) {
    const o = document.createElement('option'); o.value = ''; o.textContent = t('noEligible'); who.replaceChildren(o); who.disabled = true;
  } else {
    who.disabled = false;
  }
}

function paint() {
  const view = session.view(lang);
  currentGaps = view.gaps;

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.rosteringData?.userId ?? '';
  el('lang').textContent = t('langName');

  el('gap-count').textContent = view.gapCount === 0 ? t('allStaffed') : `${view.gapCount} ${t('gapCount')}`;

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  el('gaps-heading').hidden = view.gaps.length === 0;
  el('gaps-heading').textContent = t('gapsHeading');
  el('rows').replaceChildren(...view.gaps.map((r) => rowNode(r)));

  // The assign form — only for a manager who holds workforce.roster.manage, and only when there is a gap to fill.
  const assigner = el('assigner');
  const canAssign = view.mayManage && view.gaps.length > 0 && !view.nobodyNamed;
  assigner.hidden = !canAssign;
  if (canAssign) {
    el('assign-heading').textContent = t('assignHeading');
    el('assign-gap-label').textContent = t('shiftLabel');
    el('assign-who-label').textContent = t('whoLabel');
    el('assign').textContent = t('assignBtn');
    el('assign-gap').replaceChildren(...view.gaps.map((g) => {
      const o = document.createElement('option'); o.value = gapKey(g); o.textContent = `${g.detail}`; return o;
    }));
    paintEligible();
  }

  const state = el('state');
  if (view.gaps.length === 0) {
    state.hidden = false;
    state.className = `state tone-${view.screenState.tone}`;
    el('state-icon').textContent = view.screenState.icon;
    el('state-text').textContent = view.screenState.label;
  } else {
    state.hidden = true;
  }
}

function paintResult(presentation) {
  const result = el('result');
  if (!result) return;
  result.hidden = false;
  result.className = `result tone-${presentation.tone}`;
  el('result-icon').textContent = presentation.icon;
  el('result-text').textContent = presentation.label;
  result.setAttribute('aria-label', presentation.announcement || presentation.label);
}

// The manager's assign — a HUMAN write that runs ONLY on this explicit click, never on load. On success the
// worklist is re-read (a GET) so the filled gap drops off. The server re-checks the permission and records the
// assignment in the manager's own name (hard rule #5: no AI writes a roster).
el('assign').addEventListener('click', () => {
  void (async () => {
    const key = el('assign-gap').value;
    const gap = currentGaps.find((g) => gapKey(g) === key);
    if (!gap) return;
    const employeeId = el('assign-who').value;
    if (employeeId === '') return;
    const result = await session.assign(gap.shiftId, employeeId, gap.role);
    paintResult(session.presentAssignResult(lang, result));
    if (result === 'assigned') { await refresh(); }
  })();
});
el('assign-gap').addEventListener('change', paintEligible);
el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintStale(); });

el('sample').hidden = window.rosteringSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the live roster worklist (GETs — read-only). Offline or refused, the screen keeps its current view and
// the stale strip already says the page is what the box last told it.
async function refresh() {
  const api = window.rostering;
  if (!api || typeof api.refresh !== 'function') return;
  const data = await api.refresh();
  if (data) { session = api.present(data); paint(); }
}
refresh();

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
