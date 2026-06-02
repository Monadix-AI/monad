// GENERATED from apps/mo/assets/atlas.json by scripts/gen-mo-atlas.ts — DO NOT EDIT.
// Regenerate with `bun run scripts/gen-mo-atlas.ts` (postinstall and build-release run it automatically).
//
// Codex atlas-pet layout: the sheet (assets/mochi.png) is a columns×rows grid of MO_CELL_W×MO_CELL_H
// RGBA cells on a transparent background; each row is one agent-lifecycle state, frames packed
// left-aligned. The mo_state enum order IS the atlas row order, so a state value is its row index.

#ifndef MO_ATLAS_H
#define MO_ATLAS_H

#include "behavior.h"

#define MO_ATLAS_COLS 8
#define MO_ATLAS_ROWS 9
#define MO_CELL_W 192
#define MO_CELL_H 208

typedef struct {
  int frames;  // used cells in this row (left-aligned)
  double fps;  // playback rate for this row
} mo_atlas_row;

static const mo_atlas_row MO_ATLAS[MO_ATLAS_ROWS] = {
  [MO_IDLE] = {6, 4.0},
  [MO_RUNNING_RIGHT] = {8, 10.0},
  [MO_RUNNING_LEFT] = {8, 10.0},
  [MO_WAVING] = {4, 8.0},
  [MO_JUMPING] = {5, 10.0},
  [MO_FAILED] = {8, 9.0},
  [MO_WAITING] = {6, 6.0},
  [MO_RUNNING] = {6, 10.0},
  [MO_REVIEW] = {6, 7.0},
};

#endif
