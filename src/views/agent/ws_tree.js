// 左侧栏「工作区分组树」：替代旧的 工作目录下拉 + 平铺会话列表。
// 结构（参考桌面端聊天应用的堆叠侧栏）：
//   工作区 <计数> [＋添加工作目录]
//   ▸ [头像] 工作区名        ← 折叠/展开；悬停显示 + 新建会话 / 🗑 清除全部(仅激活) / ✕ 移除(非默认)
//      · 会话标题            ← 嵌套缩进；点击切换到该工作区并打开会话
//      · 还有 N 个           ← 每组默认只展开前 PREVIEW 条
// 数据边界：会话列表按 workspace 存在状态池（S.workspaces[wsId].conversations），
// 从未访问过的工作目录没有会话数据（服务端 workspace 尚未创建），展开时显示
// 「加载会话」入口，点击即执行 doSwitchWorkDir（创建 workspace 并切换）。
// 会话级操作（重命名/删除）只对激活工作区开放：API 路径取 S.serverInfo.workspace_id，
// 对非激活工作区的池化快照调用会打到错误 workspace。

import { t as _t } from "../../i18n.js";
import { S, invoke, store } from "./store.js";
import { escapeHtml } from "./utils.js";
import { showConfirm, reportError, showInfo } from "./ui.js";
import { selectConversation, newConversation, clearAllConversations, isClearAllInFlight, handleConvAction } from "./session.js";
import { switchToWorkspace, doSwitchWorkDir, fetchWorkdirs } from "./workspace.js";

// 每个展开的工作区默认显示的会话条数，超出部分折叠进「还有 N 个」
var PREVIEW_COUNT = 8;
// 展开状态：path → bool（模块级，切视图回来不丢）
var expanded = {};
// 「还有 N 个」展开状态：path → bool
var showAll = {};
// 切换工作区防抖：doSwitchWorkDir 会创建 workspace，快速连点会重复创建
var switchingPath = null;

var AVATAR_COLORS = ["#26a69a", "#5c6bc0", "#ef5350", "#ffa726", "#ab47bc", "#42a5f5", "#66bb6a", "#ec407a", "#8d6e63", "#26c6da"];

function avatarColor(path) {
  var hash = 0;
  for (var i = 0; i < path.length; i++) hash = (hash * 31 + path.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function wsName(path) {
  return path ? path.split(/[\\/]/).filter(Boolean).pop() || path : _t("默认工作区");
}

/** path → wsId（未访问过的工作目录没有映射，返回 null） */
function wsIdFor(path) {
  return S.wsIdByPath ? (S.wsIdByPath[path] || null) : null;
}

/** 当前激活工作区对应的目录 path；找不到返回 null（初始化中） */
function activePath() {
  if (S.workspaceInfo && S.workspaceInfo.path && wsIdFor(S.workspaceInfo.path) === S.activeWsId) {
    return S.workspaceInfo.path;
  }
  var dirs = S.workdirs || [];
  for (var i = 0; i < dirs.length; i++) {
    if (wsIdFor(dirs[i].path) === S.activeWsId) return dirs[i].path;
  }
  return null;
}

/** 工作区会话列表：激活工作区用 S.conversations（最新），已访问过的用状态池快照，未访问返回 null */
function sessionsFor(path) {
  var wsId = wsIdFor(path);
  if (!wsId) return null;
  if (wsId === S.activeWsId) return S.conversations || [];
  var snap = S.workspaces ? S.workspaces[wsId] : null;
  return snap ? (snap.conversations || []) : [];
}

/** 会话运行状态：running / queued / null */
function runStateOf(sessions, wsId, convId) {
  var snap = (wsId === S.activeWsId) ? null : (S.workspaces ? S.workspaces[wsId] : null);
  var runs = (wsId === S.activeWsId) ? (S.runs || []) : ((snap && snap.runs) || []);
  for (var i = 0; i < runs.length; i++) {
    if (runs[i] && runs[i].sessionId === convId) return runs[i].queued ? "queued" : "running";
  }
  // 池化快照兜底（如微信 Bot 等后台会话的 is_busy）
  if (snap && Array.isArray(snap.conversations)) {
    for (var j = 0; j < snap.conversations.length; j++) {
      if (snap.conversations[j] && snap.conversations[j].id === convId &&
          (snap.conversations[j].is_busy || snap.conversations[j].busy)) return "running";
    }
  }
  return null;
}

// ===== 动作 =====

/** 切换到指定工作目录（已激活则跳过）；防抖避免快速连点重复创建 workspace */
async function ensureSwitched(path) {
  if (activePath() === path) return true;
  if (switchingPath) {
    showInfo(_t("正在切换工作区，请稍候"));
    return false;
  }
  switchingPath = path;
  try {
    var wsId = wsIdFor(path);
    if (wsId) {
      await switchToWorkspace(wsId, path);
    } else {
      await doSwitchWorkDir(path);
    }
    return true;
  } finally {
    switchingPath = null;
  }
}

async function newConversationIn(path) {
  if (!(await ensureSwitched(path))) return;
  await newConversation();
}

function removeWorkdir(path) {
  showConfirm(_t("确定要移除工作目录「") + path + _t("」吗？"), async function() {
    try {
      await invoke("remove_workdir", { path: path });
      // 清理该 workspace 的状态池（会话/消息/运行状态），避免残留；
      // 该路径日后重新添加时 store.workspaces.has 为 false 会走首次初始化
      var removedWsId = wsIdFor(path);
      if (removedWsId) {
        store.removeWorkspace(removedWsId);
        delete S.wsIdByPath[path];
      }
      delete expanded[path];
      delete showAll[path];
      await fetchWorkdirs();
    } catch (err) {
      reportError(err, { prefix: _t("移除工作目录失败: ") });
    }
  });
}

async function addWorkDir() {
  try {
    var dir = await invoke("pick_workdir_folder");
    if (!dir) return;
    await invoke("add_workdir", { path: dir });
    await fetchWorkdirs();
    expanded[dir] = true; // 新添加的目录直接展开引导创建会话
    await doSwitchWorkDir(dir);
  } catch (err) {
    reportError(err, { prefix: _t("添加工作目录失败: ") });
  }
}

// ===== 渲染 =====

function ensureTreeDelegation(container) {
  var ref = /** @type {any} */ (container);
  if (ref._admWsTreeDelegated) return;
  ref._admWsTreeDelegated = true;
  container.addEventListener("click", function(e) {
    var target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    var btn = target.closest("[data-ws-action]");
    if (btn) {
      e.stopPropagation();
      var path = btn.getAttribute("data-ws-path") || "";
      var action = btn.getAttribute("data-ws-action");
      if (action === "add") newConversationIn(path);
      else if (action === "clear") clearAllConversations();
      else if (action === "remove") removeWorkdir(path);
      else if (action === "more") {
        showAll[path] = !showAll[path];
        renderWorkspaceTree();
      } else if (action === "load") {
        ensureSwitched(path);
      }
      return;
    }
    // 会话级操作按钮（仅激活工作区渲染）
    var convBtn = target.closest(".conv-action-btn");
    if (convBtn) {
      e.stopPropagation();
      var actItem = convBtn.closest(".ws-session-item");
      var convId = actItem ? actItem.getAttribute("data-conv-id") : null;
      var action2 = convBtn.getAttribute("data-action") || "";
      if (convId) handleConvAction(action2, convId);
      return;
    }
    // 嵌套会话：先切工作区（如需）再选中会话
    var sessItem = target.closest(".ws-session-item");
    if (sessItem) {
      var sessPath = sessItem.getAttribute("data-ws-path") || "";
      var sessConvId = sessItem.getAttribute("data-conv-id");
      (async function() {
        if (!(await ensureSwitched(sessPath))) return;
        if (sessConvId) await selectConversation(sessConvId);
      })();
      return;
    }
    // 工作区行：展开/收起（点击行内按钮时上面已 return）
    var row = target.closest(".ws-row");
    if (row) {
      var rowPath = row.getAttribute("data-ws-path") || "";
      expanded[rowPath] = !expanded[rowPath];
      renderWorkspaceTree();
    }
  });
}

function renderWorkspaceTree() {
  var container = document.getElementById("agent-ws-tree");
  if (!container) return;
  ensureTreeDelegation(container);

  var countEl = document.getElementById("agent-ws-count");
  if (countEl) countEl.textContent = String((S.workdirs || []).length);

  var dirs = (S.workdirs || []).slice();
  // 默认工作区排最前，其余按名称排序保证顺序稳定
  dirs.sort(function(a, b) {
    if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
    return wsName(a.path).localeCompare(wsName(b.path), "zh");
  });
  var activeWs = activePath();

  if (dirs.length === 0) {
    container.innerHTML = '<div class="ws-empty-hint">' + _t("暂无工作目录") + "</div>";
    return;
  }

  var frag = document.createDocumentFragment();
  dirs.forEach(function(d) {
    var path = d.path;
    var isActive = path === activeWs;
    // 激活工作区默认展开；其余保持用户上次的展开选择
    if (isActive && expanded[path] === undefined) expanded[path] = true;
    var isExpanded = !!expanded[path];
    var sessions = isExpanded ? sessionsFor(path) : [];
    var wsId = wsIdFor(path);

    var group = document.createElement("div");
    group.className = "ws-group";

    // 工作区行：折叠箭头 + 头像 + 名称 + 悬停操作
    var row = document.createElement("div");
    row.className = "ws-row" + (isActive ? " active" : "") + (isExpanded ? " expanded" : "");
    row.setAttribute("data-ws-path", path);
    row.title = path || "";
    row.innerHTML =
      '<span class="ws-chevron">▶</span>' +
      '<span class="ws-avatar" style="background:' + avatarColor(path) + '">' +
        escapeHtml((wsName(path) || "?").charAt(0).toUpperCase()) + "</span>" +
      '<span class="ws-name">' + escapeHtml(wsName(path)) + "</span>";

    var actions = document.createElement("span");
    actions.className = "ws-row-actions";
    var addBtn = document.createElement("button");
    addBtn.className = "ws-action-btn";
    addBtn.setAttribute("data-ws-action", "add");
    addBtn.setAttribute("data-ws-path", path);
    addBtn.title = _t("新建会话");
    addBtn.textContent = "＋";
    actions.appendChild(addBtn);
    if (isActive) {
      var clearBtn = document.createElement("button");
      clearBtn.className = "ws-action-btn danger";
      clearBtn.setAttribute("data-ws-action", "clear");
      clearBtn.title = _t("清除所有对话") + (isClearAllInFlight() ? "…" : "");
      clearBtn.textContent = "🗑";
      if (isClearAllInFlight() || !((S.conversations || []).length)) clearBtn.disabled = true;
      actions.appendChild(clearBtn);
    }
    if (!d.is_default) {
      var delBtn = document.createElement("button");
      delBtn.className = "ws-action-btn danger";
      delBtn.setAttribute("data-ws-action", "remove");
      delBtn.setAttribute("data-ws-path", path);
      delBtn.title = _t("移除");
      delBtn.textContent = "✕";
      actions.appendChild(delBtn);
    }
    row.appendChild(actions);
    group.appendChild(row);

    // 嵌套会话区
    if (isExpanded) {
      var listWrap = document.createElement("div");
      listWrap.className = "ws-sessions";
      if (sessions === null) {
        // 未访问过：无池化数据，需创建 workspace 才有会话列表
        var loadHint = document.createElement("button");
        loadHint.className = "ws-more-btn";
        loadHint.setAttribute("data-ws-action", "load");
        loadHint.setAttribute("data-ws-path", path);
        loadHint.textContent = _t("加载会话");
        listWrap.appendChild(loadHint);
      } else if (sessions.length === 0) {
        var empty = document.createElement("div");
        empty.className = "ws-empty-hint";
        empty.textContent = _t("暂无会话");
        listWrap.appendChild(empty);
      } else {
        var shown = showAll[path] ? sessions : sessions.slice(0, PREVIEW_COUNT);
        var convList = /** @type {any[]} */ (shown);
        convList.forEach(function(conv) {
          var item = document.createElement("div");
          var isCurrent = wsId === S.activeWsId && conv.id === S.currentConvId;
          var runState = runStateOf(sessions, wsId, conv.id);
          item.className = "ws-session-item" + (isCurrent ? " current" : "");
          item.setAttribute("data-ws-path", path);
          if (conv.id != null) item.setAttribute("data-conv-id", String(conv.id));
          // 运行状态优先于「当前会话」：运行中/排队的会话要在侧栏一眼可辨
          var dotCls = runState || (isCurrent ? "current" : "");
          item.innerHTML =
            '<span class="ws-session-dot ' + dotCls + '" title="' +
              (runState === "running" ? _t("运行中") : runState === "queued" ? _t("排队中") : "") + '"></span>' +
            '<span class="ws-session-title">' + escapeHtml(conv.title || conv.name || _t("新会话")) + "</span>";
          // 会话级操作只对激活工作区开放（API 路径取当前 workspace_id）
          if (wsId === S.activeWsId) {
            var sa = document.createElement("span");
            sa.className = "ws-session-actions";
            var rn = document.createElement("button");
            rn.className = "conv-action-btn";
            rn.setAttribute("data-action", "rename");
            rn.title = _t("重命名");
            rn.textContent = "✎";
            var dl = document.createElement("button");
            dl.className = "conv-action-btn delete";
            dl.setAttribute("data-action", "delete");
            dl.title = _t("删除");
            dl.textContent = "✕";
            sa.appendChild(rn);
            sa.appendChild(dl);
            item.appendChild(sa);
          }
          listWrap.appendChild(item);
        });
        if (sessions.length > PREVIEW_COUNT) {
          var more = document.createElement("button");
          more.className = "ws-more-btn";
          more.setAttribute("data-ws-action", "more");
          more.setAttribute("data-ws-path", path);
          more.textContent = showAll[path]
            ? _t("收起")
            : _t("还有 ") + (sessions.length - PREVIEW_COUNT) + _t(" 个");
          listWrap.appendChild(more);
        }
      }
      group.appendChild(listWrap);
    }

    frag.appendChild(group);
  });

  container.innerHTML = "";
  container.appendChild(frag);
}

export { renderWorkspaceTree, addWorkDir };
