// Shelf tags (OB-505 · B3) — the page over head office's catalogue reads. The session
// (apps/web-erp/src/shelf-tags-session.ts, in the bundle as window.shelfTags) reads and judges every tag; this page lays out
// what it is told and prints with the browser's own print. Nothing is read on open; nothing is ever written. Every word has a
// Tamil twin; every button its icon. Printing is on the label printer by default (OB-505: one tag per label, the page the
// label's own size, no margin) or as a sheet to cut; the choice is made each time (nothing is kept in the browser). Before
// printing every tag is measured: one whose words do not fit its label is refused by name — never a price cut off unseen.

const $ = (id) => document.getElementById(id);
const api = window.shelfTags ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
let sheet = null;
let overflowing = [];

function fillSelect(id, values, word) {
  const sel = $(id); const keep = sel.value;
  sel.replaceChildren(...values.map((v) => { const o = document.createElement('option'); o.value = v; o.textContent = word(v); return o; }));
  if (keep) sel.value = keep;
}

/** One tag, drawn in real millimetres at the heights the session judged it at. */
function drawTag(tag) {
  const box = document.createElement('div');
  box.className = 'tag';
  box.dataset.product = tag.productId;
  box.style.width = `${tag.template.widthMm}mm`;
  box.style.height = `${tag.template.heightMm}mm`;
  const words = (l) => api.tagWords(l);
  const langs = tag.language === 'both' ? ['en', 'ta'] : [tag.language];
  // OB-549 (owner, 28 Oct 2026): an English-and-Tamil tag keeps the product's name in both languages but prints its small field
  // labels (price, MRP, per kg, taxes, saving) in English only, so the MRP and the unit price fit at their lawful heights.
  const labelLangs = tag.language === 'both' ? ['en'] : langs;
  const say = (pick) => labelLangs.map((l) => pick(words(l))).filter((v, i, a) => a.indexOf(v) === i).join(' / ');
  const sized = (node, mm) => { node.style.fontSize = `${mm}mm`; return node; };
  const names = [];
  if (langs.includes('en') || tag.nameTa === undefined) names.push(tag.nameEn);
  if (langs.includes('ta') && tag.nameTa !== undefined) names.push(tag.nameTa);
  for (const n of names) box.append(sized(text('div', n, 'name'), tag.fontMm.letters));
  if (tag.netQuantity) box.append(sized(text('div', `${say((w) => w.net)}: ${tag.netQuantity}`, 'net'), tag.fontMm.letters));
  const price = document.createElement('div'); price.className = 'row';
  price.append(sized(text('span', say((w) => w.price), 'label'), tag.fontMm.letters), sized(text('span', api.rupees(tag.sellingPriceMinor), 'price'), tag.fontMm.price));
  box.append(price);
  const facts = document.createElement('div'); facts.className = 'row';
  facts.append(sized(text('span', tag.mrpMinor === undefined ? say((w) => w.loose) : `${say((w) => w.mrp)} ${api.rupees(tag.mrpMinor)}`, 'mrp'), tag.fontMm.numerals));
  facts.append(sized(text('span', `${api.rupees(tag.unitPrice.unitPriceMinor)} ${say((w) => w.per[tag.unitPrice.per])}`, 'unit'), tag.fontMm.numerals));
  box.append(facts);
  const foot = document.createElement('div'); foot.className = 'row';
  foot.append(sized(text('span', tag.savingMinor === undefined ? say((w) => w.tax) : `${say((w) => w.save)} ${api.rupees(tag.savingMinor)}`, 'save'), tag.fontMm.letters));
  if (tag.barcode) foot.append(sized(text('span', tag.barcode, 'code'), tag.fontMm.numerals));
  box.append(foot);
  return box;
}

function paintSheet() {
  $('refused').hidden = true; $('notes').hidden = true; $('sheet-section').hidden = true;
  $('refused-rows').replaceChildren(); $('notes-rows').replaceChildren(); $('sheet').replaceChildren();
  overflowing = []; sayFit();
  if (sheet === null) return;
  if (sheet.refused.length > 0) {
    $('refused').hidden = false;
    $('refused-rows').replaceChildren(...sheet.refused.map((r) => {
      const li = text('li', `${r.code}${r.name ? ` · ${r.name}` : ''} — ${t(`r_${r.refusal}`)}${lang === 'en' ? ` (${r.detail})` : ''}`, 'attention');
      li.dataset.refusal = r.refusal; return li;
    }));
  }
  const noted = sheet.tags.filter((g) => g.notes.length > 0);
  if (noted.length > 0) {
    $('notes').hidden = false;
    $('notes-rows').replaceChildren(...noted.map((g) => text('li', `${g.nameEn} — ${t('note_no_ta')}`)));
  }
  if (sheet.tags.length > 0) {
    $('sheet-section').hidden = false;
    $('sheet-meta').textContent = `${t('packFrom')} v${sheet.packVersion} · ${sheet.tags.length} ${t('made')}`;
    $('sheet').replaceChildren(...sheet.tags.map(drawTag));
    preparePrint();
  }
}

const PART_CLASSES = ['name', 'net', 'label', 'price', 'mrp', 'unit', 'save', 'code'];
/** Measure every drawn tag: is anything inside it drawn beyond its label? Marks each such tag and says so, by name. */
function checkFit() {
  const measures = [...$('sheet').querySelectorAll('.tag')].map((box) => {
    const edge = box.getBoundingClientRect();
    const partsOutside = [...box.querySelectorAll(PART_CLASSES.map((c) => `.${c}`).join(','))]
      .filter((part) => { const r = part.getBoundingClientRect(); return r.bottom > edge.bottom + 1 || r.right > edge.right + 1 || r.top < edge.top - 1 || r.left < edge.left - 1; })
      .map((part) => part.className);
    const tag = sheet.tags.find((g) => g.productId === box.dataset.product);
    return { productId: box.dataset.product, name: tag?.nameEn ?? box.dataset.product, boxWidth: box.clientWidth, boxHeight: box.clientHeight, contentWidth: box.scrollWidth, contentHeight: box.scrollHeight, partsOutside: [...new Set(partsOutside)] };
  });
  overflowing = api.tagsThatOverflow(measures);
  const over = new Set(overflowing.map((o) => o.productId));
  for (const box of $('sheet').querySelectorAll('.tag')) { if (over.has(box.dataset.product)) box.dataset.overflow = '1'; else delete box.dataset.overflow; }
  sayFit();
  return overflowing;
}
function sayFit() {
  $('t-print-status').hidden = overflowing.length === 0;
  $('t-print-status').textContent = overflowing.length === 0 ? '' : api.overflowWords(lang, overflowing.map((o) => o.name));
}
/** The paper for this print — the label's own size on the label printer, a sheet with a margin otherwise — and the hint. */
function preparePrint() {
  if (sheet === null || sheet.tags.length === 0) return;
  const template = sheet.tags[0].template;
  const mode = $('t-mode').value === 'sheet' ? 'sheet' : 'label';
  $('print-css').textContent = api.printCss(template, mode);
  $('t-hint').textContent = api.printHint(lang, mode, template);
  checkFit();
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['choose-h', 'chooseH'], ['f-text-l', 'find'], ['f-find-text', 'findButton'], ['t-codes-l', 'codes'], ['t-lang-l', 'language'], ['t-size-l', 'size'],
    ['t-make-text', 'make'], ['refused-h', 'refusedH'], ['notes-h', 'notesH'], ['t-print-text', 'print'], ['t-mode-l', 'printer']]) $(id).textContent = t(key);
  if (api !== null) {
    fillSelect('t-lang', api.languages, (v) => t(`l_${v}`));
    fillSelect('t-size', api.templates.map((x) => x.templateId), (v) => t(v));
    fillSelect('t-mode', api.printModes, (v) => t(`m_${v}`));
  }
  paintSheet();
}

for (const [id, name] of [['f-find', 'search'], ['t-make', 'tag'], ['t-print', 'ticket']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else {
  $('choose').hidden = false;
  $('f-find').addEventListener('click', async () => {
    const out = await session.find($('f-text').value);
    $('f-rows').replaceChildren();
    if (out.result !== 'ok') { $('f-status').textContent = api.outcomeWords(lang, out); return; }
    $('f-status').textContent = out.value.length === 0 ? t('none') : '';
    $('f-rows').replaceChildren(...out.value.map((r) => {
      const li = text('li', `${r.name} · ${r.barcode ?? r.sku} · ${api.rupees(r.priceMinor)}`);
      const add = document.createElement('button'); add.type = 'button'; add.className = 'quiet'; add.dataset.code = r.barcode ?? r.productId;
      const i = icon('list-plus'); if (i !== null) add.append(i);
      add.append(text('span', t('add')));
      add.addEventListener('click', () => { const box = $('t-codes'); box.value = `${box.value.trim() === '' ? '' : `${box.value.trim()}\n`}${add.dataset.code}`; });
      li.append(add); return li;
    }));
  });
  $('t-make').addEventListener('click', async () => {
    $('t-status').textContent = '';
    const out = await session.prepare({ codes: $('t-codes').value, language: $('t-lang').value, templateId: $('t-size').value });
    if (out.result !== 'ok') { sheet = null; paintSheet(); $('t-status').textContent = api.outcomeWords(lang, out); return; }
    sheet = out.value; paintSheet(); $('t-status').textContent = api.outcomeWords(lang, out);
  });
  // The person's own printer, through the browser's print — the system holds no printer driver (the printer is outside it).
  $('t-mode').addEventListener('change', preparePrint);
  // Measured again at the moment of printing: a tag that does not fit its label is refused by name — nothing is printed.
  $('t-print').addEventListener('click', () => {
    preparePrint();
    if (sheet === null || sheet.tags.length === 0 || overflowing.length > 0) return;
    window.print();
  });
}
