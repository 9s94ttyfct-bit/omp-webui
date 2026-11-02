#import "OmpApplication.h"

#include "include/cef_application_mac.h"

// CEF asks the shared application whether it is inside `sendEvent:` (`CrAppProtocol`/`CefAppProtocol`); without it,
// nested event loops in CEF (menus, drag and drop in a page) misbehave. Harmless while CEF is not started.
@interface OmpApplication () <CefAppProtocol> {
  BOOL _handlingSendEvent;
}
@end

@implementation OmpApplication

- (BOOL)isHandlingSendEvent {
  return _handlingSendEvent;
}

- (void)setHandlingSendEvent:(BOOL)handlingSendEvent {
  _handlingSendEvent = handlingSendEvent;
}

- (void)sendEvent:(NSEvent*)event {
  CefScopedSendingEvent sending;
  [super sendEvent:event];
}

@end
