#!/usr/bin/env bun
/**
 * Generate the Mo atlas tables from the single source of truth apps/mo/assets/atlas.json:
 *   - apps/mo/native/common/atlas.h      (compiled into both native shells — no C JSON dependency)
 *   - apps/web/lib/mo-atlas.ts            (the web preview's layout constants)
 *
 * Run by postinstall (scripts/setup-dev.ts) and build-release.ts before building Mo, so the C header and
 * the web constants never drift from the manifest. Do not hand-edit the generated files.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

// Write only when the content changed, so a no-op regen doesn't bump the file's mtime (which would
// trigger spurious Mo rebuilds in postinstall and dirty the working tree).
function writeIfChanged(path: string, content: string): void {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return;
  writeFileSync(path, content);
}

interface AtlasState {
  state: string;
  row: number;
  frames: number;
  fps: number;
}
interface Atlas {
  columns: number;
  rows: number;
  cell_width: number;
  cell_height: number;
  states: AtlasState[];
}

const atlas = JSON.parse(readFileSync(join(ROOT, 'apps/mo/assets/atlas.json'), 'utf8')) as Atlas;

// idle → MO_IDLE, running-right → MO_RUNNING_RIGHT (matches the mo_state enum in behavior.h).
const enumName = (state: string): string => `MO_${state.toUpperCase().replace(/-/g, '_')}`;

const headerRows = atlas.states.map((s) => `  [${enumName(s.state)}] = {${s.frames}, ${s.fps.toFixed(1)}},`).join('\n');

const headerOut = `// GENERATED from apps/mo/assets/atlas.json by scripts/gen-mo-atlas.ts — DO NOT EDIT.
// Regenerate with \`bun run scripts/gen-mo-atlas.ts\` (postinstall and build-release run it automatically).
//
// Codex atlas-pet layout: the sheet (assets/mochi.png) is a columns×rows grid of MO_CELL_W×MO_CELL_H
// RGBA cells on a transparent background; each row is one agent-lifecycle state, frames packed
// left-aligned. The mo_state enum order IS the atlas row order, so a state value is its row index.

#ifndef MO_ATLAS_H
#define MO_ATLAS_H

#include "behavior.h"

#define MO_ATLAS_COLS ${atlas.columns}
#define MO_ATLAS_ROWS ${atlas.rows}
#define MO_CELL_W ${atlas.cell_width}
#define MO_CELL_H ${atlas.cell_height}

typedef struct {
  int frames;  // used cells in this row (left-aligned)
  double fps;  // playback rate for this row
} mo_atlas_row;

static const mo_atlas_row MO_ATLAS[MO_ATLAS_ROWS] = {
${headerRows}
};

#endif
`;
writeIfChanged(join(ROOT, 'apps/mo/native/common/atlas.h'), headerOut);

const tsStates = atlas.states
  .map((s) => `    { state: '${s.state}', row: ${s.row}, frames: ${s.frames}, fps: ${s.fps} }`)
  .join(',\n');

const tsOut = `// GENERATED from apps/mo/assets/atlas.json by scripts/gen-mo-atlas.ts — DO NOT EDIT.
// Regenerate with \`bun run scripts/gen-mo-atlas.ts\`. Shares the manifest the native shells compile in.

export interface MoAtlasState {
  state: string;
  row: number;
  frames: number;
  fps: number;
}

export const MO_ATLAS = {
  cols: ${atlas.columns},
  rows: ${atlas.rows},
  cellW: ${atlas.cell_width},
  cellH: ${atlas.cell_height},
  states: [
${tsStates}
  ] as MoAtlasState[]
};
`;
writeIfChanged(join(ROOT, 'apps/web/lib/mo-atlas.ts'), tsOut);

process.stdout.write('[gen-mo-atlas] wrote apps/mo/native/common/atlas.h + apps/web/lib/mo-atlas.ts\n');
