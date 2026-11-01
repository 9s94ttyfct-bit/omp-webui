/** The address of New chat in `cwd` (`#/new?cwd=`): an existing folder, not a new project. */
export function newChatIn(cwd: string): string {
	return `/#/new?cwd=${encodeURIComponent(cwd)}`;
}
