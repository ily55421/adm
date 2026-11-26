# 内嵌服务端（desktop/internal/server）完整化：差分基座与差距清单

> 目标：把内嵌还原的 admAgent 服务端从“GUI 依赖子集”补成完整实现，
> **排除 llama.cpp 本地模型部分**。验收靠对原版 EXE 的逐项差分，不靠“看起来一样”。
>
> 状态：Stage 0（基座 + 差距清单）、1（纯 HTTP 契约）、2（LSP）、3（MCP）、4（压缩/摘要 + 锚点/事实块/recall）、
> 5（undo 文件快照 + hooks）、6（工具全集 + 前缀预算）、7（vision 图片描述链路）已交付且验证；
> 61 步差分场景已归零（4 处键序、2 处白名单），视觉链路由单测与端到端轮次守门。

## 1. 前提事实（2026-11-26 核对）

| 事实 | 证据 |
| --- | --- |
| 上游 ZIP 不是源码包 | `tar -tf admAgent_0.4.7_Windows_x86_64.zip` 只有 7 个成员：`admAgent.exe`、`LICENSE.md`、`README.md`（0 字节）、`completions/*`×3、`manpages/*`×1，**无任何 `.go`** |
| 原版 EXE 是 stripped 发布二进制 | PE 节表只有 `.text/.rdata/.data/.pdata/.xdata/.idata/.reloc/.symtab`；`coff symbol count: 0`；`DWARF` 解码失败（无 `.debug_*`）；仅 Go pclntab 保留函数名 |
| 上游源码不可得 | `git ls-remote https://github.com/admAgent/admAgent` → repository not found；`proxy.golang.org` 列表 404；本机 `GOMODCACHE` 无副本；`upstream/main` 无 `admAgent/` 目录 |

结论：无法无损还原可编译源码，因此采用“契约驱动 + 差分验证”的逐子系统重写。

## 2. 差分基座

- [`desktop/internal/server/parity_test.go`](../desktop/internal/server/parity_test.go) — `TestParityCapture`：
  同一套固定场景既能打外部原版（`PARITY_BASEURL`），也能打进程内嵌（未设置时自起 `NewServer()` + loopback 端口）。
  响应归一化 UUID、unix 时间戳、`pid`、工作区路径，落盘 `capture-<label>.json`。
- [`scripts/parity/capture-parity.ps1`](../scripts/parity/capture-parity.ps1) — 编排：
  用私有 `LOCALAPPDATA`/`HOME`/`ADMAGENT_GLOBAL_DATA` + 独立 TCP 端口拉起原版，抓完即停，
  然后跑内嵌侧，最后逐项比对 `status`/`body`；有差异退出码 1。

```powershell
pwsh -File scripts/parity/capture-parity.ps1            # 全量差分
pwsh -File scripts/parity/capture-parity.ps1 -SkipOriginal   # 只重抓内嵌
```

原版启动必须用 `--host tcp://127.0.0.1:<port>`（裸 `host:port` 会被判非法），且创建 workspace 必须带 `client_id`。

## 3. 差分结果（60 步场景）

首轮（Stage 0 基线）**23 处**；Stage 1 后 **4 处（全为 LSP）**；Stage 2 后 **0 处**；
Stage 3 并入 MCP（11 步）、Stage 4 并入压缩（4 步）后仍为 **0 处**（计数不含 order-only 与白名单）。

| 阶段 | 场景步数 | differences | order-only | whitelisted |
| --- | --- | --- | --- | --- |
| Stage 0 基线 | 34 | 23 | 0 | 0 |
| Stage 1 后 | 34 | 4 | 5 | 1 |
| Stage 2 后 | 45 | 0 | 5 | 1 |
| Stage 3 后 | 56 | **0** | 4 | 2 |
| Stage 4 后 | 60 | **0** | 4 | 2 |
| Stage 5 后 | 61 | **0** | 4 | 2 |
| Stage 6 后 | 61 | **0** | 4 | 2 |
| Stage 7 后 | 61 | **0** | 4 | 2 |

Stage 2 把 LSP 子系统补齐后，`lsp/catalog`（九个服务器 + 运行时探测）、`lsp/doctor`、`lsp/jobs`、`lsp/install|fix|uninstall` 的
计划与错误路径、`lsps`（含 `state`/`reason`/`fix`/`guide`）、`lsps/{lsp}/restart` 之后的失败状态（错误文案逐字相同）、
`lsps/{lsp}/diagnostics` 的 404 均已对齐。

Stage 3 把 MCP 子系统补齐后，`mcp/states`（connected / error / disabled 三态、计数与 connected_at）、`mcp/refresh-*`（200，name 可省，未知 name 也 200）、
`mcp/read-resource`（数组 `{uri,mime_type,text}` 与未知/禁用的 500 文案）、`mcp/get-prompt`（`{prompt}` 取首条 text）、`mcp/docker/disable` 均已对齐。

Stage 4 把压缩链路补齐后，`summarize` 在空会话、冷却期、未知会话三种情形的状态码与文案
（200 空体 / 200 空体 / 500 `failed to get session: sql: no rows in result set`）均已对齐。

Stage 5 把 undo 的文件级快照与 hooks 补齐后，`undo` 的未知 anchor 行为也进了差分场景：
原版将「anchor 未命中」按「回滚最后一轮」处理（空会话→500 `nothing to undo: this session has no previous turn to roll back`），
不再返回早期猜测的 400。快照 ref / 索引 / read_files / 文件历史的生成与清理由单测守门（见 §5.4）。

Stage 1 已对齐项（原 23 项中消除的 19 项）：

| 项 | 处理方式 |
| --- | --- |
| `config` / workspace `config` | 默认配置补 `model`+`providers`+`options`+`tools`；`providers` 为对象映射（非数组）；键序按 `configKeyOrder` |
| `providers` | 返回 provider 数组（含模型能力字段） |
| `agent_info.model` | `ctx_size` / `provider_max_output_tokens` / `default_reasoning_effort` / `reasoning_levels` 齐全 |
| `prompts/queued` | 返回数字条数（不是 `{queued:bool}`） |
| `prompts/list` | 无排队时 `null` |
| `history` / `filetracker/files` | 无记录时 `[]` |
| `undo`（空 body） | 500 + `nothing to undo: this session has no previous turn to roll back` |
| `DELETE workspace` | 缺 client_id → `client_id is required` |
| `shell` | 输出不再包 `<cwd>`；命令落库为 `shell_command` 消息 |
| `session_create` | 标题不再回填时间戳 |
| `agent/sessions/{sid}` | 只回 id + `attached_clients`/`is_busy`（时间戳零值） |
| `project/needs-init` | 实测规则：有可见文件且缺 `initialize_as` 才 true（空目录 / 已有 AGENTS.md 均 false） |

order-only（语义一致，仅键序/空白）：`config`、`messages`、`providers`、`workspace_create`、`workspace_get`、`workspaces_list`。

白名单与已文档化偏差：

- `version`：内嵌 `0.4.7-admx.N`（身份字段）。
- `data_dir`：`.admx` vs `.admAgent`（独立实例设计）。
- 内置 provider 的 `api_key`：原版内置固定 key，内嵌不内置第三方密钥（字段形态保留空串）。

## 4. 差距清单（按子系统）

| # | 子系统 | 上游证据 | 内嵌现状 |
| --- | --- | --- | --- |
| 1 | LSP 客户端 + managed LSP | `/v1/lsp/{catalog,doctor,install,fix,uninstall,jobs,jobs/{id},jobs/{id}/cancel}`、`lsps/{lsp}/{start,restart,diagnostics}` | **Stage 2 已补齐**（见 §5.1） |
| 2 | MCP 客户端 | `internal/agent/tools/mcp`（ClientSession/CallTool/GetPrompt/ListPrompts）、`mcp/docker/{enable,disable}` | **Stage 3 已补齐**（见 §5.2） |
| 3 | 压缩/摘要 | `coordinator.Summarize`、`sessionAgent.Summarize`（121 个符号） | **Stage 4 已补齐**（见 §5.3） |
| 4 | undo 文件快照 | `snapshotTool`、`internal/undo` | **Stage 5 已补齐**（见 §5.4） |
| 5 | hooks | `internal/hooks.(*Runner).Run/matchingHooks` | **Stage 5 已补齐**（见 §5.4） |
| 6 | vision | `internal/vision.Describe`、`agent.describeImages` | **Stage 7 已补齐**（见 §5.6） |
| 7 | 工具全集 | `internal/agent/tools` 各组 Params（符号/引用/LSP 类工具） | **Stage 6 已补齐**（26 个工具，描述/参数逐字对齐；见 §5.5） |
| 8 | providers/config 形态 | 原版 `config.model`/`config.providers` 带模型能力字段 | **Stage 1 已对齐**（默认配置 + 对象映射 providers） |
| 9 | prompts 队列 / 标题生成 | queued 为计数，标题由 LLM 摘要生成 | **队列结构已对齐**；标题仍为非 LLM 生成 |
| 10 | 路由补齐 | `/v1/models`、`/v1/models/status`、`/v1/analytics/events`、`skills/reload` | `/v1/lsp/*` 已补；原版 `/v1/models*` 也返回 404（未注册）；analytics 默认不启用 |
| 11 | Swagger | `/v1/docs/doc.json`（137 KB、55 路径/63 方法、68 definitions） | 404 |

路由全集取自二进制 `/v1/` 字面量（82 条唯一串，含 swagger 未声明的 0.4.8 新路由）。

## 5. 分阶段计划

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| Stage 1（**已完成**） | 纯 HTTP 契约对齐：prompts 计数、空数组/ null 语义、undo 500、DELETE 文案、shell 落库、session 标题、agent 会话形态、needs-init 规则、默认配置与 providers 形态 | 差分 23 → 4（剩余全部为 LSP） |
| Stage 2（**已完成**） | LSP 子系统：内置九服务器目录 + 运行时探测、doctor、计划/确认、安装任务与取消、卸载；工作区 LSP 客户端（起进程 + initialize + 诊断缓存）与 start/stop/restart/diagnostics | 差分 4 → **0**（45 步场景） |
| Stage 3（**已完成**） | MCP 子系统：stdio/http 客户端、tools-prompts-resources 三张列表、refresh×3、read-resource、get-prompt、docker enable/disable；agent 侧注册 `list_mcp_resources` / `read_mcp_resource` 与每工具 `mcp_<server>_<tool>` | 差分 0（56 步场景） |
| Stage 4（**已完成**） | 压缩/摘要：两档摘要调用（提示词逐字取自原版）、pinned 前缀（Persistent Anchors + Session Facts）、`is_compressed` 标记与 `summary_message_id`、30s 冷却与空会话 no-op；`recall` 工具（`range` / `expand` / `query` / `max_results`，参数声明取自二进制） | 差分 0（60 步场景） |
| Stage 5（**已完成**） | undo 文件快照（轮次 git 快照 `refs/admAgent/undo/<sid>/<anchor>`、`undo_checkpoints` 保留窗口、undo 恢复工作树并清理 read_files/history）+ hooks（`PreToolUse` matcher/command/timeout、退出码 0/2/49、envelope 聚合、Claude Code 兼容） | 文件级回滚与 hook 触发（单测 + fake LLM 端到端轮次；差分 61 步） |
| Stage 6（**已完成**） | 工具全集 + 前缀预算：26 个工具的 name/description/parameters 从原版请求体逐字内嵌（`toolcatalogue.json` + `toolCatalogueEntry`），补齐 LSP 类 6 个工具、`agent` 子代理、`agentic_fetch`、`sourcegraph`、`web_search`、`admAgent_info`、后台 shell（`job_output`/`job_kill` + bash 的 `run_in_background`/`auto_background_after`）；固定前缀预算与告警日志 | 工具目录与原版逐字一致（单测 + fake LLM 抓真实请求体）；差分 61 步仍为 0 |
| Stage 7（**已完成**） | vision 图片描述链路：顶层 `agent_vision_model` 解析、描述请求逐字对齐（system 提示词 + `[提示: …]\n描述图片内容` + image_url）、`<system_info>` 成功/失败注入、附件落盘与进程内缓存、view 读图时的同一条桥 | 单测 + fake LLM 端到端轮次；差分 61 步仍为 0 |

### 5.1 LSP 子系统的实现边界

已实现且被差分覆盖（`desktop/internal/server/lsp.go`、`lsp_client.go`）：

- **目录与运行时探测**：九个内置服务器的 `display_name`/`version`/`license`/`source`/`platforms`/`auto_install`/`fix`/`guide`；
  `node -v` / `python --version` / `go version` 实时探测（30s 缓存），`compatible` 按 `minRuntime`（node 18 / python 3.9 / go 1.21）判定。
- **doctor**：`runtime`（node/python/go 固定顺序）、`path`（PATH 拆分）、`install_dir`（`<data>/cache/lsp`，可写性实测）、`proxy`。
- **计划 / 确认 / 任务**：`lsp-plan-<UTC>` 单次使用、5 分钟过期；`confirm` 缺计划 409；`jobs` 列表/详情/取消；
  安装按步骤真执行（`npm_install` / `create_venv`+`install_pypi` / `go_install`），产物落在安装目录并写 `state.json`。
- **工作区客户端**：真实拉起进程、`initialize` 握手、`publishDiagnostics` 缓存；`restart` 同步重启；`stop` 只停运行中的客户端；
  失败错误链与原版逐字一致（`failed to create lsp client: failed to start language server: failed to start process: exec: ...`），
  `error_type` 区分 `not_installed` / `startup_failed`。

已知未验证（本机无 LSP 二进制，无法在真机上产生对照）：

- `state` 枚举只能观察到 0（未启动）与 3（错误）；1/2（启动中/就绪）取值属推断。
- 成功安装后的任务对象与确认响应形态、`diagnostics` 响应体（`{diagnostics:[...]}`）属推断（用二进制 tag `job_id`/`diagnostics`
  与 `managed.JobInfo` 符号推定，未能与原版实际响应逐字对拍）。
- managed 运行时的自动下载（二进制含 `downloading Node`/`SHASUMS256.txt` 等符号）未实现：只在系统无 node/python/go 时才会走到，
  当前实现退化为 `missing_runtime` 状态。

### 5.2 MCP 子系统的实现边界

已实现且被差分覆盖（`desktop/internal/server/mcp.go`，夹具 `scripts/parity/mcp-echo-server.js`）：

- **状态表**：`connected`（带工具/Prompt/资源计数与 `connected_at`）、`error`（带裸 exec 错误文案）、`disabled`；
  `docker` 条目只在调过 `docker/*` 后出现。
- **错误文案逐字对齐**：`mcp 'x' not found; enabled MCP servers: ...`、`mcp 'x' is disabled; ...`、
  无可用服务器时的 `none (no MCP server is enabled)`。
- **stdio 传输**：换行分隔 JSON-RPC、`initialize`/`initialized` 握手、`tools/list`/`prompts/list`/`resources/list`、
  `resources/read`、`prompts/get`（只取首条 text 消息，实测行为）、`tools/call`。
- **工作区生命周期**：建工作区时按 `mcp` 配置异步连接；工作区删除与 server `Close()` 时停子进程。

已知边界：

- `http` 传输按单次 JSON-RPC POST 实现（无 SSE 流式会话）；`sse` 传输报“不支持”，状态进入 `error`。
- `docker` 网关的启动参数无法从二进制恢复（原版错误为 `docker: unknown command: docker docker`），
  当前按 `docker run -i --rm mcp/gateway` 尝试，失败返回 `failed to start docker MCP: <err>`；
  `docker/enable` 不在差分场景里（依赖本机 docker 环境，结果不可稳定对拍）。
- agent 侧 MCP 工具命名：`list_mcp_resources` / `read_mcp_resource` 来自二进制字符串表（已核实），
  每工具名 `mcp_<server>_<tool>` 属推断（二进制里找不到对应的拼接格式串）。

### 5.3 压缩/摘要与 recall 的实现边界

已实现（`desktop/internal/server/summarize.go`；实测方式：假 LLM + 隔离实例 + SSE 抓包）：

- **两档摘要**：待压缩历史对半切，远档 / 近档各一次流式调用（`max_tokens=512`、不带工具 schema），
  系统提示词与两档指令逐字取自原版请求体；两档结果按 `"\n\n\n---\n\n"` 连接，逐行去重
  （标题 / 分隔符 / 列表项 / `[` 块保留，其余重复散文行去掉）。
- **pinned 前缀**：`---\n## Persistent Anchors (protected, never compress)` + 锚点行 + 两处空行 +
  `[Session Facts]` 的归档区间 + 结尾 `---`，与实测响应逐字节一致（`TestSummaryPrefixFormat` 守门）。
- **压缩语义**：旧消息只 `is_compressed=1`（transcript 不删）；摘要消息 `is_summary_message=1`、`parts=[text, finish(end_turn)]`；
  `summary_message_id` / `prompt_tokens` 落库，`context_tokens` 只在内存（原版重启后同样读回 0）；
  agent 轮次改用工作上下文（过滤已压缩、摘要作为首条 user）。
- **no-op 与错误**：空/内容不足、30s 冷却内重复调用 → 200 空体；未知会话 → 500
  `failed to get session: sql: no rows in result set`（三者均进差分场景）。
- **`recall` 工具**：`range`（20 条/页，`page` 分页，越界时返回 `Page %d is outside #%d..#%d (pages 1-%d, %d entries).`）、`expand`（最多 5 条、单条 4800 字符上限）、`query`（词项 + 中文二元组重叠打分）、
  `max_results`（1–8，默认 5）；参数名与描述取自二进制字符串表。

已知差异（差分不覆盖，按可用性取舍）：

- 锚点抽取是**确定性关键词规则**（`goal` = 第一条可压缩 user 文本，实测一致；`constraint`/`decision` 用关键词近似），
  原版用 LLM `Extractor`。
- `#N` 归档编号是**进程内**单调计数（原版持久化在 `messages.turn` 列并做 `BackfillTurns` 回填），
  重启后归档与编号清零；`recall` 的归档正文同样只在内存。
- 保留尾部条数用 `context_window/10000` 夹在 2..12（128k → 12 条，与实测归档区间 `#1..#19` 一致），
  原版 `deriveKeepRecentCount` 还叠加尾部 token 预算；token 重算用 `estimateTokens` 近似。
- 未实现：Rail 3 的 n-gram / 实体索引与被动召回、`RecallStrict`、项目记忆同步（`project_memory_sync`）、
  事实块里的 Modified/Created/Commits 采集（`fact_block_read` 默认关，仅保留 `Archived:` 行）。
- 摘要过程中用户取消时，原版删除半成品摘要消息；内嵌实现只把 `finish` 标成 `error`。

### 5.4 undo 文件快照与 hooks 的实现边界

已实现（`desktop/internal/server/undo.go`、`hooks.go`；取证方式：隔离实例 + 假 LLM 驱动真实轮次，见 §3 的 Stage 5 记录）：

- **轮次快照**（`Snapshotter.MaybeSnapshot` 语义）：用户消息落库后造快照——用临时索引（`GIT_INDEX_FILE`）`git add -A` → `write-tree` →
  `commit-tree -m "admAgent undo snapshot session=<sid>"`，提交挂在 `refs/admAgent/undo/<session>/<用户消息 id>`；
  索引落在 `<ws>/.admx/undo/<session>.json`，字段 `anchor` / `anchor_created_at` / `pre_head` / `tree` / `commit` / `created_at`，
  清空后文件内容为 `null`（Go nil slice 形态，与原版逐字一致）。
- **保留窗口**：`options.undo_checkpoints`（默认 10，>100 夹到 100），超出时删旧 ref 与记录。
- **undo**：把工作树恢复到记录的 `tree`（`git read-tree` + `git checkout-index -a -f`，不删除未跟踪文件），
  删对应 ref 与索引记录，再删消息（从 anchor 起）、清该会话 `read_files`、清 `files` 历史版本；响应 200 + 剩余记录数组（实测 `[]`）。
- **hooks**：项目级 `hooks.PreToolUse` 覆盖全局；`matcher` 正则匹配工具名（空=全匹配）；多条并行执行、按 `command` 去重、
  按配置顺序聚合（deny > allow > 无意见，halt 粘性，`reason`/`context` 换行拼接，`updated_input` 浅合并）。
  命令跑在内部 shell（mvdan/sh，与 bash 工具同引擎）里，cwd = 工作区；stdin 为
  `{event,session_id,cwd,tool_name,tool_input}`；env 含 `ADMAGENT_EVENT` / `TOOL_NAME` / `SESSION_ID` / `CWD` /
  `PROJECT_DIR` / `TOOL_INPUT_COMMAND` / `TOOL_INPUT_FILE_PATH`。退出码 0 解析 envelope、2 阻挡、49 结束整轮、其余非阻塞。
- **实测文案与顺序**：deny 时 tool_result 为 `Tool call blocked by hook. Reason: <stderr>`；`context` 以换行追加在 tool_result 末尾；
  `updated_input` 生效后工具用改写后的参数执行；hook 发生在权限检查之前，`allow` 等于预先批准（跳过弹窗）。

已知边界（原版不可观察或不复刻）：

- 文件级 undo 依赖**工作区自身是 git 仓库**：无 `.git` 时不产生 ref，undo 只回滚对话（`file_restore=false`）——与原版实测一致。
- 索引目录用 ADMX 的 `<ws>/.admx`（独立实例改名，同数据库），不是 `.admAgent`。
- hooks 的 `halt`（exit 49 / `halt:true`）只保证把理由写进 tool_result 并结束本轮；原版 halt 的 run 事件形态未取证。
- 未实现：快照的 token/预算剪枝、工具执行前的二次快照、hooks 的其它事件（原版也只有 `PreToolUse`）。

### 5.5 工具全集与固定前缀的实现边界

已实现（`desktop/internal/server/toolcatalogue.go`、`toolcatalogue.json`、`tools.go`、`tools_extra.go`、
`lsp_tools.go`、`jobs.go`；取证方式：隔离实例 + 假 LLM 把 `/chat/completions` 请求体完整落盘）：

- **目录逐字内嵌**：26 个工具的 `name`/`description`/`parameters` 直接取自原版请求体（只把描述里的
  `admAgent:<model>` 换成 `{{model}}` 占位符，按当前模型渲染），存成 `toolcatalogue.json` 由 `go:embed` 加载；
  `buildToolDefs` 按目录顺序注册，行为实现按名字绑定（`bindCatalogue`）。
- **补齐的工具**：`lsp_symbols` / `lsp_definition` / `lsp_references` / `lsp_call_hierarchy` / `lsp_diagnostics` /
  `lsp_restart`（真实 LSP 请求，走 Stage 2 的客户端层）、`agent`（只拿 8 个搜索类工具的子代理）、
  `agentic_fetch`（抓取或搜索后用 LLM 提取）、`sourcegraph`（SSE 搜索流解析）、`web_search`（Bing，失败回退 RSS）、
  `admAgent_info`（模型/provider/LSP/skills/hooks/权限/options 分区）、`job_output` / `job_kill`
  （后台 shell）与 bash 的 `run_in_background` / `auto_background_after`（后者当前只保留参数，不自动转后台）。
- **前缀预算**：`prefixBudgetTokens = 9400`（取自原版日志 `budget_tokens`），每轮估算
  `estimateTokens(systemPrompt) + toolSchemaTokens(tools)`，超预算写一条原版同形的告警日志；
  实测内嵌 `prefix_tokens=6969（sys=541, tool=6428）`，原版为 9750（sys=3292, tool=6458）——工具部分几乎一致，
  差异在系统提示词（内嵌版更短）。
- **MCP 工具条件注册**：无启用 MCP 服务器时只注册 26 个基础工具；有 MCP 时才追加
  `list_mcp_resources` / `read_mcp_resource` 与 `mcp_<server>_<tool>`（与原版一致，无 MCP 时工具数是 26）。

已知边界（差分不覆盖，按可用性取舍）：

- **工具行为是「同一契约、不同实现强度」**：LSP 类工具用标识符精确查找定位符号（原版依赖 LSP 符号索引），
  找不到时报 `symbol %q not found under %s`；`sourcegraph` 只解析 SSE 的 `content` 事件；`web_search` 用 Bing HTML+RSS，
  不复制原版的逐页解析细节；`agent` 子代理上限 12 步。
- 未实现：`lsp_replace_symbol` / `lsp_rename`（原版注册表里有符号编辑工具类，但不在 26 个默工具内）、
  `agentic_fetch` 的 GitHub/`gh` 优先路径、bash 的自动转后台计时、系统提示词的逐字对齐
  （内嵌版保留自己的身份/沟通约定段落）。
- 工具描述里的 `{{model}}` 只出现在 bash 的提交 trailer 说明中；模型名为空时回退 `admAgent`。

### 5.6 视觉桥（vision）的实现边界

已实现（`desktop/internal/server/vision.go`；取证方式：隔离实例 + 双端口假 LLM 抓包，主模型纯文本、视觉模型指向假服务）：

- **配置**：只认**顶层** `agent_vision_model`（`{provider, model}`）。实测把该字段嵌在 `model` 里时原版会忽略它（仍走内置 provider），
  因此内嵌也只读顶层键。
- **描述请求逐字**：system = `只输出简洁纯文本图片描述，不加 markdown/对话/反问。`；user content 为
  `[{type:text, text:"[提示: <用户原话>]\n描述图片内容"}, {type:image_url, image_url:{url: data:…;base64,…}}]`；
  不带 tools / max_tokens / temperature，`stream=true` + `stream_options.include_usage`。
- **注入形态**：主模型 `supports_images=false` 且本轮带图片附件时，把 `<system_info>` 块追加到用户消息末尾。
  成功行：`- 附件 '<name>'（<mime>，路径: <abs>）: 图片内容描述: <desc>`；
  失败行：`⚠ 附件 '<name>' 图片识别失败（多模态模型调用失败: request failed: <err>）。请直接告知用户图片识别服务暂不可用，建议重新截图上传后重试，不要尝试用工具读取该图片。`
- **附件落盘**：`<ws>/.admx/attachments/<uuid>/<name>`（原版是 `.admAgent/attachments/…`），块内路径用正斜杠。
- **不持久化**：该块只进本次请求，不写回消息；后续轮次的同一消息不再带它（与原版实测一致）。
- **缓存**：进程内按「图片内容 + 本轮用户原话」缓存描述，同一轮多个步骤只描述一次
  （原版本轮 5 次主模型请求只产生 1 次视觉调用）。
- **view 桥**：`view` 读到图片文件且主模型不收图时走同一条描述链路，返回 `[Image: <desc>]`；
  失败返回 `Image cannot be read as text: the active model does not support images and the vision bridge failed: <err>`。

已知边界：

- 只对**图片**附件做桥。非图片附件（文档/二进制）的 `<system_info>` 文件清单（原版有
  `The files below have been attached by the user, consider them in your response` 变体）未实现。
- 主模型**支持图片**时不做桥，图片仍以 `image_url` part 发给主模型；内嵌存储形态同样用 `image_url`，
  原版在纯文本主模型下存的是 `binary` part（落库形态差异，差分场景不覆盖图片附件）。
- 主模型支持图片时 `view` 仍返回文本（内嵌没有把图片作为 tool 结果 part 回传的通路），属已知差距。
- 描述缓存不跨进程：重启后重新描述。
验收白名单（允许差异）：`version`（内嵌标识）、`config`（原版 GET /v1/config 把全局配置合并三次，
`args` / `skills_paths` 因此重复；内嵌不复刻该放大），以及 `commit`/`build_id`/`go_version`/`pid`/`data_dir`。

## 6. 明确排除

llama.cpp 本地模型部分（模型下载、`llama-server` 拉起、local provider 自动发现）不在内嵌范围，由桌面端现有链路承担。
