#import "input_panel.h"
#import <QuartzCore/QuartzCore.h>

// Layout constants shared across the panel's subviews.
static const CGFloat kPanelW = 320;
static const CGFloat kPad = 14;
static const CGFloat kChipH = 22;
static const CGFloat kChipGap = 8;
static const CGFloat kAttachH = 26;
static const CGFloat kInputH = 64;
static const CGFloat kToolbarH = 32;
static const CGFloat kSurfaceRadius = 20;  // matches the web composer's chat-input-chrome (1.25rem)

static NSColor *AccentColor(void) {
  return [NSColor colorWithSRGBRed:0.42 green:0.45 blue:0.95 alpha:1.0];
}

static NSColor *SurfaceBorderColor(void) {
  return [NSColor colorWithWhite:1 alpha:0.12];  // approximates --chat-input-border on a dark HUD
}

static const CGFloat kAuroraRingWidth = 1.6;
static NSString *const kAuroraRotateKey = @"aurora-rotate";

// A rotating conic-gradient ring, masked to the surface's rounded-rect border — the native
// equivalent of the web composer's `.chat-input-aurora` focus glow (chat-input-aurora-gradient
// rotating inside chat-input-aurora-edge-mask). Built once per panel; visibility/rotation are
// toggled by focus (see textDidBeginEditing:/textDidEndEditing:).
static CAGradientLayer *MakeAuroraLayer(NSRect bounds, CGFloat cornerRadius) {
  CAGradientLayer *aurora = [CAGradientLayer layer];
  aurora.frame = bounds;
  aurora.type = kCAGradientLayerConic;
  aurora.startPoint = CGPointMake(0.5, 0.5);
  aurora.endPoint = CGPointMake(0.5, 1.0);  // sweep starts at 12 o'clock, matching conic-gradient(from 0deg)
  aurora.opacity = 0;

  NSColor *clear = [NSColor clearColor];
  NSColor *c1 = [NSColor colorWithSRGBRed:0.569 green:0.329 blue:0.906 alpha:1];  // #9154e7
  NSColor *c2 = [NSColor colorWithSRGBRed:0.376 green:0.337 blue:0.941 alpha:1];  // #6056f0
  NSColor *c3 = [NSColor colorWithSRGBRed:0.251 green:0.851 blue:0.776 alpha:1];  // #40d9c6
  NSColor *c4 = [NSColor colorWithSRGBRed:0.259 green:0.522 blue:0.957 alpha:1];  // #4285f4
  aurora.colors = @[
    (id)clear.CGColor, (id)c1.CGColor, (id)c2.CGColor, (id)c3.CGColor, (id)c4.CGColor, (id)c1.CGColor,
    (id)clear.CGColor, (id)clear.CGColor
  ];
  aurora.locations = @[ @0.0, @0.10, @0.1625, @0.225, @0.2875, @0.35, @0.45, @1.0 ];

  CAShapeLayer *ring = [CAShapeLayer layer];
  ring.frame = bounds;
  CGPathRef outer = CGPathCreateWithRoundedRect(bounds, cornerRadius, cornerRadius, NULL);
  CGRect innerRect = CGRectInset(bounds, kAuroraRingWidth, kAuroraRingWidth);
  CGFloat innerRadius = MAX(0, cornerRadius - kAuroraRingWidth);
  CGPathRef inner = CGPathCreateWithRoundedRect(innerRect, innerRadius, innerRadius, NULL);
  CGMutablePathRef path = CGPathCreateMutable();
  CGPathAddPath(path, NULL, outer);
  CGPathAddPath(path, NULL, inner);
  ring.path = path;
  CGPathRelease(path);
  CGPathRelease(outer);
  CGPathRelease(inner);
  ring.fillRule = kCAFillRuleEvenOdd;
  aurora.mask = ring;
  return aurora;
}

// --- MoTextView: multi-line prompt with a drawn placeholder --------------------

@interface MoTextView : NSTextView
@property(nonatomic, copy) NSString *placeholder;
@end

@implementation MoTextView
- (void)drawRect:(NSRect)rect {
  [super drawRect:rect];
  if (self.string.length == 0 && self.placeholder.length) {
    NSDictionary *attr = @{
      NSFontAttributeName : self.font ?: [NSFont systemFontOfSize:14],
      NSForegroundColorAttributeName : [NSColor tertiaryLabelColor]
    };
    // Match where the layout manager starts glyphs: inset + the container's line-fragment padding.
    CGFloat x = self.textContainerInset.width + self.textContainer.lineFragmentPadding;
    [self.placeholder drawAtPoint:NSMakePoint(x, self.textContainerInset.height) withAttributes:attr];
  }
}
@end

// --- MoChip: one removable attachment card -------------------------------------

@interface MoChip : NSView
@property(nonatomic, copy, readonly) NSString *path;
@property(nonatomic, copy) void (^onRemove)(void);
- (instancetype)initWithPath:(NSString *)path;
- (CGFloat)preferredWidth;
- (void)setRemoveVisible:(BOOL)visible;
- (void)setContentVisible:(BOOL)visible;
@end

@implementation MoChip {
  NSTextField *_label;
  NSButton *_remove;
}
- (instancetype)initWithPath:(NSString *)path {
  if ((self = [super initWithFrame:NSZeroRect])) {
    _path = [path copy];
    self.wantsLayer = YES;
    self.layer.cornerRadius = 6;
    self.layer.backgroundColor = [NSColor colorWithWhite:1 alpha:0.14].CGColor;
    self.layer.borderWidth = 0.5;
    self.layer.borderColor = [NSColor colorWithWhite:1 alpha:0.14].CGColor;

    _label = [NSTextField labelWithString:path.lastPathComponent];
    _label.font = [NSFont systemFontOfSize:11 weight:NSFontWeightMedium];
    _label.textColor = [NSColor labelColor];
    _label.lineBreakMode = NSLineBreakByTruncatingMiddle;
    _label.maximumNumberOfLines = 1;
    [self addSubview:_label];

    _remove = [[NSButton alloc] initWithFrame:NSMakeRect(0, 0, 14, 14)];
    _remove.bordered = NO;
    _remove.wantsLayer = YES;
    _remove.layer.cornerRadius = 7;
    _remove.layer.backgroundColor = [NSColor colorWithWhite:0 alpha:0.6].CGColor;
    _remove.attributedTitle = [[NSAttributedString alloc]
        initWithString:@"✕"
            attributes:@{
              NSFontAttributeName : [NSFont systemFontOfSize:8 weight:NSFontWeightBold],
              NSForegroundColorAttributeName : [NSColor whiteColor]
            }];
    _remove.target = self;
    _remove.action = @selector(removeTapped:);
    _remove.hidden = YES;
    [self addSubview:_remove];
  }
  return self;
}

- (CGFloat)preferredWidth {
  CGFloat text = ceil([_label intrinsicContentSize].width);
  return MIN(MAX(text + 16, 44), 150);
}

- (void)setContentVisible:(BOOL)visible {
  _label.hidden = !visible;
}

- (void)removeTapped:(id)sender {
  (void)sender;
  if (self.onRemove) self.onRemove();
}

// AppKit's -layout isn't invoked for a manual setFrameSize on a non-autolayout view, so lay out here.
- (void)setFrameSize:(NSSize)newSize {
  [super setFrameSize:newSize];
  [self layoutInternals];
}

- (void)setRemoveVisible:(BOOL)visible {
  _remove.hidden = !visible;
  [self layoutInternals];
}

- (void)layoutInternals {
  CGFloat w = NSWidth(self.bounds), h = NSHeight(self.bounds);
  CGFloat rightInset = _remove.hidden ? 8 : 10;
  _label.frame = NSMakeRect(8, (h - 14) / 2, MAX(0, w - 8 - rightInset), 14);
  _remove.frame = NSMakeRect(w - 11, h - 11, 14, 14);
}
@end

// --- MoAttachmentsView: a hover-expandable stack of chips ----------------------

@interface MoAttachmentsView : NSView
@property(nonatomic, copy) void (^onChange)(NSUInteger count);
- (instancetype)initWithPaths:(NSArray<NSString *> *)paths;
- (NSArray<NSString *> *)paths;
@end

@implementation MoAttachmentsView {
  NSMutableArray<MoChip *> *_chips;
  NSTextField *_count;
  BOOL _expanded;
  NSTrackingArea *_tracking;
}

- (instancetype)initWithPaths:(NSArray<NSString *> *)paths {
  if ((self = [super initWithFrame:NSZeroRect])) {
    self.wantsLayer = YES;
    self.layer.masksToBounds = YES;
    _chips = [NSMutableArray array];

    _count = [NSTextField labelWithString:@""];
    _count.font = [NSFont systemFontOfSize:11 weight:NSFontWeightMedium];
    _count.textColor = [NSColor secondaryLabelColor];
    [self addSubview:_count];

    for (NSString *p in paths) [self addChipForPath:p];
    // A single attachment is always shown expanded (nothing to fan out).
    _expanded = paths.count <= 1;
  }
  return self;
}

- (void)addChipForPath:(NSString *)path {
  MoChip *chip = [[MoChip alloc] initWithPath:path];
  __weak MoChip *weakChip = chip;
  __weak MoAttachmentsView *weakSelf = self;
  chip.onRemove = ^{
    [weakSelf removeChip:weakChip];
  };
  [_chips addObject:chip];
  [self addSubview:chip];
}

- (NSArray<NSString *> *)paths {
  NSMutableArray *out = [NSMutableArray array];
  for (MoChip *c in _chips) [out addObject:c.path];
  return out;
}

- (void)removeChip:(MoChip *)chip {
  if (!chip) return;
  [chip removeFromSuperview];
  [_chips removeObject:chip];
  if (_chips.count <= 1) _expanded = YES;
  [self relayoutAnimated:YES];
  if (self.onChange) self.onChange(_chips.count);
}

- (void)setExpanded:(BOOL)expanded {
  if (_expanded == expanded || _chips.count <= 1) return;
  _expanded = expanded;
  [self relayoutAnimated:YES];
}

- (void)setFrameSize:(NSSize)newSize {
  [super setFrameSize:newSize];
  [self relayoutAnimated:NO];
}

- (void)relayoutAnimated:(BOOL)animated {
  CGFloat h = NSHeight(self.bounds);
  CGFloat y = (h - kChipH) / 2;
  BOOL stacked = !_expanded && _chips.count > 1;

  _count.hidden = !stacked;
  if (stacked) {
    CGFloat dx = 5;
    NSUInteger shown = MIN(_chips.count, (NSUInteger)3);
    for (NSUInteger i = 0; i < _chips.count; i++) {
      MoChip *chip = _chips[i];
      BOOL visible = i < shown;
      chip.hidden = !visible;
      if (visible) {
        [chip setRemoveVisible:NO];
        [chip setContentVisible:NO];
        CGFloat cw = 40 - (CGFloat)(shown - 1 - i) * 4;
        [self place:chip frame:NSMakeRect((CGFloat)i * dx, y, cw, kChipH) animated:animated];
      }
    }
    CGFloat pileRight = (CGFloat)(shown - 1) * dx + 40;
    _count.stringValue = [NSString stringWithFormat:@"%lu files", (unsigned long)_chips.count];
    [_count sizeToFit];
    _count.frame = NSMakeRect(pileRight + 8, (h - NSHeight(_count.frame)) / 2,
                              NSWidth(_count.frame), NSHeight(_count.frame));
  } else {
    NSUInteger n = _chips.count;
    CGFloat natural = 0;
    for (MoChip *chip in _chips) natural += [chip preferredWidth];
    CGFloat gaps = n > 1 ? (CGFloat)(n - 1) * kChipGap : 0;
    // Fall back to equal shares when natural widths overflow the row, so no chip is clipped by
    // masksToBounds and every ✕ stays reachable.
    BOOL fits = natural + gaps <= NSWidth(self.bounds);
    CGFloat equal = n > 0 ? floor((NSWidth(self.bounds) - gaps) / (CGFloat)n) : 0;
    CGFloat x = 0;
    for (MoChip *chip in _chips) {
      chip.hidden = NO;
      [chip setContentVisible:YES];
      [chip setRemoveVisible:n > 1];
      CGFloat cw = fits ? [chip preferredWidth] : equal;
      [self place:chip frame:NSMakeRect(x, y, cw, kChipH) animated:animated];
      x += cw + kChipGap;
    }
  }
}

- (void)place:(NSView *)view frame:(NSRect)frame animated:(BOOL)animated {
  if (animated) {
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext *ctx) {
      ctx.duration = 0.16;
      ctx.allowsImplicitAnimation = YES;
      view.animator.frame = frame;
    }];
  } else {
    view.frame = frame;
  }
}

- (void)updateTrackingAreas {
  [super updateTrackingAreas];
  if (_tracking) [self removeTrackingArea:_tracking];
  _tracking = [[NSTrackingArea alloc]
      initWithRect:self.bounds
           options:NSTrackingMouseEnteredAndExited | NSTrackingActiveInKeyWindow | NSTrackingInVisibleRect
             owner:self
          userInfo:nil];
  [self addTrackingArea:_tracking];
}

- (void)mouseEntered:(NSEvent *)event {
  (void)event;
  [self setExpanded:YES];
}
- (void)mouseExited:(NSEvent *)event {
  (void)event;
  [self setExpanded:NO];
}
@end

// --- MoInputPanel: the floating HUD --------------------------------------------

@interface MoInputPanel () <NSTextViewDelegate>
@end

@implementation MoInputPanel {
  NSPanel *_panel;
  NSVisualEffectView *_surface;
  CAGradientLayer *_aurora;
  MoTextView *_text;
  MoAttachmentsView *_attach;
  NSTextField *_hint;
  NSButton *_submit;
  void (^_onSubmit)(NSString *, NSArray<NSString *> *);
  void (^_onCancel)(void);
}

- (BOOL)isOpen {
  return _panel != nil;
}

- (void)presentForPaths:(NSArray<NSString *> *)paths
                 anchor:(NSRect)anchor
               onSubmit:(void (^)(NSString *, NSArray<NSString *> *))onSubmit
               onCancel:(void (^)(void))onCancel {
  [self dismiss];
  _onSubmit = [onSubmit copy];
  _onCancel = [onCancel copy];

  CGFloat H = kPad + kAttachH + 8 + kInputH + 8 + kToolbarH + kPad;
  NSRect frame = NSMakeRect(0, 0, kPanelW, H);
  _panel = [[NSPanel alloc] initWithContentRect:frame
                                      styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                                                NSWindowStyleMaskFullSizeContentView
                                        backing:NSBackingStoreBuffered
                                          defer:NO];
  // Manually-alloc'd titled windows default to releasedWhenClosed=YES; under ARC that races the
  // strong ivar's own release when we -close then nil it. Own the lifetime ourselves.
  _panel.releasedWhenClosed = NO;
  _panel.titlebarAppearsTransparent = YES;
  _panel.titleVisibility = NSWindowTitleHidden;
  _panel.movableByWindowBackground = YES;
  _panel.level = NSFloatingWindowLevel;
  // NSPanel defaults hidesOnDeactivate to YES, which drops it behind other apps' windows the
  // moment Mo isn't frontmost — this HUD must stay on top until the user sends or cancels.
  _panel.hidesOnDeactivate = NO;
  _panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces;
  _panel.backgroundColor = [NSColor clearColor];
  _panel.opaque = NO;
  _panel.hasShadow = YES;
  [_panel standardWindowButton:NSWindowCloseButton].hidden = YES;
  [_panel standardWindowButton:NSWindowMiniaturizeButton].hidden = YES;
  [_panel standardWindowButton:NSWindowZoomButton].hidden = YES;

  // Mirrors the web composer's chat-input-chrome/chat-input-surface: a translucent, rounded,
  // hairline-bordered surface that the text and toolbar sit directly on (no separate input box).
  _surface = [[NSVisualEffectView alloc] initWithFrame:frame];
  _surface.material = NSVisualEffectMaterialHUDWindow;
  _surface.blendingMode = NSVisualEffectBlendingModeBehindWindow;
  _surface.state = NSVisualEffectStateActive;
  _surface.wantsLayer = YES;
  _surface.layer.cornerRadius = kSurfaceRadius;
  _surface.layer.masksToBounds = YES;
  _surface.layer.borderWidth = 1;
  _surface.layer.borderColor = SurfaceBorderColor().CGColor;
  _panel.contentView = _surface;

  // The rotating focus glow sits above everything else in the surface, masked to a thin ring
  // just inside its rounded border; it's hidden (opacity 0) until the text view is focused.
  _aurora = MakeAuroraLayer(frame, kSurfaceRadius);
  [_surface.layer addSublayer:_aurora];

  CGFloat contentW = kPanelW - 2 * kPad;

  _attach = [[MoAttachmentsView alloc] initWithPaths:paths];
  _attach.frame = NSMakeRect(kPad, H - kPad - kAttachH, contentW, kAttachH);
  __weak MoInputPanel *weakSelf = self;
  _attach.onChange = ^(NSUInteger count) {
    [weakSelf attachmentsChanged:count];
  };
  [_surface addSubview:_attach];

  NSScrollView *scroll = [[NSScrollView alloc]
      initWithFrame:NSMakeRect(kPad, kPad + kToolbarH + 8, contentW, kInputH)];
  scroll.hasVerticalScroller = YES;
  scroll.drawsBackground = NO;
  scroll.borderType = NSNoBorder;

  _text = [[MoTextView alloc] initWithFrame:scroll.bounds];
  _text.delegate = self;
  _text.font = [NSFont systemFontOfSize:14];
  _text.placeholder = @"What should Mo do with it?";
  _text.drawsBackground = NO;
  _text.textColor = [NSColor labelColor];
  _text.insertionPointColor = AccentColor();
  _text.textContainerInset = NSMakeSize(0, 0);
  _text.verticallyResizable = YES;
  _text.horizontallyResizable = NO;
  _text.autoresizingMask = NSViewWidthSizable;
  _text.minSize = NSMakeSize(0, 0);
  _text.maxSize = NSMakeSize(FLT_MAX, FLT_MAX);
  _text.textContainer.widthTracksTextView = YES;
  _text.textContainer.containerSize = NSMakeSize(contentW, FLT_MAX);
  scroll.documentView = _text;
  [_surface addSubview:scroll];

  // Toolbar row: hint on the left, a real submit button on the right — mirrors the web
  // composer's shared-composer-toolbar (leftTools / rightTools split, space-between).
  _hint = [NSTextField labelWithString:@""];
  _hint.font = [NSFont systemFontOfSize:10];
  _hint.textColor = [NSColor tertiaryLabelColor];
  _hint.lineBreakMode = NSLineBreakByTruncatingTail;
  _hint.frame = NSMakeRect(kPad, kPad + (kToolbarH - 14) / 2, contentW - kToolbarH - 8, 14);
  [_surface addSubview:_hint];

  _submit = [NSButton buttonWithTitle:@"" target:self action:@selector(submitTapped:)];
  _submit.bordered = NO;
  _submit.wantsLayer = YES;
  _submit.layer.cornerRadius = kToolbarH / 2;
  _submit.image = [NSImage imageWithSystemSymbolName:@"arrow.turn.down.left" accessibilityDescription:@"Send"];
  _submit.imagePosition = NSImageOnly;
  _submit.frame = NSMakeRect(kPad + contentW - kToolbarH, kPad, kToolbarH, kToolbarH);
  [_surface addSubview:_submit];

  [self attachmentsChanged:paths.count];

  NSRect placed = [self frameForAnchor:anchor size:NSMakeSize(kPanelW, H)];
  [_panel setFrame:placed display:YES];
  // Activate first: making the panel key before the app is active can drop the field editor,
  // swallowing the first keystroke.
  [NSApp activateIgnoringOtherApps:YES];
  [_panel makeKeyAndOrderFront:nil];
  [_panel makeFirstResponder:_text];
}

// Center the panel horizontally over Mo and float it just above his head; if there's no room
// above (Mo near the top of the screen), drop it below instead. Clamp into the visible frame.
- (NSRect)frameForAnchor:(NSRect)anchor size:(NSSize)size {
  const CGFloat gap = 10;
  NSScreen *screen = nil;
  for (NSScreen *s in [NSScreen screens]) {
    if (NSPointInRect(NSMakePoint(NSMidX(anchor), NSMidY(anchor)), s.frame)) {
      screen = s;
      break;
    }
  }
  NSRect vis = (screen ?: [NSScreen mainScreen]).visibleFrame;

  CGFloat x = NSMidX(anchor) - size.width / 2;
  CGFloat y = NSMaxY(anchor) + gap;
  if (y + size.height > NSMaxY(vis)) y = NSMinY(anchor) - gap - size.height;

  x = MAX(NSMinX(vis) + 8, MIN(x, NSMaxX(vis) - size.width - 8));
  y = MAX(NSMinY(vis) + 8, MIN(y, NSMaxY(vis) - size.height - 8));
  return NSMakeRect(x, y, size.width, size.height);
}

- (void)attachmentsChanged:(NSUInteger)count {
  BOOL canSend = count > 0;
  _hint.stringValue = canSend ? @"shift+return for a new line" : @"add a file to send";
  // Mirrors ComposerSubmitButton: filled accent when enabled, muted and non-interactive otherwise.
  _submit.enabled = canSend;
  _submit.layer.backgroundColor = (canSend ? AccentColor() : [NSColor colorWithWhite:1 alpha:0.1]).CGColor;
  _submit.contentTintColor = canSend ? [NSColor whiteColor] : [NSColor tertiaryLabelColor];
}

- (void)submitTapped:(id)sender {
  (void)sender;
  [self submit];
}

// Mirrors the web composer's `:focus-within` aurora glow: fade the ring in and spin it up while
// typing, fade it out and let it settle when focus leaves.
- (void)textDidBeginEditing:(NSNotification *)note {
  (void)note;
  [CATransaction begin];
  [CATransaction setAnimationDuration:0.3];
  _aurora.opacity = 1;
  [CATransaction commit];

  if ([_aurora animationForKey:kAuroraRotateKey]) return;
  CABasicAnimation *spin = [CABasicAnimation animationWithKeyPath:@"transform.rotation.z"];
  spin.fromValue = @0;
  spin.toValue = @(2 * M_PI);
  spin.duration = 3.4;
  spin.repeatCount = HUGE_VALF;
  spin.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionLinear];
  [_aurora addAnimation:spin forKey:kAuroraRotateKey];
}

- (void)textDidEndEditing:(NSNotification *)note {
  (void)note;
  [CATransaction begin];
  [CATransaction setAnimationDuration:0.3];
  _aurora.opacity = 0;
  [CATransaction commit];
  [_aurora removeAnimationForKey:kAuroraRotateKey];
}

- (BOOL)textView:(NSTextView *)textView doCommandBySelector:(SEL)selector {
  (void)textView;
  if (selector == @selector(insertNewline:)) {
    NSEvent *e = NSApp.currentEvent;
    if (e && (e.modifierFlags & NSEventModifierFlagShift)) {
      [_text insertNewlineIgnoringFieldEditor:nil];
      return YES;
    }
    [self submit];
    return YES;
  }
  if (selector == @selector(cancelOperation:)) {
    [self cancel];
    return YES;
  }
  return NO;
}

- (void)submit {
  NSString *prompt = [_text.string stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  NSArray<NSString *> *paths = [_attach paths];
  if (paths.count == 0) return;  // nothing to seed a session with — keep the panel up
  void (^submitBlock)(NSString *, NSArray<NSString *> *) = _onSubmit;
  [self teardown];
  if (submitBlock) submitBlock(prompt, paths);
}

- (void)cancel {
  void (^cancelBlock)(void) = _onCancel;
  [self teardown];
  if (cancelBlock) cancelBlock();
}

- (void)dismiss {
  [self teardown];
}

- (void)teardown {
  [_panel close];
  _panel = nil;
  _surface = nil;
  _aurora = nil;
  _text = nil;
  _attach = nil;
  _hint = nil;
  _submit = nil;
  _onSubmit = nil;
  _onCancel = nil;
}
@end
