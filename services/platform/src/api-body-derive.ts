// API-11 Platform — DERIVES every route's request and reply body schema, and every domain event's payload schema, from the
// code itself (M32-FR-01 · D14-FR-06 · §30.1 "OpenAPI/AsyncAPI or equivalent machine-readable contract" · P-06).
//
// One source of truth: the handlers. Nothing here is a hand-written copy of a body. The TypeScript compiler reads the
// sources the head-office API is built from (everything `services/api/src/main.ts` imports), finds every route object
// (`{ api, method, path, permission, handler }`) and pairs it with the route the running table serves. Then:
//   • the REPLY schema, per status, is the type the handler's own code returns, turned into JSON Schema;
//   • the REQUEST schema is what the handler reads from `ctx.body`: every property it reads — following the body into
//     the helper functions it is handed to — typed by the narrowing the handler's own checks apply (a `typeof x ===
//     'string'` makes it a string) or by the type the code declares for it, and REQUIRED exactly where the handler REFUSES
//     (400 or 422) a body that leaves the property out. "Refuses" is found by running the handler's own checks
//     symbolically with that property missing and everything else assumed fine (`RefusalProbe` below);
//   • an EVENT's payload schema is the type of the `payload` the code builds the event with, wherever it builds one.
// tests/guardrails/the-openapi-and-asyncapi-documents-equal-the-router.test.ts derives all of this again on every run and
// refuses committed documents that differ, or a route or event whose body cannot be derived. A property the handler reads
// but never checks or types is said so (`x-unchecked`), never invented. Build-time only: nothing at run time imports this
// (it needs the compiler).

import ts from 'typescript';
import { relative } from 'node:path';

export type Json = string | number | boolean | null | readonly Json[] | { readonly [k: string]: Json };
type Obj = Record<string, Json>;

/** A marker key on a schema the code does not type (an `unknown` / `any` value). */
export const UNTYPED = 'x-untyped';
/** A marker on a request property the handler reads but never checks: it passes it on as given. */
export const UNCHECKED = 'x-unchecked';

export interface DerivedRoute {
  /** The file the route object is written in (repository-relative). */
  readonly at: string;
  /** The request schema; `null` when the handler never reads `ctx.body`. */
  readonly request: Json | null;
  /** The reply schema per success status the handler returns (`2XX` when the code computes the status). Empty: it never succeeds. */
  readonly replies: Readonly<Record<string, Json>>;
}

export interface DerivedEvent {
  /** The files the code builds the event in (repository-relative), every one. */
  readonly at: readonly string[];
  readonly payload: Json;
}

export interface Derived {
  readonly routes: Readonly<Record<string, DerivedRoute>>;
  readonly events: Readonly<Record<string, DerivedEvent>>;
  /** Named types the reply and event schemas refer to (`#/components/schemas/<name>`). */
  readonly components: Readonly<Record<string, Json>>;
  /** What could not be derived, said by name. */
  readonly problems: readonly string[];
}

/** A route the running table serves: its key, and the source text of its handler (to tell two candidate sites apart). */
export interface ServedRoute {
  readonly method: string;
  readonly path: string;
  readonly handlerSource: string;
}

export interface DeriveOptions {
  readonly repoRoot: string;
  /** The head-office API's entry; route objects are read from the files it imports. */
  readonly routeEntry: string;
  /** More entries read for EVENTS only (the store computer builds events too). */
  readonly eventEntries: readonly string[];
  readonly served: readonly ServedRoute[];
  readonly eventTypes: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Types → JSON Schema
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const uniq = (parts: readonly Json[]): Json[] => [...new Map(parts.map((p) => [JSON.stringify(p), p])).values()];
/** One flat, de-duplicated list of alternatives: nested anyOf lifted, a literal absorbed by its plain type, a bare object by a richer one. */
function normalise(parts: readonly Json[]): Json[] {
  const flat: Json[] = [];
  const lift = (j: Json): void => {
    if (j !== null && typeof j === 'object' && !Array.isArray(j) && Array.isArray((j as Obj)['anyOf']) && Object.keys(j).length === 1) for (const x of (j as Obj)['anyOf'] as Json[]) lift(x);
    else flat.push(j);
  };
  parts.forEach(lift);
  let u = uniq(flat).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const o = (j: Json): Obj => (j !== null && typeof j === 'object' && !Array.isArray(j) ? (j as Obj) : {});
  const plain = (t: string): boolean => u.some((j) => o(j)['type'] === t && Object.keys(o(j)).length === 1);
  // A whole number the handler's own check demands (`Number.isInteger`) is not loosened by the plain number TypeScript sees.
  if (plain('integer') && plain('number')) u = u.filter((j) => !(o(j)['type'] === 'number' && Object.keys(o(j)).length === 1));
  for (const t of ['string', 'number', 'boolean']) if (plain(t)) u = u.filter((j) => !(o(j)['type'] === t && Object.keys(o(j)).length > 1 && (o(j)['const'] !== undefined || o(j)['enum'] !== undefined)));
  const bareObject = (j: Json): boolean => o(j)['type'] === 'object' && o(j)['properties'] === undefined && o(j)['required'] === undefined && (o(j)['additionalProperties'] === true || isUntyped(o(j)['additionalProperties'] ?? null)) && o(j)['description'] === undefined;
  // A list of anything is absorbed by a list of something.
  const bareArray = (j: Json): boolean => o(j)['type'] === 'array' && (o(j)['items'] === undefined || isUntyped(o(j)['items']!) || Object.keys(o(o(j)['items']!)).length === 0);
  if (u.some((j) => o(j)['type'] === 'array' && !bareArray(j))) u = u.filter((j) => !bareArray(j));
  else if (u.filter(bareArray).length > 1) { const first = u.find(bareArray)!; u = u.filter((j) => !bareArray(j) || j === first); }
  if (u.some((j) => o(j)['type'] === 'object' && !bareObject(j))) u = u.filter((j) => !bareObject(j));
  else if (u.filter(bareObject).length > 1) { const first = u.find(bareObject)!; u = u.filter((j) => !bareObject(j) || j === first); }
  return u;
}

const isUntyped = (j: Json): boolean => j !== null && typeof j === 'object' && !Array.isArray(j) && (j as Obj)[UNTYPED] !== undefined;
const untyped = (why: string): Json => ({ [UNTYPED]: why });
const intrinsic = (t: ts.Type): string => (t as unknown as { intrinsicName?: string }).intrinsicName ?? '';

class SchemaWriter {
  private readonly named = new Map<string, { readonly name: string; schema: Json | undefined }>();
  private readonly inProgress = new Set<ts.Type>();
  private readonly checker: ts.TypeChecker;
  private readonly repoRoot: string;
  /** Request mode: inline, nothing required (a type the code casts to is not a check), objects open. */
  private readonly request: boolean;
  constructor(checker: ts.TypeChecker, repoRoot: string, request: boolean) { this.checker = checker; this.repoRoot = repoRoot; this.request = request; }

  private nameOf(t: ts.Type): { readonly id: string; readonly name: string } | undefined {
    if (this.request) return undefined;
    const sym = t.aliasSymbol ?? t.getSymbol();
    if (sym === undefined) return undefined;
    if ((t.aliasTypeArguments?.length ?? 0) > 0) return undefined;
    if (t.aliasSymbol === undefined && ((t as ts.TypeReference).typeArguments?.length ?? 0) > 0) return undefined;
    const name = sym.getName();
    if (name.startsWith('__')) return undefined;
    const decl = sym.declarations?.[0];
    if (decl === undefined) return undefined;
    const file = decl.getSourceFile().fileName;
    if (file.includes('/node_modules/')) return undefined;
    if (!(ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl))) return undefined;
    if (ts.isTypeAliasDeclaration(decl) && (decl.typeParameters?.length ?? 0) > 0) return undefined;
    if (ts.isInterfaceDeclaration(decl) && (decl.typeParameters?.length ?? 0) > 0) return undefined;
    return { id: `${relative(this.repoRoot, file)}#${name}`, name };
  }

  schema(t: ts.Type, depth = 0): Json {
    const f = t.flags;
    if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return untyped(intrinsic(t) || 'unknown');
    const named = this.nameOf(t);
    const literalUnion = t.isUnion() && t.types.every((m) => (m.flags & (ts.TypeFlags.Literal | ts.TypeFlags.Undefined | ts.TypeFlags.Null)) !== 0);
    if (named !== undefined && !literalUnion) {
      if (!this.named.has(named.id)) {
        const slot: { name: string; schema: Json | undefined } = { name: named.name, schema: undefined };
        this.named.set(named.id, slot);
        slot.schema = this.structural(t, 0);
      }
      return { $ref: `@@${named.id}` };
    }
    return this.structural(t, depth);
  }

  private structural(t: ts.Type, depth: number): Json {
    const c = this.checker;
    const f = t.flags;
    if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return untyped(intrinsic(t) || 'unknown');
    if (f & ts.TypeFlags.Never) return { not: {} };
    if (t.isUnion()) {
      const members = t.types.filter((m) => !(m.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)));
      const strings = members.filter((m) => m.isStringLiteral()).map((m) => (m as ts.StringLiteralType).value);
      const numbers = members.filter((m) => m.isNumberLiteral()).map((m) => (m as ts.NumberLiteralType).value);
      const bools = members.filter((m) => m.flags & ts.TypeFlags.BooleanLiteral);
      const hasNull = members.some((m) => m.flags & ts.TypeFlags.Null);
      const rest = members.filter((m) => !m.isStringLiteral() && !m.isNumberLiteral() && !(m.flags & (ts.TypeFlags.BooleanLiteral | ts.TypeFlags.Null)));
      const parts: Json[] = [];
      const plainString = rest.some((m) => m.flags & ts.TypeFlags.String);
      const plainNumber = rest.some((m) => m.flags & ts.TypeFlags.Number);
      if (strings.length > 0 && !plainString) parts.push(strings.length === 1 ? { type: 'string', const: strings[0]! } : { type: 'string', enum: [...new Set(strings)].sort() });
      if (numbers.length > 0 && !plainNumber) parts.push(numbers.length === 1 ? { type: 'number', const: numbers[0]! } : { type: 'number', enum: [...new Set(numbers)].sort((a, b) => a - b) });
      if (bools.length === 2) parts.push({ type: 'boolean' });
      else if (bools.length === 1) parts.push({ type: 'boolean', const: intrinsic(bools[0]!) === 'true' });
      for (const m of rest) parts.push(this.schema(m, depth + 1));
      if (hasNull) parts.push({ type: 'null' });
      const unique = normalise(parts);
      if (unique.some(isUntyped)) return untyped('unknown');
      if (unique.length === 0) return { not: {} };
      return unique.length === 1 ? unique[0]! : { anyOf: unique };
    }
    if (t.isStringLiteral()) return { type: 'string', const: t.value };
    if (t.isNumberLiteral()) return { type: 'number', const: t.value };
    if (f & ts.TypeFlags.BooleanLiteral) return { type: 'boolean', const: intrinsic(t) === 'true' };
    if (f & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping)) return { type: 'string' };
    if (f & ts.TypeFlags.Number) return { type: 'number' };
    if (f & ts.TypeFlags.BigInt) return { type: 'integer' };
    if (f & ts.TypeFlags.Boolean) return { type: 'boolean' };
    if (f & ts.TypeFlags.Null) return { type: 'null' };
    if (f & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return { not: {}, description: 'Nothing (left out of the JSON).' };
    if (f & ts.TypeFlags.TypeParameter) {
      const constraint = c.getBaseConstraintOfType(t);
      return constraint === undefined || constraint === t ? untyped('generic') : this.schema(constraint, depth + 1);
    }
    if (f & ts.TypeFlags.NonPrimitive) return { type: 'object', additionalProperties: true };
    if (c.isTupleType(t)) {
      const args = c.getTypeArguments(t as ts.TypeReference);
      return { type: 'array', items: args.length === 0 ? {} : this.union(args.map((a) => this.schema(a, depth + 1))) };
    }
    if (c.isArrayType(t)) {
      const arg = c.getTypeArguments(t as ts.TypeReference)[0];
      return { type: 'array', items: arg === undefined ? untyped('unknown') : this.schema(arg, depth + 1) };
    }
    if (f & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) {
      const symName = t.getSymbol()?.getName();
      if (symName === 'Date') return { type: 'string', format: 'date-time' };
      if (symName === 'Map' || symName === 'Set' || symName === 'WeakMap') return { type: 'object', description: 'Serialised as an empty object.' };
      if (symName === 'Uint8Array' || symName === 'Buffer' || symName === 'ArrayBuffer') return { type: 'object', description: 'Bytes (serialised as an object of indices).' };
      if (symName === 'Promise') return untyped('promise');
      if (this.inProgress.has(t) || depth > 14) return { type: 'object', additionalProperties: true, description: 'Repeats an enclosing shape.' };
      if (t.getCallSignatures().length > 0 && c.getPropertiesOfType(t).length === 0) return untyped('function');
      this.inProgress.add(t);
      try {
        const properties: Obj = {};
        const required: string[] = [];
        for (const p of c.getPropertiesOfType(t)) {
          const decl = p.valueDeclaration ?? p.declarations?.[0];
          const pt = decl === undefined ? c.getTypeOfSymbol(p) : c.getTypeOfSymbolAtLocation(p, decl);
          if (pt.getCallSignatures().length > 0 && c.getPropertiesOfType(pt).length === 0) continue; // a method: not JSON
          if (pt.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) continue;
          const optional = (p.flags & ts.SymbolFlags.Optional) !== 0 || (pt.isUnion() && pt.types.some((m) => m.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)));
          properties[p.getName()] = this.schema(pt, depth + 1);
          if (!optional && !this.request) required.push(p.getName());
        }
        const out: Obj = { type: 'object' };
        if (required.length > 0) out['required'] = required;
        if (Object.keys(properties).length > 0) out['properties'] = properties;
        const index = c.getIndexInfosOfType(t).find((i) => (i.keyType.flags & (ts.TypeFlags.String | ts.TypeFlags.Number)) !== 0);
        out['additionalProperties'] = index === undefined ? true : this.schema(index.type, depth + 1);
        return out;
      } finally {
        this.inProgress.delete(t);
      }
    }
    return untyped(c.typeToString(t));
  }

  union(parts: readonly Json[]): Json {
    const u = normalise(parts);
    if (u.some(isUntyped)) return untyped('unknown');
    return u.length === 1 ? u[0]! : { anyOf: u };
  }

  /** The named schemas with stable component names (a name declared in two files carries its folder and file). */
  finish(): { components: Record<string, Json>; rewrite: (j: Json) => Json } {
    const byName = new Map<string, string[]>();
    for (const [id, slot] of this.named) { const ids = byName.get(slot.name) ?? []; ids.push(id); byName.set(slot.name, ids); }
    const nameFor = new Map<string, string>();
    for (const [name, ids] of byName) {
      if (ids.length === 1) nameFor.set(ids[0]!, name);
      else for (const id of ids) nameFor.set(id, `${name}.${id.split('#')[0]!.replace(/\.ts$/, '').split('/').filter((s) => s !== 'src').slice(-2).join('.').replace(/[^A-Za-z0-9.\-_]/g, '_')}`);
    }
    const rewrite = (j: Json): Json => {
      if (Array.isArray(j)) return j.map(rewrite);
      if (j !== null && typeof j === 'object') {
        const o = j as Obj;
        const r = o['$ref'];
        if (typeof r === 'string' && r.startsWith('@@')) return { $ref: `#/components/schemas/${nameFor.get(r.slice(2))!}` };
        return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, rewrite(v)]));
      }
      return j;
    };
    const components: Record<string, Json> = {};
    for (const id of [...this.named.keys()].sort((a, b) => nameFor.get(a)!.localeCompare(nameFor.get(b)!))) components[nameFor.get(id)!] = rewrite(this.named.get(id)!.schema!);
    return { components, rewrite };
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Reading the source: constants, functions, route objects
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const propOf = (o: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined => {
  for (const p of o.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
  }
  return undefined;
};

/** The symbol an identifier names — for `{ path }` shorthand, the variable it is taken from, not the property. */
const symbolOf = (checker: ts.TypeChecker, e: ts.Expression): ts.Symbol | undefined =>
  ts.isIdentifier(e) && ts.isShorthandPropertyAssignment(e.parent) && e.parent.name === e ? checker.getShorthandAssignmentValueSymbol(e.parent) : checker.getSymbolAtLocation(e);

const aliased = (checker: ts.TypeChecker, s: ts.Symbol | undefined): ts.Symbol | undefined =>
  s === undefined ? undefined : (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s);

/** Every string an expression can be, when the code fixes it; a part the code does not fix is `\u0000`. */
function constantStrings(checker: ts.TypeChecker, e: ts.Expression, depth = 0): string[] {
  const HOLE = ['\u0000'];
  if (depth > 6) return HOLE;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) return constantStrings(checker, e.expression, depth + 1);
  if (ts.isConditionalExpression(e)) return [...new Set([...constantStrings(checker, e.whenTrue, depth + 1), ...constantStrings(checker, e.whenFalse, depth + 1)])];
  const product = (parts: string[][]): string[] => parts.reduce<string[]>((acc, p) => acc.flatMap((a) => p.map((x) => a + x)), ['']).slice(0, 64);
  if (ts.isTemplateExpression(e)) {
    const parts: string[][] = [[e.head.text]];
    for (const span of e.templateSpans) { parts.push(constantStrings(checker, span.expression, depth + 1)); parts.push([span.literal.text]); }
    return product(parts);
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) return product([constantStrings(checker, e.left, depth + 1), constantStrings(checker, e.right, depth + 1)]);
  const t = checker.getTypeAtLocation(e);
  if (t.isStringLiteral()) return [t.value];
  if (t.isUnion() && t.types.every((m) => m.isStringLiteral())) return t.types.map((m) => (m as ts.StringLiteralType).value);
  if (ts.isIdentifier(e)) {
    const sym = aliased(checker, symbolOf(checker, e));
    const d = sym?.valueDeclaration;
    if (d !== undefined && ts.isVariableDeclaration(d) && d.initializer !== undefined) return constantStrings(checker, d.initializer, depth + 1);
    if (d !== undefined && ts.isParameter(d)) {
      // A parameter of the function that builds the route: what its callers in the same file pass.
      const fn = d.parent;
      const index = fn.parameters.indexOf(d);
      const name = ts.isFunctionDeclaration(fn) ? fn.name : (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) ? fn.parent.name : undefined;
      const fnSym = name !== undefined && ts.isIdentifier(name) ? checker.getSymbolAtLocation(name) : undefined;
      if (fnSym !== undefined && index >= 0) {
        const out: string[] = [];
        const visit = (n: ts.Node): void => {
          if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && checker.getSymbolAtLocation(n.expression) === fnSym && n.arguments[index] !== undefined) out.push(...constantStrings(checker, n.arguments[index]!, depth + 1));
          ts.forEachChild(n, visit);
        };
        visit(fn.getSourceFile());
        if (out.length > 0) return [...new Set(out)];
      }
    }
  }
  return HOLE;
}

type FnLike = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration;
const isFnLike = (n: ts.Node): n is FnLike => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n);

/** The function an expression denotes, when the code says which: a literal, a named function, or a function a call returns. */
function functionOf(checker: ts.TypeChecker, e: ts.Expression | undefined, depth = 0): FnLike | undefined {
  if (e === undefined || depth > 5) return undefined;
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return e;
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) return functionOf(checker, e.expression, depth + 1);
  if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
    const d = aliased(checker, symbolOf(checker, e))?.valueDeclaration;
    if (d !== undefined && (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) && d.body !== undefined) return d;
    if (d !== undefined && ts.isVariableDeclaration(d)) return functionOf(checker, d.initializer, depth + 1);
    if (d !== undefined && ts.isPropertyAssignment(d)) return functionOf(checker, d.initializer, depth + 1);
    return undefined;
  }
  if (ts.isCallExpression(e)) {
    const callee = functionOf(checker, e.expression, depth + 1);
    if (callee === undefined || callee.body === undefined) return undefined;
    if (!ts.isBlock(callee.body)) return functionOf(checker, callee.body, depth + 1);
    let found: FnLike | undefined;
    const visit = (n: ts.Node): void => {
      if (found !== undefined) return;
      if (ts.isReturnStatement(n) && n.expression !== undefined) { found = functionOf(checker, n.expression, depth + 1); return; }
      if (isFnLike(n)) return;
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(callee.body, visit);
    return found;
  }
  return undefined;
}

const stringLiteralsIn = (n: ts.Node): Set<string> => {
  const out = new Set<string>();
  const visit = (x: ts.Node): void => {
    if ((ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) && x.text.length > 3) out.add(x.text);
    ts.forEachChild(x, visit);
  };
  visit(n);
  return out;
};
const stringLiteralsInSource = (src: string): Set<string> => {
  const out = new Set<string>();
  for (const m of src.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\$]|\\.)*)`/g)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? '';
    let s = raw;
    try { s = JSON.parse(`"${raw.replace(/"/g, '\\"').replace(/\\'/g, "'")}"`) as string; } catch { /* keep the raw text */ }
    if (s.length > 3) out.add(s);
  }
  return out;
};

/** The files a program entry imports, transitively (type-only imports carry no routes). */
function reachableFiles(checker: ts.TypeChecker, program: ts.Program, entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const sf = program.getSourceFile(f);
    if (sf === undefined) continue;
    for (const st of sf.statements) {
      let spec: ts.Expression | undefined;
      if (ts.isImportDeclaration(st) && st.importClause?.isTypeOnly !== true) spec = st.moduleSpecifier;
      if (ts.isExportDeclaration(st) && !st.isTypeOnly) spec = st.moduleSpecifier;
      if (spec === undefined) continue;
      const target = checker.getSymbolAtLocation(spec)?.valueDeclaration;
      if (target !== undefined && ts.isSourceFile(target) && !target.isDeclarationFile && !target.fileName.includes('/node_modules/')) queue.push(target.fileName);
    }
  }
  return seen;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// What a handler reads from the body (the tracker)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface BodyNode {
  readonly path: readonly string[];
  readonly children: Map<string, BodyNode>;
  items: BodyNode | undefined;
  readonly observed: ts.Type[];
  /** The kinds the handler's own checks test it for (`typeof x === 'string'`, `Array.isArray(x)`, `Number.isInteger(x)`). */
  readonly checks: Set<string>;
  /** The words the handler compares it with (`x === 'accept'`, `METHODS.includes(x)`): its enum, when anything else is refused. */
  readonly literals: Set<string>;
  /** Read with a key the code computes (a map keyed by data). */
  dynamicKeys: boolean;
}
const newNode = (path: readonly string[]): BodyNode => ({ path, children: new Map(), items: undefined, observed: [], checks: new Set(), literals: new Set(), dynamicKeys: false });
const CHECKED_KINDS: Readonly<Record<string, Json>> = {
  string: { type: 'string' }, number: { type: 'number' }, integer: { type: 'integer' }, boolean: { type: 'boolean' },
  object: { type: 'object', additionalProperties: true }, array: { type: 'array', items: {} },
};

const ARRAY_CALLBACKS = new Set(['map', 'filter', 'every', 'some', 'forEach', 'find', 'findIndex', 'flatMap', 'reduce', 'sort', 'findLast']);
const VALUE_METHODS = new Set(['trim', 'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase', 'slice', 'startsWith', 'endsWith', 'includes', 'split', 'length', 'replace', 'replaceAll', 'padStart', 'padEnd', 'indexOf', 'at', 'charAt', 'match', 'localeCompare', 'concat', 'join', 'toString', 'toFixed', 'normalize', 'repeat', 'codePointAt', 'charCodeAt', 'search', 'substring', 'keys', 'values', 'entries', 'push']);

class BodyTracker {
  readonly root = newNode([]);
  private readonly seen = new Set<string>();
  private readonly symIds = new Map<ts.Symbol, number>();
  private readonly checker: ts.TypeChecker;
  /** True when the handler reads the body at all. */
  readsBody = false;
  constructor(checker: ts.TypeChecker) { this.checker = checker; }

  private idOf(s: ts.Symbol): number { let id = this.symIds.get(s); if (id === undefined) { id = this.symIds.size + 1; this.symIds.set(s, id); } return id; }
  private child(n: BodyNode, name: string): BodyNode { let c = n.children.get(name); if (c === undefined) { c = newNode([...n.path, name]); n.children.set(name, c); } return c; }
  private itemsOf(n: BodyNode): BodyNode { if (n.items === undefined) n.items = newNode([...n.path, '*']); return n.items; }

  private observe(t: ts.Type | undefined, n: BodyNode): void {
    if (t === undefined) return;
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return;
    const parts = t.isUnion() ? t.types : [t];
    // `{}` (anything but nothing) is what a check leaves part-way; it says nothing about the type.
    if (parts.some((m) => isEmptyObjectType(this.checker, m))) return;
    n.observed.push(t);
  }

  /** What a check on the value tests it for. */
  private noteCheck(expr: ts.Expression, n: BodyNode): void {
    const p = expr.parent;
    if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)) {
      const other = p.left === expr ? p.right : p.left;
      if (ts.isStringLiteral(other) && other.text !== '') n.literals.add(other.text);
    }
    if (ts.isCallExpression(p) && p.arguments[0] === expr && ts.isPropertyAccessExpression(p.expression) && (p.expression.name.text === 'includes' || p.expression.name.text === 'has')) {
      // `LIST.includes(x)` / `SET.has(x)` over a fixed list of words.
      let recv: ts.Expression = p.expression.expression;
      while (ts.isParenthesizedExpression(recv) || ts.isAsExpression(recv)) recv = recv.expression;
      const t = this.checker.getTypeAtLocation(recv);
      // A tuple (`as const`) lists each word; a list or a set holds one element type.
      const elements: readonly ts.Type[] = this.checker.isTupleType(t) ? this.checker.getTypeArguments(t as ts.TypeReference)
        : this.checker.isArrayType(t) ? this.checker.getTypeArguments(t as ts.TypeReference).slice(0, 1)
          : ((t as ts.TypeReference).typeArguments ?? []).slice(0, 1);
      const parts = elements.flatMap((el) => (el.isUnion() ? el.types : [el]));
      if (parts.length > 0 && parts.every((x) => x.isStringLiteral())) for (const x of parts) n.literals.add((x as ts.StringLiteralType).value);
    }
    if (ts.isTypeOfExpression(p) && ts.isBinaryExpression(p.parent)) {
      const op = p.parent.operatorToken.kind;
      const other = p.parent.left === p ? p.parent.right : p.parent.left;
      if ((op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) && ts.isStringLiteral(other) && CHECKED_KINDS[other.text] !== undefined) n.checks.add(other.text);
      return;
    }
    if (ts.isCallExpression(p) && p.arguments[0] === expr && ts.isPropertyAccessExpression(p.expression) && ts.isIdentifier(p.expression.expression)) {
      const what = `${p.expression.expression.text}.${p.expression.name.text}`;
      if (what === 'Array.isArray') n.checks.add('array');
      if (what === 'Number.isInteger' || what === 'Number.isSafeInteger') n.checks.add('integer');
      if (what === 'Number.isFinite') n.checks.add('number');
    }
  }

  /** A position where the value is only TESTED (typeof, a comparison, a negation, a library check), not used. */
  private tested(expr: ts.Expression): boolean {
    const p = expr.parent;
    if (ts.isTypeOfExpression(p) || ts.isPrefixUnaryExpression(p) || ts.isVoidExpression(p)) return true;
    if (ts.isIfStatement(p) || ts.isWhileStatement(p)) return true;
    if (ts.isConditionalExpression(p) && p.condition === expr) return true;
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) return p.left === expr;
      if (op === ts.SyntaxKind.QuestionQuestionToken) return false;
      return op !== ts.SyntaxKind.EqualsToken;
    }
    if (ts.isCallExpression(p) && p.arguments.includes(expr)) {
      const d = this.checker.getResolvedSignature(p)?.getDeclaration();
      return d === undefined || d.getSourceFile().isDeclarationFile;
    }
    return false;
  }

  /** The handler's context parameter: follow `ctx.body`, and `ctx` handed to another function. */
  trackContext(fn: FnLike, depth = 0): void {
    const p = fn.parameters[0];
    if (p === undefined || fn.body === undefined) return;
    if (ts.isIdentifier(p.name)) { const s = this.checker.getSymbolAtLocation(p.name); if (s !== undefined) this.bindContext(s, fn.body, depth); }
    else if (ts.isObjectBindingPattern(p.name)) for (const el of p.name.elements) {
      const key = (el.propertyName !== undefined && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : '');
      if (key === 'body') { this.readsBody = true; this.bindPattern(el.name, this.root, fn.body, depth); }
    }
  }

  private bindContext(sym: ts.Symbol, scope: ts.Node, depth: number): void {
    const key = `ctx:${this.idOf(sym)}`;
    if (this.seen.has(key) || depth > 8) return;
    this.seen.add(key);
    this.referencesOf(sym, scope, (ref) => {
      const p = ref.parent;
      if (ts.isPropertyAccessExpression(p) && p.expression === ref && p.name.text === 'body') { this.readsBody = true; this.track(p, this.root, depth); return; }
      if (ts.isCallExpression(p) && p.arguments.includes(ref)) {
        const callee = functionOf(this.checker, p.expression);
        const param = callee?.parameters[p.arguments.indexOf(ref)];
        if (callee?.body !== undefined && param !== undefined && ts.isIdentifier(param.name)) { const s = this.checker.getSymbolAtLocation(param.name); if (s !== undefined) this.bindContext(s, callee.body, depth + 1); }
        else if (callee?.body !== undefined && param !== undefined && ts.isObjectBindingPattern(param.name)) {
          for (const el of param.name.elements) {
            const k = (el.propertyName !== undefined && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : '');
            if (k === 'body') { this.readsBody = true; this.bindPattern(el.name, this.root, callee.body, depth + 1); }
          }
        }
      }
      if (ts.isVariableDeclaration(p) && p.initializer === ref && ts.isObjectBindingPattern(p.name)) {
        for (const el of p.name.elements) {
          const k = (el.propertyName !== undefined && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : '');
          if (k === 'body') { this.readsBody = true; this.bindPattern(el.name, this.root, scope, depth); }
        }
      }
    });
  }

  private referencesOf(sym: ts.Symbol, scope: ts.Node, each: (ref: ts.Identifier) => void): void {
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && n.text === sym.getName()) {
        const p = n.parent;
        const isDecl = (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) || ts.isFunctionDeclaration(p)) && (p as { name?: ts.Node }).name === n;
        const isPropName = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || (ts.isBindingElement(p) && p.propertyName === n);
        if (!isDecl && !isPropName) {
          const s = ts.isShorthandPropertyAssignment(p) ? this.checker.getShorthandAssignmentValueSymbol(p) : this.checker.getSymbolAtLocation(n);
          if (s === sym) each(n);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(scope);
  }

  private bindSymbol(sym: ts.Symbol, scope: ts.Node, n: BodyNode, depth: number): void {
    const key = `${this.idOf(sym)}:${n.path.join('\u0001')}`;
    if (this.seen.has(key) || depth > 8) return;
    this.seen.add(key);
    this.referencesOf(sym, scope, (ref) => this.track(ref, n, depth));
  }

  private bindPattern(name: ts.BindingName, n: BodyNode, scope: ts.Node, depth: number): void {
    if (ts.isIdentifier(name)) { const s = this.checker.getSymbolAtLocation(name); if (s !== undefined) this.bindSymbol(s, scope, n, depth); return; }
    if (ts.isObjectBindingPattern(name)) {
      for (const el of name.elements) {
        if (el.dotDotDotToken !== undefined) { n.dynamicKeys = true; continue; }
        const key = el.propertyName === undefined ? (ts.isIdentifier(el.name) ? el.name.text : undefined) : ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName) ? el.propertyName.text : undefined;
        if (key === undefined) { n.dynamicKeys = true; continue; }
        const c = this.child(n, key);
        this.observe(this.checker.getTypeAtLocation(el.name), c);
        this.bindPattern(el.name, c, scope, depth);
      }
      return;
    }
    for (const el of name.elements) if (ts.isBindingElement(el)) this.bindPattern(el.name, this.itemsOf(n), scope, depth);
  }

  private bindParam(callee: FnLike, index: number, n: BodyNode, depth: number): void {
    const param = callee.parameters[index] ?? (callee.parameters.length > 0 && callee.parameters[callee.parameters.length - 1]!.dotDotDotToken !== undefined ? callee.parameters[callee.parameters.length - 1] : undefined);
    if (param === undefined || callee.body === undefined) return;
    if (param.type !== undefined) this.observeDeclared(this.checker.getTypeFromTypeNode(param.type), n);
    this.bindPattern(param.name, param.dotDotDotToken !== undefined ? this.itemsOf(n) : n, callee.body, depth + 1);
  }

  /** True when a function hands back the very value its parameter `index` was given (`bodyOf(b)` → `b`, or `{}`). */
  returnsParam(callee: FnLike, index: number): boolean {
    const param = callee.parameters[index];
    if (param === undefined || callee.body === undefined || !ts.isIdentifier(param.name)) return false;
    const sym = this.checker.getSymbolAtLocation(param.name);
    const isParam = (e: ts.Expression): boolean => {
      if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) return isParam(e.expression);
      if (ts.isConditionalExpression(e)) return isParam(e.whenTrue) || isParam(e.whenFalse);
      if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return isParam(e.left);
      return ts.isIdentifier(e) && sym !== undefined && this.checker.getSymbolAtLocation(e) === sym;
    };
    if (!ts.isBlock(callee.body)) return isParam(callee.body);
    let found = false;
    const visit = (x: ts.Node): void => {
      if (found || isFnLike(x)) return;
      if (ts.isReturnStatement(x) && x.expression !== undefined && isParam(x.expression)) { found = true; return; }
      ts.forEachChild(x, visit);
    };
    ts.forEachChild(callee.body, visit);
    return found;
  }

  /** A type the code DECLARES for a value (a cast, a parameter type): its named properties become children. */
  private observeDeclared(t: ts.Type, n: BodyNode): void {
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return;
    this.observe(t, n);
  }

  /** `expr` evaluates to the body value at `n`: record what is read and follow where it goes. */
  track(expr: ts.Expression, n: BodyNode, depth: number): void {
    const c = this.checker;
    if (!this.tested(expr)) this.observe(c.getTypeAtLocation(expr), n);
    const p = expr.parent;
    if (p === undefined) return;
    this.noteCheck(expr, n);
    if ((ts.isParenthesizedExpression(p) || ts.isNonNullExpression(p) || ts.isSatisfiesExpression(p)) && p.expression === expr) { this.track(p, n, depth); return; }
    if ((ts.isAsExpression(p) || ts.isTypeAssertionExpression(p)) && p.expression === expr) { this.observeDeclared(c.getTypeFromTypeNode(p.type), n); this.track(p, n, depth); return; }
    if (ts.isAwaitExpression(p)) { this.track(p, n, depth); return; }
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind;
      if ((op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) && p.left === expr) { this.track(p, n, depth); return; }
      if (op === ts.SyntaxKind.AmpersandAmpersandToken && p.right === expr) { this.track(p, n, depth); return; }
      return;
    }
    if (ts.isConditionalExpression(p) && (p.whenTrue === expr || p.whenFalse === expr)) { this.track(p, n, depth); return; }
    if (ts.isPropertyAccessExpression(p) && p.expression === expr) {
      const name = p.name.text;
      const call = ts.isCallExpression(p.parent) && p.parent.expression === p ? p.parent : undefined;
      if (call !== undefined && ARRAY_CALLBACKS.has(name)) {
        const items = this.itemsOf(n);
        const cb = call.arguments[0];
        const fn = cb === undefined ? undefined : functionOf(c, cb);
        if (fn !== undefined) this.bindParam(fn, name === 'reduce' ? 1 : 0, items, depth);
        if (name === 'filter' || name === 'sort') this.track(call, n, depth);
        if (name === 'find' || name === 'findLast') this.track(call, items, depth);
        return;
      }
      if (VALUE_METHODS.has(name)) return;
      this.track(p, this.child(n, name), depth);
      return;
    }
    if (ts.isElementAccessExpression(p) && p.expression === expr) {
      const arg = p.argumentExpression;
      if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) { this.track(p, this.child(n, arg.text), depth); return; }
      const at = c.getTypeAtLocation(arg);
      if (at.isStringLiteral()) { this.track(p, this.child(n, at.value), depth); return; }
      if (at.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) { this.track(p, this.itemsOf(n), depth); return; }
      n.dynamicKeys = true;
      return;
    }
    if (ts.isVariableDeclaration(p) && p.initializer === expr) { this.bindPattern(p.name, n, scopeOf(p), depth); return; }
    if (ts.isCallExpression(p) && p.arguments.includes(expr as ts.Expression)) {
      const index = p.arguments.indexOf(expr as ts.Expression);
      const callee = functionOf(c, p.expression);
      if (callee !== undefined && callee.body !== undefined) {
        this.bindParam(callee, index, n, depth);
        // `const b = bodyOf(ctx.body)`: what comes back is the body itself, read on from here.
        if (this.returnsParam(callee, index)) this.track(p, n, depth);
        return;
      }
      // A function without a body here (a dependency's port): the type its signature declares for the value. A library
      // function (Object.entries, JSON.stringify…) declares nothing about the body; one that walks its keys reads them all.
      const sig = c.getResolvedSignature(p);
      const decl = sig?.getDeclaration();
      if (decl === undefined || decl.getSourceFile().isDeclarationFile) { n.dynamicKeys = true; return; }
      const param = sig?.getParameters()[index];
      if (param !== undefined) this.observeDeclared(c.getTypeOfSymbolAtLocation(param, p), n);
      return;
    }
    if (ts.isForOfStatement(p) && p.expression === expr) {
      const init = p.initializer;
      if (ts.isVariableDeclarationList(init) && init.declarations[0] !== undefined) this.bindPattern(init.declarations[0].name, this.itemsOf(n), p, depth);
      return;
    }
    if (ts.isSpreadElement(p) || ts.isSpreadAssignment(p)) { n.dynamicKeys = true; return; }
    // `helper({ entry: b, … })`: the value goes in as a named member of the helper's argument; follow it there.
    if ((ts.isPropertyAssignment(p) && p.initializer === expr && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) || (ts.isShorthandPropertyAssignment(p) && p.name === expr)) {
      const key = p.name.text;
      const obj = p.parent;
      const call = obj.parent;
      if (!ts.isCallExpression(call) || !call.arguments.includes(obj)) return;
      const callee = functionOf(c, call.expression);
      const param = callee?.parameters[call.arguments.indexOf(obj)];
      if (callee?.body === undefined || param === undefined) return;
      this.bindMember(param.name, key, n, callee.body, depth + 1);
    }
  }

  /** `n` is the `key` member of what `name` binds: follow `name.key`, and `const { key } = name`. */
  private bindMember(name: ts.BindingName, key: string, n: BodyNode, scope: ts.Node, depth: number): void {
    if (depth > 8) return;
    if (ts.isObjectBindingPattern(name)) {
      for (const el of name.elements) {
        const k = el.propertyName === undefined ? (ts.isIdentifier(el.name) ? el.name.text : undefined) : ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName) ? el.propertyName.text : undefined;
        if (k === key) this.bindPattern(el.name, n, scope, depth);
      }
      return;
    }
    if (!ts.isIdentifier(name)) return;
    const sym = this.checker.getSymbolAtLocation(name);
    if (sym === undefined) return;
    this.referencesOf(sym, scope, (ref) => {
      const rp = ref.parent;
      if (ts.isPropertyAccessExpression(rp) && rp.expression === ref && rp.name.text === key) this.track(rp, n, depth);
      else if (ts.isElementAccessExpression(rp) && rp.expression === ref && ts.isStringLiteral(rp.argumentExpression) && rp.argumentExpression.text === key) this.track(rp, n, depth);
      else if (ts.isVariableDeclaration(rp) && rp.initializer === ref) this.bindMember(rp.name, key, n, scope, depth + 1);
    });
  }
}

const isEmptyObjectType = (c: ts.TypeChecker, t: ts.Type): boolean =>
  (t.flags & ts.TypeFlags.Object) !== 0 && c.getPropertiesOfType(t).length === 0 && c.getIndexInfosOfType(t).length === 0 && t.getCallSignatures().length === 0 && !c.isArrayType(t) && !c.isTupleType(t);

const scopeOf = (n: ts.Node): ts.Node => {
  let at: ts.Node | undefined = n.parent;
  while (at !== undefined && !isFnLike(at) && !ts.isSourceFile(at)) at = at.parent;
  return at === undefined ? n.getSourceFile() : (isFnLike(at) && at.body !== undefined ? at.body : at);
};

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Which properties the handler refuses without (the refusal probe)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A value while the handler's checks run with one body property missing: known, partly known, or unknown. */
type V =
  | { readonly k: 'u' }
  | { readonly k: 'truthy' }
  | { readonly k: 'falsy' }
  | { readonly k: 'c'; readonly v: string | number | boolean | null | undefined }
  | { readonly k: 'node'; readonly path: readonly string[] }
  | { readonly k: 'ctx' }
  | { readonly k: 'obj'; readonly props: ReadonlyMap<string, V>; readonly open: boolean }
  | { readonly k: 'arr'; readonly items: readonly V[]; readonly open: boolean }
  | { readonly k: 'set'; readonly items: readonly V[]; readonly open: boolean }
  | { readonly k: 'err'; readonly status: V }
  | { readonly k: 'fn'; readonly fn: FnLike; readonly scope: Scope }
  | { readonly k: 're'; readonly re: RegExp }
  | { readonly k: 'global'; readonly name: string };
const U: V = { k: 'u' };
const C = (v: string | number | boolean | null | undefined): V => ({ k: 'c', v });

interface Scope { readonly vars: Map<ts.Symbol, V>; readonly parent: Scope | undefined }
const child = (parent: Scope | undefined): Scope => ({ vars: new Map(), parent });

class Thrown { readonly v: V; constructor(v: V) { this.v = v; } }
class OutOfBudget {}
type Completion = { readonly kind: 'normal' } | { readonly kind: 'return'; readonly v: V } | { readonly kind: 'throw'; readonly v: V } | { readonly kind: 'stop' };
const NORMAL: Completion = { kind: 'normal' };
const STOP: Completion = { kind: 'stop' };

const truthy = (v: V): boolean | undefined => {
  switch (v.k) {
    case 'c': return Boolean(v.v);
    case 'u': return undefined;
    case 'falsy': return false;
    default: return true;
  }
};
const typeofV = (v: V): string | undefined => {
  switch (v.k) {
    case 'c': return typeof v.v === 'object' ? 'object' : typeof v.v;
    case 'node': case 'obj': case 'arr': case 'set': case 'err': case 'ctx': case 're': return 'object';
    case 'fn': return 'function';
    default: return undefined;
  }
};
const isPrefix = (a: readonly string[], b: readonly string[]): boolean => a.length < b.length && a.every((s, i) => b[i] === s);

const REPLAY = /\balready[A-Z]\w*\s*:\s*true\b|\breplay(?:ed)?\s*:\s*true\b/;
/** True when `n` may return; with `replaysAreNot`, a return that hands back an earlier answer (a replay) does not count. */
const returnsSomewhere = (n: ts.Node, replaysAreNot: boolean): boolean => {
  let found = false;
  const visit = (x: ts.Node): void => {
    if (found || isFnLike(x)) return;
    if (ts.isReturnStatement(x)) { if (!(replaysAreNot && x.expression !== undefined && REPLAY.test(x.expression.getText()))) found = true; return; }
    ts.forEachChild(x, visit);
  };
  visit(n);
  return found;
};

class RefusalProbe {
  private readonly checker: ts.TypeChecker;
  private missing: readonly string[] = [];
  private steps = 0;
  private depth = 0;
  private readonly constCache = new Map<ts.Symbol, V>();
  private readonly constBusy = new Set<ts.Symbol>();
  constructor(checker: ts.TypeChecker) { this.checker = checker; }

  /** True when the handler definitely refuses (400 / 422) a body that leaves `path` out and is otherwise fine. */
  /**
   * True when the handler definitely refuses (400 / 422) a body that leaves `path` out and is otherwise fine — on EVERY
   * path through it. A branch on something the probe cannot know is explored both ways (each path is one re-run that
   * follows a recorded list of choices), except a branch that only refuses — the rest of the body is assumed fine — or
   * only hands back an earlier answer (a replay; a first request does not take it). Too many paths: not concluded.
   */
  refuses(handler: FnLike, path: readonly string[], value: V = C(undefined)): boolean {
    this.missing = path;
    this.missingValue = value;
    this.constCache.clear();
    const frontier: boolean[][] = [[]];
    let runs = 0;
    while (frontier.length > 0) {
      if (runs >= 32) return false;
      runs += 1;
      this.prefix = frontier.pop()!;
      this.taken = [];
      this.frontier = frontier;
      if (!this.onePath(handler)) return false;
    }
    return true;
  }

  private prefix: readonly boolean[] = [];
  private taken: boolean[] = [];
  private frontier: boolean[][] = [];
  private inConstant = 0;

  /** A branch the probe cannot decide: the recorded choice on a re-run, else the "false" side now and the other later. */
  private choose(): boolean | undefined {
    if (this.inConstant > 0) return undefined;
    const i = this.taken.length;
    if (i < this.prefix.length) { this.taken.push(this.prefix[i]!); return this.prefix[i]!; }
    if (i >= 12) throw new OutOfBudget();
    this.frontier.push([...this.taken, true]);
    this.taken.push(false);
    return false;
  }

  private onePath(handler: FnLike): boolean {
    this.steps = 0;
    this.depth = 0;
    try {
      const scope = child(undefined);
      const p = handler.parameters[0];
      if (p !== undefined) this.bind(p.name, { k: 'ctx' }, scope);
      if (handler.body === undefined) return false;
      const done: Completion = ts.isBlock(handler.body) ? this.exec(handler.body.statements, scope) : (() => { try { return { kind: 'return', v: this.ev(handler.body as ts.Expression, scope) } as Completion; } catch (e) { if (e instanceof Thrown) return { kind: 'throw', v: e.v } as Completion; throw e; } })();
      return this.isRefusal(done);
    } catch (e) {
      if (e instanceof OutOfBudget) return false;
      throw e;
    }
  }

  private isRefusal(done: Completion): boolean {
    const status = (v: V): number | undefined => (v.k === 'c' && typeof v.v === 'number' ? v.v : undefined);
    if (done.kind === 'throw' && done.v.k === 'err') { const s = status(done.v.status); return s === 400 || s === 422; }
    if (done.kind === 'return' && done.v.k === 'obj') { const s = done.v.props.get('status'); const n = s === undefined ? undefined : status(s); return n === 400 || n === 422; }
    return false;
  }

  private tick(): void { this.steps += 1; if (this.steps > 6000) throw new OutOfBudget(); }

  private missingValue: V = C(undefined);
  private nodeValue(path: readonly string[]): V {
    if (path.length === this.missing.length && path.every((s, i) => this.missing[i] === s)) return this.missingValue;
    if (isPrefix(path, this.missing)) return { k: 'node', path };
    return U;
  }

  private lookup(id: ts.Identifier, scope: Scope): V {
    if (id.text === 'undefined') return C(undefined);
    if (id.text === 'NaN') return C(Number.NaN);
    const raw = this.checker.getSymbolAtLocation(id);
    const sym = aliased(this.checker, raw);
    for (let s: Scope | undefined = scope; s !== undefined; s = s.parent) {
      if (raw !== undefined && s.vars.has(raw)) return s.vars.get(raw)!;
      if (sym !== undefined && s.vars.has(sym)) return s.vars.get(sym)!;
    }
    if (sym === undefined) return ['Array', 'Number', 'Object', 'JSON', 'Math', 'String', 'Boolean'].includes(id.text) ? { k: 'global', name: id.text } : U;
    const d = sym.valueDeclaration;
    if (d === undefined) return ['Array', 'Number', 'Object', 'JSON', 'Math', 'String', 'Boolean'].includes(id.text) ? { k: 'global', name: id.text } : U;
    if (d.getSourceFile().fileName.includes('/node_modules/')) return ['Array', 'Number', 'Object', 'JSON', 'Math', 'String', 'Boolean'].includes(id.text) ? { k: 'global', name: id.text } : U;
    if ((ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) && d.body !== undefined) return { k: 'fn', fn: d, scope: child(undefined) };
    if (ts.isVariableDeclaration(d) && d.initializer !== undefined && ts.isVariableDeclarationList(d.parent) && (d.parent.flags & ts.NodeFlags.Const) !== 0 && ts.isIdentifier(d.name)) {
      // A constant declared outside the code now running (a module constant or a helper): its value, once.
      if (this.constCache.has(sym)) return this.constCache.get(sym)!;
      if (this.constBusy.has(sym)) return U;
      this.constBusy.add(sym);
      this.inConstant += 1;
      let v: V = U;
      try { v = this.ev(d.initializer, child(undefined)); } catch (e) { if (e instanceof OutOfBudget) throw e; v = U; } finally { this.constBusy.delete(sym); this.inConstant -= 1; }
      this.constCache.set(sym, v);
      return v;
    }
    return U;
  }

  private bind(name: ts.BindingName, v: V, scope: Scope, init?: ts.Expression): void {
    let value = v;
    if (init !== undefined && value.k === 'c' && value.v === undefined) value = this.ev(init, scope);
    if (ts.isIdentifier(name)) { const s = this.checker.getSymbolAtLocation(name); if (s !== undefined) scope.vars.set(s, value); return; }
    if (ts.isObjectBindingPattern(name)) {
      for (const el of name.elements) {
        const key = el.propertyName === undefined ? (ts.isIdentifier(el.name) ? el.name.text : undefined) : ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName) ? el.propertyName.text : undefined;
        const got = el.dotDotDotToken !== undefined || key === undefined ? U : this.member(value, key, false);
        this.bind(el.name, got, scope, el.initializer);
      }
      return;
    }
    name.elements.forEach((el, i) => { if (ts.isBindingElement(el)) this.bind(el.name, this.member(value, String(i), false), scope, el.initializer); });
  }

  private member(obj: V, key: string, optional: boolean): V {
    switch (obj.k) {
      case 'c':
        if (obj.v === undefined || obj.v === null) { if (optional) return C(undefined); throw new Thrown({ k: 'u' }); }
        if (typeof obj.v === 'string' && key === 'length') return C(obj.v.length);
        return U;
      case 'node': return this.nodeValue([...obj.path, /^\d+$/.test(key) ? '*' : key]);
      case 'ctx': return key === 'body' ? this.nodeValue([]) : U;
      case 'obj': return obj.props.get(key) ?? (obj.open ? U : C(undefined));
      case 'arr': return key === 'length' ? (obj.open ? U : C(obj.items.length)) : /^\d+$/.test(key) ? (obj.items[Number(key)] ?? (obj.open ? U : C(undefined))) : U;
      case 'err': return key === 'status' ? obj.status : U;
      default: return U;
    }
  }

  private invoke(f: V, args: readonly V[]): V {
    if (f.k !== 'fn') return U;
    if (this.depth > 10) return U;
    const fn = f.fn;
    if (fn.body === undefined) return U;
    const scope = child(f.scope);
    fn.parameters.forEach((p, i) => this.bind(p.name, p.dotDotDotToken !== undefined ? { k: 'arr', items: args.slice(i), open: false } : (args[i] ?? C(undefined)), scope, p.initializer));
    this.depth += 1;
    try {
      if (!ts.isBlock(fn.body)) return this.ev(fn.body, scope);
      const done = this.exec(fn.body.statements, scope);
      if (done.kind === 'return') return done.v;
      if (done.kind === 'throw') throw new Thrown(done.v);
      if (done.kind === 'stop') return U;
      return C(undefined);
    } finally {
      this.depth -= 1;
    }
  }

  private isKernelApiError(callee: ts.Expression): boolean {
    const sym = aliased(this.checker, this.checker.getSymbolAtLocation(callee));
    const d = sym?.valueDeclaration;
    return d !== undefined && sym?.getName() === 'apiError' && /services\/kernel\/src\/errors\.ts$/.test(d.getSourceFile().fileName);
  }

  private call(e: ts.CallExpression, scope: Scope): V {
    const args = (): V[] => e.arguments.map((a) => (ts.isSpreadElement(a) ? U : this.ev(a, scope)));
    if (this.isKernelApiError(e.expression)) { const a = args(); return { k: 'err', status: a[0] ?? U }; }
    const optional = e.questionDotToken !== undefined;
    if (ts.isPropertyAccessExpression(e.expression)) {
      const name = e.expression.name.text;
      const recv = this.ev(e.expression.expression, scope);
      if (optional && recv.k === 'c' && (recv.v === undefined || recv.v === null)) return C(undefined);
      if (recv.k === 'global') {
        const a = args();
        const x = a[0] ?? C(undefined);
        if (recv.name === 'Array' && name === 'isArray') {
          if (x.k === 'c' || x.k === 'obj' || x.k === 'fn' || x.k === 'err' || x.k === 'ctx') return C(false);
          if (x.k === 'arr') return C(true);
          if (x.k === 'node') return C(this.missing[x.path.length] === '*');
          return U;
        }
        if (recv.name === 'Number' && ['isInteger', 'isSafeInteger', 'isFinite', 'isNaN'].includes(name)) {
          if (x.k === 'c') return C((Number as unknown as Record<string, (n: unknown) => boolean>)[name]!(x.v));
          if (x.k === 'node' || x.k === 'obj' || x.k === 'arr') return C(name === 'isNaN' ? false : false);
          return U;
        }
        if (recv.name === 'Object' && name === 'freeze') return x;
        if (recv.name === 'Object' && (name === 'keys' || name === 'entries' || name === 'values')) return x.k === 'c' && (x.v === undefined || x.v === null) ? (() => { throw new Thrown(U); })() : U;
        return U;
      }
      if (recv.k === 'c' && typeof recv.v === 'string') {
        const s = recv.v;
        const a = args();
        const str = (i: number): string | undefined => { const x = a[i]; return x !== undefined && x.k === 'c' && typeof x.v === 'string' ? x.v : undefined; };
        switch (name) {
          case 'trim': return C(s.trim());
          case 'trimStart': return C(s.trimStart());
          case 'trimEnd': return C(s.trimEnd());
          case 'toLowerCase': return C(s.toLowerCase());
          case 'toUpperCase': return C(s.toUpperCase());
          case 'startsWith': return str(0) === undefined ? U : C(s.startsWith(str(0)!));
          case 'endsWith': return str(0) === undefined ? U : C(s.endsWith(str(0)!));
          case 'includes': return str(0) === undefined ? U : C(s.includes(str(0)!));
          default: return U;
        }
      }
      if (recv.k === 're' && name === 'test') {
        const x = args()[0] ?? C(undefined);
        return x.k === 'c' ? C(recv.re.test(String(x.v))) : U;
      }
      if (recv.k === 'set' && name === 'has') {
        const x = args()[0] ?? C(undefined);
        if (x.k === 'c' && !recv.open && recv.items.every((i) => i.k === 'c')) return C(recv.items.some((i) => i.k === 'c' && i.v === x.v));
        return U;
      }
      if (recv.k === 'arr' && name === 'includes') {
        const x = args()[0] ?? C(undefined);
        if (x.k === 'c' && !recv.open && recv.items.every((i) => i.k === 'c')) return C(recv.items.some((i) => i.k === 'c' && i.v === x.v));
        if (x.k === 'c' && x.v === undefined && recv.items.every((i) => i.k === 'c' && i.v !== undefined) && !recv.open) return C(false);
        return U;
      }
      if (recv.k === 'node' && ARRAY_CALLBACKS.has(name)) {
        if (this.missing[recv.path.length] !== '*') return U; // the array's contents are not what is being probed
        const cb = e.arguments[0] === undefined ? U : this.ev(e.arguments[0], scope);
        const item = this.nodeValue([...recv.path, '*']);
        const r = this.invoke(cb, name === 'reduce' ? [U, item, C(0)] : [item, C(0)]);
        if (name === 'every') { const t = truthy(r); return t === false ? C(false) : U; }
        if (name === 'some') { const t = truthy(r); return t === true ? C(true) : U; }
        // The probed item mapped: a list holding what it became (the other items, unknown).
        if (name === 'map') return { k: 'arr', items: [r], open: true };
        return U;
      }
      if (recv.k === 'arr' && (name === 'some' || name === 'every')) {
        const cb = e.arguments[0] === undefined ? U : this.ev(e.arguments[0], scope);
        const results = recv.items.map((item, i) => truthy(this.invoke(cb, [item, C(i)])));
        if (name === 'some') return results.includes(true) ? C(true) : !recv.open && results.every((t) => t === false) ? C(false) : U;
        return results.includes(false) ? C(false) : !recv.open && results.every((t) => t === true) ? C(true) : U;
      }
      if (recv.k === 'obj') { const f = recv.props.get(name); if (f !== undefined && f.k === 'fn') return this.invoke(f, args()); return U; }
      if (recv.k === 'c' && (recv.v === undefined || recv.v === null)) throw new Thrown(U);
      // A method of something else (a dependency, a map, a list of records): unknown, but its arguments still run.
      for (const a of e.arguments) if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) continue; else if (!ts.isSpreadElement(a)) this.ev(a, scope);
      return U;
    }
    const f = this.ev(e.expression, scope);
    if (optional && f.k === 'c' && (f.v === undefined || f.v === null)) return C(undefined);
    if (f.k === 'global') {
      const x = args()[0] ?? C(undefined);
      if (f.name === 'String') return x.k === 'c' ? C(String(x.v)) : U;
      if (f.name === 'Number') return x.k === 'c' ? C(Number(x.v)) : U;
      if (f.name === 'Boolean') { const t = truthy(x); return t === undefined ? U : C(t); }
      return U;
    }
    if (f.k === 'fn') return this.invoke(f, args());
    args();
    return U;
  }

  ev(e: ts.Expression, scope: Scope): V {
    this.tick();
    if (ts.isNumericLiteral(e)) return C(Number(e.text));
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return C(e.text);
    if (e.kind === ts.SyntaxKind.TrueKeyword) return C(true);
    if (e.kind === ts.SyntaxKind.FalseKeyword) return C(false);
    if (e.kind === ts.SyntaxKind.NullKeyword) return C(null);
    if (ts.isRegularExpressionLiteral(e)) {
      const m = /^\/(.*)\/([a-z]*)$/s.exec(e.text);
      try { return m === null ? U : { k: 're', re: new RegExp(m[1]!, m[2]!.replace('g', '')) }; } catch { return U; }
    }
    if (ts.isTemplateExpression(e)) {
      let s = e.head.text;
      for (const span of e.templateSpans) { const v = this.ev(span.expression, scope); if (v.k !== 'c') return { k: 'truthy' }; s += String(v.v) + span.literal.text; }
      return C(s);
    }
    if (ts.isIdentifier(e)) return this.lookup(e, scope);
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) return this.ev(e.expression, scope);
    if (ts.isAwaitExpression(e)) return this.ev(e.expression, scope);
    if (ts.isTypeOfExpression(e)) { const t = typeofV(this.ev(e.expression, scope)); return t === undefined ? U : C(t); }
    if (ts.isVoidExpression(e)) { this.ev(e.expression, scope); return C(undefined); }
    if (ts.isPrefixUnaryExpression(e)) {
      const v = this.ev(e.operand, scope);
      if (e.operator === ts.SyntaxKind.ExclamationToken) { const t = truthy(v); return t === undefined ? U : C(!t); }
      if (e.operator === ts.SyntaxKind.MinusToken && v.k === 'c' && typeof v.v === 'number') return C(-v.v);
      if (e.operator === ts.SyntaxKind.PlusToken && v.k === 'c') return C(Number(v.v));
      return U;
    }
    if (ts.isBinaryExpression(e)) return this.binary(e, scope);
    if (ts.isConditionalExpression(e)) {
      const t = truthy(this.ev(e.condition, scope)) ?? this.choose();
      if (t === true) return this.ev(e.whenTrue, scope);
      if (t === false) return this.ev(e.whenFalse, scope);
      return U;
    }
    if (ts.isPropertyAccessExpression(e)) {
      const obj = this.ev(e.expression, scope);
      if (obj.k === 'global') return U;
      return this.member(obj, e.name.text, e.questionDotToken !== undefined || (e.flags & ts.NodeFlags.OptionalChain) !== 0 && obj.k === 'c');
    }
    if (ts.isElementAccessExpression(e)) {
      const obj = this.ev(e.expression, scope);
      const key = this.ev(e.argumentExpression, scope);
      if (key.k !== 'c' || (typeof key.v !== 'string' && typeof key.v !== 'number')) {
        if (obj.k === 'c' && (obj.v === undefined || obj.v === null) && e.questionDotToken === undefined) throw new Thrown(U);
        if (obj.k === 'node' && this.missing[obj.path.length] === '*' && this.checker.getTypeAtLocation(e.argumentExpression).flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) return this.nodeValue([...obj.path, '*']);
        return U;
      }
      return this.member(obj, String(key.v), e.questionDotToken !== undefined || (e.flags & ts.NodeFlags.OptionalChain) !== 0 && obj.k === 'c');
    }
    if (ts.isCallExpression(e)) return this.call(e, scope);
    if (ts.isNewExpression(e)) {
      const name = ts.isIdentifier(e.expression) ? e.expression.text : '';
      const args = (e.arguments ?? []).map((a) => (ts.isSpreadElement(a) ? U : this.ev(a, scope)));
      if (name === 'ApiError') return { k: 'err', status: args[0] ?? U };
      if (name === 'Set') { const a = args[0]; return a !== undefined && a.k === 'arr' ? { k: 'set', items: a.items, open: a.open } : { k: 'obj', props: new Map(), open: true }; }
      if (name === 'Set' || name === 'Map' || name === 'Date' || name === 'Error' || name === 'RangeError' || name === 'TypeError') return { k: 'obj', props: new Map(), open: true };
      return { k: 'obj', props: new Map(), open: true };
    }
    if (ts.isObjectLiteralExpression(e)) {
      const props = new Map<string, V>();
      let open = false;
      for (const p of e.properties) {
        if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name))) props.set(p.name.text, this.ev(p.initializer, scope));
        else if (ts.isShorthandPropertyAssignment(p)) props.set(p.name.text, this.lookup(p.name, scope));
        else if (ts.isSpreadAssignment(p)) {
          const s = this.ev(p.expression, scope);
          if (s.k === 'obj') { for (const [k, v] of s.props) props.set(k, v); if (s.open) open = true; }
          else if (!(s.k === 'c' && (s.v === undefined || s.v === null || s.v === false))) open = true;
        } else if (ts.isMethodDeclaration(p) && ts.isIdentifier(p.name)) props.set(p.name.text, { k: 'fn', fn: p, scope });
        else open = true;
      }
      return { k: 'obj', props, open };
    }
    if (ts.isArrayLiteralExpression(e)) {
      let open = false;
      const items: V[] = [];
      for (const el of e.elements) { if (ts.isSpreadElement(el)) { const s = this.ev(el.expression, scope); if (s.k === 'arr' && !s.open) items.push(...s.items); else open = true; } else items.push(this.ev(el, scope)); }
      return { k: 'arr', items, open };
    }
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return { k: 'fn', fn: e, scope };
    return U;
  }

  private binary(e: ts.BinaryExpression, scope: Scope): V {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      const l = this.ev(e.left, scope);
      const t = truthy(l);
      if (t === false) return l;
      const r = this.ev(e.right, scope);
      if (t === true) return r;
      return truthy(r) === false ? { k: 'falsy' } : U;
    }
    if (op === ts.SyntaxKind.BarBarToken) {
      const l = this.ev(e.left, scope);
      const t = truthy(l);
      if (t === true) return l;
      let r: V;
      try { r = this.ev(e.right, scope); } catch (x) { if (x instanceof Thrown && t === undefined) return U; throw x; }
      if (t === false) return r;
      return truthy(r) === true ? { k: 'truthy' } : U;
    }
    if (op === ts.SyntaxKind.QuestionQuestionToken) {
      const l = this.ev(e.left, scope);
      if (l.k === 'c' && (l.v === undefined || l.v === null)) return this.ev(e.right, scope);
      if (l.k === 'u' || l.k === 'falsy' || l.k === 'truthy') return U;
      return l;
    }
    if (op === ts.SyntaxKind.CommaToken) { this.ev(e.left, scope); return this.ev(e.right, scope); }
    if (op === ts.SyntaxKind.EqualsToken || (op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment)) {
      const v = this.ev(e.right, scope);
      if (ts.isIdentifier(e.left)) { const s = this.checker.getSymbolAtLocation(e.left); for (let at: Scope | undefined = scope; at !== undefined; at = at.parent) if (s !== undefined && at.vars.has(s)) { at.vars.set(s, op === ts.SyntaxKind.EqualsToken ? v : U); break; } }
      return v;
    }
    const l = this.ev(e.left, scope);
    const r = this.ev(e.right, scope);
    const strict = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    const loose = op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
    if (strict || loose) {
      const negate = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
      const eq = this.equal(l, r, loose);
      return eq === undefined ? U : C(negate ? !eq : eq);
    }
    if (op === ts.SyntaxKind.InKeyword) {
      if (l.k === 'c' && typeof l.v === 'string') {
        if (r.k === 'node') { const v = this.nodeValue([...r.path, l.v]); return v.k === 'c' && v.v === undefined ? C(false) : v.k === 'node' ? C(true) : U; }
        if (r.k === 'obj') return r.props.has(l.v) ? C(true) : r.open ? U : C(false);
      }
      return U;
    }
    if (l.k === 'c' && r.k === 'c') {
      const a = l.v as never;
      const b = r.v as never;
      switch (op) {
        case ts.SyntaxKind.LessThanToken: return C(a < b);
        case ts.SyntaxKind.GreaterThanToken: return C(a > b);
        case ts.SyntaxKind.LessThanEqualsToken: return C(a <= b);
        case ts.SyntaxKind.GreaterThanEqualsToken: return C(a >= b);
        case ts.SyntaxKind.PlusToken: return C((a as number) + (b as number));
        case ts.SyntaxKind.MinusToken: return C((a as number) - (b as number));
        case ts.SyntaxKind.AsteriskToken: return C((a as number) * (b as number));
        case ts.SyntaxKind.SlashToken: return C((a as number) / (b as number));
        case ts.SyntaxKind.PercentToken: return C((a as number) % (b as number));
        default: return U;
      }
    }
    if ((op === ts.SyntaxKind.LessThanToken || op === ts.SyntaxKind.GreaterThanToken || op === ts.SyntaxKind.LessThanEqualsToken || op === ts.SyntaxKind.GreaterThanEqualsToken) && ((l.k === 'c' && l.v === undefined) || (r.k === 'c' && r.v === undefined))) return C(false);
    return U;
  }

  private equal(l: V, r: V, loose: boolean): boolean | undefined {
    const nullish = (v: V): boolean => v.k === 'c' && (v.v === undefined || v.v === null);
    if (l.k === 'c' && r.k === 'c') return loose ? (nullish(l) && nullish(r)) || l.v === r.v : l.v === r.v;
    const known = (v: V): boolean => v.k === 'node' || v.k === 'obj' || v.k === 'arr' || v.k === 'set' || v.k === 'err' || v.k === 'fn' || v.k === 'ctx' || v.k === 're';
    if ((known(l) && r.k === 'c') || (known(r) && l.k === 'c')) return false;
    if (l.k === 'truthy' && nullish(r)) return false;
    if (r.k === 'truthy' && nullish(l)) return false;
    return undefined;
  }

  exec(stmts: readonly ts.Statement[], scope: Scope): Completion {
    for (const s of stmts) {
      this.tick();
      let done: Completion;
      try { done = this.stmt(s, scope); } catch (e) { if (e instanceof Thrown) return { kind: 'throw', v: e.v }; throw e; }
      if (done.kind !== 'normal') return done;
    }
    return NORMAL;
  }

  private stmt(s: ts.Statement, scope: Scope): Completion {
    if (ts.isVariableStatement(s)) { for (const d of s.declarationList.declarations) this.bind(d.name, d.initializer === undefined ? C(undefined) : this.ev(d.initializer, scope), scope); return NORMAL; }
    if (ts.isExpressionStatement(s)) { this.ev(s.expression, scope); return NORMAL; }
    if (ts.isReturnStatement(s)) return { kind: 'return', v: s.expression === undefined ? C(undefined) : this.ev(s.expression, scope) };
    if (ts.isThrowStatement(s)) return { kind: 'throw', v: this.ev(s.expression, scope) };
    if (ts.isBlock(s)) return this.exec(s.statements, child(scope));
    if (ts.isIfStatement(s)) {
      const t = truthy(this.ev(s.expression, scope));
      if (t === true) return this.exec([s.thenStatement], scope);
      if (t === false) return s.elseStatement === undefined ? NORMAL : this.exec([s.elseStatement], scope);
      // A check on something else. One that only refuses (or only hands back an EARLIER answer — `alreadyRecorded: true`,
      // the code's mark for a replay, which a first request never takes) is assumed not taken: the rest of the body is
      // assumed fine. Any other branch is explored both ways.
      const side = returnsSomewhere(s.thenStatement, true) ? this.choose() : false;
      if (side === true) return this.exec([s.thenStatement], scope);
      if (side === false) return s.elseStatement === undefined ? NORMAL : this.exec([s.elseStatement], scope);
      return STOP;
    }
    if (ts.isFunctionDeclaration(s) && s.name !== undefined) { const sym = this.checker.getSymbolAtLocation(s.name); if (sym !== undefined) scope.vars.set(sym, { k: 'fn', fn: s, scope }); return NORMAL; }
    if (ts.isForOfStatement(s)) {
      const it = this.ev(s.expression, scope);
      if (it.k === 'node' && this.missing[it.path.length] === '*' && ts.isVariableDeclarationList(s.initializer) && s.initializer.declarations[0] !== undefined) {
        const inner = child(scope);
        this.bind(s.initializer.declarations[0].name, this.nodeValue([...it.path, '*']), inner);
        const done = this.exec([s.statement], inner);
        return done.kind === 'throw' || done.kind === 'return' ? done : NORMAL;
      }
      return NORMAL;
    }
    if (ts.isTryStatement(s)) {
      const done = this.exec(s.tryBlock.statements, child(scope));
      if (done.kind === 'throw' && s.catchClause !== undefined) return STOP;
      return done;
    }
    if (ts.isBreakStatement(s) || ts.isContinueStatement(s)) return STOP;
    if (ts.isSwitchStatement(s) || ts.isForStatement(s) || ts.isWhileStatement(s) || ts.isDoStatement(s) || ts.isForInStatement(s) || ts.isLabeledStatement(s)) return NORMAL;
    return NORMAL;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Putting a request schema together
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A word no handler compares with: what the probe sends to see whether anything off the list is refused. */
const UNLISTED = '\u0001not-one-of-the-words';

function requestSchema(node: BodyNode, writer: SchemaWriter, requiredOf: (n: BodyNode) => boolean, declared?: Json, refusesUnlisted?: (n: BodyNode) => boolean): Json {
  if (node.children.size === 0 && node.items === undefined && node.literals.size > 0 && refusesUnlisted?.(node) === true) {
    // Compared with fixed words, and refused (400 / 422) when it is none of them: those words are its values.
    return { type: 'string', enum: [...node.literals].sort() };
  }
  // A check's polarity is not read (`!Array.isArray(x)` tests for "not a list"): a value read as an object is not also a
  // list unless its items are read too, and the other way round.
  const checks = [...node.checks]
    .filter((k) => !(k === 'number' && node.checks.has('integer')))
    .filter((k) => !(k === 'array' && node.items === undefined && node.children.size > 0))
    .filter((k) => !(k === 'object' && node.children.size === 0 && (node.items !== undefined || node.checks.has('array'))))
    .sort().map((k) => CHECKED_KINDS[k]!);
  const seen = node.observed.map((t) => writer.schema(t)).filter((j) => !isUntyped(j))
    .map((j) => (node.checks.has('integer') && (j as Obj)['type'] === 'number' && Object.keys(j as Obj).length === 1 ? CHECKED_KINDS['integer']! : j));
  // A bare check (`Array.isArray(x)`) says the kind; the type the code declares for the value says the rest.
  const declaredKinds = declared === undefined ? [] : flatten(declared);
  const detailed = checks.map((k) => declaredKinds.find((d) => d['type'] === (k as Obj)['type'] || (d['type'] === 'number' && (k as Obj)['type'] === 'integer')) ?? k);
  const fromCode = [...seen, ...detailed];
  const observed = fromCode.length > 0 ? writer.union(fromCode) : declared ?? untyped('unknown');
  const kinds = flatten(observed);
  if (node.children.size === 0 && node.items === undefined) {
    if (isUntyped(observed)) return { [UNCHECKED]: true, description: 'Read and passed on as given; the handler does not check its type.' };
    return observed;
  }
  const out: Obj[] = [];
  if (node.children.size > 0 || kinds.some((k) => k['type'] === 'object')) {
    const properties: Obj = {};
    // Properties a declared type names that the handler did not visibly read are still part of what it takes.
    for (const k of kinds) if (k['type'] === 'object' && k['properties'] !== undefined && typeof k['properties'] === 'object') for (const [name, s] of Object.entries(k['properties'] as Obj)) properties[name] = s;
    const required: string[] = [];
    for (const name of [...node.children.keys()].sort()) {
      const c = node.children.get(name)!;
      properties[name] = requestSchema(c, writer, requiredOf, properties[name], refusesUnlisted);
      if (requiredOf(c)) required.push(name);
    }
    const o: Obj = { type: 'object' };
    if (required.length > 0) o['required'] = required;
    if (Object.keys(properties).length > 0) o['properties'] = Object.fromEntries(Object.keys(properties).sort().map((k) => [k, properties[k]!]));
    o['additionalProperties'] = true;
    out.push(o);
  }
  if (node.items !== undefined || kinds.some((k) => k['type'] === 'array')) {
    const declaredItems = kinds.find((k) => k['type'] === 'array' && k['items'] !== undefined && Object.keys(k['items'] as Obj).length > 0)?.['items'];
    const items = node.items === undefined ? (declaredItems ?? {}) : requestSchema(node.items, writer, requiredOf, declaredItems, refusesUnlisted);
    out.push({ type: 'array', items });
  }
  for (const k of kinds) if (k['type'] !== 'object' && k['type'] !== 'array' && !isUntyped(k)) out.push(k);
  const u = normalise(out);
  return u.length === 1 ? u[0]! : { anyOf: u };
}

const flatten = (j: Json): Obj[] => {
  if (j === null || typeof j !== 'object' || Array.isArray(j)) return [];
  const o = j as Obj;
  if (Array.isArray(o['anyOf'])) return (o['anyOf'] as Json[]).flatMap(flatten);
  return [o];
};

const allNodes = (n: BodyNode, out: BodyNode[] = []): BodyNode[] => {
  for (const c of n.children.values()) { out.push(c); allNodes(c, out); }
  if (n.items !== undefined) allNodes(n.items, out);
  return out;
};

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The derivation
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Site { readonly at: string; readonly method: string; readonly paths: readonly string[]; readonly handlerExpr: ts.Expression; readonly fn: FnLike | undefined; readonly literals: Set<string> }

/** A function that takes the request context (`ctx`): a handler, or a wrapper's own handler. */
const takesContext = (checker: ts.TypeChecker, f: FnLike): boolean => {
  const p = f.parameters[0];
  if (p === undefined) return false;
  if (ts.isIdentifier(p.name) && p.name.text === 'ctx') return true;
  const t = checker.getTypeAtLocation(p);
  return t.getProperty('tenantId') !== undefined && t.getProperty('params') !== undefined && t.getProperty('body') !== undefined;
};

/**
 * The handler code a WRAPPER adds in front of a route at run time — `wrap(surface, 'POST', '/v1/…', (inner) => async (ctx)
 * => …)`, `guardBefore(surface, 'POST', '/v1/…', (ctx) => …)`, `replace(surface, 'POST', '/v1/…', (r) => ({ ...r, handler:
 * guard(r.handler) }))`: the context-taking functions the wrapper's last argument is, returns, or puts in `handler`.
 */
function wrapperFragments(checker: ts.TypeChecker, around: FnLike): FnLike[] {
  if (takesContext(checker, around)) return [around];
  const out: FnLike[] = [];
  const consider = (e: ts.Expression): void => {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) { consider(e.expression); return; }
    if (ts.isConditionalExpression(e)) { consider(e.whenTrue); consider(e.whenFalse); return; }
    if (ts.isObjectLiteralExpression(e)) { const h = propOf(e, 'handler'); const f = h === undefined ? undefined : functionOf(checker, h); if (f !== undefined && takesContext(checker, f)) out.push(f); return; }
    const f = functionOf(checker, e);
    if (f !== undefined && takesContext(checker, f)) out.push(f);
  };
  if (around.body === undefined) return out;
  if (!ts.isBlock(around.body)) consider(around.body);
  else {
    const visit = (n: ts.Node): void => {
      if (isFnLike(n)) return;
      if (ts.isReturnStatement(n) && n.expression !== undefined) consider(n.expression);
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(around.body, visit);
  }
  return out;
}


export function deriveBodies(opts: DeriveOptions): Derived {
  const program = ts.createProgram([opts.routeEntry, ...opts.eventEntries], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true, noUncheckedIndexedAccess: true, skipLibCheck: true, noEmit: true, resolveJsonModule: true, types: ['node'],
    esModuleInterop: true, lib: ['lib.es2022.d.ts'],
  });
  const checker = program.getTypeChecker();
  const replies = new SchemaWriter(checker, opts.repoRoot, false);
  const requests = new SchemaWriter(checker, opts.repoRoot, true);
  const problems: string[] = [];
  // The file only, never the line: a document that changed whenever a line moved above a route would be noise.
  const where = (n: ts.Node): string => relative(opts.repoRoot, n.getSourceFile().fileName);

  // 1. Every route object in the files the head-office API imports.
  const routeFiles = reachableFiles(checker, program, program.getSourceFile(opts.routeEntry)!.fileName);
  const sites: Site[] = [];
  const eventSites = new Map<string, { at: string[]; types: ts.Type[] }>();
  const eventTypes = new Set(opts.eventTypes);
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || sf.fileName.includes('/node_modules/')) continue;
    const forRoutes = routeFiles.has(sf.fileName);
    const visit = (n: ts.Node): void => {
      if (ts.isObjectLiteralExpression(n)) {
        const methodE = propOf(n, 'method');
        const pathE = propOf(n, 'path');
        const handlerE = propOf(n, 'handler');
        if (forRoutes && methodE !== undefined && pathE !== undefined && handlerE !== undefined && propOf(n, 'permission') !== undefined) {
          const methods = constantStrings(checker, methodE);
          const fn = functionOf(checker, handlerE);
          for (const method of methods) sites.push({ at: where(n), method, paths: constantStrings(checker, pathE), handlerExpr: handlerE, fn, literals: fn === undefined ? new Set() : stringLiteralsIn(fn) });
        }
        const typeE = propOf(n, 'type');
        const payloadE = propOf(n, 'payload');
        if (typeE !== undefined && payloadE !== undefined) {
          for (const t of constantStrings(checker, typeE)) {
            if (!eventTypes.has(t)) continue;
            const slot = eventSites.get(t) ?? { at: [], types: [] };
            slot.at.push(where(n));
            slot.types.push(checker.getTypeAtLocation(payloadE));
            eventSites.set(t, slot);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  // 2. Pair each served route with its route object: by its path, or the path's pattern, and by the handler's own words.
  const toRe = (p: string): RegExp => new RegExp(`^${p.split('\u0000').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+(?:/[^/]+)*')}$`);
  const exact = new Map<string, Site[]>();
  const patterned: { re: RegExp; site: Site }[] = [];
  for (const s of sites) for (const p of s.paths) {
    if (p.includes('\u0000')) patterned.push({ re: toRe(p), site: s });
    else { const k = `${s.method} ${p}`; exact.set(k, [...(exact.get(k) ?? []), s]); }
  }
  // Ports wired as another route's own handler (`port: handlerOf(surface, 'POST', '/v1/…')`).
  const delegates = new Map<string, string>();
  for (const sf of program.getSourceFiles()) {
    if (!routeFiles.has(sf.fileName)) continue;
    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && ts.isCallExpression(n.initializer) && ts.isIdentifier(n.initializer.expression) && n.initializer.expression.text === 'handlerOf' && n.initializer.arguments.length >= 3) {
        const m = constantStrings(checker, n.initializer.arguments[1]!);
        const p = constantStrings(checker, n.initializer.arguments[2]!);
        if (m.length === 1 && p.length === 1 && !m[0]!.includes('\u0000') && !p[0]!.includes('\u0000')) delegates.set(n.name.text, `${m[0]!} ${p[0]!}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  // Wrappers that put more handler code in front of a route at run time (see `wrapperFragments`): found by the method and
  // path the code names them with.
  const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
  const wrappers: { method: string; re: RegExp; exact: string | undefined; fragments: FnLike[] }[] = [];
  for (const sf of program.getSourceFiles()) {
    if (!routeFiles.has(sf.fileName)) continue;
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && n.arguments.length >= 3) {
        const last = n.arguments[n.arguments.length - 1]!;
        const around = ts.isArrowFunction(last) || ts.isFunctionExpression(last) || ts.isIdentifier(last) ? functionOf(checker, last) : undefined;
        if (around !== undefined) {
          for (let i = 0; i + 1 < n.arguments.length - 1; i += 1) {
            const a = n.arguments[i]!;
            // Cheap first: a method is written as one ('POST') or held in something named for it (method, t.method).
            if (!((ts.isStringLiteral(a) && METHODS.has(a.text)) || /method/i.test(a.getText()))) continue;
            const ms = constantStrings(checker, a);
            if (!ms.every((m) => METHODS.has(m))) continue;
            const ps = constantStrings(checker, n.arguments[i + 1]!).filter((x) => x.startsWith('/v1/'));
            if (ps.length === 0) continue;
            const fragments = wrapperFragments(checker, around);
            if (fragments.length > 0) for (const m of ms) for (const x of ps) wrappers.push({ method: m, re: toRe(x), exact: x.includes('\u0000') ? undefined : x, fragments });
            break;
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const fragmentsOf = (method: string, path: string, site: Site): FnLike[] =>
    [...new Set(wrappers.filter((w) => w.method === method && (w.exact === path || (w.exact === undefined && w.re.test(path)))).flatMap((w) => w.fragments))].filter((f) => f !== site.fn);
  const rc: ReplyContext = { checker, delegates };
  const routes: Record<string, DerivedRoute> = {};
  const probe = new RefusalProbe(checker);
  const siteOf = new Map<string, Site>();
  const replyMemo = new Map<string, Record<string, Json>>();
  const repliesOf = (key: string): Record<string, Json> => {
    const memo = replyMemo.get(key);
    if (memo !== undefined) return memo;
    const site = siteOf.get(key);
    replyMemo.set(key, {});
    const [method, path] = [key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1)];
    const out = site === undefined ? {} : deriveReplies(rc, replies, site, fragmentsOf(method, path, site), repliesOf);
    replyMemo.set(key, out);
    return out;
  };
  const pending: { key: string; site: Site }[] = [];
  for (const r of [...opts.served].sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`))) {
    const key = `${r.method} ${r.path}`;
    let candidates = exact.get(key) ?? [];
    if (candidates.length === 0) candidates = patterned.filter((x) => x.site.method === r.method && x.re.test(r.path)).map((x) => x.site);
    candidates = [...new Set(candidates)];
    if (candidates.length > 1) {
      const words = stringLiteralsInSource(r.handlerSource);
      const score = (s: Site): number => { let n = 0; for (const w of s.literals) if (words.has(w)) n += 1; return n - Math.abs(s.literals.size - words.size) / 1000; };
      const best = Math.max(...candidates.map(score));
      candidates = candidates.filter((s) => score(s) === best);
      if (candidates.length > 1) problems.push(`${key}: ${candidates.length} route objects could be it (${candidates.map((s) => s.at).join(', ')}); the first is used`);
    }
    const site = candidates[0];
    if (site === undefined) { problems.push(`${key}: no route object found in the source`); continue; }
    siteOf.set(key, site);
    pending.push({ key, site });
  }
  for (const { key, site } of pending) {
    const fragments = fragmentsOf(key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1), site);
    routes[key] = { at: site.at, request: deriveRequest(checker, requests, probe, site, fragments, problems, key), replies: repliesOf(key) };
  }

  // 3. Event payloads.
  const events: Record<string, DerivedEvent> = {};
  for (const t of [...eventTypes].sort()) {
    const slot = eventSites.get(t);
    if (slot === undefined) continue;
    events[t] = { at: [...new Set(slot.at)].sort(), payload: replies.union(slot.types.map((x) => replies.schema(x))) };
  }

  const { components, rewrite } = replies.finish();
  const outRoutes: Record<string, DerivedRoute> = {};
  for (const k of Object.keys(routes).sort()) {
    const r = routes[k]!;
    outRoutes[k] = { at: r.at, request: r.request, replies: rewrite(r.replies as Json) as Record<string, Json> };
  }
  const outEvents: Record<string, DerivedEvent> = {};
  for (const k of Object.keys(events).sort()) outEvents[k] = { at: events[k]!.at, payload: rewrite(events[k]!.payload) };
  return { routes: outRoutes, events: outEvents, components, problems };
}

type Result = { readonly statuses: string[]; readonly body: ts.Type } | { readonly delegate: string };

interface ReplyContext {
  readonly checker: ts.TypeChecker;
  /** A dependency port that IS another route's handler (`port: handlerOf(surface, 'POST', '/v1/…')`): its route key. */
  readonly delegates: ReadonlyMap<string, string>;
}

/** Every (statuses, body type) a handler can return: read from its return statements, and from the helpers they call. */
function resultsOf(rc: ReplyContext, e: ts.Expression, depth: number): Result[] {
  const checker = rc.checker;
  if (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) return resultsOf(rc, e.expression, depth);
  if (ts.isConditionalExpression(e)) return [...resultsOf(rc, e.whenTrue, depth), ...resultsOf(rc, e.whenFalse, depth)];
  const statusesOf = (t: ts.Type): string[] => (t.isUnion() ? t.types : [t]).map((x) => (x.isNumberLiteral() ? String(x.value) : 'default'));
  if (ts.isObjectLiteralExpression(e)) {
    const st = propOf(e, 'status');
    const bd = propOf(e, 'body');
    if (st !== undefined && bd !== undefined) return [{ statuses: statusesOf(checker.getTypeAtLocation(st)), body: checker.getTypeAtLocation(bd) }];
  }
  const typed: Result[] = [];
  const t = checker.getTypeAtLocation(e);
  const awaited = checker.getAwaitedType(t) ?? t;
  for (const m of awaited.isUnion() ? awaited.types : [awaited]) {
    const statusSym = m.getProperty('status');
    const bodySym = m.getProperty('body');
    if (statusSym !== undefined && bodySym !== undefined) typed.push({ statuses: statusesOf(checker.getTypeOfSymbol(statusSym)), body: checker.getTypeOfSymbol(bodySym) });
  }
  const vague = typed.length === 0 || typed.some((r) => 'body' in r && (r.body.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) !== 0);
  if (vague && ts.isCallExpression(e) && depth < 5) {
    // A port that is another route's handler answers with that route's reply.
    if (ts.isPropertyAccessExpression(e.expression) && rc.delegates.has(e.expression.name.text)) return [{ delegate: rc.delegates.get(e.expression.name.text)! }];
    const callee = functionOf(checker, e.expression);
    if (callee !== undefined) { const inner = returnsOf(rc, callee, depth + 1); if (inner.length > 0) return inner; }
  }
  return typed;
}

/** `if (res.status >= 300) return res;` — a reply passed on only when it is a refusal is not a success reply. */
const passesOnARefusal = (ret: ts.ReturnStatement): boolean => {
  const e = ret.expression;
  if (e === undefined || !ts.isIdentifier(e)) return false;
  let at: ts.Node = ret;
  while (at.parent !== undefined && (ts.isBlock(at.parent) && at.parent.statements.length === 1)) at = at.parent;
  const p = at.parent;
  if (p === undefined || !ts.isIfStatement(p) || p.thenStatement !== at) return false;
  return new RegExp(`\\b${e.text}\\.status\\s*(>=\\s*[34]\\d\\d|>\\s*[23]\\d\\d)`).test(p.expression.getText());
};

function returnsOf(rc: ReplyContext, fn: FnLike, depth: number): Result[] {
  if (fn.body === undefined) return [];
  if (!ts.isBlock(fn.body)) return resultsOf(rc, fn.body, depth);
  const out: Result[] = [];
  const visit = (n: ts.Node): void => {
    if (isFnLike(n) || ts.isClassDeclaration(n)) return;
    if (ts.isReturnStatement(n) && n.expression !== undefined && !passesOnARefusal(n)) out.push(...resultsOf(rc, n.expression, depth));
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn.body, visit);
  return out;
}

function deriveReplies(rc: ReplyContext, writer: SchemaWriter, site: Site, fragments: readonly FnLike[], delegated: (key: string) => Record<string, Json>): Record<string, Json> {
  const checker = rc.checker;
  let results = site.fn === undefined ? [] : returnsOf(rc, site.fn, 0);
  // A wrapper's own replies count; what it merely passes on from the route it wraps (a reply the code does not type) does not.
  for (const f of fragments) results.push(...returnsOf(rc, f, 0).filter((r) => !('body' in r) || (r.body.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) === 0));
  if (results.length === 0 && site.fn === undefined) {
    const sig = checker.getTypeAtLocation(site.handlerExpr).getCallSignatures()[0];
    if (sig !== undefined) {
      const ret = checker.getReturnTypeOfSignature(sig);
      const awaited = checker.getAwaitedType(ret) ?? ret;
      for (const m of awaited.isUnion() ? awaited.types : [awaited]) {
        const st = m.getProperty('status'); const bd = m.getProperty('body');
        if (st !== undefined && bd !== undefined) { const stt = checker.getTypeOfSymbol(st); results.push({ statuses: (stt.isUnion() ? stt.types : [stt]).map((x) => (x.isNumberLiteral() ? String(x.value) : 'default')), body: checker.getTypeOfSymbol(bd) }); }
      }
    }
  }
  results = results.filter((r) => !('body' in r) || !(r.body.flags & ts.TypeFlags.Never));
  const byStatus = new Map<string, Json[]>();
  const add = (st: string, body: Json): void => { byStatus.set(st, [...(byStatus.get(st) ?? []), body]); };
  for (const r of results) {
    if ('delegate' in r) { for (const [st, body] of Object.entries(delegated(r.delegate))) add(st === '2XX' ? 'default' : st, body); continue; }
    const body = writer.schema(r.body);
    for (const st of r.statuses) add(st, body);
  }
  const out: Record<string, Json> = {};
  // A refusal the handler RETURNS (rather than throws) is an error reply, already declared with the shared error shape. A
  // status the code does not fix (a computed number) is declared as "a success" (2XX).
  for (const st of [...byStatus.keys()].sort()) if (!(Number(st) >= 400)) out[st === 'default' ? '2XX' : st] = writer.union(byStatus.get(st)!);
  return out;
}

/** In a request, a part the code does not type is a part the handler passes on unchecked. */
const uncheckedNotUntyped = (j: Json): Json => {
  if (Array.isArray(j)) return j.map(uncheckedNotUntyped);
  if (j !== null && typeof j === 'object') {
    if (isUntyped(j)) return { [UNCHECKED]: true, description: 'Read and passed on as given; the handler does not check its type.' };
    return Object.fromEntries(Object.entries(j as Obj).map(([k, v]) => [k, uncheckedNotUntyped(v)]));
  }
  return j;
};

function deriveRequest(checker: ts.TypeChecker, writer: SchemaWriter, probe: RefusalProbe, site: Site, fragments: readonly FnLike[], problems: string[], key: string): Json | null {
  if (site.fn === undefined) { problems.push(`${key}: the handler's function is not readable (${site.at})`); return untyped('handler not readable'); }
  const tracker = new BodyTracker(checker);
  tracker.trackContext(site.fn);
  for (const f of fragments) tracker.trackContext(f);
  if (!tracker.readsBody) return null;
  const all = [site.fn, ...fragments];
  const memo = new Map<BodyNode, boolean>();
  // Required where the route's own handler, or a wrapper in front of it, refuses a body without it.
  const requiredOf = (n: BodyNode): boolean => {
    let r = memo.get(n);
    if (r === undefined) { r = all.some((f) => probe.refuses(f, n.path)); memo.set(n, r); }
    return r;
  };
  void allNodes;
  const refusesUnlisted = (n: BodyNode): boolean => all.some((f) => probe.refuses(f, n.path, C(UNLISTED)));
  const schema = uncheckedNotUntyped(requestSchema(tracker.root, writer, requiredOf, undefined, refusesUnlisted));
  // A request body is a JSON object: where the code also allows for something else arriving (`as X | null`, a list it
  // tests for and refuses), the object is what it reads.
  const objects = flatten(schema).filter((k) => k['type'] === 'object');
  return objects.length === 1 ? objects[0]! : schema;
}
