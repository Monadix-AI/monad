import type { JsonSchemaType, JsonSchemaValidator } from '@modelcontextprotocol/client';

import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import safeRegex from 'safe-regex2';

const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 2048;
const MAX_PATTERN_LENGTH = 512;
const MAX_ERROR_LENGTH = 2048;

const validatorProvider = new AjvJsonSchemaValidator();

export interface CompiledMcpInputSchema {
  error?: string;
  validate?: JsonSchemaValidator<Record<string, unknown>>;
}

export function compileMcpInputSchema(schema: Record<string, unknown>): CompiledMcpInputSchema {
  try {
    assertBoundedSchema(schema);
    return {
      validate: validatorProvider.getValidator<Record<string, unknown>>(schema as JsonSchemaType)
    };
  } catch (error) {
    return { error: boundedMessage(error) };
  }
}

function assertBoundedSchema(schema: Record<string, unknown>): void {
  const serialized = JSON.stringify(schema);
  if (Buffer.byteLength(serialized) > MAX_SCHEMA_BYTES) {
    throw new Error(`tool input schema exceeds ${MAX_SCHEMA_BYTES} bytes`);
  }
  const seen = new Set<object>();
  const stack: Array<{ depth: number; value: unknown }> = [{ depth: 0, value: schema }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop() as { depth: number; value: unknown };
    if (current.depth > MAX_SCHEMA_DEPTH) throw new Error(`tool input schema exceeds depth ${MAX_SCHEMA_DEPTH}`);
    if (!current.value || typeof current.value !== 'object') continue;
    if (seen.has(current.value)) throw new Error('tool input schema contains a cycle');
    seen.add(current.value);
    nodes += 1;
    if (nodes > MAX_SCHEMA_NODES) throw new Error(`tool input schema exceeds ${MAX_SCHEMA_NODES} nodes`);
    for (const [key, child] of Object.entries(current.value)) {
      if ((key === '$ref' || key === '$dynamicRef') && typeof child === 'string' && !child.startsWith('#')) {
        throw new Error('tool input schema contains a remote reference');
      }
      if (key === 'pattern' && typeof child === 'string') assertSafePattern(child);
      if (key === 'patternProperties' && child && typeof child === 'object' && !Array.isArray(child)) {
        for (const pattern of Object.keys(child)) assertSafePattern(pattern);
      }
      if (child && typeof child === 'object') stack.push({ depth: current.depth + 1, value: child });
    }
  }
}

function assertSafePattern(pattern: string): void {
  if (pattern.length > MAX_PATTERN_LENGTH)
    throw new Error(`tool input schema pattern exceeds ${MAX_PATTERN_LENGTH} characters`);
  if (!safeRegex(pattern)) throw new Error('tool input schema contains an unsafe regular expression');
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= MAX_ERROR_LENGTH ? message : `${message.slice(0, MAX_ERROR_LENGTH)}…`;
}
