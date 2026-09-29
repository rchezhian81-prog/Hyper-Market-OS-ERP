import type { Page } from 'playwright-core';

/**
 * **Counts every interaction a person makes, so a spec row can be asserted against it (design system §1 rule 1, §9).**
 *
 * One tap, one scan or one typed field each cost exactly one. A scan is what a shop scanner does — it types the code
 * and presses Enter — so the count is what the spec's interaction table counts, not what a test happens to call.
 * Shared by the till, the customer app and the handhelds, so the same arithmetic holds every surface to the same bar.
 */
export class Tally {
  count = 0;
  constructor(private readonly page: Page) {}
  async tap(selector: string): Promise<void> { this.count += 1; await this.page.click(selector); }
  async type(selector: string, text: string): Promise<void> { this.count += 1; await this.page.fill(selector, text); }
  async scan(code: string): Promise<void> { this.count += 1; await this.page.keyboard.type(code); await this.page.keyboard.press('Enter'); }
  reset(): number { const n = this.count; this.count = 0; return n; }
}
