import { fileURLToPath } from 'node:url';
import { Generator, getConfig } from '@tanstack/router-generator';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = getConfig(
  {
    generatedRouteTree: './src/routeTree.gen.ts',
    routesDirectory: './src/routes',
    target: 'react'
  },
  root
);

await new Generator({ config, root }).run();
