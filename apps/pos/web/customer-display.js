// The customer display — the view (D04-FR-05 · M12-FR-01). Draws the frame the till sends over the BroadcastChannel
// (apps/pos/src/customer-display.ts builds it). Takes no input, sends nothing, holds nothing: a frame in, a picture out.
// The words follow the language the page was opened in (?lang=ta for Tamil).

const el = (id) => document.getElementById(id);
const lang = new URLSearchParams(window.location.search).get('lang') === 'ta' ? 'ta' : 'en';
document.documentElement.lang = lang;

const WORDS = {
  en: { title: 'Your bill', welcome: 'Welcome', toPay: 'To pay', saved: 'You saved', lane: 'Till' },
  ta: { title: 'உங்கள் பில்', welcome: 'வருக', toPay: 'செலுத்த வேண்டியது', saved: 'நீங்கள் சேமித்தது', lane: 'கல்லா' },
};
const t = (key) => WORDS[lang][key] ?? WORDS.en[key];
const money = (minor) => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function draw(frame) {
  el('title').textContent = t('title');
  el('lane').textContent = frame && frame.laneId ? `${t('lane')} ${frame.laneId}` : '';
  const showing = frame !== null && frame.state === 'basket';
  el('welcome').hidden = showing;
  el('welcome').textContent = t('welcome');
  el('bill').hidden = !showing;
  el('saved').hidden = !showing || !(frame.savedMinor > 0);
  el('pay').hidden = !showing;
  if (!showing) { el('lines').replaceChildren(); return; }
  el('lines').replaceChildren(...frame.lines.map((line) => {
    const row = document.createElement('tr');
    for (const [text, cls] of [[line.description, ''], [String(line.qty), 'amount'], [money(line.amountMinor), 'amount']]) {
      const cell = document.createElement('td'); cell.textContent = text; if (cls) cell.className = cls; row.append(cell);
    }
    return row;
  }));
  el('saved').textContent = `${t('saved')} ${money(frame.savedMinor)}`;
  el('pay-label').textContent = t('toPay');
  el('pay-amount').textContent = money(frame.payableMinor);
}

draw(null);
if (typeof BroadcastChannel === 'function') {
  const channel = new BroadcastChannel('sre-customer-display');
  channel.addEventListener('message', (event) => {
    const frame = event.data;
    if (frame && typeof frame === 'object' && Array.isArray(frame.lines)) draw(frame);
  });
}
