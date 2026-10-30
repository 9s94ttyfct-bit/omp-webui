/**
 * Terminal escape sequences: CSI (colour, style, cursor and erase), OSC (titles and hyperlinks, ended by BEL or ST)
 * and the two-character escapes. omp writes what its local commands print (`/context`) for a terminal; the page
 * shows it as text.
 */
const ESCAPES =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character is what this matches
	/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])|\u009b[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
	return text.replace(ESCAPES, "");
}
