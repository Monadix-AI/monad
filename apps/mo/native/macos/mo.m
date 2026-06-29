// Mo desktop sprite — macOS / Cocoa reference shell.
//
// A transparent, frameless, always-on-top window showing a Codex atlas-pet sprite (assets/mochi.png).
// Drag a file onto Mo to open a native input box (Mo waits attentively while it's open); submitting
// POSTs the dropped paths + your text to the local daemon (POST /v1/mo/drop), which seeds a session.
// Click Mo (without dragging) to open the web UI; drag to reposition it. Mo renders one of nine
// agent-lifecycle states from the shared behavior FSM (../common/behavior.c) by blitting the matching
// atlas row (../common/atlas.h): waves on startup and as an idle fidget (also when a file hovers),
// jumps when it catches a drop (and as a fidget), waits while the input box is open / a session is
// seeded, reviews while the agent reasons, runs while it generates or runs a tool, fails on a daemon
// outage, and runs left/right when dragged.
//
// All business logic lives in the daemon; this shell only does windowing, drawing, file drops, and the
// daemon calls in ../common/daemon.c (shared with the Linux shell, HTTP over the Unix socket via libcurl).
//
// Build: see build.sh (clang, -framework Cocoa, -lcurl).

#import <Cocoa/Cocoa.h>

#import "atlas.h"
#import "behavior.h"
#import "daemon.h"

// Window matches the atlas cell aspect (192:208), scaled down for a desktop sprite.
static const CGFloat kMoW = 105.6;
static const CGFloat kMoH = 114.4;  // 105.6 * 208/192
static const double kTick = 0.12;  // animation timer interval (s)
static NSString *const kMoFrameName = @"MoWindow";  // NSUserDefaults key for the saved window frame

// The view forwards a completed drop to its window delegate through this protocol so it
// doesn't need the delegate's full interface.
@protocol MoDropTarget <NSObject>
- (void)openInputBoxForPaths:(NSArray<NSString *> *)paths;
- (void)openWebUI;  // a plain click on Mo (no drag) opens the web UI
@end

// --- the sprite view ---------------------------------------------------------

@interface MoView : NSView
@property(nonatomic) mo_state state;  // driven by the shared behavior FSM; enum value == atlas row
@property(nonatomic) NSUInteger animFrame;
@property(nonatomic, copy) NSString *bubble;
@property(nonatomic) NSTimeInterval bubbleUntil;
@property(nonatomic) BOOL dragging;  // a file is hovering over Mo, not yet dropped (feeds file_hovering)
@property(nonatomic, strong) NSImage *spriteSheet;  // the codex atlas; nil → neutral fallback
@end

@implementation MoView {
  NSPoint _downMouse;   // screen location at mouseDown
  NSPoint _downOrigin;  // window origin at mouseDown
  BOOL _didDrag;        // pointer moved past the click threshold since mouseDown
}

- (instancetype)initWithFrame:(NSRect)f {
  if ((self = [super initWithFrame:f])) {
    _state = MO_IDLE;
    [self registerForDraggedTypes:@[ NSPasteboardTypeFileURL ]];
  }
  return self;
}

// Activate on the first click even when Mo isn't the focused app, so a single click registers.
- (BOOL)acceptsFirstMouse:(NSEvent *)event {
  (void)event;
  return YES;
}

// Manual drag + click discrimination. The window's movableByWindowBackground is off so these
// events reach the view: a drag moves Mo (the tick reads the resulting window-origin delta to play
// the run-left/right animation); a click with no meaningful movement opens the web UI.
- (void)mouseDown:(NSEvent *)event {
  (void)event;
  _downMouse = [NSEvent mouseLocation];
  _downOrigin = self.window.frame.origin;
  _didDrag = NO;
}

- (void)mouseDragged:(NSEvent *)event {
  (void)event;
  NSPoint now = [NSEvent mouseLocation];
  CGFloat dx = now.x - _downMouse.x;
  CGFloat dy = now.y - _downMouse.y;
  if (hypot(dx, dy) > 3.0) _didDrag = YES;
  [self.window setFrameOrigin:NSMakePoint(_downOrigin.x + dx, _downOrigin.y + dy)];
}

- (void)mouseUp:(NSEvent *)event {
  (void)event;
  if (_didDrag) {
    [self.window saveFrameUsingName:kMoFrameName];  // remember where the user dropped Mo
  } else {
    [(id<MoDropTarget>)self.window.delegate openWebUI];
  }
}

- (void)drawRect:(NSRect)dirty {
  (void)dirty;
  NSRect dst = NSMakeRect(0, 0, kMoW, kMoH);

  if (self.spriteSheet) {
    int row = (int)self.state;  // enum order == atlas row order
    int frames = MO_ATLAS[row].frames > 0 ? MO_ATLAS[row].frames : 1;
    double fps = MO_ATLAS[row].fps > 0 ? MO_ATLAS[row].fps : 6.0;
    long ticksPerFrame = lround((1.0 / fps) / kTick);
    if (ticksPerFrame < 1) ticksPerFrame = 1;
    int frame = (int)((self.animFrame / ticksPerFrame) % frames);

    // Cocoa's image space is bottom-left origin; the atlas is laid out top-down, so row 0 sits at
    // the top → its y in Cocoa coords is totalH - cellH.
    CGFloat totalH = self.spriteSheet.size.height;
    NSRect src = NSMakeRect(frame * MO_CELL_W, totalH - (CGFloat)(row + 1) * MO_CELL_H, MO_CELL_W, MO_CELL_H);
    [self.spriteSheet drawInRect:dst
                        fromRect:src
                       operation:NSCompositingOperationSourceOver
                        fraction:1.0
                  respectFlipped:NO
                           hints:nil];
  } else {
    // Neutral fallback when the atlas asset is missing (should not happen in a real build).
    [[NSColor colorWithSRGBRed:0.42 green:0.45 blue:0.95 alpha:0.9] set];
    [[NSBezierPath bezierPathWithRoundedRect:NSInsetRect(dst, 10, 10) xRadius:16 yRadius:16] fill];
  }

  if (self.bubble && [NSDate timeIntervalSinceReferenceDate] < self.bubbleUntil) {
    [[NSColor colorWithWhite:0 alpha:0.72] set];
    NSRectFill(NSMakeRect(2, kMoH - 18, kMoW - 4, 16));
    NSDictionary *attr = @{NSFontAttributeName: [NSFont systemFontOfSize:9],
                            NSForegroundColorAttributeName: [NSColor whiteColor]};
    [self.bubble drawAtPoint:NSMakePoint(6, kMoH - 16) withAttributes:attr];
  }
}

- (void)rightMouseDown:(NSEvent *)event {
  NSMenu *menu = [[NSMenu alloc] initWithTitle:@""];
  [menu addItemWithTitle:@"Quit Mo" action:@selector(terminate:) keyEquivalent:@""];
  [NSMenu popUpContextMenu:menu withEvent:event forView:self];
}

// --- file drop ---------------------------------------------------------------

- (NSDragOperation)draggingEntered:(id<NSDraggingInfo>)sender {
  (void)sender;
  self.dragging = YES;
  [self setNeedsDisplay:YES];
  return NSDragOperationCopy;
}

- (void)draggingExited:(id<NSDraggingInfo>)sender {
  (void)sender;
  self.dragging = NO;
  [self setNeedsDisplay:YES];
}

- (BOOL)performDragOperation:(id<NSDraggingInfo>)sender {
  self.dragging = NO;
  [self setNeedsDisplay:YES];
  NSArray<NSURL *> *urls =
      [sender.draggingPasteboard readObjectsForClasses:@[ [NSURL class] ]
                                               options:@{NSPasteboardURLReadingFileURLsOnlyKey : @YES}];
  NSMutableArray<NSString *> *paths = [NSMutableArray array];
  for (NSURL *u in urls) {
    if (u.path) [paths addObject:u.path];  // absolute local path
  }
  if (paths.count == 0) return NO;
  [(id<MoDropTarget>)self.window.delegate openInputBoxForPaths:paths];
  return YES;
}

@end

// --- app delegate: window, animation, daemon WS, drop → input box → session --

@interface MoApp : NSObject <NSApplicationDelegate, NSWindowDelegate, MoDropTarget, NSURLSessionWebSocketDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) MoView *view;
@property(nonatomic, strong) NSPanel *input;
@property(nonatomic, strong) NSArray<NSString *> *pending;  // paths awaiting a prompt
@property(nonatomic, strong) NSURLSession *wsSession;
@property(nonatomic, strong) NSURLSessionWebSocketTask *wsTask;
@property(nonatomic, copy) NSString *currentSessionId;  // most-recent drop's session; kept for WS re-subscribe
@end

@implementation MoApp {
  mo_behavior _behavior;
  NSPoint _lastWinOrigin;
  BOOL _daemonOk;
  // Small FIFO of edge events, all enqueued/dequeued on the main thread (onSubmit, the drop
  // completion on the main queue, and tick). A queue rather than a single slot so a fast local drop
  // — where DROP_OK lands before the next 0.12s tick — doesn't clobber the DROP that drives JUMPING.
  mo_event _pendingEvents[8];
  int _pendingHead;
  int _pendingCount;
  // Activity from the latest daemon session event (main-thread only).
  mo_activity _sessionActivity;
  NSTimeInterval _lastActivityTime;  // CFAbsoluteTimeGetCurrent() at last meaningful event; 0 = none
  // Monotonic id counter for JSON-RPC requests sent over the WS.
  int _wsRpcId;
  // Reconnect backoff (seconds): 0 → fresh/connected; doubles on each failure up to 10s.
  double _wsReconnectDelay;
}

- (void)enqueueEvent:(mo_event)ev {
  const int cap = (int)(sizeof(_pendingEvents) / sizeof(_pendingEvents[0]));
  if (_pendingCount >= cap) return;  // full (events are rare) — drop rather than overwrite
  _pendingEvents[(_pendingHead + _pendingCount) % cap] = ev;
  _pendingCount++;
}

- (mo_event)dequeueEvent {
  if (_pendingCount == 0) return MO_EV_NONE;
  const int cap = (int)(sizeof(_pendingEvents) / sizeof(_pendingEvents[0]));
  mo_event ev = _pendingEvents[_pendingHead];
  _pendingHead = (_pendingHead + 1) % cap;
  _pendingCount--;
  return ev;
}

- (void)applicationDidFinishLaunching:(NSNotification *)note {
  (void)note;
  mo_daemon_init();

  NSRect rect = NSMakeRect(0, 0, kMoW, kMoH);
  self.window = [[NSWindow alloc] initWithContentRect:rect
                                            styleMask:NSWindowStyleMaskBorderless
                                              backing:NSBackingStoreBuffered
                                                defer:NO];
  self.window.opaque = NO;
  self.window.backgroundColor = [NSColor clearColor];
  self.window.hasShadow = NO;
  self.window.level = NSFloatingWindowLevel;
  self.window.movableByWindowBackground = NO;  // MoView handles drag (move) vs click (open web UI)
  self.window.collectionBehavior =
      NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorStationary;
  self.window.delegate = self;

  self.view = [[MoView alloc] initWithFrame:rect];
  NSString *pngPath = [[[NSBundle mainBundle] resourcePath] stringByAppendingPathComponent:@"mochi.png"];
  self.view.spriteSheet = [[NSImage alloc] initWithContentsOfFile:pngPath];
  self.window.contentView = self.view;
  // Restore Mo's saved position, or place it near the bottom-right corner on first run. The frame
  // autosaves to NSUserDefaults whenever it moves (see mouseUp), so Mo reappears where it was left.
  if (![self.window setFrameUsingName:kMoFrameName]) {
    NSRect f = (self.window.screen ?: NSScreen.mainScreen).frame;
    const CGFloat fromRight = 140;   // window's right edge this far from the screen's right edge
    const CGFloat fromBottom = 420;  // window's bottom this far up from the screen bottom (clear of the Dock)
    [self.window setFrameOrigin:NSMakePoint(NSMaxX(f) - kMoW - fromRight, NSMinY(f) + fromBottom)];
  }
  [self.window setFrameAutosaveName:kMoFrameName];
  [self.window makeKeyAndOrderFront:nil];

  mo_behavior_init(&_behavior, [NSDate timeIntervalSinceReferenceDate]);
  _lastWinOrigin = self.window.frame.origin;
  _pendingHead = 0;
  _pendingCount = 0;
  _sessionActivity = MO_ACT_NONE;
  _lastActivityTime = 0;
  _wsRpcId = 0;
  _wsReconnectDelay = 0;

  [NSTimer scheduledTimerWithTimeInterval:kTick target:self selector:@selector(tick) userInfo:nil repeats:YES];
  [self connectWS];
}

// --- WebSocket: health signal + session event delivery -----------------------

- (void)connectWS {
  const char *portStr = getenv("MO_DAEMON_PORT");
  int port = portStr ? atoi(portStr) : 0;
  if (port <= 0) {
    // No port env → old daemon or standalone dev run; assume the daemon is up.
    _daemonOk = YES;
    return;
  }

  NSString *urlStr = [NSString stringWithFormat:@"ws://127.0.0.1:%d/v1/stream", port];
  NSURL *url = [NSURL URLWithString:urlStr];

  NSURLSessionConfiguration *cfg = [NSURLSessionConfiguration defaultSessionConfiguration];
  // Deliver WS delegate callbacks on the main queue so _daemonOk / _sessionActivity updates
  // don't need synchronisation. receiveMessageWithCompletionHandler also runs here.
  self.wsSession = [NSURLSession sessionWithConfiguration:cfg delegate:self
                                            delegateQueue:[NSOperationQueue mainQueue]];
  self.wsTask = [self.wsSession webSocketTaskWithURL:url];
  [self.wsTask resume];
  [self wsReceiveLoop];
}

// Arms the next receive on the WS task. Forms a self-sustaining loop: each completion re-arms.
// The loop ends when an error arrives (task closed), which also fires didCloseWithCode.
- (void)wsReceiveLoop {
  __weak typeof(self) weak = self;
  [self.wsTask receiveMessageWithCompletionHandler:^(NSURLSessionWebSocketMessage *msg, NSError *err) {
    __strong typeof(weak) self = weak;
    if (!self || err) return;  // closed or deallocated — loop ends here
    if (msg.type == NSURLSessionWebSocketMessageTypeString && msg.string.length)
      [self wsHandleMessage:msg.string];
    [self wsReceiveLoop];
  }];
}

// Map a JSON-RPC sessions.event notification's event type to an activity for the FSM.
- (void)wsHandleMessage:(NSString *)text {
  NSData *data = [text dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *obj = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![obj isKindOfClass:[NSDictionary class]]) return;
  if (![[obj objectForKey:@"method"] isEqualToString:@"sessions.event"]) return;

  NSDictionary *params = obj[@"params"];
  NSString *type = [params[@"event"] isKindOfClass:[NSDictionary class]] ? params[@"event"][@"type"] : nil;
  if (![type isKindOfClass:[NSString class]]) return;

  if ([type isEqualToString:@"session.stream_ended"]) {
    _sessionActivity = MO_ACT_NONE;
    _lastActivityTime = 0;
  } else if ([type isEqualToString:@"agent.reasoning"]) {
    _sessionActivity = MO_ACT_REASONING;
    _lastActivityTime = CFAbsoluteTimeGetCurrent();
  } else if ([type hasPrefix:@"agent."] || [type hasPrefix:@"message."] || [type hasPrefix:@"tool."]) {
    _sessionActivity = MO_ACT_GENERATING;
    _lastActivityTime = CFAbsoluteTimeGetCurrent();
  }
}

// Send a JSON-RPC request over the WS. Best-effort: if the task is closed the send fails silently.
- (void)wsSend:(NSDictionary *)obj {
  NSData *data = [NSJSONSerialization dataWithJSONObject:obj options:0 error:nil];
  if (!data) return;
  NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  NSURLSessionWebSocketMessage *msg = [[NSURLSessionWebSocketMessage alloc] initWithString:text];
  [self.wsTask sendMessage:msg completionHandler:^(NSError *err) { (void)err; }];
}

// NSURLSessionWebSocketDelegate: fires on the main queue (delegateQueue above).
- (void)URLSession:(NSURLSession *)session
     webSocketTask:(NSURLSessionWebSocketTask *)webSocketTask
    didOpenWithProtocol:(NSString *)protocol {
  (void)session; (void)webSocketTask; (void)protocol;
  _daemonOk = YES;
  _wsReconnectDelay = 0;
  // Re-subscribe every time we (re)connect — catches daemon restarts.
  [self wsSend:@{@"jsonrpc":@"2.0", @"id":@(++_wsRpcId), @"method":@"control.subscribe", @"params":@{}}];
  if (self.currentSessionId) {
    [self wsSend:@{@"jsonrpc":@"2.0", @"id":@(++_wsRpcId),
                   @"method":@"session.subscribe", @"params":@{@"id":self.currentSessionId}}];
  }
}

- (void)URLSession:(NSURLSession *)session
     webSocketTask:(NSURLSessionWebSocketTask *)webSocketTask
    didCloseWithCode:(NSURLSessionWebSocketCloseCode)closeCode
             reason:(NSData *)reason {
  (void)session; (void)webSocketTask; (void)closeCode; (void)reason;
  _daemonOk = NO;
  _sessionActivity = MO_ACT_NONE;
  _lastActivityTime = 0;
  [self scheduleReconnect];
}

- (void)scheduleReconnect {
  _wsReconnectDelay = _wsReconnectDelay > 0 ? MIN(_wsReconnectDelay * 2.0, 10.0) : 1.0;
  [NSTimer scheduledTimerWithTimeInterval:_wsReconnectDelay
                                   target:self selector:@selector(connectWS)
                                 userInfo:nil repeats:NO];
}

// --- animation tick ----------------------------------------------------------

- (void)tick {
  double now = [NSDate timeIntervalSinceReferenceDate];
  NSRect wf = self.window.frame;

  // The user dragging Mo's own window → directional run. dx sign picks running-right vs running-left.
  double dx = wf.origin.x - _lastWinOrigin.x;
  double dy = wf.origin.y - _lastWinOrigin.y;
  BOOL userDragging = hypot(dx, dy) > 1.0;

  // Treat the last WS event as "current" for a short window (covers gaps between token deltas).
  mo_activity activity = (_lastActivityTime > 0 && now - _lastActivityTime < 2.0)
      ? _sessionActivity : MO_ACT_NONE;

  mo_sensors s = {.now = now,
                  .daemon_ok = _daemonOk,
                  .activity = activity,
                  .file_hovering = self.view.dragging,
                  .input_open = self.input != nil,
                  .user_dragging = userDragging,
                  .drag_dx = dx};
  mo_event ev = [self dequeueEvent];

  self.view.state = mo_behavior_step(&_behavior, &s, ev);
  self.view.animFrame = self.view.animFrame + 1;

  _lastWinOrigin = wf.origin;
  [self.view setNeedsDisplay:YES];
}

// --- web UI ------------------------------------------------------------------

- (void)openWebUI {
  // Ask the daemon for its web UI URL (off the main thread — it's a socket round-trip), then open it.
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    char url[1024];
    bool ok = mo_daemon_web_url(url, sizeof(url));
    NSString *s = ok ? @(url) : nil;
    dispatch_async(dispatch_get_main_queue(), ^{
      NSURL *u = s.length ? [NSURL URLWithString:s] : nil;
      if (u) {
        [[NSWorkspace sharedWorkspace] openURL:u];
      } else {
        [self setBubble:@"Mo couldn't reach the daemon"];
      }
    });
  });
}

- (void)setBubble:(NSString *)text {
  self.view.bubble = text;
  self.view.bubbleUntil = [NSDate timeIntervalSinceReferenceDate] + 4.0;
  [self.view setNeedsDisplay:YES];
}

// --- drop → input box → session ----------------------------------------------

- (void)openInputBoxForPaths:(NSArray<NSString *> *)paths {
  self.pending = paths;

  NSRect rect = NSMakeRect(0, 0, 300, 24);
  self.input = [[NSPanel alloc] initWithContentRect:rect
                                          styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
                                            backing:NSBackingStoreBuffered
                                              defer:NO];
  self.input.title = paths.count > 1 ? @"Ask Mo about these files" : @"Ask Mo about this file";
  self.input.level = NSFloatingWindowLevel;

  NSTextField *field = [[NSTextField alloc] initWithFrame:NSInsetRect(rect, 6, 2)];
  field.placeholderString = @"What should Mo do with it?";
  field.target = self;
  field.action = @selector(onSubmit:);  // fires on Enter
  self.input.contentView = field;

  [self.input center];
  [self.input makeKeyAndOrderFront:nil];
  [self.input makeFirstResponder:field];
  [NSApp activateIgnoringOtherApps:YES];
}

- (void)onSubmit:(NSTextField *)field {
  NSString *prompt = field.stringValue ?: @"";
  NSArray<NSString *> *paths = self.pending;
  [self.input close];
  self.input = nil;
  self.pending = nil;
  if (paths.count == 0) return;

  [self enqueueEvent:MO_EV_DROP];  // Mo "catches" the file (jumping) while the daemon call is in flight

  // Copy paths into a C array of owned strings so the background call is self-contained.
  int n = (int)paths.count;
  char **cpaths = calloc((size_t)n, sizeof(char *));
  for (int i = 0; i < n; i++) cpaths[i] = strdup(paths[i].fileSystemRepresentation);
  char *cprompt = strdup(prompt.UTF8String ?: "");

  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    char session[64];
    bool ok = mo_daemon_drop((const char *const *)cpaths, n, cprompt, session, sizeof(session));
    for (int i = 0; i < n; i++) free(cpaths[i]);
    free(cpaths);
    free(cprompt);
    NSString *sid = ok ? @(session) : nil;
    dispatch_async(dispatch_get_main_queue(), ^{
      if (ok) {
        // Unsubscribe the previous session before subscribing the new one.
        if (self.currentSessionId) {
          [self wsSend:@{@"jsonrpc":@"2.0", @"id":@(++self->_wsRpcId),
                         @"method":@"session.unsubscribe", @"params":@{@"id":self.currentSessionId}}];
        }
        self.currentSessionId = sid;
        [self wsSend:@{@"jsonrpc":@"2.0", @"id":@(++self->_wsRpcId),
                       @"method":@"session.subscribe", @"params":@{@"id":sid}}];
        [self enqueueEvent:MO_EV_DROP_OK];
      } else {
        [self enqueueEvent:MO_EV_DROP_FAIL];
      }
      [self setBubble:ok ? @"Mo is on it \U0001F41F" : @"Mo couldn't reach the daemon"];
    });
  });
}

- (void)applicationWillTerminate:(NSNotification *)note {
  (void)note;
  [self.wsTask cancelWithCloseCode:NSURLSessionWebSocketCloseCodeNormalClosure reason:nil];
  mo_daemon_shutdown();
}

@end

int main(int argc, const char *argv[]) {
  (void)argc;
  (void)argv;
  // Mo is launched by the monad daemon (via cli/web), which injects MO_DAEMON_SOCK pointing at
  // its own socket. Refuse to run standalone — there's no daemon to talk to, and the daemon owns
  // Mo's lifecycle. This is an intent gate (env can be faked), not a security boundary.
  if (!getenv("MO_DAEMON_SOCK")) {
    fprintf(stderr, "mo: start Mo through the monad daemon (cli/web), not directly.\n");
    return 1;
  }
  @autoreleasepool {
    NSApplication *app = [NSApplication sharedApplication];
    app.activationPolicy = NSApplicationActivationPolicyAccessory;  // no Dock icon
    MoApp *delegate = [[MoApp alloc] init];
    app.delegate = delegate;
    [app run];
  }
  return 0;
}
