#include "behavior.h"

// Timings (seconds).
#define MO_JUMP_DUR 0.6        // playful "caught it" hop after a drop / a fidget hop
#define MO_WAVE_DUR 1.2        // a greeting / fidget wave
#define MO_FAILED_DUR 3.0      // failed-drop sulk (a daemon outage keeps FAILED via the level check)
#define MO_GREETING_DUR 1.6    // startup wave before settling in
#define MO_WAITING_MAX 8.0     // give up waiting for the agent and fall back to idle
#define MO_IDLE_FIDGET 14.0    // after this long idle, do a random wave/jump fidget

void mo_behavior_init(mo_behavior *b, double now) {
  // Greet on startup: open with a wave, then settle. anim_until makes it play to completion before
  // any level state (idle/failed/etc.) takes over.
  b->state = MO_WAVING;
  b->since = now;
  b->anim_until = now + MO_GREETING_DUR;
  b->awaiting = false;
  b->awaiting_since = now;
  b->rng = (unsigned)now ^ 0x9e3779b9u;  // seed; exact value irrelevant, just needs to vary
}

static mo_state enter(mo_behavior *b, mo_state s, double now) {
  if (b->state != s) {
    b->state = s;
    b->since = now;
  }
  return s;
}

// xorshift-ish LCG; we only need a low-quality bit to pick between two fidgets.
static unsigned rng_next(mo_behavior *b) {
  b->rng = b->rng * 1103515245u + 12345u;
  return b->rng >> 16;
}

mo_state mo_behavior_step(mo_behavior *b, const mo_sensors *s, mo_event ev) {
  // Edge events start a short, uninterruptible animation.
  if (ev == MO_EV_DROP) {
    b->anim_until = s->now + MO_JUMP_DUR;  // "catch it" hop
    return enter(b, MO_JUMPING, s->now);
  }
  if (ev == MO_EV_DROP_FAIL) {
    b->anim_until = s->now + MO_FAILED_DUR;
    return enter(b, MO_FAILED, s->now);
  }
  if (ev == MO_EV_DROP_OK) {
    b->awaiting = true;
    b->awaiting_since = s->now;
    // keep playing the current animation; the awaiting/running path takes over once it finishes
  }

  // A playful, uninterruptible animation (drop hop, startup greeting, idle fidget) plays to its end.
  if (s->now < b->anim_until) return b->state;

  // ── Level states, highest priority first ─────────────────────────────────────
  // A file hovering over Mo (pre-drop) → wave it in.
  if (s->file_hovering) return enter(b, MO_WAVING, s->now);

  // Daemon offline → failed, sticky until it returns.
  if (!s->daemon_ok) return enter(b, MO_FAILED, s->now);

  // The prompt input box is open after a drop → wait attentively for the user to type.
  if (s->input_open) return enter(b, MO_WAITING, s->now);

  // Agent activity on the seeded session: reasoning → review pose, text/tool work → running.
  if (s->activity == MO_ACT_REASONING) {
    b->awaiting = false;
    return enter(b, MO_REVIEW, s->now);
  }
  if (s->activity == MO_ACT_GENERATING) {
    b->awaiting = false;
    return enter(b, MO_RUNNING, s->now);
  }

  // Seeded a session, waiting for the agent to pick it up.
  if (b->awaiting) {
    if (s->now - b->awaiting_since < MO_WAITING_MAX) return enter(b, MO_WAITING, s->now);
    b->awaiting = false;
  }

  // The user is dragging Mo's window → directional run.
  if (s->user_dragging) {
    return enter(b, s->drag_dx >= 0 ? MO_RUNNING_RIGHT : MO_RUNNING_LEFT, s->now);
  }

  // Idle. After a quiet spell, do a random wave/jump fidget, then fall back to idle (which restarts
  // the timer for the next one).
  if (b->state == MO_IDLE && s->now - b->since > MO_IDLE_FIDGET) {
    if (rng_next(b) & 1) {
      b->anim_until = s->now + MO_WAVE_DUR;
      return enter(b, MO_WAVING, s->now);
    }
    b->anim_until = s->now + MO_JUMP_DUR;
    return enter(b, MO_JUMPING, s->now);
  }
  return enter(b, MO_IDLE, s->now);
}
