# omp-webui 0.11.20 UI 审计报告

日期：2026-10-29 · 分支：`audit-0.11.20` · 基线：v0.11.20（`HEAD` = 发布提交）

这份报告记录对 omp-webui 网页端所有界面和操作的一次完整审计：哪些地方查过、怎么查的、明显的 bug 修了什么（每个都有修复前失败的测试和 GitHub issue），以及需要和你商量的设计、交互、文案问题（只记录，没有改代码）。

## 1. 结论

- **覆盖**：§6 清单的 117 项全部查过。截图在 12 种组合下拍摄并自动检查：3 种宽度（桌面 1280×800、宽屏 1920×1080、手机 390×844，手机用触屏模拟）× 2 种语言（英文、简体中文）× 2 种主题（亮、暗）。少数子状态没有截图，只由 e2e 规格验证，§6 里逐项注明（内容搜索的进行中/重试/更多/上限、单个 issue 详情、子代理弹出窗口、机器切换器）。只靠截图看不出的操作（快捷键、拖放、同步、失败重试等）由现有 e2e 测试和这次新增的测试来验证。
- **截图**：截图目录里保留 2572 张，每个界面/状态/组合一张（后面轮次的同名截图覆盖前面的），覆盖 48 个界面、236 个状态。修复后的最后几轮，所有步骤在 12 种组合下都跑通；harness 记录的 HTTP 错误都是预期的，在 §5 逐类解释：假 omp 造成的 `/api/model-config` 500，`chat-states/load-error` 的 404，解锁页的 401。
- **修好的 bug**：12 组（§3），对应 issue #723–#732，另外在 #725、#729、#730 下追加了评论。每个修复都有一个去掉修复就失败的测试：新测试先在基线 v0.11.20 上跑，确认失败；再在修复后跑，确认通过（§7）。
- **待商量**：64 条（§4），按严重程度和改动大小分级。
- **自动检查的余项**：修复后，axe（WCAG 2.1 AA）、文字裁切、被祖先元素裁掉、超出窗口、原始 i18n key 这几项检查剩下的结果都已核实，列在 §5。

## 2. 方法

**隔离。** 所有操作都在测试服务器上进行，用的是 `tests/support/server.ts` 的 `startTestServer`：独立的 HOME、独立的代理目录（`PI_CODING_AGENT_DIR`）、独立的数据目录。中英文、亮暗主题各起一台，这样主题和语言偏好不会在页面之间互相串改。审计服务器不登录模型账户（`login: false`）。实时状态（流式输出、审批、提问、子代理、重试、压缩、额度暂停等）由一个假 omp 驱动，再加上通过 socket 推给页面的帧。整个过程没有写入你真实的 `~/.omp`，也没有读取你的对话、设置或记忆；唯一的一次读取是下面说的登录令牌。

**模型调用。** 没有调用 Haiku 或其他模型。审计 harness 用的是假 omp，不登录。我跑过的 e2e 规格都不调模型。前几轮只跑改动相关规格时，用的是测试套件的默认设置：先执行一次 `omp token anthropic`，把令牌交给隔离的测试服务器，供需要真实模型的规格使用。这一步只读取登录令牌，不写入 `~/.omp`，我跑的规格也没有用到它。最后一轮完整 e2e，以及单元和契约测试，都加了 `OMPW_E2E_OFFLINE=1`，所以不读令牌；需要真实模型的测试被跳过，报告为 skip。

**Harness**（在 `.tmp/audit/` 里，属于一次性脚手架，没有提交）：

| 文件 | 内容 |
|---|---|
| `seed.ts` | 写入中英文两套对话：限流 API 示例、分支、带两个子代理的任务，以及几天的历史；同时建好真实的项目文件夹和 git 仓库 |
| `run.ts` | 静态界面：新对话、对话、面板 13 个标签页、文件、设置 5 页、侧边栏、命令面板、各个页面等。新增了 `sidebar-extra`、`chat-states`、`composer-attach` 三个步骤 |
| `live.ts`、`live-extra.ts` | 实时状态：流式输出、暂停/停止、排队、审批、提问、输入、目标、待办、重试/用量上限、软停止、压缩、额度暂停、防护通知、退出通知、引导式目标、无人值守、工具卡片和消息的各种状态、子代理等待、toast |
| `special.ts` | 特殊情况：未安装 omp、首次设置向导、解锁页、空数据、远程页面、断线、omp 更新通知 |
| `lib.ts` | 每次截图后都跑一遍检查：axe（wcag2a/aa、21a/aa）；无省略号的文字裁切；被祖先元素裁掉的文字（第二轮新加）；超出窗口；原始 i18n key；中文页面里成句的英文；HTTP 和控制台错误 |
| `sheets.ts` | 把同一个状态在各组合下的截图拼成对比图，用于人工检查 |

**人工检查。** 所有对比图都由人眼看过：设置、侧边栏、命令面板、各页面和特殊状态一批，共 91 张；对话、新对话和实时状态一批，共 81 张；实时状态补充一批，42 个状态，看了其中 5 种组合的拼图，字小的地方再看原图。凡是只出现在一种组合里的问题，都回到原图确认过。

## 3. 已修复（每项都有修复前失败的测试和 issue）

| # | 问题 | Issue | 修复 | 测试（修复前失败） |
|---|---|---|---|---|
| F1 | 可滚动的区域不能用键盘到达：工具输出、diff、面板里的待办/信息/指引/分支树、Issues、Ask、反馈预览（axe `scrollable-region-focusable`） | #723 | `useScrolls`（`lib/scrolls.ts`）判断内容是否溢出，溢出时加 `tabIndex=0`；面板标签页的内容区换成 `ScrollPane` | `scroll-focus.spec.ts`（4 个） |
| F2 | 无障碍名称里没有可见文字（WCAG 2.5.3）：目标栏开关、任务行、新对话的防护选择器、指引模板行、额度药丸、面板标签页的计数（"Agents3"）、子代理全屏的切换器 | #724 | 名称改用可见文字，说明移到 `title` 或 `aria-describedby`，并删掉不再使用的 i18n key | `label-in-name.spec.ts`（3 个）、`subagent-full.spec.ts`（2 个）、`quota.spec.ts`（名称改为描述，5 个） |
| F3 | 对比度：警告和危险色调的控件在悬停时降到 4.5:1 以下；不可见字符标记；不可用安装方式的命令被整体变淡（4.11:1）；额度重置时间用了 `opacity-70`（3.26:1） | #725 | 悬停时改成加一圈描边，不再加深底色；标记改用 15% 的底色；只把不可用选项的名称变淡；去掉重置时间的透明度 | `warning-contrast.spec.ts`（10 种配色 × 亮暗）、`omp-install.spec.ts`（每种配色下用 axe 检查） |
| F4 | 读屏器把一行的 diff 读成 "1 lines added" | #726 | 单数用独立的 key `toolLinesAddedOne/RemovedOne`（中英文） | `tool-diff.spec.ts` |
| F5 | 斜杠菜单里很长的参数提示把描述挤出了这一行 | #727 | 提示最多占一半宽度，超出用省略号，完整内容放在 `title` | `slash-hint.spec.ts` |
| F6 | 命令面板的快速指令不跟着输入过滤；没有匹配时第一条是"软停止"，按 Enter 就会把它发出去 | #728 | 按显示出来的整行文字过滤（"发送“软停止”"，名称已本地化），所以输入名称或"发送"都能找到 | `palette-filter.spec.ts` |
| F7 | 手机上：目标栏的标题被挤到只剩两个字母；目标对话框的按钮文字被裁掉；暂停横幅的文字被挤成 10 行；会话选项的输入框超出卡片；引导式目标栏被挤成 7 行 | #729（+评论） | 状态文字先截断；底部按钮区换行；横幅和引导栏的按钮单独占一行；选项网格改用 `minmax(0,1fr)` | `phone-fit-chat.spec.ts`（4 个）、`guided-goal.spec.ts › on a phone` |
| F8 | 手机上设置页：卡片标题和按钮相撞（"Model guidance"、"Measure again"）；"文件传输"被下拉框盖住；运行中会话的名字只剩一个字；下拉框里的文字被裁（"Model defaul"、快速指令的模式）；"跟随系统"折成两行；"Signed in"/"Add account" 折行；"关闭"竖着折成两行 | #730 | `CardHeader` 允许换行；`Button` 加 `whitespace-nowrap`（按钮高度固定，换行的文字会溢出）；各卡片分别调整换行和宽度 | `phone-fit-settings.spec.ts`（Pixel 5 模拟，中英文；英文的 Appearance 和 Close 两个用例在修复前本来就能通过，对应的中文用例修复前失败） |
| F9 | 命令面板没有结果时留下一个空的 listbox（`aria-required-children`）；选中行里高亮的匹配词只有 4.41:1 | #731 | 没有结果时隐藏列表，"无结果"放到列表外面；高亮改用正文颜色，保留底色 | `palette-filter.spec.ts`（2 个） |
| F10 | 终端里由应用自己写的结束行（"进程已退出"、"连接已断开"、Shell 标签页的结束行）用了暗淡样式，约 3:1 | #732 | 改用斜体（SGR 3），不再用暗淡（SGR 2） | `terminal-theme.spec.ts`（10 种配色 × 亮暗） |
| F11 | 手机上 Shell 标签页的工具栏："Copy output" 在固定高度的按钮里折成两行，溢出按钮；按钮不再折行之后，又会超出面板边缘 | #730（评论） | 工具栏允许换行，路径至少保留 `basis-24` | `shell-tab.spec.ts › on a phone` |
| F12 | 服务器连不上时，侧边栏的本机负载那一行被淡化到一半透明度（亮色 2.2:1，暗色 2.99:1），按钮却仍然可以点 | #725（评论） | 改用 `text-faint` 区分，不再降低透明度 | `host-load.spec.ts`（断线时用 axe 检查对比度） |

基线对比：这批新增和改动的测试先在 v0.11.20 的工作树（`.tmp/base`，用 HEAD 构建，再复制进新的测试文件）上运行，每个修复对应的用例都失败；修复后全部通过。其中英文的 Appearance 和 Close 两个用例在基线上也能通过，因为只有中文才会折行，对应的中文用例在基线上失败。`model-guidance.spec.ts` 只是跟着名称的改动调整了写法，不是新的测试。

## 4. 待商量的发现（只记录，没有改代码）

格式：**ID · 严重程度 · 改动大小**。严重程度：bug / 可用性 / 视觉 / 文案。证据截图在本机 `.tmp/audit/out/shots/<界面>/<状态>--<组合>.png`。复现步骤写的是从哪里进入、在什么宽度下看。

**0.12.0 处理状态（2026-10-29 复查，v0.11.20 之后 19 个提交，HEAD `a1fad73a`）。** 下面每一项都标了处理结果、提交和证据；证据里的「截图」是复查 harness 的 `.tmp/audit/out/shots/<界面>/<状态>--<组合>.png`（12 种组合都有），修复前的对照在 `.tmp/audit/out-0.11.20/`。已处理 = 修复在新截图里看得到；部分 = 修了但仍留下一个可见的尾巴（尾巴写在备注里，复查章节 §9 汇总）。下面保留的原始条目文字是审计时的记录。复查留下的尾巴由 `0f20eeba` 处理，确认复查（§9.1）的截图在 `.tmp/audit/out-0.12.0-confirm/shots/`，表里写作「确认：`<界面>/<状态>--<组合>`」。

| ID | 状态 | 提交 | 测试 / harness 证据 |
|---|---|---|---|
| S1 | 已处理 | `0fbee06b`、`0f20eeba` | `phone-fit-settings.spec.ts`（S1；"an arrow of those rows sits on the plain background, never on a half-faded label"）；截图 `settings-look/top--phone-en-light`：两行标签条边缘渐隐、带 ‹ › 箭头；确认：`settings-safety/top--phone-en-light`、`settings-chats/top--phone-zh-CN-dark`，箭头在纯色底上，渐隐的半个标签在箭头里侧 |
| S2 | 已处理 | `0fbee06b` | `phone-fit-settings.spec.ts`（S2）、`settings-nav.spec.ts`；`settings-chats/part4--phone-en-light`：短标签 "Automatic compaction" |
| S3 | 已处理 | `0fbee06b` | `phone-fit-settings.spec.ts`（S3）；`settings-look/part1--phone-en-light`：名称完整，控件在第二行 |
| S4 | 已处理 | `0fbee06b` | `phone-fit-settings.spec.ts`（S4）；`settings-look/part4--phone-en-light` |
| S5 | 已处理 | `0fbee06b` | `phone-fit-settings.spec.ts`；`settings-app/part5--phone-en-light`（长说明收成两行 + "展开"，主次按钮分清） |
| S6 | 已处理 | `0fbee06b` | `settings-app/part7--phone-en-light`（说明在按钮下全宽，"20.6 KB" 不再折行，Close 是按钮） |
| S7 | 已处理 | `0fbee06b` | `settings-search/results--desktop-en-dark`：只剩应用自己的 × |
| S8 | 已处理 | `0fbee06b`、`0f20eeba` | `settings-search.test.ts`（"a label outranks an alias, and an alias a sentence under a setting"、"the theme settings are all found for 主题…"）、`fuzzy.test.ts`；确认：`settings-search/results--desktop-en-dark`："theme" 只有 2 条，Theme 在前、Palette 在后；`results--phone-zh-CN-dark`："主题" 返回 主题、配色 2 条 |
| S9 | 已处理 | `0fbee06b` | `settings-dialogs/guidance-editor--phone-en-light`：红字消失，只有 "0 / 4000" |
| S10 | 已处理 | `0fbee06b`、`0f20eeba` | `settings-nav.spec.ts`（"a card scrolled mostly out of the top is no longer the current one: the card below it is what is read (S10)"）；确认：`settings-dialogs/shortcut-record--wide-zh-CN-light`：高亮在"语言"（第一张完整可见的卡），不再停在几乎滚出顶部的"侧边栏与快捷栏" |
| S11 | 已处理 | `0fbee06b` | `settings-models/part5--phone-en-light`：数字框有边框和占位 "10" |
| S12 | 已处理 | `0fbee06b` | `settings-models/top--phone-en-light`：`in its “This session” settings` |
| S13 | 已处理 | `0fbee06b` | `guidance-names.test.ts`（4 个）；`settings-models/part4--phone-zh-CN-dark`：中文名称、摘要和"内置"标记 |
| S14 | 已处理 | `0fbee06b` | `grep 智能体 web/src` 无结果；`settings-chats/part4--phone-zh-CN-dark` |
| S15 | 已处理 | `0fbee06b` | `guard-page.spec.ts`（"Settings › Safety has a link and a short summary…"）；`settings-safety/part2--phone-en-light`：三行带标签 |
| S16 | 已处理 | `0fbee06b` | `remote.spec.ts`；`remote-page/settings-app--phone-en-light`：卡片开头说明更新的是运行 omp-webui 的那台电脑的 omp |
| N1 | 已处理 | `6a4eb325`、`0f20eeba` | `session-rank.test.ts`（"a name with only the letters in order is listed and not marked… (N1)"）、`fuzzy.test.ts`、`search-everywhere.spec.ts`；确认：`sidebar/filtered--phone-en-light`："Draft the changelog for 2.4" 仍列出但没有任何高亮，"Rate"/"Migrate" 里是一段连续高亮；`--desktop-zh-CN-dark`："限流" 整词高亮 |
| N2 | 已处理 | `6a4eb325` | `sidebar/select-mode--phone-en-light`：两行，带文字的 Archive / Delete / Select all |
| N3 | 已处理 | `6a4eb325` | `sidebar/project-filter--phone-en-light`：图标换成带箭头的文件夹，按钮有 `title`（悬停提示不入截图） |
| N4 | 已处理 | `6a4eb325` | `sidebar-host/popover--phone-en-light`：弹层在过滤行下方，不再盖住"新对话"；小标题与表头不再重复 |
| N5 | 已处理 | `6a4eb325` | `empty-world/agents--phone-en-light`：没有浮在标题上的提示（触屏不再显示图标提示） |
| N6 | 已处理 | `6a4eb325` | `palette/empty-query--phone-en-light`：分组有分隔线；手机片段 3 行 |
| C1 | 已处理 | `6d4fe4d3`、`0f20eeba` | `phone-layout.spec.ts`（"composer footer keeps the main controls … behind ⋯"、"the ⋯ panel names the settings in Chinese too"）、`quick-prompts.spec.ts`（"on a phone the quick prompts are in the ⋯ panel with their name, and the panel closes once one is chosen"）、`panel-column.spec.ts`；确认：`chat-composer/more-panel--phone-en-light|zh-CN-dark`："Thinking: Low"、"Quick prompts"（"思考强度：低"、"快速指令"）；`new-chat-pickers/more-panel--phone-en-light|zh-CN-dark`："Thinking: Low"、"Guard: Off"、"Guidance: off"、"Mode: Full"（"模式：完整"）；`live-extra/soft-stop-line--phone-en-light|zh-CN-dark`：选了快捷指令后 ⋯ 面板已关。尾巴：axe `label-content-name-mismatch`（见 §9.1） |
| C2 | 已处理 | `6d4fe4d3` | `new-chat-pickers/goal-mode-on--phone-en-light`：目标和"跳过提问"同一组 |
| C3 | 已处理 | `6d4fe4d3`、`0f20eeba` | `folder-picker-use.spec.ts`（"a long path shows the folder that is open, with the field focused as it opens and after Enter in it"）；确认：`new-chat-folder/dir-browser--phone-en-light`：一打开就显示 "…/work/acme-api"，首行 "Up to work"；`--desktop-zh-CN-dark` 同样 |
| C4 | 已处理 | `6d4fe4d3` | `folder-picker-use.spec.ts`（"its Create is the only way on"）；`new-chat-folder/new-project-form--phone-en-light` |
| C5 | 已处理 | `6d4fe4d3` | `new-chat-folder/new-project-form--phone-zh-CN-dark`："将创建于 ~/omp" |
| C6 | 已处理 | `6d4fe4d3` | `new-chat-pickers/guidance-picker--phone-en-light`：摘要两行、完整 |
| C7 | 已处理 | `6d4fe4d3` | `guard-conversation.spec.ts`；`chat-session-controls/panel--phone-en-light`：标题行不再有"跟随设置"标记 |
| C8 | 已处理（无截图） | `6d4fe4d3` | `presets.spec.ts`（"when the presets cannot be read the chip says so"）；harness 里假 omp 的 `/api/model-config` 500 让预设芯片显示红色 (!)（`live-extra/toast-long--phone-en-light`） |
| C9 | 已处理 | `6d4fe4d3` | `dead-connection.spec.ts`；`disconnected/offline--phone-en-light`：发送变灰，框上写"重新连接后才能发送" |
| V1 | 已处理 | `dbb49d84` | `chat-header.spec.ts`；`chat-session-controls/panel--phone-en-light`：标题只出现一次 |
| V2 | 已处理 | `dbb49d84` | `chat-session-controls/advanced--phone-en-light`："Optional: what to keep" 完整 |
| V3 | 已处理 | `dbb49d84` | `usage-speed.spec.ts`、`turn-stats.spec.ts`、`stat-format.test.ts`、`chat-header.spec.ts`；`chat-messages/msg-usage-tip--desktop-en-dark`：千分位、cache read/write，不压正文；更多菜单花费 "$0.06" |
| V4 | 已处理 | `dbb49d84` | `chat-header/cost-tip--desktop-en-dark`：英文 "36k tokens"、中文 "36k token"，没有 "tok" |
| V5 | 已处理 | `dbb49d84` | `duration.test.ts`（"durations use Chinese units"）；`live-extra/retry-usage-limit--phone-zh-CN-dark`："将在1小时12分后自动重试"，`quota-hold-held`、`quota-popover` 等同 |
| V6 | 已处理 | `dbb49d84` | `paused-banner.test.ts`；`live-streaming/paused--phone-en-light` |
| V7 | 已处理 | `dbb49d84` | `status-parity.spec.ts`；`live-extra/compaction-running|compaction-outcome--phone-en-light` |
| V8 | 已处理 | `dbb49d84` | `queue-edit.spec.ts`；`live-extra/queue-edit--phone-en-light` |
| V9 | 已处理 | `dbb49d84` | `retry-banner.spec.ts`、`chat-retry.spec.ts`；`live-extra/retry-backoff--phone-en-light`、`retry-ended`：重试等待和失败是带 Cancel 的卡片 |
| V10 | 已处理 | `dbb49d84` | `quota-lazy.spec.ts`；`live-extra/quota-hold-held--phone-en-light` |
| V11 | 已处理 | `dbb49d84` | `live-extra/unattended-on|unattended-chip--phone-en-light`：开启是实心月亮，⚡ 不再单独掉行 |
| V12 | 已处理 | `dbb49d84` | `live-extra/soft-stop-line|compact-queued-line--phone-en-light`：图标、文字、取消同一块 |
| V13 | 已处理 | `dbb49d84` | `toasts.spec.ts`、`toast-long.spec.ts`；`live-extra/toast-long--phone-en-light`、`toast-many--desktop-en-dark`（底部、最多两条、"3 more waiting"） |
| V14 | 已处理 | `dbb49d84`、`0f20eeba` | `guided-goal.spec.ts`（"the proposal's buttons stay inside its card, under what scrolls; editing clears a refusal"，`0f20eeba` 加了"要求修改"表单在固定栏上方的检查）；`live-extra/goal-proposal-error--phone-en-light`：操作固定在卡片底部；确认：`live-extra/goal-proposal-changes--phone-en-light|zh-CN-dark`：输入框和 Cancel/Send 都在固定的错误+按钮栏上方，不用滚动 |
| V15 | 已处理 | `dbb49d84` | `subagent-retry.spec.ts`；`live-extra/agents-wait-detail--desktop-en-dark`、`agents-wait-stop-menu--phone-en-light`：一个拆分的 Stop，"Stop and continue" 在菜单里 |
| V16 | 已处理 | `dbb49d84` | `live-extra/tool-guard-verdicts--phone-en-light`："$0.0012 · 1.8 s" 不再拆开 |
| V17 | 已处理 | `dbb49d84`、`0f20eeba` | `phone-fit-chat.spec.ts`、`quota-lazy.spec.ts`、`status-line.spec.ts`、`panel-column.spec.ts`（"the composer's footer is one row … (V17)"、"as the window widens or narrows the footer changes once…"）、`git-status.spec.ts`（"the model's name keeps its room on the line; the branch gives way first, then is its icon…"）；手机：回到底部变成条，状态行一行（`chat-states/scrolled-up--phone-en-light`）；确认：`chat-panel/default--desktop-en-dark|desktop-zh-CN-light`：1280 宽开面板时底栏一行，其余控件收进 ⋯（中文 ☾ 不再单独一行）；`--wide-zh-CN-light` 带文字一行；`live-extra/retry-backoff--phone-en-light`：状态行 "Claude Opus 4.8 High" 完整，分支只剩图标；手机英文 44 个实时状态里模型名都完整，放得下时分支仍写 "main" |
| P1 | 已处理 | `610eba39` | `split-panel.spec.ts`；`chat-panel/default--phone-en-light|zh-CN-dark`：每个标签有名称，条可横向滚动，带箭头 |
| P2 | 已处理 | `610eba39` | `chat-panel/tab-jobs--phone-en-light` |
| P3 | 已处理 | `610eba39` | `chat-panel/tab-guidance--desktop-en-dark`：应用自己的选择器和输入框 |
| P4 | 已处理 | `610eba39` | `files-transfer.spec.ts`；`chat-panel-files/transfer--phone-en-light`：弹层在面板内，占位文字完整 |
| P5 | 已处理 | `610eba39` | `split-panel.spec.ts`（面板不自己切标签）；`live-extra/agents-wait-stop-menu--desktop-en-dark`、`live-streaming/panel-agents-running--desktop-en-dark`：子代理标签带运行数 "Agents 1/1"（不跳转这一点截图看不出，由规格验证） |
| G1 | 已处理 | `14991b2e` | `agent-graph.spec.ts`（"Untitled …"）；`agents-page/untitled-row--phone-en-light`："Untitled · 01:30:45"；`empty-world/agents--desktop-en-dark` 空状态在画布中央 |
| G2 | 已处理 | `14991b2e` | `cli-phone.spec.ts`；`cli-page/commands-open--phone-en-light`、`ran--phone-en-light` |
| G3 | 已处理 | `14991b2e` | `guard-page.spec.ts`；`guard-page/policy--phone-en-light`：灰色 Allow 后面写明原因 |
| G4 | 已处理 | `14991b2e` | `guard-page.spec.ts`；`guard-page/decisions--phone-en-light`、`bench`："Expected result" |
| G5 | 已处理 | `14991b2e`、`0f20eeba` | `memory.spec.ts`（"with no store yet the page gives the command that turns memory on, to copy, and Add is disabled, with its reason on the page"）；确认：`empty-world/memory--phone-en-light`：给出 `omp config set memory.backend mnemopi` 和复制按钮；"Add memory" 禁用，原因写在标题下（"There is no memory store yet: turn memory on…"）；命令框和页面内容同样的左右边距；`memory-page/default--desktop-zh-CN-dark` 同样 |
| G6 | 已处理 | `14991b2e` | `remote-page/guard--phone-en-light` |
| O1 | 已处理 | `59dab095` | `omp-install.spec.ts`（手机）；`omp-missing/first-run--phone-en-light`：标签在命令上方，命令不在 token 中间折行，路径收进"已在 6 个位置查找" |
| O2 | 已处理 | `59dab095` | `onboarding/step-done--desktop-en-dark|wide-zh-CN-light`：最后一步没有"跳过设置" |
| O3 | 已处理 | `59dab095` | `auth.spec.ts`（"a wrong token's error is announced and readable"）；`unlock/invalid--desktop-en-dark` |
| A1 | 已核实、不改 | — | Radix 模态菜单打开时 axe 报 `aria-hidden-focus` 仍是同一类（复查里 100 个状态，多出的 12 个是新加的子代理 Stop 菜单状态）；改成非模态会改变点外部关闭和焦点归还，所以保持 |
| A2 | 已核实、不改 | — | xterm 里程序自己的暗淡输出，应用没有改；应用自己写的结束行已在 F10 改成斜体 |
| #736 | 已处理 | `50c031d6`、`0f20eeba` | `agent-graph.spec.ts`（293 个子代理；"beside an open subagent the strip stays in the graph's half…"、"turning Focus on, or changing Grid while it is on, frames what runs again…"）、`agent-graph.test.ts`（"minimap size"）；`agents-graph-many/*`（概览、展开卡片、过滤、搜索、网格、聚焦+缩略图、缩小、适应）；确认：`agents-page/detail--phone-en-light|zh-CN-dark`：详情旁边的工具条折行，芯片完整，搜索框 "Find by name"；`agents-graph-many/focus-minimap--phone-en-light`：缩略图约 100×70（之前约 190×130）；`focus-with-grid--desktop-en-dark|phone-zh-CN-dark`：搜索、网格之后再聚焦，画布重新框住主代理和运行中的 Runner |

### 4.1 设置

- **S1 · 可用性 · M**：手机上设置页顶部的标签条和分节按钮可以横向滚动，但没有渐隐或箭头提示；首尾两项被切掉（"ɔdels & accounts"、"Keyb"、"你排队的"）。证据：`settings-look/top--phone-en-light.png`。建议：加边缘渐隐或滚动按钮，或者改成两行。
- **S2 · 视觉 · S**：有些分节按钮是一整句话（"When omp compacts by itself"、"Notifications when this page is closed"），手机上会超出窗口。证据：`settings-chats/part4--phone-en-light.png`。建议：给每节一个短标签（"Compaction"、"Queued compact"、"Notifications"）。
- **S3 · 视觉 · S**：侧边栏和导航栏的排序行在手机上把名称截断成 "Commands & t…"。证据：`settings-look/part1--phone-en-light.png`。建议：手机上把控件放到第二行。
- **S4 · 可用性 · S**：快捷键行在手机上布局不一致：名称短的一行放得下，名称长的会折行，"Change/Remove" 的点按区域也小。证据：`settings-look/part4--phone-en-light.png`。建议：手机上统一把名称放在控件上方，并加大点按区域。
- **S5 · 视觉 · S**：远程访问卡片在手机上是大段文字；隧道相关的三个操作看起来像一排变淡的标签页，旁边只有一个实心按钮。证据：`settings-app/part5--phone-en-light.png`。建议：长说明折叠到"工作原理"里，按钮分清主次。
- **S6 · 可用性 · S**：反馈行在手机上把说明挤成一窄列；导出表里的大小折成 "20.6 / KB"；运行中会话的 "Close" 只是一个文字链接。证据：`settings-app/part7--phone-en-light.png`。
- **S7 · 视觉 · S**：设置搜索框里有两个清除按钮，一个是浏览器自带的蓝色 ×，一个是应用自己的灰色 ×。证据：`settings-search/results--desktop-en-dark.png`。建议：隐藏 `::-webkit-search-cancel-button`。
- **S8 · 可用性 · S**：设置搜索的匹配太宽：英文搜 "theme" 返回 26 条关系不大的设置，中文搜"主题"只返回 1 条。建议：收紧模糊匹配，标题命中的排在前面。
- **S9 · 可用性 · S**：新建指引模板的对话框一打开就显示红字"模板需要名称"。证据：`settings-dialogs/guidance-editor--*.png`。建议：等用户提交后再显示。
- **S10 · 视觉 · S**：分节按钮的高亮比可见内容慢一拍（看的是语言/快捷键，高亮的还是"侧边栏和导航栏"）。证据：`settings-dialogs/shortcut-record--*.png`。建议：调整滚动监听的阈值。
- **S11 · 视觉 · S**：额度下限的数字框是空的，几乎看不见，也没有占位提示；旁边的"保存"一直是淡色。证据：`settings-models/part4--phone-en-light.png`。
- **S12 · 文案 · S**：Full/Light 的介绍末尾是 "…until you switch it in its This session settings"，界面上的标签直接嵌在句子里。建议：加引号，写成 'in its "This session" settings'。
- **S13 · 文案 · M**：内置的指引模板（"One of each kind at a time"、"Simple to DeepSeek, complex to Sonnet"）在中文界面里仍然是英文名称和英文摘要。它们是保存在服务器上、用户可以编辑的数据，模板正文还会发给模型，所以不能当成普通的界面翻译来处理。需要你决定：内置模板是否按语言分别提供。
- **S14 · 文案 · S**：中文术语混用："智能体"出现在压缩和安全相关的文字里，"代理/子代理"出现在代理关系图和"代理工作时"里。建议：统一用一个词。
- **S15 · 文案 · S**：防护状态行 "No decision recorded yet · reviewer's rules: default · kinds changed from Ask: 0" 太零碎，手机上折成 4 行。证据：`settings-safety/part2--*.png`。
- **S16 · 可用性 · S**：远程页面的 omp 卡片仍然提供"自动更新 omp / 立即检查 / 重新运行首次设置"，而同一页的"更新"卡片写着远程页面不能更新。服务器确实允许从远程更新 omp（`/api/omp` 没有限制只能本机访问），所以功能上没有问题，但两张卡片的说法让人困惑。建议：卡片上注明"更新的是运行 omp-webui 的那台电脑上的 omp"。

### 4.2 侧边栏、导航栏、命令面板

- **N1 · 可用性 · S**：侧边栏过滤用模糊匹配，输入 "rate" 时字母散落地高亮在 "Migrate"、"Draft" 里；没有匹配时显示"没有对话"，而且 "↑↓ 移动，Enter 打开"的提示还在。证据：`sidebar/filtered--*.png`、`sidebar/no-match--*.png`。建议：连续高亮；写成"没有匹配的对话"；没有结果时隐藏提示。
- **N2 · 可用性 · S**：批量操作栏里归档和删除只有图标；"All" 意思不明确。证据：`sidebar/select-mode--*.png`。建议：加文字标签，改成"全选"。
- **N3 · 可用性 · S**：项目行右边的文件夹图标按钮没有任何说明。证据：`sidebar/project-filter--*.png`。
- **N4 · 视觉 · S**：本机负载弹层里"进程"既是小标题又是表头，重复了；手机上弹层盖住了"新对话"按钮。证据：`sidebar-host/popover--phone-zh-CN-dark.png`。（评审提到的"中文图表只有一个时间标签"经复查不成立，中英文都有起止两个标签。）
- **N5 · 视觉 · S**：手机上"显示侧边栏"的提示框一直盖在页面标题上。证据：`empty-world/agents--phone-en-light.png`。
- **N6 · 视觉 · S**：命令面板里的快速指令、动作和分组标题在没有输入时排得很满；消息命中的摘要用的是 `line-clamp-2`，第二行在手机上会被切掉。属于观感问题，没有改。

### 4.3 新对话和输入框

- **C1 · 可用性 · M**：手机上输入框的工具栏有 8 个只有图标的按钮，同时还有两个带文字的（"Guidance: off"、"Goal"）；两个琥珀色的盾牌按钮（权限和防护）看起来一样，分不清。证据：`new-chat/typed--phone-zh-CN-dark.png`、`remote-page/new-chat--phone-en-light.png`。建议：给琥珀色的那两个加短标签，或者统一成只有图标、点按时出提示。
- **C2 · 视觉 · S**：开启目标模式时，"跳过提问"单独占了第三行，颜色也淡。证据：`new-chat-pickers/goal-mode-on--phone-en-light.png`。
- **C3 · 可用性 · S**：目录浏览器的路径框只显示开头（"/private/var/folders/…"），看不到当前文件夹名；".." 那一行没有"上一级"之类的说明。证据：`new-chat-folder/dir-browser--phone-en-light.png`。
- **C4 · 可用性 · S**：新建项目的内联表单有自己的"返回 / 创建并使用"，下面对话框的"使用这个文件夹"却仍然可以点，两排按钮不知道该点哪个。证据：`new-chat-folder/new-project-form--*.png`。
- **C5 · 文案 · S**：中文"建在 ~/omp"读起来别扭，建议改成"将创建于 ~/omp"。
- **C6 · 可用性 · S**：指引选择器里的描述在半句处截断，被截掉的部分也没有办法看到。证据：`new-chat-pickers/guidance-picker--*.png`。建议：允许折成两行，或者加 `title`。
- **C7 · 文案 · S**：防护选择器的标题行有一个"跟随设置"的标记，第一个选项又是"跟随设置（当前：关）"，同一件事说了两遍。
- **C8 · 可用性 · S**：模型配置加载失败时，工具栏上的选择器一直是灰色骨架，没有出错的提示（harness 里假 omp 的 `/api/model-config` 返回 500）。证据：`new-chat/typed--desktop-en-dark.png`。
- **C9 · 可用性 · S**：断线时页面顶部会显示"正在重新连接…"，但输入框和发送按钮看起来仍然可用。证据：`disconnected/offline--*.png`。（第一轮"手机上出现浏览器自己的离线页面"是 harness 用 `setOffline` 导致的，已经改用切断 WebSocket 重新截图。）

### 4.4 对话视图

- **V1 · 视觉 · S**：手机上从"更多"菜单打开"当前对话"弹层时，"更多"菜单的卡片还露在弹层后面，"当前对话"的标题出现两次。证据：`chat-session-controls/panel--phone-en-light.png`。建议：打开弹层时关掉"更多"菜单。
- **V2 · 视觉 · S**："压缩上下文"的占位文字 "Optional: what the summary…" 被裁掉。证据：`chat-session-controls/advanced--phone-en-light.png`。
- **V3 · 视觉 · S**：每条消息用量的提示框：数字没有千分位，r/w 是没有解释的缩写，提示框还盖住了正文；"更多"菜单里的花费显示成 "$0.058100"。证据：`chat-messages/msg-usage-tip--desktop-en-dark.png`、`chat-header/more-menu--phone-en-light.png`。
- **V4 · 文案 · S**：token 的写法不统一：英文头部写 "tok"，其他地方写 "tokens"；中文里有时写 "tokens"，有时写 "token"。
- **V5 · 文案 · M**：中文界面里时长的单位还是英文："3d 0h 后重置"、"12m 34s"、"1h 12m 后"、"45s 后开始"。证据：`live-extra/retry-usage-limit--phone-zh-CN-dark.png`。建议：让 `fmtDuration` 按语言输出单位（天/小时/分/秒）。它的调用点很多，所以单独列出来商量。
- **V6 · 视觉 · S**：暂停横幅的标题显示 "已暂停 · 0ms"，不到一秒的时长没有意义。建议：一秒以内不显示。
- **V7 · 文案 · S**：压缩相关的文字里直接出现原始的 action 名（"Auto context-full maintenance…"、"completed · 180k tokens before"）。证据：`live-extra/compaction-running--phone-en-light.png`。
- **V8 · 文案 · S**：编辑排队消息时的说明 "Saving puts it at the end of the queue: 1 message queued after it will now go first." 不通顺。
- **V9 · 可用性 · S**：重试的等待和失败只是一行很小、很淡的文字（"Retrying 2/5 in 45s · Cancel"），远不如用量上限卡片醒目。证据：`live-extra/retry-backoff--desktop-en-dark.png`。
- **V10 · 可用性 · S**：额度暂停卡片上的"仍然继续 / 再次暂停"是幽灵按钮，看起来像普通文字。证据：`live-extra/quota-hold-held--phone-en-light.png`。
- **V11 · 可用性 · S**：无人值守的开关只有一个图标，开没开只靠颜色区分；手机上开启后 ⚡ 会单独掉到第二行。证据：`live-extra/unattended-on--*.png`、`unattended-chip--phone-en-light.png`。
- **V12 · 视觉 · S**：手机上软停止和排队压缩的状态行：图标单独占一行，"取消"在英文下折到第三行。证据：`live-extra/soft-stop-line--phone-en-light.png`、`compact-queued-line--phone-en-light.png`。
- **V13 · 视觉 · S**：toast 盖在头部的按钮上（桌面上盖住 token、花费和额度，手机上盖住警告横幅的"忽略"）；一次叠三条时占了顶部大约 230px；展开后的滚动区域停在半行字上。证据：`live-extra/toast-long--desktop-en-dark.png`、`toast-expanded--phone-en-light.png`、`live-requests/toasts--phone-en-light.png`。建议：toast 放到头部下方或底部，最多叠两条。
- **V14 · 可用性 · S**：引导式目标的提案卡片出错后，"开始目标"被推到卡片可滚动区域的底部，只露出一半（滚动可以看到）。证据：`live-extra/goal-proposal-error--phone-en-light.png`。建议：把操作按钮固定在卡片底部；提案变化时清掉旧的错误。
- **V15 · 可用性 · S**：子代理详情里，头部的"停止"和正文里的"停止并继续"挨在一起，意思却不同。证据：`live-extra/agents-wait-detail--*.png`。
- **V16 · 视觉 · S**：防护判定的文字在手机上折行，"· 1.8 s" 单独留在第二行。证据：`live-extra/tool-guard-verdicts--phone-en-light.png`。
- **V17 · 视觉 · S**：滚到底部的按钮在手机上盖住正文；状态行会折行；1280 宽并打开面板时，输入框底栏会折行；新对话页上很长的路径会把额度挤到第二行。

### 4.5 右侧面板

- **P1 · 可用性 · M**：手机上面板是一个底部弹层，有 13 个只有图标的标签，没有文字，只有选中的那个显示名称。证据：`chat-panel/default--phone-en-light.png`。
- **P2 · 视觉 · S**：任务标签页的空状态文字贴着面板边缘，没有内边距。证据：`chat-panel/tab-jobs--phone-en-light.png`。
- **P3 · 视觉 · S**：指引标签页用的是原生的 `<select>` 和 textarea，暗色主题下和应用里的其他选择器风格不一致。证据：`chat-panel/tab-guidance--desktop-en-dark.png`。
- **P4 · 视觉 · S**：文件传输弹层在手机上超出了面板的左边缘（但仍然在窗口内）；占位文字被截断。证据：`chat-panel-files/transfer--phone-en-light.png`。
- **P5 · 可用性 · S**：宽屏下有子代理在运行时，面板打开的是上次看的"待办"标签，而不是"子代理"。证据：`live-streaming/panel-agents-running--wide-zh-CN-light.png`。（推断：面板会记住上次选的标签页，这是有意的设计。）

### 4.6 各个页面

- **G1 · 视觉 · M**：代理关系图的列表直接显示没有标题的会话的原始 id（"2026-10-29T05-19-01-817Z_01a1…"）；空状态的提示放在左下角，离画布很远。证据：`agents-page/graph--desktop-en-light.png`、`empty-world/agents--*.png`。建议：显示成"未命名 · 时间"，空状态放在画布中央。
- **G2 · 可用性 · S**：命令页在手机上：命令列表是一条很矮的滚动条，最后一行被截断；运行后输出出现在屏幕下方，不会自动滚过去。证据：`cli-page/ran--phone-en-light.png`。
- **G3 · 可用性 · S**：防护策略页里有些"允许"按钮是灰的，但没有说明为什么不可用。证据：`guard-page/policy--*.png`。
- **G4 · 文案 · S**：防护的"决定"页同时写着"0 条决定"和"还没有做过任何决定"，重复；"它应该"这个标签读起来像半句话。
- **G5 · 视觉 · S**：记忆关闭时，"添加记忆"按钮看起来像被禁用；空状态让用户去改 omp 的配置，却没有链接，也没有给出命令。证据：`memory-page/default--*.png`。
- **G6 · 文案 · S**：远程页面防护页的标题 "The guard is changed on the computer omp-webui runs on" 读起来别扭。

### 4.7 首次运行、向导、解锁

- **O1 · 可用性 · S**：手机上未安装 omp 的页面："运行的命令"这个标签占了不少宽度；命令在 token 中间折行（"https://om / p.sh/…"）；"Looked for omp in: /var/folders/…" 的路径清单很长。证据：`omp-missing/first-run--phone-en-light.png`。
- **O2 · 文案 · S**：向导到了最后的"完成"步骤，"跳过设置"仍然显示。证据：`onboarding/step-done--*.png`。
- **O3 · 视觉 · S**：解锁页的错误提示字小、红色偏淡。中文说明里的 "Open:" 是在原样引用服务器打印的那一行，不需要翻译。证据：`unlock/invalid--*.png`。

### 4.8 无障碍（axe 报出，但不属于明显错误）

- **A1 · 可用性 · S**：Radix 的模态下拉菜单（预设、模式、行菜单等）打开时，axe 报 `aria-hidden-focus`：菜单外的内容被设成 `aria-hidden`，焦点被困在菜单里。这是 Radix 的模态菜单本来就有的行为，读屏时菜单里的内容是正常的。可以考虑改成非模态菜单（`modal={false}`），但那会改变点外部关闭菜单和焦点归还的行为，所以没有动。
- **A2 · 可用性 · S**：xterm 显示的程序输出本身如果用了暗淡样式，对比度也会偏低。那是程序自己的输出，应用没有改。

## 5. 核实过、不需要修的自动检查结果

- 思考块和工具小标题的对比度报警（各组合数值不同：1.83、2.42、4.02…）：截图时恰好赶上 `fade-in` 动画（`index.css`），属于瞬时状态；静止后用 `text-muted`/`text-faint` 是达标的。
- 中文界面里的 "Issues" 标签：中文 i18n 里一直把 GitHub issue 当作外来词使用（`zh-CN/issues.ts` 全文都这样），属于有意的用法。
- 子代理全屏里显示 "26h 00m"：已结束的子代理，时长优先用 omp 报告的 `progress.durationMs`，没有时用 `finishedAt`，再没有才用文件的修改时间（`lib/subagents.ts elapsedMs`）。测试数据里的子代理开始时间是 26 小时前，文件却是刚写出来的，所以按修改时间算出 26 小时。真实的对话文件在最后一次写入时更新修改时间，不会出现这种情况，不算 bug。
- `chat-states/load-error` 每个组合都记录了 `/api/family`、`/api/subagents`、`/api/approval/session` 的 404：这一步故意打开一个不存在的对话来拍加载失败的状态，404 是预期的。`unlock/empty`、`unlock/invalid` 的 401（`/api/meta`、`/api/prefs`、`/api/auth`）同样是预期的：页面还没解锁，或者输入了错误的令牌。
- 审批选项（"Approve / Approve bash for this session / Deny"）在中文下是英文：它们来自 omp 请求里的文字，不是应用的界面文案。
- 假 omp 带来的现象："fake-omp 0.0.0" 的版本提示、`/api/model-config` 返回 500、模型列表里出现本机 Ollama 的模型。
- `offscreen` 报出的条目都在可以横向滚动的容器里：代码块和 diff 的长行、设置页的标签条和分节按钮（后者就是 S1、S2）。
- `rail/not-applicable-drawer` 在手机上报 `document-title` 和 `html-has-lang`：手机没有导航栏，这一步直接截了一张空白页（about:blank），是 harness 造成的。
- 第四轮加了"被祖先元素裁掉的文字"检查，在 F11 修复之后运行，12 种组合下结果都是零（F11 是在第三轮截图里人工看出来的）。这项检查先用一个故意把按钮裁掉的页面试过，能正确报出。第四轮的 axe 结果里还有断线时本机负载那一行的对比度问题，已作为 F12 修复。

## 6. 覆盖清单

✓ 表示该项在 12 种组合（3 种宽度 × 中英文 × 亮暗）下都截图并跑过自动检查，并且人工看过。"操作"一列是验证这项行为的 e2e 规格（`tests/e2e/*.spec.ts`）。"不适用"的情况都写了原因。注明"只由规格验证"的子状态没有截图，是由该行列出的 e2e 规格验证的。

| # | 项目 | 截图状态（界面/状态） | 操作验证 | 结果 |
|---|---|---|---|---|
| 1 | 外壳：重连条、浮动的侧边栏开关、错误页和重新加载、页面加载中 | special/disconnected/offline，所有页面的手机截图，empty-world/* | dead-connection、reconnect、chunk-reload、load-errors、chunk-renders | ✓ |
| 2 | 所有视图和设置页的 URL hash 路由 | 每个步骤都通过 hash 进入 | settings-nav、chat-back | ✓ |
| 3 | 侧边栏头部（标志、状态点、搜索、隐藏） | sidebar/list | sidebar-chrome | ✓ |
| 4 | 侧边栏的"新对话" | sidebar/list | sessions | ✓ |
| 5 | 机器切换器和"添加 Mac" | 不适用于浏览器页面：只在 macOS 应用里、并且保存过别的 Mac 时才显示（`MachineChip.tsx`），没有截图 | machine-switcher（模拟应用的 bridge；只由规格验证） | ✓ |
| 6 | 会话过滤和内容搜索（状态、重试、更多、上限） | sidebar/filtered、no-match（进行中、重试、更多、上限这几个子状态只由规格验证） | sidebar-content-search、search-cap、search-everywhere | ✓ |
| 7 | 项目过滤弹层、分组菜单和对话框 | sidebar/project-filter | project-filter、project-groups | ✓ |
| 8 | 日期范围过滤 | sidebar-extra/range-filter | search-everywhere | ✓ |
| 9 | 已归档、全部对话、归档为空 | sidebar/archived | archive、archived-chat | ✓ |
| 10 | 排序 | sidebar-extra/sort-focused | sessions | ✓ |
| 11 | 选择模式、选择栏、批量删除 | sidebar/select-mode、bulk-delete | bulk-select、delete-busy | ✓ |
| 12 | 会话行的各种状态（选中、置顶、分支、实时点、Light、暂停、摘要、高亮） | sidebar/list、filtered | chat-pin、live-dot-fresh、session-mode | ✓ |
| 13 | 会话行菜单，以及重命名和删除对话框 | sidebar/row-menu、sidebar-dialogs/rename、delete | sessions | ✓ |
| 14 | 置顶分组折叠、日期分组、"在消息中"、键盘导航 | sidebar/list、sidebar-extra/keyboard-nav | sidebar-content-search、chat-pin | ✓ |
| 15 | 首次运行、加载失败、空、无匹配 | empty-world/sidebar、sidebar/no-match | load-errors | ✓ |
| 16 | 侧边栏底部（star 提示、导航、版本、主机、更新、远程） | sidebar/list | star、default-star、version-switcher、app-update、remote | ✓ |
| 17 | 导航项的拖放排列 | rail/rail、settings-look/part1 | nav-layout | ✓ |
| 18 | 侧边栏宽度拖动 | sidebar-extra/resize-handle-focus（桌面、宽屏；手机上是抽屉，没有这个控件） | resizable-panels | ✓ |
| 19 | 导航栏（Rail） | rail/rail、rail-tooltip（桌面、宽屏；手机上不适用，见 `DRAWER_QUERY`） | sidebar-rail | ✓ |
| 20 | 手机上的侧边栏抽屉 | 所有 sidebar/* 的手机截图 | sidebar-narrow、mobile | ✓ |
| 21 | 新对话页（问候、文件夹、最近、额度、选项） | new-chat/*、new-chat-options/flag-form | new-chat-picks、new-chat-options | ✓ |
| 22 | 目录浏览器和新建项目 | new-chat-folder/* | folder-picker、new-chat-folder、projects-folder | ✓ |
| 23 | 输入框的各个选择器（预设、模型、思考、权限、防护、指引、模式、无人值守） | new-chat-pickers/*、live-extra/unattended-* | new-chat-pickers-skeleton、model-picker、presets、unattended、guard | ✓ |
| 24 | 目标开关、预热中/出错/重试 | new-chat-pickers/goal-mode-on | new-chat-retry、guided-goal | ✓ |
| 25 | 对话：加载中、加载失败、已归档、较早的分支 | chat-states/load-error、chat-branches/* | load-errors、archived-chat、branch | ✓ |
| 26 | 对话头部（标题、徽标、重命名、目录、归档标记） | chat/bottom、chat-rename/dialog | chat-header | ✓ |
| 27 | 花费药丸和提示 | chat-header/cost-tip | stream-cost、usage-header | ✓ |
| 28 | 额度圆环、药丸和弹层 | chat-header/quota-popover | quota | ✓ |
| 29 | 导出、当前对话、目标、已加载、面板开关 | chat-header/* | chat-header、export-inert、loaded | ✓ |
| 30 | 窄头部的"⋯"菜单 | chat-header/more-menu | chat-header | ✓ |
| 31 | 当前对话弹层（设置行、★ 默认、高级、防护、Full/Light、立即压缩） | chat-session-controls/*、live-extra/compact-queued-controls | controls、controls-help、session-defaults | ✓ |
| 32 | 目标对话框、目标栏、引导栏、提案卡片 | chat-goal-dialog/*、live-requests/goal-*、live-extra/guided-bar、goal-proposal* | goal*、guided-goal、guided-chip | ✓ |
| 33 | 已加载对话框 | chat-loaded/dialog | loaded、loaded-switches | ✓ |
| 34 | 对话记录的分页按钮、滚到底部、折叠的轮次 | chat/expanded-top、chat-states/scrolled-up | history-window、long-chat、chat-follow、turn-fold-reader | ✓ |
| 35 | 用户消息的操作、助手消息底部、分支切换 | chat-messages/*、chat-branches/sibling-nav | branch、edit-while-replying | ✓ |
| 36 | 思考、执行块、用量、附件、出错和重试、中断和继续、退出通知 | chat/thinking-open、live-extra/msg-*、exit-notice-*、composer-attach/chips | thinking、send-failure、turn-failed-tail、exit-cause、tool-interrupted | ✓ |
| 37 | 工具卡片（展开、原始、复制、全部显示、图片、子代理、计时、防护判定） | chat/edit-card*、live-extra/tool-* | tool-diff、tool-images、tool-timer、failed-tools、guard-conversation | ✓ |
| 38 | 输入框：斜杠、@、未知命令、幽灵文字、历史 | chat-composer/slash-menu、slash-unknown、mention-menu、new-chat/typed | chat-slash、mentions、ghost、chat-recall | ✓ |
| 39 | 附件、粘贴、拖放和 DropChoice | composer-attach/drop-choice、chips | drop-files、image-attach、new-chat-images | ✓ |
| 40 | 排队的消息和编辑弹层 | live-streaming/queued-chip、live-extra/queue-edit | queue、queue-edit | ✓ |
| 41 | 预设菜单（保存、默认、管理） | chat-composer/preset-picker、settings-dialogs/preset-name | presets、preset-edit | ✓ |
| 42 | 模型选择器（收藏、键盘） | chat-composer/model-picker | model-picker、favorites、model-love | ✓ |
| 43 | 思考级别 | chat-composer/thinking-select-closed | thinking-levels | ✓ |
| 44 | 权限选择器 | chat-composer/approval-picker | approval | ✓ |
| 45 | 无人值守开关和标记 | live-extra/unattended-on、unattended-chip | unattended | ✓ |
| 46 | 快速指令菜单（含软停止） | chat-composer/quick-prompts、live-extra/soft-stop-* | quick-prompts | ✓ |
| 47 | 发送、引导、暂停、停止及其状态 | live-streaming/* | pause、stop-confirm、stop-escalation、paused-controls | ✓ |
| 48 | 状态行 | chat/bottom | status-line、status-parity | ✓ |
| 49 | 输入框上方：待办条、任务、审批/提问/输入、待执行命令、停止确认 | live-requests/*、live-streaming/stop-confirm | todo-strip、ui-requests、ask-stepper、approval | ✓ |
| 50 | 横幅：暂停、重试/用量上限、软停止、压缩、排队压缩、额度暂停、防护不可用、防护未生效 | live-streaming/paused、live-extra/retry-*、soft-stop-*、compaction-*、compact-queued-*、quota-hold-*、guard-* | retry-banner、compact-queue、compact-at、quota-floor、guard | ✓ |
| 51 | 面板框架：弹层或分栏、拖动宽度、上下分栏、标签拖放和菜单 | chat-panel/default、tab-menu | split-panel、panel-sheet、panel-column、resizable-panels、tab-strip | ✓ |
| 52 | 子代理标签页（列表、详情、引导、停止/继续） | chat-panel/tab-agents、live-streaming/panel-agents-running、live-extra/agent-detail-running、agents-wait-* | subagents-live、subagent-retry、agent-follow | ✓ |
| 53 | 待办标签页 | chat-panel/tab-todos、live-requests/panel-todos-live、todo-open | todo-edit | ✓ |
| 54 | 任务标签页 | chat-panel/tab-jobs | label-in-name、chat-follow | ✓ |
| 55 | 文件标签页（树、过滤、隐藏文件、传输、拖入上传、预览） | chat-panel-files/tree、transfer、preview | files-tab、files-transfer、drop-guard | ✓ |
| 56 | 改动和 diff | chat-panel-files/changes | changes-tab | ✓ |
| 57 | Issues（列表和单个 issue） | chat-panel/tab-issues（隔离环境里没有 gh 登录，显示的是对应的状态；列表和单个 issue 只由规格验证） | issues-tab（模拟 GitHub） | ✓ |
| 58 | 信息 | chat-panel/tab-info | scroll-focus | ✓ |
| 59 | 分支 | chat-panel/tab-tree | branch | ✓ |
| 60 | Ask（顺便问） | chat-panel/tab-btw | btw-model | ✓ |
| 61 | 本机 | chat-panel/tab-host | host-load | ✓ |
| 62 | 终端 | chat-panel/tab-terminal | shell-tab | ✓ |
| 63 | 指引 | chat-panel/tab-guidance | model-guidance | ✓ |
| 64 | 提问 | chat-panel/tab-questions | ask-stepper | ✓ |
| 65 | 工作树 | chat-panel/tab-worktrees | worktrees-tab | ✓ |
| 66 | 大视图（文件、diff）和编辑器 | chat-panel-files/big-view、big-editor | file-edit | ✓ |
| 67 | 子代理全屏和切换菜单 | subagent-full/window、switcher | subagent-full | ✓ |
| 68 | 子代理弹出窗口 | 和第 67 项是同一个组件的 popOut 模式，弹出窗口本身没有截图（只由规格验证） | subagent-full（"a window popped out for a subagent…"） | ✓ |
| 69 | 代理关系图（列表、画布、缩放、详情） | agents-page/index、graph、detail | agent-graph | ✓ |
| 70 | 用量页 | usage-page/* | usage-chart、usage-range、usage-tables、usage-sessions、usage-timezone | ✓ |
| 71 | 记忆页（过滤、列表、详情、添加和删除对话框、远程/无/出错） | memory-page/default、empty-world/memory、remote-page/memory | memory（含添加和删除对话框） | ✓ |
| 72–74 | 防护页：决定、策略、基准测试 | guard-page/decisions、policy、bench | guard-page | ✓ |
| 75 | 提问页 | questions-page/open、done | ask-stepper、unattended | ✓ |
| 76 | 命令页 | cli-page/* | cli-disclosure、cli-phone、terminal-theme | ✓ |
| 77 | 设置框架和搜索 | settings-*/top、settings-search/* | settings-nav、settings-focus | ✓ |
| 78–81 | 设置 › 外观（主题、配色、排列、语言、快捷键） | settings-look/*、settings-dialogs/shortcut-record | theme、palettes、nav-layout、shortcuts、i18n | ✓ |
| 82–87 | 设置 › 对话（对话、快速指令、压缩、拖放、项目文件夹、推送） | settings-chats/* | quick-prompts、compact-at、projects-folder、push-settings、settings-usage-wait | ✓ |
| 88–92 | 设置 › 模型（模式、本地服务器、账户、角色和预设、指引、额度下限） | settings-models/*、settings-dialogs/guidance-editor、preset-name | accounts、presets、model-guidance、quota-floor、offline | ✓ |
| 93–95 | 设置 › 安全（权限、防护、无人值守） | settings-safety/* | approval、guard、unattended | ✓ |
| 96–103 | 设置 › 应用（omp、更新、退出、睡眠、远程、迁移、反馈、配置和进程） | settings-app/* | omp-update、app-update、quit-settings、sleep-note、remote*、migrate*、feedback | ✓ |
| 104 | 命令面板 | palette/* | palette-*、search-* | ✓ |
| 105 | 反馈对话框 | feedback/form、preview | feedback | ✓ |
| 106 | Toast | live-requests/toasts、live-extra/toast-* | toasts、toast-long、toast-dialog | ✓ |
| 107 | omp 更新和兼容性通知 | omp-update-notice/update-available | omp-update | ✓ |
| 108 | 更新和远程指示器 | sidebar/list | app-update、remote | ✓ |
| 109 | 主机弹层 | sidebar-host/popover | host-load | ✓ |
| 110 | 键盘快捷键（每一行） | settings-look/part3–5、settings-dialogs/shortcut-record | shortcuts、shortcut-hints、subagent-full（Option 键） | ✓ |
| 111 | 未安装 omp 或 omp 损坏 | omp-missing/first-run | omp-install、omp-killed | ✓ |
| 112 | 首次设置向导 | onboarding/step-* | first-run、omp-install | ✓ |
| 113 | 解锁页 | unlock/empty、invalid | auth | ✓ |
| 114 | 远程页面的受限版本 | remote-page/* | remote、remote-flow、remote-confirm | ✓ |
| 115 | 断线、本地模型 | disconnected/offline、settings-models/part1 | dead-connection、offline | ✓ |
| 116 | 亮暗主题 × 配色 × 语言 | 所有截图（默认配色，亮暗、中英文）；五种配色的对比度由测试覆盖 | palettes、theme、contrast、warning-contrast、terminal-theme | ✓ |
| 117 | 手机布局（抽屉、面板弹层、紧凑头部、窄输入框等） | 所有手机截图 | phone-layout、phone-fit-chat、phone-fit-settings、panel-sheet、mobile、touch | ✓ |

## 7. 验证

- `bun run typecheck`：通过。`bun run lint`：通过，biome 有 5 条警告，都是原来就有的。
- 单元和契约测试（`OMPW_E2E_OFFLINE=1 bun run test:all`）：6235 个通过，21 个跳过（需要真实模型），1 个失败。失败的是 `tests/contract/quota-floor.test.ts` 的 "three conversations held on one provider…"，这个测试对时间很敏感（`pollUntil` 15 秒）：在全套并行、机器负载高时失败；单独跑时，修复后的分支 4/4 通过，基线也是 4/4 通过；基线的全套并行这一次也是 0 失败。这次没有改动 `server/` 和 `shared/`，所以判断是负载导致的偶发失败，已开 #734。
- e2e 全套（`OMPW_E2E_OFFLINE=1`，6 个 worker）：1931 个通过，54 个跳过，3 个失败。三个都在单独重跑时通过：`guard-page.spec.ts:414` 是原来就有的偶发失败，在基线上重复 8 次失败了 2 次，已开 #733；`chat-follow.spec.ts`（iPhone 15，一次一帧）和 `render-isolation.spec.ts:205` 各重复 4 次，全部通过。这次新增和改动的规格在修复后全部通过，在基线上会失败（见 §3）。
- 修复后的 harness：所有界面在 12 种组合下都跑通（`coverage-*-pass3/4.json`）。

## 8. 复现

本机运行：`bun run build`，然后执行 `bun .tmp/audit/run.ts [界面正则] [组合正则]`；`live.ts`、`live-extra.ts`、`special.ts` 用法相同。面板相关的步骤要加 `SERIAL=1`。截图输出到 `.tmp/audit/out/shots/`，检查结果输出到 `.tmp/audit/out/findings/`。`.tmp/` 不提交。

## 9. 0.12.0 复查（2026-10-29）

**范围。** HEAD `a1fad73a`（v0.11.20 之后 19 个提交：§4 各区提交 `0fbee06b` 设置、`6a4eb325` 侧边栏、`6d4fe4d3` 输入框、`dbb49d84` 对话、`610eba39` 面板、`14991b2e` 页面、`59dab095` 首次运行、`50c031d6` 代理关系图 #736，以及防护/用量的几处修复）。`bun run build` 之后，`run.ts`（面板步骤加 `SERIAL=1`）、`live.ts`、`live-extra.ts`、`special.ts` 和新加的 `graph.ts` 在 12 种组合（桌面、宽屏、手机 × 中英文 × 亮暗）下全部重跑，每个步骤都在 12 种组合下走通（有几个步骤改过 harness 后单独补跑）。上一轮结果保留在 `.tmp/audit/out-0.11.20/`。

**规模。** 2798 张截图、49 个界面、247 个状态（上一轮 2560 / 48 / 224）；新增状态包括 ⋯ 面板（输入框，手机）、拆分 Stop 菜单、`toast-many`、`untitled-row`、手机命令列表展开、代理图的 12 个状态（293 个子代理）。

**自动检查结果（和上一轮比）。**
- 原始 i18n key：0（上一轮 0）。文字被裁、被祖先元素裁掉、整页横向滚动：0（上一轮 0）。
- axe：只剩 `aria-hidden-focus` 100 个状态（Radix 模态菜单，A1，上一轮 88；多出的 12 个是新加的子代理 Stop 菜单状态）、`document-title`/`html-has-lang` 各 4 个（手机上 `rail/not-applicable-drawer` 的空白页，§5 已解释）。`color-contrast` 为 0（上一轮残留 11 个）。这一轮给 harness 的 `check()` 加了"1.5 秒后重查"：对比度和可滚动区域的报警只有在动画结束后仍在才算（第一遍里有 3 个对比度和 2 个 `scrollable-region-focusable` 是 `fade-in` 动画或刚填满的框，重查后消失：`live-streaming/queued-chip`、`onboarding/step-account--wide-zh-CN-light`、`live-streaming/streaming--desktop-en-light`、`chat-messages/msg-usage-tip` 手机）。
- HTTP / 控制台：类别和 §5 一样（假 omp 的 `/api/model-config` 500、`chat-states/load-error` 的 404、解锁页的 401、`msg-unrenderable` 故意触发的 React 错误），只多一个：`agents-page/untitled-row` 故意打开一个不存在的文件，`/api/subagents` 404。
- 中文页面里的英文：新增的候选全是假 omp 编出来的词、夹在输出里的终端/命令帮助文字、harness 自己输入的文字和工具名（read/edit/bash），没有新的界面漏译；S13 的内置指引模板、"智能体" 这两类旧问题已消失。
- `offscreen`：新增的条目都在可横向滚动的容器里（设置页的标签条、手机面板的标签条、代理图画布、代码块），属于 S1/P1 的新设计，不是问题。

**人工看过的。** 5 路评审分区看了全部 §4 条目的新旧对照（`.tmp/audit/pairs.ts` 拼的前后图，手机英文亮色 + 手机中文暗色为主，桌面英文暗色 + 宽屏中文亮色补充），我自己又逐一看了：手机输入框 ⋯ 面板（英/中）、防护眼睛图标与权限盾牌、桌面和手机的 toast（底部，最多两条）、中文时长、拆分 Stop、重试卡片、P1 手机面板标签、P5 运行数、G1 "Untitled · 时间"、293 个子代理的代理图、设置页手机端边缘渐隐、引导最后一步没有"跳过"、解锁错误。结论见 §4 的状态表：除下面几项外，每一项在新截图里都看得到修复。

**harness 的改动（`.tmp/audit/`，未提交的脚手架）。** `run.ts`：⋯ 面板辅助函数 `composerControl`/`shotMorePanel`（手机上经 ⋯ 打开思考、防护、指引、Full/Light、目标、快捷指令），新状态 `more-panel`、`untitled-row`、`commands-open`、`after-esc-1|2`，目录浏览器、侧边栏、用量提示等步骤跟着新界面调整，`FULL=1` 打印完整错误；`live.ts`：`panel-agents-running` 手机也拍，用 `right-panel-close` 关面板；`live-extra.ts`：软停止经 ⋯ 面板选快捷指令，新状态 `agents-wait-stop-menu`、`toast-many`；`graph.ts`（新）：293 个子代理的代理图；`lib.ts`：对比度/可滚动报警的重查；`compare.ts`、`pairs.ts`、`stats.ts`（新）：新旧结果对比、前后图、统计。

**复查发现的、还没处理的问题（都不影响功能；产品代码这一轮没有改）。**
1. **C1（部分）**：对话页手机的 ⋯ 面板里，快捷指令按钮只有 ⚡ 图标，没有文字（`chat-composer/more-panel--phone-en-light|zh-CN-dark`，`QuickPromptMenu.tsx` 只给了 `title`/`aria-label`）；新对话页的 ⋯ 面板里 "Low"、"Full" 只写了值，没写是哪个设置。真问题，小。
2. **C3（部分）**：目录浏览器一打开路径框就有焦点，`DirBrowser.tsx:51` 在有焦点时不滚到末尾，所以仍只显示 "/private/var/folders/…"（`new-chat-folder/dir-browser--*`）；规格先把焦点移走再量，所以通过。真问题，小。
3. **N1（部分）**：纯模糊匹配的行（"Draft the changelog"）仍散落高亮（`sidebar/filtered--phone-en-light`）。**S8（部分）**：中文"主题"仍只 1 条、英文 "theme" 仍有 3 条无关结果。**S10（部分）**：`settings-dialogs/shortcut-record--wide-zh-CN-light` 的高亮仍落后一张卡。**V17（部分）**：1280 宽并打开面板时输入框底栏仍折行（`chat-panel/default--desktop-en-dark|zh-CN-light`，中文下 ☾ 单独占一行）。
4. **代理图，手机，打开详情时**（`agents-page/detail--phone-en-light|zh-CN-dark`）：#736 新加的状态/时间过滤条被右边的详情栏压住，"Failed" 芯片被切、"Today" 撞上分隔线、搜索框只剩 "Find by"。真问题，小，只在手机。
5. **代理图，手机，聚焦+缩略图**（`agents-graph-many/focus-minimap--phone-*`）：缩略图约 190×130 盖住画布近一半。可用性问题，小。（聚焦在干净的画布上能同时框住主代理和运行中的子代理；先开"网格排列"、搜索过再聚焦，画布不重新定位，`focus-with-grid--desktop|phone-*`，很可能是"人移动过视图就不再自动定位"的设计，没有当 bug。）
6. **V14 的尾巴**：手机上目标提案出错后再点"要求修改"，固定在底部的错误+按钮栏盖住表单的发送行（`live-extra/goal-proposal-changes--phone-en-light|zh-CN-dark`，滚动能看到）。小。
7. **V17 的副作用**：手机英文一行状态行把分支截成 "m…"、模型截成 "Claude Opus…"（`live-extra/retry-backoff--phone-en-light` 等；中文放得下）。小。
8. **手机上从 ⋯ 面板选了快捷指令后，面板留在输入框上方**（`live-extra/soft-stop-line--phone-en-light|zh-CN-dark`）。规格只说"面板里打开的选择器保持面板"，选完一条会发送的快捷指令后不关面板是否有意，待定。小。
9. **G5 的尾巴**：记忆关闭时"添加记忆"仍是淡色按钮；空状态的命令框在手机上离屏幕边缘只有约 4px（`empty-world/memory--phone-en-light`）。**S1 的小毛病**：手机标签条的 ‹ › 箭头画在被渐隐的半个标签上（"‹ls & accounts"），只是观感。

以上没有一项是"没修"；它们是修复留下的尾巴或新界面带来的小问题，是否追加修复由你定。这 9 项后来都在 `0f20eeba` 处理，确认结果见 §9.1。

### 9.1 确认复查：`0f20eeba`（2026-10-29）

**范围。** HEAD `a46512ec`（`0f20eeba` 之后只改了 README 和发布说明）。用现成的 `bun run build` 产物（`dist/web` 里已有 `0f20eeba` 新加的 `mode.chipPrefix`、`panel.thinkingPrefix`），设 `AUDIT_OUT=out-0.12.0-confirm`，在 12 种组合（桌面、宽屏、手机 × 中英文 × 亮暗）下重跑 `0f20eeba` 涉及的界面：`run.ts`（`SERIAL=1`）的 `chat-composer`、`new-chat-pickers`、`new-chat-folder`、`agents-page`、`memory-page`、`sidebar`、`settings-look|chats|models|safety|app`、`settings-search`、`settings-dialogs`，`SERIAL=1 run.ts chat-panel`，整个 `live-extra.ts`，`graph.ts`，`special.ts empty-world`。每个步骤在 12 种组合下都走通，没有 FAILED 截图。结果在 `.tmp/audit/out-0.12.0-confirm/`：1698 张截图、17 个界面、152 个状态，和上一轮这 17 个界面的状态一一对应。对比基准是 `.tmp/audit/out-0.12.0-pre/` 里同样 17 个界面（`compare.ts` 输出到 `out-0.12.0-confirm/compare.md`）。

**自动检查（括号里是上一轮同样 17 个界面的数字）。**
- 原始 i18n key：0（0）。文字被裁、整页横向滚动：0（0）。`offscreen`：266（266），仍然都是可以横向滚动的标签条、画布和代码块。`color-contrast`：0。
- axe：`aria-hidden-focus` 100 个状态（100，属于 A1）。`new-chat-pickers/approval-picker` 报警节点的选择器变了，所以 compare 里一条算新增、一条算消失，类别没变。**新增 `label-content-name-mismatch` 10 个**：`new-chat-pickers` 的 `more-panel`、`thinking-picker-closed`、`guidance-picker`、`guard-picker`、`goal-mode-on`，每个状态在 `phone-en-light|phone-en-dark` 各一个。这是真问题，由 `0f20eeba` 引入：New chat 的 ⋯ 面板里，模式按钮显示 "Mode: Full"，`aria-label` 却是 "Full or Light for new conversations"，"Mode:" 不在可访问名称里。原因是 `ModePicker.tsx:50` 的前缀 `<span>` 没有 `aria-hidden`，而思考强度的前缀（`ModelPicker.tsx:319`）有。读屏不受影响，但用语音控制说 "Mode Full" 可能点不到。问题小，改一行就行；这一轮没有改产品代码。
- HTTP / 控制台：280 个状态，类别和次数都和上一轮一样：假 omp 的 `/api/model-config` 500（`live-extra` 1328 次，`agents-graph-many` 72 次），`agents-page/untitled-row` 的 `/api/subagents` 404（12 次），`msg-unrenderable` 故意触发的 React #31（12 次）。compare 里 `live-extra` 的"新增"都是这条 500，只是 URL 里的临时目录名每次运行都不同。
- 中文页面里的英文：639 条（634）。多出来的都不是漏译：手机中文的 `soft-stop-line` 现在拍到了已发送的 "Soft stop: wrap up now…" 引导芯片（⋯ 面板选完就关，芯片才露出来；这段文字是 `shared/quick-prompts.ts` 里发给模型的内置快捷指令正文，0.11.20 起在桌面、宽屏和 `soft-stop-exit` 里就被报过），还有斜杠菜单里 omp 自己的命令说明、模型选择器里的模型 id。

**人工确认（全部修好）。** 每项的截图写在 §4 表的「确认」里：S8、S10、N1、C1、C3、V17、G5；另外还有 V14 的尾巴（"要求修改"的表单在固定栏上方）、手机状态行（模型名完整，分支缩成图标）、从 ⋯ 面板选了快捷指令后面板关闭、设置标签条的箭头在纯色底上、手机上代理图详情旁边的工具条、缩略图大小、搜索和网格之后再聚焦会重新定位。上面 1–9 项全部处理。

**还剩的小问题（已在 `a1f960dd` 处理）。**
1. `label-content-name-mismatch`（New chat 手机 ⋯ 面板里的 "Mode: Full"）：前缀 "Mode:" 加了 `aria-hidden`，和 "Thinking:" 一样只给眼睛看，按钮的名称本来就说了是哪个设置。
2. 手机上代理图打开详情时（`agents-page/detail--phone-en-light|zh-CN-dark`），过滤、两个开关和图例占了左半栏大部分高度：现在列宽不到 640px 或打开详情时，它们收进一个带计数的「过滤」按钮，工具条从约 400px 降到约 115px，画布占了大部分高度（`agent-graph.spec.ts` 手机两条；截图 `.tmp/audit/out-0.12.0-fix/shots/agents-page/detail--phone-*`）。
3. 没有记忆存储时，标题和黄色提示说的不一致：现在每种状态只说一件事，"没在用这个存储"的提示只在存储存在时出现，禁用的「添加记忆」下面写明原因（`memory.spec.ts` 新增各状态的测试；截图 `.tmp/audit/out-0.12.0-fix/shots/empty-world/memory--phone-en-light.png`、`memory-page/default--*`）。

**harness。** `lib.ts` 的输出目录可以用 `AUDIT_OUT` 指定（默认仍是 `out/`）。这次确认复查写到 `out-0.12.0-confirm/`，不和别的运行共用 `out/`；各个步骤的脚本没有改。

### 9.2 最终复查：§9.1 之后改过的界面（2026-10-30）

**范围。** HEAD `5b2bef21`（v0.12.0）。§9.1 之后改过、还没重拍的界面：防护确认卡片里审查模型拒绝（#753）和审查模型不可用（#764）的说明块；"审查模型拒绝时问我"开关（设置 › 安全、对话自己的防护面板，#747）；输入框 ⋯ 面板（Esc，#755，外观没变，也拍）；代理图工具条（搜索框位置 #761）、卡片上的 `agent://all` 喇叭标记和计数（#756）、Tab 顺序（#759）；toast 堆叠（最多 2 条 + 排队，错误 toast 留着，#757）；侧边栏标题和 favicon 的新图标（#781）。全部在隔离的测试服务器上跑（自己的 HOME/agent 目录、假 omp），没碰 `~/.omp`。

**命令。** `bun run build` 之后，`AUDIT_OUT=out-0.12.0-final`：
- `SERIAL=1 bun run.ts '^(guard-reviewer|app-icon|chat-composer|new-chat-pickers|agents-page|sidebar|settings-safety|chat-session-controls)$'`
- `bun live-extra.ts '^(risk|moreesc|toasts|guard|verdicts|softstop)$'`
- `bun graph.ts`
- `bun live.ts '^live-requests$'`

日志在 `.tmp/audit/logs/final-*.log`，对比在 `out-0.12.0-final/compare-vs-confirm.md`（对 §9.1）和 `compare-vs-pre.md`，每个状态 12 种组合的拼图在 `out-0.12.0-final/sheets12/`。

**规模。** 11 个界面、95 个状态、1096 张截图，每个状态 12 种组合（桌面、宽屏、手机 × 中英文 × 亮暗）。例外：`live-extra` 的 ⋯ 面板两个状态只有手机有 ⋯ 面板（各 4 张，桌面和宽屏拍 `more-streaming-no-panel` 8 张）；`agents-graph-many/card-collapsed` 手机 4 种组合失败（见下面 #786），只有 8 张加 4 张 FAILED 截图。

**harness 的改动（`.tmp/audit/`，未提交的脚手架）。** `run.ts`：新步骤 `guard-reviewer`（经 `POST /api/guard` 选审查模型；设置 › 安全的卡片开/关；对话面板的防护和自己的"在这里设置"；新对话的防护选择器及滚动后；最后恢复关闭）和 `app-icon`（侧边栏标题、图标放大、favicon/各尺寸图标拼板）。`live-extra.ts`：新步骤 `risk`（用 `riskTitle` 帧拍 `risk-plain`、`risk-denied`、`risk-denied-no-reason`、`risk-unavailable`、`risk-unavailable-no-reason`）和 `moreesc`（流式输出时的 ⋯ 面板和按 Esc 之后），toast 步骤加 `toast-burst-errors-first|come-up|last`（#757）。`graph.ts`：种入 `agent://all` 写入（第 0 个调用的 scout、Runner 两次、主代理），`overview` 等标记出现再拍，新状态 `search-folded-detail`、`small-broadcast`、`small-tab-order`、`small-detail`（每种组合一个小的 "Graph probe" 对话），`FULL=1` 打印完整错误，`PROBE=1` 在 `card-collapsed` 打印折叠按钮中心的命中测试。

**自动检查（1072 个 findings 文件）。**
- 原始 i18n key：0。文字被裁、被祖先裁掉、整页横向滚动：0。`color-contrast`：0。
- axe：`aria-hidden-focus` 80 个（Radix 模态菜单，A1，和以前一样）；`label-content-name-mismatch` 14 个，全部是手机英文 New chat ⋯ 面板里的 "Mode: Full"（`new-chat-pickers` 10 个、`guard-reviewer` 的选择器状态 4 个）：`a1f960dd` 给前缀加了 `aria-hidden`，axe 仍算它是可见文字，没有消掉（#788）。
- HTTP / 控制台：只有假 omp 的 `/api/model-config` 500（624 次）和 `agents-page/untitled-row` 故意打开不存在文件的 404（12 次）。
- `offscreen`：166 条 / 150 个状态，都是可横向滚动的标签条、代理图画布和手机上隐藏的计数 span，和以前同类。
- 中文页面里的英文：新增的都是假 omp 和 harness 的内容（代理图里的工具调用 `write: agent://all`、"Fixture …" 标题、命令和路径），没有新的界面漏译。

**逐个界面（每张拼图我都看过）。**

| 界面 | 状态 × 组合 | 结果 |
|---|---|---|
| 防护确认卡片：审查拒绝 / 不可用（#753、#764） | `live-extra/risk-*` 5 × 12 | 拒绝和不可用的说明块、理由、无理由的写法 12/12 都对、中英文都译了。**缺陷**：每张卡都写着"远程页面在驱动这一轮，设置 › 远程访问会在运行前询问"，防护自己的询问（问我 / 审查拒绝 / 不可用）在本地页面上也这么写；手机英文的拒绝卡片因此到了高度上限，"Cancel" 被卡片底边切掉（`risk-denied--phone-en-*`）。→ **#785** |
| "审查模型拒绝时问我"（#747） | `guard-reviewer/*` 6 × 12 | 设置卡片、对话面板、新对话选择器 12/12 排版正常、中英文都有。**缺陷**：亮色主题下关着的开关几乎看不见（轨道 1.20:1、边 1.31:1，低于 WCAG 1.4.11 的 3:1；所有 `Switch` 都这样，暗色主题白色圆点仍可见）。→ **#787** |
| 输入框 ⋯ 面板（#755） | `live-extra/more-*`、`chat-composer`、`new-chat-pickers` | 外观没变，流式时打开、按 Esc 后都正常。手机英文 "Mode: Full" 的 label-in-name 见 #788。 |
| 代理图工具条、`agent://all` 标记、Tab 顺序（#756、#759、#761） | `agents-graph-many` 17 × 12、`agents-page` 4 × 12 | 搜索框位置、折叠的过滤、喇叭标记和计数、Tab 顺序 12/12 正常。**缺陷**：手机上打开一个批次后，"折叠" 按钮被批次第一张子代理卡片盖住，点不到（命中测试：手机 4×4 px，顶层元素是 `Team00Scout00`；桌面 6×6、宽屏 9×9 能点但远小于 24×24）。由 `dd93ede1` 的绘制顺序引入。→ **#786**。手机打开详情时 tokens/费用/时间三栏挤在一起、时长折行（§9.1 时已有）→ **#789** |
| toast 堆叠（#757） | `live-extra/toast-*` 7 × 12、`live-requests/toasts` | 最多 2 条可见、其余排队、错误 toast 不自动消失，12/12 正常。 |
| 新图标（#781） | `app-icon` 3 × 12、`sidebar` 10 × 12 | 侧边栏标题的图标在亮暗两种底色上清楚、没有裁切，favicon 和各尺寸 12/12 正常。 |
| 其余一起拍的界面 | `settings-safety`、`chat-session-controls`、`live-requests` 的审批/确认/提问/目标/待办 | 12/12 正常，没有新问题。 |

**没开 issue 的观察。** 亮色主题下信息 toast 和错误 toast 的图标颜色几乎一样（都是偏红的强调色）；中文 "思考强度： 低" 冒号后多一个空格的间距；手机上小代理图适配后卡片和标记很小（放大即可）；防护确认卡片里命令前的 "Command:" 在中文界面也是英文（这段文字是服务器在 `shared/remote-risk.ts` 里写的调用说明，和命令本身一起原样显示，没判断是不是有意）。

**结论。** 6 处改动都在 12 种组合下重拍并看过；新开 5 个 issue：#785（防护卡片的远程说明）、#786（代理图折叠按钮被盖住）、#787（关着的开关对比度）、#788（Mode 按钮 label-in-name）、#789（手机代理图详情的统计栏），标题前缀都是 "0.12.1:"。产品代码这一轮没有改。
