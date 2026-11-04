// EPR registers — the records a person keeps (W5 · OB-212 · R4 B20–B22). The session (apps/web-erp/src/epr-records-session.ts,
// in the bundle as window.eprRecords) does every call and every rule; this script lays out the forms under the registers
// epr.js shows, and after each record asks epr.js to read the registers again ('epr:changed'). Every record is an explicit
// press; head office decides whether it stands and its refusal is shown as it said it (OB-553). Every word added here has a
// Tamil twin; the page's language toggle (epr.js) changes both. No prompt/confirm/alert; nothing on a timer.

const $ = (id) => document.getElementById(id);
const api = window.eprRecords ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, record: false, confirm: false };
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const t = (k) => (api === null ? k : api.words(lang(), k));
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function option(value, words) { const o = document.createElement('option'); o.value = value; o.textContent = words; return o; }
function fill(sel, options) { const was = sel.value; sel.replaceChildren(...options.map(([v, w]) => option(v, w))); if (options.some(([v]) => v === was)) sel.value = was; }

let declarations = null; let recyclers = []; let waiting = [];

function tell(out, okWords) {
  const r = $('rec-result');
  r.hidden = false;
  r.className = `result tone-${out.result === 'ok' ? 'ok' : 'error'}`;
  r.textContent = out.result === 'ok' ? okWords : api.outcomeWords(lang(), out);
}

function paint() {
  if (api === null) return;
  for (const n of document.querySelectorAll('#records [data-w]')) n.textContent = t(n.dataset.w);
  fill($('cf-key'), api.settings.map((k) => [k, t(k)]));
  for (const sel of document.querySelectorAll('.ob-cat')) fill(sel, [['', '—'], ...api.categories.map((c) => [c, c])]);
  for (const sel of document.querySelectorAll('.tb-kinds')) fill(sel, api.kinds.map((k) => [k, t(k)]));
  fill($('rc-which'), [['', t('newRecycler')], ...recyclers.map((r) => [r.recyclerId, r.registrationNumber === null ? `${r.name} (${t('noNumber')})` : `${r.name} — ${r.registrationNumber}`])]);
  fill($('sh-recycler'), recyclers.map((r) => [r.recyclerId, r.registrationNumber === null ? `${r.name} (${t('noNumber')})` : `${r.name} — ${r.registrationNumber}`]));
  const assets = waiting.map((a) => [a.assetId, `${a.name} (${a.assetId}) · ${a.disposedOn}`]);
  fill($('sh-asset'), [['', t('noAsset')], ...assets]);
  fill($('ne-asset'), assets);
  $('ne-none').hidden = waiting.length > 0;
  $('not-e-waste').hidden = waiting.length === 0 || !may.record;
  $('own-brand').replaceChildren(...(declarations === null ? [] : declarations.length === 0 ? [text('li', t('noDeclarations'), 'row')] : declarations.map((d) => {
    const li = document.createElement('li');
    li.className = `row tone-${!d.ownBrand ? 'idle' : d.packaging.length === 0 ? 'error' : 'ok'}`;
    li.dataset.product = d.productId;
    const words = !d.ownBrand ? t('notOwnBrand') : d.packaging.length === 0 ? t('missing')
      : d.packaging.map((p) => `${p.category}: ${api.grams(p.weightPerUnitMg)} ${t('perUnit')}${p.description === undefined ? '' : ` (${p.description})`}`).join(' · ');
    li.append(text('span', d.productId, 'headline'), text('span', words, 'facts'));
    return li;
  })));
}

async function load() {
  const [ob, ra] = await Promise.all([session.ownBrand(), session.recyclersAndAssets()]);
  declarations = ob.result === 'ok' ? ob.value : null;
  if (ra.result === 'ok') { recyclers = ra.value.recyclers; waiting = ra.value.waitingAssets; }
  if (ob.result !== 'ok') { $('rec-state').hidden = false; $('rec-state').textContent = api.outcomeWords(lang(), ob); }
  paint();
}

async function done(out, okWords, form) {
  tell(out, okWords);
  if (out.result === 'ok') { form?.reset(); window.dispatchEvent(new Event('epr:changed')); await load(); }
}

function on(form, run) { $(form).addEventListener('submit', (e) => { e.preventDefault(); void run(); }); }

new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });

if (api !== null && may.named && may.read) {
  $('records').hidden = false;
  if (!may.record) {
    for (const f of document.querySelectorAll('#records .record-form')) f.hidden = true;
    $('rec-state').hidden = false; $('rec-state').textContent = t('cannotRecord');
  }
  $('confirm').hidden = !may.confirm;
  $('confirm-none').hidden = may.confirm;
  $('rc-which').addEventListener('change', () => {
    const r = recyclers.find((x) => x.recyclerId === $('rc-which').value);
    $('rc-name').value = r?.name ?? ''; $('rc-number').value = r?.registrationNumber ?? '';
  });
  on('confirm', async () => {
    const out = await session.confirmSetting($('cf-key').value, $('cf-value').value, $('cf-by').value);
    await done(out, `${t('saved')}: ${t($('cf-key').value)}`, $('confirm'));
  });
  on('declare', async () => {
    const lines = [1, 2].map((n) => ({ category: $(`ob-cat-${n}`).value, grams: $(`ob-g-${n}`).value, description: $(`ob-d-${n}`).value }));
    const product = $('ob-product').value.trim();
    const out = await session.declare({ productId: product, ownBrand: $('ob-own').value === 'yes', lines });
    await done(out, `${t('saved')}: ${product}${out.result === 'ok' && !out.value.packagingDeclared ? ` — ${t('missing')}` : ''}`, $('declare'));
  });
  on('recycler', async () => {
    const name = $('rc-name').value.trim();
    const out = await session.saveRecycler({ recyclerId: $('rc-which').value, name, registrationNumber: $('rc-number').value });
    await done(out, `${t('saved')}: ${name}${out.result === 'ok' && !out.value.registered ? ` (${t('noNumber')})` : ''}`, $('recycler'));
  });
  on('shop', async () => {
    const grams = $('sh-weight').value;
    const out = await session.shopHandover({ kind: $('sh-kind').value, recyclerId: $('sh-recycler').value, description: $('sh-what').value, weightGrams: grams, batteryType: $('sh-type').value, assetId: $('sh-asset').value, note: $('sh-note').value });
    await done(out, out.result === 'ok' ? `${t('saved')}: ${grams} g → ${out.value.registrationNumber}` : '', $('shop'));
  });
  on('count', async () => {
    const out = await session.countBin({ kind: $('ct-kind').value, batteryType: $('ct-type').value, countedGrams: $('ct-grams').value });
    await done(out, out.result === 'ok' ? (out.value.differs ? t('countDiffers') : t('countSame')) : '', $('count'));
  });
  on('not-e-waste', async () => {
    const asset = $('ne-asset').value;
    const out = await session.notEWaste(asset, $('ne-why').value);
    await done(out, `${t('saved')}: ${asset}`, $('not-e-waste'));
  });
  paint();
  void load();
}
