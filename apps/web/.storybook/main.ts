import type { StorybookConfig } from '@storybook/react-vite';

import { resolve } from 'node:path';

const APP_ROOT = resolve(import.meta.dirname, '..');
const REPO_ROOT = resolve(APP_ROOT, '../..');

const config: StorybookConfig = {
  framework: {
    name: '@storybook/react-vite',
    options: {}
  },
  stories: ['../stories/**/*.stories.@(ts|tsx)'],
  viteFinal: async (config) => ({
    ...config,
    define: {
      ...config.define,
      __MONAD_DEV_TOOL_PORTS__: JSON.stringify({}),
      __MONAD_WEB_PORT__: JSON.stringify('3000'),
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development')
    },
    resolve: {
      ...config.resolve,
      alias: {
        ...(Array.isArray(config.resolve?.alias) ? {} : config.resolve?.alias),
        '#': resolve(APP_ROOT, 'src'),
        '@monad/monad': resolve(REPO_ROOT, 'apps/monad/src/public-api.ts'),
        '@monad/monad/log-maintenance': resolve(REPO_ROOT, 'apps/monad/src/public-log-maintenance.ts'),
        '@monad/monad/start': resolve(REPO_ROOT, 'apps/monad/src/public-api.ts')
      }
    }
  })
};

export default config;
