import { join } from 'node:path';

import {
  AGENTS_SCHEMA_CONTENT,
  AUTH_SCHEMA_CONTENT,
  CONFIG_SCHEMA_CONTENT,
  MESH_SCHEMA_CONTENT
} from '../src/config/index.ts';

const schemas = {
  agents: AGENTS_SCHEMA_CONTENT,
  auth: AUTH_SCHEMA_CONTENT,
  config: CONFIG_SCHEMA_CONTENT,
  mesh: MESH_SCHEMA_CONTENT
};

await Promise.all(
  Object.entries(schemas).map(async ([name, content]) => {
    await Bun.write(join(import.meta.dir, '..', `${name}.schema.json`), `${content}\n`);
  })
);
