// W5 (store operations): draws the sections the bundle attached as `window.w5Sections` — the owner's policy numbers on
// Settings, the indent changes, the held direct-delivery goods, on-shelf availability, trace requests, an ingredient's
// cost, bins, the facilities records, the loss-prevention records and the no-receipt report. Every rule, check and word is
// in the TESTED sections (apps/web-erp/src/w5-store-ops-sections.ts and w5-facilities-lp-sections.ts); this file only lays
// them out — a heading, labelled boxes, one button, a status line that says head office's answer, and a list — and
// repaints them when the page's language changes. A read marked `auto` runs once on open (GET only); nothing is written
// until a person presses a button. No prompt/confirm/alert.

const sections = Array.isArray(window.w5Sections) ? window.w5Sections : [];
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const painters = [];

function el(tag, cls, text) {
  const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text;
  // Every control a section draws wears the foundation's class, so it is a 44px target with the one look (U0/U1 rules).
  if (tag === 'button') n.classList.add('sre-btn'); else if (tag === 'select') n.classList.add('sre-select'); else if (tag === 'textarea' || tag === 'input') n.classList.add('sre-input');
  return n;
}

function inputFor(f, id) {
  let box;
  if (f.kind === 'select') {
    box = document.createElement('select');
    for (const o of f.options ?? []) { const opt = document.createElement('option'); opt.value = o.value; opt.dataset.label = 'y'; box.append(opt); }
  } else if (f.kind === 'lines') {
    box = document.createElement('textarea'); box.rows = 4;
  } else {
    box = document.createElement('input');
    box.type = f.kind === 'datetime' ? 'datetime-local' : f.kind === 'date' ? 'date' : 'text';
    if (f.kind === 'money') box.inputMode = 'decimal';
    if (f.kind === 'number') box.inputMode = 'numeric';
    box.autocomplete = 'off';
  }
  box.id = id; box.name = f.key;
  if (f.initial !== undefined) box.value = f.initial;
  return box;
}

function drawAction(sec, a, host) {
  const base = `${sec.id}-${a.id}`;
  const box = el('div', 'w5-action'); box.id = base;
  const h = el('h3'); h.id = `${base}-h`; box.append(h);
  const note = a.note === undefined ? null : el('p', 'note'); if (note) box.append(note);
  const fields = a.fields.map((f) => {
    const wrap = el('div', 'w5-field');
    const label = el('label'); label.htmlFor = `${base}-${f.key}`;
    const input = inputFor(f, `${base}-${f.key}`);
    wrap.append(label, input); box.append(wrap);
    return { f, label, input };
  });
  const go = el('button', 'sre-btn'); go.type = 'button'; go.id = `${base}-go`; box.append(go);
  const status = el('p', 'status'); status.id = `${base}-said`; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); box.append(status);
  const rows = el('ul', 'w5-rows'); rows.id = `${base}-rows`; rows.setAttribute('aria-labelledby', `${base}-h`); box.append(rows);
  let last = null;
  const paintSaid = () => {
    status.textContent = last === null ? '' : last.text(lang());
    status.dataset.tone = last === null ? '' : last.tone;
    rows.replaceChildren();
    for (const line of last?.lines ?? []) {
      const li = el('li', `w5-line tone-${line.tone}`, line.text(lang()));
      li.dataset.tone = line.tone; if (line.key !== undefined) li.dataset.key = line.key;
      rows.append(li);
    }
  };
  const paint = () => {
    h.textContent = a.title(lang());
    if (note) note.textContent = a.note(lang());
    for (const { f, label, input } of fields) {
      label.textContent = f.label(lang());
      if (f.kind === 'select') [...input.options].forEach((opt, i) => { opt.textContent = f.options[i].label(lang()); });
    }
    go.textContent = a.go(lang());
    paintSaid();
  };
  const run = async () => {
    go.disabled = true;
    try {
      const values = Object.fromEntries(fields.map(({ f, input }) => [f.key, input.value]));
      last = await a.run(values);
      paintSaid();
      if (last.stop !== true) for (const other of a.refresh ?? []) sec.runners.get(other)?.();
    } finally { go.disabled = false; }
  };
  go.addEventListener('click', () => { void run(); });
  sec.runners.set(a.id, () => { void run(); });
  painters.push(paint);
  host.append(box);
  paint();
  return a.auto === true ? run : null;
}

const main = document.querySelector('main') ?? document.body;
const opening = [];
for (const sec of sections) {
  sec.runners = new Map();
  const s = el('section', 'w5-section'); s.id = sec.id; s.setAttribute('aria-labelledby', `${sec.id}-heading`);
  const h = el('h2'); h.id = `${sec.id}-heading`;
  const lead = el('p', 'lead'); lead.id = `${sec.id}-lead`;
  s.append(h, lead);
  painters.push(() => { h.textContent = sec.heading(lang()); lead.textContent = sec.lead(lang()); });
  for (const a of sec.actions) { const r = drawAction(sec, a, s); if (r !== null) opening.push(r); }
  main.append(s);
}
const repaint = () => { for (const p of painters) p(); };
repaint();
new MutationObserver(repaint).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
document.addEventListener('sre:chrome', repaint);
for (const r of opening) void r();
