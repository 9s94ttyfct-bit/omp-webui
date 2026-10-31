import WebKit

/// What every web view the app makes is set to, in whichever window it is: the app's own (`buildWindow` in main.swift), a
/// pop-out (popout.swift) and a window onto another Mac (remotewindow.swift).
func prepareWebView(_ web: WKWebView) {
	// The page is never zoomed in the app: the UI is laid out for the window it is in. With magnification off WebKit
	// zooms on neither a pinch nor a smart zoom (a two-finger double tap), and the menu has no command for ⌘= ⌘- ⌘0
	// (appmenu.swift): those reach the page as plain keystrokes. A browser tab keeps its browser's zoom.
	web.allowsMagnification = false
	web.setValue(false, forKey: "drawsBackground")
	// WebKit holds back a page whose window other windows cover: its timers coarsen to seconds and what arrives over its
	// sockets is handled late, in bursts, so a transcript that is partly in view beside another app's window goes stale (#381).
	// The app turns that detection off for its web views. A WebKit without the switch just keeps its behaviour.
	if web.responds(to: NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")) {
		web.setValue(false, forKey: "windowOcclusionDetectionEnabled")
	}
}
