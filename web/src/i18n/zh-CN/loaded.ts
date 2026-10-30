import type { en } from "../loaded.ts";
import type { en as later } from "../loaded-later.ts";

export const zh: Record<keyof typeof en | keyof typeof later, string> = {
	title: "此对话已加载的内容",
	description: "这个对话已加载的内容：它的工具、MCP 服务器、斜杠命令、技能、插件和规则，均来自 omp 的报告。",
	searchPlaceholder: "按名称筛选…",
	searchAria: "筛选已加载的内容",
	refresh: "刷新",
	loadFailed: "无法读取已加载的内容：{error}",
	sectionFailed: "omp 没能给出这部分内容：{error}",
	noMatch: "没有与“{query}”匹配的已加载内容。",
	notRunning: "这个对话没有正在运行的 omp 进程。打开它之后，就能看到它的工具、MCP 服务器、斜杠命令和技能。",
	lightNote: "此对话以轻量模式启动：只加载在“设置”中选定的 MCP 服务器、工具和技能，不加载任何插件。",

	sectionTools: "工具",
	sectionMcp: "MCP 服务器",
	sectionCommands: "斜杠命令",
	sectionSkills: "技能",
	sectionPlugins: "插件",
	sectionRules: "规则",

	toolsNote:
		"模型可以调用的工具。标有 xd:// 的工具挂载为设备，模型向它写入内容来调用；标有“未启用”的工具已注册，但没有启用。",
	toolMounted: "xd://",
	toolMountedTip: "已挂载为 xd:// 设备",
	toolOff: "未启用",
	toolOffTip: "已注册，但没有启用",

	mcpNote:
		"omp 已配置的服务器（/mcp list）。开关会在服务器所在的配置里启用或停用它（这个文件夹的 .omp/mcp.json 或你的 mcp.json）。omp 只在启动时连接服务器，所以改动要等这个对话的 omp 重启后才生效。列表不会告诉你服务器是否已连接：没有工具的服务器可能仍在启动、已经失败，或本来就不提供工具。",
	mcpEnabled: "已启用",
	mcpDisabled: "已停用",
	mcpToolOne: "1 个工具",
	mcpTools: "{n} 个工具",
	mcpNoTools: "未加载任何工具",
	mcpOther: "其他 MCP 工具",
	mcpOtherTip: "不属于上述任何服务器的 MCP 工具",
	mcpExpand: "显示 {name} 的工具",
	mcpCollapse: "隐藏 {name} 的工具",
	mcpOffStillRunning: "已关闭 · 仍在运行",
	mcpSwitch: "使用 MCP 服务器 {name}",
	mcpSwitchLight: "轻量对话加载的是在“设置 › 完整 / 轻量”里选定的 MCP 服务器",
	mcpSwitchName: "omp 的 /mcp enable 和 /mcp disable 只接受一个词：这个名称含有空格或特殊字符，只能在 mcp.json 里切换",
	mcpSwitchBoth: "这个名称同时定义在你的配置和此文件夹的配置里：omp 列出的是一份，切换时改的却是另一份，请在终端里编辑",
	mcpFailed: "无法更改 MCP 服务器 {name}：{error}",
	mcpRestartIdle:
		"已在 omp 的配置中更改：{names}。omp 只在启动时连接 MCP 服务器，所以要等这个对话的 omp 重启后才生效。重启会从已保存的文件恢复同一个对话。",
	mcpRestartLater: "已在 omp 的配置中更改：{names}。这个对话正忙，所以改动会在它的 omp 下次启动时生效，不会提前。",
	mcpRestartNow: "重启 omp 以生效",
	mcpRestarting: "正在重启…",

	srcBuiltin: "内置",
	srcExtension: "扩展",
	srcCustom: "自定义",
	srcFile: "提示词模板",
	aliases: "别名：{names}",
	subcommands: "{n} 个子命令",
	skillsEmpty: "没有列出技能。omp 通过技能的斜杠命令来报告技能，而这些命令由 skills.enableSkillCommands 设置开启。",

	pluginsEmpty: "没有安装插件。",
	pluginDisabled: "已停用",
	pluginShadowed: "已被此文件夹中的同名插件覆盖",
	pluginLight: "轻量模式下不加载",
	rulesNote: "监视模型输出的规则，输出一旦匹配就会介入（omp ttsr list）。",
	rulesEmpty: "没有规则。",

	slashHint:
		"先打开一个对话：它的顶部有“此对话已加载的内容”按钮，列出它的工具、MCP 服务器、斜杠命令、技能、插件和规则。",
	slashDescription: "显示此对话已加载的内容",

	paused: "这个对话已暂停，没法向 omp 询问。恢复它之后，就能看到它的工具、MCP 服务器、斜杠命令和技能。",
	refreshFailed: "刷新失败：{error}",
	retry: "重试",
	srcMcpPrompt: "MCP 提示词",
	descriptionExpand: "显示完整说明",
	descriptionCollapse: "收起说明",

	skillsNote:
		"技能在 omp 的设置（disabledExtensions）里关闭，所以关掉的技能在所有对话里都保持关闭。omp 会立刻不再提供它。",
	skillOff: "已关闭",
	skillOffTip: "已关闭：omp 不再提供这个技能，所以这里没有它的说明。",
	skillSwitch: "使用技能 {name}",
	skillOverridden: "已保存，但这个文件夹自己的{by}设置决定哪些扩展被关闭，所以 {name} 在这里没有变化。",
	skillFailed: "无法更改技能 {name}：{error}",
	pluginsNote: "切换插件后，这个对话的技能和命令会立刻重新加载。其他已打开的对话会在重新加载插件时生效。",
	pluginSwitch: "使用插件 {name}",
	pluginSwitchLight: "轻量模式下 omp 不加载插件",
	pluginNotReloaded: "已切换 {name}，但这个对话的 omp 无法重新加载插件，将在 omp 下次启动时生效。",
	pluginFailed: "无法更改插件 {name}：{error}",
};
