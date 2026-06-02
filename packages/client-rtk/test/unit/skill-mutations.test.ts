import type { MonadClient } from '@monad/client';
import type { AgentId } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { createMonadStore, monadApi } from '../../src/index.ts';

type LooseEndpoint = { initiate: (arg?: unknown) => unknown };
type MutationResult<T> = Promise<unknown> & { unwrap(): Promise<T> };

function endpoint(name: string): LooseEndpoint {
  const value = (monadApi.endpoints as Record<string, LooseEndpoint | undefined>)[name];
  if (!value) throw new Error(`missing endpoint: ${name}`);
  return value;
}

test('Skill mutations pass an Agent target through GitHub, upload, and editor creation', async () => {
  const agentId = 'agt_100000000000' as AgentId;
  const calls: unknown[] = [];
  const client = {
    treaty: {
      v1: {
        atoms: {
          skills: Object.assign(
            {
              post: async (body: unknown) => {
                calls.push({ kind: 'create', body });
                return {
                  data: {
                    id: 'agent:private-agent:created-private',
                    name: 'created-private',
                    dir: '/agents/private-agent/skills/created-private',
                    warnings: []
                  },
                  status: 200
                };
              },
              install: {
                post: async (body: unknown) => {
                  calls.push({ kind: 'install', body });
                  return {
                    data: {
                      skills: ['github-private'],
                      skillIds: ['agent:private-agent:github-private'],
                      commit: 'a'.repeat(40),
                      warnings: []
                    },
                    status: 200
                  };
                }
              }
            },
            {}
          )
        }
      }
    },
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ kind: 'upload', url, body: init.body, contentType: new Headers(init.headers).get('content-type') });
      return Response.json({
        skills: ['uploaded-private'],
        skillIds: ['agent:private-agent:uploaded-private'],
        commit: '',
        warnings: []
      });
    },
    subscribeControl: () => () => {},
    streamEvents: () => () => {},
    streamMessageGeneration: () => () => {}
  } as unknown as MonadClient;
  const store = createMonadStore({ client });
  const target = { kind: 'agent' as const, agentId };
  const uploadBody = new Blob(['skill']);

  await (
    store.dispatch(
      endpoint('installSkill').initiate({ source: 'github:example/skills@main', consent: true, target }) as never
    ) as MutationResult<unknown>
  ).unwrap();
  await (
    store.dispatch(
      endpoint('uploadSkill').initiate({
        filename: 'skill.zip',
        body: uploadBody,
        contentType: 'application/zip',
        target
      }) as never
    ) as MutationResult<unknown>
  ).unwrap();
  await (
    store.dispatch(
      endpoint('createSkill').initiate({
        name: 'created-private',
        content: '---\nname: created-private\ndescription: Private\n---\n',
        target
      }) as never
    ) as MutationResult<unknown>
  ).unwrap();

  expect(calls).toEqual([
    {
      kind: 'install',
      body: {
        source: 'github:example/skills@main',
        consent: true,
        overwrite: false,
        target
      }
    },
    {
      kind: 'upload',
      url: `/v1/atoms/skills/upload?filename=skill.zip&overwrite=false&agentId=${agentId}`,
      body: uploadBody,
      contentType: 'application/zip'
    },
    {
      kind: 'create',
      body: {
        name: 'created-private',
        content: '---\nname: created-private\ndescription: Private\n---\n',
        target
      }
    }
  ]);
});
