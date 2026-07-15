// Platform-independent behavior state machine for the Mo sprite. Each native shell (macOS/mo.m,
// Linux/mo.c) feeds it signals once per tick and renders the returned state by blitting the matching
// atlas row (see atlas.h). Platform-independent C (mirrors common/daemon.c) so both shells share
// identical behavior.
//
// The state set is the atlas-pet taxonomy — agent-lifecycle semantics, not generic animations.
// The enum order IS the atlas row order, so a state value doubles as its sprite-sheet row index.

#ifndef MO_BEHAVIOR_H
#define MO_BEHAVIOR_H

#include <stdbool.h>

typedef enum {
  MO_IDLE = 0,        // row 0 — calm resting / breathing / blinking
  MO_RUNNING_RIGHT,   // row 1 — dragged rightward
  MO_RUNNING_LEFT,    // row 2 — dragged leftward
  MO_WAVING,          // row 3 — greeting (startup), idle fidget, or a file hovering
  MO_JUMPING,         // row 4 — caught a dropped file, or an idle fidget hop
  MO_FAILED,          // row 5 — drop failed, or daemon unreachable
  MO_WAITING,         // row 6 — input box open / session seeded, awaiting input or the agent
  MO_RUNNING,         // row 7 — agent generating text or running a tool
  MO_REVIEW           // row 8 — agent reasoning (extended thinking)
} mo_state;

// What the subscribed session's SSE stream is currently doing (classified from event types in
// common/daemon.c). MO_ACT_NONE = idle / stream ended.
typedef enum { MO_ACT_NONE = 0, MO_ACT_REASONING, MO_ACT_GENERATING } mo_activity;

// Edge-triggered inputs: the shell passes one per step at the moment it happens, else MO_EV_NONE.
typedef enum { MO_EV_NONE, MO_EV_DROP, MO_EV_DROP_OK, MO_EV_DROP_FAIL } mo_event;

// Level inputs sampled fresh every tick.
typedef struct {
  double now;            // monotonic seconds (any epoch; only deltas matter)
  bool daemon_ok;        // GET /health succeeded
  mo_activity activity;  // current SSE activity (reasoning vs generating/tool), recency-gated by the shell
  bool file_hovering;    // a file is dragged over Mo, not yet dropped
  bool input_open;       // the post-drop prompt input box is open, awaiting the user's text
  bool user_dragging;    // the user is moving Mo's own window this tick
  double drag_dx;        // horizontal window delta this tick (sign picks running-right/left)
} mo_sensors;

typedef struct {
  mo_state state;
  double since;          // when the current state was entered
  double anim_until;     // a playful, uninterruptible animation (drop hop, greeting/fidget) plays until here
  bool awaiting;         // a drop seeded a session; waiting for the agent to start
  double awaiting_since;
  unsigned rng;          // tiny LCG state for picking idle fidgets (no libc rand dependency)
} mo_behavior;

void mo_behavior_init(mo_behavior *b, double now);

// Advance one tick; returns the state to render now.
mo_state mo_behavior_step(mo_behavior *b, const mo_sensors *s, mo_event ev);

#endif
