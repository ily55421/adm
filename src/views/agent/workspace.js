// 工作区切换 / 选择器 / 自动压缩配置
import { t as _t } from "../../i18n.js";
import { S, invoke, store } from "./store.js";
import { api } from "./api.js";
import { updateContextUsage, exitManualScrollMode, clearErrorNotices, reportError, clearSendSafetyTimer, updateStatusBar, updateSendButton, showConfirm } from "./ui.js";
import { log } from "./log.js";
import { renderMessages, renderTodos } from "./render.js";
import { loadConversations, renderConversationList, syncWxFollowSession } from "./session.js";
import { loadTools } from "./tools.js";
import { refreshAgentInfo, refreshServerProviders, updateModelDropdown } from "./model.js";
import { resetPermissionState, syncModeToServer } from "./permission.js";
import { reconcilePdfBatching } from "./pdf_batch.js";
import { updateDecisionModeUI } from "./decision_mode.js";

// ===== 会话上下文压缩 =====
// 全局默认开启自动压缩（Compact 模式）：上下文接近上限时服务端自动生成摘要压缩，
// 无需用户手动干预（scope=0 全局配置，幂等，每次初始化确保开启，不提供设置开关）
export async function enableAutoCompact() {
  if (!S.serverInfo || !S.serverInfo.workspace_id) return;
  try {
    await api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/config/compact", {
      scope: 0,
      enabled: true
    });
    console.log("[agent] 自动压缩（Compact 模式）已开启");
  } catch (e) {
    console.warn("[agent] 开启自动压缩失败:", e);
  }
}

// ===== 工作区切换 =====

// 按当前状态池的会话重算标题栏文本（会话列表比 currentConv 新时以列表为准）。
// currentConvId 为空时不动 DOM：此时 loadConversations 会自动选中/新建会话并自行写标题，
// 这里抢先写占位文案会把「新会话」冲掉。
function syncConvTitle() {
  if (!S.currentConvId) return;
  var titleEl = document.getElementById("agent-conv-title");
  if (!titleEl) return;
  var conv = null;
  var list = S.conversations || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].id === S.currentConvId) { conv = list[i]; break; }
  }
  if (!conv) conv = S.currentConv;
  titleEl.textContent = (conv && conv.title) ? conv.title : _t("选择或创建一个会话");
}

// 多 workspace 架构：切换 tab 时保存当前 workspace 状态到状态池，
// 恢复目标 workspace 状态。旧 workspace 的 agent run 在后台继续执行。
export async function switchToWorkspace(wsId, wsPath) {
  if (!wsId) return;
  log.debug("WS", "workspace.switchTo: " + wsId + " path=" + wsPath);

  // 在 setActive 之前判断是否首次访问：
  // store.setActive → registerWorkspace 会创建空快照，之后 S.workspaces[wsId] 永远 truthy
  var isFirstVisit = !store.workspaces.has(wsId);

  // 通知 Rust 后端切换激活 workspace（用于微信路由等）
  try { await invoke("switch_workspace", { workspaceId: wsId }); } catch (_) {}

  // Store 统一处理：保存旧 workspace 状态 + 切换 activeWsId + 恢复目标 workspace
  store.setActive(wsId);
  updateDecisionModeUI();
  S.workspaceInfo = { id: wsId, path: wsPath || "", name: wsPath ? wsPath.split(/[\\/]/).pop() : _t("默认工作区") };
  // 记录 path → wsId 映射，供 remove_workdir / validate_workdirs 清理状态池使用
  if (wsPath) S.wsIdByPath[wsPath] = wsId;

  if (!isFirstVisit) {
    // 恢复已保存的状态（store.setActive 已恢复，但 UI 需手动刷新）
    renderMessages();
    renderTodos(S.currentConv && Array.isArray(S.currentConv.todos) ? S.currentConv.todos : []);
    renderConversationList();
    updateContextUsage();
    updateStatusBar(S.isSending ? "busy" : "ready", wsPath || null, S.contextUsage.used);
    // 标题栏必须按恢复后的会话重算：store 只恢复数据不改 DOM，
    // 不重算会保留上一个工作区的会话标题（切回老工作区时标题栏停留旧工作区的对话记录）
    syncConvTitle();
    // 刷新服务端数据：后台运行可能已更新会话标题、上下文用量、Agent 信息
    loadConversations().then(syncConvTitle);
    refreshAgentInfo();
    loadTools();
  } else {
    // 首次进入该 workspace：初始化
    clearSendSafetyTimer();
    resetPermissionState();
    exitManualScrollMode();
    clearErrorNotices();
    renderMessages();
    renderTodos(S.currentConv && Array.isArray(S.currentConv.todos) ? S.currentConv.todos : []);
    document.getElementById("agent-conv-title").textContent = _t("选择或创建一个会话");

    // 重新初始化 Agent
    try { await api("POST", "/v1/workspaces/" + wsId + "/agent/init"); } catch (_) {}
    await syncModeToServer();
    await enableAutoCompact();
    try {
      var info = await api("GET", "/v1/workspaces/" + wsId + "/agent");
      store.setAgentInfo(wsId, info);
      if (info && info.model && info.model.context_window) {
        store.setContextUsage(wsId, S.contextUsage.used, info.model.context_window, S.contextUsage.estimated);
      }
    } catch (_) {}
    // SSE 监听是全局的（后端为每个 workspace 独立转发），不需要重新订阅
    // 刷新对话列表
    await loadConversations();
    await loadTools();
    updateContextUsage();
    updateStatusBar("ready", wsPath || null, 0);
    // 首次进入后保存到状态池（store.setActive 已注册，store 方法写入时自动快照）
  }

  // 切回工作区后必须重算工具栏：其它 tab 期间该 workspace 的 run_complete 只更新状态池
  // 不触发 UI 副作用（sse.js 按 active workspace 过滤），「停止」按钮的显隐只由
  // updateSendButton 维护，不在此重算会保留上一个工作区的可见性——表现为任务早已结束
  // 停止按钮仍常驻，或切进正在运行的工作区却没有停止按钮
  updateSendButton();

  // 切回工作区后对账 PDF 批次：其它 tab 期间该 workspace 的 run_complete 不被处理
  // （SSE 事件按 active workspace 过滤），有剩余计划时在此按 is_busy 恢复推进
  reconcilePdfBatching();

  // 刷新云端模型列表：切换 workspace 后目标 workspace 的服务端 ConfigStore 可能过期
  // （在另一个 workspace 添加云端模型时 config/set scope:0 只触发当前 workspace 的 autoReload），
  // 需要重新加载 S.providers（全局 admAgent.json，始终最新）、触发目标 workspace 配置重载、
  // 再拉取 /providers 快照并更新模型下拉。
  await refreshProvidersOnSwitch(wsId);

  updateWorkspaceSelector();
  updateDecisionModeUI();
  // 切换工作区后同步微信 follow session，防止微信消息仍用旧 workspace 的 session ID
  syncWxFollowSession();
}

// 切换 workspace 后刷新云端模型 provider 列表。
// 1) 从 admAgent.json 重新加载 S.providers（全局文件，始终最新）
// 2) 对目标 workspace 触发一次 config/set（scope:0），强制其 ConfigStore autoReload，
//    从而拾取全局配置文件中其他 workspace 添加的云端模型
// 3) 拉取目标 workspace 的 /providers 快照并更新模型下拉
async function refreshProvidersOnSwitch(wsId) {
  try {
    S.providers = await invoke("list_cloud_providers");
  } catch (_) {
    S.providers = [];
  }

  // 目标 workspace 的 ConfigStore 可能未加载最新的全局配置（cloud providers 在
  // 其他 workspace 通过 config/set scope:0 写入全局文件时只触发了那个 workspace 的
  // autoReload）。用第一个 provider 的 api_key 做一次幂等 config/set 来触发 reload。
  if (S.providers.length > 0 && S.serverInfo) {
    var trigger = S.providers[0];
    try {
      await api("POST", "/v1/workspaces/" + wsId + "/config/set", {
        scope: 0,
        key: "providers." + trigger.key + ".api_key",
        value: trigger.api_key || ""
      });
    } catch (_) {}
  }

  // 重置服务端快照（旧快照属于上一个 workspace），重新拉取目标 workspace 的 provider 列表
  S.serverProviders = [];
  S.serverProvidersLoaded = false;
  await refreshServerProviders();
  updateModelDropdown();
}

// ===== 工作目录列表缓存 =====
// 旧的「工作目录下拉」已替换为左侧工作区分组树（ws_tree.js），本模块只负责
// 提供目录列表数据（fetchWorkdirs）与切换动作（doSwitchWorkDir），
// 添加/移除目录的交互在 ws_tree.js 中实现。

/** 拉取工作目录列表并写入 S.workdirs（树渲染的数据源），完成后刷新树 */
export async function fetchWorkdirs() {
  try {
    S.workdirs = await invoke("get_workdirs");
  } catch (e) {
    console.warn("[agent] 加载工作目录列表失败:", e);
    if (!Array.isArray(S.workdirs)) S.workdirs = [];
  }
  renderConversationList();
}

// 执行工作目录切换：在已运行的 server 上创建新 workspace，成功后切换 tab
export async function doSwitchWorkDir(path) {
  try {
    if (!S.serverInfo || !S.serverInfo.workspace_id) {
      reportError(new Error("server not ready"), { prefix: _t("切换工作目录失败: ") });
      return;
    }
    // 通过 Rust 后端创建 workspace（启动独立 SSE 转发）
    var wsInfo = await invoke("create_workspace", { path: path, clientId: S.clientId });
    if (!wsInfo || !wsInfo.workspace_id) {
      reportError(new Error("server returned no workspace id"), { prefix: _t("切换工作目录失败: ") });
      return;
    }
    // 设为默认工作目录
    await invoke("set_default_workdir", { path: path });
    // 切换到新 workspace（保存旧状态，恢复新状态）
    await switchToWorkspace(wsInfo.workspace_id, path);
  } catch (e) {
    reportError(e, { prefix: _t("切换工作目录失败: ") });
  }
}

// 启动时验证工作目录列表（移除不存在的路径）
export async function validateWorkDirs() {
  try {
    var removed = await invoke("validate_workdirs");
    if (removed && removed.length > 0) {
      removed.forEach(function(path) {
        // 同步清理已失效目录的状态池条目
        var staleWsId = S.wsIdByPath[path];
        if (staleWsId) {
          store.removeWorkspace(staleWsId);
          delete S.wsIdByPath[path];
        }
        console.warn("[agent] 工作目录不存在，已从配置移除:", path);
      });
    }
    await fetchWorkdirs();
  } catch (e) {
    console.warn("[agent] 验证工作目录失败:", e);
  }
}

// ===== 工作区展示 =====
// 旧下拉标签已移除：工作区树的激活态/计数由 ws_tree.js 渲染时从 store 派生，
// 切换工作区后的树刷新经 loadConversations → renderConversationList 链路完成。
// 保留本函数为兼容入口（agent.js / settings_dialog.js 仍有调用点）。
export function updateWorkspaceSelector() {}
