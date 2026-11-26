// session_tools.js — admAgent 会话工具接口封装与展示模块
// 补齐以下服务端端点（契约见 doc/server-api.md）：
//   1. GET /v1/workspaces/{id}/sessions/{sid}/filetracker/files  已读文件列表（string[]）
//   2. GET /v1/workspaces/{id}/sessions/{sid}/history             文件历史快照（File[]）
//   3. GET /v1/workspaces/{id}/messages/user                      跨会话用户消息（Message[]）
//   4. POST /v1/workspaces/{id}/filetracker/read                  记录文件读取
// 独立模块：不依赖模板结构，渲染在 renderSessionTools 内完成，容器 id 由外部传入。
import { api } from "./api.js";
import { S } from "./store.js";
import { showError, reportError } from "./ui.js";
import { t as _t } from "../../i18n.js";

// 默认渲染容器 id（loadSessionTools 未显式传容器时使用）
var SESSION_TOOLS_CONTAINER = "agent-session-tools";
// 文件历史内容摘要截断长度（超出部分以 … 结尾）
var CONTENT_PREVIEW_LEN = 500;

// ===== 模块内数据缓存（loadSessionTools 写入，renderSessionTools 读取）=====
var sessionReadFiles = [];   // string[]：已读文件列表
var sessionFileHistory = []; // File[]：文件历史快照
var sessionUserMessages = []; // Message[]：跨会话用户消息
var sessionCurrentUserMessages = [];
var sessionToolsRequestSeq = 0;
var sessionToolsLoadedFor = "";

// 取当前工作区 ID（S.serverInfo.workspace_id 由 bindToS 同步）
function currentWsId() {
  return (S.serverInfo && S.serverInfo.workspace_id) || "";
}

// 截断过长文本（非字符串按空处理）
function truncateText(text, max) {
  if (typeof text !== "string") return "";
  if (text.length > max) return text.substring(0, max) + "…";
  return text;
}

// 提取消息文本：优先 content，缺省时拼接 text parts（Message 结构见 doc/server-api.md 附录 A）
function msgText(m) {
  if (!m) return "";
  if (typeof m.content === "string" && m.content) return m.content;
  var parts = m.parts;
  if (Array.isArray(parts)) {
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p && p.type === "text" && p.data && typeof p.data.text === "string") out.push(p.data.text);
    }
    return out.join("\n");
  }
  return "";
}

// 秒级时间戳 → 本地时间字符串（无效时间返回空串）
function fmtTime(ts) {
  if (!ts) return "";
  var d = new Date(ts * 1000);
  if (isNaN(d.getTime())) return "";
  var pad = function(n) { return (n < 10 ? "0" : "") + n; };
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

// 通用节点构造
function el(tag, cls, text) {
  var node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

// 内容摘要块：可滚动、保留换行，避免长内容撑爆布局
function contentBox(text) {
  var box = el("div", "session-tools-content");
  box.style.cssText =
    "margin-top:4px;padding:6px 8px;background:var(--c-bg-deep);border:1px solid var(--c-border-soft);" +
    "border-radius:4px;white-space:pre-wrap;word-break:break-all;max-height:160px;overflow:auto;" +
    "font-size:12px;line-height:1.5;color:var(--c-text-2);";
  box.textContent = text || "";
  return box;
}

// ===== 加载 =====
// 用 S.serverInfo.workspace_id 与 S.currentConvId 并行请求三个 GET，
export function loadSessionTools(containerId) {
  var wsId = currentWsId();
  var sid = S.currentConvId;
  if (!wsId || !sid) {
    sessionToolsRequestSeq++;
    sessionReadFiles = [];
    sessionFileHistory = [];
    sessionUserMessages = [];
    sessionCurrentUserMessages = [];
    sessionToolsLoadedFor = "";
    renderSessionTools(containerId || SESSION_TOOLS_CONTAINER);
    return Promise.resolve();
  }
  var requestKey = wsId + "|" + sid;
  var seq = ++sessionToolsRequestSeq;
  if (sessionToolsLoadedFor !== requestKey) {
    sessionReadFiles = [];
    sessionFileHistory = [];
    sessionUserMessages = [];
    sessionCurrentUserMessages = [];
    sessionToolsLoadedFor = requestKey;
  }
  var base = "/v1/workspaces/" + wsId;
  return Promise.allSettled([
    api("GET", base + "/sessions/" + sid + "/filetracker/files"),
    api("GET", base + "/sessions/" + sid + "/history"),
    api("GET", base + "/sessions/" + sid + "/messages/user"),
    api("GET", base + "/messages/user")
  ]).then(function(results) {
    if (seq !== sessionToolsRequestSeq || currentWsId() !== wsId || S.currentConvId !== sid) return;
    var names = [_t("已读文件"), _t("文件历史"), _t("当前会话用户消息"), _t("工作区用户消息")];
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      if (r.status === "fulfilled") {
        var v = r.value;
        if (i === 0) sessionReadFiles = Array.isArray(v) ? v : [];
        else if (i === 1) sessionFileHistory = Array.isArray(v) ? v : [];
        else if (i === 2) sessionCurrentUserMessages = Array.isArray(v) ? v : [];
        else sessionUserMessages = Array.isArray(v) ? v : [];
      } else {
        reportError(r.reason, { prefix: _t("加载") + names[i] + _t("失败: ") });
      }
    }
    renderSessionTools(containerId || SESSION_TOOLS_CONTAINER);
  });

}
// ===== 记录文件读取 =====
// POST /v1/workspaces/{id}/filetracker/read，请求体 { session_id, path }。
// 成功后把路径补进已读文件缓存并刷新面板（无需重新拉取）；供其他模块按需调用。
export function recordFileRead(path) {
  if (!path) return Promise.resolve();
  var wsId = currentWsId();

  var sid = S.currentConvId;
  if (!wsId || !sid) {
    showError(_t("未选择工作区或会话，无法记录文件读取"));
    return Promise.resolve();
  }
  return api("POST", "/v1/workspaces/" + wsId + "/filetracker/read", { session_id: sid, path: path })
    .then(function() {
      if (sessionReadFiles.indexOf(path) === -1) {
        sessionReadFiles = sessionReadFiles.concat([path]);
        renderSessionTools(SESSION_TOOLS_CONTAINER);
      }
    })
    .catch(function(e) {
      reportError(e, { prefix: _t("记录文件读取失败: ") });
    });
}

function loadLastReadTime(path) {
  var wsId = currentWsId();
  var sid = S.currentConvId;
  if (!path || !wsId || !sid) return Promise.resolve();
  var query = "path=" + encodeURIComponent(path) + "&session_id=" + encodeURIComponent(sid);
  return api("GET", "/v1/workspaces/" + wsId + "/filetracker/lastread?" + query)
    .then(function(value) {
      var timestamp = value && (value.last_read_at || value.lastread || value.timestamp || value.time || value);
      var result = document.getElementById("agent-last-read-result");
      if (result) result.textContent = _t("最后读取时间：") + (fmtTime(timestamp) || String(timestamp));
    })
    .catch(function(e) { reportError(e, { prefix: _t("查询最后读取时间失败: ") }); });
}

// ===== 渲染 =====
// 把容器渲染成可折叠面板：已读文件 / 文件历史 / 用户消息三节，空则显示占位。
// 全部用 createElement + textContent 构建，不注入 HTML，路径与内容按纯文本展示。
export function renderSessionTools(containerId) {
  var container = document.getElementById(containerId);
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);

  var root = el("div", "session-tools-root");
  root.style.cssText = "display:flex;flex-direction:column;gap:8px;";

  var lastReadControls = el("div", "session-tools-item");
  lastReadControls.style.cssText = "display:flex;gap:4px;align-items:center;padding:4px;";
  var lastReadInput = el("input", "settings-input");
  lastReadInput.type = "text";
  lastReadInput.placeholder = _t("相对工作区的文件路径");
  lastReadInput.style.flex = "1";
  lastReadControls.appendChild(lastReadInput);
  var lastReadBtn = el("button", "tool-fix-btn", _t("查最后读取时间"));
  lastReadBtn.type = "button";
  lastReadBtn.addEventListener("click", function() { loadLastReadTime(lastReadInput.value); });
  lastReadControls.appendChild(lastReadBtn);
  root.appendChild(lastReadControls);
  var lastReadResult = el("div", "session-tools-meta");
  lastReadResult.id = "agent-last-read-result";
  lastReadResult.style.cssText = "padding:2px 4px;font-size:11px;color:var(--c-text-4);";
  root.appendChild(lastReadResult);
  root.appendChild(buildSection(
    _t("已读文件"),
    function() {
      var out = [];
      for (var i = 0; i < sessionReadFiles.length; i++) {
        var row = el("div", "session-tools-item");
        row.style.cssText = "padding:4px 2px;font-size:12px;color:var(--c-text-2);word-break:break-all;";
        row.appendChild(el("span", "session-tools-dot", "•"));
        row.appendChild(el("span", "session-tools-path", sessionReadFiles[i]));
        out.push(row);
      }
      return out;
    },
    _t("暂无已读文件")
  ));
  root.appendChild(buildSection(
    _t("文件历史"),
    function() {
      var out = [];
      for (var i = 0; i < sessionFileHistory.length; i++) {
        var f = sessionFileHistory[i] || {};
        var item = el("div", "session-tools-item");
        item.style.cssText = "padding:6px 8px;background:var(--c-raise);border:1px solid var(--c-border-soft);border-radius:4px;";
        var meta = el("div", "session-tools-meta");
        meta.style.cssText = "font-size:12px;color:var(--c-text-3);word-break:break-all;";
        meta.appendChild(el("span", "session-tools-path", f.path || ""));
        var metaTail = [];
        if (f.version !== undefined && f.version !== null && f.version !== "") metaTail.push(_t("版本: ") + f.version);
        if (f.updated_at) metaTail.push(_t("更新于: ") + fmtTime(f.updated_at));
        if (metaTail.length > 0) {
          meta.appendChild(document.createTextNode("　" + metaTail.join("　")));
        }
        item.appendChild(meta);
        var readBtn = el("button", "tool-fix-btn", _t("记录已读"));
        readBtn.type = "button";
        readBtn.addEventListener("click", recordFileRead.bind(null, f.path || ""));
        item.appendChild(readBtn);
        out.push(item);
      }
      return out;
    },
    _t("暂无文件历史")
  ));

  root.appendChild(buildSection(
    _t("当前会话用户消息"),
    function() {
      var out = [];
      for (var i = 0; i < sessionCurrentUserMessages.length; i++) {
        var m = sessionCurrentUserMessages[i] || {};
        var item = el("div", "session-tools-item");
        item.style.cssText = "padding:6px 8px;background:var(--c-raise);border:1px solid var(--c-border-soft);border-radius:4px;";
        if (m.created_at) item.appendChild(el("div", "session-tools-meta", fmtTime(m.created_at)));
        item.appendChild(contentBox(msgText(m)));
        out.push(item);
      }
      return out;
    },
    _t("暂无当前会话用户消息")
  ));
  root.appendChild(buildSection(
    _t("用户消息（本工作区全部会话）"),
    function() {
      var out = [];
      for (var i = 0; i < sessionUserMessages.length; i++) {
        var m = sessionUserMessages[i] || {};
        var item = el("div", "session-tools-item");
        item.style.cssText = "padding:6px 8px;background:var(--c-raise);border:1px solid var(--c-border-soft);border-radius:4px;";
        var meta = el("div", "session-tools-meta");
        meta.style.cssText = "font-size:12px;color:var(--c-text-3);word-break:break-all;";
        var sessionTitle = "";
        if (Array.isArray(S.conversations)) {
          for (var c = 0; c < S.conversations.length; c++) {
            if (S.conversations[c] && S.conversations[c].id === m.session_id) { sessionTitle = S.conversations[c].title || ""; break; }
          }
        }
        meta.appendChild(el("span", "session-tools-path", (sessionTitle ? sessionTitle + " · " : "") + (m.session_id || _t("会话未知"))));
        if (m.created_at) meta.appendChild(document.createTextNode("　" + fmtTime(m.created_at)));
        item.appendChild(meta);
        item.appendChild(contentBox(msgText(m)));
        out.push(item);
      }
      return out;
    },
    _t("暂无用户消息")
  ));

  container.appendChild(root);
}

// 可折叠节：头部按钮（箭头 + 标题 + 计数）+ 正文列表，点击切换折叠。
function buildSection(title, itemRenderer, emptyText) {
  var items = itemRenderer();

  var header = el("button", "session-tools-header");
  header.type = "button";
  header.style.cssText =
    "display:flex;align-items:center;gap:6px;width:100%;padding:6px 8px;cursor:pointer;" +
    "background:var(--c-raise);border:1px solid var(--c-border);border-radius:6px;" +
    "font-size:13px;color:var(--c-text);text-align:left;";
  var arrow = el("span", "session-tools-arrow", "▾");
  arrow.style.cssText = "flex:0 0 auto;color:var(--c-text-3);";
  var label = el("span", "session-tools-title", title);
  label.style.cssText = "flex:1 1 auto;";
  header.appendChild(arrow);
  header.appendChild(label);
  if (items.length > 0) {
    var count = el("span", "session-tools-count", String(items.length));
    count.style.cssText = "flex:0 0 auto;font-size:11px;color:var(--c-text-4);";
    header.appendChild(count);
  }

  var body = el("div", "session-tools-body");
  body.style.cssText = "padding:6px 2px;display:flex;flex-direction:column;gap:4px;";
  if (items.length === 0) {
    var empty = el("div", "session-tools-empty", emptyText);
    empty.style.cssText = "padding:4px 2px;font-size:12px;color:var(--c-text-4);";
    body.appendChild(empty);
  } else {
    for (var i = 0; i < items.length; i++) body.appendChild(items[i]);
  }

  header.addEventListener("click", function() {
    var collapsed = body.style.display === "none";
    body.style.display = collapsed ? "" : "none";
    arrow.textContent = collapsed ? "▾" : "▸";
  });

  var wrap = el("div", "session-tools-section");
  wrap.style.cssText = "display:flex;flex-direction:column;";
  wrap.appendChild(header);
  wrap.appendChild(body);
  return wrap;
}
