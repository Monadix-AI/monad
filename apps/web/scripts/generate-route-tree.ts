import { Generator, getConfig } from '@tanstack/router-generator';

const root = new URL('..', import.meta.url).pathname;
const config = getConfig(
  {
    generatedRouteTree: './src/routeTree.gen.ts',
    routesDirectory: './src/routes',
    target: 'react'
  },
  root
);

await new Generator({ config, root }).run();
