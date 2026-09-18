// Day reopen — the view layer (M14-FR-04, API-05, §28). Every rule lives in the TESTED session model
// (apps/web-erp/src/day-reopen-session.ts), attached as window.dayReopenSession, built on packages/ui. This
// file only draws what the session hands it: the still-LOCKED days (most recent first, each with who closed it
// and when), then a "reopen" form (pick a day, a required reason, and a NAMED approver who is a different
// person). Reopening is a HUMAN decision that runs ONLY on an explicit click, never on load, and it posts to
// the BOX (POST /lane/day-reopen) — the only place that can perform it. The screen refuses a self-approval (§28)
// before any POST; on success the worklist is re-read (a GET) so the reopened day drops off. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: { title: 'Reopen a locked day', langName: 'தமிழ்',
      lead: 'Sample locked days. Connect the store computer to reopen your own shop’s days.',
      lockedHeading: 'Locked days', lockedCount: 'locked', allClear: 'No locked days to reopen.',
      dayLabel: 'Trading day', closedByLabel: 'Closed by', closedAtLabel: 'Closed at',
      reopenHeading: 'Reopen a day', dayField: 'Which day', reasonLabel: 'Reason (required)', reasonPlaceholder: 'Why this locked day must be reopened.',
      approverLabel: 'Approved by (a different person)', approverPlaceholder: 'The authorised person who approved this reopen.', reopenBtn: 'Reopen the day',
      reopenRecorded: 'The day is reopened.', reopenRefused: 'Could not reopen — you may not have permission, or the approver is not authorised. Nothing was changed.',
      sampleData: 'Sample data — this is not your shop.', staleShell: 'No connection to the store computer. This page is what it was last told, at', nobodyNamed: '' },
    ta: { title: 'மூடிய நாளை மீண்டும் திற', langName: 'English',
      lead: 'மாதிரி பூட்டிய நாட்கள். உங்கள் கடையின் நாட்களை மீண்டும் திறக்க கடை கணினியை இணைக்கவும்.',
      lockedHeading: 'பூட்டிய நாட்கள்', lockedCount: 'பூட்டியவை', allClear: 'மீண்டும் திறக்க பூட்டிய நாட்கள் இல்லை.',
      dayLabel: 'வர்த்தக நாள்', closedByLabel: 'மூடியவர்', closedAtLabel: 'மூடிய நேரம்',
      reopenHeading: 'ஒரு நாளை மீண்டும் திற', dayField: 'எந்த நாள்', reasonLabel: 'காரணம் (தேவை)', reasonPlaceholder: 'இந்த பூட்டிய நாளை ஏன் மீண்டும் திறக்க வேண்டும்.',
      approverLabel: 'அங்கீகரித்தவர் (வேறொருவர்)', approverPlaceholder: 'இந்த மீள்திறப்பை அங்கீகரித்த அங்கீகரிக்கப்பட்ட நபர்.', reopenBtn: 'நாளை மீண்டும் திற',
      reopenRecorded: 'நாள் மீண்டும் திறக்கப்பட்டது.', reopenRefused: 'மீண்டும் திறக்க முடியவில்லை — உங்களுக்கு அனுமதி இல்லாமல் இருக்கலாம், அல்லது அங்கீகரித்தவருக்கு அதிகாரம் இல்லை. எதுவும் மாற்றப்படவில்லை.',
      sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', nobodyNamed: '' },
  };
  const sampleRow = (l) => ({
    dayCloseId: 'sample-dc-1', tradingDay: '2026-09-17', closedBy: 'manager', closedAt: '2026-09-18T02:05:00.000Z',
    status: { tone: 'ok', icon: '🔒', label: l === 'ta' ? 'வர்த்தக நாள்' : 'Trading day', announcement: 'trading day', needsAttention: false },
  });
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => ({
      screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
      locked: [sampleRow(l)], lockedCount: 1, nobodyNamed: false, mayReopen: true,
    }),
    reopen: async () => 'lost_link',
    presentReopenResult: (l, result) => ({ tone: result === 'reopened' ? 'ok' : result === 'lost_link' ? 'degraded' : 'error', icon: result === 'reopened' ? '✓' : result === 'lost_link' ? '⚠' : '✕', label: '', announcement: '', needsAttention: result !== 'reopened' }),
  };
}

let session = window.dayReopenSession ?? sampleSession();
const t = (key) => session.text(lang, key);

function rowNode(r) {
  const li = document.createElement('li');
  li.className = `row tone-${r.status.tone}`;

  const head = document.createElement('div');
  head.className = 'head';
  const headline = document.createElement('span'); headline.className = 'headline'; headline.textContent = `${t('dayLabel')} ${r.tradingDay}`;
  head.append(headline);

  const status = document.createElement('span');
  status.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = r.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = r.status.label;
  status.append(icon, slabel);
  status.setAttribute('aria-label', r.status.announcement || r.status.label);

  const facts = document.createElement('div'); facts.className = 'facts';
  const cby = document.createElement('span'); cby.textContent = `${t('closedByLabel')}: ${r.closedBy}`;
  const cat = document.createElement('span'); cat.textContent = `${t('closedAtLabel')}: ${r.closedAt}`;
  facts.append(cby, cat);

  li.append(head, status, facts);
  return li;
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.dayReopenData?.userId ?? '';
  el('lang').textContent = t('langName');

  el('locked-count').textContent = view.lockedCount === 0 ? t('allClear') : `${view.lockedCount} ${t('lockedCount')}`;

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  el('locked-heading').hidden = view.locked.length === 0;
  el('locked-heading').textContent = t('lockedHeading');
  el('rows').replaceChildren(...view.locked.map((r) => rowNode(r)));

  // The reopen form — only for an authority who holds till.dayclose.approve, and only when there is a locked
  // day to reopen. The §28 self-approval refusal is the session's; the result strip says so.
  const reopener = el('reopener');
  const canReopen = view.mayReopen && view.locked.length > 0 && !view.nobodyNamed;
  reopener.hidden = !canReopen;
  if (canReopen) {
    el('reopen-heading').textContent = t('reopenHeading');
    el('reopen-day-label').textContent = t('dayField');
    el('reopen-reason-label').textContent = t('reasonLabel');
    el('reopen-approver-label').textContent = t('approverLabel');
    el('reopen-reason').setAttribute('aria-label', t('reasonLabel'));
    el('reopen-reason').placeholder = t('reasonPlaceholder');
    el('reopen-approver').setAttribute('aria-label', t('approverLabel'));
    el('reopen-approver').placeholder = t('approverPlaceholder');
    el('do-reopen').textContent = t('reopenBtn');
    el('reopen-day').replaceChildren(...view.locked.map((r) => {
      const o = document.createElement('option'); o.value = r.dayCloseId; o.textContent = `${r.tradingDay} — ${t('closedByLabel')}: ${r.closedBy}`; return o;
    }));
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

// The reopen — a HUMAN write that runs ONLY on this explicit click, never on load. On success the worklist is
// re-read (a GET) so the reopened day drops off. The screen refuses a self-approval (§28) before any POST; the
// box enforces it and the cloud re-verifies the approver's authority. It never fakes a success.
el('do-reopen').addEventListener('click', () => {
  void (async () => {
    const dayCloseId = el('reopen-day').value;
    const reason = el('reopen-reason').value;
    const approver = el('reopen-approver').value;
    const result = await session.reopen(dayCloseId, reason, approver);
    paintResult(session.presentReopenResult(lang, result));
    if (result === 'reopened') { el('reopen-reason').value = ''; el('reopen-approver').value = ''; await refresh(); }
  })();
});

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintStale(); });

el('sample').hidden = window.dayReopenSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the live locked-day worklist (a GET — read-only). Offline or refused, the screen keeps its current view
// and the stale strip already says the page is what the box last told it.
async function refresh() {
  const api = window.dayReopen;
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
