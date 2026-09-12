import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

/**
 * WP5 — the public commercial site (marketing landing page + sign-in).
 *
 * A marketing page is where a product is most tempted to overstate itself. These checks keep the two
 * public pages honest about the three things that matter here: the prices shown are the ones actually
 * billed and are labelled as indicative launch pricing; the auto-debit story matches how billing
 * really works (UPI Autopay, RBI e-mandate, no card storage); and the sign-in page stays
 * credential-free — it delegates to the identity provider and never collects or stores a password
 * (hard rule #4).
 */

const landing = readFileSync('apps/site/web/index.html', 'utf8');
const login = readFileSync('apps/site/web/login.html', 'utf8');

describe('the landing page exists and describes the real product', () => {
  it('is a titled, standalone page', () => {
    expect(existsSync('apps/site/web/index.html')).toBe(true);
    expect(landing).toMatch(/<title>SRE Retail OS<\/title>/);
    expect(landing.trimStart().toLowerCase().startsWith('<!doctype html>')).toBe(true);
  });

  it('shows all three plans at the prices actually billed (PROPOSED_PLANS)', () => {
    for (const price of ['₹2,000', '₹5,000', '₹12,000']) {
      expect(landing, `the landing page must show ${price}`).toContain(price);
    }
    for (const name of ['Starter', 'Standard', 'Growth']) expect(landing).toContain(name);
  });

  it('labels the pricing as indicative launch pricing — not a fixed promise', () => {
    expect(landing).toMatch(/[Ll]aunch pricing/);
    expect(landing).toMatch(/indicative/);
  });

  it('tells the truth about how it works: offline, UPI Autopay, GST, and no card storage', () => {
    expect(landing).toMatch(/no internet|offline|dead router/i);
    expect(landing).toMatch(/UPI Autopay/);
    expect(landing).toMatch(/GST/);
    expect(landing).toMatch(/₹15,000/); // the RBI no-OTP ceiling, stated honestly
    expect(landing).toMatch(/never stored|never hold a card|only ever hold a reference/i);
  });

  it('sends visitors to sign in', () => {
    expect(landing).toContain('./login.html');
  });
});

describe('the sign-in page is credential-free (hard rule #4)', () => {
  it('exists and asks only for an email, delegating to the identity provider', () => {
    expect(existsSync('apps/site/web/login.html')).toBe(true);
    expect(login).toMatch(/<title>Sign in · SRE Retail OS<\/title>/);
    expect(login).toMatch(/type="email"/);
    expect(login).toMatch(/identity provider/i);
  });

  it('never collects or stores a password', () => {
    expect(login, 'the sign-in page must not have a password field').not.toMatch(/type="password"/);
    expect(login).toMatch(/never asks for or stores your password|no password is collected or stored/i);
  });

  it('does not fake a session — it says sign-in opens once the IdP is connected', () => {
    expect(login).toMatch(/will be available once your identity provider is connected/);
    // No pretend redirect into the app, no localStorage token — nothing that impersonates being signed in.
    expect(login).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
  });

  it('lets a visitor get back to the site', () => {
    expect(login).toContain('./index.html');
  });
});
