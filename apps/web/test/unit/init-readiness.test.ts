import type { GetInitStatusResponse } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  isRuntimeIncomplete,
  isRuntimeReady,
  runtimeDisabledSectionIds,
  runtimeSectionEnabled
} from '../../features/init/init-readiness';

const completeStatus: GetInitStatusResponse = {
  initialized: true,
  missing: [],
  homePath: '/tmp/monad'
};

function statusWithMissing(missing: GetInitStatusResponse['missing']): GetInitStatusResponse {
  return {
    initialized: false,
    missing,
    homePath: '/tmp/monad'
  };
}

test('runtime readiness follows init status initialized exactly', () => {
  expect(isRuntimeReady(completeStatus)).toBe(true);
  expect(isRuntimeReady(statusWithMissing(['provider']))).toBe(false);
});

test('runtime incomplete covers missing provider, credential, default, and agent states', () => {
  expect(isRuntimeIncomplete(statusWithMissing(['provider']))).toBe(true);
  expect(isRuntimeIncomplete(statusWithMissing(['credential']))).toBe(true);
  expect(isRuntimeIncomplete(statusWithMissing(['default']))).toBe(true);
  expect(isRuntimeIncomplete(statusWithMissing(['agent']))).toBe(true);
});

test('runtime overview stays enabled while the other runtime tabs disable until onboarding is complete', () => {
  expect(runtimeDisabledSectionIds).toEqual(['models', 'agents', 'capabilities', 'acpDelegates', 'memory', 'safety']);
  expect(runtimeSectionEnabled('runtime', false)).toBe(true);
  expect(runtimeSectionEnabled('models', false)).toBe(false);
  expect(runtimeSectionEnabled('nativeCliAgents', false)).toBe(true);
  expect(runtimeSectionEnabled('models', true)).toBe(true);
});
