#import "CEFHost.h"

#include <cstdlib>
#include <functional>
#include <map>
#include <string>
#include <string_view>

#include "include/cef_app.h"
#include "include/cef_browser.h"
#include "include/cef_client.h"
#include "include/cef_command_line.h"
#include "include/cef_devtools_message_observer.h"
#include "include/cef_display_handler.h"
#include "include/cef_focus_handler.h"
#include "include/cef_life_span_handler.h"
#include "include/cef_parser.h"
#include "include/wrapper/cef_library_loader.h"

// What the feasibility spike (Task 1) proved, in the app's shape: the framework is loaded from the data folder
// (`cef_load_library`), CEF runs on the app's own run loop (external message pump), the helpers are the app's
// "omp-webui Helper" bundles and are told where the framework is, pages are windowed CefBrowsers whose views can move
// between windows and keep running in a hidden one, and CDP goes through each page's DevTools channel. A CDP message is
// never sent from inside a DevTools callback (Chromium's observer lists refuse re-entry): every send is posted.

namespace {

/// The folder that holds "Chromium Embedded Framework.framework".
std::string gFramework;
bool gRunning = false;
/// Where every page's view is made and parked: a borderless window that is never ordered in.
NSWindow* gHidden = nil;
void (^gObserver)(NSString*, NSString*) = nil;
void (^gPageObserver)(NSString*, NSDictionary<NSString*, NSString*>* _Nullable) = nil;

/// The host's own CDP calls are numbered from here: the server numbers its own from 1 up.
constexpr int kOwnIds = 1 << 30;
int gNextOwn = kOwnIds;
std::map<int, std::function<void(bool ok, const std::string& json)>> gOwnCalls;

struct Page {
  CefRefPtr<CefBrowser> browser;
  CefRefPtr<CefRegistration> observer;
  /// Its DevTools target id, once CEF said it (until then nothing can name the page).
  std::string targetId;
  std::string url;
  std::string title;
  /// The page that opened it (its CefBrowser identifier; 0 for none), and its target id once that is known.
  int openerKey = 0;
  std::string openerId;
};
/// By CefBrowser identifier.
std::map<int, Page> gPages;

NSString* ns(const std::string& s) {
  return [[NSString alloc] initWithBytes:s.data() length:s.size() encoding:NSUTF8StringEncoding] ?: @"";
}

Page* pageOf(NSString* targetId) {
  std::string id = targetId.UTF8String;
  for (auto& [_, page] : gPages)
    if (page.targetId == id) return &page;
  return nullptr;
}

/// What the server is told of a page (`AppPage` of server/browser/cef.ts).
NSDictionary<NSString*, NSString*>* infoOf(const Page& page) {
  NSMutableDictionary* info = [@{@"targetId" : ns(page.targetId), @"url" : ns(page.url), @"title" : ns(page.title)} mutableCopy];
  if (!page.openerId.empty()) info[@"openerId"] = ns(page.openerId);
  return info;
}

/// The page appeared or changed (`closed`: it is gone), told on the next turn of the run loop.
void tell(const Page& page, bool closed = false) {
  if (page.targetId.empty() || !gPageObserver) return;
  auto observer = gPageObserver;
  NSString* target = ns(page.targetId);
  NSDictionary* info = closed ? nil : infoOf(page);
  dispatch_async(dispatch_get_main_queue(), ^{
    observer(target, info);
  });
}

/// Send on the next turn of the run loop, never from inside a CEF callback.
void post(CefRefPtr<CefBrowser> browser, std::string message) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (browser->IsValid()) browser->GetHost()->SendDevToolsMessage(message.data(), message.size());
  });
}

void ownCall(CefRefPtr<CefBrowser> browser,
             const std::string& method,
             std::function<void(bool, const std::string&)> done) {
  int id = gNextOwn++;
  gOwnCalls[id] = std::move(done);
  post(browser, "{\"id\":" + std::to_string(id) + ",\"method\":\"" + method + "\",\"params\":{}}");
}

/// The `id` a CDP answer starts with (`{"id":N,`), or -1 for an event.
int answerId(const char* data, size_t size) {
  static const char kPrefix[] = "{\"id\":";
  const size_t n = sizeof(kPrefix) - 1;
  if (size <= n || std::string_view(data, n) != kPrefix) return -1;
  long v = 0;
  for (size_t i = n; i < size && data[i] >= '0' && data[i] <= '9'; i++) v = v * 10 + (data[i] - '0');
  return v > INT32_MAX ? -1 : (int)v;
}

class Observer : public CefDevToolsMessageObserver {
 public:
  bool OnDevToolsMessage(CefRefPtr<CefBrowser> browser, const void* message, size_t size) override {
    const char* data = static_cast<const char*>(message);
    int id = answerId(data, size);
    if (id >= kOwnIds) {
      auto it = gOwnCalls.find(id);
      if (it != gOwnCalls.end()) {
        auto done = std::move(it->second);
        gOwnCalls.erase(it);
        std::string json(data, size);
        done(json.find("\"error\"") == std::string::npos, json);
      }
      return true;
    }
    auto page = gPages.find(browser->GetIdentifier());
    if (page == gPages.end() || page->second.targetId.empty() || !gObserver) return true;
    NSString* target = ns(page->second.targetId);
    NSString* json = ns(std::string(data, size));
    auto observer = gObserver;
    dispatch_async(dispatch_get_main_queue(), ^{
      observer(target, json);
    });
    return true;
  }
  IMPLEMENT_REFCOUNTING(Observer);
};

class Client : public CefClient, public CefLifeSpanHandler, public CefDisplayHandler, public CefFocusHandler {
 public:
  Client(void (^reply)(NSString* _Nullable), int openerKey) : reply_(reply), openerKey_(openerKey) {}

  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefFocusHandler> GetFocusHandler() override { return this; }

  // A page takes the keyboard only when the person clicks in it: never because it loaded (the composer keeps it).
  bool OnSetFocus(CefRefPtr<CefBrowser>, FocusSource source) override { return source == FOCUS_SOURCE_NAVIGATION; }

  // A page opened by another (`window.open`, a link to a new tab) is another page in the hidden window, never a window
  // of its own: the server shows it as another tab of the opener's conversation.
  bool OnBeforePopup(CefRefPtr<CefBrowser> opener,
                     CefRefPtr<CefFrame>,
                     int,
                     const CefString&,
                     const CefString&,
                     WindowOpenDisposition,
                     bool,
                     const CefPopupFeatures&,
                     CefWindowInfo& windowInfo,
                     CefRefPtr<CefClient>& client,
                     CefBrowserSettings&,
                     CefRefPtr<CefDictionaryValue>&,
                     bool*) override {
    NSView* parent = gHidden.contentView;
    windowInfo.SetAsChild((__bridge void*)parent, CefRect(0, 0, (int)parent.bounds.size.width, (int)parent.bounds.size.height));
    client = new Client(nil, opener->GetIdentifier());
    return false;
  }

  void OnAddressChange(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame, const CefString& url) override {
    if (!frame->IsMain()) return;
    auto it = gPages.find(browser->GetIdentifier());
    if (it == gPages.end()) return;
    it->second.url = url.ToString();
    tell(it->second);
  }

  void OnTitleChange(CefRefPtr<CefBrowser> browser, const CefString& title) override {
    auto it = gPages.find(browser->GetIdentifier());
    if (it == gPages.end()) return;
    it->second.title = title.ToString();
    tell(it->second);
  }

  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    Page& page = gPages[browser->GetIdentifier()];
    page.browser = browser;
    page.observer = browser->GetHost()->AddDevToolsMessageObserver(new Observer());
    page.openerKey = openerKey_;
    page.url = browser->GetMainFrame() ? browser->GetMainFrame()->GetURL().ToString() : "";
    auto reply = reply_;
    reply_ = nil;
    int key = browser->GetIdentifier();
    ownCall(browser, "Target.getTargetInfo", [key, reply](bool ok, const std::string& json) {
      std::string targetId;
      if (ok) {
        CefRefPtr<CefValue> v = CefParseJSON(json, JSON_PARSER_RFC);
        CefRefPtr<CefDictionaryValue> result = v ? v->GetDictionary()->GetDictionary("result") : nullptr;
        CefRefPtr<CefDictionaryValue> info = result ? result->GetDictionary("targetInfo") : nullptr;
        if (info) targetId = info->GetString("targetId");
      }
      auto it = gPages.find(key);
      if (it == gPages.end()) {
        if (reply) reply(nil);
        return;
      }
      Page& made = it->second;
      made.targetId = targetId;
      auto opener = gPages.find(made.openerKey);
      if (opener != gPages.end()) made.openerId = opener->second.targetId;
      // Told before the reply (both on the next turns of the run loop, in this order): the server knows the page by the
      // time `create` is answered.
      tell(made);
      if (!reply) return;
      NSString* made_id = targetId.empty() ? nil : ns(targetId);
      dispatch_async(dispatch_get_main_queue(), ^{
        reply(made_id);
      });
    });
  }

  // A page closes in place, never through its window. CEF's default (`false`) asks the window the page's view is in to
  // close (`performClose:`): the hidden window cannot, so the page stayed open, and the app's own window, while its
  // Browser tab showed the page, took it for the person closing the window and quit the app (#32). The close is completed
  // as the header says it may be, by taking the view out of its window: CEF's view going is the end of the browser,
  // then `OnBeforeClose`. On the run loop rather than the main queue, so that it runs inside `shutdown`'s wait too, which
  // runs inside a block of the main queue at quit.
  bool DoClose(CefRefPtr<CefBrowser> browser) override {
    NSView* view = (__bridge NSView*)browser->GetHost()->GetWindowHandle();
    CFRunLoopPerformBlock(CFRunLoopGetMain(), kCFRunLoopCommonModes, ^{
      [view removeFromSuperview];
    });
    CFRunLoopWakeUp(CFRunLoopGetMain());
    return true;
  }

  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
    auto it = gPages.find(browser->GetIdentifier());
    if (it == gPages.end()) return;
    tell(it->second, true);
    it->second.observer = nullptr;
    gPages.erase(it);
  }

 private:
  void (^reply_)(NSString* _Nullable);
  int openerKey_;
  IMPLEMENT_REFCOUNTING(Client);
};

class App : public CefApp, public CefBrowserProcessHandler {
 public:
  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override { return this; }

  void OnBeforeCommandLineProcessing(const CefString& process_type, CefRefPtr<CefCommandLine> line) override {
    if (!process_type.empty()) return;
    // Never the macOS keychain ("Chromium Safe Storage"): it would ask the person for their login password. The profile's
    // cookies are kept by the data folder's own permissions instead, as for Chrome for Testing (server/browser/cft.ts).
    line->AppendSwitch("use-mock-keychain");
    // Chrome's WebMCP (a page's declared tools), which the agents' browser tool reads through CDP: still behind a flag,
    // as for Chrome for Testing (server/browser/cft.ts).
    line->AppendSwitchWithValue("enable-features", "WebMCP");
  }

  // The helpers are the app's own bundles, not CEF's; each is told where the framework is.
  void OnBeforeChildProcessLaunch(CefRefPtr<CefCommandLine> line) override {
    line->AppendSwitchWithValue("ompw-framework", gFramework);
  }

  // CEF runs on the app's run loop: it says when it next wants a turn.
  void OnScheduleMessagePumpWork(int64_t delay_ms) override {
    int64_t delay = delay_ms < 0 ? 0 : delay_ms;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, delay * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
      if (gRunning) CefDoMessageLoopWork();
    });
  }

  IMPLEMENT_REFCOUNTING(App);
};

NSError* failure(NSString* text) {
  return [NSError errorWithDomain:@"dev.omp.webui.browser" code:1 userInfo:@{NSLocalizedDescriptionKey : text}];
}

}  // namespace

@implementation CEFHost

+ (BOOL)startWithFramework:(NSString*)frameworkDir profile:(NSString*)profileDir error:(NSError**)error {
  if (gRunning) return YES;
  gFramework = frameworkDir.UTF8String;
  std::string lib = gFramework + "/Chromium Embedded Framework.framework/Chromium Embedded Framework";
  if (!cef_load_library(lib.c_str())) {
    if (error) *error = failure([NSString stringWithFormat:@"Could not load %s", lib.c_str()]);
    return NO;
  }
  NSString* bundle = NSBundle.mainBundle.bundlePath;
  NSString* helper =
      [bundle stringByAppendingPathComponent:@"Contents/Frameworks/omp-webui Helper.app/Contents/MacOS/omp-webui Helper"];
  CefSettings settings;
  settings.no_sandbox = 1;
  settings.external_message_pump = 1;
  settings.persist_session_cookies = 1;
  settings.remote_debugging_port = 0;
  settings.log_severity = LOGSEVERITY_WARNING;
  CefString(&settings.main_bundle_path) = bundle.UTF8String;
  CefString(&settings.framework_dir_path) = gFramework + "/Chromium Embedded Framework.framework";
  CefString(&settings.browser_subprocess_path) = helper.UTF8String;
  CefString(&settings.root_cache_path) = profileDir.UTF8String;
  CefString(&settings.cache_path) = profileDir.UTF8String;
  CefString(&settings.log_file) = [profileDir stringByAppendingString:@".log"].UTF8String;
  CefMainArgs args(0, nullptr);
  CefRefPtr<App> app(new App());
  if (!CefInitialize(args, settings, app.get(), nullptr)) {
    cef_unload_library();
    if (error) *error = failure(@"CEF did not start");
    return NO;
  }
  gRunning = true;
  gHidden = [[NSWindow alloc] initWithContentRect:NSMakeRect(-20000, -20000, 1280, 800)
                                        styleMask:NSWindowStyleMaskBorderless
                                          backing:NSBackingStoreBuffered
                                            defer:NO];
  gHidden.releasedWhenClosed = NO;
  // A turn now and then besides the ones CEF asks for, as CEF's own samples do with an external pump.
  [NSTimer scheduledTimerWithTimeInterval:1.0 / 30
                                  repeats:YES
                                    block:^(NSTimer* timer) {
                                      if (gRunning)
                                        CefDoMessageLoopWork();
                                      else
                                        [timer invalidate];
                                    }];
  return YES;
}

+ (BOOL)running {
  return gRunning;
}

+ (void)shutdown {
  if (!gRunning) return;
  gPageObserver = nil;
  for (auto& [_, page] : gPages) page.browser->GetHost()->CloseBrowser(true);
  NSDate* deadline = [NSDate dateWithTimeIntervalSinceNow:3];
  while (!gPages.empty() && [deadline timeIntervalSinceNow] > 0) {
    CefDoMessageLoopWork();
    [NSRunLoop.mainRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
  }
  gRunning = false;
  gObserver = nil;
  gOwnCalls.clear();
  gPages.clear();
  CefShutdown();
  cef_unload_library();
}

+ (NSView*)viewForTarget:(NSString*)targetId {
  Page* page = pageOf(targetId);
  return page ? (__bridge NSView*)page->browser->GetHost()->GetWindowHandle() : nil;
}

+ (void)createPage:(NSString*)url reply:(void (^)(NSString* _Nullable))reply {
  if (!gRunning) return reply(nil);
  NSView* parent = gHidden.contentView;
  CefWindowInfo info;
  info.SetAsChild((__bridge void*)parent, CefRect(0, 0, (int)parent.bounds.size.width, (int)parent.bounds.size.height));
  CefBrowserSettings settings;
  if (!CefBrowserHost::CreateBrowser(info, new Client(reply, 0), url.UTF8String, settings, nullptr, nullptr)) reply(nil);
}

+ (void)closePage:(NSString*)targetId {
  Page* page = pageOf(targetId);
  if (page) page->browser->GetHost()->CloseBrowser(true);
}

+ (void)sendCdp:(NSString*)targetId message:(NSString*)json {
  Page* page = pageOf(targetId);
  if (page) post(page->browser, json.UTF8String);
}

+ (void)setCdpObserver:(void (^)(NSString*, NSString*))observer {
  gObserver = observer;
}

+ (void)setPageObserver:(void (^)(NSString*, NSDictionary<NSString*, NSString*>* _Nullable))observer {
  gPageObserver = observer;
}

+ (void)showDevTools:(NSString*)targetId {
  Page* page = pageOf(targetId);
  if (!page) return;
  CefWindowInfo info;
  CefBrowserSettings settings;
  page->browser->GetHost()->ShowDevTools(info, nullptr, settings, CefPoint());
}

+ (void)parkAll {
  if (!gHidden) return;
  for (auto& [_, page] : gPages) {
    NSView* view = (__bridge NSView*)page.browser->GetHost()->GetWindowHandle();
    if (!view || view.window == gHidden) continue;
    [view removeFromSuperview];
    [gHidden.contentView addSubview:view];
  }
}

+ (NSArray<NSDictionary<NSString*, NSString*>*>*)pages {
  NSMutableArray* all = [NSMutableArray array];
  for (auto& [_, page] : gPages)
    if (!page.targetId.empty()) [all addObject:infoOf(page)];
  return all;
}

@end
