/**
 * A random id for something the page names itself (an attached picture, a browser window). Not `crypto.randomUUID`: it
 * exists only in a secure context, and a page served over plain http on the network (`OMP_WEBUI_HOST`) is not one, so a call
 * to it throws there. `crypto.getRandomValues` is in every page.
 */
export function randomId(): string {
	const b = crypto.getRandomValues(new Uint8Array(16));
	// Version 4, variant 10: a UUID as `randomUUID` writes it.
	b[6] = ((b[6] as number) & 0x0f) | 0x40;
	b[8] = ((b[8] as number) & 0x3f) | 0x80;
	const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
