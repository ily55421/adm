// 工具面板（Skill / LSP / MCP）
import { t as _t } from "../../i18n.js";
import { S, invoke } from "./store.js";
import { api } from "./api.js";
import { showInfo, showError, showConfirm, reportError } from "./ui.js";
import { $input } from "./utils.js";
import { ensureFixTargets, isLspFixable, fixTarget, guideFor, runLspFix, runAiInstall, isLspAutoFixEnabled, setLspAutoFixEnabled, onLspStateEvent } from "./lsp_fix.js";


var managedLspCatalog = [];
// ===== 工具列表 =====
// 分别调用 /skills、/mcp/states、/lsps 三个端点，外加工作区详情获取 skill 状态快照
// 结果按 tab（skill / lsp / mcp）分类缓存到 toolsData，再渲染当前 tab
export async function loadTools() {
  if (!S.serverInfo) return;
  var wsId = S.serverInfo.workspace_id;
  await ensureFixTargets();

  // MCP/LSP 共用的 state 字符串 → 中文标签 + 颜色（显示时经 _t 翻译）
  var stateMap = {
    connected: { label: _t("已连接"), color: "green" },
    starting:  { label: _t("启动中"), color: "yellow" },
    disabled:  { label: _t("已禁用"), color: "gray" },
    error:     { label: _t("错误"),   color: "red" },
  };

  // 并行请求四个端点（工作区详情用于 skill 状态快照），外加本地磁盘扫描兜底
  // + admAgent.json 中的 MCP 配置（可编辑来源）
  var results = await Promise.allSettled([
    api("GET", "/v1/workspaces/" + wsId + "/skills"),
    api("GET", "/v1/workspaces/" + wsId + "/mcp/states"),
    api("GET", "/v1/workspaces/" + wsId + "/lsps"),
    api("GET", "/v1/workspaces/" + wsId),
    invoke("list_installed_skills"),
    invoke("list_mcp_servers"),
  ]);

  // Skill 状态快照 map: name → {state, error}（state: 0=正常 1=错误）
  var skillStates = {};
  if (results[3].status === "fulfilled" && results[3].value && Array.isArray(results[3].value.skills)) {
    results[3].value.skills.forEach(function(s) {
      if (s && s.name) skillStates[s.name] = s;
    });
  }

  // Skills
  var skillTools = [];
  if (results[0].status === "fulfilled") {
    var skills = results[0].value;
    if (Array.isArray(skills)) {
      // 直接数组格式 [SkillInfo, ...]
    } else if (skills && typeof skills === "object") {
      // 尝试多种可能的包装 key
      if (Array.isArray(skills.skills)) skills = skills.skills;
      else if (Array.isArray(skills.data)) skills = skills.data;
      else if (Array.isArray(skills.result)) skills = skills.result;
      else if (Array.isArray(skills.items)) skills = skills.items;
      else {
        // Map 格式 {"name": SkillInfo, ...}
        var mapValues = Object.values(skills).filter(function(v) { return v && typeof v === "object"; });
        if (mapValues.length > 0 && mapValues.every(function(v) { return typeof v.name === "string" || typeof v.id === "string"; })) {
          skills = mapValues;
        } else {
          skills = [];
        }
      }
    } else {
      skills = [];
    }
    skills.forEach(function(s) {
      var name = s.name || s.id || "unknown";
      // 快照里 state=1 为发现/解析错误；能出现在 /skills 列表里的默认视为已加载
      var snap = skillStates[name];
      var status = { label: _t("已加载"), color: "green", title: "" };
      if (snap && snap.state === 1) {
        status = { label: _t("错误"), color: "red", title: snap.error || "" };
      }
      skillTools.push({
        name: name,
        status: status.label,
        statusColor: status.color,
        title: status.title,
      });
    });
  }

  // 磁盘扫描兜底合并：server 的 skill 列表是 workspace 创建时的发现快照，
  // 技能管理页安装的全局/项目技能不会触发服务端重新发现，需以磁盘为准补齐，
  // 否则切回 Agent 页 Skill 栏看不到刚安装的技能。
  if (results[4].status === "fulfilled" && Array.isArray(results[4].value)) {
    var knownNames = {};
    skillTools.forEach(function (tool) { knownNames[tool.name] = true; });
    results[4].value.forEach(function (s) {
      if (!s || !s.name || knownNames[s.name]) return;
      knownNames[s.name] = true;
      skillTools.push({
        name: s.name,
        status: _t("已加载"),
        statusColor: "green",
        title: "",
      });
    });
  }

  // MCP clients：配置（admAgent.json 顶层 mcp）为可编辑来源，
  // /mcp/states 提供运行状态；两者按名称合并展示：
  // - 已配置：有点击编辑入口；有运行状态则显示状态，否则显示「待重启生效」（新增/修改需重启 server 初始化）
  // - 仅运行状态存在（配置文件里没有）：只读展示
  var runtimeStates = {};
  if (results[1].status === "fulfilled") {
    var mcpStates = results[1].value;
    if (mcpStates && typeof mcpStates === "object" && !Array.isArray(mcpStates)) {
      Object.values(mcpStates).forEach(function(m) {
        if (m && m.name) runtimeStates[m.name] = m;
      });
    }
  }
  function runtimeStatus(m) {
    var st = stateMap[m.state] || { label: m.state || _t("未知"), color: "gray" };
    return { label: st.label, color: st.color, title: m.error || "" };
  }

  var mcpTools = [];
  var configViews = [];
  if (results[5] && results[5].status === "fulfilled" && Array.isArray(results[5].value)) {
    configViews = results[5].value;
  }
  configViews.forEach(function(view) {
    var runtime = runtimeStates[view.name];
    var status = runtime ? runtimeStatus(runtime) : (view.disabled
      ? { label: _t("已禁用"), color: "gray", title: "" }
      : { label: _t("待重启生效"), color: "gray", title: _t("新增或修改的 MCP 需重启 Agent 服务后生效") });
    mcpTools.push({
      name: view.name,
      status: status.label,
      statusColor: status.color,
      title: status.title,
      configed: true,
      view: view,
    });
  });
  Object.keys(runtimeStates).forEach(function(name) {
    var exists = mcpTools.some(function(t) { return t.name === name; });
    if (exists) return;
    var status = runtimeStatus(runtimeStates[name]);
    mcpTools.push({
      name: name,
      status: status.label,
      statusColor: status.color,
      title: status.title,
      configed: false,
    });
  });

  // LSP clients（state 为整数：0=未启动 1=启动中 2=已连接 3=错误 4=已停止 5=已禁用）
  // error_type=not_installed（服务端分类）表示二进制未安装：不作为故障展示，
  // 直接隐藏——真正启动失败（startup_failed）才保留红点与修复入口。
  var lspStateMap = {
    0: { label: _t("未启动"), color: "gray" },
    1: { label: _t("启动中"), color: "yellow" },
    2: { label: _t("已连接"), color: "green" },
    3: { label: _t("错误"), color: "red" },
    4: { label: _t("已停止"), color: "gray" },
    5: { label: _t("已禁用"), color: "gray" },
  };
  var lspTools = [];
  if (results[2].status === "fulfilled") {
    var lspStates = results[2].value;
    if (lspStates && typeof lspStates === "object" && !Array.isArray(lspStates)) {
      Object.keys(lspStates).forEach(function(key) {
        var l = lspStates[key];
        var lspName = l.name || key;
        var isErr = l.state === 3;
        // 状态事件先派发（drive 自动安装开关），再决定是否展示：
        // error_type=not_installed 仅表示未安装，不作为故障展示/计数。
        if (isErr) onLspStateEvent(lspName, l.state, l.error, l.error_type);
        if (l.error_type === "not_installed") return;
        var st = lspStateMap[l.state] || { label: l.state || _t("未知"), color: "gray" };
        var fixable = isErr && isLspFixable(lspName);
        lspTools.push({
          name: lspName,
          status: st.label,
          statusColor: st.color,
          title: l.error || "",
          errorText: l.error || "",
          lspState: l.state,
          managed: !!l.managed,
          serverFix: l.fix || null,
          fixable: fixable,
          guide: isErr && !fixable ? guideFor(lspName) : null,
          aiInstall: isErr,
        });
      });
    }
  }

  S.toolsData = { skill: skillTools, lsp: lspTools, mcp: mcpTools };
  renderToolsList();
}

// 渲染当前 tab 的工具列表（名称 + 状态），空则显示占位
export function renderToolsList() {
  var container = document.getElementById("agent-tools-list");
  var countEl = document.getElementById("agent-tools-count");
  if (!container) return;
  ensureAutoFixToggle();

  // 添加 MCP 按钮仅在 MCP tab 显示
  var addBtn = document.getElementById("agent-mcp-add-btn");
  if (addBtn) addBtn.classList.toggle("show", S.toolsTab === "mcp");

  var tools = S.toolsData[S.toolsTab] || [];
  if (countEl) countEl.textContent = String(tools.length);
  container.innerHTML = "";

  // LSP 管理工具（0.4.7）：catalog/doctor/jobs 与 managed server 安装/修复/卸载
  if (S.toolsTab === "lsp") {
    container.appendChild(buildLspManagementRow());
    var catalogPanel = document.createElement("div");
    catalogPanel.id = "agent-managed-lsp-catalog";
    catalogPanel.style.cssText = "display:none;max-height:140px;overflow-y:auto;";
    container.appendChild(catalogPanel);
    if (managedLspCatalog.length > 0) {
      renderManagedLspCatalog();
      catalogPanel.style.display = "block";
    }
  }

  if (S.toolsTab === "mcp") {
    container.appendChild(buildDockerMcpRow());
  }

  if (tools.length === 0) {
    if (S.toolsTab === "lsp") return;
    var empty = document.createElement("div");
    empty.className = "tool-item";
    empty.innerHTML = '<span class="tool-dot gray"></span><span class="tool-name" style="color:var(--c-text-4);">' + _t("暂无工具") + '</span>';
    container.appendChild(empty);
    return;
  }

  tools.forEach(function(tool) {
    var item = document.createElement("div");
    item.className = "tool-item";
    if (tool.title) item.title = tool.title;
    // 已配置的 MCP 可点击进入编辑（点击事件由 mcp_dialog.js 在列表容器上委托）
    if (tool.configed) item.setAttribute("data-mcp-name", tool.name);
    var dot = document.createElement("span");
    dot.className = "tool-dot " + (tool.statusColor || "gray");
    item.appendChild(dot);
    var name = document.createElement("span");
    name.className = "tool-name";
    name.textContent = tool.name;
    item.appendChild(name);
    if (tool.configed) {
      var hint = document.createElement("span");
      hint.className = "tool-edit-hint";
      hint.textContent = "✎";
      hint.title = _t("点击修改");
      item.appendChild(hint);
      // MCP 运行时操作入口（/mcp/refresh-*、read-resource、get-prompt，契约见 doc/server-api.md §11）
      appendMcpRuntimeButtons(item, tool.name);
    }
    if (tool.fixable) {
      var fixBtn = document.createElement("button");
      fixBtn.className = "tool-fix-btn";
      fixBtn.textContent = _t("修复");
      var ft = fixTarget(tool.name);
      if (ft && ft.command) fixBtn.title = ft.command + (ft.requires ? "（需要 " + ft.requires + "）" : "");
      fixBtn.addEventListener("click", function(e) {
        e.stopPropagation();
        fixBtn.disabled = true;
        fixBtn.textContent = _t("修复中…");
        runLspFix(tool.name).then(function() {
          fixBtn.disabled = false;
          fixBtn.textContent = _t("修复");
        });
      });
      item.appendChild(fixBtn);
    } else if (tool.guide) {
      var guideBtn = document.createElement("button");
      guideBtn.className = "tool-fix-btn";
      guideBtn.textContent = _t("指引");
      if (tool.guide.hint) guideBtn.title = tool.guide.hint;
      guideBtn.addEventListener("click", function(e) {
        e.stopPropagation();
        if (tool.guide && tool.guide.url) window.openUrl(tool.guide.url);
      });
      item.appendChild(guideBtn);
    }
    if (tool.aiInstall) {
      var aiBtn = document.createElement("button");
      aiBtn.className = "tool-fix-btn";
      aiBtn.textContent = _t("AI 安装");
      aiBtn.title = _t("把安装任务发给当前会话的 AI 处理");
      aiBtn.addEventListener("click", function(e) {
        e.stopPropagation();
        runAiInstall(tool.name, tool.errorText);
      });
      item.appendChild(aiBtn);
    }
    if (S.toolsTab === "lsp" && tool.managed) {
      item.appendChild(makeOpBtn(_t("修复"), function() {
        requestManagedLspFix(tool.name, tool.serverFix && tool.serverFix.kind);
      }));
      item.appendChild(makeOpBtn(_t("卸载"), function() { uninstallManagedLsp(tool.name); }));
    }
    // LSP 运行时操作：停止端点作用于工作区所有 LSP，重启与诊断作用于单个 LSP。
    if (tool.lspState === 2) {
      item.appendChild(makeOpBtn(_t("停止所有"), function() {
        lspStopAll();
      }));
      item.appendChild(makeOpBtn(_t("重启"), function() {
        lspRestart(tool.name);
      }));
    }
    if (S.toolsTab === "lsp") {
      item.appendChild(makeOpBtn(_t("诊断"), function() {
        lspDiagnostics(tool.name);
      }));
    }
    var statusLabel = document.createElement("span");
    statusLabel.className = "tool-status " + (tool.statusColor || "gray");
    statusLabel.textContent = tool.status;
    item.appendChild(statusLabel);
    container.appendChild(item);
  });
}

// 绑定「启动失败自动修复」开关（DOM 随视图重建，用 dataset 标记避免重复绑定）
function ensureAutoFixToggle() {
  var row = document.getElementById("agent-lsp-autofix-row");
  if (!row || row.dataset.bound) return;
  var box = $input("agent-lsp-autofix");
  if (!box) return;
  row.dataset.bound = "1";
  box.checked = isLspAutoFixEnabled();
  box.addEventListener("change", function() {
    setLspAutoFixEnabled(!!box.checked);
    showInfo(box.checked ? _t("LSP 启动失败时将自动安装修复") : _t("LSP 启动失败时仅提示，不自动安装"));
  });
  row.style.display = S.toolsTab === "lsp" ? "flex" : "none";
}

// 切换工具 tab（Skill / LSP / MCP）并重绘列表；供 tab 点击与外部流程（如保存 MCP 后）调用
export function activateToolsTab(tab) {
  S.toolsTab = tab;
  var toolsTabs = document.getElementById("agent-tools-tabs");
  if (toolsTabs) {
    toolsTabs.querySelectorAll(".tools-tab").forEach(function(t) {
      t.classList.toggle("active", t.getAttribute("data-tab") === tab);
    });
  }
  var autoRow = document.getElementById("agent-lsp-autofix-row");
  if (autoRow) autoRow.style.display = tab === "lsp" ? "flex" : "none";
  renderToolsList();
}

// ===== MCP / LSP 运行时操作（契约见 doc/server-api.md §6、§11）=====

// 工具项内的小操作按钮（与「修复」按钮同样式；点击不冒泡，避免触发列表委托）
function makeOpBtn(label, onClick) {
  var btn = document.createElement("button");
  btn.className = "tool-fix-btn";
  btn.textContent = label;
  btn.addEventListener("click", function(e) {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

// MCP tab 顶部的「Docker MCP」开关行：POST /mcp/docker/enable|disable（体 {}），
// 工作区级开关，不归属单个 MCP 客户端
function buildDockerMcpRow() {
  var item = document.createElement("div");
  item.className = "tool-item";
  var dot = document.createElement("span");
  dot.className = "tool-dot gray";
  item.appendChild(dot);
  var name = document.createElement("span");
  name.className = "tool-name";
  name.textContent = _t("Docker MCP");
  item.appendChild(name);
  item.appendChild(makeOpBtn(_t("启用"), function() {
    mcpRuntimeCall("docker/enable", _t("启用 Docker MCP"), {});
  }));
  item.appendChild(makeOpBtn(_t("禁用"), function() {
    mcpRuntimeCall("docker/disable", _t("禁用 Docker MCP"), {});
  }));
  return item;
}

// MCP 客户端运行时操作按钮：刷新 tools / prompts / resources、读取资源、获取提示
function appendMcpRuntimeButtons(item, name) {
  var refreshOps = [
    { action: "refresh-tools", label: _t("刷新工具") },
    { action: "refresh-prompts", label: _t("刷新提示") },
    { action: "refresh-resources", label: _t("刷新资源") },
  ];
  refreshOps.forEach(function(op) {
    item.appendChild(makeOpBtn(op.label, function() {
      mcpRuntimeCall(op.action, op.label, { name: name });
    }));
  });
  item.appendChild(makeOpBtn(_t("读取资源"), function() {
    doMcpReadResource(name);
  }));
  item.appendChild(makeOpBtn(_t("获取提示"), function() {
    doMcpGetPrompt(name);
  }));
}

// MCP 运行时操作统一入口：POST /v1/workspaces/{id}/mcp/{action}。
// 成功 showInfo 反馈并刷新工具面板；失败 reportError（原始错误只进日志与提示）
function mcpRuntimeCall(action, label, body) {
  var wsId = S.serverInfo ? S.serverInfo.workspace_id : "";
  if (!wsId) { showError(_t("未获取到工作区信息，MCP 操作不可用")); return Promise.resolve(); }
  return api("POST", "/v1/workspaces/" + wsId + "/mcp/" + action, body || {})
    .then(function() {
      showInfo(label + _t(" 成功"));
      return loadTools();
    })
    .catch(function(e) {
      reportError(e, { prefix: label + _t(" 失败：") });
    });
}

// 读取 MCP 资源：弹输入框取 URI，POST /mcp/read-resource，展示返回内容后刷新面板
function doMcpReadResource(name) {
  promptInput(_t("读取资源 URI"), _t("请输入资源 URI（如 file:///path/to/resource）")).then(function(uri) {
    if (uri == null || !uri) return;
    var wsId = S.serverInfo ? S.serverInfo.workspace_id : "";
    if (!wsId) { showError(_t("未获取到工作区信息，MCP 操作不可用")); return; }
    api("POST", "/v1/workspaces/" + wsId + "/mcp/read-resource", { name: name, uri: uri })
      .then(function(res) {
        showInfo(_t("MCP「") + name + _t("」资源内容：") + formatJsonText(res));
        return loadTools();
      })
      .catch(function(e) {
        reportError(e, { prefix: _t("读取 MCP 资源失败：") });
      });
  });
}

// 获取 MCP Prompt：弹输入框取 prompt_id（client_id 用 MCP 名称），POST /mcp/get-prompt，
// 展示返回的 prompt 文本
function doMcpGetPrompt(name) {
  promptInput(_t("获取提示 ID"), _t("请输入提示 ID（prompt_id）")).then(function(promptId) {
    if (promptId == null || !promptId) return;
    var wsId = S.serverInfo ? S.serverInfo.workspace_id : "";
    if (!wsId) { showError(_t("未获取到工作区信息，MCP 操作不可用")); return; }
    api("POST", "/v1/workspaces/" + wsId + "/mcp/get-prompt", {
      client_id: name,
      prompt_id: promptId,
      args: {},
    })
      .then(function(res) {
        var text = (res && (res.prompt || res.content || res.text)) || res;
        showInfo(_t("MCP「") + name + _t("」提示内容：") + formatJsonText(text));
        return loadTools();
      })
      .catch(function(e) {
        reportError(e, { prefix: _t("获取 MCP 提示失败：") });
      });
  });
}

// 轻量输入弹窗（WebView 原生 prompt 不可靠，复用 permission-modal 样式自建 overlay）：
// 返回输入值（去首尾空白）；取消 / 关闭 / 点遮罩返回 null
function promptInput(title, placeholder) {
  return new Promise(function(resolve) {
    var overlay = document.createElement("div");
    overlay.className = "permission-overlay show";
    overlay.innerHTML =
      '<div class="permission-modal">' +
        '<div class="permission-header">' +
          '<span class="permission-icon">ℹ️</span>' +
          '<span class="permission-title"></span>' +
        '</div>' +
        '<div class="permission-body">' +
          '<input type="text" class="settings-input">' +
        '</div>' +
        '<div class="permission-footer">' +
          '<button class="settings-btn settings-btn-secondary" data-act="cancel"></button>' +
          '<button class="settings-btn settings-btn-primary" data-act="ok"></button>' +
        '</div>' +
      '</div>';
    overlay.querySelector(".permission-title").textContent = title || "";
    var input = overlay.querySelector("input");
    if (placeholder) input.setAttribute("placeholder", placeholder);
    overlay.querySelector('[data-act="cancel"]').textContent = _t("取消");
    overlay.querySelector('[data-act="ok"]').textContent = _t("确定");
    function close(result) { overlay.remove(); resolve(result); }
    overlay.querySelector('[data-act="cancel"]').addEventListener("click", function() { close(null); });
    overlay.querySelector('[data-act="ok"]').addEventListener("click", function() { close(input.value.trim()); });
    overlay.addEventListener("click", function(e) {
      e.stopPropagation();
      if (e.target === overlay) close(null);
    });
    input.addEventListener("keydown", function(e) {
      if (e.key === "Enter") close(input.value.trim());
    });
    (document.querySelector(".agent-root") || document.body).appendChild(overlay);
    input.focus();
  });
}

// 响应对象 → 紧凑文本（字符串原样、对象 JSON 序列化，超长截断），供 showInfo 展示
function formatJsonText(value) {
  var text;
  try {
    text = (typeof value === "string") ? value : JSON.stringify(value);
  } catch (_) {
    text = String(value);
  }
  if (text.length > 600) text = text.slice(0, 600) + "…";
  return text;
}

// 停止所有 LSP：POST /v1/workspaces/{id}/lsps/stop（体 {}）
function lspStopAll() {
  var wsId = S.serverInfo ? S.serverInfo.workspace_id : "";
  if (!wsId) { showError(_t("未获取到工作区信息，LSP 操作不可用")); return; }
  api("POST", "/v1/workspaces/" + wsId + "/lsps/stop", {})
    .then(function() {
      showInfo(_t("已停止所有 LSP"));
      return loadTools();
    })
    .catch(function(e) {
      reportError(e, { prefix: _t("停止 LSP 失败：") });
    });
}

// 重启单个 LSP：POST /v1/workspaces/{id}/lsps/{lsp}/restart（体 {}）
function lspRestart(name) {
  var wsId = S.serverInfo ? S.serverInfo.workspace_id : "";
  if (!wsId) { showError(_t("未获取到工作区信息，LSP 操作不可用")); return; }
  api("POST", "/v1/workspaces/" + wsId + "/lsps/" + encodeURIComponent(name) + "/restart", {})
    .then(function() {
      showInfo(name + _t(" 已重启"));
      return loadTools();
    })
    .catch(function(e) {
      reportError(e, { prefix: name + _t(" 重启失败：") });
    });
}

// LSP 诊断：GET /v1/workspaces/{id}/lsps/{lsp}/diagnostics，展示返回的诊断信息
function lspDiagnostics(name) {
  var wsId = S.serverInfo ? S.serverInfo.workspace_id : "";
  if (!wsId) { showError(_t("未获取到工作区信息，LSP 操作不可用")); return; }
  api("GET", "/v1/workspaces/" + wsId + "/lsps/" + encodeURIComponent(name) + "/diagnostics")
    .then(function(diag) {
      showInfo(_t("LSP「") + name + _t("」诊断：") + formatDiagnostics(diag));
    })
    .catch(function(e) {
      reportError(e, { prefix: name + _t(" 诊断失败：") });
    });
}

// 诊断信息格式化：数组给出条数，对象/字符串直接序列化
function formatDiagnostics(diag) {
  if (diag == null) return _t("无诊断信息");
  if (Array.isArray(diag)) {
    return _t("共 ") + diag.length + _t(" 条诊断：") + formatJsonText(diag);
  }
  return formatJsonText(diag);
}

// ===== admAgent 0.4.7 managed LSP API =====
function buildLspManagementRow() {
  var row = document.createElement("div");
  row.className = "tool-item";
  row.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;padding:5px 8px;";
  [[_t("服务目录"), loadLspCatalog], [_t("环境诊断"), runLspDoctor], [_t("安装 Managed LSP"), promptInstallManagedLsp], [_t("安装任务"), loadLspJobs], [_t("读取任务详情"), promptLoadLspJob], [_t("取消安装任务"), promptCancelLspJob]].forEach(function(action) {
    row.appendChild(makeOpBtn(action[0], action[1]));
  });
  return row;
}

function lspApiPath(suffix) {
  return "/v1/lsp/" + suffix;
}

function loadLspCatalog() {
  api("GET", lspApiPath("catalog"))
    .then(function(data) {
      managedLspCatalog = data && Array.isArray(data.servers) ? data.servers : [];
      renderManagedLspCatalog();
      var panel = document.getElementById("agent-managed-lsp-catalog");
      if (panel) panel.style.display = "block";
      showInfo(_t("Managed LSP 服务目录已加载：") + managedLspCatalog.length + _t(" 项"));
    })
    .catch(function(e) { reportError(e, { prefix: _t("读取 LSP 服务目录失败：") }); });
}

function renderManagedLspCatalog() {
  var panel = document.getElementById("agent-managed-lsp-catalog");
  if (!panel) return;
  panel.innerHTML = "";
  managedLspCatalog.forEach(function(server) {
    var item = document.createElement("div");
    item.className = "tool-item";
    item.style.cssText = "display:flex;gap:6px;padding:4px 8px;";
    var label = document.createElement("span");
    label.className = "tool-name";
    label.textContent = (server.display_name || server.name) + " " + (server.version || "") + " · " + (server.license || "");
    item.appendChild(label);
    if (server.available_on_host) {
      item.appendChild(makeOpBtn(_t("安装"), function() { installManagedLsp(server.name); }));
    } else {
      var unavailable = document.createElement("span");
      unavailable.className = "tool-status";
      unavailable.textContent = _t("当前平台不可用");
      item.appendChild(unavailable);
    }
    panel.appendChild(item);
  });
}

function runLspDoctor() {
  api("POST", lspApiPath("doctor"), {})
    .then(function(data) { showInfo(_t("LSP 环境诊断：") + formatJsonText(data)); })
    .catch(function(e) { reportError(e, { prefix: _t("LSP 环境诊断失败：") }); });
}

function loadLspJobs() {
  api("GET", lspApiPath("jobs"))
    .then(function(data) {
      var jobs = data && Array.isArray(data.jobs) ? data.jobs : [];
      showInfo(jobs.length ? _t("Managed LSP 安装任务：") + formatJsonText(jobs) : _t("当前没有 Managed LSP 安装任务"));
    })
    .catch(function(e) { reportError(e, { prefix: _t("读取 LSP 安装任务失败：") }); });
}

function promptLoadLspJob() {
  promptInput(_t("读取 Managed LSP 任务"), _t("请输入 job_id")).then(function(id) {
    if (!id) return;
    api("GET", lspApiPath("jobs/" + encodeURIComponent(id)))
      .then(function(job) { showInfo(_t("Managed LSP 任务详情：") + formatJsonText(job)); })
      .catch(function(e) { reportError(e, { prefix: _t("读取 LSP 任务详情失败：") }); });
  });
}

function promptCancelLspJob() {
  promptInput(_t("取消 Managed LSP 任务"), _t("请输入 job_id")).then(function(id) {
    if (!id) return;
    showConfirm(_t("确定取消 LSP 安装任务「") + id + "」？", function() {
      api("POST", lspApiPath("jobs/" + encodeURIComponent(id) + "/cancel"), {})
        .then(function() { showInfo(_t("已取消 LSP 安装任务")); loadLspJobs(); })
        .catch(function(e) { reportError(e, { prefix: _t("取消 LSP 安装任务失败：") }); });
    });
  });
}

function promptInstallManagedLsp() {
  promptInput(_t("安装 Managed LSP"), _t("请输入服务名称（可先点“服务目录”查看）")).then(function(name) {
    if (name) installManagedLsp(name);
  });
}
function installManagedLsp(name) {
  requestManagedLspPlan("install", name);
}

function requestManagedLspPlan(endpoint, name, action) {
  var body = { name: name };
  if (action) body.action = action;
  api("POST", lspApiPath(endpoint), body).then(function(plan) {
    if (!plan || !plan.plan_id) { showInfo(formatJsonText(plan)); return; }
    var summary = name + " " + (plan.action || endpoint) + (plan.version ? " " + plan.version : "");
    var confirmText = _t("将执行 Managed LSP 操作：") + summary + "。" +
      (plan.license ? _t("许可证：") + plan.license + "。" : "") +
      (plan.source ? _t("来源：") + plan.source + "。" : "") + _t("是否继续？");
    showConfirm(confirmText, function() {
      api("POST", lspApiPath(endpoint), {
        name: name,
        plan_id: plan.plan_id,
        confirm: true,
        action: plan.action || action,
      }).then(function(result) {
        showInfo(_t("Managed LSP 操作已提交：") + formatJsonText(result));
        loadLspJobs();
        loadTools();
      }).catch(function(e) { reportError(e, { prefix: _t("Managed LSP 操作失败：") }); });
    });
  }).catch(function(e) { reportError(e, { prefix: _t("获取 Managed LSP 操作计划失败：") }); });
}


function requestManagedLspFix(name, action) {
  requestManagedLspPlan("fix", name, action || "install_server");
}

function uninstallManagedLsp(name) {
  showConfirm(_t("确定卸载 Managed LSP 服务「") + name + _t("」？"), function() {
    api("POST", lspApiPath("uninstall"), { name: name })
      .then(function(result) { showInfo(_t("Managed LSP 卸载完成：") + formatJsonText(result)); loadTools(); })
      .catch(function(e) { reportError(e, { prefix: _t("卸载 Managed LSP 失败：") }); });
  });
}
