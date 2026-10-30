/**
 * What the keys are called on this machine. Apple platforms write shortcuts with symbols (⌘⇧O); everywhere
 * else they are spelled out (Ctrl+Shift+O). Every shortcut hint in the UI goes through here.
 */

/** macOS, iOS and iPadOS. Outside a page (unit tests) there is no `navigator`, which counts as not Apple. */
export const isApple =
	typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** One key as the user sees it. "Mod" is the platform's command key: ⌘ or Ctrl. */
export function keyLabel(key: string, apple = isApple): string {
	if (key === "Mod") return apple ? "⌘" : "Ctrl";
	if (key === "Shift") return apple ? "⇧" : "Shift";
	if (key === "Enter") return apple ? "↵" : "Enter";
	if (key === "Alt") return apple ? "⌥" : "Alt";
	return key;
}

/** A whole shortcut from its keys (`SHORTCUTS[id].keys`): `⌘⇧O` on Apple platforms, `Ctrl+Shift+O` elsewhere. */
export function shortcutLabel(keys: readonly string[], apple = isApple): string {
	return keys.map((k) => keyLabel(k, apple)).join(apple ? "" : "+");
}
