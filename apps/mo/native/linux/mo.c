// Mo desktop sprite — Linux/GTK3 reference shell.
//
// A transparent, frameless, always-on-top window showing a pixel-art cat. Drag a file
// onto Mo to open a native input box; submitting POSTs the dropped paths + your text to
// the local daemon (POST /v1/mo/drop), which seeds a session. Mo polls the daemon health
// to switch between awake (idle/blink) and asleep (Zzz) animation.
//
// All business logic lives in the daemon; this shell only does windowing, drawing, file
// drops, and the two daemon calls in daemon.c. The "run toward the cursor while dragging"
// behaviour is a progressive enhancement gated on global input monitoring (X11/XInput2),
// which is not wired here — without it Mo simply waits to be dropped on, the path that is
// guaranteed to work on every platform.
//
// Build deps: libgtk-3-dev, libcurl4-openssl-dev. See build.sh.

#include "daemon.h"

#include <gtk/gtk.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MO_SIZE 96

typedef struct {
  GtkWidget *window;
  GtkWidget *area;
  gboolean awake;
  guint frame;          // animation tick for blink/eat
  gboolean working;     // a drop is being processed → "eat" animation
  char bubble[256];     // transient status text near the cat
  gint64 bubble_until;  // monotonic ms; 0 = hidden
} Mo;

// --- rendering ---------------------------------------------------------------
// Placeholder procedural cat drawn with Cairo. NOTE: the Linux shell is not yet wired to the shared
// behavior FSM or the Codex atlas (assets/mochi.png + common/atlas.h) — the macOS shell is the
// reference implementation. Follow-up: blit atlas cells per behavior.c state, as mo.m does.

static void draw_cat(cairo_t *cr, Mo *mo) {
  double cx = MO_SIZE / 2.0, cy = MO_SIZE / 2.0 + 6, r = 26;
  // body
  cairo_set_source_rgba(cr, 0.42, 0.45, 0.95, 1.0);
  cairo_arc(cr, cx, cy, r, 0, 2 * G_PI);
  cairo_fill(cr);
  // ears
  cairo_move_to(cr, cx - 18, cy - 16);
  cairo_line_to(cr, cx - 26, cy - 34);
  cairo_line_to(cr, cx - 6, cy - 22);
  cairo_close_path(cr);
  cairo_move_to(cr, cx + 18, cy - 16);
  cairo_line_to(cr, cx + 26, cy - 34);
  cairo_line_to(cr, cx + 6, cy - 22);
  cairo_close_path(cr);
  cairo_fill(cr);
  // eyes — closed when asleep, or a periodic blink when awake
  gboolean blink = !mo->awake || (mo->frame % 12 == 0);
  cairo_set_source_rgba(cr, 1, 1, 1, 1);
  if (blink) {
    cairo_set_line_width(cr, 2);
    cairo_move_to(cr, cx - 14, cy - 2); cairo_line_to(cr, cx - 4, cy - 2);
    cairo_move_to(cr, cx + 4, cy - 2);  cairo_line_to(cr, cx + 14, cy - 2);
    cairo_stroke(cr);
  } else {
    cairo_arc(cr, cx - 9, cy - 3, 4, 0, 2 * G_PI); cairo_fill(cr);
    cairo_arc(cr, cx + 9, cy - 3, 4, 0, 2 * G_PI); cairo_fill(cr);
  }
  // mouth: a small ":3" when working, else a dot
  cairo_set_source_rgba(cr, 1, 1, 1, 1);
  cairo_arc(cr, cx, cy + 8, mo->working ? 5 : 2, 0, mo->working ? G_PI : 2 * G_PI);
  cairo_fill(cr);
  // Zzz when asleep
  if (!mo->awake) {
    cairo_set_font_size(cr, 12);
    cairo_move_to(cr, cx + 18, cy - 28);
    cairo_show_text(cr, "z");
  }
}

static gboolean on_draw(GtkWidget *w, cairo_t *cr, gpointer data) {
  (void)w;
  Mo *mo = data;
  cairo_set_operator(cr, CAIRO_OPERATOR_CLEAR);
  cairo_paint(cr);
  cairo_set_operator(cr, CAIRO_OPERATOR_OVER);
  draw_cat(cr, mo);
  if (mo->bubble_until && g_get_monotonic_time() / 1000 < mo->bubble_until) {
    cairo_set_source_rgba(cr, 0, 0, 0, 0.72);
    cairo_rectangle(cr, 2, 2, MO_SIZE - 4, 16);
    cairo_fill(cr);
    cairo_set_source_rgba(cr, 1, 1, 1, 1);
    cairo_set_font_size(cr, 9);
    cairo_move_to(cr, 6, 14);
    cairo_show_text(cr, mo->bubble);
  }
  return FALSE;
}

static void set_bubble(Mo *mo, const char *text) {
  g_strlcpy(mo->bubble, text, sizeof(mo->bubble));
  mo->bubble_until = g_get_monotonic_time() / 1000 + 4000;
  gtk_widget_queue_draw(mo->area);
}

static gboolean tick(gpointer data) {
  Mo *mo = data;
  mo->frame++;
  gtk_widget_queue_draw(mo->area);
  return G_SOURCE_CONTINUE;
}

static gboolean poll_health(gpointer data) {
  Mo *mo = data;
  mo->awake = mo_daemon_healthy();
  gtk_widget_queue_draw(mo->area);
  return G_SOURCE_CONTINUE;
}

// --- window dragging ---------------------------------------------------------

static gboolean on_press(GtkWidget *w, GdkEventButton *e, gpointer data) {
  (void)data;
  if (e->button == 1)
    gtk_window_begin_move_drag(GTK_WINDOW(w), e->button, (gint)e->x_root, (gint)e->y_root, e->time);
  return FALSE;
}

// --- drop → input box → session ----------------------------------------------

typedef struct {
  Mo *mo;
  char **paths;
  int count;
} DropCtx;

static void free_drop(DropCtx *d) {
  for (int i = 0; i < d->count; i++) g_free(d->paths[i]);
  g_free(d->paths);
  g_free(d);
}

static void submit_drop(DropCtx *d, const char *prompt) {
  d->mo->working = TRUE;
  gtk_widget_queue_draw(d->mo->area);
  char session[64];
  gboolean ok = mo_daemon_drop((const char *const *)d->paths, d->count, prompt, session, sizeof(session));
  d->mo->working = FALSE;
  set_bubble(d->mo, ok ? "Mo is on it \xF0\x9F\x90\x9F" : "Mo couldn't reach the daemon");
}

static void on_entry_activate(GtkEntry *entry, gpointer data) {
  DropCtx *d = data;
  submit_drop(d, gtk_entry_get_text(entry));
  gtk_widget_destroy(gtk_widget_get_toplevel(GTK_WIDGET(entry)));
  free_drop(d);
}

static void open_input_box(DropCtx *d) {
  GtkWidget *win = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  gtk_window_set_decorated(GTK_WINDOW(win), FALSE);
  gtk_window_set_keep_above(GTK_WINDOW(win), TRUE);
  gtk_window_set_position(GTK_WINDOW(win), GTK_WIN_POS_MOUSE);

  GtkWidget *entry = gtk_entry_new();
  gtk_entry_set_placeholder_text(GTK_ENTRY(entry),
                                 d->count > 1 ? "Ask Mo about these files…" : "Ask Mo about this file…");
  gtk_widget_set_size_request(entry, 280, -1);
  g_signal_connect(entry, "activate", G_CALLBACK(on_entry_activate), d);
  gtk_container_add(GTK_CONTAINER(win), entry);
  gtk_widget_show_all(win);
  gtk_widget_grab_focus(entry);
}

static void on_drop(GtkWidget *w, GdkDragContext *ctx, gint x, gint y, GtkSelectionData *sel,
                    guint info, guint time, gpointer data) {
  (void)w; (void)x; (void)y; (void)info;
  Mo *mo = data;
  gchar **uris = gtk_selection_data_get_uris(sel);
  if (!uris) { gtk_drag_finish(ctx, FALSE, FALSE, time); return; }

  DropCtx *d = g_new0(DropCtx, 1);
  d->mo = mo;
  int n = 0;
  for (gchar **u = uris; *u; u++) n++;
  d->paths = g_new0(char *, n);
  for (gchar **u = uris; *u; u++) {
    gchar *path = g_filename_from_uri(*u, NULL, NULL);
    if (path) d->paths[d->count++] = path;  // absolute local path
  }
  g_strfreev(uris);
  gtk_drag_finish(ctx, TRUE, FALSE, time);

  if (d->count == 0) { free_drop(d); return; }
  open_input_box(d);
}

// --- window setup ------------------------------------------------------------

static void make_transparent(GtkWidget *win) {
  GdkScreen *screen = gtk_widget_get_screen(win);
  GdkVisual *rgba = gdk_screen_get_rgba_visual(screen);
  if (rgba) gtk_widget_set_visual(win, rgba);  // needs a compositor for real transparency
  gtk_widget_set_app_paintable(win, TRUE);
}

int main(int argc, char **argv) {
  // Mo is launched by the monad daemon (via cli/web), which injects MO_DAEMON_SOCK pointing at
  // its own socket. Refuse to run standalone — there's no daemon to talk to, and the daemon owns
  // Mo's lifecycle. This is an intent gate (env can be faked), not a security boundary.
  if (!getenv("MO_DAEMON_SOCK")) {
    fprintf(stderr, "mo: start Mo through the monad daemon (cli/web), not directly.\n");
    return 1;
  }
  gtk_init(&argc, &argv);
  mo_daemon_init();

  static Mo mo;
  mo.awake = TRUE;

  GtkWidget *win = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  mo.window = win;
  gtk_window_set_decorated(GTK_WINDOW(win), FALSE);
  gtk_window_set_keep_above(GTK_WINDOW(win), TRUE);
  gtk_window_set_skip_taskbar_hint(GTK_WINDOW(win), TRUE);
  gtk_window_set_skip_pager_hint(GTK_WINDOW(win), TRUE);
  gtk_window_set_default_size(GTK_WINDOW(win), MO_SIZE, MO_SIZE);
  gtk_window_set_resizable(GTK_WINDOW(win), FALSE);
  make_transparent(win);

  GtkWidget *area = gtk_drawing_area_new();
  mo.area = area;
  gtk_container_add(GTK_CONTAINER(win), area);
  g_signal_connect(area, "draw", G_CALLBACK(on_draw), &mo);

  gtk_widget_add_events(win, GDK_BUTTON_PRESS_MASK);
  g_signal_connect(win, "button-press-event", G_CALLBACK(on_press), &mo);

  // Accept file drops (text/uri-list) anywhere on Mo.
  gtk_drag_dest_set(win, GTK_DEST_DEFAULT_ALL, NULL, 0, GDK_ACTION_COPY);
  gtk_drag_dest_add_uri_targets(win);
  g_signal_connect(win, "drag-data-received", G_CALLBACK(on_drop), &mo);

  g_signal_connect(win, "destroy", G_CALLBACK(gtk_main_quit), NULL);

  g_timeout_add(120, tick, &mo);            // animation
  g_timeout_add_seconds(3, poll_health, &mo);  // awake/asleep
  poll_health(&mo);

  gtk_widget_show_all(win);
  gtk_main();
  mo_daemon_shutdown();
  return 0;
}
