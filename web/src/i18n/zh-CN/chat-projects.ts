import type { en } from "../chat-projects.ts";

export const zh: Record<keyof typeof en, string> = {
	// 项目的菜单
	newChat: "在这个项目里开始新对话",
	rename: "重命名…",
	setFolder: "设置文件夹…",
	changeFolder: "更换文件夹…",
	removeFolder: "移除文件夹",
	moveUp: "上移",
	moveDown: "下移",
	deleteProject: "删除项目…",

	// 对话菜单里的“移到项目”
	removeFromProject: "从项目中移出",
	inThisProject: "已在这个项目里",
	noProjects: "还没有项目",

	// 给项目命名
	newTitle: "新建项目",
	renameTitle: "重命名项目",
	nameLabel: "项目名称",
	namePlaceholder: "研究",
	create: "创建",
	save: "重命名",
	newHint: "项目把对话归在一起，不论每个对话在哪个文件夹里工作。项目的文件夹是可选的。",

	// 项目的文件夹
	folderTitle: "选择项目的文件夹",
	folderDescription: "项目的文件夹按钮会在“文件”面板里显示这个文件夹，项目里的新对话也从这里开始。",

	// 删除项目
	deleteTitle: "删除“{name}”？",
	deleteDescription: "它的对话会回到按日期排列的列表里。不会删除任何对话，也不会动它文件夹里的任何东西。",
	deleteConfirm: "删除项目",

	// 出了什么问题
	problemEmpty: "请输入项目名称。",
	problemTooLong: "名称太长了（最多 {max} 个字符）。",
	problemInvalid: "名称里不能有控制字符或方向标记。",
	problemTaken: "已经有一个项目叫“{name}”了。",
	saveFailed: "无法保存项目：{error}",
	deleteFailed: "无法删除项目：{error}",

	// 项目页面（`#/project/<id>`）
	pageConversations: "对话",
	pageEmpty: "这个项目里还没有对话。用“新对话”开始一个，或者从侧边栏把对话移到这里。",
	pageNewChat: "新对话",
	pageFiles: "文件",
	pageNoFolder: "这个项目没有文件夹。设置一个就能在这里看到它的文件。",
	pageGone: "这个项目已经不存在了。",
};
