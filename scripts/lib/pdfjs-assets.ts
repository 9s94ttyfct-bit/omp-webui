import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * The files PDF.js loads by address while it reads a PDF (#697), served under `/pdfjs/` by the page's own server: no CDN,
 * since the page may be on a computer with no network, and its policy lets it fetch from itself only.
 *
 *   - `cmaps/`: the character maps of PDFs in Chinese, Japanese and Korean (and any PDF with a predefined encoding): without
 *     them the text of such a page is lost, and a scan's text layer with it.
 *   - `wasm/`: the decoders of the image formats scanners write (JBIG2, and CCITT fax with it, and JPEG 2000), and the
 *     plain JavaScript each falls back to where the page's policy forbids WebAssembly (it does: no `wasm-unsafe-eval`).
 *
 * The standard fonts, the colour profiles and the script engine are left out: a page is drawn without them, with its
 * reader's own fonts for the letters a PDF does not carry. `lib/pdf.ts` names the two directories.
 */

const WASM = ["jbig2.wasm", "jbig2_nowasm_fallback.js", "openjpeg.wasm", "openjpeg_nowasm_fallback.js"];

/** Every file served, by its path under `/pdfjs/` and where it is on disk. */
function assets(root: string): Map<string, string> {
	const pdfjs = join(root, "node_modules", "pdfjs-dist");
	const out = new Map<string, string>();
	for (const name of readdirSync(join(pdfjs, "cmaps"))) out.set(`cmaps/${name}`, join(pdfjs, "cmaps", name));
	for (const name of WASM) out.set(`wasm/${name}`, join(pdfjs, "wasm", name));
	return out;
}

/** What a file is served as: a module is fetched with `import()`, which wants a JavaScript type. */
function typeOf(path: string): string {
	if (path.endsWith(".wasm")) return "application/wasm";
	return path.endsWith(".js") ? "text/javascript" : "application/octet-stream";
}

export function pdfjsAssets(root: string): Plugin {
	const dir = resolve(root);
	return {
		name: "ompw-pdfjs-assets",
		// The dev server answers for them from node_modules; a build writes them next to the page's own files.
		configureServer(server) {
			const files = assets(dir);
			server.middlewares.use("/pdfjs/", (req, res, next) => {
				const path = (req.url ?? "").replace(/^\/+/, "").split("?")[0] ?? "";
				const abs = files.get(path);
				if (!abs) return next();
				res.setHeader("content-type", typeOf(path));
				res.end(readFileSync(abs));
			});
		},
		generateBundle() {
			for (const [path, abs] of assets(dir)) {
				this.emitFile({ type: "asset", fileName: `pdfjs/${path}`, source: readFileSync(abs) });
			}
		},
	};
}
