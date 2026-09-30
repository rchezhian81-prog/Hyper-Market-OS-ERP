import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **The three screens used away from a desk, guarded.**
 *
 * A handheld in a cold aisle, a phone at a doorstep and a scanner up the racking are the hardest places this
 * product runs:
 * one hand, gloves, sunlight, no signal, and somebody waiting. Every decision below is easy to undo
 * in a hurry and invisible in review — a text box "just for the barcode", a tick box labelled
 * *customer confirmed*, a card option on the payment list because the form generator produced one.
 *
 * The two shells are checked together because they share a spine and must not drift apart: same
 * scanner discipline, same non-fading banner, same complete Tamil, same blind count. A rule that
 * held on the picker and quietly lapsed on the driver would be worse than one nobody wrote down.
 */

const PICKER = readFileSync('apps/picker-app/web/app.js', 'utf8');
const PICKER_HTML = readFileSync('apps/picker-app/web/index.html', 'utf8');
const DRIVER = readFileSync('apps/delivery-app/web/app.js', 'utf8');
const DRIVER_HTML = readFileSync('apps/delivery-app/web/index.html', 'utf8');
const WAREHOUSE = readFileSync('apps/warehouse-app/web/app.js', 'utf8');
const WAREHOUSE_HTML = readFileSync('apps/warehouse-app/web/index.html', 'utf8');
const ROUTE_MODEL = readFileSync('apps/delivery-app/src/route-session.ts', 'utf8');
const PICK_MODEL = readFileSync('apps/picker-app/src/pick-session.ts', 'utf8');

/** Comments discuss these on purpose, so only real code counts. */
const code = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

/** `banner` names the function that shows the non-fading banner in each shell. */
const SHELLS = [
  { name: 'picker', app: PICKER, html: PICKER_HTML, banner: 'function tell' },
  { name: 'driver', app: DRIVER, html: DRIVER_HTML, banner: 'function tell' },
  { name: 'warehouse', app: WAREHOUSE, html: WAREHOUSE_HTML, banner: 'function feltResult' },
] as const;

describe('what both shells must hold, held by both', () => {
  for (const { name, app, html, banner: bannerFn } of SHELLS) {
    describe(name, () => {
      it('uses no prompt, confirm or alert', () => {
        const found = [...code(app).matchAll(/\b(?:window\.)?(prompt|confirm|alert)\s*\(/g)].map((m) => m[1]);
        expect(found).toEqual([]);
      });

      it('has a banner that does not disappear on a timer', () => {
        // Standing at a doorstep or halfway down an aisle, a message that fades after four seconds
        // is a message that was missed.
        expect(html).toContain('id="banner"');
        expect(html).toContain('role="alert"');
        const from = code(app).indexOf(bannerFn);
        expect(from, `${bannerFn} is missing`).toBeGreaterThan(-1);
        const banner = code(app).slice(from, code(app).indexOf("el('banner-ok')", from));
        expect(banner).not.toMatch(/setTimeout|setInterval/);
      });

      it('declares a touch target of at least 56px — bigger than the till', () => {
        // Gloves, cold hands, sunlight, one hand on a crate or a gate. A mis-tap here is a wrong
        // item in somebody's crate or a wrong amount of cash.
        const tap = /--tap:\s*(\d+)px/.exec(html);
        expect(tap, 'the shell must declare a minimum touch target').not.toBeNull();
        expect(Number(tap![1])).toBeGreaterThanOrEqual(56);
      });

      it('carries Tamil for every word, not a subset', () => {
        const source = code(app);
        const block = (marker: string): string => {
          const from = source.indexOf(marker);
          expect(from, `the ${marker.slice(0, 2)} words are missing`).toBeGreaterThan(-1);
          return source.slice(from, source.indexOf('\n  },', from));
        };
        const keysIn = (text: string): string[] =>
          [...text.matchAll(/(?:^|[{,]\s*)(\w+):\s*'/g)].map((m) => m[1]!);

        const english = keysIn(block('en: {'));
        const tamil = new Set(keysIn(block('ta: {')));
        expect(english.length).toBeGreaterThan(30);
        for (const key of english) expect([...tamil], `"${key}" has no Tamil`).toContain(key);
      });

      it('announces sample work instead of passing it off as real', () => {
        expect(html).toContain('id="sample"');
        expect(code(app)).toMatch(/el\('sample'\)\.hidden = real !== undefined/);
      });

      it('says when the device could not save the work, rather than swallowing it', () => {
        // A picker whose scans are not being saved needs to know before the end of the wave.
        expect(html).toContain('id="storage"');
        expect(code(app)).toMatch(/StorageProblem/);
      });

      it('shows the unsent count in words as well as a dot', () => {
        expect(code(app)).toContain("t('allSent')");
        expect(code(app)).toContain("t('waiting')");
      });

      it('holds no money or pricing arithmetic of its own', () => {
        // The view converts and displays. A second copy of a rule here is one nobody tests.
        expect(code(app)).not.toMatch(/unitPrice\s*\*|taxBps|\*\s*1\.\d|marginMinor/);
      });

      // ── Stage G slice 4: what the browser audit found and fixed, held so it cannot come back ──

      it('keeps the language toggle at the shell’s own touch target — no 40px override survives', () => {
        expect(html).not.toMatch(/min-height:\s*40px/);
        expect(html).not.toMatch(/\.lang\s*\{/);
      });

      it('writes words on the readable red, never white on the signal red (3.8:1)', () => {
        expect(html).not.toMatch(/color:\s*#fff\b/i);
        expect(html).toMatch(/\.storage \{[^}]*var\(--danger-surface\)/);
        expect(html).toMatch(/\.banner \{[^}]*var\(--danger-surface\)/);
      });

      it('names its colours from the foundation’s tokens, not literals', () => {
        const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');
        const literals = [...style.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0]);
        expect(literals, 'literal colours in the page stylesheet').toEqual([]);
      });

      it('has exactly one h1 — the header line that says whose work this is (2.4.6)', () => {
        expect((html.match(/<h1\b/g) ?? []).length).toBe(1);
        expect(html).toMatch(/<h1 class="(wave|route|who)"/);
      });

      it('carries the sync badge: this device’s unsent count AND the store computer’s state, in words (rule 4)', () => {
        expect(html).toContain('id="box-text"');
        for (const key of ['noBoxLink', 'checkingBox', 'boxNotAnswering', 'boxOnline', 'noCloud', 'cloudNotSetUp', 'cloudUnknown', 'lastContact']) {
          expect(code(app), `${key} is not shown`).toContain(`t('${key}')`);
        }
        // Never a guessed address: with no store computer named, it says so.
        expect(code(app)).toMatch(/typeof window\.laneWriteBase === 'string' \? window\.laneWriteBase : null/);
        expect(code(app)).not.toMatch(/127\.0\.0\.1|localhost/);
        // Read-only, bounded, and never able to stall the screen.
        expect(code(app)).toMatch(/fetch\(`\$\{base\}\/lane\/sync-status`, \{ cache: 'no-store', signal: ctl\.signal \}\)/);
        expect(code(app)).toMatch(/setTimeout\(\(\) => ctl\.abort\(\), 3000\)/);
      });
    });
  }
});

describe('a scanner’s Enter is never a person’s Enter', () => {
  it('is swallowed before the browser can press the focused button — the flow must not run twice', () => {
    // Found by the browser audit: after "Receive a delivery" the scanner's Enter also clicked the button the
    // worker had just tapped, and the panel silently asked for the next scan after every received item.
    for (const [name, app] of [['picker', PICKER], ['warehouse', WAREHOUSE]] as const) {
      const handler = code(app).slice(code(app).indexOf("window.addEventListener('keydown'"));
      const enter = handler.slice(handler.indexOf("if (event.key === 'Enter')"), handler.indexOf('return;\n  }'));
      expect(enter, `${name}: the scanner's Enter must be preventDefault-ed`).toContain('event.preventDefault()');
    }
  });
});

describe('the picker’s three steps start at the bin, as the spec says (picker-packer.md)', () => {
  it('a bin label scanned from the list IS step 1 — the scan chooses the line', () => {
    // "pick a line (≤3: scan bin → scan item → confirm)" begins with a scan, not a tap. Counted in the browser
    // by the-handhelds-meet-the-spec.e2e.ts: 3.
    const handler = code(PICKER).slice(code(PICKER).indexOf("window.addEventListener('keydown'"));
    expect(handler).toMatch(/l\.state === 'pending' && \(l\.bin === code \|\| l\.shelf === code\)/);
    expect(handler).toMatch(/void startLine\(line, code\)/);
    expect(code(PICKER)).toMatch(/async function startLine\(line, binCode = null\)/);
  });

  it('offers Substitute and Problem on the item panel — the shelf is where a shortage is found', () => {
    // record a substitution = Substitute → scan the swap → scan the customer's reference (3);
    // flag a quality fail = Problem → the reason (2). Both counted in the browser.
    expect(PICKER_HTML).toContain('id="scan-substitute"');
    expect(PICKER_HTML).toContain('id="scan-problem"');
    const start = code(PICKER).slice(code(PICKER).indexOf('async function startLine'));
    expect(start).toMatch(/awaitScan\(`\$\{t\('scanTheItem'\)\} — \$\{line\.description\}`, t\('pointAndPull'\), true\)/);
    expect(start).toContain('if (itemCode === SUBSTITUTE)');
    expect(start).toContain('if (itemCode === PROBLEM)');
    // Not on the bin panel: nothing has been found short before the picker reaches the shelf.
    expect(start).toMatch(/awaitScan\(`\$\{t\('scanTheBin'\)\} — \$\{line\.bin\}`, t\('pointAndPull'\)\)/);
  });

  it('a green banner yields to the next scan; a red one must be read first (rule 5)', () => {
    const handler = code(PICKER).slice(code(PICKER).indexOf("window.addEventListener('keydown'"));
    expect(handler).toMatch(/if \(!banner\.classList\.contains\('good'\)\) return; banner\.hidden = true;/);
  });
});

describe('the warehouse pick starts at the bin the pick list names, as the spec says (inventory-warehouse.md · W1)', () => {
  it('a bin label scanned from the list IS step 1 — the scan chooses the line that names that bin', () => {
    // "pick a line (≤3): scan bin → scan item → confirm" begins with a scan, not a tap — the same rule as the picker.
    // Counted in the browser by the-handhelds-meet-the-spec.e2e.ts: 3.
    const handler = code(WAREHOUSE).slice(code(WAREHOUSE).indexOf("window.addEventListener('keydown'"));
    expect(handler).toMatch(/real\.pickLines\(\)\.find\(\(l\) => l\.binId === code\)/);
    expect(handler).toMatch(/void startPick\(line, code\)/);
    expect(code(WAREHOUSE)).toMatch(/async function startPick\(line, binCode = null\)/);
    // Only when nothing else is asking for a scan — a bin scanned INTO the put-away panel is the put-away's bin.
    expect(handler).toMatch(/if \(scanResolve !== null\) \{[\s\S]*?resolve\(code\);\s*return;/);
  });

  it('asks for the bin, then the item, then a confirm — and the MODEL checks each scan before the next is asked for', () => {
    const start = code(WAREHOUSE).slice(code(WAREHOUSE).indexOf('async function startPick'), code(WAREHOUSE).indexOf("el('pick').addEventListener"));
    const bin = start.indexOf("t('scanPickBin')");
    const item = start.indexOf("t('scanItem')");
    const confirm = start.indexOf('awaitConfirm(');
    expect(bin, 'the bin scan is missing').toBeGreaterThan(-1);
    expect(item, 'the item scan is missing').toBeGreaterThan(-1);
    expect(confirm, 'the confirm step is missing').toBeGreaterThan(-1);
    expect(bin).toBeLessThan(item);
    expect(item).toBeLessThan(confirm);
    // A wrong bin is refused at the racking and a wrong item at the shelf — by the tested session, never the view.
    expect(start).toMatch(/real\.checkPick\(\{ lineId: line\.lineId, scannedBinId: bin \}\)/);
    expect(start).toMatch(/real\.checkPick\(\{ lineId: line\.lineId, scannedBinId: bin, scannedItem: item \}\)/);
    expect(start).toMatch(/real\.pick\(\{/);
    expect(start).not.toMatch(/binId ===|productId ===/); // no re-deciding in the view
  });

  it('confirms the model’s remaining quantity with one tap and no typed number', () => {
    // A pick of fewer than the line wants is a short pick and the supervisor's call on the ERP, not a number a
    // worker adjusts up a ladder. So the confirm step shows the model's figure and offers Confirm or Cancel.
    expect(WAREHOUSE_HTML).toContain('id="confirm"');
    expect(WAREHOUSE_HTML).toContain('id="confirm-ok"');
    expect(WAREHOUSE_HTML).toContain('id="confirm-cancel"');
    expect(WAREHOUSE_HTML).not.toMatch(/<input/i);
    const confirm = code(WAREHOUSE).slice(code(WAREHOUSE).indexOf('function awaitConfirm'), code(WAREHOUSE).indexOf('function settleConfirm'));
    expect(confirm).toMatch(/line\.remainingMinor/);
    expect(confirm).not.toMatch(/quantityMinor\s*[-+*]/);
  });

  it('spells out which of the three steps comes next, and names every pick outcome in both languages', () => {
    for (const key of ['stepPick', 'stepPickScanBin', 'stepScanItem', 'stepConfirm']) expect(code(WAREHOUSE)).toContain(`t('${key}')`);
    // The pick outcomes join the session's FEEDBACK_CODES, which the-warehouse-screen-speaks-both-languages binds to
    // the words; this pins the five here so the two guardrails cannot drift apart.
    const en = WAREHOUSE.slice(WAREHOUSE.indexOf('  en: {'), WAREHOUSE.indexOf('  ta: {'));
    const ta = WAREHOUSE.slice(WAREHOUSE.indexOf('  ta: {'));
    for (const c of ['picked', 'wrong_bin', 'wrong_item', 'not_on_pick_list', 'line_done']) {
      expect(en, `English missing ${c}`).toMatch(new RegExp(`\\b${c}:`));
      expect(ta, `Tamil missing ${c}`).toMatch(new RegExp(`\\b${c}:`));
    }
  });

  it('shows the pick list with the BIN as the biggest thing on the row — the bin is where the worker walks to', () => {
    expect(WAREHOUSE_HTML).toContain('id="pick-lines"');
    expect(WAREHOUSE_HTML).toMatch(/\.item \.where \{[^}]*font-size: 22px/);
    const render = code(WAREHOUSE).slice(code(WAREHOUSE).indexOf('function render'), code(WAREHOUSE).indexOf("el('receive').addEventListener"));
    expect(render).toMatch(/where\.textContent = line\.binId/);
    // The Pick button exists only while there is pick work; the bin scan from the list needs it not at all.
    expect(render).toMatch(/el\('pick'\)\.hidden = lines\.length === 0/);
  });
});

describe('the driver’s buttons act on the stop the driver is at (delivery.md)', () => {
  it('selects the first unfinished stop on the driver’s behalf, and keeps a stop they chose until it is finished', () => {
    // capture proof ≤3 · record COD ≤3 · mark failed with reason ≤3 are counted from the doorstep, so a tap to
    // say "this one" on every stop would spend a third of the budget on the obvious.
    expect(code(DRIVER)).toMatch(/const TERMINAL = new Set\(\['delivered', 'partially_delivered', 'returned_to_origin', 'failed'\]\)/);
    expect(code(DRIVER)).toMatch(/function currentStop\(\)/);
    expect(code(DRIVER)).toMatch(/if \(chosen === null \|\| TERMINAL\.has\(chosen\.state\)\) selectedStopId = currentStop\(\)\?\.stopId \?\? null;/);
  });

  it('counts notes with buttons at the phone’s full touch target', () => {
    expect(DRIVER_HTML).toMatch(/\.denom button \{[^}]*min-height: var\(--tap\)/);
  });
});

describe('every pick is a scan, and the screen makes that structural', () => {
  it('offers no text input anywhere in the picker shell', () => {
    // The rule is scan bin → scan item → confirm. The only way that survives a busy afternoon is
    // if there is nothing to type into — a picker who can type a product code will, when the
    // scanner will not read a crushed label.
    expect(PICKER_HTML).not.toMatch(/<input/i);
    expect(PICKER_HTML).not.toMatch(/<textarea/i);
  });

  it('collects scans globally rather than from a focused field', () => {
    // A shop scanner is a keyboard that types fast and presses Enter. With a focused input, losing
    // focus sends a scan into whatever was last tapped — on a handheld, a quantity field.
    expect(code(PICKER)).toMatch(/window\.addEventListener\('keydown'/);
    expect(code(PICKER)).toContain('scanBuffer');
  });

  it('ignores a person pressing Enter', () => {
    expect(code(PICKER)).toMatch(/code\.length < \d+/);
  });

  it('asks for the bin and the item as separate scans, in that order', () => {
    const start = code(PICKER).slice(code(PICKER).indexOf('async function startLine'));
    const bin = start.indexOf("t('scanTheBin')");
    const item = start.indexOf("t('scanTheItem')");
    expect(bin, 'the bin scan is missing').toBeGreaterThan(-1);
    expect(item, 'the item scan is missing').toBeGreaterThan(-1);
    expect(bin).toBeLessThan(item);
  });

  it('spells out which of the three steps comes next', () => {
    // A handheld user should never have to work out where they are in a sequence.
    expect(code(PICKER)).toContain("t('stepBin')");
    expect(code(PICKER)).toContain("t('stepItem')");
    expect(code(PICKER)).toContain("t('stepQty')");
  });
});

describe('a substitution is the customer’s decision, not the picker’s', () => {
  it('has no tick box for "customer confirmed" anywhere', () => {
    // A checkbox is one a picker with eleven lines left taps in half a second. It is true in the
    // type system and unverifiable in the aisle.
    expect(PICKER_HTML).not.toMatch(/type=["']checkbox/i);
    expect(code(PICKER)).not.toMatch(/customerConfirmed\s*[:=]\s*true/);
  });

  it('asks for the customer’s approval REFERENCE, scanned rather than typed', () => {
    expect(code(PICKER)).toContain("t('customerRef')");
    expect(code(PICKER)).toMatch(/awaitScan\(t\('customerRef'\)/);
  });

  it('says what to do instead when the reference cannot be got', () => {
    // The honest alternative has to be one tap away, or the control gets worked around.
    expect(code(PICKER)).toContain("t('substituteNeedsCustomer')");
    const words = code(PICKER).slice(code(PICKER).indexOf('substituteNeedsCustomer:'));
    expect(words.slice(0, 300)).toMatch(/mark the item unavailable/i);
  });

  it('is enforced by the MODEL, not only asked for by the screen', () => {
    expect(PICK_MODEL).toMatch(/SubstitutionEvidenceRequiredError/);
    expect(PICK_MODEL).toMatch(/approvalRef\.trim\(\) === ''/);
  });
});

describe('the crate matches what was packed', () => {
  it('says how many lines are left rather than "cannot pack"', () => {
    // The same rule the manager's day close follows: a refusal without a list is not actionable.
    expect(code(PICKER)).toContain("t('packBlocked')");
    expect(code(PICKER)).toMatch(/progress\.pending/);
  });

  it('captures the cold-chain temperature and the tamper seal at packing', () => {
    expect(code(PICKER)).toContain("t('packTemp')");
    expect(code(PICKER)).toMatch(/tamperSealRef/);
  });

  it('never builds a manifest of its own — it asks the model for one', () => {
    // It is derived from what was picked, in the model. A view that assembled one could produce a
    // manifest that disagrees with the crate, which is the one thing it exists not to do.
    //
    // Scoped to the pack handler rather than the whole file: the stand-in further up deliberately
    // mimics the model's shape so the shell is runnable before a wave is assigned, and a check
    // blunt enough to catch that would be one nobody could keep green honestly.
    const handler = code(PICKER).slice(code(PICKER).indexOf("el('pack').addEventListener"));
    expect(handler).toMatch(/session\.pack\(/);
    expect(handler).not.toMatch(/\.filter\(|\.reduce\(|totalValue\s*=/);
  });
});

describe('nothing is delivered without proof, and card is never offered', () => {
  it('asks for proof before it asks for anything else', () => {
    const deliver = code(DRIVER).slice(code(DRIVER).indexOf("el('deliver').addEventListener"));
    const proof = deliver.indexOf("t('howProved')");
    const paid = deliver.indexOf("t('howPaid')");
    expect(proof).toBeGreaterThan(-1);
    expect(paid).toBeGreaterThan(-1);
    expect(proof, 'proof must be asked for first').toBeLessThan(paid);
  });

  it('offers only cash and UPI — card is not on the list at all', () => {
    // COD is cash/UPI (hard rule #3). A method the screen cannot offer is a refusal a driver can
    // never walk into with a customer waiting.
    const methods = code(DRIVER).slice(code(DRIVER).indexOf('const PAY_METHODS'), code(DRIVER).indexOf('const DENOMS'));
    expect(methods).toContain("method: 'cash'");
    expect(methods).toContain("method: 'upi'");
    expect(methods).not.toMatch(/card|visa|mastercard|rupay/i);
  });

  it('stores or shows no card number, CVV or expiry anywhere (hard rule #3)', () => {
    expect(code(DRIVER)).not.toMatch(/\bcvv\b|cardNumber|card_number|expiry|\bpan\b/i);
  });

  it('turns the model’s refusal into an instruction, not an error code', () => {
    expect(code(DRIVER)).toMatch(/ProofRequiredError/);
    expect(code(DRIVER)).toContain("t('noProof')");
  });

  it('tells the driver as they type whether they are short or over', () => {
    // Fine if it is what happened. Not fine if the driver did not notice which one they recorded.
    expect(code(DRIVER)).toContain("t('collectedLess')");
    expect(code(DRIVER)).toContain("t('collectedMore')");
  });
});

describe('a failed delivery is routed, never just left', () => {
  it('offers preset reasons rather than free text', () => {
    expect(code(DRIVER)).toContain('FAILURE_REASONS');
    expect(DRIVER_HTML).not.toMatch(/<input[^>]*reason/i);
  });

  it('asks what happens to the goods next', () => {
    // The order and the goods are in different places until this is answered.
    expect(code(DRIVER)).toContain("t('thenWhat')");
    expect(code(DRIVER)).toMatch(/session\.reattempt/);
    expect(code(DRIVER)).toMatch(/session\.returnToOrigin/);
  });

  it('surfaces a contribution-rule flag rather than burying it (D09)', () => {
    expect(DRIVER_HTML).toContain('id="flagged"');
    expect(code(DRIVER)).toMatch(/session\.contributionFlags\(\)/);
  });
});

describe('the driver’s cash is counted blind', () => {
  it('puts no expected figure on the counting panel', () => {
    // Shown "you should have ₹6,000", people hand over ₹6,000 and count nothing. Same control as
    // the till drawer and the stock count, and worth being structural in all three.
    const panel = DRIVER_HTML.slice(DRIVER_HTML.indexOf('id="count"'), DRIVER_HTML.indexOf('id="banner"'));
    expect(panel).not.toMatch(/expected|should be|target|recorded/i);

    const counting = code(DRIVER).slice(code(DRIVER).indexOf('function countCash'), code(DRIVER).indexOf("el('count-cancel')"));
    expect(counting).not.toMatch(/expected|codHeld|recorded/i);
  });

  it('reads the recorded figure only from the RESULT, after a count was given', () => {
    expect(code(DRIVER)).toMatch(/result\.varianceMinor/);
    expect(code(DRIVER)).not.toMatch(/session\.(?:expected|recorded)\w*\(/);
  });

  it('counts by denomination rather than asking for one typed total', () => {
    expect(code(DRIVER)).toContain('DENOMS');
    expect(DRIVER_HTML).toContain('id="denoms"');
  });

  it('tells the driver what to DO about a material difference', () => {
    // "Short ₹2,400" is a fact. "Do not hand the money over until somebody from the office is
    // with you" is an instruction, and at the end of a shift only one of those gets acted on.
    expect(code(DRIVER)).toContain("t('materialVariance')");
    const words = code(DRIVER).slice(code(DRIVER).indexOf('materialVariance:'));
    expect(words.slice(0, 300)).toMatch(/do not hand the money over/i);
  });

  it('is structural in the model too — no method returns the expected cash', () => {
    expect(ROUTE_MODEL).not.toMatch(/^\s*expected\w*\s*\(/m);
    expect(ROUTE_MODEL).toMatch(/recordedMinor/);
  });
});

describe('what leaves the device is thin', () => {
  it('queues the proof KIND and never the photograph', () => {
    // A route's worth of doorstep photographs on a sync queue is a privacy problem being uploaded.
    expect(ROUTE_MODEL).toMatch(/proofKind: next\.proof\?\.kind/);
    expect(ROUTE_MODEL).not.toMatch(/proof: next\.proof,\s*$/m);
  });

  it('carries an order reference and no customer identity (§31)', () => {
    for (const model of [ROUTE_MODEL, PICK_MODEL]) {
      const payloads = [...model.matchAll(/payload: \{[\s\S]*?\},/g)].map((m) => m[0]).join('\n');
      expect(payloads).toMatch(/orderRef/);
      expect(payloads).not.toMatch(/customerName|customerPhone|\bemail\b|\baddress\b/i);
    }
  });
});
