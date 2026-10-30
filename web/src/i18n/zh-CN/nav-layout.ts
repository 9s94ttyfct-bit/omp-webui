import type { en } from "../nav-layout.ts";

export const zh: Record<keyof typeof en, string> = {
	title: "侧边栏与快捷栏",
	hint: "选择侧边栏和快捷栏提供哪些页面，以及放在哪里。也可以直接在任一栏里拖动：拖到同一组的其他位置、拖到另一组，或拖到拖动时出现的“隐藏”区域。这个排列只保存在本设备上。",
	sidebar: "侧边栏",
	rail: "快捷栏（隐藏侧边栏后留下的窄条）",
	groupTop: "顶部",
	groupBottom: "底部",
	groupHidden: "已隐藏",
	groupEmpty: "这里还没有内容",
	groupLabel: "{item}在{surface}中的分组",
	moveUp: "在{surface}中上移{item}",
	moveDown: "在{surface}中下移{item}",
	reset: "恢复默认",
	resetHint: "两个栏的所有页面都放在底部，顺序与原来一致。",
	guardNote: "不在本机上的页面不会提供“防护”页面入口。",
};
