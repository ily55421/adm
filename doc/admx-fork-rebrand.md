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
