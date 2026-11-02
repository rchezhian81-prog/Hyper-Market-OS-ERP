// Organisation — the THIN CLIENT over head office's hierarchy (M01-FR-01 · PA-05). It holds no rule: where a place may
// sit, whether a draft may activate and every refusal are head office's (`/v1/org/nodes`, the tested org engine). It
// draws the tree as read, and sends a person's change in their own session — add, rename, activate — each POST with
// its own idempotency key, then reads the tree again so what is shown is what head office kept. Every word has a
// Tamil twin and follows the one language toggle.

const $ = (id) => document.getElementById(id);
const who = window.organisationData && typeof window.organisationData === 'object' ? window.organisationData : null;
const perms = new Set(Array.isArray(who?.permissions) ? who.permissions : []);
const mayRead = perms.has('org.branch.read');
const mayChange = perms.has('platform.setup.write');

const WORDS = {
  en: {
    title: 'Organisation', treeH: 'The shop\'s places',
    treeLede: 'The company, its stores, their back stores and departments — every sale, permission and report belongs to one of these.',
    addH: 'Add a place', addLede: 'Head office checks where it may sit. A new place starts as a draft until it has everything it needs.',
    kind: 'Kind', name: 'Name', code: 'Short code', parent: 'Sits under', add: 'Add this place', noParent: '— nothing (a company) —',
    company: 'Company', branch: 'Store / branch', warehouse: 'Back store', department: 'Department',
    draft: 'Draft — not yet trading', active: 'Active', suspended: 'Closed for now', closed: 'Closed for good',
    gstin: 'GST registration', noGstin: 'no GST registration yet', code_: 'code', under: 'under',
    rename: 'Rename', newName: 'New name', activate: 'Activate',
    added: 'Added — head office kept it.', renamed: 'Renamed — head office kept the new name.', activated: 'Activated.',
    askedOwner: 'Asked — making a place active is the owner\'s approval (M01-FR-01). When the owner has approved it on the Approvals page, press Activate again.',
    waitingOwner: 'Still waiting for the owner\'s approval on the Approvals page.',
    needName: 'Write a name and a short code first.', refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.',
    empty: 'No places yet. Start with the company.', reading: 'Reading the hierarchy from head office…', cannotRead: 'Your role cannot read the organisation.',
    readOnly: 'You can read the hierarchy; changing it needs setup rights.',
    nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.',
    deptH: 'Departments and their categories', deptLede: 'Each department owns the product categories its sales and reports count. A category belongs to one department; a change is the owner\'s approval.',
    deptCats: 'Owns', noCats: 'no categories yet — nothing is counted to it', catsInput: 'Categories it owns (ids, comma between)', why: 'Why', saveCats: 'Save the categories',
    unowned: 'Categories no department owns (their sales are counted apart): {list}', noUnowned: 'Every category belongs to a department.', noDepts: 'No department has been added yet — add one below.',
    catsAsked: 'Asked — the owner approves which categories a department owns. When he has approved it on the Approvals page, press “Save the categories” again.',
    catsWaiting: 'Still waiting for the owner\'s approval on the Approvals page.', catsRejected: 'The owner rejected it: {why}', catsSaved: 'Saved — head office counts these categories to the department.', needWhy: 'Write why first.',
    reportDay: 'Trading day', showReport: 'Show the department\'s sales', reportTotal: '{name} on {day}: {total} from {n} products. Sales no department owns that day: {unowned}.', reportNone: 'No sale of this department\'s products that day.',
    reportLine: '{name}: {qty} · {value} · {bills} bills',
  },
  ta: {
    title: 'அமைப்பு', treeH: 'கடையின் இடங்கள்',
    treeLede: 'நிறுவனம், அதன் கடைகள், அவற்றின் பின் கிடங்குகள், பிரிவுகள் — ஒவ்வொரு விற்பனையும் அனுமதியும் அறிக்கையும் இவற்றில் ஒன்றைச் சேர்ந்தது.',
    addH: 'ஒரு இடத்தைச் சேர்', addLede: 'அது எங்கே அமையலாம் என்பதைத் தலைமை அலுவலகம் சரிபார்க்கும். புதிய இடம் தேவையானவை அனைத்தும் கிடைக்கும் வரை வரைவாகத் தொடங்கும்.',
    kind: 'வகை', name: 'பெயர்', code: 'சுருக்கக் குறியீடு', parent: 'இதன் கீழ்', add: 'இந்த இடத்தைச் சேர்', noParent: '— எதுவுமில்லை (ஒரு நிறுவனம்) —',
    company: 'நிறுவனம்', branch: 'கடை / கிளை', warehouse: 'பின் கிடங்கு', department: 'பிரிவு',
    draft: 'வரைவு — இன்னும் வணிகம் இல்லை', active: 'செயலில்', suspended: 'தற்காலிகமாக மூடப்பட்டது', closed: 'நிரந்தரமாக மூடப்பட்டது',
    gstin: 'ஜிஎஸ்டி பதிவு', noGstin: 'இன்னும் ஜிஎஸ்டி பதிவு இல்லை', code_: 'குறியீடு', under: 'இதன் கீழ்',
    rename: 'பெயர் மாற்று', newName: 'புதிய பெயர்', activate: 'செயல்படுத்து',
    added: 'சேர்க்கப்பட்டது — தலைமை அலுவலகம் வைத்துக்கொண்டது.', renamed: 'பெயர் மாற்றப்பட்டது — தலைமை அலுவலகம் புதிய பெயரை வைத்துக்கொண்டது.', activated: 'செயல்படுத்தப்பட்டது.',
    askedOwner: 'கேட்கப்பட்டது — ஒரு இடத்தைச் செயல்படுத்துவது உரிமையாளரின் ஒப்புதல் (M01-FR-01). உரிமையாளர் ஒப்புதல்கள் பக்கத்தில் ஒப்புதல் தந்ததும், மீண்டும் செயல்படுத்து அழுத்தவும்.',
    waitingOwner: 'ஒப்புதல்கள் பக்கத்தில் உரிமையாளரின் ஒப்புதலுக்காக இன்னும் காத்திருக்கிறது.',
    needName: 'முதலில் ஒரு பெயரும் சுருக்கக் குறியீடும் எழுதுங்கள்.', refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
    empty: 'இன்னும் இடங்கள் இல்லை. நிறுவனத்துடன் தொடங்குங்கள்.', reading: 'தலைமை அலுவலகத்திலிருந்து அமைப்பைப் படிக்கிறது…', cannotRead: 'உங்கள் பங்கால் அமைப்பைப் படிக்க முடியாது.',
    readOnly: 'நீங்கள் அமைப்பைப் படிக்கலாம்; மாற்ற அமைப்பு உரிமை தேவை.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.',
    deptH: 'பிரிவுகளும் அவற்றின் வகைகளும்', deptLede: 'ஒவ்வொரு பிரிவும் அதன் விற்பனையும் அறிக்கைகளும் கணக்கிடும் பொருள் வகைகளைக் கொண்டுள்ளது. ஒரு வகை ஒரே பிரிவைச் சேர்ந்தது; மாற்றம் உரிமையாளரின் ஒப்புதல்.',
    deptCats: 'கொண்டிருப்பவை', noCats: 'இன்னும் வகைகள் இல்லை — எதுவும் இதற்குக் கணக்கிடப்படவில்லை', catsInput: 'இது கொண்டிருக்கும் வகைகள் (எண்கள், காற்புள்ளியால் பிரிக்கவும்)', why: 'ஏன்', saveCats: 'வகைகளைச் சேமி',
    unowned: 'எந்தப் பிரிவும் கொண்டிராத வகைகள் (அவற்றின் விற்பனை தனியாகக் கணக்கிடப்படும்): {list}', noUnowned: 'ஒவ்வொரு வகையும் ஒரு பிரிவைச் சேர்ந்தது.', noDepts: 'இன்னும் பிரிவு சேர்க்கப்படவில்லை — கீழே ஒன்றைச் சேருங்கள்.',
    catsAsked: 'கேட்கப்பட்டது — ஒரு பிரிவு எந்த வகைகளைக் கொண்டிருக்கும் என்பதை உரிமையாளர் ஒப்புக்கொள்கிறார். அவர் ஒப்புதல்கள் பக்கத்தில் ஒப்புக்கொண்டதும் மீண்டும் “வகைகளைச் சேமி” அழுத்தவும்.',
    catsWaiting: 'ஒப்புதல்கள் பக்கத்தில் உரிமையாளரின் ஒப்புதலுக்காக இன்னும் காத்திருக்கிறது.', catsRejected: 'உரிமையாளர் நிராகரித்தார்: {why}', catsSaved: 'சேமிக்கப்பட்டது — தலைமை அலுவலகம் இந்த வகைகளைப் பிரிவுக்குக் கணக்கிடுகிறது.', needWhy: 'முதலில் ஏன் என்று எழுதுங்கள்.',
    reportDay: 'வணிக நாள்', showReport: 'பிரிவின் விற்பனையைக் காட்டு', reportTotal: '{day} அன்று {name}: {n} பொருட்களிலிருந்து {total}. அன்று எந்தப் பிரிவுக்கும் சேராத விற்பனை: {unowned}.', reportNone: 'அன்று இந்தப் பிரிவின் பொருட்கள் எதுவும் விற்கப்படவில்லை.',
    reportLine: '{name}: {qty} · {value} · {bills} பில்கள்',
  },
};
let lang = 'en';
const t = (k) => WORDS[lang][k] ?? WORDS.en[k] ?? k;
const idem = () => ((crypto.randomUUID && crypto.randomUUID()) || `org-${Date.now()}-${Math.random()}`);

let nodes = null;
let registrations = [];

async function post(path, body) {
  try {
    const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': idem() }, body: JSON.stringify(body ?? {}) });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}
/** OB-288 P1 (M01-FR-01): the activation this person already asked for — approved (its id), still waiting, or none. */
async function askedActivation(nodeId) {
  try {
    const res = await fetch('/v1/approvals/requests', { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } });
    const body = await res.json().catch(() => ({}));
    const mine = Array.isArray(body.mine) ? body.mine : [];
    const asked = mine.filter((r) => r.kind === 'org_structure_change' && r.subjectRef === nodeId && r.details?.action === 'activate');
    const approved = asked.find((r) => r.status === 'approved');
    if (approved !== undefined) return { approvalId: approved.requestId };
    return asked.some((r) => r.status === 'waiting') ? { waiting: true } : {};
  } catch { return {}; }
}
function say(el, out, good) {
  el.className = `status ${out.ok ? 'good' : 'err'}`;
  el.textContent = out.ok ? good : out.status === 0 ? t('unreachable') : `${t('refused')} ${out.body?.error?.whatHappened ?? out.status}`;
}

/** The tree in reading order: each company, then what sits under it, depth first, by name. */
function inTreeOrder(all) {
  const byParent = new Map();
  const ids = new Set(all.map((n) => n.nodeId));
  for (const n of all) {
    const p = n.parentId !== null && ids.has(n.parentId) ? n.parentId : '';
    byParent.set(p, [...(byParent.get(p) ?? []), n]);
  }
  const out = [];
  const visit = (parent, depth, seen) => {
    for (const n of [...(byParent.get(parent) ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
      if (seen.has(n.nodeId)) continue;
      out.push({ node: n, depth });
      visit(n.nodeId, depth + 1, new Set([...seen, n.nodeId]));
    }
  };
  visit('', 0, new Set());
  return out;
}

const companyOf = (nodeId) => {
  const byId = new Map((nodes ?? []).map((n) => [n.nodeId, n]));
  let at = byId.get(nodeId);
  const seen = new Set();
  while (at !== undefined && !seen.has(at.nodeId)) {
    if (at.kind === 'company') return at.nodeId;
    seen.add(at.nodeId);
    at = at.parentId === null ? undefined : byId.get(at.parentId);
  }
  return undefined;
};

function placeNode(entry) {
  const n = entry.node;
  const li = document.createElement('li');
  li.className = 'place';
  li.dataset.node = n.nodeId;
  li.style.marginInlineStart = `${Math.min(entry.depth, 4) * 24}px`;
  const head = document.createElement('div'); head.className = 'head';
  const name = document.createElement('span'); name.className = 'name'; name.textContent = n.name;
  const kind = document.createElement('span'); kind.textContent = t(n.kind);
  const status = document.createElement('span'); status.className = 'state'; status.dataset.status = n.status; status.textContent = t(n.status);
  head.append(name, kind, status);
  const reg = registrations.find((r) => r.gstin === n.gstin);
  const facts = document.createElement('p'); facts.className = 'facts';
  facts.textContent = `${t('code_')} ${n.nodeId}${n.parentId === null ? '' : ` · ${t('under')} ${(nodes.find((p) => p.nodeId === n.parentId)?.name) ?? n.parentId}`}`
    + (n.kind === 'branch' || n.kind === 'company' ? ` · ${n.gstin === undefined ? t('noGstin') : `${t('gstin')} ${n.gstin}${reg === undefined ? '' : ` (${reg.legalName})`}`}` : '');
  li.append(head, facts);
  if (mayChange) {
    const acts = document.createElement('div'); acts.className = 'acts';
    const input = document.createElement('input'); input.setAttribute('aria-label', `${t('newName')}: ${n.name}`); input.placeholder = t('newName'); input.autocomplete = 'off';
    const rename = document.createElement('button'); rename.classList.add('sre-btn'); rename.type = 'button'; rename.textContent = t('rename'); rename.dataset.act = 'rename';
    const line = document.createElement('p'); line.className = 'status'; line.setAttribute('role', 'status');
    rename.addEventListener('click', async () => {
      const next = input.value.trim();
      if (next === '') { line.className = 'status err'; line.textContent = t('needName'); return; }
      const out = await post(`/v1/org/nodes/${encodeURIComponent(n.nodeId)}`, {
        kind: n.kind, name: next, parentId: n.parentId, status: n.status,
        ...(n.companyId === undefined ? {} : { companyId: n.companyId }), ...(n.gstin === undefined ? {} : { gstin: n.gstin }),
      });
      say($('tree-status'), out, t('renamed'));
      await load();
    });
    acts.append(input, rename);
    if (n.status === 'draft') {
      const activate = document.createElement('button'); activate.classList.add('sre-btn'); activate.type = 'button'; activate.textContent = t('activate'); activate.dataset.act = 'activate';
      activate.addEventListener('click', async () => {
        // A structural change is the owner's approval: send the one already approved; else ask for it, once.
        const asked = await askedActivation(n.nodeId);
        if (asked.waiting === true) { $('tree-status').className = 'status err'; $('tree-status').textContent = `⏳ ${t('waitingOwner')}`; return; }
        const out = await post(`/v1/org/nodes/${encodeURIComponent(n.nodeId)}/activation`, asked.approvalId === undefined ? {} : { approvalId: asked.approvalId });
        if (!out.ok && out.body?.error?.code === 'structural_change_needs_owner_approval') {
          const ask = await post('/v1/approvals/requests', { kind: 'org_structure_change', subjectRef: n.nodeId, details: { nodeId: n.nodeId, action: 'activate' }, valueMinor: null, summary: `Activate ${n.name}`, reason: 'ready to trade' });
          if (ask.ok) { $('tree-status').className = 'status good'; $('tree-status').textContent = `⏳ ${t('askedOwner')}`; } else say($('tree-status'), ask, '');
          return;
        }
        say($('tree-status'), out, t('activated'));
        await load();
      });
      acts.append(activate);
    }
    li.append(acts, line);
  }
  return li;
}

function render() {
  const tree = $('tree');
  tree.replaceChildren();
  const status = $('tree-status');
  if (!mayRead) { status.className = 'status'; status.textContent = who === null ? '' : t('cannotRead'); return; }
  if (nodes === null) return;
  if (nodes.length === 0) { const p = document.createElement('li'); p.className = 'muted'; p.textContent = t('empty'); tree.append(p); }
  for (const entry of inTreeOrder(nodes)) tree.append(placeNode(entry));
  const parent = $('add-parent');
  const was = parent.value;
  parent.replaceChildren();
  const none = document.createElement('option'); none.value = ''; none.textContent = t('noParent');
  parent.append(none);
  for (const entry of inTreeOrder(nodes)) {
    const o = document.createElement('option');
    o.value = entry.node.nodeId;
    o.textContent = `${'  '.repeat(entry.depth)}${entry.node.name} (${t(entry.node.kind)})`;
    parent.append(o);
  }
  if ([...parent.options].some((o) => o.value === was)) parent.value = was;
}

function paintWords() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title', 'title'], ['tree-h', 'treeH'], ['tree-lede', 'treeLede'], ['dept-h', 'deptH'], ['dept-lede', 'deptLede'], ['add-h', 'addH'], ['add-lede', 'addLede'], ['l-add-kind', 'kind'], ['l-add-name', 'name'], ['l-add-code', 'code'], ['l-add-parent', 'parent'], ['add', 'add'], ['o-branch', 'branch'], ['o-warehouse', 'warehouse'], ['o-department', 'department'], ['o-company', 'company']]) {
    const el = $(id);
    if (el) el.textContent = t(k);
  }
  $('add-section').hidden = !mayChange;
  const nobody = $('nobody');
  nobody.hidden = who !== null;
  nobody.textContent = t('nobody');
}

async function load() {
  if (!mayRead) { render(); return; }
  try {
    const res = await fetch('/v1/org/nodes', { headers: { accept: 'application/json' }, credentials: 'same-origin' });
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    nodes = Array.isArray(body.nodes) ? body.nodes : [];
    registrations = Array.isArray(body.registrations) ? body.registrations : [];
    if (!mayChange) { $('tree-status').className = 'status'; $('tree-status').textContent = t('readOnly'); }
    else if ($('tree-status').textContent === t('reading')) $('tree-status').textContent = '';
  } catch {
    nodes = null;
    $('tree-status').className = 'status err';
    $('tree-status').textContent = t('unreachable');
  }
  render();
}


// ── M01-FR-01: which categories each department owns, and the department's own report (Round 4a) ───────────────────
const mayReport = perms.has('reporting.report.read');
const fillIn = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
const rupeesOf = (minor) => `₹${(minor / 100).toFixed(2)}`;
let departments = null;
let unownedCategories = [];
function canonicalOf(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalOf).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalOf(v[k])}`).join(',')}}`;
}
/** This person's own request to set exactly these categories on a department: approved (its id), waiting, rejected or none. */
async function askedDepartment(departmentId, details) {
  try {
    const res = await fetch('/v1/approvals/requests', { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } });
    const body = await res.json().catch(() => ({}));
    const mine = (Array.isArray(body.mine) ? body.mine : []).filter((r) => r.kind === 'org_structure_change' && r.subjectRef === `department:${departmentId}` && canonicalOf(r.details) === canonicalOf(details));
    const newest = (rows) => rows.slice().sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))[0];
    const approved = newest(mine.filter((r) => r.status === 'approved'));
    if (approved !== undefined) return { approvalId: approved.requestId };
    if (mine.some((r) => r.status === 'waiting')) return { waiting: true };
    const last = newest(mine);
    return last?.status === 'rejected' ? { rejected: last.decisionReason ?? '' } : {};
  } catch { return {}; }
}

function departmentRow(d) {
  const li = document.createElement('li'); li.className = 'place'; li.dataset.department = d.departmentId;
  const head = document.createElement('div'); head.className = 'head';
  const name = document.createElement('span'); name.className = 'name'; name.textContent = d.name;
  const state = document.createElement('span'); state.textContent = t(d.status);
  head.append(name, state);
  const facts = document.createElement('p'); facts.className = 'facts'; facts.dataset.role = 'categories';
  facts.textContent = `${t('deptCats')}: ${d.categoryIds.length === 0 ? t('noCats') : d.categoryIds.join(', ')}`;
  li.append(head, facts);
  const line = document.createElement('p'); line.className = 'status'; line.setAttribute('role', 'status');
  if (mayChange) {
    const acts = document.createElement('div'); acts.className = 'acts';
    const cats = document.createElement('input'); cats.setAttribute('aria-label', `${t('catsInput')}: ${d.name}`); cats.placeholder = t('catsInput'); cats.autocomplete = 'off';
    cats.value = d.categoryIds.join(', '); cats.setAttribute('list', 'category-list'); cats.dataset.role = 'cats';
    const why = document.createElement('input'); why.setAttribute('aria-label', `${t('why')}: ${d.name}`); why.placeholder = t('why'); why.autocomplete = 'off'; why.dataset.role = 'why';
    const save = document.createElement('button'); save.classList.add('sre-btn'); save.type = 'button'; save.textContent = t('saveCats'); save.dataset.act = 'save-categories';
    save.addEventListener('click', async () => {
      const reason = why.value.trim();
      if (reason === '') { line.className = 'status err'; line.textContent = t('needWhy'); return; }
      const categoryIds = [...new Set(cats.value.split(',').map((c) => c.trim()).filter((c) => c !== ''))].sort();
      const details = { categoryIds, reason, departmentId: d.departmentId };
      const asked = await askedDepartment(d.departmentId, details);
      if (asked.waiting === true) { line.className = 'status err'; line.textContent = `⏳ ${t('catsWaiting')}`; return; }
      if (asked.rejected !== undefined) { line.className = 'status err'; line.textContent = fillIn(t('catsRejected'), { why: asked.rejected }); return; }
      if (asked.approvalId === undefined) {
        const ask = await post('/v1/approvals/requests', { kind: 'org_structure_change', subjectRef: `department:${d.departmentId}`, details, valueMinor: null, summary: `${d.name}: categories ${categoryIds.join(', ') || 'none'}`, reason });
        if (ask.ok) { line.className = 'status good'; line.textContent = `⏳ ${t('catsAsked')}`; } else say(line, ask, '');
        return;
      }
      const out = await post(`/v1/org/departments/${encodeURIComponent(d.departmentId)}/categories`, { categoryIds, reason, approvalId: asked.approvalId });
      if (out.ok) {
        await loadDepartments();
        const again = [...document.querySelectorAll('#depts li.place')].find((x) => x.dataset.department === d.departmentId)?.querySelector(':scope > p.status');
        if (again) { again.className = 'status good'; again.textContent = t('catsSaved'); }
      } else say(line, out, '');
    });
    acts.append(cats, why, save);
    li.append(acts);
  }
  if (mayReport) {
    const acts = document.createElement('div'); acts.className = 'acts';
    const day = document.createElement('input'); day.type = 'date'; day.setAttribute('aria-label', `${t('reportDay')}: ${d.name}`); day.dataset.role = 'day';
    day.value = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const show = document.createElement('button'); show.classList.add('sre-btn'); show.type = 'button'; show.textContent = t('showReport'); show.dataset.act = 'report';
    const out = document.createElement('ul'); out.className = 'tree'; out.dataset.role = 'report';
    show.addEventListener('click', async () => {
      try {
        const res = await fetch(`/v1/org/departments/${encodeURIComponent(d.departmentId)}/report?${new URLSearchParams({ day: day.value })}`, { credentials: 'same-origin', headers: { accept: 'application/json' }, cache: 'no-store' });
        const body = await res.json().catch(() => null);
        if (!res.ok) { say(line, { ok: false, status: res.status, body }, ''); out.replaceChildren(); return; }
        line.className = 'status';
        line.textContent = fillIn(t('reportTotal'), { name: body.name, day: body.tradingDay, total: rupeesOf(body.totalValueMinor), n: body.products.length, unowned: rupeesOf(body.unownedValueMinor) });
        out.replaceChildren(...(body.products.length === 0 ? [Object.assign(document.createElement('li'), { className: 'muted', textContent: t('reportNone') })]
          : body.products.map((p) => Object.assign(document.createElement('li'), { className: 'place', textContent: fillIn(t('reportLine'), { name: p.name ?? p.productId, qty: p.quantityMinor, value: rupeesOf(p.valueMinor), bills: p.bills }) }))));
      } catch { say(line, { ok: false, status: 0, body: null }, ''); }
    });
    acts.append(day, show);
    li.append(acts, out);
  }
  li.append(line);
  return li;
}

function renderDepartments() {
  const ul = $('depts');
  ul.replaceChildren();
  $('dept-section').hidden = !mayRead;
  if (departments === null) return;
  if (departments.length === 0) ul.append(Object.assign(document.createElement('li'), { className: 'muted', textContent: t('noDepts') }));
  for (const d of departments) ul.append(departmentRow(d));
  $('unowned').textContent = unownedCategories.length === 0 ? t('noUnowned') : fillIn(t('unowned'), { list: unownedCategories.join(', ') });
}

async function loadDepartments() {
  if (!mayRead) { renderDepartments(); return; }
  try {
    const [res, cats] = await Promise.all([
      fetch('/v1/org/departments', { headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' }),
      fetch('/v1/catalogue/categories', { headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' }).catch(() => null),
    ]);
    const body = await res.json().catch(() => null);
    if (!res.ok) { departments = null; say($('dept-status'), { ok: false, status: res.status, body }, ''); renderDepartments(); return; }
    departments = Array.isArray(body?.departments) ? body.departments : [];
    unownedCategories = Array.isArray(body?.unownedCategories) ? body.unownedCategories : [];
    if (cats !== null && cats.ok) {
      const list = (await cats.json().catch(() => ({}))).categories ?? [];
      $('category-list').replaceChildren(...list.map((c) => Object.assign(document.createElement('option'), { value: c.categoryId, label: c.name })));
    }
    $('dept-status').textContent = '';
  } catch {
    departments = null;
    $('dept-status').className = 'status err'; $('dept-status').textContent = t('unreachable');
  }
  renderDepartments();
}

$('add').addEventListener('click', async () => {
  const name = $('add-name').value.trim();
  const code = $('add-code').value.trim();
  if (name === '' || code === '') { $('add-status').className = 'status err'; $('add-status').textContent = t('needName'); return; }
  const kind = $('add-kind').value;
  const parentId = $('add-parent').value === '' ? null : $('add-parent').value;
  const companyId = kind === 'company' ? undefined : (parentId === null ? undefined : companyOf(parentId));
  const out = await post(`/v1/org/nodes/${encodeURIComponent(code)}`, { kind, name, parentId, ...(companyId === undefined ? {} : { companyId }) });
  say($('add-status'), out, t('added'));
  if (out.ok) { $('add-name').value = ''; $('add-code').value = ''; }
  await load();
  await loadDepartments();
});

$('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintWords();
  render();
  renderDepartments();
});

paintWords();
if (who !== null) { $('tree-status').textContent = t('reading'); void load(); void loadDepartments(); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
