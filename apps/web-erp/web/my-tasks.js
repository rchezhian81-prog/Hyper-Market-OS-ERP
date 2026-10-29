// My tasks — the assignee's own page over head office's D-8 register (OB-154 · OB-158: only the assignee completes). The
// session (apps/web-erp/src/store-ops-session.ts, in the bundle as window.storeOps) reads the signed-in person's tasks and
// completes one in their own session, with every step ticked and the evidence the task asks for; head office refuses
// anyone else and every refusal is shown in its words. Nothing is written on open. Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const api = window.storeOps ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, ownTasks: false };

let lang = 'en';
const t = (k, slots) => (api === null ? k : api.words(lang, k, slots));
// OB-607: a moment is shown at the SHOP's clock (its zone, as the store computer told the page) — never the UTC clock.
const when = (iso) => (typeof iso === 'string' ? window.sreShopDay?.dateTimeOf(iso) ?? '' : '');
let tasks = null;

function say(el, out, good) {
  el.className = `status ${out.result === 'ok' ? 'good' : 'err'}`;
  el.textContent = out.result === 'ok' ? good : api.outcomeWords(lang, out);
}

function field(labelText, control) {
  const label = document.createElement('label');
  const span = document.createElement('span'); span.textContent = labelText;
  label.append(span, control);
  return label;
}

function completeForm(task) {
  const form = document.createElement('form'); form.className = 'complete';
  const ticks = task.steps.map((s) => { const box = document.createElement('input'); box.type = 'checkbox'; box.className = 'step'; box.dataset.step = s.stepId; return [s, box]; });
  const evidence = document.createElement('input'); evidence.className = 'evidence'; evidence.autocomplete = 'off';
  const note = document.createElement('input'); note.className = 'note'; note.autocomplete = 'off';
  const button = document.createElement('button'); button.type = 'submit'; button.className = 'done'; button.textContent = t('myDone');
  const status = document.createElement('p'); status.className = 'status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  form.append(...ticks.map(([s, box]) => field(s.label, box)), field(t('myEvidence'), evidence), field(t('myNote'), note), button, status);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    button.disabled = true;
    const out = await session.completeTask(task, { evidenceRef: evidence.value, stepsDone: ticks.filter(([, b]) => b.checked).map(([s]) => s.stepId), note: note.value });
    button.disabled = false;
    say(status, out, out.result === 'ok' && out.value.lateByMinutes > 0 ? `${t('mySaved')} ${t('tkLate', { m: out.value.lateByMinutes })}` : t('mySaved'));
    if (out.result === 'ok') { say($('page-status'), out, status.textContent); await load(); }
  });
  return form;
}

function taskRow(task) {
  const words = api.taskWords(lang, task);
  const li = document.createElement('li');
  li.className = `row tone-${words.tone}`;
  li.dataset.task = task.taskId; li.dataset.status = task.status;
  const head = document.createElement('div'); head.className = 'head';
  const name = document.createElement('span'); name.className = 'headline'; name.textContent = task.title;
  const state = document.createElement('span'); state.className = 'state'; state.setAttribute('aria-label', words.label);
  const icon = document.createElement('span'); icon.setAttribute('aria-hidden', 'true'); icon.textContent = words.icon;
  const word = document.createElement('span'); word.textContent = words.label;
  state.append(icon, word); head.append(name, state);
  const facts = document.createElement('div'); facts.className = 'facts';
  const missed = task.accountableDueAt !== undefined && task.accountableDueAt !== task.dueAt ? ` · ${t('tkMissedWas')} ${when(task.accountableDueAt)}` : '';
  facts.textContent = `${t('tkColDue')}: ${when(task.dueAt)}${missed}${task.evidenceRequired ? ` · ${t('tkEvidence')}` : ''}`;
  li.append(head, facts);
  if (task.completion === undefined) li.append(completeForm(task));
  return li;
}

function paint() {
  document.title = `SRE ${t('myTitle')}`;
  for (const [id, k] of [['title-text', 'myTitle'], ['page-h', 'myTitle'], ['lead', 'myLead'], ['list-h', 'myTitle']]) $(id).textContent = t(k);
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.storeOpsData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  const list = tasks ?? [];
  $('rows').replaceChildren(...list.map(taskRow));
  $('none').hidden = tasks === null || list.length > 0; $('none').textContent = t('myNone');
}

async function load() {
  if (session === null || !may.named || !may.ownTasks) return;
  const out = await session.myTasks();
  if (out.result === 'ok') tasks = out.value.tasks; else say($('page-status'), out, '');
  paint();
}

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (may.named && !may.ownTasks) { $('page-status').className = 'status err'; $('page-status').textContent = t('cannotRead'); }
if (may.named && may.ownTasks) { $('page-status').textContent = t('reading'); void load().then(() => { if ($('page-status').textContent === t('reading')) $('page-status').textContent = ''; }); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
