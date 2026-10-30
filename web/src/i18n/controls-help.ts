/**
 * What each setting of the session controls does, as its "About" disclosure says: what it is, what each choice means, what
 * it costs, and what to pick. The text describes omp's own behaviour (read in omp 18.12's source, not guessed); it is
 * opened by a click, so the strings travel with the controls' lazy chunk (`registerStrings`), not with the first page.
 */
export const en = {
	autoCompactionWhat:
		"When the conversation grows too long for the model's context window, omp summarizes its older part so the work can go on.",
	autoCompactionOn:
		"omp compacts by itself when the context passes its threshold, and to recover when a request no longer fits.",
	autoCompactionOff:
		"omp never compacts by itself. A request that no longer fits fails until you compact by hand (Compact context, below) or start a new conversation.",
	autoCompactionCost:
		"A compaction is one extra model request, and the model then works from a summary in place of the older messages: a detail the summary leaves out is gone for it.",
	autoCompactionAdvice: "Keep it On. Turn it Off only if you want to decide yourself when the history is summarized.",

	autoRetryWhat:
		"When a request fails for a reason that may pass (a rate limit, an overloaded provider, a dropped connection, a usage limit that lifts), omp waits and sends it again by itself.",
	autoRetryOn:
		"omp retries up to its retry limit (10 by default), waiting longer each time. It may switch to another account, or to a fallback model if you configured one. You can cancel a wait. A wait longer than 5 minutes (such as a usage limit that resets later) ends the turn instead, unless omp can switch to another account or model, or retry.waitForUsageReset is on.",
	autoRetryOff: "The first failure ends the turn with its error. Nothing is sent again until you retry.",
	autoRetryCost:
		"Every retry is a billed request, and a switch to another account or model can change who answers. With it Off a short hiccup of the provider stops the work and needs you.",
	autoRetryAdvice:
		"Keep it On, above all for unattended work. Turn it Off to see a failing request at once, for example while testing a provider or a proxy.",

	steeringModeWhat:
		"Messages you steer while omp is working (Send now) reach it in the middle of its turn, not after it. This decides how several waiting ones are handed over.",
	steeringModeOneAtATime:
		"Each steering message gets its own turn, so omp answers them one by one (omp recommends this).",
	steeringModeAll: "Every waiting steering message is delivered together, in one turn.",
	steeringModeCost:
		"One at a time costs a model turn per message and keeps each message separate. All is cheaper, but messages that depend on each other (a correction, then “never mind”) are read together.",
	steeringModeAdvice:
		"Keep One at a time. Use All when you steer several independent notes and want one answer to them.",

	followUpModeWhat:
		"Messages you queue while omp is working (Queue a follow-up) wait for the end of its turn. This decides how they are handed over once it finishes.",
	followUpModeOneAtATime: "Each follow-up gets its own turn, in the order you queued them (omp recommends this).",
	followUpModeAll: "Every queued follow-up is sent together, in one turn.",
	followUpModeCost:
		"One at a time costs a whole turn per follow-up. All is cheaper, but omp answers several requests at once and cannot act on the result of the first before it starts the second.",
	followUpModeAdvice: "Keep One at a time. Use All for a batch of small, independent requests.",

	interruptModeWhat:
		"Decides what a steering message does to the tools omp is running or about to run when it arrives.",
	interruptModeImmediately:
		"The message interrupts the tools it can: ones not started yet are skipped and omp is told to retry them if still needed. Your message is handled at once.",
	interruptModeWait: "The tools of the current step finish first, then your message is delivered.",
	interruptModeCost:
		"Immediately stops a wrong command quickly, but can cut off work half done. Wait never cuts anything off, but a slow tool delays your message until it is over.",
	interruptModeAdvice:
		"Keep Immediately (omp's default). Choose Wait while tools run long or must not be cut off, such as a migration or an install.",

	fastModeWhat:
		"Sends this conversation's requests on the provider's priority tier (omp's /fast) for faster replies. It acts on the provider of the model in use, and only on models that offer it.",
	fastModeOn: "Priority tier: replies start sooner.",
	fastModeOff: "Standard processing.",
	fastModeCost:
		"Priority requests are billed at a premium rate. On a model with no priority tier omp says so and nothing changes.",
	fastModeAdvice:
		"Keep it Off. Turn it On for work you are waiting on and are happy to pay extra for, not for long unattended runs.",

	// What the slow mode rows and the filled star of the session controls are called and say: with the explanations, so that
	// they travel with the controls' lazy chunk and not with the first page.
	slowModeLabel: "Slow mode",
	slowModeLabelLowPriority: "Slow mode (low priority at the limit)",
	slowModeLabelFlex: "Slow mode (cheaper flex tier)",
	slowModeLabelClaude: "Claude slow mode (low priority at the limit)",
	slowModeNoteGlobal:
		"Keeps Claude going at low priority once your usage limit is reached. It is omp's global setting: turning it on here writes omp's config.yml, so it applies to every conversation, not only this one.",
	slowModeNoteSession:
		"Uses the provider's cheaper, slower flex tier for this conversation only; it is not saved in omp's settings.",
	// The panel of a paused conversation: omp is frozen, so what it shows is the server's record of what omp had.
	pausedNote:
		"Paused: these are the settings omp had when it was paused. Changing one runs omp for a moment to apply it, and the conversation stays paused.",
	starIsDefault: "“{label}” is already omp's default for new conversations; nothing to save",

	// Slow mode is two different mechanisms, and a conversation shows only the one its model has: Claude's low-priority
	// lane at the plan's usage limit (omp's global setting), or the provider's flex tier (this conversation only).
	// The third set is for a model whose provider omp does not name: it claims neither.
	slowModeLowPriorityWhat:
		"A Claude plan allows a set amount of use until its usage limit resets. With slow mode on, once you reach that limit your requests keep going at low priority, served from spare capacity, instead of stopping until the reset.",
	slowModeLowPriorityOn: "At the usage limit, requests keep going at low priority.",
	slowModeLowPriorityOff: "At the usage limit, a request gets a short wrap-up allowance, then waits for the reset.",
	slowModeLowPriorityCost:
		"Until the limit is reached it changes nothing. After that, replies can be much slower and may pause while omp waits for spare capacity. It is omp's own setting, saved in its config.yml, so it changes every conversation (and the terminal), not only this one. It has no default to set here.",
	slowModeLowPriorityAdvice:
		"Keep it Off for interactive work. Turn it On when slow progress is better than waiting for the limit to reset.",

	slowModeFlexWhat:
		"Asks your model's provider (OpenAI or Google) for its flex tier: a cheaper way of processing a request that the provider offers for work that can wait. Replies come back more slowly, and when the provider is short of capacity it can refuse a request.",
	slowModeFlexOn: "Flex tier: lower cost, slower replies.",
	slowModeFlexOff: "Standard processing: normal speed and price.",
	slowModeFlexCost:
		"Replies can be much slower, and a request can fail when the provider has no spare capacity; send it again later, or turn this Off. It applies to this conversation only; it is not saved in omp's settings. Each provider keeps its own flex setting here: it applies whenever a model from that provider runs in this conversation, subagents included, so switch to that provider to see or change it. It has no default to set here.",
	slowModeFlexAdvice:
		"Keep it Off for interactive work. Turn it On for background or batch work where waiting is fine.",

	slowModeGenericWhat:
		"Trades speed for price: omp asks your model's provider to process requests in its slower, cheaper way.",
	slowModeGenericOn: "Slower, cheaper processing.",
	slowModeGenericOff: "Standard processing.",
	slowModeGenericCost: "Replies can be much slower. It has no default to set here.",
	slowModeGenericAdvice:
		"Keep it Off for interactive work. Turn it On for background or batch work where waiting is fine.",

	cacheWarmingWhat:
		"Providers keep the start of your prompt in a cache for a few minutes, so repeated requests cost less. Warming re-sends the last request with a one-token reply shortly before the cache entry would expire, so the next real request still finds it.",
	cacheWarmingOff:
		"No refresh requests. An entry expires after its lifetime (5 minutes is typical) and the next request pays to write the whole prompt again.",
	cacheWarmingStreaming:
		"Refreshes only while omp is working, for example during a long tool run, and stops when it settles.",
	cacheWarmingIdle:
		"Also keeps a 5-minute entry alive between turns while the expected saving is more than the refresh costs, for at most 30 minutes.",
	cacheWarmingCost:
		"A refresh is a real request: it reads the whole cached prompt at the cache-read price and returns one token, and it counts against rate limits and subscription quotas. omp stops by itself when the saving is too small.",
	cacheWarmingAdvice:
		"Idle (omp's default) suits interactive work. Choose Streaming to send nothing while you are away, and Off where every request counts against a quota.",

	compactAtWhat:
		"omp compacts the conversation by itself once the context passes this point: a share of the model's context window, or a fixed count of tokens. Default leaves it to omp, which keeps a reserve free — 15% of the window, or 16k tokens, whichever is larger — so a 200k window compacts at about 170k (85%).",
	compactAtCost:
		"Compacting earlier costs more compactions (each one a model request) and gives the model a shorter history to work from. Later keeps more of the conversation but risks a request that no longer fits, which fails the turn until omp compacts.",
	compactAtAdvice:
		"Keep Default unless the model's window is smaller than omp thinks, or a task needs a longer history: then a share just under the point where the provider starts refusing, or a token count where a proxy or gateway limits you below the model's window.",

	compactWhat:
		"Summarizes the older part of the conversation now (omp's /compact) to free context. The instructions say what the summary must keep.",
	compactCost:
		"One model request, and only when there is something to compact (omp says so otherwise). The model then works from the summary: details it leaves out are gone for it. While omp is working the compact is queued for the end of the turn, so no work is cut short; messages you queue meanwhile are sent after it.",
	compactAdvice:
		"Use it before a big new task when the context is getting full, with instructions naming what must survive. Auto-compaction does the same by itself.",
};
