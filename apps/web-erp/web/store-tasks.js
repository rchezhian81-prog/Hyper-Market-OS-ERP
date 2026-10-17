// Store tasks — the manager's board over head office's D-8 register (OB-154 · OB-158). It holds no rule: the session
// (apps/web-erp/src/store-ops-session.ts, in the bundle as window.storeOps) reads every task worst first and assigns one in
// the signed-in person's session, refuses only blank input before a POST, and hands every refusal back in head office's
// words. Nobody completes a task here — only the assignee, on "My tasks" (OB-158). Nothing is written on open.

const $ = (id) => document.getElementById(id);
const api = window.storeOps ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, readTasks: false, assignTasks: false };

let lang = 'en';
const t = (k, slots) => (api === null ? k : api.words(lang, k, slots));
const when = (iso) => (typeof iso === 'string' ? iso.replace('T', ' ').slice(0, 16) : '');
let tasks = null;

function say(el, out, good) {
  el.className = `status ${out.result === 'ok' ? 'good' : 'err'}`;
  el.textContent = out.result === 'ok' ? good : api.outcomeWords(lang, out);
}

function taskRow(task) {
  const words = api.taskWords(lang, task);
  const li = document.createElement('li');
  li.className = `row tone-${words.tone}`;
  li.dataset.task = task.taskId; li.dataset.status = task.status;
  const head = document.createElement('div'); head.className = 'head';
  const name = document.createElement('span'); name.className = 'headline'; name.textContent = `${task.title} — ${task.assignedTo}`;
  const state = document.createElement('span'); state.className = 'state'; state.setAttribute('aria-label', words.label);
  const icon = document.createElement('span'); icon.setAttribute('aria-hidden', 'true'); icon.textContent = words.icon;
  const word = document.createElement('span'); word.textContent = words.label;
  state.append(icon, word); head.append(name, state);
  const facts = document.createElement('div'); facts.className = 'facts';
  const missed = task.accountableDueAt !== undefined && task.accountableDueAt !== task.dueAt ? ` · ${t('tkMissedWas')} ${when(task.accountableDueAt)}` : '';
  facts.textContent = `${t('tkColDue')}: ${when(task.dueAt)}${missed} · ${task.detail}`;
  li.append(head, facts);
  return li;
}

function paint() {
  document.title = `SRE ${t('tkTitle')}`;
  for (const [id, k] of [['title-text', 'tkTitle'], ['page-h', 'tkTitle'], ['lead', 'tkLead'], ['k-escalated', 'tkEscalated'], ['k-overdue', 'tkOverdue'], ['k-pending', 'tkPending'], ['k-donelate', 'tkDoneLate'],
    ['assign-h', 'tkAssign'], ['l-a-title', 'tkTask'], ['l-a-person', 'tkPerson'], ['l-a-branch', 'tkBranch'], ['l-a-due', 'tkDueAt'], ['l-a-critical', 'tkCritical'], ['l-a-evidence', 'tkEvidence'], ['l-a-steps', 'tkSteps'], ['a-save', 'tkSave'], ['board-h', 'tkTitle']]) $(id).textContent = t(k);
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.storeOpsData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  $('assign-section').hidden = !may.assignTasks;
  const list = tasks ?? [];
  const count = (s) => list.filter((x) => x.status === s).length;
  for (const [id, s] of [['escalated', 'escalated'], ['overdue', 'overdue'], ['pending', 'pending'], ['donelate', 'done_late']]) {
    $(`v-${id}`).textContent = tasks === null ? '—' : String(count(s));
    $(`p-${id}`).classList.toggle('attention', s !== 'pending' && count(s) > 0);
  }
  $('rows').replaceChildren(...list.map(taskRow));
  $('none').hidden = tasks === null || list.length > 0; $('none').textContent = t('tkNone');
}

async function load() {
  if (session === null || !may.named || !may.readTasks) return;
  const out = await session.taskBoard();
  if (out.result === 'ok') tasks = out.value.tasks; else say($('page-status'), out, '');
  paint();
}

$('assign').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('a-save').disabled = true;
  const out = await session.assignTask({
    branchId: $('a-branch').value, title: $('a-title').value, assignedTo: $('a-person').value, dueAt: $('a-due').value,
    critical: $('a-critical').checked, evidenceRequired: $('a-evidence').checked, steps: $('a-steps').value,
  });
  $('a-save').disabled = false;
  say($('assign-status'), out, t('tkSaved'));
  if (out.result === 'ok') { $('a-title').value = ''; $('a-steps').value = ''; await load(); }
});
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (may.named && !may.readTasks) { $('page-status').className = 'status err'; $('page-status').textContent = t('cannotRead'); }
else if (may.named && !may.assignTasks) $('page-status').textContent = t('tkReadOnly');
if (may.named && may.readTasks) { if ($('page-status').textContent === '') $('page-status').textContent = t('reading'); void load().then(() => { if ($('page-status').textContent === t('reading')) $('page-status').textContent = ''; }); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
