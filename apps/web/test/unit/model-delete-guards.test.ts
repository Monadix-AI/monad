import type { Agent, ProfileView, ProviderView } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { ModelProviderType } from '@monad/protocol';

import { profileDeleteBlock, providerDeleteBlock } from '../../components/studio/ModelSettings/delete-guards';

const provider = (id: string): ProviderView => ({ id, label: id, type: ModelProviderType.OpenAICompatible });
const profile = (alias: string, providerId = 'p'): ProfileView => ({
  alias,
  routes: { chat: { provider: providerId, modelId: 'm' } },
  params: {},
  fallbacks: []
});
const agent = (
  name: string,
  model: Partial<Pick<Agent, 'model' | 'modelAlias'>>
): Pick<Agent, 'model' | 'modelAlias' | 'name'> => ({
  name,
  ...model
});

test('provider delete is blocked when a profile uses that provider', () => {
  expect(providerDeleteBlock(provider('p'), [profile('default', 'p')])).toEqual({
    kind: 'profile',
    alias: 'default'
  });
  expect(providerDeleteBlock(provider('unused'), [profile('default', 'p')])).toBeNull();
});

test('profile delete is blocked for protected or agent-used profiles', () => {
  const profiles = [profile('default'), profile('research'), profile('writer')];

  expect(profileDeleteBlock(profile('default'), profiles, [], 'default')).toEqual({ kind: 'default-profile' });
  expect(profileDeleteBlock(profile('default'), profiles, [], 'research')).toBeNull();
  expect(profileDeleteBlock(profile('research'), [profile('research')], [], 'default')).toEqual({
    kind: 'single-profile'
  });
  expect(
    profileDeleteBlock(profile('research'), profiles, [agent('Researcher', { modelAlias: 'research' })], 'default')
  ).toEqual({
    kind: 'agent',
    name: 'Researcher'
  });
  expect(profileDeleteBlock(profile('writer'), profiles, [agent('Writer', { model: 'writer' })], 'default')).toEqual({
    kind: 'agent',
    name: 'Writer'
  });
  expect(
    profileDeleteBlock(profile('writer'), profiles, [agent('Inherited', { model: 'inherit' })], 'default')
  ).toBeNull();
});
