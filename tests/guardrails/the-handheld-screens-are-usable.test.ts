import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **The two screens used away from a desk, guarded.**
 *
 * A handheld in a cold aisle and a phone at a doorstep are the hardest places this product runs:
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
const ROUTE_MODEL = readFileSync('apps/delivery-app/src/route-session.ts', 'utf8');
const PICK_MODEL = readFileSync('apps/picker-app/src/pick-session.ts', 'utf8');

/** Comments discuss these on purpose, so only real code counts. */
const code = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const SHELLS = [
  { name: 'picker', app: PICKER, html: PICKER_HTML },
  { name: 'driver', app: DRIVER, html: DRIVER_HTML },
] as const;

describe('what both shells must hold, held by both', () => {
  for (const { name, app, html } of SHELLS) {
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
        const banner = code(app).slice(code(app).indexOf('function tell'), code(app).indexOf("el('banner-ok')"));
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
    });
  }
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
