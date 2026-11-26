# ADMX 分支品牌化改造记录

> 范围：本仓库 fork 后与上游原版 ADM 的差异化（应用名 / 标识符 / 图标 / 导航 / 自升级）。
> 改动目标：桌面端独立分发时不与原版 ADM 冲突（exe、安装包、数据目录、托盘、图标、更新源全部区分开）。

## 应用名与标识符

| 项 | 原版 ADM | 本分支 ADMX |
| --- | --- | --- |
| `productName`（tauri.conf.json） | `ADM` | `ADMX`（窗口标题 / 安装包 / 安装目录 `%LOCALAPPDATA%\ADMX`） |
| `mainBinaryName`（tauri.conf.json，顶层字段） | （缺省，取 cargo 名 `adm` → `adm.exe`） | `ADMX`（主程序为 `ADMX.exe`，任务管理器/托盘进程名与原版 `adm.exe` 区分） |
| `identifier`（tauri.conf.json） | `com.adm.admapp` | `com.admx.admapp`（数据目录 / app_data_dir 随之独立） |
| 窗口标题 / `<title>` | `ADM` | `ADMX` |
| 托盘 tooltip（`lib.rs`） | `ADM` | `ADMX` |
| `scripts/sign-windows.ps1` 的 `$AppName` | `ADM` | `ADMX` |

注意：identifier 变更会让 macOS/Linux 的 app_data_dir 从 `com.adm.admapp` 变为 `com.admx.admapp`，
ADMX 全新安装从零开始积累配置，不读原版数据（这是有意为之）。

## 图标

- 图标源改为矢量文件 `src-tauri/icons/source.svg`（紫色渐变圆角方块 + 白圆 + ADMX 字样），
  再生成命令：`pnpm tauri icon src-tauri/icons/source.svg`（Tauri CLI 2.x 原生支持 SVG 输入，
  一次产出 ico / icns / 各尺寸 PNG / Square*Logo 全套）。
- 上游遗留的 `scripts/generate-icons.py`（PIL 从 source.png 缩放）保留但不再使用；
  `source.png` 现为生成产物的 512px 副本，仅作预览参考。

## 导航（底栏）与路由

- 底栏保留 **设置 / Agent / 云端模型 / 技能管理** 四个菜单；「首页」（模型列表）入口已移除。
  「云端模型」页（`#/cloud`，`src/views/cloud_models.js`）是上游 0.8.3 新增页，2026-11-19 合并时纳入
  （上游已把云端模型管理从 Agent 设置弹窗整体独立成页，不纳入则无入口）；`/list` 路由仍然删除。
- `index.html` 路由表删除 `/list`，默认路由与未知 hash 兜底均改为 `#/agent`；
  `setActiveNav` 初始激活 `agent-btn`。
- 设置页头部返回按钮（原指向 `#/list`）一并移除（`settings.js` 的 `back-btn` / `goBack`）。
- `src/views/model_list.js` **文件保留但不再被任何路由引用**（模型下载/管理 UI 在 ADMX 内不可达，
  模型运行时依赖的 Rust 命令 `fetch_model_list` / `scan_local_models` 等不受影响）；
  保留是为了降低后续合并上游的冲突面，不要恢复 `/list` 路由。

## 自升级链路（重要）

`pages/index.rs` 的 `check_update` 中 `has_update` **恒为 `false`**：官方更新源
`https://adm.tuduoduo.top/update.json` 的 app_url 指向原版 ADM 安装包，若照常静默下载
（启动 3 秒后的 `checkForUpdate(true)`）会把 ADMX 自升级覆盖成原版 ADM。
`update.json` 仍用于 VC++ 运行库检测与 llamacpp 运行时更新检查，这两条链路保持不变
（详见 [rust-backend.md](rust-backend.md) 自升级一节）。

## 打包注意（Windows 本地 Git Bash 环境）

Git Bash 下静默安装 NSIS 包时，裸传 `/S` 会被 MSYS 路径转换吞掉（安装器进交互模式挂起等点击），
需走 cmd 包装：`cmd //c "ADMX_0.8.3_x64-setup.exe /S"`。

`scripts/prepare-agent-binary.mjs` 用 `execFileSync("tar", ...)` 解压 adm-binaries 的 zip：
在 PowerShell / CI 里解析到 System32 的 bsdtar（支持 zip），在 Git Bash 里会解析到
GNU tar（不支持 zip，报 status 128）。本地 Git Bash 打包前手动解一次即可：
`/c/Windows/System32/tar.exe -xf adm-binaries/admAgent_*_Windows_x86_64.zip`，
把 `admAgent.exe` 放到 `src-tauri/binaries/admAgent-x86_64-pc-windows-msvc.exe`
并 touch 刷新 mtime，`prepare-agent-binary.mjs` 的增量跳过逻辑会自动放行。

### 本机无 MSVC Build Tools 时的 GNU 构建配方

本机若未装 VS Build Tools（无 `link.exe` 与 Windows SDK），msvc 目标无法链接
（`link: extra operand ...` = Git Bash 把 `link.exe` 解析到 GNU coreutils 的 `link`）。
已装 WinLibs mingw64（WinGet `BrechtSanders.WinLibs.POSIX.UCRT`）时可改走
windows-gnu 目标全量构建，两处配套改动已入库：

1. `src-tauri/build.rs`：`/SUBSYSTEM:WINDOWS`（MSVC 语法）按 `CARGO_CFG_TARGET_ENV`
   区分，gnu 目标改发 `-Wl,--subsystem,windows`，否则 mingw ld 把整串当文件名找。
2. `tauri.conf.json` 顶层 `mainBinaryName: "ADMX"`，让主二进制不叫 `adm.exe`。

构建命令（Git Bash）：

```bash
export PATH="/c/Users/dds/AppData/Local/Microsoft/WinGet/Packages/BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe/mingw64/bin:/c/Windows/System32:$PATH"
export RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu   # 关键：宿主工具链也切 GNU，否则 build script 仍用 msvc 链接
pnpm tauri build --target x86_64-pc-windows-gnu --bundles nsis
```

产物：`src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/ADMX_<版本>_x64-setup.exe`。
gnu 链接时有 `.rsrc merge failure: multiple non-default manifests` 警告（tauri-winres 与
rustc 各嵌了一份 manifest），实测不影响启动，可忽略。上游 CI 仍走 msvc（`pnpm tauri:build:windows`），
本配方仅用于本机无 MSVC 时的本地打包与端到端验证。

## 端到端验证记录（2026-11-14，ADMX 0.8.2 x64 NSIS）

静默安装（`/S`）→ 启动 → 截图核对：窗口标题 `ADMX`；标题栏/任务栏为紫色 ADMX 图标；
底栏仅 设置 / Agent / 技能管理 三项（Agent 高亮为默认页）；admAgent sidecar 随主程序
拉起（`%LOCALAPPDATA%\ADMX\admAgent.exe`），Agent 会话实际跑通一轮模型对话；
Agent 运行中点其它菜单被 `navigateTo` 的 agentBusy 拦截正确弹提示；空闲后进设置页，
头部无「返回」按钮；卸载注册表项为 `HKCU\...\Uninstall\ADMX`（`DisplayName=ADMX`），
与原版 ADM（`%LOCALAPPDATA%\ADM`、`adm.exe`）完全共存不冲突。

## 端到端验证记录（2026-11-25，ADMX 0.8.3 x64 NSIS 重打包覆盖安装）

源码相对 2026-11-19 的 0.8.3 无改动（`git status` 仅文档变更），仍走上面的 GNU 配方
（本机无 MSVC `link.exe`）：`pnpm tauri build --target x86_64-pc-windows-gnu --bundles nsis`，
产物 `src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/ADMX_0.8.3_x64-setup.exe`。
PowerShell 下静默覆盖安装直接 `Start-Process <setup> /S -Wait` 即可（cmd //c 包装只在 Git Bash 需要）。

- **sidecar 修复**：安装前 `%LOCALAPPDATA%\ADMX` 的 `admAgent.exe` 已被此前的 0.9.x 原生实验归档
  （只剩 `admAgent.exe.sidecar-archived-0.9.0.bak`，等于 Agent 链路是断的）；重装后 `admAgent.exe`
  恢复，哈希与 `src-tauri/binaries/admAgent-x86_64-pc-windows-gnu.exe` 一致。
- **安装件与构建产物的 3 字节差异属正常**：安装后的 `ADMX.exe` 与
  `target/.../release/ADMX.exe` 只差 `BUNDLE_TYPE_VAR_NS` / `BUNDLE_TYPE_VAR_UNK`
  （tauri-bundler 的 bundle 类型补丁，安装包版写 NS）。源码未变时构建确定性复现，
  哈希与 2026-11-19 的安装件逐字节相同，不要因为哈希不一致就判定“没打进去”。
- UI 核对（UIA）：窗口标题 `ADMX`；底栏 设置 / Agent / 云端模型 / 技能管理；自动加载
  `config.json` 的默认工作区；8 个 skill 全部「已加载」；状态栏 Token / 工具调用 / 交互轮次正常。
- Agent 端到端：UIA 向输入框写入一条短消息并回车，`%LOCALAPPDATA%\admAgent\cache\admAgent.log`
  记录 `Loop step response ... finish_reason=stop`，UI 收到模型回复；`admAgent-panic.log` 仅新增
  `process start` 行，无 panic 栈。
- **坑（验证常驻进程时）**：从 agent 的 shell 工具里 `Start-Process` 拉起的 GUI 进程会随该命令结束
  被进程树回收而退出（用一个 `ping -n 40` 对照即可复证），会误判成“应用启动即退出”。
  验证要用 `Invoke-CimMethod -ClassName Win32_Process -MethodName Create` 这类分离启动方式。
  另外本应用挂了 `tauri_plugin_single_instance`，第二个实例只会聚焦第一个然后退出，验证时不要重复拉起。

## 服务端基线与桌面端接口对齐（2026-11-26）

- **ADMX 应用版本基线**：`src-tauri/tauri.conf.json` 从 `0.8.3` 升至 `0.8.4`。
- **Windows sidecar 包基线**：`adm-binaries` 远端 main 提供 `admAgent_0.4.7_Windows_x86_64.zip`；其中 `go version -m` 报告模块版本实际为 `v0.4.8-0.20261123042035-0a9d8a6c6be1+dirty`（go1.26.4），包名 `0.4.7` 与模块伪版本须区分记录。
- `scripts/prepare-agent-binary.mjs` 将该二进制打入 `src-tauri/binaries/admAgent-x86_64-pc-windows-gnu.exe`。sidecar 包仍依赖 `adm-binaries` 仓库基线，不在本仓库提交二进制。
- `src/views/agent/tools.js` 接入 MCP runtime、LSP stop/diagnostics/restart 与 managed-LSP catalog/doctor/install/fix/uninstall/jobs/cancel。install/fix 采用 server plan → 显示版本/来源/许可证 → 用户确认 → `confirm:true` 二次请求，不自动执行计划。
- `src/views/agent/send.js` 接入 `!command` Bang shell 模式及 prompts queued/list 查询；普通消息不变，工作区 Agent 忙时拒绝 Bang shell 避免并发写冲突。
- `src/views/agent/session_tools.js` 加入侧栏「会话」tab，展示当前会话已读文件、文件快照历史与工作区用户消息，并可从历史快照显式调用 `filetracker/read`。
- `src-tauri/src/pages/agent.rs` 在应用真正退出的 `kill_agent_session` 路径回收其注册的 `/clients/{client_id}`；页面切换不触发客户端回收。
- **端点基线核对**：0.4.7 自带 Swagger 2.0 `/v1/docs/doc.json` 覆盖旧基础 API，但不声明 `/v1/lsp/{catalog,doctor,install,fix,uninstall,jobs}`、`/v1/analytics/events`、`/v1/models`、`/v1/models/status` 这组新增路由；managed-LSP 请求结构用隔离 scratch server 做只读/计划阶段验证，未执行安装/卸载。
- **明确不启用**：`/v1/analytics/events` 遥测暂不由 ADMX 调用（契约和隐私 payload 未公开）；`/v1/models*` 属 TUI/CLI 模型状态路由，ADMX 继续使用原生模型管理链路；hooks 是 admAgent 服务端内部机制（`builtin/admAgent-hooks` skill），没有 `/v1/hooks` HTTP endpoint。
- **构建/安装验证状态**：已在后续前端样式优化轮完成类型检查、GNU 生产构建、NSIS 覆盖安装与安装后交互验证，详见下节；未单独运行 `cargo check`，Rust 编译由生产构建覆盖。

## 工作区目录样式与渲染优化验证（2026-11-26，ADMX 0.8.4）

- **改动范围**：Tauri 桌面端目录树增加右键「打开文件夹」，由 `open_workdir_folder` 校验已登记的绝对目录后调用系统文件管理器；侧栏优化间距、层级、操作占位与焦点/滚动保留，消息和输入区统一圆角及主题变量，Markdown 代码围栏与行内代码避免二次转换，并支持有序/嵌套列表、引用与未闭合的流式代码。
- **编译**：`pnpm typecheck` 通过；GNU 工具链下 `pnpm tauri build --target x86_64-pc-windows-gnu --bundles nsis` 成功，生成 `src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/ADMX_0.8.4_x64-setup.exe`（23,830,717 字节）。仅见已有的 `.rsrc merge failure: multiple non-default manifests` 警告。
- **浏览器验证**：临时验证页直接导入真实前端模块，19 项检查通过，覆盖菜单位置/关闭/键盘、路径传递、目录 DOM 与滚动/焦点保留、代码原文和缩进、未闭合围栏、列表/引用/表格、HTML 转义/链接协议、流式列表及拖拽保护；另核对中文带空格目录传参，未触发 workspace 创建。窄窗口预览无横向溢出。
- **覆盖安装**：先确认安装实例就绪，备份旧主程序与配置，再 `/S` 静默覆盖 `%LOCALAPPDATA%\ADMX`；安装退出码 0，安装前后 `config.json` / `admAgent.json` 哈希一致。新主程序为 43,342,468 字节，与构建产物仅差 NSIS bundle 标记的 3 字节；sidecar 哈希与打包源一致。
- **安装版验证**：1440×800 WebView 中 9 项检查通过（菜单、目录路径、展开状态、关闭、不切工作区/会话、未登记路径拒绝、就绪、输入可编辑、无横向溢出）；系统 `Shell.Application` 确认资源管理器实际打开所选目录。侧栏 272px；初始化完成；panic 日志末尾无新增异常栈。验证后以正常模式重新启动，未更改全局 WebView 调试配置。

## 每轮统计栏与消息布局验证（2026-11-26，ADMX 0.8.4 再次覆盖）

- **改动范围**：`round_metrics.js` 汇总本轮消息，`render.js` 在轮正文后增加发起、结束（记录）、耗时、Token（文本估算）、工具调用和模型交互六项；折叠仍保留统计，运行中每秒更新耗时，短回复不再强制占满 200px，长回复可在轮内滚动到统计栏。服务端不提供单轮 usage，Token 明确带 `~` 和估算口径提示；历史结束时间按最后一条保存回复的更新时间计算，不声称精确计费或运行结束时间。
- **源码验证**：`pnpm typecheck` 与 `git diff --check` 通过；scratch 中 12 项纯统计边界检查通过，覆盖秒/毫秒/ISO、无效时间、跨分钟/小时、缺少回复、临时错误、图片数据不计文本、SSE 缓存失效及负耗时。真实模块浏览器验证 14 项通过，覆盖每轮/每项数量、正文后位置、折叠可见、估算提示、秒精度、运行计时、节点复用、选择保护、停止计时、长内容滚动与无横向溢出；另核对 720px 容器和浅色主题自动换行。
- **构建与覆盖**：GNU 配方生产构建退出码 0，生成 `src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/ADMX_0.8.4_x64-setup.exe`（23,831,401 字节）。覆盖前备份旧主程序和配置到当前 PI scratch，目标实例当时已退出；静默安装退出码 0。新主程序 43,342,276 字节、产品版本 0.8.4，与构建产物仅差已核实的 3 字节 NSIS bundle 标记；sidecar 与打包源哈希一致；`config.json` / `admAgent.json` 安装前后及对话验证后哈希均一致。
- **安装版真实对话**：1440×800 WebView 通过 11 项检查，原有 4 轮完整保留并新增 1 轮，真实模型回复「统计验证通过」，本轮记录为 09:21:42 → 09:21:50、8 秒、文本估算 `~68`、工具调用 0、模型交互 1；结束后恢复就绪，折叠统计可见，输入可编辑且无横向溢出。截图经原生 `Page.captureScreenshot` 保存并核对；再通过真实消息 API 读取该会话，确认统计可从落盘历史还原，未改变当前会话选择。
- **重启收尾状态**：安装版验证后用户另开新会话并开始运行；最终重启门禁读到 `busy:true`、草稿长度 0，因此没有关闭正在工作的应用。当前实例仍是仅进程级环境启用的临时 loopback CDP（127.0.0.1:9224）；未改全局环境或注册表。普通模式重启与端口关闭复验尚未执行，须等当前任务空闲后完成，不能把此前章节的普通启动结果当成本轮结果。

## 最新包覆盖更新与服务端同步基准（2026-11-26，ADMX 0.8.4 第三次覆盖）

- **源码范围**：`git HEAD` 仍是 `c013cc7`（`feat(agent): 完善桌面端工具接口与每轮统计展示`）；工作树只有文档 / 冻结资料类未提交项（`AGENTS.md`、`doc/adm-server-embedded-parity.md`、`desktop/`、`scripts/parity/`、`.knowstack/`、根目录遗留 `admAgent.exe`），`src/` 与 `src-tauri/src/` 相对 09:19 那次构建无改动。
- **服务端没有可重编的源码**：本仓库已无 `admAgent/` 目录，交付服务端只能是 `adm-binaries/` 里的 `admAgent_0.4.7_Windows_x86_64.zip`（2026-11-25 23:42 写入）；因此本次没有重编 sidecar，`prepare-agent-binary.mjs` 判定二进制已是最新并跳过解压。
- **类型检查与构建**：`pnpm typecheck` 通过；GNU 配方 `pnpm tauri build --target x86_64-pc-windows-gnu --bundles nsis` 退出码 0（`Finished release profile in 1m 05s`，仅既有 `.rsrc merge failure: multiple non-default manifests` 警告）。产物 `src-tauri/target/x86_64-pc-windows-gnu/release/ADMX.exe` 43,342,276 字节（SHA256 `CD1CA38A…`）、`bundle/nsis/ADMX_0.8.4_x64-setup.exe` 23,836,636 字节（SHA256 `9B68402A…`）。主程序与 09:19 那次字节数/哈希一致（源码未变的确定性复现）；安装器比上次大 5,235 字节，差异在 NSIS 打包侧（主程序逐字节相同），不影响安装结果。
- **覆盖安装**：安装前确认实例空闲（UIA 读到「就绪」且无「停止」按钮），把 `config.json`、`admAgent.json`、旧 `ADMX.exe` 与旧 `admAgent.exe` 备份到当次 PI scratch 的 `before-update/`，按 `ExecutablePath` 精确匹配后 `taskkill /T /F` 结束 `%LOCALAPPDATA%\ADMX` 的 ADMX + sidecar 进程树，`Start-Process <setup> /S -Wait` 退出码 0。安装后 `ADMX.exe` 43,342,276 字节、产品版本 0.8.4，与构建产物只差 3 字节（offset 23919723–23919725，即已核实的 NSIS `BUNDLE_TYPE_*` 标记）；`admAgent.exe` 与 `src-tauri/binaries/admAgent-x86_64-pc-windows-gnu.exe` 哈希一致（`FBFC2311…`）；`config.json`（`48C29CAF…`）与 `admAgent.json`（`F6853FCE…`）安装前后哈希均未变。
- **安装版验证**：用 `Invoke-CimMethod Win32_Process Create` 分离启动（`Start-Process` 拉起的 GUI 会被进程树回收）；窗口 `ADMX`（`Tauri Window`）UIA 读到「就绪」、底栏 设置 / Agent / 云端模型 / 技能管理、工作区 `%LOCALAPPDATA%\ADMX`、历史统计仍为交互轮次 8 / 工具调用 7（与安装前一致，会话数据未丢），输入框 `输入消息... (Enter 发送, Shift+Enter 换行)` enabled 且可写；`admAgent.exe` 随主程序自动拉起；9224 端口无监听（本次未开临时 CDP）。

### 服务端同步基准怎么记、怎么比

交付服务端只有在 `adm-binaries` 里才能换代，所以基准落成「可重跑的字段快照」，不写在散文里：

```powershell
pwsh -File scripts/server-baseline.ps1 -OutFile doc/admx-server-baseline.json
```

`doc/admx-server-baseline.json` 记录四组字段：

| 字段组 | 内容 | 变化含义 |
| --- | --- | --- |
| `app` | productName / version / identifier / git HEAD 与脏文件清单 | 桌面端换代 |
| `sidecar` | `adm-binaries` 包名·字节数·SHA256，打包二进制字节数·SHA256，`go version -m` 的模块路径 / 伪版本 / go 版本 | 交付服务端换代 |
| `installed` | 安装实例 exe 字节数·SHA256·产品版本，sidecar SHA256 及「是否等于打包源」 | 覆盖安装是否真的落地 |
| `embeddedServer` / `parityBaseline` | `desktop/internal/server` 文件数与内容树 SHA256、`capture-parity.ps1` 与 `parity_test.go` 的 SHA256、文档记录的 61 步 0 差异口径 | 冻结还原实现或对拍口径变了 |

对比方式：服务端更新（换 `adm-binaries` 包，或内嵌还原实现继续演进）后重跑同一脚本到 `$env:PI_SCRATCH_DIR`，
与仓库里的 JSON 逐字段 diff。脚本的目录树哈希按「相对路径:文件 SHA256」排序拼接后再取 SHA256，不依赖 mtime。
包名 `0.4.7` 与模块伪版本 `v0.4.8-0.20261123042035-0a9d8a6c6be1+dirty` 必须分开看：前者是打包脚本选包的版本号，
后者才是二进制真实来源（`go version -m`）。
