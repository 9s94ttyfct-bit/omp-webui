import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { chunkModules } from "./scripts/lib/chunk-modules.ts";
import { pdfjsAssets } from "./scripts/lib/pdfjs-assets.ts";

const serverPort = Number(process.env.OMP_WEBUI_PORT ?? 7878);

/**
 * The packages the page's own component library (`components/ui.tsx`: the buttons, the dialogs, the tooltips) is built
 * on: Radix's dialog and tooltip with what they use, the floating-ui they position with, the scroll lock and the rest
 * of their small helpers.
 */
const UI_PACKAGES =
	/@radix-ui\/|@floating-ui\/|aria-hidden\/|clsx\/|get-nonce\/|react-remove-scroll\/|react-style-singleton\/|tslib\/|use-callback-ref\/|use-sidecar\/|react-dom\/|lucide-react\//;

export default defineConfig({
	root: "web",
	plugins: [
		react(),
		tailwindcss(),
		chunkModules(new URL(".", import.meta.url).pathname),
		pdfjsAssets(new URL(".", import.meta.url).pathname),
	],
	resolve: {
		alias: { "@shared": new URL("./shared", import.meta.url).pathname },
	},
	build: {
		outDir: "../dist/web",
		emptyOutDir: true,
		chunkSizeWarningLimit: 1500,
		// A font is always a file of its own, never a `data:` URL in the stylesheet: the page's Content-Security-Policy loads
		// fonts from the page's own origin only (`server/csp.ts`), so an inlined one (KaTeX's smallest, the Markdown editor's
		// math) would be refused. Anything else keeps Vite's own limit.
		assetsInlineLimit: (file) => (/\.(?:woff2?|ttf|otf|eot)$/i.test(file) ? false : undefined),
		rolldownOptions: {
			output: {
				codeSplitting: {
					groups: [
						{
							// The code the first paint shares with the pages that load after it: the stores, the
							// libraries, the page's own component library and the packages it is built on.
							//
							// The bundler would otherwise give every one of those a chunk of its own, and the first
							// load would fetch a file for each of them: the first paint paid for a request per sharing
							// set, for code it shares with the pages that come later. One group, and the first load
							// fetches one file for all of it.
							name: "app",
							test: (id) => {
								const path = id.split("?")[0].replace(/\\/g, "/");
								if (path.includes("/web/src/i18n/")) return false;
								if (path.endsWith("/web/src/components/ui.tsx")) return true;
								if (
									path.includes("/web/src/lib/") ||
									path.includes("/web/src/store/") ||
									path.includes("/web/shared/")
								) {
									return true;
								}
								return path.lastIndexOf("/node_modules/") >= 0 && UI_PACKAGES.test(path);
							},
							// Only what more than one entry uses: what the first paint uses alone stays in its file.
							minShareCount: 2,
							priority: 200,
							// And only what the first paint reaches (`$initial`: statically imported from the page's entry). Without
							// this the group took every module of `lib/` and `store/` that two lazy pages share (the conversation and
							// the subagent views use the same diff, transcript and agent code) into this file, and the first load
							// carried code that only those pages run: 9 KiB gzip by the time of #583. What the lazy pages share
							// among themselves is theirs to fetch with them.
							tags: ["$initial"],
						},
					],
				},
			},
		},
	},
	// The highlighter's worker loads its grammars and themes on demand, which needs code splitting (not an IIFE).
	worker: { format: "es" },
	server: {
		port: 5173,
		proxy: {
			"/api": `http://127.0.0.1:${serverPort}`,
			"/ws": { target: `ws://127.0.0.1:${serverPort}`, ws: true },
		},
	},
});
