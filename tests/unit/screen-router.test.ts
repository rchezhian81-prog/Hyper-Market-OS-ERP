import { describe, it, expect } from 'vitest';
import { redirectFor, routeOf, screenOfPath, SCREEN_ALIASES } from '../../edge/store-edge/src/screen-server';
import { SCREENS } from '../../edge/store-edge/src/screen-data';

// The store box's screen router (P-07). The ERP menu carries "Products", "Pricing" and "Promotions" as
// three items, but there is ONE built + browser-verified "Products and prices" screen (`catalogue`,
// M03/M05) with items/price/promo tabs. Rather than a dead link the box would 404, each menu item
// REDIRECTS to that screen on the right tab. This proves the redirects, and that they never loop.

describe('menu-alias redirects open the catalogue screen on the right tab (M05 · P-07)', () => {
  it('Pricing and Promotions open the catalogue screen on their tab; Products opens the item list', () => {
    expect(redirectFor('/pricing')).toBe('/catalogue/?tab=price');
    expect(redirectFor('/promotions')).toBe('/catalogue/?tab=promo');
    expect(redirectFor('/products')).toBe('/catalogue/');
  });

  it('the trailing-slash form lands in the same place (no redirect loop)', () => {
    expect(redirectFor('/pricing/')).toBe('/catalogue/?tab=price');
    expect(redirectFor('/promotions/')).toBe('/catalogue/?tab=promo');
  });

  it('the redirect TARGET does not itself redirect — the loop stops at the catalogue screen', () => {
    // /catalogue/?tab=price is already the slashed, real screen: no further redirect.
    expect(redirectFor('/catalogue/?tab=price')).toBeNull();
    expect(redirectFor('/catalogue/')).toBeNull();
  });

  it('a real screen without its slash still gets the ordinary trailing-slash redirect (unchanged)', () => {
    expect(redirectFor('/catalogue')).toBe('/catalogue/');
  });

  it('the redirect target resolves to the catalogue screen and its shell file', () => {
    const route = routeOf('/catalogue/?tab=price');
    expect(route).not.toBeNull();
    expect(route!.screen).toBe('catalogue');
    expect(route!.file).toBe('catalogue.html');
  });

  it('an alias is not itself a served screen — the box only reaches it via the redirect', () => {
    // routeOf refuses /pricing directly (it is not in SCREENS); redirectFor is what carries it to catalogue.
    expect(routeOf('/pricing')).toBeNull();
    expect(routeOf('/promotions')).toBeNull();
    // And no alias name shadows a real screen.
    for (const name of Object.keys(SCREEN_ALIASES)) {
      expect((SCREENS as readonly string[]).includes(name), `${name} both an alias and a real screen`).toBe(false);
    }
  });
});

describe('the menu resolves each of its paths to the screen it opens on this box (Stage G slice 5b)', () => {
  it('a bare route, a slashed route and a tab deep-link all name their screen', () => {
    expect(screenOfPath('/counts')).toBe('counts');
    expect(screenOfPath('/counts/')).toBe('counts');
    expect(screenOfPath('/manager/?tab=approvals')).toBe('manager');
    expect(screenOfPath('/admin/?tab=people')).toBe('admin');
  });

  it('an alias names the screen it redirects to', () => {
    expect(screenOfPath('/pricing')).toBe('catalogue');
    expect(screenOfPath('/products')).toBe('catalogue');
  });

  it('a path this box does not serve names nothing — never a guessed screen', () => {
    expect(screenOfPath('/payroll')).toBeNull();
    expect(screenOfPath('/admin/users')).toBeNull();
    expect(screenOfPath('/')).toBeNull();
  });
});
