/** A fence of backticks longer than any run of them in `text`, so that nothing in it can close the fence. */
export function fenceFor(text: string): string {
	let longest = 0;
	for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	return "`".repeat(Math.max(3, longest + 1));
}
