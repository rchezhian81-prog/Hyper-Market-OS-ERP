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
    needName: 'Write a name and a short code first.', refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was changed.',
    empty: 'No places yet. Start with the company.', reading: 'Reading the hierarchy from head office…', cannotRead: 'Your role cannot read the organisation.',
    readOnly: 'You can read the hierarchy; changing it needs setup rights.',
    nobody: 'Nobody is signed in on this screen — you can read nothing and change nothing.',
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
    needName: 'முதலில் ஒரு பெயரும் சுருக்கக் குறியீடும் எழுதுங்கள்.', refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் மாற்றப்படவில்லை.',
    empty: 'இன்னும் இடங்கள் இல்லை. நிறுவனத்துடன் தொடங்குங்கள்.', reading: 'தலைமை அலுவலகத்திலிருந்து அமைப்பைப் படிக்கிறது…', cannotRead: 'உங்கள் பங்கால் அமைப்பைப் படிக்க முடியாது.',
    readOnly: 'நீங்கள் அமைப்பைப் படிக்கலாம்; மாற்ற அமைப்பு உரிமை தேவை.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்கவோ மாற்றவோ முடியாது.',
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
    const rename = document.createElement('button'); rename.type = 'button'; rename.textContent = t('rename'); rename.dataset.act = 'rename';
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
      const activate = document.createElement('button'); activate.type = 'button'; activate.textContent = t('activate'); activate.dataset.act = 'activate';
      activate.addEventListener('click', async () => {
        const out = await post(`/v1/org/nodes/${encodeURIComponent(n.nodeId)}/activation`, {});
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
  for (const [id, k] of [['title', 'title'], ['tree-h', 'treeH'], ['tree-lede', 'treeLede'], ['add-h', 'addH'], ['add-lede', 'addLede'], ['l-add-kind', 'kind'], ['l-add-name', 'name'], ['l-add-code', 'code'], ['l-add-parent', 'parent'], ['add', 'add'], ['o-branch', 'branch'], ['o-warehouse', 'warehouse'], ['o-department', 'department'], ['o-company', 'company']]) {
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
});

$('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paintWords();
  render();
});

paintWords();
if (who !== null) { $('tree-status').textContent = t('reading'); void load(); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
