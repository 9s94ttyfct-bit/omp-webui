/**
 * The address of New chat in `cwd` (`#/new?cwd=`): an existing folder, not a new project. `base` is the page before the
 * hash: another server's (`${s.url}/?token=…`), or the worker's own (`/`).
 */
export function newChatIn(cwd: string, base = "/"): string {
	return `${base}#/new?cwd=${encodeURIComponent(cwd)}`;
}
