import type { en } from "../preset-agents.ts";

export const zh: Record<keyof typeof en, string> = {
	rule: "子代理模型：设置了子代理模型的预设，应用时会替换目标（当前对话，或新对话的默认值）原有的子代理模型；没有设置的预设则保持现有子代理模型不变。",
	summary: "子代理：{models}",
	editAria: "预设 {name} 的子代理模型",
	title: "子代理模型 · {name}",
	description:
		"子代理（task 工具所用的代理，例如 reviewer、scout）默认使用其角色对应的模型，除非在这里另行指定。应用此预设时，会用下面列出的子代理模型替换当前对话或默认值中的子代理模型；下面为空时，则保持现有设置不变。",
	none: "未设置子代理模型：应用此预设时保持现有子代理模型不变。",
	modelAria: "子代理 {agent} 的模型",
	thinkingAria: "子代理 {agent} 的思考强度",
	remove: "移除子代理 {agent}",
	addAria: "要添加的子代理名称",
	addName: "子代理，例如 reviewer",
	add: "添加子代理",
	addInvalid: "请以字母开头，其后只能用字母、数字、- 或 _。",
	addExists: "列表中已有该子代理。",
	unsaved: "尚未保存",
	saved: "已保存“{name}”的子代理模型。",
	savedNone: "“{name}”不再设置子代理模型。",
	noteSet: "将一并保存：子代理模型 {models}。应用此预设时，会用这些模型替换子代理模型。",
	noteNone: "当前没有设置子代理模型，因此应用此预设时会保持现有子代理模型不变。",
};
