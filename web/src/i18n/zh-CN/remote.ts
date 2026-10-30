import type { en } from "../remote.ts";
import type { en as later } from "../remote-later.ts";

export const zh: Record<keyof typeof en | keyof typeof later, string> = {
	// Settings › Remote access
	settingsTitle: "远程访问",
	settingsIntro:
		"从任何地方打开这个应用：Cloudflare 隧道把 https://{hostname} 连到这台 Mac，Cloudflare Access 在放你进来之前先问你是谁。",
	settingsRemoteRefused: "这个页面不在运行服务器的这台 Mac 上，所以这里不能改动隧道。",

	// The state of the tunnel
	stateOff: "已关闭",
	stateStarting: "启动中…",
	stateConnected: "已连接",
	stateError: "未运行",
	stateLabel: "隧道：{state}",
	urlLabel: "公网地址",
	urlEmpty: "还没有主机名",
	copyUrl: "复制地址",
	urlCopied: "已复制",

	// The steps
	stepInstall: "安装 cloudflared",
	stepInstallDone: "cloudflared 已安装",
	stepLogin: "登录 Cloudflare",
	stepLoginDone: "已登录 Cloudflare",
	stepLoginWaiting: "等待登录完成…",
	loginLink: "打开登录页面",
	stepSetup: "设置隧道",
	stepStart: "启动隧道",
	stepStop: "停止隧道",

	// The settings
	hostname: "主机名",
	hostnameHint: "这个应用的公网名字，例如 omp.example.com",
	team: "Cloudflare 团队",
	teamHint: "你的 Access 地址的第一段（<团队名>.cloudflareaccess.com）",
	aud: "应用 AUD（AUD 标签）",
	audHint: "Access 应用的 AUD，从控制台复制",
	emails: "允许的邮箱地址",
	emailsHint: "一行一个。只有这些地址能进来。",
	emailsEmpty: "还没有地址",
	autostart: "随应用启动隧道",

	confirmRisky: "远程页面的高风险命令先确认",
	confirmRiskyHint:
		"默认关闭。当不在这台电脑上的页面（经隧道进来的，或经网络地址进来的）发送或引导一轮对话时，看起来高风险的工具调用（sudo、在项目文件夹之外删除或覆盖、git push --force 或 reset --hard、把下载内容直接交给 shell 执行、大范围更改权限、~/.ssh、~/.omp 或本应用的数据、launchctl、osascript、隧道、远程访问工具）会先等你在该页面点“允许”或“拒绝”才运行。其余调用照对话的权限模式运行；权限模式本身不会改变，这台电脑上的页面也永远不会被询问。这是尽力而为的检查，不是沙箱：它只读取调用携带的命令或路径（技术文档 docs/TECHNICAL.zh-CN.md 列出了它检查的内容）。",

	// 远程页面的文件传输（#614）
	fileTransfer: "文件传输",
	fileTransferOff: "关闭",
	fileTransferDownload: "仅下载",
	fileTransferFull: "下载和上传",
	fileTransferHint:
		"不在这台电脑上的页面（经隧道进来的，或经网络地址进来的）可以对对话所在文件夹里的文件做什么：下载文件、把文件夹下载为 ZIP，以及向其中上传文件和文件夹。默认允许上传。机密文件（.env、密钥、凭据）、指向文件夹之外的链接，以及 ~/.ssh 这样的位置永远不会被传输，每一次传输都会记录在本应用的数据文件夹里。这台电脑上的页面不受影响。",
	shell: "允许远程页面打开终端",
	shellHint:
		"面板的“终端”标签是这台电脑上的登录 shell，位于对话所在的文件夹。打开此项后，不在这台电脑上的页面（经隧道或经网络地址进来的）也能打开它：任何能进来的人都能在这里使用 shell，而且防护看不到其中输入的内容。关闭后，这些页面不能再打开新的 shell，已打开的也会被结束。这台电脑上的页面不受影响。",

	// Let the AI help
	aiSwitch: "让 AI 协助设置远程访问",
	aiHint:
		"默认关闭。在你用“用 AI 设置”开始的对话里，代理可以读取这些设置，并在你逐步批准后保存设置、安装 cloudflared、发起 Cloudflare 登录、设置/启动/停止隧道、检查公网地址。它看不到任何令牌或隧道凭据，不能自己打开这个开关；不在这台电脑上的页面（经隧道或经网络地址进来的）打开该对话时，它的请求会被拒绝。",
	aiButton: "用 AI 设置",
	aiActiveOne: "AI 在 1 个打开的对话里拥有这些工具。",
	aiActiveMany: "AI 在 {n} 个打开的对话里拥有这些工具。",

	// Check the address
	checkButton: "检查公网地址",
	setupNeeds: "设置隧道之前，需要先安装 cloudflared、完成 Cloudflare 登录，并保存主机名。",

	// The Cloudflare sign-in link, when the AI started the login (it is shown here and never to the AI)
	loginReady: "Cloudflare 正在等你登录。",
	loginOpen: "打开登录页面",

	// What the AI is told at the start of the conversation
	aiPrompt:
		"请帮我给这个应用（omp-webui）设置远程访问：用 Cloudflare 隧道加 Cloudflare Access，一步一步来，直到能从我的其他设备打开为止。\n\n你有 remote_access_* 这组工具可以管理这个应用的远程访问：先读 remote_access_guide，再读 remote_access_status。能用工具做的步骤你来做；Cloudflare 控制台里你做不了的步骤，请准确告诉我点哪里，需要主机名、团队名、AUD 和允许的邮箱地址时请让我粘贴给你。不要向我要 Cloudflare 密码或 API 令牌。\n\n目前的情况：\n{state}",
	aiStateTools: "- cloudflared 已安装：{installed}；Cloudflare 已登录：{login}",
	aiStateSettings: "- 主机名：{hostname}；团队名：{team}；AUD：{aud}；允许的邮箱地址：{emails}",
	aiStateTunnel: "- 隧道：{state}",
	aiYes: "是",
	aiNo: "否",
	aiUnset: "未设置",
	aiSet: "已设置",

	// The dashboard guide
	guideTitle: "创建 Access 应用",
	guideIntro: "在 Cloudflare 控制台里按这个顺序：",
	guideApp: "Zero Trust › Access › Applications › Add an application › Self-hosted",
	guideHostname:
		"主机名填上面同一个，或者填一个能覆盖它的通配域名（*.example.com）：一个应用就能管下面所有 Mac，共用一个 AUD 标签",
	guidePolicy: "添加一条策略：Allow，并填上面的邮箱地址",
	guideAud: "从应用里复制 AUD 标签，粘贴到上面",
	guideSession:
		"可选，大约每月登录一次：把应用的 Session Duration 设为 1 个月，再把 Access settings 里的全局登录时长（global session duration）也设为 1 个月（两者默认都是 24 小时）",
	guideLink: "打开 Cloudflare 控制台",

	// What went wrong
	actionFailed: "操作失败：{error}",
	saveFailed: "无法保存设置：{error}",
	saveDone: "设置已保存",

	transferTitle: "把这些设置分享给另一台 Mac",
	transferHint:
		"一个使用通配域名（*.example.com）的 Access 应用可以管下面所有的 Mac。在这里导出团队名、AUD 标签和允许的邮箱，在另一台 Mac 上导入，它就只需要填自己的主机名。文件里没有别的东西（没有主机名、隧道和任何凭据）。",
	transferExport: "导出设置",
	transferImport: "导入设置…",
	transferExported: "已保存 {name}",
	transferImported: "已把文件里的设置填进上面的表单。请核对，如果还没有主机名就填上这台 Mac 的主机名，然后保存。",
	transferTooLarge: "这个文件太大，不像远程访问设置文件。",
	transferNotJson: "这个文件不是 JSON。",
	transferNotOurs: "这不是 omp-webui 导出的远程访问设置文件。",
	transferVersion: "这个文件来自此版本读不了的 omp-webui。",
	transferEmpty: "这个文件里没有团队名、AUD 标签或邮箱。",
	transferTooMany: "这个文件里的邮箱太多了。",
	transferInvalid: "这个文件里的设置无效：{error}",
	transferReadFailed: "无法读取这个文件：{error}",

	// Sidebar indicator
	indicatorOff: "远程已关闭",
	indicatorStarting: "远程启动中…",
	indicatorConnected: "远程已连接",
	indicatorError: "远程未运行",
	indicatorTitle: "远程访问：{state}。设置 › 远程访问。",
};
