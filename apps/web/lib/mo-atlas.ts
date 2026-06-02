// GENERATED from apps/mo/assets/atlas.json by scripts/gen-mo-atlas.ts — DO NOT EDIT.
// Regenerate with `bun run scripts/gen-mo-atlas.ts`. Shares the manifest the native shells compile in.

export interface MoAtlasState {
  state: string;
  row: number;
  frames: number;
  fps: number;
}

export const MO_ATLAS = {
  cols: 8,
  rows: 9,
  cellW: 192,
  cellH: 208,
  states: [
    { state: 'idle', row: 0, frames: 6, fps: 4 },
    { state: 'running-right', row: 1, frames: 8, fps: 10 },
    { state: 'running-left', row: 2, frames: 8, fps: 10 },
    { state: 'waving', row: 3, frames: 4, fps: 8 },
    { state: 'jumping', row: 4, frames: 5, fps: 10 },
    { state: 'failed', row: 5, frames: 8, fps: 9 },
    { state: 'waiting', row: 6, frames: 6, fps: 6 },
    { state: 'running', row: 7, frames: 6, fps: 10 },
    { state: 'review', row: 8, frames: 6, fps: 7 }
  ] as MoAtlasState[]
};
