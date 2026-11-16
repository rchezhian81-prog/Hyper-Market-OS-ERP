// Users & roles — "Change what a role may do" (CR-01 step 4c-2 · ADR-0034 · OB-740 "B" · OB-809). The tested session
// (apps/web-erp/src/role-change-session.ts, in the bundle as window.users.roleChange) does every call and every rule; this
// file lays out what it is told. It reads as it opens (GETs only); every write is an explicit press. On the store PC asking
// asks for the person's PIN again; the second person approves on the Approvals page, with their PIN.

const $ = (id) => document.getElementById(id);
const api = window.users ?? null;
const rc = api?.roleChange ?? null;
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';
const w = (k) => (api?.roleChangeWords ? api.roleChangeWords(lang, k) : k);
const permWords = (code) => (api?.permissionWords ? api.permissionWords(code, lang) : code);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, onClick) { const b = document.createElement('button'); b.type = 'button'; b.className = 'sre-btn sre-btn-quiet quiet'; b.textContent = words; b.addEventListener('click', onClick); return b; }
const outWords = (out) => (out.result === 'invalid' ? w(out.why) : out.result === 'lost_link' ? w('unreachable') : `${w('refused')} ${out.whatHappened}`);

let view = null; let mine = [];
const roleWord = (r) => (lang === 'ta' && typeof r?.nameTa === 'string' && r.nameTa !== '' ? r.nameTa : r?.name ?? '');
const roleOf = (id) => view?.roles.find((r) => r.roleId === id);

function paintPermissions() {
  const sel = $('rc-perm'); const keep = sel.value; sel.replaceChildren();
  const role = roleOf($('rc-role').value);
  $('rc-locked').hidden = role === undefined || role.locked === null;
  if (role !== undefined && role.locked !== null) $('rc-locked').textContent = `${w('locked')} ${role.locked}`;
  if (role === undefined || role.locked !== null) return;
  const change = $('rc-change').value;
  // Switch on: what the role does not hold yet; switch off: what it holds. Only what may be changed from a screen.
  const list = (change === 'add' ? view.productPermissions.filter((p) => !role.permissions.includes(p)) : role.permissions)
    .filter((p) => rc.offered(view, role.roleId, p))
    .map((p) => ({ p, words: permWords(p) }))
    .sort((a, b) => a.words.localeCompare(b.words));
  sel.append(text('option', '—'));
  sel.firstChild.value = '';
  for (const { p, words } of list) { const o = text('option', `${words} (${p})`); o.value = p; sel.append(o); }
  if (list.some((x) => x.p === keep)) sel.value = keep;
}

function paintHolds() {
  const ul = $('rc-holds'); ul.replaceChildren();
  const role = roleOf($('rc-role').value);
  if (role === undefined) return;
  for (const p of role.permissions) {
    const tag = role.added.includes(p) ? ` — ${w('added')}` : '';
    const li = text('li', `${permWords(p)}${tag}`); li.dataset.permission = p; li.append(text('small', ` ${p}`, 'meta')); ul.append(li);
  }
  for (const p of role.removed) { const li = text('li', `${permWords(p)} — ${w('removed')}`, 'meta'); li.dataset.permission = p; ul.append(li); }
}

function paintMine() {
  const ul = $('rc-mine'); ul.replaceChildren();
  for (const m of mine) {
    const li = document.createElement('li'); li.dataset.approval = m.approvalId;
    li.append(text('h4', `${roleWord(roleOf(m.roleId)) || m.roleId}: ${m.change === 'add' ? w('on') : w('off')} — ${permWords(m.permission)}`), text('p', `${w(`st_${m.status}`)} · ${m.reason}`, 'meta'));
    // At head office the asker applies an approved change here (a recent second-factor sign-in); on the store PC it was
    // applied when the second person approved it.
    if (m.status === 'approved' && !rc.onStorePc) {
      const status = text('p', '', 'status'); status.setAttribute('role', 'status');
      li.append(button(w('apply'), async () => { status.textContent = w('reading'); const out = await rc.apply(m); status.textContent = out.result === 'ok' ? w('applied') : outWords(out); if (out.result === 'ok') void load(true); }), status);
    }
    ul.append(li);
  }
}

function paintHistory() {
  const ul = $('rc-history'); ul.replaceChildren();
  if (view === null) return;
  if (view.history.length === 0) { ul.append(text('li', w('none'), 'meta')); return; }
  for (const h of [...view.history].reverse()) {
    const li = document.createElement('li'); li.dataset.change = h.requestId;
    li.append(text('h4', `${roleWord(roleOf(h.roleId)) || h.roleId}: ${h.change === 'add' ? w('on') : w('off')} — ${permWords(h.permission)}`),
      text('p', `${w('by')} ${h.requestedBy} · ${w('approvedBy')} ${h.approvedBy} · ${h.reason}`, 'meta'));
    // Undo is the opposite change, asked and approved the same way (ADR-0034 decision 1).
    li.append(button(w('undo'), () => {
      $('rc-role').value = h.roleId; $('rc-change').value = h.change === 'add' ? 'remove' : 'add'; paintPermissions(); paintHolds();
      $('rc-perm').value = h.permission; $('rc-reason').focus();
    }));
    ul.append(li);
  }
}

function paint() {
  for (const [id, key] of [['rc-h', 'h'], ['rc-lead', 'lead'], ['rc-role-l', 'role'], ['rc-change-l', 'change'], ['rc-on', 'on'], ['rc-off', 'off'], ['rc-perm-l', 'permission'], ['rc-reason-l', 'reason'],
    ['rc-check-text', 'check'], ['rc-ask-text', 'ask'], ['rc-holds-h', 'holdsNow'], ['rc-mine-h', 'mineH'], ['rc-history-h', 'history']]) $(id).textContent = w(key);
  const sel = $('rc-role'); const keep = sel.value; sel.replaceChildren();
  sel.append(text('option', '—')); sel.firstChild.value = '';
  for (const r of view?.roles ?? []) { const o = text('option', `${roleWord(r)}${r.locked === null ? '' : ' 🔒'}`); o.value = r.roleId; sel.append(o); }
  if ((view?.roles ?? []).some((r) => r.roleId === keep)) sel.value = keep;
  paintPermissions(); paintHolds(); paintMine(); paintHistory();
}

// `quiet`: read again after an act, keeping the act's own words on screen (a failed read is still said).
async function load(quiet = false) {
  if (!quiet) $('rc-status').textContent = w('reading');
  const [v, m] = await Promise.all([rc.view(), rc.mine()]);
  view = v.result === 'ok' ? v.value : null; mine = m.result === 'ok' ? m.value : [];
  if (v.result !== 'ok') $('rc-status').textContent = outWords(v);
  else if (!quiet) $('rc-status').textContent = '';
  paint();
}

if (rc !== null && rc.may.adjust) {
  $('role-change').hidden = false;
  $('rc-role').addEventListener('change', () => { paintPermissions(); paintHolds(); });
  $('rc-change').addEventListener('change', paintPermissions);
  $('rc-check').addEventListener('click', async () => {
    $('rc-status').textContent = w('reading');
    const out = await rc.check({ roleId: $('rc-role').value, permission: $('rc-perm').value, change: $('rc-change').value });
    if (out.result !== 'ok') { $('rc-status').textContent = outWords(out); return; }
    $('rc-status').textContent = out.value.allowed
      ? w('allowed').replace('{n}', String(out.value.affectedPeople.length)).replace('{who}', out.value.approvedBy)
      : `${w('notAllowed')} ${out.value.why}`;
  });
  $('rc-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('rc-status').textContent = w('reading');
    const out = await rc.ask({ roleId: $('rc-role').value, permission: $('rc-perm').value, change: $('rc-change').value, reason: $('rc-reason').value });
    $('rc-status').textContent = out.result === 'ok' ? (out.value.words !== '' ? out.value.words : w(rc.onStorePc ? 'askedStorePc' : 'asked')) : outWords(out);
    if (out.result === 'ok') { $('rc-reason').value = ''; void load(true); }
  });
  document.getElementById('lang')?.addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; paint(); });
  void load();
}
