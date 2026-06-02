#include "daemon.h"

#include <curl/curl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Resolve the daemon's Unix socket. MO_DAEMON_SOCK (injected by the daemon when it launches Mo)
// is authoritative — it points at the exact daemon instance that started us. The MONAD_ROOT /
// $HOME fallbacks only matter for ad-hoc/legacy runs; normal launches always set MO_DAEMON_SOCK.
static void socket_path(char *buf, size_t len) {
  const char *sock = getenv("MO_DAEMON_SOCK");
  if (sock && *sock) {
    snprintf(buf, len, "%s", sock);
    return;
  }
  const char *root = getenv("MONAD_ROOT");
  if (root && *root) {
    snprintf(buf, len, "%s/run/monad.sock", root);
    return;
  }
  const char *home = getenv("HOME");
  snprintf(buf, len, "%s/.monad/run/monad.sock", home ? home : "");
}

struct response {
  char *data;
  size_t len;
};

static size_t collect(void *ptr, size_t size, size_t nmemb, void *userdata) {
  size_t total = size * nmemb;
  struct response *r = (struct response *)userdata;
  char *grown = realloc(r->data, r->len + total + 1);
  if (!grown) return 0;
  r->data = grown;
  memcpy(r->data + r->len, ptr, total);
  r->len += total;
  r->data[r->len] = '\0';
  return total;
}

// JSON-escape `in` into `out`. Keeps the wire body safe regardless of weird filenames.
static void json_escape(const char *in, char *out, size_t out_len) {
  size_t o = 0;
  for (size_t i = 0; in[i] && o + 7 < out_len; i++) {
    unsigned char c = (unsigned char)in[i];
    switch (c) {
      case '"': out[o++] = '\\'; out[o++] = '"'; break;
      case '\\': out[o++] = '\\'; out[o++] = '\\'; break;
      case '\n': out[o++] = '\\'; out[o++] = 'n'; break;
      case '\r': out[o++] = '\\'; out[o++] = 'r'; break;
      case '\t': out[o++] = '\\'; out[o++] = 't'; break;
      default:
        if (c < 0x20) { o += snprintf(out + o, out_len - o, "\\u%04x", c); }
        else { out[o++] = (char)c; }
    }
  }
  out[o] = '\0';
}

void mo_daemon_init(void) { curl_global_init(CURL_GLOBAL_DEFAULT); }
void mo_daemon_shutdown(void) { curl_global_cleanup(); }

// Pull a string field's value out of a JSON body without a JSON dependency: find "<field>", then
// the first "..." after the following colon. Values here (session ids, a URL) contain no escaped
// quotes, so a naive next-quote scan is sufficient.
static bool extract_string(const char *body, const char *field, char *out, int out_len) {
  char needle[64];
  snprintf(needle, sizeof(needle), "\"%s\"", field);
  const char *key = strstr(body, needle);
  if (!key) return false;
  const char *colon = strchr(key + strlen(needle), ':');
  if (!colon) return false;
  const char *q1 = strchr(colon, '"');
  if (!q1) return false;
  const char *q2 = strchr(q1 + 1, '"');
  if (!q2) return false;
  int n = (int)(q2 - q1 - 1);
  if (n <= 0 || n >= out_len) return false;
  memcpy(out, q1 + 1, n);
  out[n] = '\0';
  return true;
}

static bool extract_session(const char *body, char *out, int out_len) {
  return extract_string(body, "sessionId", out, out_len);
}

bool mo_daemon_web_url(char *out, int out_len) {
  char sock[1024];
  socket_path(sock, sizeof(sock));
  CURL *curl = curl_easy_init();
  if (!curl) return false;
  struct response resp = {0};
  curl_easy_setopt(curl, CURLOPT_UNIX_SOCKET_PATH, sock);
  curl_easy_setopt(curl, CURLOPT_URL, "http://localhost/v1/mo/status");
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, collect);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &resp);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, 1500L);
  CURLcode rc = curl_easy_perform(curl);
  long status = 0;
  curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
  curl_easy_cleanup(curl);
  bool ok = rc == CURLE_OK && status == 200 && resp.data && extract_string(resp.data, "webUrl", out, out_len);
  free(resp.data);
  return ok;
}

bool mo_daemon_drop(const char *const *paths, int path_count, const char *prompt,
                    char *out_session, int out_session_len) {
  char sock[1024];
  socket_path(sock, sizeof(sock));

  // Build {"paths":[...],"prompt":"..."} with each string JSON-escaped.
  size_t cap = 64;
  for (int i = 0; i < path_count; i++) cap += strlen(paths[i]) * 6 + 8;
  if (prompt) cap += strlen(prompt) * 6 + 16;
  char *json = malloc(cap);
  if (!json) return false;
  // One reusable escape buffer sized for the largest field (each byte → ≤6 chars: \uXXXX). A fixed
  // buffer would silently truncate paths/prompts that are long but still within the daemon's limits.
  size_t maxin = prompt ? strlen(prompt) : 0;
  for (int i = 0; i < path_count; i++) {
    size_t l = strlen(paths[i]);
    if (l > maxin) maxin = l;
  }
  const size_t esc_len = maxin * 6 + 8;
  char *esc = malloc(esc_len);
  if (!esc) {
    free(json);
    return false;
  }
  size_t o = (size_t)snprintf(json, cap, "{\"paths\":[");
  for (int i = 0; i < path_count; i++) {
    json_escape(paths[i], esc, esc_len);
    o += (size_t)snprintf(json + o, cap - o, "%s\"%s\"", i ? "," : "", esc);
  }
  o += (size_t)snprintf(json + o, cap - o, "]");
  if (prompt && *prompt) {
    json_escape(prompt, esc, esc_len);
    o += (size_t)snprintf(json + o, cap - o, ",\"prompt\":\"%s\"", esc);
  }
  snprintf(json + o, cap - o, "}");
  free(esc);

  CURL *curl = curl_easy_init();
  if (!curl) { free(json); return false; }
  struct response resp = {0};
  struct curl_slist *headers = curl_slist_append(NULL, "content-type: application/json");
  curl_easy_setopt(curl, CURLOPT_UNIX_SOCKET_PATH, sock);
  curl_easy_setopt(curl, CURLOPT_URL, "http://localhost/v1/mo/drop");
  curl_easy_setopt(curl, CURLOPT_POSTFIELDS, json);
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, collect);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &resp);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, 8000L);
  CURLcode rc = curl_easy_perform(curl);
  long status = 0;
  curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);

  bool ok = rc == CURLE_OK && status == 200 && resp.data &&
            extract_session(resp.data, out_session, out_session_len);

  curl_slist_free_all(headers);
  curl_easy_cleanup(curl);
  free(resp.data);
  free(json);
  return ok;
}
