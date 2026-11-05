/**
 * What two names a person gives (a Mac's in the list of Macs, a project's in the sidebar) are compared by: case, accents,
 * width and compatibility forms do not make a name another one. One definition for the server, the page and the macOS app
 * (`foldedName` in macos/remotemacs.swift), held to the same cases (`NAME_SAME` and `NAME_DIFFERENT` in
 * tests/support/mac-vectors.ts):
 *
 * 1. NFKD (a width or a ligature becomes the letters it stands for; an accent becomes a mark after its letter),
 * 2. the marks (general category M) are dropped,
 * 3. lower case, then upper case, then lower case again: the full mappings of Unicode both ways, which make `ß`, `ẞ` and `ss`,
 *    and `σ` and `Σ`, the same letters (`toLowerCase` alone keeps `ß`),
 * 4. a final sigma `ς` is written `σ`: `toLowerCase` reads a sigma by its place in a word (`ΟΔΥΣΣΕΥΣ` ends in `ς`) and Swift's
 *    `lowercased()` does not, so neither is left to decide,
 * 5. NFC, so that what is left is written one way.
 */
export function foldName(name: string): string {
	return name
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.toUpperCase()
		.toLowerCase()
		.replace(/\u03c2/g, "\u03c3")
		.normalize("NFC");
}
