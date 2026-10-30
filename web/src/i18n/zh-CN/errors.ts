import type { en } from "../errors.ts";

export const zh: Record<keyof typeof en, string> = {
	// A change of the Light settings that was refused
	settingsListInvalid: "{field}必须是名称列表。",
	settingsNameInvalid: "{field}里有无效的名称。",
	settingsAddressInvalid: "{name} 地址必须形如 http://127.0.0.1:11434/v1。",
	settingsAddressLinkLocal: "{name} 地址是链路本地地址（{host}），那里不会有模型服务器。",
	settingsOfflineShape: "轻量模式的设置必须是一个对象。",
	settingsBackendUnknown: "本地模型服务器必须是以下之一：{backends}。",
	settingsBaseUrlsShape: "服务器地址必须是一个对象。",
	settingsBaseUrlsBackendUnknown: "{name} 不是本应用支持的本地模型服务器。",
	settingsModelShape: "模型必须为空（自动选择），或是本地服务器的模型 ID，例如 ollama/llama3。",
	settingsModelOfBackend: "模型必须为空（自动选择），或是 {name} 提供的模型。",
	settingsThinkingUnknown: "这不是有效的思考强度。",
	settingsToolUnknown: "{tool} 不是轻量模式可用的工具。",
	settingsToolsNone: "轻量模式至少需要一个工具。",
	settingsAgentsMdShape: "是否加载 AGENTS.md 只能是开或关。",
	settingsModeUnknown: "模式只能是完整或轻量。",
	settingsLightModelsUnknown: "轻量模式的模型只能是你自己的模型，或本地服务器的模型。",
	settingsFieldUnknown: "{setting} 不是轻量模式的设置。",

	// Light on a local server that cannot start
	offlineUnreachableRefused: "无法连接到 {url} 上的 {name}（连接被拒绝）。请启动 {name} 服务器，或切换到完整模式。",
	offlineUnreachableTimeout:
		"无法连接到 {url} 上的 {name}（{seconds} 秒内没有响应）。请启动 {name} 服务器，或切换到完整模式。",
	offlineUnreachableOther: "无法连接到 {url} 上的 {name}（{reason}）。请启动 {name} 服务器，或切换到完整模式。",
	offlineKeyWithheld:
		"{url} 上的 {name} 需要 API 密钥（HTTP {status}），而 models.yml 里的密钥不会发到这个地址：它既不在这台电脑或其网络上，也不是 models.yml 给 {backend} 提供方的地址。请把这个地址写进该提供方，或改用本地地址。",
	offlineKeyRefused:
		"{url} 上的 {name} 拒绝了它的 API 密钥（HTTP {status}）。请检查 models.yml 里 {backend} 提供方的 apiKey。",
	offlineModelNotServed: "{name} 不提供 {id}（它提供：{served}）。请在“设置 › 完整 / 轻量”里选择别的模型。",
	offlineModelNotServedNone: "{name} 不提供 {id}（它没有提供任何模型）。请在“设置 › 完整 / 轻量”里选择别的模型。",
	offlineChooseModel: "请在“设置 › 完整 / 轻量”里选择一个模型：{name} 没有列出它的模型。",
	offlineNoModels: "{name} 还没有可用的模型。请先在 {name} 里加载或拉取一个，或切换到完整模式。",
	offlineProviderMissing:
		"轻量模式使用本地服务器时，需要在 {path} 里有名为“{backend}”的提供方（带 baseUrl），但没有找到。",
	offlineModelsUnreadable: "无法读取 {path}：{reason}",
	offlineFlagForeignModel:
		"轻量模式使用本地服务器时只使用 {name} 的模型，但 {flag} {value} 选择了别的模型。请去掉这个选项，或切换到完整模式。",

	// A conversation that cannot be switched to the other mode now
	modeSwitchPaused: "这个对话已暂停；请先继续它，再切换模式。",
	modeSwitchUnsaved: "这个对话还没有保存的记录；请先发送一条消息，再切换模式。",

	// A folder the folder picker cannot list
	dirRelative: "{path} 不是完整路径：请以 / 或 ~ 开头。",
	dirNotFound: "{path} 不存在。",
	dirNotFolder: "{path} 不是文件夹。",
	dirNoAccess: "没有权限打开 {path}。",
	dirNotWritable: "没有权限在 {path} 里创建文件夹。",
	projectsNotHere: "项目文件夹要在运行 omp-webui 的电脑上更改。",
	projectsFolderShape: "请指定文件夹，或选择默认。",
	// 具体的名称问题由页面根据 `problem` 说明（project-groups 命名空间）。
	groupNameInvalid: "这个名称不能用作分组名。",
	groupProjectInvalid: "项目由它的对话所在的文件夹来标识。",
	groupUnknown: "这个分组已经不存在了。",
	groupFull: "分组里的项目已经达到上限。请先移出一个。",

	// An omp install or update that did not finish
	jobCancelled: "已取消",
	jobCouldNotRun: "无法运行 {command}：{reason}",
	jobExited: "{command} 退出，退出码 {code}。",
	jobExitedOutput: "{command} 退出，退出码 {code}：\n{output}",
	jobStopped: "{command} 在完成前被停止。",
	jobStoppedOutput: "{command} 在完成前被停止：\n{output}",
	installNotFound: "安装程序已完成，但之后没有找到 omp。查找位置：{dirs}",
	installDoesNotRun: "omp 已安装在 {bin}，但无法运行：{error}",
	updateDoesNotRun: "omp 已更新，但无法运行：{error}",
	updateStillOld: "omp update 已完成，但 omp 仍报告版本 {version}",
	jobNotSettled: "{command} 在 omp-webui 关闭期间已结束，但无法读取它的结果：{reason}",

	// A paused conversation that omp may not be run for
	paused: "这个对话已暂停；请先点“继续”再进行操作。",
	pausedRetryDue:
		"这个对话已暂停，而 omp 正在等待重试失败的那一轮，这次等待已经结束：为这个操作运行 omp 会开始重试那一轮。请点“继续”，让它重试。",

	sessionFolderGone: "这个对话原来所在的文件夹 {folder} 已不存在。",
	sessionFolderUnknown: "这个对话的文件没有记录它所在的文件夹。",

	// A closed conversation's omp that has not ended yet
	stillFinishing: "这个对话被关闭后，omp 仍在完成手头的工作；请等它结束后再试。",

	// 旁问：一个对话里排队的已达上限
	btwTooMany: "这个对话已有两个旁问在排队：请等其中一个回答完，或取消一个。",

	// Moving to another computer
	migrateBusy: "另一个导出或导入正在进行；请等它结束。",
	migrateWorking: "有 {count} 个对话仍在工作。请等它们结束或先停止它们，然后重试。",
	migrateNothingChosen: "没有选择要导出的内容。请至少勾选一种数据，或者包含登录信息。",
	migrateCategories: "{category} 不是可以导出的数据类型。",
	migratePasswordMissing: "请输入用来加密文件的密码。",
	migratePasswordShort: "密码至少要有 {min} 个字符。",
	migratePasswordWrong: "这个密码打不开文件里的登录信息。没有改动任何内容。",
	migratePasswordNeeded: "这个文件是加密的。请输入密码来打开它。",
	migrateFilePasswordWrong: "这个密码打不开这个文件。没有改动任何内容。",
	migrateTampered: "文件在生成之后被改动过，或者已经损坏，所以没有导入。没有改动任何内容。",
	migrateNotArchive: "这不是 omp-webui 的迁移文件，或者无法读取。",
	migrateCorrupt: "文件已损坏或不完整。没有改动任何内容。",
	migrateNewerFormat:
		"这个文件由更新的 omp-webui 生成（格式 {format}；当前版本最高读取到 {supported}）。请更新这个应用后重试。",
	migrateNotReady: "文件还没有检查过。",
	migrateUpload: "上传没有从中断的位置继续。请重新开始。",
	migrateNoCredentials: "这个文件不含登录信息。",
	migrateRunning: "正在导入并写入文件。请在导入结束后再打开对话。",
	migrateTooLarge: "文件里的 {file} 声称比实际存放的内容大得多，不可能是这个应用生成的文件。没有改动任何内容。",
	migrateDiskSpace: "这台 Mac 的可用空间不够放下文件里的内容。请先腾出空间再试。",
	migrateNoBackup: "没有可以还原的备份。",
};
