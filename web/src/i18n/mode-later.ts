/**
 * Strings for Full / Light mode: the badge of a conversation, and the Settings section.
 *
 * The strings only code outside the first page load asks for, which `later.ts` registers: a module that uses one
 * imports `later.ts` (`tests/unit/i18n-first-load.test.ts`). The ones the first page asks for are in `mode.ts`.
 */
export const en = {
	// The badge of a conversation started in Light
	badge: "Light",
	badgeLocal: "Light · local",
	badgeTitle: "Started in Light mode: only the tools, MCP servers and skills chosen in Settings, on your own models",
	badgeTitleLocal:
		"Started in Light mode on a local server's models: only the tools, MCP servers and skills chosen in Settings",
	switchFailed: "Could not switch mode: {error}",

	// Settings: the choice
	settingsTitle: "Full / Light",
	settingsIntro:
		"Full runs omp as you have set it up. Light loads only the MCP servers, tools and skills you choose, which leaves the context window free for the work; its models are your own, or a local server's (oMLX, Ollama or LM Studio). A mode applies to conversations started from now on; an open one keeps its own until you switch it in its “This session” settings.",
	defaultLegend: "Mode of new conversations",
	fullDesc: "Your models, tools, MCP servers and skills, as omp is configured.",
	lightDesc: "Only the tools, MCP servers and skills chosen below are loaded.",
	modelsLegend: "Light's models",
	modelsYours: "Your models",
	modelsYoursDesc: "The models and roles omp is set up with, as in Full.",
	modelsLocal: "Local server",
	modelsLocalDesc: "Every model role runs on a local server (oMLX, Ollama or LM Studio).",
	omlxMissing:
		"Light on a local server needs a provider named `omlx` in omp's models.yml (an OpenAI-compatible server with a baseUrl and an API key).",

	// Settings: the local server
	localTitle: "Local server",
	backendLabel: "Local model server",
	backendHint:
		"Light conversations on a local server run on this server. Ollama and LM Studio need nothing in models.yml; if it has a provider of that name, its API key and model settings are used.",
	baseUrlLabel: "{backend} address",
	baseUrlDefault: "The default address of {backend}. Type another one to use it for Light.",
	baseUrlModels:
		"From the {backend} provider in your models.yml. An address typed here replaces it for Light on a local server only.",
	baseUrlSettings:
		"Set here, for Light on a local server only. Clear the field to go back to the address in models.yml, or the default one.",
	baseUrlPublic:
		"{host} is not on this computer or your local network. Every prompt and the files it reads will be sent there. An API key from models.yml goes along only if models.yml gives this address too.",
	modelLabel: "{backend} model",
	modelAuto: "Automatic (the first model {backend} serves)",
	modelMissing: "{id} ({backend} does not serve it)",
	modelsLoading: "Asking {backend} which models it serves…",
	modelsServed: "{backend} at {url} serves {n} models.",
	modelsRetry: "Check again",
	thinkingLabel: "Thinking level",

	// Settings: what Light loads
	lightTitle: "What Light loads",
	mcpHint: "From your mcp.json. Light loads only the ones checked; each adds its tools to the context window.",
	mcpNone: "There are no MCP servers in your mcp.json.",
	mcpOff: "switched off in omp",
	mcpOffTip:
		"Switched off in omp (the switch in a conversation’s Loaded dialog, or /mcp disable), so Light does not load it either. Switch it on again to use it.",
	toolsHint: "Built-in tools the model can use. Each adds its description to the context window.",
	skillsHint: "Skill names or patterns such as `git-*`, separated by commas. Leave it empty for no skills.",
	agentsMdLabel: "Also load my AGENTS.md",
	agentsMdHint:
		"Your own instructions file in omp's agent folder. Leave it off to keep the context small; a project's AGENTS.md is always read.",

	// Settings: the saving
	ctxTitle: "Context at the start of a conversation",
	ctxHint: "Measured with omp's /context in a fresh process of each mode, before the first message.",
	ctxMeasuring: "Measuring…",
	ctxMeasureAgain: "Measure again",
	ctxSaving:
		"Light starts a conversation with {light} tokens in the context window instead of {full}: {percent}% less.",
	ctxNoSaving: "Light starts a conversation with {light} tokens in the context window; Full starts with {full}.",
	ctxRowSystemPrompt: "System prompt",
	ctxRowSystemTools: "Tool definitions",
	ctxRowSystemContext: "Context files and MCP notes",
	ctxRowSkills: "Skills",
	ctxRowTotal: "Total",
	ctxIncomplete:
		"An MCP server had not finished starting when this was measured, so its tools may be missing from the number.",
	ctxFailed: "{side}: {error}",
	ctxRowHeader: "What fills the context window",

	// Settings: MCP servers that are gone
	mcpMissing: "Not in mcp.json: {names}",
	mcpMissingForget: "Remove from the list",
};
