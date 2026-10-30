/**
 * What `scripts/bench.ts` installs in the page before the app loads (`addInitScript(benchRecorder, …)`): clocks and
 * recorders that read only what a browser exposes (the DOM, the WebSocket, the performance timeline), so they work
 * on any version of the app. Everything is on `window.__bench`; the harness drives and reads it with `page.evaluate`.
 *
 * `benchRecorder` is serialised into the page: it must not use anything from this module.
 */

export interface ArmResult {
	/** When the click happened (page clock, ms): `event.timeStamp` of the click that started it. */
	t0: number;
	/** When the awaited element was in the DOM and the frame after it was painted; null if it never was. */
	painted: number | null;
}

export interface ScrollResult {
	/** Gaps between animation frames while scrolling (ms). */
	gaps: number[];
	startAt: number;
	endAt: number;
	/** How far it got, and how tall the thing it scrolled is. */
	distance: number;
	scrollHeight: number;
}

export interface RevealResult {
	/** Click → painted, per click (ms). */
	clicks: number[];
	/** Frames spent waiting for a busy button (a page of history on its way) instead of clicking it. */
	waits: number;
	startAt: number;
	endAt: number;
}

export interface StreamRecord {
	frames: number;
	bytes: number;
	deltas: number;
	firstDeltaAt: number | null;
	agentEndAt: number | null;
	/** Frame arrival → the main thread starts handling it (ms), per delta frame. */
	queue: number[];
	/** Frame arrival → the first paint after the page changed (ms), per delta frame. */
	toPaint: number[];
	/** Gaps between animation frames from the first delta to the end of the turn (ms). */
	gaps: number[];
}

export interface BenchApi {
	lt: { start: number; dur: number }[];
	lcp: number | null;
	listReadyAt: number | null;
	armed: Promise<ArmResult> | null;
	arm(selector: string, timeoutMs: number): void;
	scroll(selector: string, speed: number, maxDistance: number, maxMs: number): Promise<ScrollResult>;
	reveal(buttonSelector: string, scrollerSelector: string, maxClicks: number, maxMs: number): Promise<RevealResult>;
	ws: StreamRecord;
}

declare global {
	interface Window {
		__bench: BenchApi;
	}
}

/** Rows in the sidebar that mean "the list is on screen" (the list is windowed: a screenful of rows is in the page, not all of them). */
export const LIST_MIN_ROWS = 10;

export function benchRecorder(listMin: number): void {
	const ws: StreamRecord = {
		frames: 0,
		bytes: 0,
		deltas: 0,
		firstDeltaAt: null,
		agentEndAt: null,
		queue: [],
		toPaint: [],
		gaps: [],
	};
	const b = { lt: [], lcp: null, listReadyAt: null, armed: null, ws } as unknown as Window["__bench"];
	window.__bench = b;

	/** `cb` with the time after the next frame has been painted: the animation frame callbacks run, the page is painted, then a message task runs. */
	const afterPaint = (cb: (t: number) => void) =>
		requestAnimationFrame(() => {
			const channel = new MessageChannel();
			channel.port1.onmessage = () => {
				channel.port1.close();
				cb(performance.now());
			};
			channel.port2.postMessage(0);
		});

	new PerformanceObserver((list) => {
		for (const e of list.getEntries()) b.lt.push({ start: e.startTime, dur: e.duration });
	}).observe({ type: "longtask", buffered: true });
	new PerformanceObserver((list) => {
		for (const e of list.getEntries()) b.lcp = e.startTime;
	}).observe({ type: "largest-contentful-paint", buffered: true });

	// The conversation list is on screen: rows in the sidebar, and painted.
	const pollList = () => {
		if (document.querySelectorAll('[data-testid="session-item"]').length >= listMin) {
			afterPaint((t) => {
				b.listReadyAt = t;
			});
			return;
		}
		requestAnimationFrame(pollList);
	};
	requestAnimationFrame(pollList);

	// A click, and what it is waiting for: the element appearing in the DOM, then the frame after it painted.
	b.arm = (selector, timeoutMs) => {
		const { promise, resolve } = Promise.withResolvers<ArmResult>();
		b.armed = promise;
		const onClick = (e: Event) => {
			document.removeEventListener("click", onClick, true);
			const t0 = e.timeStamp;
			const observer = new MutationObserver(() => {
				if (!document.querySelector(selector)) return;
				observer.disconnect();
				clearTimeout(timer);
				afterPaint((painted) => resolve({ t0, painted }));
			});
			const timer = setTimeout(() => {
				observer.disconnect();
				resolve({ t0, painted: null });
			}, timeoutMs);
			observer.observe(document.documentElement, { subtree: true, childList: true });
		};
		document.addEventListener("click", onClick, true);
	};

	// A scroll at a steady speed (px/s) from the top of `selector`, as far as `maxDistance` or its end.
	b.scroll = (selector, speed, maxDistance, maxMs) => {
		const { promise, resolve } = Promise.withResolvers<ScrollResult>();
		const el = document.querySelector(selector) as HTMLElement;
		el.scrollTop = 0;
		const gaps: number[] = [];
		requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				const startAt = performance.now();
				let first = 0;
				let last = 0;
				const tick = (ts: number) => {
					if (!first) first = ts;
					else gaps.push(ts - last);
					last = ts;
					const limit = Math.min(maxDistance, el.scrollHeight - el.clientHeight);
					const want = ((ts - first) * speed) / 1000;
					el.scrollTop = Math.min(want, limit);
					if (want >= limit || ts - first > maxMs) {
						resolve({ gaps, startAt, endAt: performance.now(), distance: el.scrollTop, scrollHeight: el.scrollHeight });
						return;
					}
					requestAnimationFrame(tick);
				};
				requestAnimationFrame(tick);
			}),
		);
		return promise;
	};

	// "Show earlier messages" clicked from the top, over and over, until it is gone: the way to the first message. A reader
	// clicks again when what the last click asked for has come: a page that brings its history in on demand asks the server
	// for the page above the held ones before the reader reaches them, and a click that arrives before it reveals only what is
	// held (a part of a step, or a spinner that reveals nothing). So the loop waits for a history request that is on its way
	// (`/api/family`, and the two frames after its answer) and for a busy button (`aria-busy`) before it clicks: the number of
	// clicks is then how much there is to read, not how much faster than the server the loop clicks. A page that holds all of
	// the history asks for nothing and has no busy button, so it is clicked exactly as before.
	b.reveal = async (buttonSelector, scrollerSelector, maxClicks, maxMs) => {
		const scroller = document.querySelector(scrollerSelector) as HTMLElement;
		let onItsWay = 0;
		const realFetch = window.fetch;
		const counting = (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
			const answer = realFetch.call(window, input, init);
			if (!url.includes("/api/family?")) return answer;
			onItsWay++;
			const done = () =>
				requestAnimationFrame(() =>
					requestAnimationFrame(() => {
						onItsWay--;
					}),
				);
			answer.then(done, done);
			return answer;
		};
		window.fetch = counting as typeof fetch;
		const clicks: number[] = [];
		let waits = 0;
		const startAt = performance.now();
		try {
			while (clicks.length < maxClicks && performance.now() - startAt < maxMs) {
				scroller.scrollTop = 0;
				const button = document.querySelector(buttonSelector) as HTMLElement | null;
				if (!button) break;
				if (onItsWay > 0 || button.getAttribute("aria-busy") === "true") {
					waits++;
					await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
					continue;
				}
				const painted = Promise.withResolvers<number>();
				const t0 = performance.now();
				button.click();
				afterPaint(painted.resolve);
				clicks.push((await painted.promise) - t0);
			}
		} finally {
			window.fetch = realFetch;
		}
		return { clicks, waits, startAt, endAt: performance.now() };
	};

	// What the socket carries while a turn streams: when each delta arrived, how long the page took to show it.
	const pending: number[] = [];
	let watching = false;
	const observer = new MutationObserver(() => {
		if (!pending.length) return;
		const batch = pending.splice(0);
		afterPaint((t) => {
			for (const arrived of batch) ws.toPaint.push(t - arrived);
		});
	});
	let frameId = 0;
	let stopFrames = false;
	const startFrames = () => {
		let last = 0;
		const tick = (ts: number) => {
			if (stopFrames) return;
			if (last) ws.gaps.push(ts - last);
			last = ts;
			frameId = requestAnimationFrame(tick);
		};
		frameId = requestAnimationFrame(tick);
	};
	const record = (ev: MessageEvent) => {
		const now = performance.now();
		const s = typeof ev.data === "string" ? ev.data : "";
		ws.frames++;
		ws.bytes += s.length;
		if (s.length > 100_000) return;
		if (
			s.includes('"type":"text_delta"') ||
			s.includes('"type":"thinking_delta"') ||
			s.includes('"type":"toolcall_delta"') ||
			s.includes('"type":"tool_execution_update"')
		) {
			if (ws.firstDeltaAt === null) {
				ws.firstDeltaAt = now;
				startFrames();
			}
			if (!watching) {
				const transcript = document.querySelector('[data-testid="transcript"]');
				if (transcript) {
					watching = true;
					observer.observe(transcript, { subtree: true, childList: true, characterData: true });
				}
			}
			ws.deltas++;
			ws.queue.push(now - ev.timeStamp);
			pending.push(ev.timeStamp);
		} else if (ws.firstDeltaAt !== null && ws.agentEndAt === null && s.includes('"type":"agent_end"')) {
			ws.agentEndAt = now;
			stopFrames = true;
			cancelAnimationFrame(frameId);
		}
	};
	const NativeWebSocket = window.WebSocket;
	window.WebSocket = class extends NativeWebSocket {
		constructor(url: string | URL, protocols?: string | string[]) {
			super(url, protocols);
			// Registered before the app's own handler, so it runs first for every message.
			this.addEventListener("message", record);
		}
	};
	// Not the app's business, and not what is measured: a stored language or title setting must not vary with the machine.
	localStorage.setItem("ompw.autoTitle", "off");
}
