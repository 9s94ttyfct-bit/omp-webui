import type { en } from "../controls-help.ts";

export const zh: Record<keyof typeof en, string> = {
	autoCompactionWhat: "对话变得过长、超出模型的上下文窗口时，omp 会把较早的部分总结成摘要，让工作能继续下去。",
	autoCompactionOn: "上下文超过 omp 的阈值时，或请求已装不下时，omp 会自己压缩。",
	autoCompactionOff: "omp 绝不会自己压缩。装不下的请求会失败，直到你手动压缩（下方“压缩上下文”）或开始新的对话。",
	autoCompactionCost:
		"压缩是多出的一次模型请求；之后模型看到的是摘要，而不是较早的消息：摘要里没写的细节，模型就不知道了。",
	autoCompactionAdvice: "建议保持“开”。只有想自己决定何时总结历史时才关掉。",

	autoRetryWhat:
		"请求因可能自行消失的原因失败时（限流、服务商过载、连接中断、用量上限解除），omp 会等待并自动重新发送。",
	autoRetryOn:
		"omp 最多重试到它的重试上限（默认 10 次），每次等待更久；它可能切换到另一个账号，或你配置过的备用模型。等待期间可以取消。等待时间超过 5 分钟（例如稍后才重置的用量上限）时，这一轮会直接结束，除非 omp 能切换到另一个账号或模型，或者打开了 retry.waitForUsageReset。",
	autoRetryOff: "第一次失败就会带着错误结束这一轮，在你手动重试之前不会再发送。",
	autoRetryCost:
		"每次重试都是计费的请求；切换到另一个账号或模型，回答的对象也可能变了。关掉后，服务商的一次小故障就会让工作停下来等你。",
	autoRetryAdvice: "建议保持“开”，无人值守时尤其如此。想立刻看到失败的请求时再关，例如调试服务商或代理。",

	steeringModeWhat:
		"omp 工作时你发出的引导消息（“立即发送”）会在它这一轮的中途送达，而不是等它做完。此项决定多条等待中的消息如何交给它。",
	steeringModeOneAtATime: "每条引导消息单独占一轮，omp 逐条回应（omp 推荐）。",
	steeringModeAll: "所有等待中的引导消息一起送达，合成一轮。",
	steeringModeCost:
		"选“逐条”时，每条消息要多花一轮模型调用，但各条互不影响。全部更省，但互相依赖的消息（先纠正、再说“算了”）会被放在一起读。",
	steeringModeAdvice: "建议保持“逐条”。同时引导多条互不相干的备注、只想要一个回应时，再用“全部”。",

	followUpModeWhat: "omp 工作时你排队的后续消息会等到它这一轮结束。此项决定它结束后如何处理这些消息。",
	followUpModeOneAtATime: "每条后续消息单独占一轮，按你排队的顺序（omp 推荐）。",
	followUpModeAll: "所有排队的后续消息一起发送，合成一轮。",
	followUpModeCost:
		"选“逐条”时，每条后续消息都要多花一整轮。全部更省，但 omp 会一次回应多个请求，在开始第二个之前无法根据第一个的结果行动。",
	followUpModeAdvice: "建议保持“逐条”。一批小而互不相干的请求可以用“全部”。",

	interruptModeWhat: "决定引导消息到达时，对 omp 正在运行或即将运行的工具怎么处理。",
	interruptModeImmediately:
		"消息会打断它能打断的工具：尚未开始的会被跳过，omp 会被告知在仍需要时重试。你的消息立刻得到处理。",
	interruptModeWait: "当前这一步的工具先全部跑完，再送达你的消息。",
	interruptModeCost:
		"“立即”能很快叫停错误的命令，但可能把做到一半的工作截断。“等待”不会截断任何工作，但慢的工具会让你的消息等到它结束。",
	interruptModeAdvice: "建议保持“立即”（omp 默认）。工具运行很久或不能被截断时（如迁移、安装），选“等待”。",

	fastModeWhat:
		"让这个对话的请求走服务商的优先档位（omp 的 /fast），回复更快。它作用于当前所用模型的服务商，且只对提供该档位的模型有效。",
	fastModeOn: "优先档位：回复更早开始。",
	fastModeOff: "标准处理。",
	fastModeCost: "优先请求按溢价计费。模型没有优先档位时，omp 会说明，且不会有任何变化。",
	fastModeAdvice: "建议保持“关”。需要等结果、愿意多付费的工作可以开，长时间无人值守的任务不要开。",

	// What the slow mode rows and the filled star of the session controls are called and say: with the explanations, so that
	// they travel with the controls' lazy chunk and not with the first page.
	slowModeLabel: "慢速模式",
	slowModeLabelLowPriority: "慢速模式（到上限时低优先级）",
	slowModeLabelFlex: "慢速模式（更便宜的弹性档位）",
	slowModeLabelClaude: "Claude 慢速模式（到上限时低优先级）",
	slowModeNoteGlobal:
		"到达用量上限后让 Claude 以低优先级继续。这是 omp 的全局设置：在这里打开会写入 omp 的 config.yml，因此对所有对话生效，而不只是当前这个。",
	slowModeNoteSession: "为当前对话使用服务商更便宜、更慢的弹性（flex）档位。仅限当前对话，不会保存到 omp 的设置里。",
	// 已暂停对话的面板：omp 被冻结，所显示的是服务器记下的、omp 当时的设置。
	pausedNote: "已暂停：下面是 omp 暂停时的设置。更改某一项会让 omp 短暂运行来应用它，对话仍保持暂停。",
	starIsDefault: "“{label}”已经是 omp 给新对话的默认值，无需保存",

	// 慢速模式是两种不同的机制，一个对话只显示它的模型所具有的那一种：到套餐用量上限时 Claude 的低优先级通道（omp 的全局设置），
	// 或服务商的弹性（flex）档位（只作用于当前对话）。第三组用于 omp 没有说出服务商的模型：两者都不声称。
	slowModeLowPriorityWhat:
		"Claude 套餐在用量上限重置之前，只允许一定的用量。打开慢速模式后，达到这个用量上限时，请求会以低优先级、用空闲容量继续，而不是停下来等到重置。",
	slowModeLowPriorityOn: "到用量上限时，请求以低优先级继续。",
	slowModeLowPriorityOff: "到用量上限时，请求先得到一小段收尾额度，然后等待重置。",
	slowModeLowPriorityCost:
		"没到上限时它不会改变任何东西。到了上限之后，回复可能慢得多，还可能因为 omp 等待空闲容量而暂停。它是 omp 自己的设置，保存在 config.yml 里，所以会改变所有对话（包括终端），而不只是当前这个。这里没有可设的默认值。",
	slowModeLowPriorityAdvice: "交互式工作建议保持“关”。比起等上限重置，慢慢推进更好时再开。",

	slowModeFlexWhat:
		"向你的模型的服务商（OpenAI 或 Google）要它的弹性（flex）档位：服务商为可以等待的工作提供的、更便宜的处理方式。回复来得更慢，服务商容量紧张时还可能拒绝请求。",
	slowModeFlexOn: "弹性档位：成本更低，回复更慢。",
	slowModeFlexOff: "标准处理：正常的速度和价格。",
	slowModeFlexCost:
		"回复可能慢得多；服务商没有空闲容量时请求会失败，可以稍后再发，或把它关掉。它只作用于当前对话，不会保存到 omp 的设置里。每个服务商在这里各有自己的弹性设置：这个对话里只要有该服务商的模型在运行（包括子代理），它就生效，所以要查看或更改，请切换到那个服务商的模型。这里没有可设的默认值。",
	slowModeFlexAdvice: "交互式工作建议保持“关”。后台或批量任务、等待也无妨时再开。",

	slowModeGenericWhat: "用速度换价格：omp 请你的模型的服务商用它更慢、更便宜的方式处理请求。",
	slowModeGenericOn: "更慢、更便宜的处理。",
	slowModeGenericOff: "标准处理。",
	slowModeGenericCost: "回复可能慢得多。这里没有可设的默认值。",
	slowModeGenericAdvice: "交互式工作建议保持“关”。后台或批量任务、等待也无妨时再开。",

	cacheWarmingWhat:
		"服务商会把提示开头的部分缓存几分钟，让重复请求更便宜。预热会在缓存条目快过期时，重新发送上一次请求（只返回一个 token），让下一次真正的请求仍能命中缓存。",
	cacheWarmingOff: "不发送刷新请求。条目到期后失效（通常 5 分钟），下一次请求要重新为整个提示付写入费用。",
	cacheWarmingStreaming: "只在 omp 工作期间刷新，例如长时间的工具运行中；它一旦闲下来就停止。",
	cacheWarmingIdle: "还会在两轮之间让 5 分钟的条目保持有效，只要预期节省大于刷新成本，最长 30 分钟。",
	cacheWarmingCost:
		"刷新是真实的请求：按缓存读取价格读取整个缓存的提示并返回一个 token，也会计入速率限制和订阅额度。节省太少时 omp 会自己停止。",
	cacheWarmingAdvice:
		"“空闲时”（omp 默认）适合交互式工作。离开时不想发送任何请求，选“流式输出时”；每个请求都占额度时，选“关”。",

	compactAtWhat:
		"上下文超过这个阈值后，omp 会自己压缩对话：可以是模型上下文窗口的百分比，也可以是固定的 token 数。“默认”交给 omp：它会留出一部分余量（窗口的 15% 与 16k token 中较大的那个），所以 200k 的窗口会在约 170k（85%）时压缩。",
	compactAtCost:
		"更早压缩会压缩得更频繁（每次压缩都是一次模型请求），留给模型的对话也更短。更晚能保留更多对话，但请求可能超出窗口而失败，这一轮会中断，直到 omp 压缩为止。",
	compactAtAdvice:
		"除非模型的窗口比 omp 认为的小，或者任务需要更长的历史，否则保持“默认”。要改的话：用比服务商开始拒绝的点略低的百分比，或者当代理、网关限制得比模型窗口更小时，用 token 数。",

	compactWhat: "现在就把对话较早的部分总结成摘要（omp 的 /compact），腾出上下文。说明里可以写明摘要必须保留什么。",
	compactCost:
		"多一次模型请求，且只在有内容可压缩时进行（否则 omp 会告知）。之后模型依据摘要工作：摘要里没有的细节，模型就不知道了。omp 工作时，压缩会排到本轮结束时进行，不会打断正在做的事；在此期间排队的消息会在压缩之后发送。",
	compactAdvice: "开始一项大任务前、上下文快满时使用，并在说明里写明必须保留的内容。自动压缩也会自己做同样的事。",
};
