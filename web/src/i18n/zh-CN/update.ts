import type { en } from "../update.ts";

export const zh: Record<keyof typeof en, string> = {
	// The card
	title: "更新",
	hint: "omp-webui 会从 GitHub 上的公开发布版本更新自己。",
	remoteRefused: "远程页面不能更新：只能在运行它的那台 Mac 上更新应用。",
	loadFailed: "读不到应用的更新状态。",
	versionInstalled: "当前版本：v{version}",
	versionLatest: "最新版本：v{version}",
	versionLatestUnknown: "最新版本：暂时不知道",
	upToDate: "已是最新版本。",
	available: "有新版本 v{version}",
	checkedAt: "上次检查：{when}",
	neverChecked: "还没有检查过",
	check: "立即检查",
	checking: "正在检查…",

	// A look at GitHub that gave no answer
	noRelease: "现在找不到可用的发布版本。",
	offline: "连不上 GitHub。请检查网络，然后再检查一次。",
	rateLimitedAt: "GitHub 的请求次数用完了，应用会在 {when} 再去看。",
	rateLimited: "GitHub 的请求次数用完了，过一会儿再试。",
	http: "GitHub 返回了状态 {status}，不是发布版本。过一会儿再试。",
	badAnswer: "GitHub 的回答不是本应用能识别的发布版本。过一会儿再试。",

	// The newer release
	notesLabel: "v{version} 的更新内容",
	releasePage: "发布页面",
	install: "下载并安装",
	noAsset: "v{version} 已发布，但安装包还没有上传。几分钟后再检查一次。",

	// Why this copy cannot install
	blockedNotApp: "只有 macOS 应用才能在这里安装更新。请到发布页面下载 v{version}，或者按这份副本原来的安装方式更新。",
	blockedTranslocated:
		"macOS 正在从一份临时副本运行 omp-webui。请把它移到“应用程序”文件夹，再从那里打开，它才能更新自己。",
	blockedNotWritable: "当前用户没有 omp-webui 所在文件夹的写入权限，没法替换自己。请到发布页面下载新版本，手动安装。",
	blockedAdHoc:
		"这份 omp-webui 使用的是临时（ad hoc）签名，没有可用来核对下载内容的签名。请到发布页面下载新版本，手动安装。",

	// An install under way
	phaseDownloading: "正在下载 v{version}…",
	phaseVerifying: "正在检查下载的文件…",
	phaseStaging: "正在准备新版本…",
	phaseHandover: "正在重启以完成更新…",
	progressLabel: "下载进度",
	cancel: "取消",

	// An install that was refused
	refusedBusy: "已经有一个更新在进行了。",
	refusedNothing: "没有可安装的内容：那个版本已经不是最新的了。请再检查一次。",
	refusedBlocked: "这份 omp-webui 不能自己更新。",
	requestFailed: "没能开始更新：{error}",

	// Conversations are replying
	confirmTitle: "有对话正在回复，仍要更新吗？",
	confirmBodyOne: "有 1 个对话正在回复，更新会让它停下。仍要更新吗？",
	confirmBodyMany: "有 {n} 个对话正在回复，更新会让它们停下。仍要更新吗？",
	confirmStayingOne: "另有 1 个已暂停或在等待的对话，会留在后台。",
	confirmStayingMany: "另有 {n} 个已暂停或在等待的对话，会留在后台。",
	confirmAnyway: "仍然更新",

	// An install that did not go on
	failedTitle: "更新没有安装",
	failedDownload: "安装包下载失败（{detail}），没有改动任何东西。",
	failedDownloadPlain: "安装包下载失败，没有改动任何东西。",
	failedSize:
		"下载下来的文件是 {actual} 字节，而发布页列出的是 {expected} 字节，说明文件不完整，或不是发布的那个文件。没有安装。",
	failedDigest: "下载文件的校验值（SHA-256 {actual}）和 GitHub 列出的安装包校验值（{expected}）不一致，所以没有安装。",
	failedMount: "安装包打不开：{detail}",
	failedNoApp: "安装包里没有 omp-webui.app，所以没有安装。",
	failedSignature: "macOS 不认可新应用的签名，所以没有安装：{detail}",
	failedBundleId: "安装包里的应用是 `{found}`，不是 `{expected}`，所以没有安装。",
	failedVersion: "安装包里的应用是 v{found}，而发布的版本是 {tag}，所以没有安装。",
	failedNotNewer: "安装包里的应用是 v{found}，并不比已安装的 v{installed} 新。应用不会退回到旧版本。",
	failedRequirement: "新应用的签名证书（{found}）和正在运行的这份（{expected}）不是同一个，所以没有安装。",
	failedAdHoc: "这份 omp-webui 使用的是临时（ad hoc）签名，没法拿新应用来比对。请到发布页面下载新版本，手动安装。",
	failedSpace: "可用空间不够，无法更新：需要 {needed}，现在只剩 {free}。腾出一些空间后再试。",
	failedNotWritable: "当前用户不能写入文件夹 `{dir}`，应用没法在那里替换自己。",
	failedStage: "新应用没能复制到旧应用旁边：{detail}",
	failedUnknown: "更新没能安装（原因：{code}），没有改动任何东西。",
	retry: "重试",
	dismiss: "关闭",

	// How the last update ended
	outcomeOk: "已更新到 v{to}。",
	outcomeFailed: "更新到 v{to} 没有成功，已恢复为 v{from}。",
	outcomeQuitTimeout: "更新到 v{to} 没有成功：应用没有及时退出。已恢复为 v{from}。",
	outcomeVerify: "更新到 v{to} 没有成功：最后一次检查时，新应用与预期不符。已恢复为 v{from}。",
	outcomeSwap: "更新到 v{to} 没有成功：没能换上新应用。已恢复为 v{from}。",
	outcomeDidNotStart: "更新到 v{to} 没有成功：新应用没能启动。已换回 v{from}。",
	outcomeRollbackFailed: "更新到 v{to} 没有成功，而且没能换回 v{from}。请到发布页面重新安装 omp-webui。",

	// The setting
	auto: "自动检查更新",
	autoHint: "启动时检查一次，之后每 6 小时检查一次。无论是否开启，“立即检查”都可以用。",
};
