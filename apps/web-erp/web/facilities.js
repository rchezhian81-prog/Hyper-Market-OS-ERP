// Facilities maintenance & compliance — the view layer (M26-FR-03, API-11). Every rule lives in the TESTED
// session model (apps/web-erp/src/facilities-session.ts), attached as window.facilitiesSession, built on
// packages/ui over the cloud's overdue list. This file only draws what the session hands it: the overdue checks
// (worst first, each with its category, was-due date, how late, who it escalated to and why it matters), and a
// "Mark done" control per row — with optional evidence + second-verifier inputs. Marking done is a HUMAN
// decision that runs ONLY on an explicit click, never on load; on success the board is re-read (a GET) so a
// done check drops off. No prompt/confirm/alert.

const el = (id) => document.getElementById(id);
let lang = 'en';

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const CHROME = {
    en: {
      title: 'Maintenance & compliance', langName: 'தமிழ்',
      lead: 'Sample checks. Connect the store computer to see the overdue checks in your own shop.',
      listHeading: 'Overdue', overdueCount: 'overdue', allDone: 'Nothing overdue — every scheduled check is up to date.',
      notKnown: 'This store computer has not been told the maintenance schedules yet.',
      complianceRiskCount: 'a regulator would care about',
      categoryLabel: 'Kind', dueLabel: 'Was due', lateLabel: 'Late by', escalatedToLabel: 'Escalated to',
      catCleaning: 'Cleaning', catPestControl: 'Pest control', catFireSafety: 'Fire safety', catElectricalSafety: 'Electrical safety', catMaintenance: 'Maintenance', catStatutory: 'Statutory',
      complianceWord: 'Compliance risk', escalatedWord: 'Escalated', overdueWord: 'Overdue', dueWord: 'Due today',
      dueTodayText: 'due today', daysLateText: 'day(s) late',
      completeBtn: 'Mark done', completeHint: 'Marking a check done records it in your name.',
      evidenceLabel: 'Evidence reference (photo / certificate)', verifierLabel: 'Verified by (a second person)',
      completeRecorded: 'Marked done and recorded.', completeRefused: 'Not accepted — this check needs its evidence attached, or a second person to verify it, or you do not have permission.', completeLostLink: 'No connection — not saved. Try again.',
      scrReady: 'Showing the overdue checks', scrEmpty: 'Nothing overdue — every scheduled check is up to date.',
      stateNotPermitted: 'You do not have permission to see maintenance and compliance.', noComplete: 'You can see the overdue checks, but marking one done needs the facilities-record permission.',
      nobodyNamed: 'This store computer has not been told who is using this screen.',
      staleShell: 'No connection to the store computer. This page is what it was last told, at', sampleData: 'Sample data — this is not your shop.',
    },
    ta: {
      title: 'பராமரிப்பு & இணக்கம்', langName: 'English',
      lead: 'மாதிரிச் சோதனைகள். உங்கள் கடையில் தாமதமான சோதனைகளைப் பார்க்க கடை கணினியை இணைக்கவும்.',
      listHeading: 'தாமதமானவை', overdueCount: 'தாமதம்', allDone: 'தாமதம் எதுவும் இல்லை — ஒவ்வொரு சோதனையும் புதுப்பித்த நிலையில்.',
      notKnown: 'பராமரிப்பு அட்டவணைகள் இன்னும் கடைக் கணினிக்குச் சொல்லப்படவில்லை.',
      complianceRiskCount: 'ஒழுங்குமுறை அதிகாரி கவலைப்படுவார்',
      categoryLabel: 'வகை', dueLabel: 'தேதி இருந்தது', lateLabel: 'தாமதம்', escalatedToLabel: 'மேலிடம்',
      catCleaning: 'சுத்தம்', catPestControl: 'பூச்சிக் கட்டுப்பாடு', catFireSafety: 'தீ பாதுகாப்பு', catElectricalSafety: 'மின் பாதுகாப்பு', catMaintenance: 'பராமரிப்பு', catStatutory: 'சட்டப்பூர்வம்',
      complianceWord: 'இணக்க அபாயம்', escalatedWord: 'மேலிடம்', overdueWord: 'தாமதம்', dueWord: 'இன்று',
      dueTodayText: 'இன்று செய்ய வேண்டியது', daysLateText: 'நாள் தாமதம்',
      completeBtn: 'முடிந்ததெனக் குறி', completeHint: 'ஒரு சோதனையை முடிந்ததெனக் குறித்தல் அதை உங்கள் பெயரில் பதிவு செய்கிறது.',
      evidenceLabel: 'ஆதாரக் குறிப்பு (புகைப்படம் / சான்றிதழ்)', verifierLabel: 'சரிபார்த்தவர் (இரண்டாம் நபர்)',
      completeRecorded: 'முடிந்ததெனக் குறிக்கப்பட்டு பதிவு செய்யப்பட்டது.', completeRefused: 'ஏற்கப்படவில்லை — ஆதாரம் அல்லது இரண்டாம் நபர் தேவை, அல்லது அனுமதி இல்லை.', completeLostLink: 'இணைப்பு இல்லை — சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
      scrReady: 'தாமதமான சோதனைகளைக் காட்டுகிறது', scrEmpty: 'தாமதம் எதுவும் இல்லை — ஒவ்வொரு சோதனையும் புதுப்பித்த நிலையில்.',
      stateNotPermitted: 'பராமரிப்பு & இணக்கத்தைப் பார்க்க உங்களுக்கு அனுமதி இல்லை.', noComplete: 'தாமதமான சோதனைகளைப் பார்க்கலாம், ஆனால் ஒன்றை முடிந்ததெனக் குறிக்க facilities-record அனுமதி தேவை.',
      nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
      staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:', sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.',
    },
  };
  const sampleTask = (l) => ({
    taskId: 'task-fire', scheduleId: 's-fire', title: l === 'ta' ? 'தீ அணைப்பான் சோதனை' : 'Fire extinguisher check',
    category: 'fire_safety', categoryWord: l === 'ta' ? 'தீ பாதுகாப்பு' : 'Fire safety',
    dueOn: '2026-09-12', daysOverdue: 9, lateWord: l === 'ta' ? '9 நாள் தாமதம்' : '9 day(s) late',
    detail: l === 'ta' ? 'ஒழுங்குமுறை அதிகாரி கவலைப்படுவார்' : 'a regulator would care — escalated to owner',
    escalateTo: 'owner', complianceLinked: true, severityWord: l === 'ta' ? 'இணக்க அபாயம்' : 'Compliance risk',
    status: { tone: 'error', icon: '✕', label: (l === 'ta' ? 'இணக்க அபாயம்' : 'Compliance risk') + ' · fire', announcement: 'compliance risk', needsAttention: true },
    needsAttention: true,
  });
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    view: (l) => ({
      screenState: { tone: 'error', icon: '✕', label: '', announcement: '', needsAttention: true },
      tasks: [sampleTask(l)], overdueCount: 1, complianceRiskCount: 1, nobodyNamed: false, mayComplete: true,
    }),
    complete: async () => 'lost_link',
    presentCompleteResult: (l, result) => ({ tone: result === 'completed' ? 'ok' : result === 'refused' ? 'error' : 'degraded', icon: result === 'completed' ? '✓' : result === 'refused' ? '✕' : '⚠', label: '', announcement: '', needsAttention: result !== 'completed' }),
  };
}

let session = window.facilitiesSession ?? sampleSession();
const t = (key) => session.text(lang, key);
let canCompleteNow = false;

function fact(label, value) {
  const span = document.createElement('span');
  span.textContent = `${label}: ${value}`;
  return span;
}

function labelledInput(labelText, cls) {
  const label = document.createElement('label');
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = cls;
  label.append(input);
  return label;
}

function rowNode(r) {
  const li = document.createElement('li');
  li.className = `row tone-${r.status.tone}`;
  li.dataset.taskId = r.taskId;

  const head = document.createElement('div');
  head.className = 'head';
  const headline = document.createElement('span'); headline.className = 'headline'; headline.textContent = r.title;
  const status = document.createElement('span');
  status.className = 'status';
  const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = r.status.icon;
  const slabel = document.createElement('span'); slabel.textContent = r.severityWord;
  status.append(icon, slabel);
  status.setAttribute('aria-label', r.status.announcement || r.status.label);
  head.append(headline, status);

  const facts = document.createElement('div'); facts.className = 'facts';
  facts.append(
    fact(t('categoryLabel'), r.categoryWord),
    fact(t('dueLabel'), new Date(r.dueOn).toLocaleDateString()),
    fact(t('lateLabel'), r.lateWord),
  );
  if (r.escalateTo) facts.append(fact(t('escalatedToLabel'), r.escalateTo));

  li.append(head, facts);

  const detail = document.createElement('div'); detail.className = 'detail'; detail.textContent = r.detail;
  li.append(detail);

  // The one decision — only for an operator who holds facilities.task.record. Optional evidence + a second
  // verifier ride with it; the server refuses a completion with no required evidence or a self-verified safety
  // check (§28), and the screen surfaces that refusal rather than faking a success.
  if (canCompleteNow) {
    const actions = document.createElement('div'); actions.className = 'actions';
    const fields = document.createElement('div'); fields.className = 'fields';
    fields.append(labelledInput(t('evidenceLabel'), 'evidence'), labelledInput(t('verifierLabel'), 'verifier'));
    const complete = document.createElement('button'); complete.className = 'act complete'; complete.type = 'button'; complete.dataset.taskId = r.taskId; complete.textContent = t('completeBtn');
    actions.append(fields, complete);
    li.append(actions);
  }
  return li;
}

function paint() {
  const view = session.view(lang);
  canCompleteNow = view.mayComplete && !view.nobodyNamed;

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.facilitiesData?.userId ?? '';
  el('lang').textContent = t('langName');

  el('overdue-count').textContent = view.overdueCount === 0 ? t('allDone') : `${view.overdueCount} ${t('overdueCount')}`;
  const risk = el('risk-count');
  risk.hidden = view.complianceRiskCount === 0;
  risk.textContent = view.complianceRiskCount === 0 ? '' : `${view.complianceRiskCount} ${t('complianceRiskCount')}`;

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  el('list-heading').hidden = view.tasks.length === 0;
  el('list-heading').textContent = t('listHeading');
  el('rows').replaceChildren(...view.tasks.map((r) => rowNode(r)));

  const state = el('state');
  if (view.tasks.length === 0) {
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

// The operator's "mark done" — a HUMAN write that runs ONLY on this explicit click, never on load. Delegated
// from the list so there is one handler; on success the board is re-read (a GET) so a done check drops off. The
// server enforces the evidence/verification rules; the screen never fakes a success it did not get (P-08).
el('rows').addEventListener('click', (ev) => {
  const btn = ev.target instanceof Element ? ev.target.closest('button.complete') : null;
  if (!btn) return;
  const li = btn.closest('li.row');
  const taskId = btn.dataset.taskId;
  const evidenceRef = li?.querySelector('input.evidence')?.value ?? '';
  const verifiedBy = li?.querySelector('input.verifier')?.value ?? '';
  void (async () => {
    const result = await session.complete(taskId, { evidenceRef, verifiedBy });
    paintResult(session.presentCompleteResult(lang, result));
    if (result === 'completed') { await refresh(); }
  })();
});
el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintStale(); });

el('sample').hidden = window.facilitiesSession !== undefined;
el('sample').textContent = t('sampleData');
paint();

// Read the live overdue board (a GET — read-only). Offline or refused, the screen keeps its current view and the
// stale strip already says the page is what the box last told it.
async function refresh() {
  const api = window.facilities;
  if (!api || typeof api.refresh !== 'function') return;
  const board = await api.refresh();
  if (board) { session = api.present(board); paint(); }
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
