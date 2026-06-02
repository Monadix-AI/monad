import { expect, test } from 'bun:test';

import { McpUrlCompletionRegistry } from '#/capabilities/tools/registry/mcp';
import { fulfillElicitation, fulfillElicitationRequests } from '#/capabilities/tools/registry/mcp/elicitation';

test('fulfillElicitation preserves primitive JSON Schema value types', async () => {
  const prompts: unknown[] = [];
  const result = await fulfillElicitation(
    {
      mode: 'form',
      message: 'Deployment settings',
      requestedSchema: {
        type: 'object',
        properties: {
          environment: { type: 'string', enum: ['Staging', 'Production'], title: 'Environment' },
          approved: { type: 'boolean', title: 'Approved' },
          replicas: { type: 'integer', title: 'Replicas' },
          threshold: { type: 'number', title: 'Threshold' }
        }
      }
    },
    async (request) => {
      prompts.push(request);
      return {
        answer: JSON.stringify({ environment: 'Production', approved: true, replicas: 4, threshold: 0.75 }),
        status: 'answered'
      };
    },
    { serverName: 'deployments' }
  );

  expect({ prompts, result }).toEqual({
    prompts: [
      {
        question: 'Deployment settings',
        asker: { name: 'deployments' },
        form: {
          fields: [
            {
              name: 'environment',
              label: 'Environment',
              required: false,
              type: 'single-select',
              options: [
                { value: 'Staging', label: 'Staging' },
                { value: 'Production', label: 'Production' }
              ]
            },
            { name: 'approved', label: 'Approved', required: false, type: 'boolean' },
            { name: 'replicas', label: 'Replicas', required: false, type: 'integer' },
            { name: 'threshold', label: 'Threshold', required: false, type: 'number' }
          ]
        }
      }
    ],
    result: {
      action: 'accept',
      content: { environment: 'Production', approved: true, replicas: 4, threshold: 0.75 }
    }
  });
});

test('fulfillElicitation presents safe URL mode and rejects unsafe property names', async () => {
  const questions: Array<{ question: string; origin?: string }> = [];
  const urlResult = await fulfillElicitation(
    { mode: 'url', message: 'Complete authorization', url: 'https://example.com/authorize' },
    async ({ question, urlElicitation }) => {
      questions.push({ question, origin: urlElicitation?.origin });
      return { answer: urlElicitation ? 'Completed' : '', status: 'answered' };
    }
  );
  const formResult = await fulfillElicitation(
    {
      mode: 'form',
      requestedSchema: {
        type: 'object',
        properties: {
          __proto__: { type: 'string' },
          answer: { type: 'string' }
        }
      }
    },
    async () => ({ answer: JSON.stringify({ answer: 'safe' }), status: 'answered' })
  );

  expect({ questions, urlResult, formResult }).toEqual({
    questions: [
      {
        question: 'Complete authorization\n\nhttps://example.com/authorize',
        origin: 'https://example.com'
      }
    ],
    urlResult: { action: 'accept' },
    formResult: { action: 'accept', content: { answer: 'safe' } }
  });
});

test('fulfillElicitationRequests returns explicit decline responses for unsupported requests', async () => {
  const result = await fulfillElicitationRequests(
    {
      url: { method: 'elicitation/create', params: { mode: 'url', url: 'https://example.com' } },
      unsupported: { method: 'sampling/createMessage', params: {} }
    },
    async ({ urlElicitation }) => ({ answer: urlElicitation ? 'Completed' : '', status: 'answered' })
  );

  expect(result).toEqual({ url: { action: 'accept' } });
});

test('fulfillElicitation declines unsafe URL mode without prompting', async () => {
  let prompts = 0;
  const result = await fulfillElicitation({ mode: 'url', url: 'http://example.com/authorize' }, async () => {
    prompts += 1;
    return { answer: 'done', status: 'answered' };
  });

  expect({ prompts, result }).toEqual({ prompts: 0, result: { action: 'decline' } });
});

test('fulfillElicitation accepts the structured URL completion result and cancellation status', async () => {
  const accepted = await fulfillElicitation({ mode: 'url', url: 'https://example.com/authorize' }, async () => ({
    answer: 'done',
    status: 'answered'
  }));
  const cancelled = await fulfillElicitation({ mode: 'url', url: 'https://example.com/authorize' }, async () => ({
    answer: '',
    status: 'cancelled'
  }));

  expect({ accepted, cancelled }).toEqual({
    accepted: { action: 'accept' },
    cancelled: { action: 'cancel' }
  });
});

test('fulfillElicitation settles a URL request from its matching completion notification', async () => {
  const registry = new McpUrlCompletionRegistry();
  let settle: ((value: { answer: string; status: 'answered' }) => void) | undefined;
  let requestId: string | undefined;
  const pending = fulfillElicitation(
    { mode: 'url', url: 'https://example.com/authorize', elicitationId: 'elicit-1' },
    async (request) => {
      requestId = request.requestId;
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
    {
      registerUrlCompletion: (elicitationId, complete) => registry.register(elicitationId, complete),
      resolveClarification: async (resolvedRequestId, action) => {
        if (!requestId) throw new Error('URL clarification request id was not captured');
        expect({ action, resolvedRequestId }).toEqual({ action: 'complete', resolvedRequestId: requestId });
        settle?.({ answer: 'Completed', status: 'answered' });
        return true;
      }
    }
  );
  await Promise.resolve();
  await registry.complete('elicit-1');
  expect(await pending).toEqual({ action: 'accept' });
});

test('fulfillElicitation retries answers that violate declared scalar constraints', async () => {
  const answers = [JSON.stringify({ replicas: 1, label: 'too long' }), JSON.stringify({ replicas: 3, label: 'ok' })];
  const result = await fulfillElicitation(
    {
      mode: 'form',
      message: 'Release settings',
      requestedSchema: {
        type: 'object',
        properties: {
          replicas: { type: 'integer', minimum: 2, maximum: 5 },
          label: { type: 'string', minLength: 2, maxLength: 4 }
        }
      }
    },
    async () => ({ answer: answers.shift() ?? '', status: 'answered' })
  );

  expect(result).toEqual({ action: 'accept', content: { replicas: 3, label: 'ok' } });
});

test('fulfillElicitation preserves titled enums, defaults, formats, and required fields', async () => {
  let captured: unknown;
  const result = await fulfillElicitation(
    {
      mode: 'form',
      message: 'Profile',
      requestedSchema: {
        type: 'object',
        required: ['email', 'roles'],
        properties: {
          email: {
            type: 'string',
            title: 'Email',
            description: 'Work address',
            format: 'email',
            default: 'a@example.com'
          },
          plan: {
            type: 'string',
            oneOf: [
              { const: 'pro', title: 'Professional' },
              { const: 'free', title: 'Free' }
            ]
          },
          roles: {
            type: 'array',
            minItems: 1,
            items: { anyOf: [{ const: 'admin', title: 'Administrator' }] },
            default: ['admin']
          }
        }
      }
    },
    async (request) => {
      captured = request;
      return { answer: JSON.stringify({ email: 'a@example.com', plan: 'pro', roles: ['admin'] }), status: 'answered' };
    }
  );

  expect({ captured, result }).toEqual({
    captured: {
      question: 'Profile',
      form: {
        fields: [
          {
            name: 'email',
            label: 'Email',
            description: 'Work address',
            required: true,
            type: 'string',
            defaultValue: 'a@example.com',
            format: 'email'
          },
          {
            name: 'plan',
            label: 'plan',
            required: false,
            type: 'single-select',
            options: [
              { value: 'pro', label: 'Professional' },
              { value: 'free', label: 'Free' }
            ]
          },
          {
            name: 'roles',
            label: 'roles',
            required: true,
            type: 'multi-select',
            options: [{ value: 'admin', label: 'Administrator' }],
            defaultValue: ['admin'],
            minItems: 1
          }
        ]
      }
    },
    result: { action: 'accept', content: { email: 'a@example.com', plan: 'pro', roles: ['admin'] } }
  });
});

test('fulfillElicitation refuses sensitive credential fields before prompting', async () => {
  let prompts = 0;
  const result = await fulfillElicitation(
    {
      mode: 'form',
      requestedSchema: { type: 'object', properties: { apiKey: { type: 'string', title: 'API key' } } }
    },
    async () => {
      prompts += 1;
      return { answer: '{}', status: 'answered' };
    }
  );
  expect({ prompts, result }).toEqual({ prompts: 0, result: { action: 'decline' } });
});
