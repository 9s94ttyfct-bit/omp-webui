// The app's NSApplication: CEF needs to know when AppKit is dispatching an event (`CefAppProtocol`, see
// OmpApplication.mm). Made as the shared application in main.swift (`OmpApplication.shared`), before anything else asks for it.
#import <Cocoa/Cocoa.h>

@interface OmpApplication : NSApplication
@end
