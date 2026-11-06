// The built-in browser's engine inside the Mac app: CEF, the framework the app ships in Contents/Frameworks
// (scripts/app.ts), its helper processes in Chrome's macOS sandbox (helper.mm; docs/agents/browser.md). Every page is a
// windowed CefBrowser whose view lives in a hidden window until the Browser tab places it (macos/browser.swift). The server
// drives the pages over CDP, which passes through here (`sendCdp`, `setCdpObserver`): no debugging port is ever opened.
//
// Also Swift's bridging header (`swiftc -import-objc-header`): nothing here may need C++.
#import <Cocoa/Cocoa.h>

#import "OmpApplication.h"

NS_ASSUME_NONNULL_BEGIN

@interface CEFHost : NSObject

/// The CEF version the app ships (the one it is built against, third_party/cef).
+ (NSString*)version;
/// Load the framework from the app's Contents/Frameworks and start CEF with its profile in `profileDir`. NO, with `error`
/// set, when it cannot be loaded or started; once only per process.
+ (BOOL)startWithProfile:(NSString*)profileDir error:(NSError**)error;
/// Whether CEF runs in this process.
+ (BOOL)running;
/// Close every page and stop CEF (at quit). Waits up to a few seconds for the pages to close.
+ (void)shutdown;
/// The page's view (to place it in a window); nil for no such page.
+ (NSView* _Nullable)viewForTarget:(NSString*)targetId;
/// A new page at `url`, parked in the hidden window; `reply` gets its DevTools target id (nil when it could not be made).
+ (void)createPage:(NSString*)url reply:(void (^)(NSString* _Nullable targetId))reply;
/// Close the page. One whose download is still running is closed for the server at once (the observer is told) and by
/// CEF once its downloads end: CEF tells a download's end only while its page is open.
+ (void)closePage:(NSString*)targetId;
/// A CDP message (JSON text) to the page's DevTools channel; its answers and events go to the observer.
+ (void)sendCdp:(NSString*)targetId message:(NSString*)json;
/// Where the pages' CDP answers and events go (JSON text, with the page they are of); nil: nowhere.
+ (void)setCdpObserver:(void (^_Nullable)(NSString* targetId, NSString* json))observer;
/// Where it is told that a page appeared or its address, title or opener changed (`info`: `targetId`, `url`, `title`,
/// `openerId` when another page opened it), or that it closed (`info` nil); nil: nowhere.
+ (void)setPageObserver:(void (^_Nullable)(NSString* targetId, NSDictionary<NSString*, NSString*>* _Nullable info))observer;
/// Where it is told how a download a page started goes (`AppDownload` of server/browser/cef.ts: `id`, `targetId`,
/// `openerId`, `name`, `path`, `state` progress|done|cancelled|failed, `received`, `total`, `error`); nil: nowhere.
/// Downloads go to the Downloads folder under a name no file there has; progress is told a few times a second at most.
+ (void)setDownloadObserver:(void (^_Nullable)(NSDictionary<NSString*, id>* download))observer;
/// Stop the running download `downloadId` (as the observer named it); nothing when it is not running.
+ (void)cancelDownload:(NSString*)downloadId;
/// Open Chrome's DevTools for the page in a window of their own.
+ (void)showDevTools:(NSString*)targetId;
/// Move every page's view back into the hidden window (the window they are in is closing). Pages go on running there.
+ (void)parkAll;
/// The pages there are now, as the page observer tells them.
+ (NSArray<NSDictionary<NSString*, NSString*>*>*)pages;

@end

NS_ASSUME_NONNULL_END
