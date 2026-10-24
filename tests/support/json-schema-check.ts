// A small JSON Schema checker for the subset the declared API body schemas use (services/platform/src/api-body-schemas.ts):
// type (one or a list), const, enum, required, properties, additionalProperties (true / false / a schema), items, minItems,
// minimum, minLength, pattern, anyOf, and $ref into a document's components. Returns every problem with its JSON path, so a
// schema that has drifted from its handler says exactly where. Test support only.

type Schema = Record<string, unknown>;

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const matchesType = (v: unknown, t: string): boolean => t === 'number' ? typeof v === 'number' : t === 'integer' ? Number.isInteger(v) : typeOf(v) === t;

export function schemaProblems(value: unknown, schema: Schema, root: unknown = {}, path = '$'): string[] {
  if (typeof schema['$ref'] === 'string') {
    const target = (schema['$ref'] as string).replace(/^#\//, '').split('/').reduce<unknown>((at, seg) => (at as Record<string, unknown> | undefined)?.[seg], root);
    if (target === undefined) return [`${path}: $ref ${String(schema['$ref'])} does not resolve`];
    return schemaProblems(value, target as Schema, root, path);
  }
  const out: string[] = [];
  if (Array.isArray(schema['anyOf'])) {
    const ok = (schema['anyOf'] as Schema[]).some((s) => schemaProblems(value, s, root, path).length === 0);
    if (!ok) out.push(`${path}: matches none of anyOf`);
    return out;
  }
  if ('const' in schema && value !== schema['const']) out.push(`${path}: expected ${JSON.stringify(schema['const'])}, got ${JSON.stringify(value)}`);
  if (Array.isArray(schema['enum']) && !(schema['enum'] as unknown[]).includes(value)) out.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema['enum'])}`);
  const types = schema['type'] === undefined ? [] : Array.isArray(schema['type']) ? (schema['type'] as string[]) : [schema['type'] as string];
  if (types.length > 0 && !types.some((t) => matchesType(value, t))) return [...out, `${path}: expected ${types.join('|')}, got ${typeOf(value)}`];
  if (typeof value === 'string') {
    if (typeof schema['minLength'] === 'number' && value.length < (schema['minLength'] as number)) out.push(`${path}: shorter than ${String(schema['minLength'])}`);
    if (typeof schema['pattern'] === 'string' && !new RegExp(schema['pattern'] as string).test(value)) out.push(`${path}: does not match ${String(schema['pattern'])}`);
  }
  if (typeof value === 'number' && typeof schema['minimum'] === 'number' && value < (schema['minimum'] as number)) out.push(`${path}: below ${String(schema['minimum'])}`);
  if (Array.isArray(value)) {
    if (typeof schema['minItems'] === 'number' && value.length < (schema['minItems'] as number)) out.push(`${path}: fewer than ${String(schema['minItems'])} items`);
    if (schema['items'] !== undefined) value.forEach((v, i) => out.push(...schemaProblems(v, schema['items'] as Schema, root, `${path}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    for (const k of (schema['required'] as string[] | undefined) ?? []) if (!(k in obj)) out.push(`${path}: missing required "${k}"`);
    const props = (schema['properties'] as Record<string, Schema> | undefined) ?? {};
    for (const [k, v] of Object.entries(obj)) {
      if (props[k] !== undefined) out.push(...schemaProblems(v, props[k]!, root, `${path}.${k}`));
      else if (schema['additionalProperties'] === false) out.push(`${path}: "${k}" is not allowed`);
      else if (typeOf(schema['additionalProperties']) === 'object') out.push(...schemaProblems(v, schema['additionalProperties'] as Schema, root, `${path}.${k}`));
    }
  }
  return out;
}
