#import <Cocoa/Cocoa.h>

// A rounded, frosted HUD that floats just above Mo to collect a prompt for dropped files.
// The text area is multi-line (return sends, shift+return inserts a newline); the dropped files
// render as a stack of chips that fans out on hover, each removable with its own ✕. Purely
// presentational — the owner performs the daemon call inside onSubmit with the (possibly pruned)
// file list. onCancel fires when the user escapes out of the panel. Re-presenting or -dismiss
// silently supersedes an open panel without firing its onCancel.
@interface MoInputPanel : NSObject
@property(nonatomic, readonly) BOOL isOpen;
- (void)presentForPaths:(NSArray<NSString *> *)paths
                 anchor:(NSRect)anchor
               onSubmit:(void (^)(NSString *prompt, NSArray<NSString *> *paths))onSubmit
               onCancel:(void (^)(void))onCancel;
- (void)dismiss;
@end
