import { fuzzyMatch } from "@shared/fuzzy.ts";
import "../i18n/later.ts";
import type { MessageKey } from "../i18n/index.ts";

/**
 * Every setting the Settings page has, as the search at its top finds them: the card it is on (the page's grouping), the
 * label a person reads, the sentence under it, a few names people use for it, and where on the page it is.
 *
 * The catalogue is written by hand because a setting's words are its label and its description, and a control's place in
 * the page is a selector: nothing in the DOM says which of the many paragraphs of a card is the one that describes the
 * switch beside it. A setting that is added to a card and not here is still reachable from the card's own entry.
 */
export interface SettingEntry {
	/** A stable name, for tests and for the highlight key. */
	id: string;
	/** The card it is on: its title, which is also the page's grouping of the result. */
	group: MessageKey;
	/** The name a person reads. */
	label: MessageKey;
	/** The sentence under the name (not every control has one). */
	hint?: MessageKey;
	/** Other names for it, in English and in Chinese (`dark mode`, `深色模式`): searched, never shown. */
	aliases?: readonly string[];
	/** Where it is in the page: the element the result scrolls to and marks. */
	target: string;
}

/** The catalogue, in page order. `target` is a selector inside the Settings page (`:scope` is not assumed). */
export const SETTINGS: readonly SettingEntry[] = [
	{
		id: "theme",
		group: "pages.settingsAppearance",
		label: "pages.settingsTheme",
		aliases: [
			"theme",
			"light",
			"dark",
			"system",
			"light mode",
			"dark mode",
			"主题",
			"浅色",
			"深色",
			"跟随系统",
			"外观",
			"颜色",
		],
		target: 'fieldset:has(input[name="theme"])',
	},
	{
		id: "palette",
		group: "pages.settingsAppearance",
		label: "pages.settingsPalette",
		hint: "pages.settingsPaletteHint",
		aliases: ["color", "colour", "theme", "配色", "颜色", "外观", "主题", "调色板", "配色方案"],
		target: '[data-testid="palette-picker"]',
	},
	{
		id: "reset-layout",
		group: "pages.settingsAppearance",
		label: "pages.settingsResetLayout",
		hint: "pages.settingsResetLayoutHint",
		aliases: ["sidebar width", "panel width", "resize", "布局", "宽度", "重置"],
		target: '[data-testid="reset-layout"]',
	},
	{
		id: "nav-layout",
		group: "navLayout.title",
		label: "navLayout.title",
		hint: "navLayout.hint",
		aliases: [
			"sidebar",
			"rail",
			"reorder",
			"drag",
			"hide",
			"guard",
			"pages",
			"侧边栏",
			"快捷栏",
			"排序",
			"拖动",
			"隐藏",
			"防护",
		],
		target: '[data-testid="nav-layout-settings"]',
	},
	{
		id: "quick-prompts",
		group: "quickPrompts.cardTitle",
		label: "quickPrompts.cardTitle",
		hint: "quickPrompts.cardIntro",
		aliases: ["quick prompt", "snippet", "soft stop", "handoff", "快速指令", "软结束", "交接"],
		target: '[data-testid="quick-prompts-settings"]',
	},
	{
		id: "language",
		group: "common.language",
		label: "common.language",
		aliases: ["english", "chinese", "zh", "locale", "语言", "中文", "英文"],
		target: '[data-testid="language"]',
	},
	{
		id: "shortcuts",
		group: "shell.shortcutsTitle",
		label: "shell.shortcutsTitle",
		hint: "pages.settingsShortcutsHint",
		aliases: ["keyboard", "hotkeys", "keys", "bindings", "快捷键", "键盘", "按键"],
		target: '[data-testid="shortcuts-settings"]',
	},
	{
		id: "auto-title",
		group: "pages.settingsConversations",
		label: "pages.settingsAutoTitle",
		hint: "pages.settingsAutoTitleHint",
		aliases: ["title", "rename", "name", "标题", "命名", "重命名"],
		target: '[data-testid="auto-title"]',
	},
	{
		id: "keep-thinking",
		group: "pages.settingsConversations",
		label: "pages.settingsKeepThinking",
		hint: "pages.settingsKeepThinkingHint",
		aliases: ["thinking", "reasoning", "collapsed", "思考", "推理", "展开"],
		target: '[data-testid="keep-thinking"]',
	},
	{
		id: "tool-timer",
		group: "pages.settingsConversations",
		label: "pages.settingsToolTimer",
		hint: "pages.settingsToolTimerHint",
		aliases: [
			"timer",
			"elapsed",
			"duration",
			"how long",
			"stopwatch",
			"clock",
			"计时",
			"耗时",
			"时间",
			"运行时间",
			"秒表",
		],
		target: '[data-testid="tool-timer-mode"]',
	},
	{
		id: "notifications",
		group: "pages.settingsConversations",
		label: "pages.settingsNotify",
		aliases: ["notification", "desktop", "alert", "提醒", "通知", "提示"],
		target: '[data-testid="notifications"]',
	},
	{
		id: "usage-wait",
		group: "pages.settingsConversations",
		label: "pages.settingsUsageWait",
		hint: "pages.settingsUsageWaitHint",
		aliases: ["quota", "rate limit", "retry", "wait", "额度", "限流", "重试", "等待"],
		target: '[data-testid="usage-wait-default"]',
	},
	{
		id: "quota-floor",
		group: "pages.settingsQuotaFloor",
		label: "pages.settingsQuotaFloorLabel",
		hint: "pages.settingsQuotaFloorIntro",
		aliases: [
			"quota floor",
			"quota",
			"usage limit",
			"hold",
			"floor",
			"reset",
			"window",
			"额度下限",
			"额度",
			"用量上限",
			"暂缓",
			"下限",
			"重置",
		],
		target: '[data-testid="quota-floor-settings"]',
	},
	{
		id: "compact-at",
		group: "pages.settingsCompactAt",
		label: "pages.settingsCompactAt",
		hint: "pages.settingsCompactAtHint",
		aliases: ["compact", "context", "auto compact", "threshold", "压缩", "上下文", "自动压缩"],
		target: '[data-testid="compact-at-settings"]',
	},
	{
		id: "compact-where",
		group: "pages.settingsCompactWhere",
		label: "pages.settingsCompactWhere",
		hint: "pages.settingsCompactWhereHint",
		aliases: [
			"compact",
			"compaction",
			"queue",
			"between steps",
			"turn end",
			"summary",
			"压缩",
			"排队",
			"步骤之间",
			"本轮结束",
			"摘要",
		],
		target: '[data-testid="compact-where-settings"]',
	},
	{
		id: "push",
		group: "push.title",
		label: "push.title",
		hint: "push.hint",
		aliases: ["push", "phone", "closed", "device", "推送", "手机", "设备"],
		target: '[data-testid="push-settings"]',
	},
	{
		id: "projects-folder",
		group: "projects.title",
		label: "projects.title",
		hint: "projects.hint",
		aliases: ["folder", "new project", "workspace", "文件夹", "项目", "工作区"],
		target: '[data-testid="projects-settings"]',
	},
	{
		id: "mode",
		group: "mode.settingsTitle",
		label: "mode.settingsTitle",
		hint: "mode.settingsIntro",
		aliases: [
			"full",
			"light",
			"local",
			"backend",
			"ollama",
			"omlx",
			"lm studio",
			"mlx",
			"完整",
			"轻量",
			"本地",
			"在线",
			"离线",
		],
		target: '[data-testid="mode-settings"]',
	},
	{
		id: "approval",
		group: "pages.settingsApproval",
		label: "pages.settingsApprovalDefault",
		hint: "pages.settingsApprovalHint",
		aliases: ["permission", "approve", "ask", "yolo", "权限", "批准", "许可", "自动"],
		target: '[data-testid="approval-settings"]',
	},
	{
		id: "guard",
		group: "guard.title",
		label: "guard.guardTitle",
		hint: "guard.guardIntro",
		aliases: ["safety", "risky", "reviewer", "dangerous", "安全", "危险", "审核"],
		target: '[data-testid="guard-settings"]',
	},
	{
		id: "unattended",
		group: "questions.settingsTitle",
		label: "questions.settingsTitle",
		hint: "questions.settingsIntro",
		aliases: ["away", "unattended", "questions", "file question", "无人值守", "离开", "提问"],
		target: '[data-testid="unattended-settings"]',
	},
	{
		id: "accounts",
		group: "pages.accTitle",
		label: "pages.accTitle",
		hint: "pages.accIntro",
		aliases: ["login", "log in", "api key", "provider", "凭据", "登录", "账号", "密钥"],
		target: '[data-testid="accounts"]',
	},
	{
		id: "model-roles",
		group: "presets.rolesTitle",
		label: "presets.rolesTitle",
		hint: "presets.rolesHint",
		aliases: ["model", "role", "default model", "thinking level", "模型", "角色", "思考强度"],
		target: '[data-testid="model-roles"]',
	},
	{
		id: "model-presets",
		group: "presets.listTitle",
		label: "presets.listTitle",
		hint: "presets.listHint",
		aliases: ["preset", "models", "presets", "预设", "模型组"],
		target: '[data-testid="model-presets"]',
	},
	{
		id: "guidance",
		group: "guidance.title",
		label: "guidance.title",
		hint: "guidance.settingsIntro",
		aliases: ["subagent", "template", "model guidance", "conflict", "AGENTS.md", "指导", "子代理", "模板", "冲突"],
		target: '[data-testid="guidance-settings"]',
	},
	{
		id: "omp",
		group: "omp.settingsTitle",
		label: "omp.settingsTitle",
		aliases: ["version", "up to date", "install method", "更新", "版本", "安装"],
		target: '[data-testid="omp-settings"]',
	},
	{
		id: "quit",
		group: "pages.settingsQuit",
		label: "pages.settingsQuit",
		hint: "pages.settingsQuitNote",
		aliases: ["close window", "background", "cmd q", "退出", "后台", "关闭窗口"],
		target: '[data-testid="quit-settings"]',
	},
	{
		id: "sleep",
		group: "pages.settingsSleep",
		label: "pages.settingsKeepAwake",
		hint: "pages.settingsKeepAwakeHint",
		aliases: ["sleep", "awake", "caffeinate", "idle", "lid", "wake", "休眠", "睡眠", "唤醒", "合盖", "保持唤醒"],
		target: '[data-testid="sleep-settings"]',
	},
	{
		id: "drop",
		group: "drop.settingsTitle",
		label: "drop.settingsTitle",
		hint: "drop.settingsIntro",
		aliases: ["drag", "drop", "paste", "attach", "file", "拖入", "拖放", "粘贴", "附件", "文件"],
		target: '[data-testid="drop-settings"]',
	},
	{
		id: "update",
		group: "update.title",
		label: "update.title",
		hint: "update.hint",
		aliases: ["upgrade", "release", "auto update", "升级", "更新", "版本"],
		target: '[data-testid="update-settings"]',
	},
	{
		id: "remote",
		group: "remote.settingsTitle",
		label: "remote.settingsTitle",
		hint: "remote.settingsIntro",
		aliases: ["tunnel", "cloudflare", "access", "hostname", "远程", "隧道", "公网", "访问"],
		target: '[data-testid="remote-settings"]',
	},
	{
		id: "remote-shell",
		group: "remote.settingsTitle",
		label: "remote.shell",
		hint: "remote.shellHint",
		aliases: ["terminal", "shell", "remote terminal", "终端", "命令行"],
		target: '[data-testid="remote-shell"]',
	},
	{
		id: "migrate",
		group: "migrate.title",
		label: "migrate.title",
		hint: "migrate.intro",
		aliases: ["move", "backup", "export", "import", "another computer", "迁移", "备份", "导出", "导入"],
		target: '[data-testid="migrate-settings"]',
	},
	{
		id: "send-feedback",
		group: "feedback.settingsTitle",
		label: "feedback.navFeedback",
		hint: "feedback.settingsSendHint",
		aliases: ["bug", "feature", "report", "issue", "github", "问题", "建议", "反馈", "报告"],
		target: '[data-testid="settings-feedback"]',
	},
	{
		id: "feedback",
		group: "feedback.settingsTitle",
		label: "feedback.settingsStar",
		hint: "feedback.settingsStarHint",
		aliases: ["star", "github", "rating", "星标", "反馈", "评分"],
		target: '[data-testid="star-prompt-setting"]',
	},
	{
		id: "config",
		group: "pages.settingsConfig",
		label: "pages.settingsConfig",
		hint: "pages.settingsConfigHint",
		aliases: ["cli", "terminal", "command", "命令", "终端", "配置"],
		target: '[data-setting="config"]',
	},
	{
		id: "running",
		group: "pages.settingsRunning",
		label: "pages.settingsRunning",
		aliases: ["process", "close", "pid", "进程", "运行", "关闭"],
		target: '[data-setting="running"]',
	},
];

/** One setting the query matched. */
export interface SettingHit {
	entry: SettingEntry;
	/** How well it matched; only the order matters. */
	score: number;
	/** The text that matched (a label, a hint or an alias), for the tooltip of a result the label alone does not explain. */
	matched: string;
}

/** A card's worth of results, in page order. */
export interface SettingGroup {
	group: MessageKey;
	title: string;
	hits: SettingHit[];
}

/** What a field of a setting is, which is how much a match in it is worth: a name beats a nickname beats prose. */
type Kind = "label" | "alias" | "hint";

/** Added to a match's score for the kind of field it is in: a label always outranks an alias, an alias a hint. */
const KIND_RANK: Record<Kind, number> = { label: 2000, alias: 1000, hint: 0 };

/**
 * Most characters a fuzzy match of a label or an alias may skip between two letters of a word: `ntfctns` finds
 * *Notifications* (2 at most), `theme` does not find *Keep the Mac awake while a conversation works* (the *the* of
 * *the Mac*, an *m* and an *e* seven letters on).
 */
const MAX_SKIP = 2;

/**
 * The words a setting is found by, each with what it is. A hint is a paragraph: matched letter by letter it holds
 * almost any short word's letters in order, so it only counts when it contains each word of the query as written
 * (`containsWords`).
 */
function fields(entry: SettingEntry, text: (key: MessageKey) => string): { text: string; kind: Kind }[] {
	const out: { text: string; kind: Kind }[] = [{ text: text(entry.label), kind: "label" }];
	if (entry.hint) out.push({ text: text(entry.hint), kind: "hint" });
	for (const alias of entry.aliases ?? []) out.push({ text: alias, kind: "alias" });
	return out.filter((field) => field.text !== "");
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** A word with a Chinese, Japanese or Korean character in it: those scripts have no spaces, so the term is its text. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `text` has every word of `query` as written (case and diacritics aside): a word of English as a whole word
 * (`theme` is in *the theme* and not in *themes* or *schemes*), a term of Chinese as the whole term.
 */
function containsWords(query: string, text: string): boolean {
	const folded = fold(text);
	return fold(query)
		.split(/\s+/)
		.filter(Boolean)
		.every((word) =>
			UNSPACED.test(word)
				? folded.includes(word)
				: new RegExp(`(?<![\\p{Script=Latin}\\p{N}])${escapeRegExp(word)}(?![\\p{Script=Latin}\\p{N}])`, "u").test(
						folded,
					),
		);
}

/**
 * The settings `query` finds, grouped by the card they are on and ordered by how well they matched (the best card
 * first; within a card, the best setting first). An empty query finds nothing: the box is a search, not a list of
 * every setting. `text` is the label of a key in the language being searched, and `title` names a card.
 *
 * `available` keeps only the settings whose element is on the page (a card the page does not show — the guard on a page
 * through the tunnel, quitting in a browser — is not a place a result could go).
 */
export function searchSettings(
	query: string,
	text: (key: MessageKey) => string,
	o: { catalogue?: readonly SettingEntry[]; available?: (entry: SettingEntry) => boolean } = {},
): SettingGroup[] {
	const typed = query.trim();
	if (typed === "") return [];
	const groups = new Map<MessageKey, SettingGroup>();
	for (const entry of o.catalogue ?? SETTINGS) {
		if (o.available && !o.available(entry)) continue;
		let best: SettingHit | null = null;
		for (const field of fields(entry, text)) {
			if (field.kind === "hint" && !containsWords(typed, field.text)) continue;
			const match = fuzzyMatch(typed, field.text, field.kind === "hint" ? {} : { maxSkip: MAX_SKIP });
			if (!match) continue;
			const score = match.score + KIND_RANK[field.kind];
			if (!best || score > best.score) best = { entry, score, matched: field.text };
		}
		if (!best) continue;
		let group = groups.get(entry.group);
		if (!group) {
			group = { group: entry.group, title: text(entry.group), hits: [] };
			groups.set(entry.group, group);
		}
		group.hits.push(best);
	}
	const out = [...groups.values()].map((g) => ({
		...g,
		hits: g.hits.sort((a, b) => b.score - a.score),
	}));
	// The cards keep the page's order for equal answers, and the best answer leads.
	return out.sort(
		(a, b) =>
			(b.hits[0]?.score ?? 0) - (a.hits[0]?.score ?? 0) ||
			SETTINGS.findIndex((e) => e.group === a.group) - SETTINGS.findIndex((e) => e.group === b.group),
	);
}

/** The results as one list, in the order they are shown: what the keyboard moves through. */
export function flattenSettings(groups: readonly SettingGroup[]): SettingHit[] {
	return groups.flatMap((g) => g.hits);
}
