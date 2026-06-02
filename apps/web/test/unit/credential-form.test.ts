import { expect, test } from 'bun:test';

import {
  type CredentialFormState,
  createCredentialRequest,
  parseAllowedHosts,
  updateCredentialRequest,
  validateCredentialForm
} from '../../src/features/studio/credentials-settings/credential-form';

const form = (patch: Partial<CredentialFormState> = {}): CredentialFormState => ({
  label: 'Primary API',
  description: 'Read metrics',
  environmentVariable: 'PRIMARY_API_TOKEN',
  allowedHosts: 'API.Example.com,\nmetrics.example.com',
  secret: 'secret-canary',
  secretAction: 'replace',
  ...patch
});

test('Credential form canonicalizes comma and newline host input', () => {
  expect(parseAllowedHosts('API.Example.com,\nmetrics.example.com, api.example.com')).toEqual([
    'api.example.com',
    'metrics.example.com'
  ]);
  expect(createCredentialRequest(form())).toEqual({
    label: 'Primary API',
    description: 'Read metrics',
    environmentVariable: 'PRIMARY_API_TOKEN',
    allowedHosts: ['api.example.com', 'metrics.example.com'],
    secret: 'secret-canary'
  });
});

test('Credential form rejects invalid environment variables and URL-like hosts', () => {
  expect(validateCredentialForm(form({ environmentVariable: 'bad-name' }), false)).toEqual({
    environmentVariable: 'invalid'
  });
  expect(validateCredentialForm(form({ allowedHosts: 'https://api.example.com/path' }), false)).toEqual({
    allowedHosts: 'invalid'
  });
});

test('Credential edits emit keep, explicit replace, and explicit remove semantics', () => {
  expect(updateCredentialRequest(form({ secretAction: 'keep', secret: '' }))).toEqual({
    label: 'Primary API',
    description: 'Read metrics',
    environmentVariable: 'PRIMARY_API_TOKEN',
    allowedHosts: ['api.example.com', 'metrics.example.com']
  });
  expect(updateCredentialRequest(form({ secretAction: 'replace', secret: 'replacement' })).secret).toEqual({
    action: 'replace',
    value: 'replacement'
  });
  expect(updateCredentialRequest(form({ secretAction: 'remove', secret: '' })).secret).toEqual({ action: 'remove' });
});
