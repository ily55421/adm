# admAgent 后端服务内嵌还原（desktop/internal/server）

> ⛔ **已弃用冻结（2026-11-25）**：原生 GUI `desktop/` 整体退场，桌面 UI 回到 Web/HTML（Tauri 主线
> `src/` + `src-tauri/`，唯一交付目标；`website/` 只是营销官网落地页，不是桌面 UI）。
> 本文档与 `desktop/internal/server` 作为**实验成果与参考留档**保留，不再接受新功能、兼容性修复或
> 构建/发布变更；除非用户明确要求，不要改动 `desktop/`。依据见根 `AGENTS.md` 硬规则 7。

> 目标：把外部 sidecar `admAgent.exe`（57 MB Go 二进制）的后端服务能力**还原进桌面端进程**，
> 客户端与服务端同进程（命名管道仍在，传输契约不变），不再依赖外部 exe。
>
> 状态：**已落地并验证**（构建 / 单测 / 端到端 / 无头真机冒烟全绿）。
> 还原对象：`github.com/admAgent/admAgent` **v0.4.7**（go1.26.4，revision `66ee74b`，
> SHA-256 `21c5780a…44ecf1`，模块路径取自 `go version -m`）。

---

## 1. 还原依据（证据链）

全部结论来自对二进制的静态提取 + 对运行中真实实例的只读取证，无源码。

| 证据 | 获取方式 | 用途 |
| --- | --- | --- |
| 模块身份 / 138 个依赖 / 构建参数 | `go version -m admAgent.exe` | 确认 Go 1.26.4、`-trimpath`、CGO 关闭 |
| pclntab 函数名表（40072 个符号） | 自写解析器（scratch，`debug/pe` + pclntab 头/funcnametab/functab） | 包结构地图；`internal/server` 的 96 个 handler、`agent/tools` 的工具目录（28 个 Params 结构）、`proto`/`db`/`pubsub`/`config` 等 |
| goose 迁移 SQL（sessions/messages/files/read_files 全部 DDL + 触发器 + 索引） | 二进制字符串上下文提取（含 `-- +goose StatementBegin/End`） | schema 逐字节还原 |
| 真实工作区数据库 | `%LOCALAPPDATA%` 下既有 `.admAgent/admAgent.db`（modernc sqlite 只读探针） | goose 版本号 10 条、每列 notNull/pk/default；schema 与真实库双向兼容 |
| 运行中实例的 HTTP 响应 | 命名管道只读 GET：`/version` `/workspaces` `/agent` `/sessions` `/messages` `/skills` `/providers` `/permissions/skip` `/mcp/states` `/lsps` `/project/needs-init` | 字段级 ground truth（Session/Workspace/AgentInfo/Message parts/SkillInfo 精确形态） |
| 仓库权威契约 | `doc/server-api.md`（63 端点）、`doc/admAgent-server.md` | 错误码语义、SSE 事件信封、决策模式契约 |
| 客户端调用面 | `desktop/internal/adm/client.go`、`model.go` | boot 链路与会话绑定、事件消费集合 |

**未使用反编译引擎**：本机 Ghidra/Hopper/IDA/Kuna 均不可用（REA `binary_session` 报 `provider_unavailable`/`not_configured`）。对 Go 二进制而言 pclntab + 字符串 + 运行时取证的信息密度高于通用反编译器，故按上述路线执行。

---

## 2. 实现范围（与真实 v0.4.x 对齐）

### 2.1 已实现（GUI 桌面端依赖面）

- **数据层** `store.go`：SQLite（modernc.org/sqlite，纯 Go），`<workdir>/.admx/admx.db`（独立化后）；
  建表/触发器/索引/后期列与真实迁移等价；goose 版本记录与真实库一致 → **两边可互相打开同一 DB**
  （内嵌创建的库真实 admAgent 不会重放迁移，反之亦然）。
- **HTTP 层** `server.go`：`/v1/*` 全部路由骨架 + 核心语义：
  - 系统：`/health` `/version` `/config` `/control`（shutdown / shutdown_if_idle + 空闲检测）`DELETE /clients/{id}`
  - 工作区：增删查、current-session（要求 client 已挂 SSE，否则 409）、providers、events(SSE)、messages/user
  - 会话：CRUD、messages、history(files)、filetracker
  - Agent：GET/POST /agent（202 fire-and-forget）、init、update、sessions/{sid}、cancel、shell、undo、summarize(no-op)、prompts 队列
  - 配置：set/remove/model/compact/provider-key（scope 0 全局 / 1 工作区，与真实合并规则一致）
  - skills（内置嵌入 + skills_paths 扫描 + read/reload）、project（needs-init/init/init-prompt）
  - LSP/MCP：空表或显式「不可用」语义（客户端按空处理）
- **SSE** `pubsub.go`：事件总线 + 挂载/摘除；信封 `{type, payload:{type,payload}}`；
  30s 写超时；连接断开（ctx done / channel close）即摘除。事件类型：session / message /
  permission_request / permission_notification / agent_event / run_complete / config_changed / skills_event。
- **Agent 循环** `agent.go`：最多 64 步；流式增量落库 + 广播；工具调用聚合（index 维度）；
  reasoning/text/tool_call/tool_result/finish part 形态与真实 ContentPart 一致；
  权限门控（bash deny-list + 写类工具权限请求，allow / allow_session / deny）；
  todos 工具回写会话并广播；run_complete 每轮精确一次（含 error / cancelled / empty_output / incomplete_todos）；
  会话繁忙排队（上限 10，超出 409）；token usage 逐轮累加；首轮自动生成标题。
- **决策模式**：`decision.mode=auto/choice/bool/score` 独立决策轮（不注册工具），输出
  `<adm_decision_result>` 契约校验 + 一次重定向重试；通过后正文替换为 `decision` part（`kind/mode/raw/...`）。
- **LLM** `llm.go`：openai-compat `/chat/completions` 流式（reasoning_content / content / tool_calls / usage），
  DeepSeek 风格 `reasoning_effort`；usage 缺失时按字符粗估。
- **工具** `tools.go`：`view/ls/glob/grep/write/edit/multiedit/bash/fetch/download/todos/admAgent_logs`。
  bash 用 mvdan/sh（POSIX），与真实引擎同源；只读命令免权限；deny-list 语义与
  `options.bash_allow_all` 联动（描述里追加 `<bash_allow_all>` 段）。
- **内置 skills** `skills/*.md`：从二进制提取还原（admAgent-config / admAgent-hooks / git-commit / jq），
  `embed.FS` 打包；git-commit 的完整 git/PR 剧本与署名 trailer 约定一并保留。

### 2.2 有意未实现（与真实 server 的差异，按需再补）

| 能力 | 现状 | 影响 |
| --- | --- | --- |
| LSP 客户端（启动/诊断/符号检索类工具） | 空表 + 显式不可用 | 依赖 LSP 的 grep/定义跳转增强不可用；grep/glob/view 原生工具不受影响 |
| MCP（stdio/docker、refresh、read-resource、get-prompt） | 空表 + no-op | MCP 工具不会出现；工具面板为空 |
| summarize / 上下文压缩 | 端点返回 200 但 no-op | 长会话不自动摘要（窗口占满由模型自身处理） |
| undo 的文件快照回滚 | 仅对话级回滚（删消息） | 文件修改不回退；快照仍会写入 files 表 |
| hooks、vision 模型、图片生成 | 未接 | 与 GUI 无关的后端能力 |
| Swagger UI | 404 | 契约以 `doc/server-api.md` 为准 |

---

## 3. 接入方式（desktop 侧）

- `internal/adm/embedded.go`：`StartEmbedded(pipe)` 在 **ADMX 专属**命名管道上启动进程内 server
  （`\\.\pipe\admx-<SID>.sock`，或 `ADM_AGENT_PIPE` 显式覆盖；非 Windows 退化为 Unix socket）；
  `Stop()` 关 HTTP + 断 SSE + 关存储。
- `bootRun` 决策顺序：
  1. `ADM_EMBEDDED_SERVER=1` → 跳过外部探测，强制内嵌（冒烟/排障）；
  2. 默认（`ADM_EMBEDDED_SERVER` 未设）→ 内嵌：遍历 `EmbeddedPipeCandidates()`
     （`ADM_AGENT_PIPE` 覆盖 > `\\.\pipe\admx-<SID>.sock` > `\\.\pipe\admx.sock`），
     逐个探测健康实例，命中则复用、否则用第一个可用管道启动内嵌 server；
  3. `ADM_EMBEDDED_SERVER=0` → 退回旧 sidecar 外部 exe 模式（`startExternalBoot`，
     走 `PipeCandidates()` 的 `admAgent-*` 候选，可能复用/拉起外部 admAgent.exe）。
- **独立实例设计**：内嵌只使用 `admx-*` 专属管道与 ADMX 专属目录（全局配置
  `%LOCALAPPDATA%\ADMX`，工作区数据 `<workdir>/.admx/admx.db`），因此 ADM(Tauri) +
  admAgent.exe 与 ADMX 可同时运行而互不干扰；仅当显式 `=0` 时才碰外部 admAgent。
- 因此客户端 `client.go` 与 UI 零改动；只有权限请求体改为契约形态（`permission`+`action`，
  见 §5），展示字段用 `ApplyAliases` 从 `tool_name/description/params.command` 派生。
- 日志：`%LOCALAPPDATA%\ADMX\adm-server.log`（server 侧）、`adm-desktop.log`（boot/连接，
  debugLog 现在会自动建目录）。

---

## 4. 验证证据

- `go build ./...` / `go vet ./...` 全绿；`go test ./... -count=1` 全绿：
  - `internal/server`：DB 往返 + 计数触发器 + goose 幂等、HTTP 契约（错误码/信封/空表/skills/needs-init）、
    **fake-LLM 端到端轮次**（SSE 事件序、user/assistant/tool 消息 parts 形态、token 累计、自动标题）、
    决策输出解析、bash 只读白名单、Broker 投递/摘除、UUID 校验。
  - `internal/adm`：`ADM_EMBEDDED_TEST=1` 时真命名管道契约测试（Health→工作区→会话→SSE→
    current-session→详情→DialPipe）。
- 无头真机冒烟（隔离 LOCALAPPDATA + 独立管道 + `ADM_EMBEDDED_SERVER=1`）：进程内 server 启动、
  `CreateWorkspace 200`、`agent/init 完成`、SSE 挂接成功，`layout 0 problems`，UI 元素齐全。

---

## 5. 已知边界与后续

- 权限请求体现为契约形态（proto.PermissionRequest）；仅 `ADM_EMBEDDED_SERVER=0` 走外部真实
  admAgent.exe 时同样命中该形态，一致。
- `undo` 仅对话级；`summarize` no-op；LSP/MCP 空表——上表逐项补齐时同步更新本文档与
  `doc/server-api.md` 的对应小节。
- **独立实例**：ADMX 内嵌默认只用 `<workdir>/.admx/admx.db`，与外部 admAgent 的
  `.admAgent/admAgent.db` 物理隔离，二者可同时运行；仅当 `ADM_EMBEDDED_SERVER=0` 走旧 sidecar 时
  才可能操作外部库（WAL 并发写仅支持单进程，切换前请完全退出一个）。

---

## 6. 打包、安装与真机验证（0.9.1，独立实例版）

> 0.9.0 曾按「复用外部 admAgent」设计（见 git 历史）；0.9.1 改为**独立实例**：专属 `admx-*`
> 管道 + `%LOCALAPPDATA%\ADMX` 全局目录 + `<workdir>/.admx/admx.db`，不再与外部 admAgent 争用。

```powershell
cd desktop
go run github.com/vivaui/viva/cmd/viva@v0.6.5 package --target windows --arch amd64
# -> build\admx-0.9.1-windows-amd64-setup.exe（约 5.1 MiB；程序 15.2 MiB stripped）
& ".\build\admx-0.9.1-windows-amd64-setup.exe" /S    # 用户级静默安装到 %LOCALAPPDATA%\Programs\ADMX
```

真机结果（本机，**与运行中的 ADM(Tauri) 及外部 admAgent 进程同时存在**）：

- 安装覆盖前备份旧程序为 `*.pre-0.9.0-<时间戳>.bak` / `*.pre-0.9.1-<时间戳>.bak`；退出码 0。
- `%LOCALAPPDATA%\ADMX\admAgent.exe`（外部 sidecar）归档为 `.sidecar-archived-0.9.0.bak`——内嵌模式不需要它。
- 默认启动（**无需任何环境变量**）日志：`embedded: 内嵌 server 已启动 pipe=\\.\pipe\admx-<SID>.sock`
  → `就绪` → `CreateWorkspace 200` → `agent/init 完成` → `SSE 已挂接` → `Sessions n=1` → `boot: 就绪` → paint 正常。
- 独立化落点已核对：`%LOCALAPPDATA%\ADMX\admAgent.json` 存在且配置生效；
  工作区库落在 `<workdir>\.admx\admx.db`（旧 `.admAgent` 数据仅在首次启动时复制迁移）。
- 冒烟与既有配置未受影响（`config.json` 哈希一致）；外部 admAgent 进程未被挤占或改动。
- 若确实要回到外部 sidecar：设 `ADM_EMBEDDED_SERVER=0`（会探测/复用 `admAgent-*` 管道与外部 exe）。

---

## 7. 复现命令

```powershell
cd desktop
go build ./...
go vet ./...
go test ./... -count=1                 # 常规
$env:ADM_EMBEDDED_TEST="1"; go test ./internal/adm/ -run TestEmbedded -count=1

# 无头真机冒烟（隔离环境）
$smoke = "$env:PI_SCRATCH_DIR\smoke"
$env:VIVA_HEADLESS="1"; $env:LOCALAPPDATA=$smoke; $env:HOME=$smoke
$env:ADM_AGENT_PIPE="\\.\pipe\admx-smoke-1.sock"; $env:ADM_EMBEDDED_SERVER="1"
go build -tags vivahead -o "$smoke\ADMX-headless.exe" ./cmd/admx
'settle'; 'texts'; 'layout' | & "$smoke\ADMX-headless.exe"   # 另开管道保持 stdin 打开
Get-Content "$smoke\ADMX\adm-desktop.log"; Get-Content "$smoke\ADMX\adm-server.log"
```
