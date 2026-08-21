// API-01 Organisational hierarchy (M01-FR-01) — the skeleton every transaction, permission and report is
// scoped to: company → GST registration → branch/store → warehouse → department. Get it wrong and the
// symptoms appear everywhere at once (GST filed against the wrong registration, a manager seeing another
// branch's takings, a report double-counting a warehouse), so this cloud boundary validates the structure
// as a whole, on the SAME tested engine the setup screen uses (`packages/org/src/hierarchy`):
//
//   • a GSTIN is checksum-valid and UNIQUE — a duplicate is refused with the holder named (the second
//     entry is almost always a typo of the first);
//   • the parent/kind rules hold (a department cannot sit under a company, a company has no parent) and a
//     cross-tenant parent is a hard refusal, never a configuration option;
//   • an incomplete node is a legitimate DRAFT — it is recorded, and what would stop it ACTIVATING is
//     reported rather than refused; a branch cannot ACTIVATE without a company and a GST registration.
//
// Managing the structure is gated `platform.setup.write` (tenant onboarding, owner); reading it is
// `org.branch.read`. The rule is the pure engine (the `services-run-on-their-tested-engine` guardrail);
// this file is the persistence + HTTP skin, holding the append-only node/registration record.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  GstRegister, validateNode, canActivate, descendantsOf, ancestryOf, gstinFor,
  InvalidGstinError, DuplicateGstinError, HierarchyError,
  type OrgNode, type OrgNodeKind, type OrgNodeStatus, type GstRegistration,
} from '../../../packages/org/src/index';

export type { OrgNode, GstRegistration } from '../../../packages/org/src/index';

const KINDS: readonly OrgNodeKind[] = ['company', 'branch', 'warehouse', 'department'];
const STATUSES: readonly OrgNodeStatus[] = ['draft', 'active', 'suspended', 'closed'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export interface OrgStructureDeps {
  readonly nodes: (tenantId: string) => Promise<readonly OrgNode[]> | readonly OrgNode[];
  readonly registrations: (tenantId: string) => Promise<readonly GstRegistration[]> | readonly GstRegistration[];
  readonly recordNode: (tenantId: string, node: OrgNode) => Promise<void> | void;
  readonly recordRegistration: (tenantId: string, registration: GstRegistration) => Promise<void> | void;
  readonly now: () => string;
}

/** The node view a read returns — the node plus its computed scope and activation readiness. */
function nodeView(node: OrgNode, nodes: readonly OrgNode[], register: GstRegister) {
  let issues; let activatable;
  try {
    issues = validateNode(node, nodes, register);
    activatable = !issues.some((i) => i.severity === 'blocks_activation');
  } catch (err) {
    // A structural break in an already-stored node (e.g. its parent was closed) — surface it, don't throw.
    issues = [{ nodeId: node.nodeId, severity: 'blocks_activation' as const, message: err instanceof Error ? err.message : 'structural error' }];
    activatable = false;
  }
  return {
    node,
    issues,
    canActivate: activatable,
    ancestry: ancestryOf(node.nodeId, nodes).map((n) => n.nodeId),
    descendants: descendantsOf(node.nodeId, nodes).map((n) => n.nodeId),
    filedUnderGstin: gstinFor(node.nodeId, nodes) ?? null,
  };
}

export function orgStructureRoutes(deps: OrgStructureDeps): readonly Route[] {
  return [
    {
      // Register a GST registration. Body: { companyId, legalName }. The GSTIN (path) is checksum-validated
      // and refused if already held by another company (a duplicate is usually a typo of the first).
      api: 'API-01', method: 'POST', path: '/v1/org/gst-registrations/:gstin',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        const gstin = (ctx.params['gstin'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (gstin === '' || !isStr(b['companyId']) || !isStr(b['legalName'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_registration',
            whatHappened: 'A GST registration needs a GSTIN in the path and { companyId, legalName } in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the company it belongs to and its legal name.',
          });
        }
        const register = new GstRegister(await deps.registrations(ctx.tenantId));
        let stored: GstRegistration;
        try {
          stored = register.add({ gstin, companyId: b['companyId'] as string, stateCode: '', legalName: b['legalName'] as string });
        } catch (err) {
          if (err instanceof InvalidGstinError) {
            throw apiError(422, { code: 'gstin_invalid', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the GSTIN — the checksum catches a mistyped digit when it is entered, not at the first return.' });
          }
          if (err instanceof DuplicateGstinError) {
            throw apiError(409, { code: 'gstin_already_registered', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Use the existing registration, or correct the GSTIN if this was a typo of it.' });
          }
          throw err;
        }
        await deps.recordRegistration(ctx.tenantId, stored);
        return { status: 201, body: { gstin: stored.gstin, companyId: stored.companyId, stateCode: stored.stateCode } };
      },
    },
    {
      // Upsert an org node. Body: { kind, name, parentId?, companyId?, gstin?, status? }. A structural
      // violation (wrong parent kind, cross-tenant, unknown parent/company) is refused 422; an incomplete
      // node is recorded as a DRAFT with its activation blockers reported. Creating one already `active`
      // requires it to be activatable now.
      api: 'API-01', method: 'POST', path: '/v1/org/nodes/:nodeId',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        const nodeId = (ctx.params['nodeId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (nodeId === '' || typeof b['kind'] !== 'string' || !KINDS.includes(b['kind'] as OrgNodeKind) || !isStr(b['name'])
          || (b['parentId'] !== undefined && b['parentId'] !== null && typeof b['parentId'] !== 'string')
          || (b['status'] !== undefined && (typeof b['status'] !== 'string' || !STATUSES.includes(b['status'] as OrgNodeStatus)))) {
          throw apiError(400, {
            code: 'not_readable_as_an_org_node',
            whatHappened: `An org node needs a nodeId in the path and { kind (${KINDS.join('|')}), name, parentId?, companyId?, gstin?, status? } in the body.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the node kind, name and where it sits.',
          });
        }
        const node: OrgNode = {
          nodeId, tenantId: ctx.tenantId, kind: b['kind'] as OrgNodeKind, name: b['name'] as string,
          parentId: isStr(b['parentId']) ? b['parentId'] as string : null,
          status: (b['status'] as OrgNodeStatus | undefined) ?? 'draft',
          ...(isStr(b['companyId']) ? { companyId: b['companyId'] as string } : {}),
          ...(isStr(b['gstin']) ? { gstin: b['gstin'] as string } : {}),
        };
        const nodes = await deps.nodes(ctx.tenantId);
        const register = new GstRegister(await deps.registrations(ctx.tenantId));
        // Context = the other nodes (validateNode never self-references; excluding the prior version keeps it clean).
        const context = nodes.filter((n) => n.nodeId !== nodeId);
        let issues;
        try {
          issues = validateNode(node, context, register);
        } catch (err) {
          if (err instanceof HierarchyError) {
            throw apiError(422, { code: 'hierarchy_violation', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Fix where the node sits (its parent and kind) and try again. Nothing was recorded.' });
          }
          throw err;
        }
        if (node.status === 'active' && issues.some((i) => i.severity === 'blocks_activation')) {
          throw apiError(409, {
            code: 'cannot_activate',
            whatHappened: `${nodeId} cannot be created active: ${issues.filter((i) => i.severity === 'blocks_activation').map((i) => i.message).join('; ')}`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Record it as a draft, complete the missing details, then activate it.',
          });
        }
        await deps.recordNode(ctx.tenantId, node);
        return { status: 201, body: nodeView(node, [...context, node], register) };
      },
    },
    {
      // Activate a node — only when it meets every condition (a branch needs a company and a valid, own GST
      // registration). Blocked activation returns the reasons, never a half-activated branch.
      api: 'API-01', method: 'POST', path: '/v1/org/nodes/:nodeId/activation',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        const nodeId = (ctx.params['nodeId'] ?? '').trim();
        const nodes = await deps.nodes(ctx.tenantId);
        const node = nodes.find((n) => n.nodeId === nodeId);
        if (node === undefined) throw notFound(`org node ${nodeId}`);
        const register = new GstRegister(await deps.registrations(ctx.tenantId));
        const context = nodes.filter((n) => n.nodeId !== nodeId);
        let ready = false; let issues;
        try {
          issues = validateNode(node, context, register);
          ready = canActivate(node, context, register);
        } catch (err) {
          issues = [{ nodeId, severity: 'blocks_activation' as const, message: err instanceof Error ? err.message : 'structural error' }];
        }
        if (!ready) {
          throw apiError(409, {
            code: 'cannot_activate',
            whatHappened: `${nodeId} is not ready to activate: ${(issues ?? []).filter((i) => i.severity === 'blocks_activation').map((i) => i.message).join('; ')}`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Resolve the blockers above (a company and a valid GST registration for a branch), then activate.',
          });
        }
        const activated: OrgNode = { ...node, status: 'active' };
        await deps.recordNode(ctx.tenantId, activated);
        return { status: 200, body: nodeView(activated, [...context, activated], register) };
      },
    },
    {
      // Read one node — its validation issues, whether it may activate, and its scope (ancestry to the
      // company, descendants it covers, and the GSTIN a transaction here is filed under). 404 when unknown.
      api: 'API-01', method: 'GET', path: '/v1/org/nodes/:nodeId',
      permission: 'org.branch.read',
      handler: async (ctx) => {
        const nodeId = (ctx.params['nodeId'] ?? '').trim();
        const nodes = await deps.nodes(ctx.tenantId);
        const node = nodes.find((n) => n.nodeId === nodeId);
        if (node === undefined) throw notFound(`org node ${nodeId}`);
        const register = new GstRegister(await deps.registrations(ctx.tenantId));
        return { status: 200, body: nodeView(node, nodes, register) };
      },
    },
    {
      // The whole structure — every node and every GST registration.
      api: 'API-01', method: 'GET', path: '/v1/org/nodes',
      permission: 'org.branch.read',
      handler: async (ctx) => {
        const [nodes, registrations] = await Promise.all([
          Promise.resolve(deps.nodes(ctx.tenantId)),
          Promise.resolve(deps.registrations(ctx.tenantId)),
        ]);
        return { status: 200, body: { nodes, registrations, nodeCount: nodes.length } };
      },
    },
  ];
}
