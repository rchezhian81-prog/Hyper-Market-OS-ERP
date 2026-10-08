// Which shops' realms head office believes (OB-15-d · OB-19 "A" · ADR-0019 §4 · M36-FR-01 · ADR-0003 hard isolation).
//
// Each shop has its own realm at the identity server, made from the repository's realm by the administrator (owner
// decision OB-19: head office never holds a key that can create realms). Head office is told, in its settings, which
// realms there are and which ONE shop each signs for; a sign-in from a realm naming any other shop is refused.
//
//   IDP_OIDC_ISSUER       the first shop's realm, as people reach it   (https://<address>/auth/realms/sre-store)
//   IDP_OIDC_JWKS_URL     its keys on the private network              (http://idp:8080/auth/realms/sre-store/…/certs)
//   IDP_OIDC_TENANT_ID    the shop that first realm signs for          (its tenant id)
//   IDP_OIDC_SHOP_REALMS  every further shop: realm=tenant, comma-separated (sre-anna-nagar=<tenant id>,…)
//
// A further shop's issuer and keys are the first realm's, with only the realm's name changed — the same identity server.

export interface ShopRealm {
  readonly realm: string;
  /** The one shop this realm signs for. */
  readonly tenantId: string | undefined;
  /** Its issuer, exactly as its tokens say. */
  readonly issuer: string;
  /** Its public keys, on the private network. */
  readonly jwksUrl: string;
}

const REALM_NAME = /^[a-z0-9][a-z0-9-]{1,40}$/;
const TENANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The realm named in an issuer or key-set address (…/realms/<realm>…), or undefined. */
export function realmOf(address: string): string | undefined {
  return /\/realms\/([^/?#]+)/.exec(address)?.[1];
}

/** The same address for another realm of the same identity server. */
function forRealm(address: string, from: string, to: string): string {
  return address.replace(`/realms/${from}`, `/realms/${to}`);
}

/** Read the settings. `problems` lists, in the operator's words, everything that stops head office starting. */
export function shopRealmsFrom(env: Readonly<Record<string, string | undefined>>): { readonly realms: readonly ShopRealm[]; readonly problems: readonly string[] } {
  const issuer = env['IDP_OIDC_ISSUER']?.trim();
  const jwks = env['IDP_OIDC_JWKS_URL']?.trim();
  const pin = env['IDP_OIDC_TENANT_ID']?.trim() || undefined;
  const more = env['IDP_OIDC_SHOP_REALMS']?.trim() || undefined;
  if (issuer === undefined || issuer === '' || jwks === undefined || jwks === '') {
    return {
      realms: [],
      problems: [
        ...(pin !== undefined ? ['IDP_OIDC_TENANT_ID is set without the identity server (IDP_OIDC_ISSUER, IDP_OIDC_JWKS_URL).'] : []),
        ...(more !== undefined ? ['IDP_OIDC_SHOP_REALMS is set without the identity server (IDP_OIDC_ISSUER, IDP_OIDC_JWKS_URL).'] : []),
      ],
    };
  }
  const problems: string[] = [];
  const first = realmOf(issuer);
  if (first === undefined || realmOf(jwks) !== first) {
    problems.push('IDP_OIDC_ISSUER and IDP_OIDC_JWKS_URL must name the same realm (…/realms/<realm>…).');
    return { realms: [], problems };
  }
  if (pin !== undefined && !TENANT.test(pin)) problems.push('IDP_OIDC_TENANT_ID must be a tenant id (a UUID).');
  const realms: ShopRealm[] = [{ realm: first, tenantId: pin, issuer, jwksUrl: jwks }];
  if (more !== undefined) {
    // Every realm must be pinned to its shop once there is more than one — otherwise one shop's realm could sign for another.
    if (pin === undefined) problems.push('IDP_OIDC_SHOP_REALMS needs IDP_OIDC_TENANT_ID: with more than one shop, every realm is pinned to its own shop.');
    for (const entry of more.split(',').map((e) => e.trim()).filter((e) => e !== '')) {
      const [realm = '', tenantId = ''] = entry.split('=').map((x) => x.trim());
      if (!REALM_NAME.test(realm) || !TENANT.test(tenantId)) {
        problems.push(`IDP_OIDC_SHOP_REALMS entry "${entry}" is not realm=tenant (a realm name of a–z, 0–9 and hyphens; a tenant UUID).`);
        continue;
      }
      realms.push({ realm, tenantId, issuer: forRealm(issuer, first, realm), jwksUrl: forRealm(jwks, first, realm) });
    }
  }
  const seenRealm = new Set<string>();
  const seenTenant = new Set<string>();
  for (const r of realms) {
    if (seenRealm.has(r.realm)) problems.push(`The realm "${r.realm}" is named twice.`);
    if (r.tenantId !== undefined && seenTenant.has(r.tenantId)) problems.push(`The shop ${r.tenantId} is given two realms — one shop, one realm.`);
    seenRealm.add(r.realm);
    if (r.tenantId !== undefined) seenTenant.add(r.tenantId);
  }
  return { realms, problems };
}
