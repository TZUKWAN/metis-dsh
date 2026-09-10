/**
 * Runtime argument validator generated from a JSON Schema subset.
 *
 * Provides structural validation for builtin tool arguments without relying on
 * free-text regex. Unknown/extra keys are rejected by default (strictObject).
 *
 * SECURITY: Any unsupported JSON Schema construct results in an explicit
 * failure rather than falling back to z.unknown() or an open validator.
 */

import { z } from 'zod';

export type JSONSchemaType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'array'
  | 'object'
  | 'null';

export interface JSONSchema {
  type?: JSONSchemaType | JSONSchemaType[];
  properties?: Record<string, JSONSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JSONSchema;
  enum?: unknown[];
  description?: string;
  default?: unknown;
  // Unsupported constructs that must fail-closed:
  oneOf?: unknown;
  anyOf?: unknown;
  allOf?: unknown;
  $ref?: string;
  nullable?: boolean;
  not?: unknown;
  if?: unknown;
  then?: unknown;
  else?: unknown;
}

export class UnsupportedSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedSchemaError';
  }
}

function assertSupported(schema: JSONSchema): void {
  if (schema.oneOf !== undefined) {
    throw new UnsupportedSchemaError('oneOf is not supported');
  }
  if (schema.anyOf !== undefined) {
    throw new UnsupportedSchemaError('anyOf is not supported');
  }
  if (schema.allOf !== undefined) {
    throw new UnsupportedSchemaError('allOf is not supported');
  }
  if (schema.$ref !== undefined) {
    throw new UnsupportedSchemaError('$ref is not supported');
  }
  if (schema.not !== undefined) {
    throw new UnsupportedSchemaError('not is not supported');
  }
  if (schema.if !== undefined || schema.then !== undefined || schema.else !== undefined) {
    throw new UnsupportedSchemaError('conditional schemas are not supported');
  }
  if (schema.nullable !== undefined) {
    throw new UnsupportedSchemaError('nullable is not supported');
  }
  if (schema.type === undefined) {
    throw new UnsupportedSchemaError('schema without type is not supported');
  }
  if (Array.isArray(schema.type) && schema.type.length === 0) {
    throw new UnsupportedSchemaError('empty type union is not supported');
  }
  // Non-single type unions are rejected everywhere (root + nested)
  if (Array.isArray(schema.type) && schema.type.length > 1) {
    throw new UnsupportedSchemaError('non-single type union is not supported');
  }
  // Unknown keyword detection: any key not in our known set is rejected
  const known = new Set(['type','properties','required','additionalProperties','items','enum','description','default','oneOf','anyOf','allOf','$ref','nullable','not','if','then','else']);
  for (const key of Object.keys(schema)) {
    if (!known.has(key)) {
      throw new UnsupportedSchemaError(`Unknown keyword: ${key}`);
    }
  }
}

function isJSONSchemaTypeArray(t: unknown): t is JSONSchemaType[] {
  return (
    Array.isArray(t) &&
    t.every(
      (x) =>
        typeof x === 'string' &&
        ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'].includes(x),
    )
  );
}

function schemaToZod(schema: JSONSchema): z.ZodType<unknown> {
  assertSupported(schema);

  // enum takes precedence over type
  if (schema.enum && Array.isArray(schema.enum)) {
    const values = schema.enum;
    if (values.length === 0) return z.never();
    const literals = values.map((v) =>
      typeof v === 'string'
        ? z.literal(v)
        : typeof v === 'number'
          ? z.literal(v)
          : typeof v === 'boolean'
            ? z.literal(v)
            : z.never(),
    );
    if (literals.length === 1) return literals[0]!;
    return z.union(literals as unknown as [z.ZodType<unknown>, z.ZodType<unknown>, ...z.ZodType<unknown>[]]);
  }

  const type = schema.type;
  if (type === undefined) {
    return z.unknown();
  }

  const types = isJSONSchemaTypeArray(type) ? type : [type];
  if (types.length === 0) return z.unknown();

  const unionSchemas = types.map((t) => {
    switch (t) {
      case 'string':
        return z.string();
      case 'number':
        return z.number();
      case 'integer':
        return z.number().int();
      case 'boolean':
        return z.boolean();
      case 'array':
        if (!schema.items) {
          throw new UnsupportedSchemaError('array without items is not supported');
        }
        return z.array(schemaToZod(schema.items));
      case 'object':
        return buildObjectSchema(schema);
      case 'null':
        return z.null();
      default:
        throw new UnsupportedSchemaError(`Unsupported JSON Schema type: ${String(t)}`);
    }
  });

  if (unionSchemas.length === 1) return unionSchemas[0]!;
  return z.union(unionSchemas as [z.ZodType<unknown>, z.ZodType<unknown>, ...z.ZodType<unknown>[]]);
}

function buildObjectSchema(schema: JSONSchema): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType<unknown>> = {};
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  for (const [key, propSchema] of Object.entries(properties)) {
    const base = schemaToZod(propSchema);
    shape[key] = required.has(key) ? base : base.optional();
  }

  const obj = z.strictObject(shape);
  // additionalProperties:true is unsafe; only false or absent (default) is allowed.
  if (schema.additionalProperties === true) {
    throw new UnsupportedSchemaError('additionalProperties: true is not supported');
  }
  return obj;
}

/**
 * Build a runtime argument decoder from a JSON Schema object definition.
 * Throws UnsupportedSchemaError for unsupported constructs instead of falling
 * back to an open validator. The root schema must be a plain object type.
 */
export function buildArgsDecoder(
  parameters: Record<string, unknown>,
): (raw: Record<string, unknown>) => Record<string, unknown> {
  const root = parameters as JSONSchema;
  assertSupported(root);
  if (root.type !== 'object') {
    throw new UnsupportedSchemaError('root schema must have type "object"');
  }
  const schema = buildObjectSchema(root);
  return (raw: Record<string, unknown>) => schema.parse(raw) as Record<string, unknown>;
}
