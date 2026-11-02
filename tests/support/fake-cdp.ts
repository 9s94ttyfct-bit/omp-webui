import type { TargetInfo } from "../../server/browser/registry.ts";
import { type CdpMessage, type CdpTransport, TransportListeners } from "../../server/browser/transport.ts";

/**
 * A browser for unit tests that answers the browser-level Target domain the way Chrome does (browser sessions, target
 * discovery, auto-attach, flat page sessions, pages opening pages), events before the answer that caused them. Any other
 * command is answered `{}`; `emitOnPage` stands for what a page does on its own (a console message, a frame).
 */

type Session =
	| { kind: "browser"; discover: boolean; autoAttach: boolean }
	| { kind: "page"; targetId: string; parent: string | undefined };

export class FakeBrowser implements CdpTransport {
	readonly listeners = new TransportListeners();
	readonly targets = new Map<string, TargetInfo>();
	readonly sessions = new Map<string | undefined, Session>([
		[undefined, { kind: "browser", discover: false, autoAttach: false }],
	]);
	/** Every command the browser was sent, with its session. */
	readonly log: { method: string; sessionId?: string; params?: unknown }[] = [];
	private n = 0;

	send(message: object): void {
		const m = message as CdpMessage;
		this.log.push({ method: m.method ?? "", sessionId: m.sessionId, params: m.params });
		queueMicrotask(() => this.handle(m));
	}
	onMessage(fn: (m: CdpMessage) => void) {
		return this.listeners.onMessage(fn);
	}
	onClose(fn: (why: string) => void) {
		return this.listeners.onClose(fn);
	}
	close(): void {
		this.listeners.end("closed");
	}

	/** A page opened by `opener` (`window.open`). */
	open(opener: string): string {
		return this.create("about:blank", opener);
	}

	/** An event of a page, to every session attached to it. */
	emitOnPage(targetId: string, method: string, params: object): void {
		for (const [id, s] of this.sessions)
			if (s.kind === "page" && s.targetId === targetId) this.emit(id, method, params);
	}

	private emit(sessionId: string | undefined, method: string, params: object): void {
		this.listeners.deliver({ method, params, ...(sessionId === undefined ? {} : { sessionId }) });
	}

	private create(url: string, openerId?: string): string {
		const targetId = `T${++this.n}`.padEnd(32, "0");
		const info: TargetInfo = { targetId, type: "page", url, title: url, ...(openerId ? { openerId } : {}) };
		this.targets.set(targetId, info);
		for (const [id, s] of this.sessions) {
			if (s.kind !== "browser") continue;
			if (s.discover) this.emit(id, "Target.targetCreated", { targetInfo: info });
			if (s.autoAttach) this.attach(id, targetId);
		}
		return targetId;
	}

	private attach(parent: string | undefined, targetId: string): string {
		const sessionId = `S${++this.n}`;
		this.sessions.set(sessionId, { kind: "page", targetId, parent });
		this.emit(parent, "Target.attachedToTarget", {
			sessionId,
			targetInfo: this.targets.get(targetId),
			waitingForDebugger: true,
		});
		return sessionId;
	}

	private handle(m: CdpMessage): undefined {
		const session = this.sessions.get(m.sessionId);
		const reply = (result: object): undefined => {
			this.listeners.deliver({ id: m.id, result, ...(m.sessionId ? { sessionId: m.sessionId } : {}) });
		};
		const p = (m.params ?? {}) as Record<string, unknown>;
		if (!session) {
			this.listeners.deliver({ id: m.id, error: { code: -32001, message: "Session not found" } });
			return;
		}
		switch (m.method) {
			case "Target.attachToBrowserTarget": {
				const sessionId = `B${++this.n}`;
				this.sessions.set(sessionId, { kind: "browser", discover: false, autoAttach: false });
				return reply({ sessionId });
			}
			case "Target.setDiscoverTargets":
				if (session.kind === "browser") {
					session.discover = p.discover === true;
					if (session.discover)
						for (const t of this.targets.values()) this.emit(m.sessionId, "Target.targetCreated", { targetInfo: t });
				}
				return reply({});
			case "Target.setAutoAttach":
				if (session.kind === "browser") {
					session.autoAttach = p.autoAttach === true;
					if (session.autoAttach) for (const t of this.targets.keys()) this.attach(m.sessionId, t);
				}
				return reply({});
			case "Target.getTargets":
				return reply({ targetInfos: [...this.targets.values()] });
			case "Target.createTarget":
				return reply({ targetId: this.create(String(p.url)) });
			case "Target.attachToTarget":
				return reply({ sessionId: this.attach(m.sessionId, String(p.targetId)) });
			case "Target.detachFromTarget": {
				const child = this.sessions.get(String(p.sessionId));
				this.sessions.delete(String(p.sessionId));
				if (child?.kind === "page")
					this.emit(m.sessionId, "Target.detachedFromTarget", { sessionId: p.sessionId, targetId: child.targetId });
				return reply({});
			}
			case "Target.closeTarget": {
				const targetId = String(p.targetId);
				this.targets.delete(targetId);
				for (const [id, s] of [...this.sessions]) {
					if (s.kind === "page" && s.targetId === targetId) {
						this.sessions.delete(id);
						this.emit(s.parent, "Target.detachedFromTarget", { sessionId: id, targetId });
					}
				}
				for (const [id, s] of this.sessions)
					if (s.kind === "browser" && s.discover) this.emit(id, "Target.targetDestroyed", { targetId });
				return reply({ success: true });
			}
			case "Browser.getVersion":
				return reply({ product: "Chrome/1.0", protocolVersion: "1.3", userAgent: "fake", jsVersion: "1" });
			default:
				return reply({});
		}
	}
}
