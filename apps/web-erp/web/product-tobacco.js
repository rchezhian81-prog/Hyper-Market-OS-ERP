// Tobacco health warning (W3 · D01-FR-05 · B16 · COTPA 2003 s.7 · OB-140 "A") — the Product details page's tobacco section.
// The session (apps/web-erp/src/tobacco-warning-session.ts, in the bundle as window.tobaccoWarning) does every call and every
// rule; this lays out what head office said: the warning pictures on record, the one in force, every tobacco product's
// standing, and — for each one not on sale — a confirmation, in the signed-in person's own name, that its packs carry the
// picture. There is no "confirm all". Nothing is written on open. Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const api = window.tobaccoWarning ?? null;
const session = api?.session ?? null;
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const t = (k) => (api === null ? k : api.words(lang(), k));
let read = null; let readOut = null;

function el(tag, text, cls) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; }
function input(id, label, value, type) {
  const l = el('label'); l.htmlFor = id;
  const i = el('input'); i.id = id; i.autocomplete = 'off'; if (type) i.type = type; if (value !== undefined) i.value = value;
  l.append(el('span', label), i); return l;
}

function confirmForm(p) {
  const f = el('div', undefined, 'row');
  // the picture in force, or the next one notified — confirming an older one would not put the product on sale
  const choices = [read.inForce, read.next].filter((x) => typeof x === 'string' && x !== '');
  const l = el('label'); l.htmlFor = `tc-picture-${p.productId}`;
  const sel = el('select'); sel.id = `tc-picture-${p.productId}`;
  for (const c of choices) { const o = el('option', c); o.value = c; sel.append(o); }
  l.append(el('span', t('confirmPicture')), sel);
  const ev = input(`tc-evidence-${p.productId}`, t('confirmEvidence'));
  const b = el('button', t('confirm')); b.type = 'button'; b.id = `tc-go-${p.productId}`;
  b.addEventListener('click', async () => {
    $('confirm-status').className = 'status'; $('confirm-status').textContent = t('saving');
    const out = await session.confirm(p.productId, sel.value, $(`tc-evidence-${p.productId}`).value);
    $('confirm-status').className = out.result === 'ok' ? 'status good' : 'status err';
    $('confirm-status').textContent = out.result === 'ok' ? `${p.name || p.productId}: ${t('confirmed')}` : api.outcomeWords(lang(), out);
    if (out.result === 'ok') await load();
  });
  f.append(l, ev, b);
  return f;
}

function paint() {
  if (api === null || session === null) return;
  const sec = $('tobacco');
  sec.hidden = !session.may.read;
  if (sec.hidden) return;
  for (const [id, k] of [['tobacco-h', 'h'], ['tobacco-lead', 'lead'], ['pictures-h', 'picturesH'], ['picture-form-h', 'recordH'], ['picture-note', 'recordNote'],
    ['l-tw-id', 'imageId'], ['l-tw-notified', 'notifiedOn'], ['l-tw-from', 'effectiveFrom'], ['l-tw-ref', 'reference'], ['l-tw-evidence', 'evidenceRef'], ['tw-record', 'record'], ['tobacco-products-h', 'productsH']]) $(id).textContent = t(k);
  $('picture-form').hidden = !session.may.record;
  if (read === null) {
    $('tobacco-status').textContent = readOut === null ? t('reading') : api.outcomeWords(lang(), readOut);
    return;
  }
  $('tobacco-status').textContent = '';
  $('pictures-now').textContent = read.pictures.length === 0 ? t('noPictures') : `${t('inForce')}: ${read.inForce ?? t('none')} · ${t('next')}: ${read.next ?? t('none')}`;
  $('picture-rows').replaceChildren(...read.pictures.map((p) => {
    const li = el('li', `${p.imageId} — ${t('colFrom')} ${p.effectiveFrom} · ${t('colNotified')} ${p.notifiedOn} · ${p.reference}`, 'row-item');
    li.dataset.picture = p.imageId; return li;
  }));
  $('tobacco-rows').replaceChildren(...(read.products.length === 0 ? [el('li', t('noProducts'), 'muted')] : read.products.map((p) => {
    const li = el('li'); li.dataset.product = p.productId; li.dataset.sellable = String(p.sellable);
    const head = el('p');
    head.append(el('strong', `${p.name || p.productId} (${p.productId})`), document.createTextNode(' — '));
    head.append(document.createTextNode(p.sellable
      ? `${t('sellable')} · ${t('confirmedBy')} ${p.confirmedBy ?? ''}${p.goodUntil === null ? '' : ` · ${t('goodUntil')} ${p.goodUntil}`}`
      : `${t('notSellable')} · ${t(`st_${p.standing}`)}`));
    li.append(head);
    if (!p.sellable && session.may.confirm && (read.inForce !== null || read.next !== null)) li.append(confirmForm(p));
    return li;
  })));
}

async function load() {
  const out = await session.read();
  if (out.result === 'ok') { read = out.value; readOut = null; } else { read = null; readOut = out; }
  paint();
}

$('picture-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('picture-status').className = 'status'; $('picture-status').textContent = t('saving');
  const out = await session.recordPicture({ imageId: $('tw-id').value, notifiedOn: $('tw-notified').value, effectiveFrom: $('tw-from').value, reference: $('tw-ref').value, evidenceRef: $('tw-evidence').value });
  $('picture-status').className = out.result === 'ok' ? 'status good' : 'status err';
  $('picture-status').textContent = out.result === 'ok' ? `${t('recorded')} ${out.value.imageId}.` : api.outcomeWords(lang(), out);
  if (out.result === 'ok') { for (const id of ['tw-id', 'tw-ref', 'tw-evidence']) $(id).value = ''; await load(); }
});
new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
if (session !== null && session.may.read) { paint(); void load(); } else paint();
