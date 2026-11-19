/**
 * The page is built for Safari and iOS 16.4, Chrome 111 and Firefox 114 (Vite's default target, which lowers syntax and
 * adds no runtime API). `Promise.withResolvers` is in Safari 17.4, Chrome 119 and Firefox 121: on an iPhone that stays on
 * iOS 16, in an un-updated Safari or in the Mac app's web view on macOS 13 the page would load and then list nothing, as its
 * socket's first request throws. It is added where it is missing, before the page makes any request.
 */
export function installPolyfills(): void {
	if (typeof Promise.withResolvers === "function") return;
	Promise.withResolvers = function withResolvers<T>() {
		let resolve!: (value?: T | PromiseLike<T>) => void;
		let reject!: (reason?: unknown) => void;
		const promise = new Promise<T>((res, rej) => {
			resolve = res as (value?: T | PromiseLike<T>) => void;
			reject = rej;
		});
		return { promise, resolve, reject };
	};
}
