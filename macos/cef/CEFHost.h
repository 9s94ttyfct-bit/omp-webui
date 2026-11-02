// The built-in browser's engine inside the Mac app: CEF, loaded from the version the server installed into the app's data
// folder (`<data>/browser/cef/<version>/`, docs/agents/browser.md). Every page is a windowed CefBrowser whose view lives
// in a hidden window until the Browser tab places it (macos/browser.swift). The server drives the pages over CDP, which
// passes through here (`sendCdp`, `setCdpObserver`): no debugging port is ever opened.
//
// Also Swift's bridging header (`swiftc -import-objc-header`): nothing here may need C++.
#import <Cocoa/Cocoa.h>

#import "OmpApplication.h"

NS_ASSUME_NONNULL_BEGIN

@interface CEFHost : NSObject

/// Load the framework in `frameworkDir` (the folder that holds "Chromium Embedded Framework.framework") and start CEF
/// with its profile in `profileDir`. NO, with `error` set, when it cannot be loaded or started; once only per process.
+ (BOOL)startWithFramework:(NSString*)frameworkDir profile:(NSString*)profileDir error:(NSError**)error;
/// Whether CEF runs in this process.
+ (BOOL)running;
/// Close every page and stop CEF (at quit). Waits up to a few seconds for the pages to close.
+ (void)shutdown;
/// The page's view (to place it in a window); nil for no such page.
+ (NSView* _Nullable)viewForTarget:(NSString*)targetId;
/// A new page at `url`, parked in the hidden window; `reply` gets its DevTools target id (nil when it could not be made).
+ (void)createPage:(NSString*)url reply:(void (^)(NSString* _Nullable targetId))reply;
/// Close the page.
+ (void)closePage:(NSString*)targetId;
/// A CDP message (JSON text) to the page's DevTools channel; its answers and events go to the observer.
+ (void)sendCdp:(NSString*)targetId message:(NSString*)json;
/// Where the pages' CDP answers and events go (JSON text, with the page they are of); nil: nowhere.
+ (void)setCdpObserver:(void (^_Nullable)(NSString* targetId, NSString* json))observer;
/// Open Chrome's DevTools for the page in a window of their own.
+ (void)showDevTools:(NSString*)targetId;
/// Move every page's view back into the hidden window (the window they are in is closing). Pages go on running there.
+ (void)parkAll;
/// The pages there are now, by target id.
+ (NSArray<NSString*>*)targets;

@end

NS_ASSUME_NONNULL_END
