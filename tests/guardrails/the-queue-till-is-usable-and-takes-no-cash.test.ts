import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **The queue till (D04-FR-05), guarded.** A low-spec Android handheld held in one hand in a queue, a basket in the other
 * and a customer watching. These are the decisions that are easy to undo in a hurry and invisible in review:
 *
 *   • the same spine as the other handhelds: no prompt/confirm/alert, a banner that never fades, 56 px targets, Tamil for
 *     every word, no text box for scanning;
 *   • NO CASH on a handheld — the owner's decision (OB-372, 25 Oct 2026): the screen offers no cash button and never calls
 *     the cash tender, and the store computer's door refuses any tender but card and UPI, saying it is the owner's decision;
 *   • NO PRINTER on a handheld (OB-373): a paid sale's screen says "Ask at a till or the service desk to print this bill",
 *     with the bill number — the handheld never prints;
 *   • the price is the till's: the screen holds no price list and no rule of its own — it boots the till's own session;
 *   • the door is behind the device credential: the device socket hands `/queue-pos/` over only AFTER it authenticated the
 *     enrolled device, and the door's lane routes never include refunds, cash, approvals, holds or the day close.
 */

const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const APP = code(readFileSync('apps/queue-pos/web/app.js', 'utf8'));
const HTML = readFileSync('apps/queue-pos/web/index.html', 'utf8');
const SW = readFileSync('apps/queue-pos/web/sw.js', 'utf8');
const ENTRY = readFileSync('apps/queue-pos/src/browser-entry.ts', 'utf8');
const DOOR = readFileSync('edge/store-edge/src/queue-pos-door.ts', 'utf8');
const DEVICE = readFileSync('edge/store-edge/src/device-server.ts', 'utf8');

describe('the queue till keeps the handhelds\' spine', () => {
  it('uses no prompt, confirm or alert', () => {
    expect([...APP.matchAll(/\b(?:window\.)?(prompt|confirm|alert)\s*\(/g)].map((m) => m[1])).toEqual([]);
  });

  it('has a banner that does not disappear on a timer', () => {
    expect(HTML).toContain('id="banner"');
    expect(HTML).toMatch(/class="banner" id="banner" hidden role="alert"/);
    const from = APP.indexOf('function tell');
    const banner = APP.slice(from, APP.indexOf("el('banner-ok').addEventListener", from));
    expect(banner).not.toMatch(/setTimeout|setInterval/);
  });

  it('declares a touch target of at least 56px, and the money buttons are bigger', () => {
    const tap = /:root \{ --tap: (\d+)px; \}/.exec(HTML);
    expect(Number(tap?.[1])).toBeGreaterThanOrEqual(56);
    expect(HTML).toMatch(/footer \.primary, \.sheet \.primary \{[^}]*min-height: 64px/);
  });

  it('carries Tamil for every word, not a subset', () => {
    const block = (marker: string): string => APP.slice(APP.indexOf(marker), APP.indexOf('\n  },', APP.indexOf(marker)));
    const keysIn = (text: string): string[] => [...text.matchAll(/(?:^|[{,]\s*)(\w+):\s*'/g)].map((m) => m[1]!);
    const english = keysIn(block('en: {'));
    const tamil = new Set(keysIn(block('ta: {')));
    expect(english.length).toBeGreaterThan(40);
    for (const key of english) expect([...tamil], `"${key}" has no Tamil`).toContain(key);
  });

  it('has no text box for scanning — the scanner is a keyboard; the one text field is the card machine\'s approval number', () => {
    expect((HTML.match(/<input\b/g) ?? []).length).toBe(1);
    expect(HTML).toMatch(/<input class="entry-text" id="entry-text"/);
    expect(APP).toMatch(/window\.addEventListener\('keydown'/);
  });

  it('opens with no signal: the worker precaches the shell and the built bundle', () => {
    expect(SW).toMatch(/const SHELL = \['\.\/sre-foundation\.css', '\.\/sre-icons\.js', '\.\/sre-update\.js', '\.\/app\.js', '\.\/manifest\.webmanifest'\];/);
    expect(SW).toMatch(/const BUILT = \['\.\/queue-pos\.bundle\.js'\];/);
    expect(APP).toMatch(/navigator\.serviceWorker\.register\('\.\/sw\.js'\)/);
  });
});

describe('no cash on a handheld — the owner decided so (OB-372, 25 Oct 2026)', () => {
  it('the refusal says it is the owner\'s decision, in English and Tamil — never "not decided"', () => {
    expect(DOOR).toMatch(/A handheld takes card or UPI only — never cash \(the owner\\'s decision\)/);
    expect(DOOR).toMatch(/ரொக்கம் ஒருபோதும் இல்லை \(உரிமையாளரின் முடிவு\)/);
    expect(DOOR).not.toMatch(/not decided yet/);
  });

  it('the screen offers no cash button and never calls the cash tender', () => {
    expect(HTML).not.toMatch(/id="cash"/);
    expect(APP).not.toMatch(/tenderCash|tenderSplit|tenderPaidOnOldErp/);
    expect(APP).toMatch(/tenderCardOrUpi\(/);
  });

  it('the store computer refuses any tender but card and UPI, before anything is written', () => {
    expect(DOOR).toMatch(/export const HANDHELD_TENDERS: readonly string\[\] = Object\.freeze\(\['card', 'upi'\]\);/);
    expect(DOOR).toMatch(/if \(route === '\/lane\/sales' && \(b === null \|\| handheldTenderRefusal\(b\)\)\)/);
  });
});

describe('the price and the rules are the till\'s', () => {
  it('the screen holds no price and no rule: it boots the till\'s own session from the served pack', () => {
    expect(ENTRY).toMatch(/import \{ bootPos, serveLaneFrom \} from '\.\.\/\.\.\/pos\/src\/browser-entry';/);
    expect(ENTRY).toMatch(/catalogue: w\.posCatalogue/);
    expect(APP).not.toMatch(/unitPriceMinor\s*[*+]/);
  });
});

describe('the door is behind the device credential, and reaches only what a queue till needs', () => {
  it('the device socket hands /queue-pos/ to the door only after the enrolled device is authenticated', () => {
    const auth = DEVICE.indexOf('const auth = input.enrolments.authenticate(');
    const door = DEVICE.indexOf('input.queuePos?.owns(pathname)');
    expect(auth).toBeGreaterThan(-1);
    expect(door).toBeGreaterThan(auth);
    expect(DEVICE.slice(auth, door)).toMatch(/if \(!auth\.ok\) \{[\s\S]*return;\s*\}/);
  });

  it('a sign-in for selling, never a warehouse or picker one; its lane routes never include refunds, cash, approvals, holds or the close', () => {
    expect(DOOR).toMatch(/holder\.authority === TILL_AUTHORITY/);
    const routes = /QUEUE_POS_LANE_ROUTES[^=]*= Object\.freeze\(\{([\s\S]*?)\}\);/.exec(DOOR)?.[1] ?? '';
    expect(routes).not.toMatch(/returns|cash-movements|shift-close|approvals|held-bills|day-close|day-reopen|outbox|operator\/sign-in|loyalty|phone-baskets|queue-baskets/);
  });
});

describe('no printer on a handheld — the bill is printed at a till by its number (OB-373, 25 Oct 2026)', () => {
  it('the paid screen tells the colleague to ask at a till or the service desk, with the bill number, in English and Tamil', () => {
    expect(APP).toMatch(/printAtTill: 'Ask at a till or the service desk to print this bill: bill number \{number\}\. This handheld does not print\.'/);
    expect(APP).toMatch(/printAtTill: 'இந்த பில்லை அச்சிட ஏதேனும் பில்லிங் கவுண்டர் அல்லது சேவை மேசையில் கேளுங்கள்: பில் எண் \{number\}/);
    expect(APP).toMatch(/fill\(t\('printAtTill'\), \{ number: receiptNumber \}\)/);
  });
  it('the handheld never prints: no print call and no lane door to the bill copies', () => {
    expect(APP).not.toMatch(/window\.print|\.print\(\)/);
    expect(DOOR).not.toMatch(/bill-copies/);
  });
});
