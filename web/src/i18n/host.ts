/**
 * Strings for the host's load (#613): the sidebar's indicator and the pane of graphs behind it (a popover, and the side
 * panel's Host tab). Like `guard`, the namespace is not in `MODULES` of `index.ts`: everything that draws it is a lazy
 * chunk, and its strings travel with the chunk (`lib/host-strings.ts`, `addStrings`). The zh-CN ones are a chunk of
 * their own, fetched only by a person who reads the page in Chinese. The panel's tab label is `panel.tabHost`.
 */
export const en = {
	title: "Host load",
	// The indicator: `{v}` is a figure with its unit (`12%`), or a dash.
	chipTitle: "The load of the Mac that runs omp-webui",
	chipCpu: "CPU {v}",
	chipGpu: "GPU {v}",
	chipMem: "MEM {v}",
	chipAria: "Host load: {figures}. Memory pressure: {pressure}.",
	chipAriaNoPressure: "Host load: {figures}.",
	chipOffline: "Not connected: these are the last figures received.",
	// Memory pressure, as the system says it.
	pressureName: "Memory pressure",
	pressureNormal: "Normal",
	pressureWarning: "Warning",
	pressureCritical: "Critical",
	// The tiles
	tileCpu: "CPU",
	tileGpu: "GPU",
	tileMemory: "Memory",
	cpuSub: "{n} cores",
	gpuSub: "{name}",
	gpuSubCores: "{name} · {n} cores",
	memSub: "{used} of {total}",
	// The graphs
	rangeLabel: "History",
	range1h: "1 h",
	range24h: "24 h",
	chartAria: "{name}, last {range}: now {now}, highest {peak}",
	chartNoData: "no figures yet",
	peak: "peak {v}",
	bandNote: "Shaded where memory pressure was above normal: amber is a warning, red is critical.",
	emptyTitle: "Collecting the first figures",
	emptyHint: "A graph needs two looks, a few seconds apart.",
	emptyHintDay: "The 24 h graph has a point a minute: it needs two minutes of history.",
	loadFailed: "The history could not be read from the server. New figures are still added as they arrive.",
	// The processes
	procTitle: "Processes",
	/** The table's first column, under the "Processes" heading: a name, not "Process" a second time. */
	procName: "Name",
	procCpu: "CPU",
	procMem: "Memory",
	procServer: "omp-webui server",
	procOmp: "omp",
	procRelay: "Relays",
	procCountN: "{n} conversations",
	procCountOne: "1 conversation",
	procNote: "CPU is a share of one core: 100% is one core fully busy.",
	procWaiting: "Looking at the processes…",
	// What the pane says of how it works
	footer:
		"The server looks every {live} s while a page shows these graphs, and every {background} s while only the sidebar's line does (or nothing at all). The history is kept in the server's memory only and starts over when it restarts.",
};
