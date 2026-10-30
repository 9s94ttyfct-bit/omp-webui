import type { en } from "../mode.ts";
import type { en as later } from "../mode-later.ts";

export const zh: Record<keyof typeof en | keyof typeof later, string> = {
	full: "完整",
	light: "轻量",
	pickerTitle: "新对话使用完整还是轻量模式",
	pickerMenu: "新对话使用的模式",
	chipPrefix: "模式：",
	pickerLabel: "模式：{mode}",
	fullHint: "使用你的模型、工具、MCP 服务器和技能，按 omp 的配置运行。",
	lightHintYours: "只加载在设置里选定的工具、MCP 服务器和技能，使用你自己的模型。",
	lightHintLocal: "只加载在设置里选定的工具、MCP 服务器和技能，使用 {backend} 的模型。",
	lightHintUnknown: "本地服务器",
	liveState: "{state}（轻量模式）",
	switchFailed: "无法切换模式：{error}",
	badge: "轻量",
	badgeLocal: "轻量 · 本地",
	badgeTitle: "以轻量模式启动：只加载在设置里选定的工具、MCP 服务器和技能，使用你自己的模型",
	badgeTitleLocal: "以轻量模式启动，使用本地服务器的模型：只加载在设置里选定的工具、MCP 服务器和技能",

	settingsTitle: "完整 / 轻量",
	settingsIntro:
		"完整模式按你现有的 omp 配置运行。轻量模式只加载你选定的 MCP 服务器、工具和技能，把上下文窗口留给真正的工作；它的模型可以是你自己的模型，也可以是本地服务器（oMLX、Ollama 或 LM Studio）的模型。模式只对之后新开的对话生效；已打开的对话保持原来的模式，直到你在它的“当前对话”设置里切换。",
	defaultLegend: "新对话使用的模式",
	fullDesc: "按 omp 的配置使用你的模型、工具、MCP 服务器和技能。",
	lightDesc: "只加载下面选定的工具、MCP 服务器和技能。",
	modelsLegend: "轻量模式的模型",
	modelsYours: "你的模型",
	modelsYoursDesc: "使用 omp 里配置的模型和角色，与完整模式相同。",
	modelsLocal: "本地服务器",
	modelsLocalDesc: "所有模型角色都运行在本地服务器（oMLX、Ollama 或 LM Studio）上。",
	omlxMissing:
		"轻量模式使用本地服务器时，需要在 omp 的 models.yml 里配置名为 `omlx` 的提供方（带 baseUrl 和 API 密钥的 OpenAI 兼容服务器）。",

	localTitle: "本地服务器",
	backendLabel: "本地模型服务器",
	backendHint:
		"使用本地服务器的轻量对话运行在这个服务器上。Ollama 和 LM Studio 不需要在 models.yml 里配置；如果 models.yml 里有同名的提供方，会使用它的 API 密钥和模型设置。",
	baseUrlLabel: "{backend} 地址",
	baseUrlDefault: "{backend} 的默认地址。输入别的地址即可让轻量模式使用它。",
	baseUrlModels:
		"来自你 models.yml 里的 {backend} 提供方。在这里输入的地址只对使用本地服务器的轻量模式生效，并会替代它。",
	baseUrlSettings: "在这里设置，只对使用本地服务器的轻量模式生效。清空输入框即可回到 models.yml 里的地址或默认地址。",
	baseUrlPublic:
		"{host} 不在本机，也不在你的局域网内。每条提示词和它读取的文件都会发送到那里。只有 models.yml 里也写了这个地址时，其中的 API 密钥才会一并发送。",
	modelLabel: "{backend} 模型",
	modelAuto: "自动（{backend} 提供的第一个模型）",
	modelMissing: "{id}（{backend} 没有提供它）",
	modelsLoading: "正在询问 {backend} 提供哪些模型…",
	modelsServed: "{url} 的 {backend} 提供 {n} 个模型。",
	modelsRetry: "重新检查",
	thinkingLabel: "思考强度",

	lightTitle: "轻量模式加载的内容",
	mcpLabel: "MCP 服务器",
	mcpHint: "来自你的 mcp.json。轻量模式只加载勾选的服务器，每个服务器的工具都会占用上下文窗口。",
	mcpNone: "你的 mcp.json 里没有 MCP 服务器。",
	mcpOff: "已在 omp 中关闭",
	mcpOffTip:
		"已在 omp 中关闭（对话“已加载的内容”里的开关，或 /mcp disable），所以轻量模式也不会加载它。重新打开后才能使用。",
	toolsLabel: "工具",
	toolsHint: "模型可以使用的内置工具。每个工具的说明都会占用上下文窗口。",
	skillsLabel: "技能",
	skillsHint: "技能名称或通配模式（如 `git-*`），用逗号分隔。留空表示不加载任何技能。",
	agentsMdLabel: "同时加载我的 AGENTS.md",
	agentsMdHint: "omp 配置文件夹里你自己的指令文件。关闭可以让上下文更小；项目里的 AGENTS.md 始终会被读取。",

	ctxTitle: "对话开始时的上下文",
	ctxHint: "用 omp 自带的 /context 在两种模式的全新进程里测得，此时还没有任何消息。",
	ctxMeasuring: "正在测量…",
	ctxMeasureAgain: "重新测量",
	ctxSaving: "轻量模式开始对话时上下文窗口里是 {light} 个 token，完整模式是 {full} 个：少了 {percent}%。",
	ctxNoSaving: "轻量模式开始对话时上下文窗口里是 {light} 个 token，完整模式是 {full} 个。",
	ctxRowSystemPrompt: "系统提示词",
	ctxRowSystemTools: "工具定义",
	ctxRowSystemContext: "上下文文件与 MCP 说明",
	ctxRowSkills: "技能",
	ctxRowTotal: "合计",
	ctxIncomplete: "测量时有 MCP 服务器还没有启动完成，这个数字里可能缺少它的工具。",
	ctxFailed: "{side}：{error}",
	ctxRowHeader: "占用上下文窗口的内容",

	mcpMissing: "不在 mcp.json 中：{names}",
	mcpMissingToast:
		"轻量模式将在没有以下已选 MCP 服务器的情况下启动，它们不在你的 mcp.json 里：{names}。请在 mcp.json 中恢复它们，或在“设置 › 完整 / 轻量”中把它们移除。",
	mcpMissingForget: "从列表中移除",
};
