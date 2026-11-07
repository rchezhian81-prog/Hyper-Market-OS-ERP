// Store tasks — the manager's board over head office's D-8 register (OB-154 · OB-158). It holds no rule: the session
// (apps/web-erp/src/store-ops-session.ts, in the bundle as window.storeOps) reads every task worst first and assigns one in
// the signed-in person's session, refuses only blank input before a POST, and hands every refusal back in head office's
// words. Nobody completes a task here — only the assignee, on "My tasks" (OB-158). Nothing is written on open.

const $ = (id) => document.getElementById(id);

// ── U2 (UI/UX gap audit G5 · P-07): a thing is PICKED by name through the chrome's picker, never typed as a code ───────
// The field keeps the id the page sends (the typed code stays possible when the list cannot be read — head office down,
// no right — so the form is never a dead end, P-01 · P-08); the chrome's sheet finds it by name, code or barcode and the
// name is shown beside the field. Mounted when the chrome is there (a page that paints first listens for `sre:chrome`).
const pickWords = {
  en: { choose: 'Choose…', pickProduct: 'Which product?', pickPlace: 'Which place in the store?', pickPerson: 'Which person?', pickStore: 'Which store?', pickCustomer: 'Which customer?', pickApproval: 'Which approval?' },
  ta: { choose: 'தேர்ந்தெடு…', pickProduct: 'எந்தப் பொருள்?', pickPlace: 'கடையில் எந்த இடம்?', pickPerson: 'எந்த நபர்?', pickStore: 'எந்தக் கடை?', pickCustomer: 'எந்த வாடிக்கையாளர்?', pickApproval: 'எந்த அனுமதி?' },
};
const pw = (k) => pickWords[document.documentElement.lang === 'ta' ? 'ta' : 'en'][k] ?? pickWords.en[k];
const pickRepaints = [];
const repaintPickers = () => { for (const f of pickRepaints) f(); };
function pickable(inputId, kind, titleKey, extra = {}) {
  const input = document.getElementById(inputId);
  if (!input || input.dataset.pickable === 'on') return;
  const office = window.sreOffice;
  if (!office || typeof office.pick !== 'function') { document.addEventListener('sre:chrome', () => pickable(inputId, kind, titleKey, extra), { once: true }); return; }
  input.dataset.pickable = 'on';
  const row = document.createElement('div'); row.className = 'pick-row';
  input.replaceWith(row); row.append(input);
  const btn = document.createElement('button'); btn.type = 'button'; btn.id = `${inputId}-pick`; btn.className = 'sre-btn sre-btn-quiet pick';
  const name = document.createElement('span'); name.id = `${inputId}-name`; name.className = 'pick-name';
  row.append(btn, name);
  const paint = () => { btn.textContent = pw('choose'); btn.setAttribute('aria-label', `${pw('choose')} ${pw(titleKey)}`); };
  paint(); pickRepaints.push(paint);
  btn.addEventListener('click', async () => {
    const picked = await office.pick({ kind, title: { en: pickWords.en[titleKey], ta: pickWords.ta[titleKey] }, allowCode: true, ...(typeof extra.scope === 'function' ? { scope: extra.scope() } : {}), ...(typeof extra.filter === 'function' ? { filter: extra.filter } : {}) });
    if (!picked || picked.ok !== true) return;
    input.value = typeof extra.idOf === 'function' ? extra.idOf(picked) : String(picked.id ?? '');
    name.textContent = typeof picked.name === 'string' && picked.name !== input.value ? picked.name : '';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (typeof extra.onPick === 'function') extra.onPick(picked);
  });
  input.addEventListener('input', () => { name.textContent = ''; });
}
const api = window.storeOps ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, readTasks: false, assignTasks: false };

let lang = 'en';
const t = (k, slots) => (api === null ? k : api.words(lang, k, slots));
// OB-607: a moment is shown at the SHOP's clock (its zone, as the store computer told the page) — never the UTC clock.
const when = (iso) => (typeof iso === 'string' ? window.sreShopDay?.dateTimeOf(iso) ?? '' : '');
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

// OB-390 (store-manager.md "assign/complete a task ≤3"): a new task starts in the manager's OWN store (as head office's
// sign-in names it) and due by the end of today — so assigning is what to do, who does it, Assign. Both are defaults the
// manager can change; a sign-in that names no store leaves the field empty for them to fill, never a guessed store.
async function fillDefaults() {
  if (!may.assignTasks) return;
  if ($('a-due').value === '' && typeof api.endOfTodayField === 'function') $('a-due').value = api.endOfTodayField();
  if ($('a-branch').value !== '') return;
  const mine = await session.myBranch();
  if (mine.result === 'ok' && mine.value.branchId !== null && $('a-branch').value === '') $('a-branch').value = mine.value.branchId;
}
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); repaintPickers(); });
// U2: who does it and the store are picked by name from the store's own people (the pack) — the id is what is sent.
pickable('a-person', 'person', 'pickPerson', { scope: () => ($('a-branch').value === '' ? {} : { storeId: $('a-branch').value }) });
pickable('a-branch', 'store', 'pickStore');
paint();
if (may.named && !may.readTasks) { $('page-status').className = 'status err'; $('page-status').textContent = t('cannotRead'); }
else if (may.named && !may.assignTasks) $('page-status').textContent = t('tkReadOnly');
if (may.named && may.readTasks) { if ($('page-status').textContent === '') $('page-status').textContent = t('reading'); void load().then(() => { if ($('page-status').textContent === t('reading')) $('page-status').textContent = ''; }); }
if (session !== null && may.named) void fillDefaults().then(() => { document.body.dataset.taskDefaults = 'ready'; });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
