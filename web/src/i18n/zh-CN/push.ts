import type { en } from "../push.ts";

export const zh: Record<keyof typeof en, string> = {
	title: "页面关闭时的通知",
	indexTitle: "通知",
	hint: "对话结束或需要你时，即使这个页面已关闭，手机或电脑也会收到通知。消息只为这一台设备加密，只用对话已保存的标题（没有标题就只写“对话”）称呼它，并说明原因；除非你选择，否则不含对话内容。",
	// This device
	thisDevice: "这台设备",
	enable: "通知这台设备",
	disable: "不再通知这台设备",
	enabling: "正在开启…",
	enabledNote: "当对话结束或需要你、且这台设备没有页面在屏幕上时，服务器会通知它。",
	// Why it cannot be turned on here
	unsupported: "这个浏览器无法在页面关闭时接收通知。",
	needsApp:
		"在 iPhone 或 iPad 上，请先把这个页面添加到主屏幕（分享 › 添加到主屏幕），从主屏幕打开，再在那个应用里开启。Safari 标签页无法接收通知。",
	needsHttps: "页面关闭时的通知需要安全地址（https）。请通过远程地址打开应用（设置 › 远程访问）。",
	blocked: "这个网站的通知被阻止了。请在浏览器或系统设置里允许通知，然后重试。",
	macApp: "macOS 应用会显示自己的通知；这里用于浏览器或主屏幕应用。",
	failed: "无法开启：{error}",
	// The devices
	devices: "会收到通知的设备",
	none: "还没有设备。",
	current: "这台设备",
	lastSent: "上次发送 {when}",
	neverSent: "还没有发送过",
	preview: "显示一行消息内容",
	previewHint:
		"关闭：通知只说出对话名称，以及它已结束或需要你。开启：同时显示在等的问题，或最后一条回复的开头，随推送服务传递（已加密，但内容更多）。",
	test: "发送测试",
	testSent: "已发送",
	testFailed: "{error}",
	testRefused: "推送服务拒绝了它（{status}）。",
	testGone: "推送服务已不认识这台设备，已将它移除。",
	testWait: "刚刚发过一条测试。请等几秒再试。",
	revoke: "撤销",
	revokeLabel: "撤销 {name}",
	revokeAll: "撤销所有设备",
	revoked: "已撤销",
	loadFailed: "无法读取设备：{error}",
	changeFailed: "无法更改：{error}",
	remoteNote: "通过隧道访问时，设备只在远程访问开启期间收到通知。",
	masterNote: "上面的“通知”也必须开启（会替你开启）。",
};
