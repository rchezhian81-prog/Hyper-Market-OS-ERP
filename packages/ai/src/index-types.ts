// Shared identifiers, kept in one small module so `budget.ts` does not have to import the
// gateway (which would pull the simulator into the cost path) and `authority.ts` does not have
// to import the budget. Small file, deliberate.

export type { AgentId } from './authority';
export type { ModelTier } from './gateway';
