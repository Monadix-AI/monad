import { join } from 'node:path';

import { SCHEMA_CONTENT } from '../src/config/index.ts';

// Dev convenience: materialize the editor-facing schema file. Content is the single source of
// truth in config.ts (derived from the zod schema), so this file can never drift from the binary.
const outPath = join(import.meta.dir, '..', 'config.schema.json');
await Bun.write(outPath, `${SCHEMA_CONTENT}\n`);
