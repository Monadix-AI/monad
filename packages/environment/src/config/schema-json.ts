import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toJSONSchema, z } from 'zod';

export function toMonadJsonSchema(schema: z.ZodType): string {
  const json = toJSONSchema(schema, { target: 'draft-07', io: 'input' }) as {
    $schema?: string;
    properties?: Record<string, unknown>;
  };
  json.$schema = 'http://json-schema.org/draft-07/schema#';
  if (json.properties) json.properties.$schema = { type: 'string' };
  return JSON.stringify(json, null, 2);
}

export function sourceSchemaUrl(fileName: string): string {
  return pathToFileURL(join(import.meta.dir, '..', '..', `${fileName}.schema.json`)).href;
}

export function runtimeSchemaUrl(runtimeDir: string, fileName: string): string {
  return pathToFileURL(join(runtimeDir, `${fileName}.schema.json`)).href;
}
