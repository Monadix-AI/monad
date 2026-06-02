// Thin daemon client for the Mo sprite. Talks to the local monad daemon over its Unix socket
// using libcurl. Only the HTTP calls (drop, web-url) live here; health + event delivery run over
// a persistent WebSocket handled natively in mo.m (NSURLSessionWebSocketTask).

#ifndef MO_DAEMON_H
#define MO_DAEMON_H

#include <stdbool.h>

// Process-wide curl setup/teardown. Call once at startup / before exit.
void mo_daemon_init(void);
void mo_daemon_shutdown(void);

// Fetch the daemon-reported web UI URL (GET /v1/mo/status → "webUrl"). On success writes the URL
// into `out` (caller-sized) and returns true. Used to open the web UI when the user clicks Mo.
bool mo_daemon_web_url(char *out, int out_len);

// POST /v1/mo/drop with the given absolute paths + optional prompt. On success writes the
// new session id into `out_session` (caller-sized buffer) and returns true. `prompt` may be
// NULL/empty.
bool mo_daemon_drop(const char *const *paths, int path_count, const char *prompt,
                    char *out_session, int out_session_len);

#endif
