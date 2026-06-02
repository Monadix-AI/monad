// Bridges a Tool's inputSchema to the JSON Schema the model sees for native function-calling.
// Built-in @/capabilities/tools assign raw zod schemas; agent-core's own tools hand-roll a
// ToolInputSchema with an explicit toJsonSchema(). Resolution order: an explicit
// toJsonSchema() wins (non-zod opt-in), else a zod schema is auto-converted, else the tool
// exposes no parameters. `inputExamples` ride along as the schema's `examples`.

import type { Tool } from '@/capabilities/tools/types.ts';

import { z } from 'zod';

export function toolInputJsonSchema(tool: Tool): Record<string, unknown> | undefined {
  const schema = tool.inputSchema;
  if (!schema) return undefined;

  let json: Record<string, unknown> | undefined;
  if (typeof schema.toJsonSchema === 'function') {
    json = schema.toJsonSchema();
  } else {
    // Raw zod schema (the @/capabilities/tools convention). z.toJSONSchema throws on a non-zod
    // object, so a hand-rolled schema without toJsonSchema() simply yields no parameters.
    try {
      json = z.toJSONSchema(schema as unknown as z.ZodType, {
        unrepresentable: 'any',
        target: 'draft-07'
      }) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  if (json && tool.inputExamples?.length && json.examples === undefined) {
    json = { ...json, examples: tool.inputExamples };
  }
  return json;
}
