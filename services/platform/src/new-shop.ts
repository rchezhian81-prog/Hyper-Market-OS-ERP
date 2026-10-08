// A new shop, created on the server with ONE guided command (OB-15-d-2 · owner decision OB-20 "A" · M36-FR-01 ·
// ADR-0019 §4 · OB-19).
//
// The owner chose that creating a shop stays an act of a person at the server: no web page and no head-office account can
// create one. This is the command's plan — everything checked BEFORE anything is written:
//   • the shop's id, name, first owner and the person running it (the tested tenant-bootstrap rules: never on a
//     production box, never the demo shop, a real UUID, an owner, a named operator, known roles, nobody twice);
//   • the shop's own sign-in area (the tested realm file, OB-19: every value written in, no person, no secret);
// and only then: the shop recorded with its first owner (one atomic append), its name on the platform's record, its realm
// file written for the administrator to load. The next steps are printed, in order.

import { planTenantBootstrap, type TenantBootstrapPlan } from '../../../packages/migration/src/tenant-bootstrap';
import { shopRealmFile } from '../../identity/src/shop-realm-file';

export interface NewShopRequest {
  /** The shop's id (a UUID). */
  readonly tenantId: string;
  /** The shop's name, as people know it. */
  readonly name: string;
  /** Its first owner's id in the product. */
  readonly owner: string;
  /** Further initial administrators, as userId:roleId. */
  readonly admins: readonly { readonly userId: string; readonly roleId: string }[];
  /** Who is running the command — every shop carries the name of whoever created it. */
  readonly operator: string;
  /** The shop's realm: sre-<shop>. */
  readonly realm: string;
  /** The shop's screens' address. */
  readonly webOrigin: string;
  readonly audience: string;
  readonly allowHttp?: boolean;
  // What the box knows about itself.
  readonly targetKind: string | undefined;
  readonly demoTenantIds: readonly string[];
  readonly knownRoleIds: readonly string[];
  readonly ownerRoleId: string;
  /** The repository's realm (the parsed `realm-sre-store.json`). */
  readonly realmTemplate: Record<string, unknown>;
}

/** The shop's entry on the platform's own record: its name, realm and address, and who created it. */
export interface ShopRegistered {
  readonly tenantId: string;
  readonly name: string;
  readonly realm: string;
  readonly webOrigin: string;
  readonly createdBy: string;
  readonly at: string;
}

export type NewShopPlan =
  | {
    readonly ok: true;
    readonly bootstrap: Extract<TenantBootstrapPlan, { ok: true }>;
    readonly realmFile: Record<string, unknown>;
    readonly shop: Omit<ShopRegistered, 'at'>;
  }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Check everything a new shop needs; nothing is written by this. */
export function planNewShop(req: NewShopRequest): NewShopPlan {
  const problems: string[] = [];
  const name = req.name.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 80) problems.push('The shop\'s name must be 2 to 80 characters.');
  const bootstrap = planTenantBootstrap({
    tenantId: req.tenantId, owner: req.owner, admins: req.admins, targetKind: req.targetKind,
    demoTenantIds: req.demoTenantIds, knownRoleIds: req.knownRoleIds, operator: req.operator, ownerRoleId: req.ownerRoleId,
  });
  if (!bootstrap.ok) problems.push(`${bootstrap.detail} (${bootstrap.refusedBecause})`);
  const realm = shopRealmFile(req.realmTemplate, {
    realm: req.realm, tenantId: req.tenantId, displayName: name, webOrigin: req.webOrigin, audience: req.audience,
    ...(req.allowHttp === undefined ? {} : { allowHttp: req.allowHttp }),
  });
  if (!realm.ok) problems.push(...realm.problems.filter((p) => !/2 to 80/.test(p) && !/tenant id \(a UUID\)/.test(p)));
  if (problems.length > 0 || !bootstrap.ok || !realm.ok) return { ok: false, problems: problems.length > 0 ? problems : ['Not readable as a new shop.'] };
  return {
    ok: true,
    bootstrap,
    realmFile: realm.realm,
    shop: { tenantId: bootstrap.tenantId, name, realm: req.realm, webOrigin: req.webOrigin.replace(/\/+$/, ''), createdBy: bootstrap.operator },
  };
}

/** The steps after the command, in order, for the administrator. */
export function nextSteps(shop: Omit<ShopRegistered, 'at'>, owner: string, realmFilePath: string): readonly string[] {
  return [
    `Load the sign-in area: /auth/admin → the realm list (top left) → Create realm → Browse → ${realmFilePath} → Create.`,
    `Tell head office: in .env.pilot add  ${shop.realm}=${shop.tenantId}  to IDP_OIDC_SHOP_REALMS (comma-separated), then release.`,
    `Give the owner their sign-in, in their presence: realm ${shop.realm} → Users → Add user → their own name; Attributes → sre_user_id = ${owner}; Credentials → a temporary password; Role mapping → sre-privileged.`,
    `The shop's address (${shop.webOrigin}) and its front door come with the domain name.`,
  ];
}
