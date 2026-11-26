# Agent 视图前端约定（桌面端）

> 范围：`src/views/agent/` 的错误处理、自动续跑、假完成检测、拖拽选择保护，以及同目录多会话并行的前台状态模型。

---

## 前端错误处理（Agent 视图，`src/views/agent/`）

- **统一提取**：所有服务端错误（API invoke 抛错、SSE 事件内嵌 error）先用 `error.js` 的 `getErrorMessage()` 提取可读文本（兼容 string / Error / `{"error":{"message","type"}}` / 其它对象），再用 `classifyError()` 分类（quota/timeout/network/not_found/cancel/unknown）。
- **统一展示入口**：错误统一走 `ui.js` 的 `reportError(err, { prefix, hint })`，内部自动提取+分类：quota（401/余额/授权）类直接显示"余额不足，任务中断"，其余显示原始错误；三档 UI 为 `showNotice(msg, level)`（error 红 / warn 黄 / info 灰），消息区节点 3s 自动消失，`showError/showWarning/showInfo` 是薄封装。
- **禁止** `showError("前缀: " + e)` 直接拼接错误对象（对象会显示 `[object Object]`）；应把**原始错误**传给 `reportError(e, { prefix })`。本地状态提示（无服务端错误对象，如"文件过大"、轮数上限）才直接用 `showError/showWarning` 字符串。
- **SSE 错误路径**：`run_complete` / `agent_event` 内嵌 error 均走 `reportError`，不要在 sse.js 里自行实现 formatRunError/isQuotaError（已在统一模块）。
- **模型不支持关闭思考**（`error.js` 的 `ERROR_THINKING_UNSUPPORTED`）：provider 同时拒绝 `reasoning_effort:none` 与 `thinking.disabled` 时，admAgent 返回 400，文案以 **`thinking_mode_unsupported`** 开头（前后端契约 token，`internal/llm/client.go` 产出、`client_test.go` 锁定，改文案须保留）。桌面端按该 token 分类（早于 network 匹配——被包裹的 provider 原文含 "Upstream request failed"），提示"本模型不支持关闭思考，请切回思考模式"并**中断本轮**；既不自动恢复默认档，也不静默去掉参数继续跑。
- **假完成/静默停止检测**（`sse.js` `detectFakeCompletion`）：本轮有 edit/write/multiedit/bash/lsp 等副作用工具调用、但工具调用总数 ≤4、且 prompt 含操作动词（部署/修复/重构…）时，`showWarning` 提示"任务可能未完整执行"（服务端重试耗尽后 run_complete 无 error 静默结束的兜底）。
- **任务清单未完成提示**（`sse.js` run_complete 收尾）：`action.kind === "ok"` 且 `run_complete.incomplete_todos > 0` 时弹常驻 `showNotice(..., "warn", true)`「任务清单还有 N 项未完成，本轮已结束；可发送"继续"让模型收尾」。`todos` 面板按会话快照渲染（`renderTodos`），服务端未回写完成态时面板就是 0/N——这类"终稿说做完了、清单还全没勾"的矛盾必须靠该提示暴露，不要在前端按终稿正文自动把清单改成完成。清单是会话累积的，旧清单未清掉时后续每轮都会再次触发，提示节点用 `todosNoticeEl` 复用改写文案（节点被 `clearErrorNotices` 清掉后自动重建），否则每轮会叠一条相同黄条。
- **自动续跑进度判定**（`autocontinue.js` `maybeAutoContinue(data, runStats)`）：本轮有 edit/write/bash 等实质副作用工具**成功落地**（`runStats.sideEffectSuccess > 0`）视为有进展、不计无进展，避免"模型在干活但没标 todos"被误熔断。
- **工具卡状态跟随结果**（`render.js` 的 `toolStatusSuffix`）：`is_error` 的 tool_result 到达后摘要显示「(失败)」并标红，而不是「(已完成)」。旧版只看 `finished`，于是被 `stale_read` 守卫拒绝的编辑卡片写着"已完成"、正文却是红色错误，用户只能自己判断哪一半是真的。

## 运行态交互约定

- **同目录多会话并行**（桌面端，`agent_concurrent_sessions` **默认关**，需在 Agent 设置→基础设置里手动开启；并发上限 3）：服务端运行态本就按会话隔离（`activeRequests`/`messageQueue`/`cancelMark`/`sessionMu` 均以 sessionID 为键），并行无需服务端改动，由桌面端状态模型与开关控制。`store.js` 按会话登记运行：`runs`（sessionId→活动运行）、`queued`（sessionId→排队轮次数组，FIFO）；`S.activeRun`/`S.queuedRun`/`S.runStats` 是 `currentConvId` 的**派生视图**（沿用旧语义=「当前打开会话的运行」），`S.isSending`=「本工作区有任一运行在飞」，`S.runs` 供会话列表/状态栏标识（workspace 状态池快照会带上 `runs`，切回工作区即恢复）。`run_complete` 只注销发起它的会话（`store.handleSSEEvent` → `completeRun(wsId, sessionId, runId)`，run_id 不匹配= 迟到的旧事件直接丢弃，避免误清新一轮），非当前会话的完成只刷新列表（`sse.js` 用处理前快照 `ctx.prevRuns` 判定归属）。开关与上限在**附件/PDF 转换之前**判定（否则已转换的 PDF 批次会被静默丢弃）；关闭时其它会话运行期间拒绝新会话发送（旧的"跨会话排队"是客户端假象——服务端早就并发跑了）；同会话内不可折叠的轮次（决策轮/分批发送）仍登记为 `queued`。写冲突护栏：`edit`/`write` 的读后写守卫跨会话天然生效（mtime > 本会话 lastRead 即要求重读），撤销入口在并行运行期间被前端拦下（服务端 undo 是整仓库回滚）。服务端侧防护已落地（admAgent：`SessionAgent.ActiveSessionIDs` + `coordinator.Undo` 并发拒绝、`internal/agent/tools/filelock.go` 按路径写锁、`filetracker.RecordWrite/LastWriteBy` + 写前跨会话提示），详见 `doc/admAgent-parallel-sessions-file-guards.md`；admAgent 改动需重编译推送 sidecar 才在 ADM 生效。

### 新增服务端接口入口（ADMX 0.8.4 / sidecar 包名 0.4.7）

- **Bang shell**：用户输入 `!command` 直调 `POST /agent/sessions/{sid}/shell`，以会话消息显示命令、输出和退出码；若工作区任一会话正在运行，则拒绝执行以避免并行文件写。`!!` 前缀继续作为普通 Agent 提示。
- **排队提示**：同会话消息排队后查询 `/prompts/queued` + `/prompts/list`；服务端 run queue 已实现时才返回实际排队列表，UI 不应把“已发送”误写成“排队”。
- **会话数据 tab**：在侧栏会话页签读取当前会话 filetracker/read-files 与历史快照，并读取工作区用户消息；“记录已读”按钮按快照文件路径调用 `/filetracker/read`。用户消息列表是工作区范围，不是当前会话范围。
- **退出时回收 client**：`DELETE /clients/{client_id}` 只在应用真正退出的 Rust `kill_agent_session` 生命周期调用。Agent 视图切换到设置/技能页会触发 `unmount`，不等于应用退出，不得在那里回收。
- **MCP/LSP runtime controls**：工具面板按钮调用 MCP refresh/read/get-prompt/docker 与 LSP stop/restart/diagnostics。Managed LSP catalog/doctor/jobs 为 sidecar v0.4.7 扩展路由；安装/修复先取 plan，再明确显示服务版本/来源/许可证并由用户确认后发送 `confirm:true`；卸载和任务取消同样二次确认。不要在面板加载或后台刷新时自动安装、修复、卸载或取消。
- **边界**：`/v1/analytics/events` 不由 ADMX 上报；hooks 是 sidecar 内部 hooks，不存在 `/v1/hooks` 端点；`/v1/models*` 当前由桌面 Rust 模型管理链路处理，不调用 sidecar TUI/CLI 模型路由。
- **左侧栏 = 工作区分组树**（`agent/ws_tree.js`，2026-11 起替代旧的「工作目录下拉 + 平铺会话列表」）：结构为 `工作区 <计数> [＋添加目录]` 头部 + 可折叠工作区行（彩色首字母头像，悬停 `＋`新建会话 / `🗑`清除全部(仅激活) / `✕`移除(非默认)）+ 嵌套缩进的会话行（状态点：运行中绿点脉冲 > 排队黄点 > 当前会话蓝点 > 灰点；每组默认展开前 `PREVIEW_COUNT=8` 条，超出折叠为「还有 N 个」）。关键约定：
  - `renderConversationList()` 已变为**兼容入口**（委托 `ws_tree.renderWorkspaceTree()`），切换工作区/会话增删/SSE 刷新的全部既有调用点不改；树自行从 `S.workdirs`（`fetchWorkdirs` 写入，`validateWorkDirs` 末尾刷新）+ 状态池快照派生，`updateWorkspaceSelector` 降级为 no-op。
  - **数据边界**：从未访问过的工作目录没有会话数据（服务端 workspace 未创建），展开显示「加载会话」入口，点击走 `doSwitchWorkDir`；**会话级操作（重命名/删除）只对激活工作区渲染**——API 路径取 `S.serverInfo.workspace_id`，对非激活池化快照调用会打到错误 workspace。点击嵌套会话/行内 `＋` 先 `ensureSwitched`（带防抖，避免快速连点重复 create_workspace）再执行。
  - `session.js ↔ ws_tree.js ↔ workspace.js` 存在 ESM 循环 import，全部是**运行时才解引用的活跃绑定**（模块顶层无调用），属有意为之；新增顶层调用前先想清楚求值顺序。
  - **目录右键菜单**：右键目录行（或聚焦后按 `Shift+F10` / 菜单键）显示真实目录路径与「打开文件夹」，经 Tauri `open_workdir_folder` 打开对应文件夹；不切换工作区、不创建会话。菜单位置限制在窗口内，Esc、Tab、点击外部、滚动、失焦、窗口缩放及视图卸载均清理菜单和监听；失败走 `reportError`。
  - **树刷新与可读性**：目录/会话行的操作按钮始终占位，仅改变透明度，避免悬停挤压标题；会话有缩进引导线和完整标题提示。按目录、会话标题、当前选择及运行态计算渲染签名，无变化保留 DOM，有变化保留树滚动位置及目录/会话行焦点。Enter/空格支持展开目录与选择会话。
  - **消息与输入区样式**：侧栏默认 272px，窄窗口 248px；消息轮容器、正文、输入区使用现有主题变量和一致圆角/留白，工具栏允许换行，系统减少动态效果偏好会缩短动画。
- **工具栏显隐必须随工作区切换重算**（`workspace.js` `switchToWorkspace` 末尾调 `updateSendButton()`）：后台 workspace 的 `run_complete` 只更新状态池、不走 UI 副作用（`sse.js` 按 active workspace 过滤），而「停止」按钮的显隐只由 `updateSendButton()` 维护。切换时不重算会沿用上一个工作区的按钮状态——任务早已结束「停止」仍常驻（点它 `cancelCurrentRun` 因 `activeRun` 为空直接返回，无副作用但误导），或切进正在运行的工作区却看不到停止按钮。
- **标题栏（`.chat-header` 的 `#agent-conv-title`）也必须随工作区切换重算**：`store.setActive` 只把目标 workspace 的 `currentConv` 恢复到状态池、不碰 DOM，切回已访问过的工作目录时标题栏会残留上一个工作区的会话名，与下方消息区（`renderMessages` 已按恢复的会话重绘）自相矛盾。`switchToWorkspace` 的非首次进入分支用 `syncConvTitle()` 按恢复后的 `currentConvId` 重写标题（会话列表里同 id 的项优先，服务器标题更新后以列表为准），并在 `loadConversations()` 之后再同步一次。**不能无条件写占位文案**：`currentConvId` 为空时 `loadConversations` 会自动选中/新建会话并自行写标题，抢先写「选择或创建一个会话」会把「新会话」冲掉——所以 `syncConvTitle` 在 `currentConvId` 为空时直接返回、不动 DOM。
- **底部状态栏统计**：工具调用 / 交互轮次仍按已加载的完整消息集合统计，口径不变；Store 现在在全量消息替换/恢复时重算，在新增、更新、删除单条消息时调整计数，`renderMessages` 只读取缓存计数并更新 DOM，避免流式期间每帧扫描整段历史。
- **每轮底部统计**（`render.js` + `round_metrics.js`）：每条 user 消息对应的 `.msg-round` 底部固定有 `.msg-round-stats`，折叠后仍显示发起、结束（记录）、耗时、Token（文本估算）、工具调用、模型交互；无 user 的前导轮不显示。去掉展开轮的 200px 最小高度，短回复随内容收缩；正文不被 flex 压缩，长内容在轮内滚动，统计栏位于正文之后且允许换行。
  - **时间口径**：发起时间来自该轮 user `created_at`（本地待发送气泡补客户端时间，正式消息到达后替换）；结束（记录）取本轮最后一条已保存回复的 `created_at` / `updated_at` 最大值，历史耗时为二者之差。兼容 Unix 秒、毫秒、ISO，缺少回复/无效时间显示 `—`；记录时间不冒充服务端精确运行结束时间。运行/排队期间显示「进行中/排队中」及含等待的实时耗时。
  - **Token 口径**：当前 Message / RunComplete 契约没有单轮 usage，不能用会话累计 `prompt_tokens` / `completion_tokens` 或 `context_tokens` 代替。仅对该轮保存的正文、推理、工具输入/结果和 shell 文本按 CJK≈1 token/字、其它≈4字符/token 估算，显式显示 `~` 和「文本估算」并附口径提示；不含反复发送的历史上下文、系统提示词、图片及供应商隐藏 token，**不代表实际计费用量**。临时/本地错误消息不计入；工具调用只数 `tool_call`，模型交互沿用 assistant 消息数。
- **增量更新**：轮级 Token 等指标继续按不可变消息对象用 WeakMap 缓存；会话级工具调用 / assistant 轮次计数改由 `store.js` 按消息变更增量维护，全量消息刷新时重算。每秒仅更新末轮统计节点，不重绘正文、不自动滚底，拖拽选区期间暂停 DOM 写入；运行结束、空消息、切会话或 `resetSelectGuard`（视图卸载）时停止计时器。
- **历史轮按需渲染**：折叠历史轮保留标题与轮级统计，卸载其中的消息 DOM（运行中的“正在工作”指示器保留）；标题点击或右侧大纲跳转时才用最新轮数据构建消息节点，右键折叠同样回收节点。该优化减少长会话常驻 DOM，但 `/messages` 仍按现有接口加载完整历史，不代表服务端分页已实现。
- **撤销入口挂在每个对话容器上**（`src/views/agent/undo.js` + `render.js` 的 `buildRoundNode`）：标题栏的那个「撤销上一轮对话」按钮已删除，改为每轮 `.msg-round-header` 右侧一个 `↶`（`.msg-round-undo`）——点它撤销**这一轮及其之后的所有轮次**（跨轮撤销）。服务端 `POST .../undo` 支持可选 `anchor`（该轮起始 user 消息 ID），桌面端**一次调用**带 anchor 完成跨轮回滚；不带 anchor 退回「只回滚最后一轮」（TUI `ctrl+b`）。成功后 `selectConversation` 重拉会话。特殊状态与文案约束：
  - **运行中置灰（不设 `disabled`）**：`S.activeRun`/`S.queuedRun`（本会话在跑或排队）与「同工作区其它会话在跑」都让按钮加 `.msg-round-undo-blocked` 置灰（服务端 undo 是整仓库回滚，会连带回滚别人的改动/提交）；置灰只是视觉提示，点击由 `undoToRound` 重新判定 `undoBlockReason()` 并 `showWarning` 给出原因。**不要改回 `btn.disabled`**：禁用态 `<button>` 收不到指针事件，`title` 不弹、点击也不触发，用户只会看到一个没有解释的死按钮；而且按钮状态只在消息渲染（`applyRoundState`）时重算，运行态在别处变化（如同工作区其它会话结束）时不重渲染，禁用态会一直留着，把入口锁死。**手动取消（停止）后按钮才恢复可用**——这是"发错提示词"的标准修复路径：停止 → 点该轮 `↶`。
  - **跨轮撤销的精度边界**：文件回退依赖服务端保留的**每轮快照**（`options.undo_checkpoints`，默认 10，上限 100；`internal/undo` 的 `DefaultMaxCheckpoints`），快照按整树还原，所以超出保留窗口的更早轮次只能回滚对话记录、文件改动可能残留；确认文案里明确写出这条，不要让用户以为文件一定回退了。多段告警用 `\n\n` 分段（`.permission-body` 已设 `white-space: pre-line`，否则挤成一段）。
  - **非 git 工作目录**：`undo` 的 git 快照只是"回退文件"的手段，没有它服务端会退化为"只删消息"（`coordinator.undoRecord` 合成无 snapshot 的 record，只跑 `cleanupAfterUndo`）。前端用 Rust 命令 `check_git_repo`（`git rev-parse --is-inside-work-tree`，按工作目录缓存）区分「没装 git」与「装了但不是仓库」，在确认弹窗里如实追加提示；两种情况都仍然允许撤销，不因此禁用入口。
  - **禁止**在这里再退回"只回滚最后一轮、前端循环调用"的实现（一次跨轮回滚变成 N 次整树还原，中途失败会停在两轮之间的混合态）；也**禁止**在撤销进行中并发触发第二次（`undoInFlight` 期间全部按钮置灰，点击直接被 `undoBlockReason()` 拦下）。
- **右侧「对话记录」大纲是轮级索引**（`session.js` 的 `renderMessageOutline` + `render.js` 的 `roundOutlineEntries`）：面板每项 = 一个对话容器（`.msg-round`，一条 user 消息为一轮），显示 `#序号 · 时间 · 轮标题`，**不再逐条列 agent 消息**——一轮里几十条工具/思考消息会把面板淹掉，而用户要跳转的粒度是"第几轮在聊什么"。标题复用轮标题条同一份文本（`roundTitleText`：首条 user 消息正文，剔除 `<system_info>` 与决策控制块，无文字时显示"（无文字内容）"），因此面板与容器标题永不打架。点击 → `scrollToRound` 按 `data-roundkey` 定位轮容器、**先展开**（折叠的轮不展开就只看得到标题条）、轮内滚回开头，再给轮容器自身加 `.flash-highlight` 闪烁（`.msg-round.flash-highlight`；消息级 `.msg.flash-highlight` 已随逐条大纲一起移除）。无 user 消息的前导轮（只有本地错误气泡）不进面板；FAB 角标数字 = 轮数，与面板项数一致。
- **前端自动续跑**（`src/views/agent/autocontinue.js`）：本轮正常结束但 todos 未完成时自动发“继续”开新轮（每轮重置服务端 nudge 预算）；上限 10 轮、连续 2 轮无进展自动停；仅续跑本客户端发起的任务；出错、取消、切走会话均不触发；开关存 localStorage（`agent_auto_continue`，默认开）。
- **拖拽选择保护 / 主线程停顿看门狗**（桌面端）：在消息区按住左键拖拽选择文字期间，`render.js` 的 `beginSelectGuard` 暂停流式 DOM 写入与自动滚底（`renderMessages` 只置待渲染标记、`scrollChatToBottom` 直接返回），抬键（window 捕获 mouseup）/失焦/10s 超时后补渲染一次；消息区 `dragstart` 拦截“从已有文字选区发起的原生拖拽”（图片除外）。原因：WebView2/Chromium 在拖拽选择期间变更 DOM + 程序化 scrollTop 有触发输入卡死的已知回归（crbug 559347435 / 559795247 / 41327805）。`agent.js` 的看门狗每秒采样定时器漂移，>2s 记 `PERF` 调试日志：界面无响应但无停顿记录 = WebView2 输入卡死（上游问题，需更新运行时），有记录 = 前端长任务阻塞。

## Markdown 显示与流式更新

- `utils.js` 先按块识别围栏代码（包括尚未闭合的流式代码）、标题、段落、有序/无序嵌套列表、引用、分隔线与表格，再做行内代码/强调/链接转换。代码内容保留缩进与换行，HTML 按文本转义，只有 http(s) 链接可点击；避免代码中的星号、链接或表格标记被二次渲染。
- 块内容使用 `.agent-markdown`，以正常空白排版；代码块单独 `white-space: pre` 并横向滚动，避免气泡的 `pre-wrap` 把 HTML 块间空白放大。缓存与 rAF/80ms 合并仍保留；纯文本判定必须覆盖新增块语法。Markdown 节流回调同样遵守拖拽选择保护，并丢弃已卸载节点的待更新内容。
