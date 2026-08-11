#!/usr/bin/env bun

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { stagePublicReleaseAssets } from './lib/public-release-assets.ts';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    from: { type: 'string' },
    to: { type: 'string' }
  },
  strict: true
});

if (!values.from || !values.to) {
  throw new Error('usage: stage-public-release-assets.ts --from <artifact-dir> --to <public-dir>');
}

const sourceDir = resolve(values.from);
const destinationDir = resolve(values.to);
const assets = await stagePublicReleaseAssets(sourceDir, destinationDir);
process.stdout.write(`Staged ${assets.length} public release assets in ${destinationDir}\n`);
