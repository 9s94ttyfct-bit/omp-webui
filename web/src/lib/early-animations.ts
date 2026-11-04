/**
 * WebKit (the Mac app's window, Safari) draws a CSS animation that began while the page was loading at a few frames a
 * second for as long as it runs: the spinner and the bar of a tool that was running when the page opened (the window
 * opened again from the background, a reload) step instead of turning, for minutes. One that begins later runs at the
 * display's rate, and so does one started again; so once the page has loaded, the CSS animations it has are started again
 * where they are (an animation made by script is left alone: one that ends is waited for).
 */
export function restartEarlyAnimations(): void {
	if (typeof document.getAnimations !== "function" || typeof CSSAnimation === "undefined") return;
	for (const animation of document.getAnimations()) {
		if (!(animation instanceof CSSAnimation) || animation.playState !== "running") continue;
		const at = animation.currentTime;
		animation.cancel();
		animation.play();
		animation.currentTime = at;
	}
}
