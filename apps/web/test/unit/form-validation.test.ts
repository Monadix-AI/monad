import { expect, test } from 'bun:test';

import { daemonConnectionFormSchema, mcpServerFormSchema, providerFormSchema } from '../../src/lib/form-validation.ts';

test('provider form requires and normalizes baseUrl only when the provider needs one', () => {
  expect(providerFormSchema(false).parse({ type: 'anthropic', baseUrl: '' })).toEqual({
    type: 'anthropic',
    baseUrl: ''
  });

  expect(
    providerFormSchema(true).parse({ type: 'openai-compatible', baseUrl: '  http://localhost:11434/v1  ' })
  ).toEqual({
    type: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1'
  });

  expect(() => providerFormSchema(true).parse({ type: 'openai-compatible', baseUrl: 'ftp://example.com' })).toThrow();
});

test('MCP server form validates URL only for HTTP transport', () => {
  expect(
    mcpServerFormSchema.parse({
      name: 'shell',
      transport: 'stdio',
      command: 'npx',
      args: '',
      cwd: '',
      env: '',
      url: ''
    })
  ).toMatchObject({ transport: 'stdio', command: 'npx' });

  expect(
    mcpServerFormSchema.parse({
      name: 'remote',
      transport: 'http',
      command: '',
      args: '',
      cwd: '',
      env: '',
      url: ' https://mcp.example.com/mcp '
    })
  ).toMatchObject({ transport: 'http', url: 'https://mcp.example.com/mcp' });

  expect(() =>
    mcpServerFormSchema.parse({
      name: 'bad',
      transport: 'http',
      command: '',
      args: '',
      cwd: '',
      env: '',
      url: 'javascript:alert(1)'
    })
  ).toThrow();
});

test('daemon connection form allows local blank and validates non-empty remote URLs', () => {
  expect(daemonConnectionFormSchema.parse({ url: '', token: '  ' })).toEqual({ url: '', token: '' });
  expect(daemonConnectionFormSchema.parse({ url: ' https://127.0.0.1:52749 ', token: ' abc ' })).toEqual({
    url: 'https://127.0.0.1:52749',
    token: 'abc'
  });
  expect(() => daemonConnectionFormSchema.parse({ url: 'file:///tmp/socket', token: '' })).toThrow();
});
