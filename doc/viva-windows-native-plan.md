# ADM Windows 原生桌面（Viva）迁移方案

> ⛔ **已弃用冻结（2026-11-25）**：原生 GUI 路线（ADMX/viva）整体退场，桌面 UI 回到 Web/HTML
> （Tauri 主线 `src/` + `src-tauri/`，唯一交付目标）。本文档作为历史方案与落地记录留档，
> 不再驱动新开发；详见根 `AGENTS.md` 硬规则 7 与 §18。

> 分析对象：`github.com/vivaui/viva`（commit `c5e8c41`，release 线 `v0.6.5`，Apache-2.0）。
> 目标：把当前 Tauri（Web 前端 + Rust 壳）形态的 ADM 桌面端，迁移为 **Windows 原生 Go 桌面**
> （Win32 + Direct3D 11 + DirectWrite，无 WebView、无捆绑运行时），macOS/Linux 暂不动。
> 约束：`admAgent/` 只读（硬规则 2），仅以 sidecar + HTTP API 方式复用。
> 状态：**P0-P4 已落地**（见文末「落地记录」）；0.8.7 补齐消息区高级交互 / 顶栏模型切换 /
> 会话删除与清除；0.8.8 修复消息区 flex 布局崩坏（§13，含布局规约）；0.8.9 消息窗口化 +
> 工作区按路径复用（§14）；0.8.10 修复真机冻结——Invalidate 画帧不上屏，回退限频
> resize 抖动 + mdCache 宽度容差（§15）；自动更新与 model_list 完整管理未做。

---

## 1. Viva 框架分析

### 1.1 定位与形态

- **Go-first、GPU 原生桌面框架**：应用通过平台自己的窗口与 GPU API 绘制——macOS 走
  Cocoa/Metal，Windows 走 Win32/D3D11，Linux 走 XCB/Vulkan。**没有 WebView、没有浏览器引擎、
  没有捆绑运行时**；系统库运行时动态加载（Windows 侧 purego），不链接、不分发任何微软运行时。
- 模块 `github.com/vivaui/viva`，`go 1.26.0`，依赖极少（go-winio、purego、go-bsdiff、
  go-toml/v2、x/sys、x/text）。本机 `go1.27.3` 满足版本要求。
- `viva` CLI（init/dev/build/package/doctor/form/feed/add）是独立命令，**不链进交付程序**；
  `viva init` 生成可运行工程（窗口 + 无窗口驱动测试 + viva.toml + AGENTS.md 编程模型说明）。

### 1.2 Windows 后端关键事实（决定可行性）

| 项 | 事实 | 对 ADM 的意义 |
| --- | --- | --- |
| 渲染 | Win32 窗口 + D3D11 retained 渲染，内嵌 DXBC shader；无 GPU 时回退 WARP | 不依赖独显；老旧机器可跑 |
| 文本 | DirectWrite 测量 + Direct2D 光栅化 label 纹理（按可见设备列裁剪） | 中文/等宽字体走系统字体（微软雅黑/Segoe UI），无需内嵌字体 |
| 输入法 | **IMM32，非 TSF**（候选框位置、再转换、子句样式不如 TSF） | 中文聊天输入可用；高级 IME 特性缺失，需真机验证 |
| 窗口材质 | Win11 22H2+ Mica / Mica Alt / Acrylic（DWM）；Win10 1809+ 旧 Acrylic；`Config.WindowBackdrop` 回调，`RtlGetVersion` 探测 | 一键获得 Win11 原生观感；Win10 自动退化为 ClearColor |
| 自定义标题栏 | `WindowCustomTitlebar`：透明标题栏、内容全高、`MovesWindow()` 声明拖动区、Viva 自绘最小化/最大化/关闭 + `TitlebarInsets()` 让位 | 可复刻 ADM 现有顶栏 + 硬件栏的一体式外观 |
| 构建 | 跨编译 amd64/arm64；Windows 默认 CGO_ENABLED=0；**不需要 Windows SDK 头文件或 Windows App SDK 运行时；不需要 VC++ 运行库** | CI 构建简单；可去掉现有 `check_vc_redist` 启动预检 |
| 体积 | hello 程序 Windows amd64 **3.1 MB**（`-trimpath -ldflags='-s -w -buildid=' -H=windowsgui`） | 单 exe，对比 Tauri 包 + WebView2 运行时依赖是数量级差距 |
| 打包 | `viva package` 出 NSIS 安装器（Windows）；`viva feed` 签更新 feed | 与现有 NSIS 发布链路同形态 |
| 成熟度 | README 标注 "Experimental Windows shell"；有平台单测 + Wine/DXVK 冒烟 + 真机 Win11 一致性场景 | 可投产但必须留真机验证清单（见 §6） |

### 1.3 编程模型（与 Web 思维差异最大，务必先读）

- 窗口内容是一个**页面函数** `func (m *model) page(c ui.C)`，每次可能改变画面的事件后重跑；
  **没有 DOM、没有 CSS、没有帧循环**（事件驱动重绘，静止时零 GPU 工作）。
- 状态全部在 model 结构体；**点击在控件声明处处理**（`if ui.Button(c, "x").Clicked() { ... }`）；
  改列表要 `c.After(func(){ ... })`。
- 布局是链式声明：`ui.Row/Column/Stack/Grid/Flow/Scroll` + `Pad/Gap/Grow/Width/Items/Justify`；
  所有长度是 `float32`。
- 后台工作用 `ui.Effect`（带 key、可取消），**不要手起 goroutine 碰窗口**；跨线程结果经
  `app.Invalidator` + `Config.OnWake` 回到窗口线程。
- 控件直接绑定 model 字段：`ui.TextField(c, &m.msg, "消息", "输入…")`、`ui.Switch(c, &m.x, "")`、
  `ui.Choice(c, &m.tab, tabs, nil)`、`ui.List(c, &m.list, n, func(row ui.ListRow){…})`。
- 测试：`app.NewDriver(page.Config(config()), nil)` 无窗口驱动真实应用（Click/Type/Key/
  Scroll/Resize + Snapshot 读标签）；`vivahead` 构建 tag + `VIVA_HEADLESS=1` 可跑
  `layout/tree/click/expect/shot` 无头检查。
- `viva vet` 静态查"能编译但做错"的页面积法（未加 Key 的列表按钮、Memo 脏读等）。

### 1.4 组件与系统能力覆盖

- **~150 个 shadcn 风格组件**（`ui.*` 与 `components.*`）：Button/Input/TextArea/Select/
  Combobox/Checkbox/Switch/Slider、Table（排序/固定头）、Tree、List、Sidebar、Tabs、Command
  （命令面板）、Dialog/Sheet/Drawer/Popover/Menu/ContextMenu、Toaster、Menubar、Calendar、
  Chart、Accordion、Card、Badge、Avatar、Progress/Spinner、Skeleton……
- **与 ADM 聊天界面直接相关的三件套**：
  - `components.MarkdownView`：retained markdown，流式更新、选择/复制、图片回调
    （`MarkdownLook.Image`）、围栏代码块 + **可插拔逐行高亮**（`Highlight func(language, line string, dst []MarkdownCodeRun)`，
    类 = Comment/String/Number/Keyword/Function/Variable/Flag/Key/Added/Removed）。
  - `components.CodeDiff` / `CodeEditor`：工具调用 diff、代码查看的内建方案。
  - `components.MessageScroller` / `ui.Scroll(...).Follow(true)`：聊天气泡流的滚动/跟随。
- 系统能力：托盘与通知区（`AddStatusItem` + `WindowPanel` 弹窗）、全局快捷键、
  Credential Manager 密钥存取（`app.StoreSecret`）、防休眠、系统代理解析（WinHTTP PAC/WPAD）、
  文件拖放（`OnFileDrop`）、剪贴板（文本/HTML/图片/文件）、文件图标、Mica/Acrylic、
  UI Automation 无障碍树、**可选 WebView2 托管**（`Config.Web` + `ui.Slot.NativeView`，
  打开第一个页面前不加载任何东西）。
- 自动更新：`update` 包读 Ed25519 签名 feed，校验长度 + SHA-256，交 NSIS 安装器执行。

---

## 2. ADM 前端现状与迁移面盘点

### 2.1 现状

- 桌面端 = Tauri：`src/`  vanilla JS SPA（无框架）+ `src-tauri/` Rust 壳（约 85 个
  `#[tauri::command]`，核心页 `pages/agent.rs` 4659 行、`ilink.rs`、`docker_model.rs`、
  `model_list.rs`、`skills.rs`、`index.rs`）。
- 路由仅三个：`/agent`、`/settings`、`/skills`（`model_list.js` 保留但无路由引用）。
- 外壳（`src/index.html` 1411 行）：左侧导航、底部硬件栏（内存/显存/CPU + GPU 下拉）、
  启动自检（VC++ 运行库、应用更新检查/下载/安装、llamacpp 运行时检查/下载/重装）、
  中英 i18n（`src/i18n.js` 936 行）。
- Agent 视图（`src/views/agent/*`，约 20 个模块）：会话列表、轮次分组、消息 parts 渲染
  （text/thinking/tool call/decision/system info）、markdown 流式（`render.js` 1257 行 +
  `template.js` 2278 行样式）、附件（`attach.js`）、PDF 分批（`pdf_batch.js` + vendor/pdf.js）、
  权限请求（`permission.js`）、撤销（`undo.js`）、工作区树（`ws_tree.js`）、决策模式
  （`decision_mode.js`）、压缩（`compact.js`）、项目记忆（`memory.js`）。
- 事件通道：`agent_subscribe_events` 把 admAgent 的 SSE 桥接到前端事件（`sse.js` 853 行，
  含 run_complete 丢失兜底等稳定性逻辑）。
- sidecar：`admAgent.exe` 由 NSIS 装在 ADM.exe 旁；配置
  `%LOCALAPPDATA%\admAgent\admAgent.json`；HTTP API 契约以 `doc/server-api.md` 为准。

### 2.2 迁移面结论

- 前端大量 `invoke` 其实是 admAgent HTTP API 的转发（`agent_http_request`、
  `fetch_skill_store`、`install_skill`、`list_mcp_servers`、`list_installed_skills`…）。
  **迁到 Go 后这些转发层整体消失**，直接 `net/http` 调本地 server。
- Rust 层真正不可替代的只有：sidecar 生命周期管理、设置存储、剪贴板/文件对话框/拖放、
  自更新、VC++/llamacpp 预检与下载、docker 模型管理、ilink 桥。这些在 Go + viva 下都有
  对应原生能力（exec + viva 的 clipboard/files/update/secret/tray）。
- **可删除的前端依赖**：pdf.js（1.8MB vendor）、整套 DOM/CSS 渲染层、Tauri IPC 桥。

---

## 3. 现有 UI → Viva 映射表

| ADM 现有实现 | Viva 原生方案 | 备注 |
| --- | --- | --- |
| hash 路由 + 左侧导航（Agent/设置/技能） | `ui.Sidebar` 或左侧 `ui.List` + `switch m.view` 单窗切换；或 `ui.Tabs` | 单窗口多视图即可，不需要多 window |
| 自定义顶栏 + 硬件栏（RAM/VRAM/CPU/GPU） | `WindowCustomTitlebar` + `MovesWindow()` 行 + `ui.Row/Text`；GPU 信息经 sidecar/系统查询 | Win11 圆角与边框色用 `WindowBorderColor` 接缝 |
| 启动自检遮罩（VC++/更新/llamacpp） | 启动时在 model 里跑检查，`ui.Modal` + `ui.Progress(...).Indeterminate()` 展示 | VC++ 检查可删（viva 不需要 VC++ 运行库） |
| 自更新（Tauri updater） | `update` 包 + `viva feed` 签名的 Ed25519 feed，NSIS 安装 | **需新建 feed 与签名密钥**，与旧 updater 不兼容 |
| i18n（zh/en 词典 + t()） | Go `map[string]string` + `t(key)`；语言随设置持久化 | 936 行词典可直接翻译成 Go 字面量 |
| 会话列表（session.js） | `ui.List(c, &m.sessions, n, …)`：`Selected()/Changed()/Submitted()`、typeahead、`ScrollIntoView` | 行用 `c.KeyInt(conv.ID)` 保焦点 |
| 消息流 + 轮次分组（render.js） | `ui.Scroll(...).Follow(true)` + 每轮 `ui.Column`；气泡 = 带 `Background/Radius/Pad` 的容器 | 长列表用 `components.MessageScroller` 或 List 虚拟化 |
| markdown 流式渲染（自制） | `components.MarkdownView` + `Highlight` 回调接入 Go 语法高亮 | 高亮器可自写轻量 lexer 或引 chroma（二选一，需评估体积） |
| 工具调用 diff 展示 | `components.CodeDiff`（含 inline 变体） | 新增/删除行有内建配色 |
| thinking 折叠、tool 卡片 | `components.Accordion` / `Collapsible` + `Card` | |
| 权限请求 / 决策模式（Choice/Bool/Score） | `ui.Modal` + `ui.Choice`/`ui.Switch`/`ui.Slider` | Modal 自带 Esc/遮罩/焦点归还 |
| 输入框（Enter 发送、Ctrl+Enter 换行、停止） | `ui.TextArea(c, &m.draft, "消息", "输入…").Height(…)` + `.Submitted()`；Ctrl+Enter 用 `ui.Shortcut(c, ui.Primary, "enter")` 或 `Config.OnShortcut` | IME 中文输入走 IMM32，需真机验证候选框 |
| 附件（粘贴/选择/拖放） | `Config.OnFileDrop` + 剪贴板文件读取 + `app` 文件 API | 保存落盘后把路径交给 server |
| PDF 附件预览（pdf.js） | 方案 A：`Config.Web` 托管 WebView2 跑 pdf.js（按需加载）；方案 B：调用系统默认程序打开 | 推荐 B 先行，A 作增强 |
| 设置页（settings.js） | `ui.FormField`/`TextField`/`Switch`/`Select` + `go tool viva form`（结构体 tag 生成表单） | 保持写 `%LOCALAPPDATA%\admAgent\admAgent.json` 兼容现有配置 |
| 技能商店 / MCP 管理（skills.js） | `ui.List`/`ui.Table` + 安装进度 `ui.Progress` + `ui.Toaster` 通知 | 直接调 server HTTP API |
| 托盘 / 最小化到托盘 | `Application.AddStatusItem` + `WindowPanel` | Windows 通知区 |
| 全局快捷键 | `Config.OnShortcut` / `ui.Shortcut` / 全局快捷键 API | |
| 调试日志（agent_debug_log） | Go 侧直接写 `adm_api_debug.log`（沿用现有标记约定） | 不再经 IPC |
| docker 模型管理 / ilink 桥 | Go exec + HTTP，逻辑从 Rust 平移植 | 纯 Go 无外部依赖 |

---

## 4. 分期实施（Windows 优先）

> 粗估按"熟悉 viva 编程模型的全职工程师"计；每期结束都有可运行、可验证的增量。
> 新工程建议放仓库顶层新目录 `desktop/`（独立 go.mod，`require github.com/vivaui/viva v0.6.5`，
> `tool` 线固定 viva 版本）。**不要放进 `admAgent/`**（只读），也不要混改 `src/`+`src-tauri/`
> （硬规则 1：未经明确指示不混改两端）。

### P0 骨架与壳层（约 2-3 天）

1. `desktop/` 新模块 + `viva init`；接 `app.RunApplication` + `ui.OpenWindow`。
2. `WindowCustomTitlebar` + 深色 `gfx.DarkTheme()` + `WindowBackdrop` 返回 `BackdropMicaAlt, Dark: true`
   （Win11 22H2+；其余平台/版本自动退化，需给不透明 `ClearColor` 兜底）。
3. 左侧导航三视图（Agent/设置/技能）+ 底部硬件栏 + 顶栏 `MovesWindow()`。
4. sidecar 管理：定位 exe 旁 `admAgent.exe`（与 NSIS 现有布局一致）→ 启动 → 轮询
   `/status`（契约见 `doc/server-api.md`）→ 关闭时结束进程；配置目录沿用
   `%LOCALAPPDATA%\admAgent`。
5. 设置读写：`load_settings/save_settings` 的 Go 实现，保持 JSON 结构兼容。

**验证**：`go test ./...`（driver 驱动无窗口）+ `viva dev .` 真机看材质/标题栏/DPI。

### P1 Agent 对话核心（约 1-2 周）

1. SSE 客户端（`net/http` + `bufio` 逐行读 `event:/data:`），事件分发对照 `sse.js` 迁移，
   **保留 run_complete 丢失兜底**与增量日志降频。
2. 会话 List + 消息流（Scroll + Follow(true)）+ 轮次分组 + 用户/助手气泡。
3. `MarkdownView` 流式追加 + 代码高亮回调；复制（`SelectedText`）。
4. 输入区：TextArea、Enter 发送、停止按钮、`ui.Toaster` 错误提示（沿用 `error.js` 的
   友好错误分类）。

**验证**：真实模型对话一轮完整流程；无头 `expect text "…"` 脚本。

### P2 工具调用与交互完备（约 1 周）

tool call 卡片（参数/结果折叠）、`CodeDiff`、权限请求 Modal、决策模式（Choice/Bool/Score）、
thinking 折叠、附件（拖放 + 粘贴 + 选择）、ws 树、撤销入口。

### P3 设置 / 技能 / 模型（约 1 周）

设置表单页（`viva form` 或手写 FormField）、技能商店（安装/卸载/进度）、MCP 管理；
`model_list.js` 若重新启用再做模型管理页（docker 流程平移）。

### P4 系统集成（约 3-5 天）

托盘 + 面板、全局快捷键、硬件栏真实数据、剪贴板图片、`update` 包接入（新建 Ed25519
feed；NSIS 安装器与现有发布脚本对齐）、PDF 预览方案 B（外置打开）。

### P5 打包与发布（约 3-5 天）

`viva build --target windows --arch amd64`（release：trimpath/stripped/固定 buildid，
记录体积）；`viva package` 出 NSIS；CI 作业（Go 1.26+，CGO_ENABLED=0，无需 mingw）；
更新 feed 签名与托管；双轨并存（Tauri 版继续服务 macOS/Linux，Windows 用户切原生版）。

---

## 5. 风险与注意事项

1. **Windows 后端仍是 Experimental**：必须在真机 Win11 走查——IMM32 中文候选框位置与行为、
   焦点丢失/恢复、关闭拦截（`OnCloseRequest`）、多显示器 DPI/缩放、WARP 回退路径、
   自定义标题栏拖动区与窗口按钮避让。
2. **无原生应用菜单**：Windows 上用窗口内 `components.Menubar` 复刻菜单（平台契约如此，
   不是缺陷）；toast 是气球提示（真 toast 需要带 AppUserModelID 的快捷方式）。
3. **arm64**：可跨编译，但 UI Automation 浮点 thunk 仅 amd64；arm64 宣传需谨慎。
4. **自动更新体系更换**：Ed25519 feed 与 Tauri updater 不兼容；密钥管理与回滚策略要新建。
5. **编程模型迁移成本**：团队从 DOM/CSS 转到"页面函数 + model + ui.Effect"需要适应期；
   `viva vet` + driver 测试 + 无头 `expect` 三段检查要进日常循环，否则容易出现
   "能编译但行为错"（未加 Key 的列表、Memo 脏读等）。
6. **共享边界**：与 Tauri 版唯一共享物是 admAgent HTTP API 契约与配置文件格式；
   两边 UI 完全分叉，后续功能先 Windows 原生、后回补 Tauri（或反向），需在
   `doc/conventions.md` 的同步映射表里登记该分叉。
7. **版本 pin**：`go.mod` 用 `tool` 线固定 viva 版本并锁 `v0.6.5`；升级前读
   `docs/upgrading.md`。
8. **性能预期**：事件驱动重绘 + retained 场景，空闲零 GPU；但页面函数每次事件全量重跑，
   大规模列表要用 `ui.List` 虚拟化，不要把 10k 节点塞进 `Children`。

---

## 6. 真机验证清单（每期收尾跑一遍）

```powershell
# 构建与无窗口测试
cd desktop
go test ./... -count=1
go vet ./...
go run ./cmd/viva vet
viva build --target windows --arch amd64

# 无头画面检查（另开终端）
go build -tags vivahead -o $env:PI_SCRATCH_DIR\adm-headless.exe .
$env:VIVA_HEADLESS = "1"; $env:HOME = $env:PI_SCRATCH_DIR
& $env:PI_SCRATCH_DIR\adm-headless.exe   # stdin: layout / tree / texts / click "发送" / expect layout clean
```

真机项：中文 IME 输入与候选框、Ctrl+Enter 换行、Enter 发送、拖文件进窗口、
Mica Alt 深浅切换、窗口按钮避让、最小化到托盘与恢复、关闭时 agent 运行中的确认、
更新安装（NSIS）、125%/150% DPI。

---

## 7. 参考

- viva 仓库与文档站：`github.com/vivaui/viva` / `vivaui.dev`（中英站）。
- 仓库内关键文档（clone 后阅读）：`README.md`、`docs/conformance.md`（Windows 能力边界）、
  `docs/windows-materials.md`、`docs/windows-text-editing.md`、`docs/web-views.md`、
  `docs/updating.md`、`cmd/viva/initfiles/AGENTS.md.txt`（编程模型全文，迁移前必读）、
  `examples/guides/{hello,page,windows,webview,background}`。
- ADM 侧契约：`doc/server-api.md`（HTTP API）、`doc/frontend-architecture.md`（现前端结构）、
  `doc/conventions.md`（调试日志与文档同步映射）。

---

## 8. 落地记录（2026-11-18）

### 8.1 落地形态

新增 `desktop/` 独立 Go 模块（`module adm.desktop`，`require github.com/vivaui/viva v0.6.5`，
`tool` 线固定 viva 版本），入口 `desktop/cmd/admx`，业务在 `desktop/internal/adm`：

| 文件 | 职责 |
| --- | --- |
| `settings.go` | 与 Tauri 版同一份 `config.json` 的读写；候选路径 = exe 目录 → `%LOCALAPPDATA%\ADMX|ADM` → Tauri 数据目录 |
| `client.go` | 命名管道 HTTP 客户端（`github.com/Microsoft/go-winio` 拨 `\\.\pipe\admAgent-<sid>.sock`）+ SSE 逐行解析 |
| `sidecar.go` | 定位 `admAgent.exe`、`server [--cwd]` 子进程（`CREATE_NO_WINDOW`）、健康轮询、退出清理 |
| `model.go` | 全部状态：服务端数据 mutex 保护并快照给页面，UI 状态仅窗口线程；`app.Invalidator` 唤醒 |
| `shell.go` | 页面函数：自定义标题栏（`TitlebarInsets` 避让窗口按钮）、左侧导航 + 会话 `ui.List`、底部硬件栏（`GlobalMemoryStatusEx`） |
| `agent_view.go` | 消息流（`ui.Scroll.Follow(true)` + 气泡）、Markdown（`components.MarkdownView` + 自研逐行高亮）、tool_call/tool_result/thinking 卡片、权限请求条、输入区（`ui.TextArea` + `ui.Shortcut(Primary,"enter")`） |
| `settings_view.go` / `skills_view.go` | 设置表单（`ui.FormField`/`TextField`/`Select`/`Switch`）、技能/MCP/LSP 状态列表 |
| `mdview.go` / `highlight.go` / `i18n.go` / `tray.go` / `sysinfo.go` | Markdown 排版缓存、语法高亮、中英文案、托盘图标与菜单、内存/CPU |

### 8.2 与方案的偏差

- **依赖获取**：github.com 直连不通，但 Go module proxy 可用，因此 `go get` 直接拉 `v0.6.5`；
  v0.6.5 的 `ui` 包没有 `ui.OpenWindow`，改用 `ui.NewPage(...)` + `application.OpenWindow(page.Config(cfg), canvas)`。
- **输入发送**：`ui.TextArea` 的 Enter 是换行，发送走 `ui.Shortcut(c, ui.Primary, "enter")`
  （Ctrl+Enter），与最初映射表里"Enter 发送"的描述不同，placeholder 文案已同步。
- **SSE 断线**：`ReadSSE` 在 EOF 时返回 nil，重连策略在 `sseLoop`（1.5s 退避），
  前端原有的 run_complete 兜底未移植（服务端每轮精确一次 run_complete，暂以 agent_finished + run_complete 双信号收尾）。
- **未做**：自动更新（`update` 包 + Ed25519 feed）、`model_list` 视图、PDF 附件的 WebView2 托管、
  ilink 桥、docker 模型管理（仍在 Tauri 版）。

### 8.3 验证证据

- `go build ./...` / `go vet ./...` 通过；`go test ./... -count=1` 全绿，其中 `TestPageBuilds`
  用 `app.NewDriver` 无窗口驱动真实页面并点击三个导航。
- 无头自检：`VIVA_HEADLESS=1` 下 `texts` 输出标题栏/导航/会话/输入区/硬件栏全部文案，
  `layout` 报 **0 problems**；`click "设置"` 后设置页表单（语言/Provider/视觉模型/工作目录/推理强度/开关）渲染正确，
  Provider 与工作目录从安装目录 `config.json` 正确读入。
- 真机冒烟：程序启动后自动拉起 `admAgent.exe`，服务端日志可见 workspace 创建、goose 迁移、
  MCP 初始化与工具构建；关闭窗口后 sidecar 被清理。
- 打包：`viva package --target windows --arch amd64` 出 `admx-0.8.3-windows-amd64-setup.exe`
  （3.34 MiB，用户级安装），release 程序 9.95 MiB（Tauri 版为 41 MiB）。
- 覆盖更新：已备份 `%LOCALAPPDATA%\ADMX\ADMX.exe.tauri-0.8.2.bak`（41 MiB）并替换为原生版
  （9.95 MiB），sidecar/`config.json`/`.admAgent`/`llamacpp`/`models` 未动；安装版启动验证窗口标题
  `ADMX` 与 sidecar 拉起均正常。

### 8.4 遗留与下一步

1. 中文输入法（IMM32）候选框行为、125%/150% DPI、Mica Alt 明暗切换需真机走查（§6 清单）。
2. 自动更新：新建 Ed25519 密钥与 feed 托管，替换 Tauri updater。
3. `model_list` / docker / ilink 视需要从 Tauri 版平移。
4. 安装器未签名，SmartScreen 会告警；签名走 `scripts/sign-windows.ps1` 既有链路。

---

## 9. 可用性修复记录（2026-11-18 深夜，0.8.4）

用户反馈「新的 GUI 桌面空有壳，并不能真实可用」。定位与修复：

1. **根因：`Sessions` 解析失败静默中断启动**。服务端 `created_at` 发的是数字，
   桌面端按 `string` 解析 → `json: cannot unmarshal number` → boot 失败；
   而失败弹窗的开关字段恒为 false，用户只看到「● 错误」和空壳，看不到任何原因。
   修复：`Session`/`Message` 的时间字段改为 `any`（宽松类型，桌面端不展示）；
   失败弹窗改为按 `boot == BootFailed` 自动打开，并提供「重试」。
2. **启动链路补齐服务端契约 B.2 的步骤**：创建/复用工作区后调用
   `POST /v1/workspaces/{id}/agent/init`；`current-session` 前等待 SSE 流建立
   （`sseReady` channel，最多 3s），避免 404 client not attached。
3. **发送重试**：`POST /agent` 返回 coordinator not initialized 时先 init 再重发一次
   （与 Tauri 前端既有策略一致）。
4. **Shortcut 短路隐患**：`ui.Shortcut` 原先写在 `||` 右侧会被短路、偶尔不声明，
   改为先声明再判断，Ctrl+Enter 发送稳定。
5. **诊断日志**：新增 `%LOCALAPPDATA%\ADMX\adm-desktop.log`，记录 boot 每步、
   SSE 连接/重连、发送与消息加载，排查「壳能看但不能用」类问题不再靠猜。

验证：无头模式跑通「boot 就绪 → 点击发送 → 运行中 → agent 回复 OK → 已连接」全链路；
安装版（0.8.4）覆盖更新后 boot 0.4s 就绪、加载 90 条历史消息、sidecar 自动拉起。

---

## 10. 功能复原（2026-11-18，0.8.5）

针对「只有壳、不可用」的反馈，按 ADM（Tauri 版）界面逐项复原：

### 10.1 已复原

| ADM 界面元素 | 原生版实现 |
| --- | --- |
| 工作目录选择器（顶栏，可切换） | 侧栏顶部目录 chip + Popover 列表（来自 `agent_workdirs`），点击即 `POST /v1/workspaces` 建/复用工作区、重启 SSE、重载会话（`Model.SwitchWorkdir`） |
| 「＋ 新建会话」主按钮 | 侧栏主按钮 → `POST /sessions` + `current-session` |
| 对话记录（标题 / 时间 / 条数） | 会话项两行：标题 + `RelTime(updated_at)` · `message_count 条消息` |
| 工具面板 Skill / LSP / MCP 三 tab | 侧栏 tab + 列表（boot 就绪自动拉一次；LSP/MCP 带状态色点） |
| 底部导航（设置 / Agent / 云端模型 / 技能管理） | 侧栏底部四导航（含「云端模型」只读概览页） |
| 顶栏：模型 + 上下文 + 模式 + Token | `◆ codely-basic 1.0M` + 模式组（普通对话/Choice/Bool/Score，发送时带 `decision`）+ `Token used/max` |
| 状态栏：就绪 / 工作区 / Token / 工具 / 轮次 / 硬件 | 全部就位（工具数与轮次从消息列表派生，避免重复计数） |
| 任务清单面板 | 会话详情 `todos` + SSE `session updated` 驱动，进度条 + 勾选项 |
| 消息渲染 | 用户/助手气泡、Markdown（自研逐行高亮）、thinking、tool_call/tool_result 卡片、decision、空态 |

数据来源全部走既有 HTTP 契约：`GET /v1/workspaces/{id}/agent`（模型名/上下文窗口，
`model.name` 为空时回退 `model_cfg.model`）、`GET /v1/workspaces/{id}/sessions/{sid}`
（`message_count`/`todos`/`prompt_tokens`）、`GET .../skills|mcp/states|lsps`。

### 10.2 仍未复原（已知差距，需排期）

- **消息区高级交互**：0.8.7 已补 thinking 折叠 / 工具卡片折叠 / 复制按钮 / diff 着色 /
  权限请求完整参数卡片（见 §12）；剩余轮次折叠分组、拖拽分栏。
- **模型管理**：0.8.7 已补顶栏模型下拉切换（`GET /providers` → `config/model` →
  `agent/update`，见 §12）；剩余模型下载/删除/Docker 部署（`model_list` 页）。
- **会话操作**：0.8.7 已补单击选中修复、单会话删除、清除全部（确认弹窗），见 §12。
- **自动更新**：Ed25519 feed 未接，仍靠手动覆盖更新。
- **云端 Provider 配置**：API Key 写入（`config/provider-key`）未接。

### 10.3 验证

无头模式 `texts` 确认：工作目录 chip、新建会话按钮、会话项「11 分钟前 · 90 条消息」、
Skill 列表（admAgent-config / git-commit / jq）、`codely-basic 1.0M`、`Token 0/1.0M`、
状态栏（已连接 / 工作区 / 工具 / 轮次 / 内存 / CPU）全部渲染，`layout 0 problems`。
安装版（0.8.5）覆盖更新后启动正常，boot 0.5s 就绪并拉到全部上述真实数据。

---

## 11. 「连接中…卡住」问题处置（2026-11-18，0.8.6）

用户两次反馈「界面全空 / 一直连接中」。排查过程与结论：

### 11.1 排查发现

1. **此前所有自测都是「复用已运行的 admAgent」**（`adm.exe` 即 ADM Tauri 版在后台
   守护 admAgent，父进程 = adm），因此没覆盖到冷启动路径。
2. 单独验证冷启动（杀掉 ADM 与 admAgent 后再启动 ADMX）**成功**：ADMX 自己拉起
   admAgent，1.3s 就绪。也就是说启动路径本身可用。
3. **真实风险是双实例互抢**：ADM 与 ADMX 各自守护 admAgent（同一命名管道
   `\\.\pipe\admAgent-<SID>.sock`、同一数据目录），后启动的实例会监听失败，
   先启动的也可能被对方的守护循环反复重启——用户看到的就是这个窗口里的
   「连接中…」与空数据。

### 11.2 已加防护（0.8.6）

- **不重复启动**：pipe 探测失败时，若已有 `admAgent.exe` 进程在跑（任何目录），
  只等待其就绪（30s），绝不启动第二个实例（`AgentProcessRunning` + tasklist 探测）。
- **分阶段状态**：标题栏从单一「连接中…」细化为「正在连接服务… / 正在启动服务… /
  正在挂接服务… / 正在加载会话…」，卡住时能看出卡在哪一步。
- **更快失败 + 明确恢复**：等待超时 60s → 30s；失败弹窗带原因与「重试」。
- 诊断日志 `%LOCALAPPDATA%\ADMX\adm-desktop.log` 记录 boot 每步。

### 11.3 使用建议

**不要同时运行 ADM（Tauri 版）与 ADMX（原生版）**——两者会争抢同一个 admAgent
实例。只用其中一个；确需同时用时，先在 ADM 里退出再启动 ADMX。

### 11.4 仍未解释的现象

在本机按「ADM 在跑 + ADMX 冷启动」「全部杀掉后 ADMX 冷启动」「admAgent 重启间隙
启动 ADMX」三种场景复现，boot 均成功（0.8.6 已加双实例防护）。若用户仍遇到
「连接中」超过 30s，请把 `adm-desktop.log` 与「任务管理器里 admAgent.exe 的
父进程」发来，即可定位是哪个程序在守护 admAgent。

---

## 12. 消息区交互、模型切换与会话操作（2026-11-18，0.8.7）

### 12.1 新增功能

| 功能 | 实现 |
| --- | --- |
| 顶栏模型下拉切换 | 模型 chip 点击 → Popover：本地模型 + `GET /providers` 云端模型（📷/上下文窗口标注，当前模型 ●，上限 24 条）→ `POST config/model`（scope 0，带 reasoning_effort / temperature）→ `POST agent/update` 重载 → 刷新 AgentInfo；`agent_default_provider` 持久化（key 与 Tauri 版一致：`local` / `provider/model`），失败回滚本地选择 |
| thinking 折叠 | 默认收起一行「💭 思考过程 ▸」，点击展开全文（截断 4000 字） |
| 工具卡片折叠 | tool_call / tool_result 头部点击折叠/展开；内容 >800 字符默认折叠 |
| diff 着色 | unified diff 检测（`diff --git` / `@@` / `---` `+++` 文件头 / 同时存在 +/- 行）→ + 绿 / - 红 / @@ 主色按行渲染；收起显示前 8 行，展开上限 200 行 |
| 复制按钮 | 助手消息尾部「⧉ 复制」（汇总全部 text part）；工具结果卡片头部 ⧉（`app.SetClipboardText` + toast） |
| 权限请求卡片化 | 完整 command 换行展示（不再截断）+ reason + 工具名徽标，允许/跳过右置 |
| 会话单击选中 | **修复**：原来用 `Submitted()`（双击/Enter 语义），单击只高亮不切换；现在 `Changed()` 单击即选 |
| 会话删除 | 列表行 ✕ → `DELETE /sessions/{sid}`；删当前会话自动切相邻或新建 |
| 清除全部 | 「清除全部」→ 确认弹窗 → 逐个删除当前工作区会话 → 新建会话 |

### 12.2 boot 链路修复（本轮无头测试暴露的真实缺陷）

1. **SID 依赖 `whoami /user` 外部命令**：PATH 里先出现 POSIX whoami（Git Bash 环境）时
   SID 取空 → 只探测 `admAgent.sock` 兜底管道，而 admAgent 监听 SID 管道 → 永远等不到
   就绪，表现为「正在启动服务…」30s 后失败。改为 `windows.OpenCurrentProcessToken()`
   直读进程 token（`TestPipeCandidates` 锁定回归）。
2. **等待就绪只盯第一个候选管道**：启动自家 sidecar / 等待已有实例都只探测
   `PipeCandidates()[0]`，server 实际监听另一个候选时会假性超时。改为 `WaitReadyAny`
   每轮询一遍全部候选，任一健康即采用。
3. **真机流式输出不重绘**：看门狗指纹只含消息条数，流式增量只改内容不改条数 →
   真机上流式文本冻结在首帧（v0.6.5 Invalidate 失效 + 看门狗补偿架构下的盲区）。
   指纹加入 `messageFootprint`（全部消息文本体量）。

### 12.3 验证

- `go build` / `go vet` / `go test` 全绿（13 个，新增驱动级 `TestMessageInteractions`：
  thinking 默认折叠→点击展开、短 diff 行渲染、长 diff 折叠 8 行→点击展开、长结果
  折叠、复制按钮）。
- 无头真实数据走查：boot 就绪 → 模型下拉（本地 + 4 个云端模型、当前 ● codely-basic）→
  90 条历史消息渲染（📤 卡片 + ⧉ 复制）→ 状态栏 `Token 162.8K/1.0M · 工具 44 · 轮次 7`，
  `layout` 0 problems。
- 活体诊断（`TestDiagLive`，`ADM_DIAG_LIVE=1`，默认跳过）：确认新 workspace id 下查
  旧会话，SessionDetail 返回完整 90 条消息——消息为空不是服务端问题，是无头脚本
  虚拟时钟竞态（见 §12.4）。
- 安装器 `desktop/build/admx-0.8.7-windows-amd64-setup.exe`（3.39 MiB）；已覆盖更新
  `%LOCALAPPDATA%\ADMX\ADMX.exe`（旧版备份 `ADMX.exe.native-0.8.6.bak`）。

### 12.4 踩坑记录

- **无头 `wait N` 是虚拟时钟，瞬间完成**：等待异步加载的内容必须用 `settle`（等画面
  静默）或 `waitfor`，不能靠 `wait` 睡过去——之前几次「消息区为空」的误判皆源于此。
- **快照标签值是整行文本**：diff 行 / 段落的 label 是完整字符串，测试断言要用前缀
  匹配（`containsPrefix`），不要拿短词做精确匹配。

---

## 13. 布局崩坏修复（2026-11-19，0.8.8）

用户反馈 0.8.7「布局太乱根本无法使用」：侧栏被挤成 ~50px（文字逐字换行）、消息气泡
塌缩成小方块（用户气泡只剩空色块）。无头 `shot` 截图复现了同样画面，定位到**两个
叠加的 flex 布局缺陷**：

### 13.1 根因

1. **气泡宽度靠 min-content，而 Markdown Slot 对宽度零贡献**。`MarkdownBlock` 是
   延迟绘制的 `ui.Slot`（FillWidth + 固定高），不参与气泡的内容测量；气泡又只有
   `MaxWidthPercent(84)` 上限——实际宽度塌到「最小内容宽」= 复制按钮宽（助手气泡
   ~90px）或纯内边距（用户气泡 ~28px），markdown 被画进几十像素的槽里。
2. **`ui.Paragraph` 的最小内容宽 = 最长不可断 token**。工具参数/结果里的压缩 JS
   一行（几百字符无空格）最小宽可达 ~2000px，沿 flex 链上传；viva 的 flex 沿 X 轴
   给容器默认 `shrink=1`（CSS 语义），固定宽度的侧栏被按比例挤没。

### 13.2 修复

| 修复 | 实现 |
| --- | --- |
| 侧栏永不收缩 | 侧栏 `Width + MinWidth + Shrink(0)`，分隔线 `Shrink(0)`——无论内容区发生什么，壳层布局不变形 |
| 助手气泡定宽 | 宽度在消息列层面一次算好（`contentWidth - contentPadX` 的 84%），气泡显式 `Width(bubbleMax)`，md Slot 宽度与测量严格一致（不再触发 paint 重排） |
| 用户气泡真文本 | 改用 `ui.Paragraph`（真实 min-content、按所得宽度换行），`MaxWidth(bubbleMax)` 兜底；不再走 Markdown Slot |
| 长文本逐行 Ellipsis | 新增 `boundedLines`：按行拆分 + 每行单行 Text + Ellipsis + 行数上限 + 「还有 N 行」提示。工具参数/结果/thinking/权限命令全部换用它——`Paragraph` 的 min-content 是最长不可断 token，禁止用于展示不可信文本 |

### 13.3 验证

- 无头截图（90 条真实消息 + 含压缩 JS 一行命令的会话）：侧栏恢复 268px、markdown
  正常排版（标题/列表/行内代码着色）、用户气泡右对齐带完整文本、助手气泡带复制按钮。
- 全量标签几何检查：最右标签边缘 1260px < 内容区边界，无任何横向越界。
- `go build` / `go vet` / `go test` 全绿（`TestMessageInteractions` 已适配按行折叠语义）。

### 13.4 布局编程规约（本项目沿用 viva 时必须遵守）

1. **壳层固定宽度元素一律 `Shrink(0)`**（侧栏、分隔线；底栏/顶栏是纵向子元素不受影响）。
2. **气泡/卡片要显式定宽或从外层传入宽度**，不要依赖「内容撑宽」——`ui.Slot`
   （MarkdownBlock / 自绘）与 `FillWidth` 子元素对宽度零贡献。
3. **不可信文本（工具参数/结果/命令输出）禁止 `ui.Paragraph`**，一律 `boundedLines`
   逐行 Ellipsis；可信短文案（技能描述等已 truncate 的）可以用 Paragraph。

---

## 14. 卡顿与「点了没反应」修复（2026-11-19，0.8.9）

用户反馈 0.8.8「操作卡顿、功能完全不可用」，截图里工作目录弹层开着悬在侧栏上方。

### 14.1 根因与修复

| 问题 | 根因 | 修复 |
| --- | --- | --- |
| 操作卡顿 | 看门狗每 300ms 真实 resize 两次窗口（+2px 再还原）触发整窗重排；0.8.8 给指纹加了消息内容足迹后，流式期间每个 delta 都抖一次；且 90 条消息全量声明（~650 元素/帧） | ① 看门狗自调优：优先 `app.Post + Invalidate`（纯重绘不 resize），以 paintCount 前进验证，**无头已证实廉价路径生效**，日志可见「不再 resize」；仅连续 4 次无画帧才退回限频（800ms）抖动。② 消息窗口化：只声明尾部 40 条，顶部「↑ 加载更早消息（还有 N 条）」按页展开（90 条会话每帧元素 653→315）。③ mdCache 接入 trim（原来定义了但从未调用） |
| 会话时有时无 | 每次启动 POST /workspaces 都拿到**新 id**（服务端对同一路径不查重），会话视图随工作区漂移；工作区表无限增长 | `EnsureWorkspace`：先 `GET /workspaces` 按路径复用（路径规整比较），没有才 POST。boot 与切换工作目录都走它 |
| 点了没反应 | SwitchWorkdir / SwitchModel 无服务时提前 return，**弹层不收起**，看起来像没点上 | 两个动作第一步就关弹层，任何分支都不留 |

### 14.2 验证

- 无头日志出现 `watchdog: 廉价路径（Post+Invalidate）已证实可触发重绘，不再 resize`。
- 无头日志出现 `workspace: 复用已有工作区 …（path=E:\data\1003\…）`，boot 加载 90 条
  消息的会话，「↑ 加载更早消息（还有 50 条）」按钮渲染，每帧标签 653→315。
- 驱动级新增 `TestWorkdirPopover`：chip 打开弹层 → 点目录行触发切换 → 弹层关闭 +
  「服务未就绪」提示（顺带锁住「弹层必收起」的行为）。
- `go build` / `go vet` / `go test` 全绿（14 个）。
- 安装器 `admx-0.8.9-windows-amd64-setup.exe`，已覆盖更新 `%LOCALAPPDATA%\ADMX\ADMX.exe`
  （0.8.8 备份 `.native-0.8.8.bak`）。

### 14.3 复测建议

~~真机启动 ADMX 后先看 `%LOCALAPPDATA%\ADMX\adm-desktop.log`：若出现
「廉价路径…不再 resize」说明走的是纯重绘（应当流畅）~~
**0.8.9 的「廉价路径已证实生效」是误判，见 §15；0.8.10 起该建议作废。**

---

## 15. 真机冻结修复：Invalidate 上当记（2026-11-19，0.8.10）

用户真机跑 0.8.9：「连不上、点都不能点」，截图停在「连接中…」。日志真相：

### 15.1 日志还原（`adm-desktop.log`）

- boot 其实 **2 秒就绪**，90 条消息已加载；
- `paint #20 boot=1 sessions=1 msgs=90` —— 页面函数**跑了**、paint 计数前进；
- 但屏幕停在 boot 前的首帧（用户看到「连接中」）——**Invalidate 唤醒的画帧
  跑了页面函数但不上屏**（真机 v0.6.5 的既有缺陷，0.8.9 之前就存在）；
- 0.8.9 的自调优看门狗把**窗口打开初期的环境画帧**（OpenWindow 的 #1-3、布局
  安顿帧 #4-19）误判成「Invalidate 生效」的证据（`cheapOK=true`），从此永不
  resize 兜底 → 数据类更新全部冻结，「点了没反应」。

### 15.2 0.8.10 修复

| 修复 | 说明 |
| --- | --- |
| 看门狗回退为 **nudge 唯一通道** | 删除廉价路径。指纹变化 → 限频 500ms 的真实 resize 抖动（0.8.4~0.8.8 真机验证过的上屏通道）；流式期间的增量合并进下一次抖动 |
| 抖动成本打下来 | 0.8.8 卡顿的真凶是每次 +2px 让**全部 markdown 重新解析排版**。mdCache 加 ±4px 宽度容差（`mdWidthTolerance`）：measure/paint 都跳过微差重排，抖动只剩盒几何 |
| EnsureWorkspace 不再静默 | `GET /workspaces` 失败/无匹配都记日志（0.8.9 曾静默吞错导致看似没生效）。另实测：工作区列表是 **server 进程内存态**——server 重启后首个 boot 必然新建（此后复用），这是服务端行为 |

### 15.3 经验

1. **廉价路径的「验证」必须排除环境画帧**——paint 计数前进 ≠ 我们发的
   Invalidate 生效。要验证，得在指纹不变时发 Invalidate 且看到画帧，或者干脆
   别做无法隔离变量的自动调优。
2. 真机 UI 冻结类问题**先看日志里 paint 计数与模型状态是否一致**：
   计数前进但用户看到旧画面 = 上屏链路问题；计数不动 = 唤醒链路问题。
   两者在 v0.6.5 上都出现过，修法不同。
3. 抖动通道本身不卡，卡的是抖动引发的 markdown 重排——给缓存加容差比限频更对症。

安装器 `admx-0.8.10-windows-amd64-setup.exe`；已覆盖 `%LOCALAPPDATA%\ADMX\ADMX.exe`
与 `%LOCALAPPDATA%\Programs\ADMX\ADMX.exe`（用户已用安装器装到后者；均备份
`ADMX.exe.pre-0.8.10.bak`）。`go test` 全绿（14 个）。

---

## 16. 卡顿根治：放弃 resize 抖动，改用 InvalidateRect 直接触发上屏（2026-11-19，0.8.11）

用户 0.8.10 反馈「能连接了但交互卡顿严重」，并指示：认真核对 `C:\workspace\code\adm`
原版上游代码、去掉本地模块差异，之后的界面以还原原版功能为先。

### 16.1 机制层结论（读 v0.6.5 Windows 后端源码 + 真机日志交叉验证）

- `renderer.apply(frame)` 只更新 retained 场景缓冲；**真正的 present 在 wndproc 的
  `WM_PAINT` 分支**（present 当前 retained 场景，不重跑页面函数）。
- `OnRedraw`（Invalidate 唤醒）→ 页面函数 → applyFrame 之后，是否发 WM_PAINT 取决于
  `prepareFrame` 的 `dirty` 计算；真机上这条链的画帧「跑了页面函数、paint 计数前进，
  却不上屏」（0.8.9 日志）。
- resize 抖动能上屏是因为 `WM_SIZE` 分支**同步调用 presentImmediate**，绕过一切 gate——
  这就是它可靠但卡顿的原因：每次 SetSize 都是 swapchain 重分配（ResizeBuffers）+
  全窗重排；0.8.8 给指纹加了消息内容足迹后，流式期间每个 delta 都抖，交互期间
  任何数据变化后也抖。
- 0.8.9 自调优的「廉价路径已证实生效」是**误判**：把窗口打开初期的环境画帧
  （OpenWindow 初始帧 + 布局安顿帧 + 光标闪烁帧）当成了 Invalidate 的功劳。
- 真机上连「上屏」都依赖输入事件：0.8.10 有焦点时光标闪烁（~10 paint/s）顺带把
  每帧都推上屏，无焦点则完全冻结——0.8.9 的「永久连接中」即此。

### 16.2 0.8.11 方案：补上缺失的最后一步

`internal/adm/wake_windows.go`：应用侧直接调 user32

1. `Post(Invalidate)` —— 页面函数重跑，retained 场景缓冲更新（照旧走 waker）；
2. `InvalidateRect(hwnd)`（+60ms/+180ms 两笔）—— 强制投递 WM_PAINT，
   wndproc 分支 present **已更新的场景**。

窗口句柄按「本进程 PID + 标题 ADMX」EnumWindows 过滤，不会误伤其它实例。
全程无窗口尺寸变化、无 swapchain 重分配——抖动卡顿的成本归零。看门狗瘦身为
「指纹变了 → wakeRepaint()」（150ms 轮询）。`wake_windows.go` 里带唤醒次数与
hwnd 的诊断日志（前 3 次 + 每 50 次）。

真机证据（00:47 的日志）：`wake: 第 1 次唤醒 hwnd=451050，已安排 InvalidateRect`，
其后 paint 持续前进（274 行 paint 日志 ≈ 持续重绘中）。

### 16.3 顺带修复：会话列表改普通可点击行

真机上 `ui.List` 的行不渲染（无头、scale=1/2 均可渲染，原因未明——不排除与
visibility gate/光标式上屏有交互），导致用户「会话列表永远空白、没东西可点」。
改为与工作目录弹层相同的「普通可点击行」模式（`Row+Hit+Clicked`，外层
`Scroll.Grow(1)`），该模式已被真机验证（0.8.9 用户截图里弹层正常）。
`ui.List`/ListState 从 model 与 shell 中移除。

### 16.4 验证与交付

- `go build` / `go vet` / `go test` 全绿（15 个）。
- 真机日志：wake 唤醒正常、paint 持续前进、工作区按路径复用生效。
- 安装器 `admx-0.8.11-windows-amd64-setup.exe`（3.37 MiB）；已覆盖两个安装位置
  （备份 `.pre-0.8.11.bak`）。

### 16.5 待办（按用户指示：以还原原版功能为先）

- 对照 `C:\workspace\code\adm` 上游（Tauri 原版 `src/`）逐项核对功能差距，
  下轮起以原版行为为基准补齐（附件/PDF、撤销入口、压缩、权限完整表单等）。
- `ui.List` 真机不渲染的根因留档未查（已绕开）。

---

## 17. 后端服务内嵌（2026-11-25，取代外部 admAgent.exe）

按用户要求「用 REA 反编译 `D:\code\adm\admAgent.exe` 后端服务并还原到当前项目内嵌实现」，
新增独立 Go 包 `desktop/internal/server`（RESTORE 实现），客户端与服务端同进程。

- **证据链与范围**：见 [adm-server-embedded.md](adm-server-embedded.md) §1–§2。核心还原依据是
  pclntab 函数表（40072 符号）、二进制内嵌 goose 迁移 SQL、真实工作区 DB 探针
  （goose 10 条版本 + 列结构）、对运行中实例的命名管道只读取证（字段级 ground truth）；
  Ghidra/Hopper/IDA/Kuna 在本机不可用（REA provider_unavailable），故未走通用反编译路线。
- **数据兼容**：`<workdir>/.admAgent/admAgent.db` schema/goose 版本与真实 v0.4.x 一致，
  内嵌与外部实例可交替打开同一库（同时写不行，WAL 单进程）。
  *0.9.1 独立化后 ADMX 改用 `<workdir>/.admx/admx.db`，与外部库物理隔离；见 embedded 文档 §3/§6。*
- **boot 决策**：`ADM_EMBEDDED_SERVER=1` 强制内嵌（跳过外部探测）；默认内嵌；
  `=0` 退回原 sidecar exe；外部已有实例仍可复用（分支顺序见 embedded 文档 §3）。
  *0.9.1 起默认只遍历 `admx-*` 专属管道，不再复用外部实例；仅 `=0` 才碰 `admAgent-*`。*
- **验证**：`go build`/`go vet`/`go test ./...` 全绿（含 fake-LLM 端到端轮次与命名管道契约测试
  `ADM_EMBEDDED_TEST=1`）；无头真机冒烟确认内嵌 server 启动、建工作区、init、SSE 挂接与
  `layout 0 problems`。
- **差异清单**（LSP/MCP/summarize/undo 文件回滚等）集中在 embedded 文档 §2.2，后续补齐时同步更新。


---

## 18. 弃用冻结记录（2026-11-25）

用户决策：**桌面 UI 仍走网页 HTML 版本，即 Tauri 承载的 Web 前端（`src/` + `src-tauri/`）**，
原生的 ADMX/viva 桌面端（本目录）**弃用冻结**。

- 「网页 HTML 版」= `src/` + `src-tauri/`，不是 `website/`；后者只是营销官网落地页（单页 + 截图）。
- `desktop/` 不再新增功能、不做兼容性修复、不改构建/发布链路（CI 与脚本本来也未引用）；
  保留代码与本文档作参考与回退。除非用户明确要求，不要改动 `desktop/`。
- `desktop/internal/server`（admAgent 后端内嵌还原，见 [adm-server-embedded.md](adm-server-embedded.md)）
  随之冻结：它是已验证的实验成果与参考资料，不是交付物。若后续确有「服务端能力以内嵌方式提供」
  的需求，需用户显式重启，并重新评估是否并入 `src-tauri/` 而非留在 `desktop/`。
- 本节之前的方案、分期（P0–P5）与 §8–§17 落地记录均为历史事实，保留不改写。
