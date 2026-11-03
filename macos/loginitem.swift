import AppKit
import ServiceManagement
import WebKit

// Settings › App & system › Start at login, in the macOS app: the app is its own login item (`SMAppService.mainApp`), and
// started that way it opens no window, as Run in Background leaves it (the menu bar icon is the way in). What the system says
// is what the switch shows: macOS keeps the item (System Settings › General › Login Items), and the person may turn it off
// there too. Off unless the person turns it on. The page asks through `ompwLogin` (web/src/lib/login-start.ts).

/// Whether this launch is the system starting the app at login (the open-application event says so).
func launchedAtLogin() -> Bool {
	guard let event = NSAppleEventManager.shared().currentAppleEvent, event.eventID == kAEOpenApplication else { return false }
	return event.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
}

/// The login item's state in the page's words: `on`, `off` or `approval` (on, waiting for the person in System Settings).
/// macOS says `notFound` for an app it has not registered yet in some places (a copy outside /Applications): that is off too,
/// and a `register` that cannot be done says why.
func loginItemState(_ status: SMAppService.Status) -> String {
	switch status {
	case .enabled: return "on"
	case .requiresApproval: return "approval"
	case .notRegistered, .notFound: return "off"
	@unknown default: return "off"
	}
}

/// A request of the page: what the switch is (`get`), or turn it on or off (`set`).
enum LoginRequest: Equatable {
	case get
	case set(Bool)
}

func parseLoginRequest(_ body: Any) -> LoginRequest? {
	guard let message = body as? [String: Any], let type = message["type"] as? String else { return nil }
	switch type {
	case "get": return .get
	case "set": return (message["on"] as? Bool).map { .set($0) }
	default: return nil
	}
}

final class LoginBridge: NSObject, WKScriptMessageHandlerWithReply {
	static let handlerName = "ompwLogin"

	private let origin: () -> URL?

	init(origin: @escaping () -> URL?) {
		self.origin = origin
	}

	func userContentController(
		_ controller: WKUserContentController, didReceive message: WKScriptMessage,
		replyHandler: @escaping (Any?, String?) -> Void
	) {
		let sender = message.frameInfo.securityOrigin
		guard message.frameInfo.isMainFrame, isOwnPage(scheme: sender.protocol, host: sender.host, port: sender.port, origin: origin())
		else { return replyHandler(nil, "Not available to this page.") }
		guard let request = parseLoginRequest(message.body) else { return replyHandler(nil, "Unknown request.") }
		let service = SMAppService.mainApp
		if case .set(let on) = request {
			do {
				if on { try service.register() } else { try service.unregister() }
			} catch {
				// What the system says afterwards is what the switch shows; the error says why it is not what was asked.
				return replyHandler(["state": loginItemState(service.status), "error": error.localizedDescription], nil)
			}
		}
		replyHandler(["state": loginItemState(service.status)], nil)
	}
}
