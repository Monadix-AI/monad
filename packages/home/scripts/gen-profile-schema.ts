import { join } from 'node:path';

import { PROFILE_SCHEMA_CONTENT } from '../src/config/index.ts';

// Dev convenience: materialize the editor-facing schema file. Content is the single source of
// truth in config.ts (derived from the zod schema), so this file can never drift from the binary.
const outPath = join(import.meta.dir, '..', 'profile.schema.json');
await Bun.write(outPath, `${PROFILE_SCHEMA_CONTENT}\n`);
