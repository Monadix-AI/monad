import { expect, test } from 'bun:test';

import { compileMcpInputSchema } from '#/capabilities/tools/registry/mcp/schema-validator.ts';

test('MCP schema validator supports JSON Schema 2020-12 local references', () => {
  const compiled = compileMcpInputSchema({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { count: { $ref: '#/$defs/positiveInteger' } },
    required: ['count'],
    additionalProperties: false,
    $defs: {
      positiveInteger: { type: 'integer', minimum: 1 }
    }
  });

  expect({
    compileError: compiled.error,
    valid: compiled.validate?.({ count: 2 }),
    invalid: compiled.validate?.({ count: 0 })
  }).toEqual({
    compileError: undefined,
    valid: { valid: true, data: { count: 2 }, errorMessage: undefined },
    invalid: {
      valid: false,
      data: undefined,
      errorMessage: 'data/count must be >= 1'
    }
  });
});

test('MCP schema validator rejects remote references and unsafe regular expressions before compilation', () => {
  const remote = compileMcpInputSchema({
    type: 'object',
    properties: { value: { $ref: 'https://attacker.example/schema.json' } }
  });
  const unsafePattern = compileMcpInputSchema({
    type: 'object',
    properties: { value: { type: 'string', pattern: '(a+)+$' } }
  });

  expect({
    remote: remote.error,
    unsafePattern: unsafePattern.error
  }).toEqual({
    remote: 'tool input schema contains a remote reference',
    unsafePattern: 'tool input schema contains an unsafe regular expression'
  });
});
