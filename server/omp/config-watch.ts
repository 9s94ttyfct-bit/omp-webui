import { existsSync, type FSWatcher, watch } from "node:fs";

/** What `watchOmpConfig` asks of the file system: the real one by default, a scripted one in a test. */
export interface ConfigWatchFs {
	exists(path: string): boolean;
	watch(dir: string, listener: (event: string, name: string | null) => void): Pick<FSWatcher, "close">;
}

const realFs: ConfigWatchFs = { exists: existsSync, watch: (dir, listener) => watch(dir, listener) };

/** A burst of writes (omp writes a temporary file, then renames it over config.yml) is one change. */
const DEBOUNCE_MS = 150;

/**
 * Call `onChange` whenever omp's global `config.yml` in `agentDir` is written — by a Settings write, "Set as
 * default", the terminal UI, or a `/modelpreset switch` run there (a preset switched to in a conversation of the web
 * UI is that conversation's own and writes nothing: see `Live.setModelPreset`). omp saves a change in the background a
 * moment after making it, so this is when a fresh read sees it. Watches the directory, not the file: a rename replaces
 * the file a file watcher would hold. Until the directory exists (a fresh install) it is polled for.
 * Returns a function that stops watching.
 *
 * The file system tells of a write when it chooses to: macOS drops events while it is busy with other files' (a build,
 * another test run), so a change can go unreported. That is why this is an optimisation and not what views depend on.
 */
export function watchOmpConfig(agentDir: string, onChange: () => void, fs: ConfigWatchFs = realFs): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopWatch: (() => void) | undefined;
	let poll: ReturnType<typeof setInterval> | undefined;
	const changed = () => {
		clearTimeout(timer);
		timer = setTimeout(onChange, DEBOUNCE_MS);
	};
	const attach = () => {
		try {
			const w = fs.watch(agentDir, (_event, name) => {
				if (name === "config.yml") changed();
			});
			stopWatch = () => w.close();
		} catch {
			// Watching is an optimisation: views still refresh on focus and on omp's config_update frames.
		}
	};
	if (fs.exists(agentDir)) attach();
	else {
		poll = setInterval(() => {
			if (!fs.exists(agentDir)) return;
			clearInterval(poll);
			attach();
			changed();
		}, 1000);
		poll.unref?.();
	}
	return () => {
		clearTimeout(timer);
		clearInterval(poll);
		stopWatch?.();
	};
}
