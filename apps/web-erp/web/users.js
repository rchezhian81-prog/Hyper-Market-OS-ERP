// Users & roles (Round 4c) — the page over head office's identity routes. The session (apps/web-erp/src/users-session.ts, in
// the bundle as window.users) does every call and every rule; this page lays out what it is told. It reads head office as it
// opens (GETs only); every write is an explicit press. Every word this page adds has a Tamil twin; head office's own
// sentences stay in English (OB-553).

const $ = (id) => document.getElementById(id);
const api = window.users ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, ask: false, decide: false };
const signIns = api?.signIns ?? null;
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, cls, onClick) { const b = document.createElement('button'); b.classList.add('sre-btn'); b.type = 'button'; b.className = cls ?? 'quiet'; b.textContent = words; b.addEventListener('click', onClick); return b; }
function field(labelWords, id) {
  const l = document.createElement('label'); l.htmlFor = id; l.append(text('span', labelWords));
  const i = document.createElement('input'); i.id = id; i.autocomplete = 'off'; l.append(i); return { label: l, input: i };
}
const scopeWords = (s) => (s === 'all' ? t('all') : s.join(', '));
const say = (id, out) => { $(id).textContent = out.result === 'ok' ? '' : api.outcomeWords(lang, out); };

let roles = { live: [], waiting: [] }; let holders = null; let pending = null; let mine = null;
// U3 (OB-699): a role's name is the product's own word — head office carries it in both languages; the Tamil is shown on a Tamil screen.
const roleWord = (r) => (lang === 'ta' && typeof r?.nameTa === 'string' && r.nameTa !== '' ? r.nameTa : r?.name);
const roleName = (id) => roleWord(roles.live.find((r) => r.id === id) ?? roles.waiting.find((r) => r.id === id)) ?? id;

function paintPending() {
  const ul = $('pending-rows'); ul.replaceChildren();
  if (pending === null) return;
  if (pending.length === 0) { ul.append(text('li', t('nothingPending'), 'meta')); return; }
  for (const p of pending) {
    const li = document.createElement('li'); li.className = 'tone-degraded'; li.dataset.grant = p.grantId;
    const head = document.createElement('div'); head.className = 'head';
    head.append(text('h4', `${p.userId} — ${roleName(p.roleId)}`), text('span', `${t('where')}: ${scopeWords(p.branchScope)}`, 'meta'));
    li.append(head, text('p', `${t('askedBy')} ${p.requestedBy} · ${p.reason}`, 'meta'));
    if (p.mine) li.append(text('p', t('yourOwn'), 'meta'));
    else if (may.decide) {
      const why = field(t('reason'), `why-${p.grantId}`);
      const acts = document.createElement('div'); acts.className = 'acts';
      const status = text('p', '', 'status'); status.setAttribute('role', 'status');
      acts.append(why.label,
        button(t('approve'), '', async () => { status.textContent = t('reading'); const out = await session.decide(p.grantId, 'approve', why.input.value); status.textContent = out.result === 'ok' ? t('approved') : api.outcomeWords(lang, out); if (out.result === 'ok') void loadAll(); }),
        button(t('reject'), 'quiet', async () => { status.textContent = t('reading'); const out = await session.decide(p.grantId, 'reject', why.input.value); status.textContent = out.result === 'ok' ? t('rejected') : api.outcomeWords(lang, out); if (out.result === 'ok') void loadAll(); }));
      li.append(acts, status);
    }
    ul.append(li);
  }
}

function paintHolders() {
  const ul = $('holder-rows'); ul.replaceChildren();
  if (holders === null) return;
  if (holders.length === 0) { ul.append(text('li', t('nobodyHolds'), 'meta')); return; }
  for (const h of holders) {
    const li = document.createElement('li'); li.dataset.person = h.userId;
    li.append(text('h4', h.userId));
    const status = text('p', '', 'status'); status.setAttribute('role', 'status');
    const why = field(t('reason'), `tb-${h.userId}`);
    for (const g of h.grants) {
      const row = document.createElement('div'); row.className = 'head'; row.dataset.role = g.roleId;
      row.append(text('span', `${roleName(g.roleId)} · ${t('where')}: ${scopeWords(g.branchScope)}`));
      if (may.ask && h.userId !== session.userId) {
        row.append(button(t('takeBack'), 'quiet', async () => { status.textContent = t('reading'); const out = await session.askTakeBack(h, g, why.input.value); status.textContent = out.result === 'ok' ? t('asked') : api.outcomeWords(lang, out); if (out.result === 'ok') void loadMine(); }));
      }
      li.append(row);
    }
    if (may.ask && h.userId !== session.userId) {
      const acts = document.createElement('div'); acts.className = 'acts';
      acts.append(why.label, button(t('leaver'), 'quiet', async () => { status.textContent = t('reading'); const out = await session.askTakeBack(h, 'leaver', why.input.value); status.textContent = out.result === 'ok' ? t('asked') : api.outcomeWords(lang, out); if (out.result === 'ok') void loadMine(); }));
      li.append(acts);
    }
    li.append(status);
    ul.append(li);
  }
}

function paintMine() {
  const ul = $('mine-rows'); ul.replaceChildren();
  if (mine === null) return;
  if (mine.length === 0) { ul.append(text('li', t('nothingMine'), 'meta')); return; }
  const statusWord = { waiting: 'statusWaiting', approved: 'statusApproved', rejected: 'statusRejected', expired: 'statusExpired', used: 'statusUsed' };
  for (const c of mine) {
    const li = document.createElement('li'); li.dataset.request = c.requestId; li.dataset.status = c.status;
    li.className = c.status === 'approved' ? 'tone-ok' : c.status === 'waiting' ? 'tone-degraded' : '';
    const head = document.createElement('div'); head.className = 'head';
    head.append(text('h4', t(`kind_${c.kind}`)), text('span', t(statusWord[c.status]), 'meta'));
    li.append(head, text('p', c.summary, 'meta'));
    if (c.status === 'approved') {
      const status = text('p', '', 'status'); status.setAttribute('role', 'status');
      li.append(button(t('apply'), 'quiet', async () => { status.textContent = t('reading'); const out = await session.apply(c); status.textContent = out.result === 'ok' ? t('applied') : out.result === 'refused' && out.code === 'blocked' ? `${t('blocked')} ${out.whatHappened}` : api.outcomeWords(lang, out); if (out.result === 'ok') void loadAll(); }), status);
    }
    ul.append(li);
  }
}

function paintWaiting() {
  const ul = $('waiting-rows'); ul.replaceChildren();
  for (const r of roles.waiting) {
    const li = document.createElement('li'); li.className = 'tone-degraded'; li.dataset.role = r.id;
    li.append(text('h4', roleWord(r)),
      text('p', `${t('scopeLabel')}: ${r.roadmap.scope} · ${t('mayLabel')}: ${r.roadmap.may} · ${t('mustNotLabel')}: ${r.roadmap.mustNot}`, 'meta'),
      text('p', `${t('limitedBy')}: ${r.limitedBy.join(', ')}`, 'meta'), text('p', t('wordsLabel')));
    const words = document.createElement('ul'); words.className = 'why';
    for (const w of r.words) words.append(text('li', `${w.permission} — ${w.why}`));
    li.append(words, text('p', t('withheldLabel')));
    const left = document.createElement('ul'); left.className = 'why';
    for (const w of r.withheld) left.append(text('li', `${w.permission} — ${w.why}`));
    li.append(left);
    if (r.questions.length > 0) { li.append(text('p', t('questionsLabel'))); const q = document.createElement('ul'); q.className = 'why'; for (const x of r.questions) q.append(text('li', x)); li.append(q); }
    ul.append(li);
  }
}

function paintRoleChoices() {
  for (const id of ['g-role', 'l-role']) {
    const sel = $(id); const was = sel.value; sel.replaceChildren(text('option', '—'));
    sel.firstChild.value = '';
    for (const r of roles.live) { const o = text('option', roleWord(r)); o.value = r.id; sel.append(o); }
    sel.value = was;
  }
  const dim = $('l-dimension'); const was = dim.value; dim.replaceChildren();
  for (const d of api?.dimensions ?? []) { const o = text('option', t(d)); o.value = d; dim.append(o); }
  if (was !== '') dim.value = was;
}

function paintSignIns() {
  if (signIns === null) return;
  const v = signIns.view(lang);
  $('signins-source').textContent = `${v.source.icon} ${v.source.label}`;
  $('signin-form').hidden = !v.mayIssue;
  if (v.cannot !== null) $('signins-status').textContent = v.cannot;
  const ul = $('signin-rows'); ul.replaceChildren();
  if (v.listKnown && v.rows.length === 0) ul.append(text('li', signIns.text(lang, 'noneYet'), 'meta'));
  for (const r of v.rows) { const li = document.createElement('li'); li.className = `tone-${r.tone}`; li.dataset.person = r.userId; li.append(text('h4', r.name), text('p', `${r.stateWords} · ${r.detail}`, 'meta')); ul.append(li); }
  const h = signIns.handOver();
  $('handover').hidden = h === null;
  if (h !== null) { $('handover-words').textContent = api.handOverWords(lang, h); $('handover-password').textContent = h.oneTimePassword; }
  for (const [id, key] of [['s-name-l', 'nameLabel'], ['s-signin-l', 'signInLabel'], ['s-issue-text', 'issueBtn'], ['handed-text', 'handedOverBtn']]) $(id).textContent = signIns.text(lang, key);
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  document.title = `SRE ${t('title')}`;
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['reload-text', 'reload'], ['pending-h', 'pendingH'], ['pending-lead', 'pendingLead'], ['holders-h', 'holdersH'], ['holders-lead', 'holdersLead'],
    ['give-h', 'giveH'], ['give-lead', 'giveLead'], ['g-person-l', 'person'], ['g-role-l', 'role'], ['g-stores-l', 'stores'], ['g-reason-l', 'reason'], ['g-ask-text', 'give'],
    ['limit-h', 'limitH'], ['limit-lead', 'limitLead'], ['l-person-l', 'person'], ['l-role-l', 'role'], ['l-dimension-l', 'dimension'], ['l-values-l', 'values'], ['l-reason-l', 'reason'], ['l-ask-text', 'limit'],
    ['mine-h', 'mineH'], ['mine-lead', 'mineLead'], ['waiting-h', 'waitingH'], ['waiting-lead', 'waitingLead'], ['signins-h', 'signInsH'], ['signins-lead', 'signInsLead']]) $(id).textContent = t(key);
  paintRoleChoices(); paintPending(); paintHolders(); paintMine(); paintWaiting(); paintSignIns();
}

async function loadRoles() {
  const out = await session.roles();
  if (out.result === 'ok') { roles = out.value; $('waiting').hidden = roles.waiting.length === 0; } else say('page-status', out);
}
async function loadHolders() { $('holders-status').textContent = t('reading'); const out = await session.holders(); holders = out.result === 'ok' ? out.value : null; say('holders-status', out); paintHolders(); }
async function loadPending() { $('pending-status').textContent = t('reading'); const out = await session.pending(); pending = out.result === 'ok' ? out.value : null; say('pending-status', out); paintPending(); }
async function loadMine() { if (!may.ask) return; $('mine-status').textContent = t('reading'); const out = await session.mine(); mine = out.result === 'ok' ? out.value : null; say('mine-status', out); paintMine(); }
async function loadAll() { await loadRoles(); paint(); await Promise.all([may.ask ? loadHolders() : Promise.resolve(), may.read ? loadPending() : Promise.resolve(), loadMine()]); }

for (const [id, name] of [['reload', 'refresh-cw'], ['g-ask', 'user-round']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
$('give-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('give-status').textContent = t('reading');
  const out = await session.give({ userId: $('g-person').value, roleId: $('g-role').value, stores: $('g-stores').value, reason: $('g-reason').value }, roles.waiting.map((r) => r.id));
  $('give-status').textContent = out.result === 'ok' ? t('given') : api.outcomeWords(lang, out);
  if (out.result === 'ok') void loadPending();
});
$('limit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('limit-status').textContent = t('reading');
  const out = await session.askLimit({ userId: $('l-person').value, roleId: $('l-role').value, dimension: $('l-dimension').value, values: $('l-values').value, reason: $('l-reason').value });
  $('limit-status').textContent = out.result === 'ok' ? t('asked') : api.outcomeWords(lang, out);
  if (out.result === 'ok') void loadMine();
});
$('signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = { signInName: $('s-signin').value, displayName: $('s-name').value };
  const out = await signIns.issue(input);
  const p = signIns.present(lang, out, input);
  $('signins-status').textContent = `${p.icon} ${p.label}`;
  paintSignIns();
});
$('handed').addEventListener('click', () => { signIns?.handedOver(); paintSignIns(); });

paint();
if (session === null || !may.named) $('page-status').textContent = t('nobody');
else {
  if (!may.read && !may.ask && signIns === null) $('page-status').textContent = t('cannotRead');
  // The owner (identity.role.read) sees what waits for a second person; whoever asks (identity.role.request) sees who holds
  // what and gives, takes back and limits.
  if (may.read) $('pending').hidden = false;
  if (may.ask) { $('holders').hidden = false; $('give').hidden = false; $('limit').hidden = false; $('mine').hidden = false; }
  if (may.read || may.ask) { $('reload').hidden = false; $('reload').addEventListener('click', () => { void loadAll(); }); void loadAll(); }
  if (signIns !== null) { $('signins').hidden = false; void signIns.refresh().then(paintSignIns); }
}
