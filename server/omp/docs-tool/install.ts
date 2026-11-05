import { join } from "node:path";
import { installFiles } from "../extension-files.ts";
import { agentDocs, source } from "../source-macro.ts" with { type: "macro" };

/**
 * Put the `webui_docs` extension (`extension.ts`) where omp can read it, beside the other extensions of the server: omp loads
 * an extension from a file, and the compiled server holds its sources — and the documentation it answers from, every file of
 * `docs/agents/` — inside itself. The files are written under `<data dir>/webui-docs/` in the layout they have in the source
 * tree, the docs as a module (`docs-data.ts`) the extension imports, so that it never opens a file. A file is written again
 * only when it differs (an update changes it; a process started before keeps the copy it loaded).
 */
const FILES: Readonly<Record<string, string>> = {
	"server/omp/docs-tool/extension.ts": source("server/omp/docs-tool/extension.ts"),
	"server/omp/docs-tool/lookup.ts": source("server/omp/docs-tool/lookup.ts"),
	"server/omp/docs-tool/docs-data.ts": `// Written by omp-webui from the documentation compiled into it (server/omp/docs-tool/install.ts).\nconst docs: Readonly<Record<string, string>> = ${JSON.stringify(agentDocs())};\n\nexport default docs;\n`,
};

/** The folder the extension lives in, and the file omp is given (`--extension`). */
export function docsToolPaths(dataDir: string): { dir: string; extension: string } {
	const dir = join(dataDir, "webui-docs");
	return { dir, extension: join(dir, "server/omp/docs-tool/extension.ts") };
}

/** Write the extension's files under `dataDir`; the answer is the extension's path. Throws when they cannot be written. */
export function installDocsTool(dataDir: string): string {
	const { dir, extension } = docsToolPaths(dataDir);
	installFiles(dir, FILES);
	return extension;
}

/**
 * What the pool needs of the docs tool: the extension omp is started with, and its files put in place before a process is
 * started with it. `LivePool.docsTool` is null where the app has none (a server that started without a data dir): its
 * conversations then have no `webui_docs`.
 */
export interface DocsToolHooks {
	/** The extension omp is started with (`--extension`). */
	readonly extension: string;
	/** Make sure the extension's files are as the server has them. False when they cannot be. */
	ensure(): boolean;
}

export class DocsToolService implements DocsToolHooks {
	constructor(private readonly dataDir: string) {}

	get extension(): string {
		return docsToolPaths(this.dataDir).extension;
	}

	ensure(): boolean {
		try {
			installDocsTool(this.dataDir);
			return true;
		} catch (e) {
			console.warn(`omp-webui: could not set up the webui_docs tool for a conversation: ${(e as Error).message}`);
			return false;
		}
	}
}
