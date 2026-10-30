import type { en } from "../project-groups.ts";

export const zh: Record<keyof typeof en, string> = {
	// 漏斗按钮与弹出列表
	allProjects: "所有项目",
	title: "项目",
	close: "关闭",
	empty: "还没有项目：项目有第一个对话后就会出现在这里。",
	projectCount: "{n} 个对话",
	projectCountOne: "1 个对话",
	groupAria: "{name}，分组：{n} 个项目",
	groupAriaOne: "{name}，分组：1 个项目",
	groupAriaCollapsed: "{name}，分组：{n} 个项目，已折叠",
	groupEmpty: "这个分组里还没有项目",

	// 菜单
	groupMenu: "分组 {name} 的操作",
	newGroup: "新建分组…",
	renameGroup: "重命名…",
	deleteGroup: "删除分组…",
	moveUp: "上移",
	moveDown: "下移",
	moveToTop: "移出分组",
	moveToGroupAria: "把 {name} 移到分组",
	inThisGroup: "已在这个分组",

	// 给分组命名
	newGroupTitle: "新建分组",
	renameGroupTitle: "重命名分组",
	nameLabel: "分组名称",
	namePlaceholder: "工作",
	create: "新建",
	rename: "重命名",

	// 删除分组
	deleteTitle: "删除“{name}”？",
	deleteDescription: "其中的项目会回到列表的顶层。项目文件夹里的内容不会被删除，对话也不受影响。",
	deleteConfirm: "删除分组",

	// 出错
	problemEmpty: "请为分组输入名称。",
	problemTooLong: "这个名称太长了（最多 {max} 个字符）。",
	problemInvalid: "名称里不能有控制字符或方向标记。",
	problemTaken: "已经有分组叫“{name}”。",
	saveFailed: "无法保存分组：{error}",
	moveFailed: "无法移动 {name}：{error}",
	deleteFailed: "无法删除分组：{error}",
	damaged: "分组文件中有读不出来的条目，所以没有显示。列表的其余部分在这里，下次改动写入文件时会保留原文件。",
};
