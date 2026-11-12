/* =========================================================================
   紫语星枢 LilacLingua AI — renderer application (v3.2 / local NLLB)
   ========================================================================= */
(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const icon = (name, cls = "") => `<svg class="${cls}"><use href="#i-${name}"></use></svg>`;
  const uid = () => Math.random().toString(36).slice(2, 10);

  const FEATURES = {
    text: { name: "文本翻译", crumb: "文本翻译", icon: "text", hint: "输入文本，交给紫语星枢完成识别与翻译。" },
    video: { name: "视频识别", crumb: "视频识别", icon: "video", hint: "导入视频或直接监听系统声音，边听边译生成双语字幕。" },
    game: { name: "游戏识别", crumb: "游戏识别", icon: "game", hint: "捕获系统声音，为游戏与直播实时生成双语字幕。" },
    web: { name: "网页翻译", crumb: "网页翻译", icon: "globe", hint: "粘贴网址提取正文翻译，或使用识屏功能及独立识屏浮窗。" },
  };

  const PROVIDER_NAMES = {
    tencent: "腾讯神经翻译",
    mymemory: "MyMemory",
    "tencent+mymemory": "在线混合翻译",
    "nllb-local": "本地 NLLB",
    "lilac-local": "Lilac 本地模型",
    identity: "原文",
    none: "等待翻译",
  };

  const state = {
    feature: "text",
    source: "auto",
    target: "zh",
    asrLang: "zh",
    asrTarget: "auto",
    mode: "offline",
    conversations: [],
    activeId: null,
    messages: [],
    languages: [],
    health: null,
    settings: {},
    collapsed: false,
    busy: false,
    floatOpen: false,
    ocrFloatOpen: false,
    lastDetected: "",
    bilingual: true,
    live: null,
    video: { path: "", url: "", name: "", duration: 0, streaming: false, job: null },
    web: { url: "", article: null, lastOcr: null },
    pending: [],
    pendingTimer: null,
    partialTransTimer: null,
    partialTransBusy: false,
    streamQueue: [],
    streamBusy: false,
    historyLoaded: false,
    maxConversations: 80,
  };

  const desktop = window.lilac || makeBrowserBridge();

  function makeBrowserBridge() {
    const local = (key, fallback) => {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    };
    const save = (key, value) => {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {}
    };
    return {
      isElectron: false,
      appInfo: async () => ({ port: location.port, version: "3.0.0", userData: "", settings: local("lilac-settings", {}) }),
      quit: async () => {},
      window: {
        minimize: async () => {},
        maximize: async () => false,
        close: async () => {},
        isMaximized: async () => false,
        onMaximized: () => {},
      },
      history: {
        load: async () => local("lilac-history", { conversations: [], activeId: null }),
        save: async (data) => {
          save("lilac-history", data);
          return true;
        },
      },
      settings: {
        get: async () => local("lilac-settings", {}),
        patch: async (patch) => {
          const next = { ...local("lilac-settings", {}), ...patch };
          save("lilac-settings", next);
          return next;
        },
      },
      floating: {
        open: async () => {
          showToast("提示", "浮窗只在桌面应用中可用。", "info");
          return false;
        },
        close: async () => true,
        update: async () => true,
        setPinned: async () => true,
        setOpacity: async () => true,
        setFont: async () => true,
        setSize: async () => true,
        setClickThrough: async () => true,
        getBounds: async () => null,
        onContent: () => {},
        onState: () => {},
        onAppearance: () => {},
        onVisibility: () => {},
      },
      ocrFloating: {
        open: async () => false,
        close: async () => true,
        update: async () => true,
        capture: async () => "",
        onVisibility: () => {},
        onCapturedFromFloat: () => {},
      },
      desktopSources: async () => [],
      openMediaDialog: async () => null,
      fileUrl: async (path) => (path ? "file:///" + String(path).replace(/\\/g, "/") : ""),
      fileStat: async () => ({ exists: false }),
      getPathForFile: () => "",
      openExternal: async (url) => window.open(url, "_blank"),
      showItem: async () => {},
      onBackendDown: () => {},
      onAppInfo: () => {},
    };
  }

  // ------------------------------------------------------------------ helpers
  function showToast(title, message = "", type = "info", timeout = 4200) {
    const stack = $("#toastStack");
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="toast-icon">${icon(type === "error" ? "alert" : type === "success" ? "check" : "spark")}</span>
      <div class="toast-copy"><strong></strong><p></p></div>`;
    $("strong", el).textContent = title;
    $("p", el).textContent = message;
    stack.appendChild(el);
    setTimeout(() => {
      el.classList.add("leaving");
      setTimeout(() => el.remove(), 260);
    }, timeout);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function debounce(fn, wait) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  function langName(code) {
    if (!code || code === "auto") return "自动检测";
    const found = state.languages.find((item) => item.code === code);
    return found ? found.name : code;
  }

  function featureName(feature) {
    return (FEATURES[feature] || FEATURES.text).name;
  }

  function formatTime(ts) {
    const date = new Date(ts || Date.now());
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }

  function formatDateLabel(ts) {
    const date = new Date(ts);
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    if (sameDay) return "今天";
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return "昨天";
    return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
  }

  function truncate(text, max = 24) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    return value.length > max ? value.slice(0, max) + "…" : value;
  }

  function hasCjk(text) {
    return /[\u3400-\u9fff]/.test(text || "");
  }

  function scrollToBottom(el) {
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 180;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }

  // --------------------------------------------------------------------- API
  async function api(path, body = null, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeout || 90000);
    try {
      const response = await fetch(path, {
        method: body == null ? "GET" : "POST",
        headers: body == null ? undefined : { "Content-Type": "application/json" },
        body: body == null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || `请求失败（HTTP ${response.status}）`);
      }
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("请求超时，请检查网络后重试");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function waitBackend() {
    for (let i = 0; i < 60; i++) {
      try {
        const health = await api("/api/health", null, { timeout: 2500 });
        state.health = health;
        return health;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    }
    throw new Error("无法连接本地引擎");
  }

  // ------------------------------------------------------------------ history
  const persistHistory = debounce(async () => {
    if (!state.historyLoaded) return;
    const payload = {
      conversations: state.conversations.slice(0, state.maxConversations),
      activeId: state.activeId,
    };
    await desktop.history.save(payload);
  }, 260);

  function activeConversation() {
    return state.conversations.find((item) => item.id === state.activeId) || null;
  }

  function ensureConversation() {
    let convo = activeConversation();
    if (convo) return convo;
    convo = {
      id: uid(),
      title: "新对话",
      feature: state.feature,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    state.conversations.unshift(convo);
    state.activeId = convo.id;
    state.messages = convo.messages;
    return convo;
  }

  function addMessage(message) {
    const convo = ensureConversation();
    const item = {
      id: uid(),
      createdAt: Date.now(),
      feature: state.feature,
      ...message,
    };
    convo.messages.push(item);
    convo.updatedAt = Date.now();
    convo.feature = item.feature;
    if (convo.messages.length === 1) {
      convo.title = truncate(item.original || "新对话", 26);
    }
    state.messages = convo.messages;
    persistHistory();
    renderMessages();
    renderHistory();
    updatePageHeading();
    updateFloat();
    return item;
  }

  function updateMessage(id, patch) {
    const convo = activeConversation();
    if (!convo) return;
    const msg = convo.messages.find((item) => item.id === id);
    if (!msg) return;
    Object.assign(msg, patch);
    convo.updatedAt = Date.now();
    persistHistory();
    renderMessages();
    updateFloat();
  }

  function newChat(notify = true) {
    stopLive({ silent: true });
    pauseVideo();
    const previous = activeConversation();
    if (previous && previous.messages.length) {
      if (notify) showToast("已保存", "上一段原文与译文已存入历史对话。", "success", 3000);
    }
    state.activeId = null;
    state.messages = [];
    state.lastDetected = "";
    state.web = { url: "", article: null, lastOcr: null };
    $("#webUrl").value = "";
    $("#sourceInput").value = "";
    updateInputCount();
    renderAll();
    setTimeout(() => $("#sourceInput").focus(), 80);
  }

  function loadConversation(id) {
    const convo = state.conversations.find((item) => item.id === id);
    if (!convo) return;
    if (state.live) stopLive({ silent: true });
    state.activeId = id;
    state.messages = convo.messages;
    const last = convo.messages[convo.messages.length - 1];
    const feature = (last && last.feature) || convo.feature || "text";
    if (feature !== state.feature) {
      state.feature = feature;
      applyFeatureUI();
    }
    if (feature === "web") {
      const articleMsg = [...convo.messages].reverse().find((m) => m.article);
      if (articleMsg) {
        state.web = { url: articleMsg.article.url, article: articleMsg.article, lastOcr: null };
        $("#webUrl").value = articleMsg.article.url || "";
      }
    }
    renderAll();
    updatePageHeading();
    showToast("已载入历史", truncate(convo.title, 28), "info", 2600);
  }

  async function deleteConversation(id) {
    const convo = state.conversations.find((item) => item.id === id);
    if (!convo) return;
    const ok = await confirmDialog("删除这段对话？", `“${truncate(convo.title, 30)}”及其原文与译文将被移除。`, "删除");
    if (!ok) return;
    state.conversations = state.conversations.filter((item) => item.id !== id);
    if (state.activeId === id) {
      state.activeId = null;
      state.messages = [];
    }
    persistHistory();
    renderAll();
  }

  async function clearHistory() {
    if (!state.conversations.length) return;
    const ok = await confirmDialog("清空全部历史？", "所有对话中的原文与译文都会被删除，此操作无法撤销。", "清空");
    if (!ok) return;
    state.conversations = [];
    state.activeId = null;
    state.messages = [];
    persistHistory();
    renderAll();
    showToast("历史已清空", "", "success");
  }

  function renderHistory() {
    const list = $("#historyList");
    list.innerHTML = "";
    const conversations = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!conversations.length) {
      list.innerHTML = `<div class="history-empty">${icon("history")}<div>还没有保存的对话<br>翻译一次后会自动出现在这里</div></div>`;
      return;
    }
    let group = "";
    for (const convo of conversations) {
      const label = formatDateLabel(convo.updatedAt);
      if (label !== group) {
        group = label;
        const heading = document.createElement("div");
        heading.className = "history-group";
        heading.textContent = label;
        list.appendChild(heading);
      }
      const button = document.createElement("button");
      button.className = "history-item" + (convo.id === state.activeId ? " active" : "");
      const feature = (convo.messages[convo.messages.length - 1] || {}).feature || convo.feature || "text";
      const preview = convo.messages.length
        ? (convo.messages[convo.messages.length - 1].translated || convo.messages[convo.messages.length - 1].original || "")
        : "空对话";
      button.innerHTML = `<span class="history-icon">${icon(FEATURES[feature] ? FEATURES[feature].icon : "text")}</span>
        <span class="history-copy"><strong></strong><small></small></span>
        <span class="history-del" title="删除">${icon("trash")}</span>`;
      $("strong", button).textContent = convo.title || "新对话";
      $("small", button).textContent = `${formatTime(convo.updatedAt)} · ${truncate(preview, 20)}`;
      button.addEventListener("click", () => loadConversation(convo.id));
      $(".history-del", button).addEventListener("click", (event) => {
        event.stopPropagation();
        deleteConversation(convo.id);
      });
      list.appendChild(button);
    }
  }

  // ------------------------------------------------------------------- render
  function renderAll() {
    applyFeatureUI();
    renderMessages();
    renderHistory();
    updatePageHeading();
    updateStatusBars();
    updateControls();
  }

  function applyFeatureUI() {
    const feature = state.feature;
    $$(".feature-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.feature === feature));
    $$(".ws-item").forEach((item) => item.classList.toggle("active", item.dataset.feature === feature));
    $("#crumbFeature").textContent = FEATURES[feature].name;
    $("#pageSub").textContent = FEATURES[feature].hint;
    $("#textComposer").classList.toggle("hidden", feature !== "text");
    $("#videoStage").classList.toggle("hidden", feature !== "video");
    $("#gameStage").classList.toggle("hidden", feature !== "game");
    $("#webBar").classList.toggle("hidden", feature !== "web");
    $("#langBarText").classList.toggle("hidden", feature === "video" || feature === "game");
    $("#langBarAsr").classList.toggle("hidden", feature !== "video" && feature !== "game");
    $("#sourceMeta").textContent = feature === "text" || feature === "web"
      ? (state.source === "auto" ? (state.lastDetected ? `检测为 ${langName(state.lastDetected)}` : "自动检测") : langName(state.source))
      : (state.asrLang === "auto" ? "自动识别 · 中英" : langName(state.asrLang));
    if (!state.messages.length) {
      const emptyTitle = $("#emptyTitle");
      const emptyText = $("#emptyText");
      const chips = $("#sampleChips");
      if (feature === "text") {
        emptyTitle.textContent = "把世界，翻译给你听";
        emptyText.textContent = "在左侧输入文本，或试试下面的句子。";
        chips.classList.remove("hidden");
      } else if (feature === "video") {
        emptyTitle.textContent = "视频里说的话，实时变成双语字幕";
        emptyText.textContent = "导入本地视频识别，或点击“监听系统声音”直接识别电脑上正在播放的视频。";
        chips.classList.add("hidden");
      } else if (feature === "game") {
        emptyTitle.textContent = "游戏声音，边听边译";
        emptyText.textContent = "允许屏幕共享后捕获系统音频，字幕与译文会实时同步显示在右侧与浮窗。";
        chips.classList.add("hidden");
      } else {
        emptyTitle.textContent = "输入网址翻译网页，或一键识屏翻译";
        emptyText.textContent = "紫语星枢支持提取网页正文翻译，也支持框选屏幕文字并发送到独立识屏浮窗。";
        chips.classList.add("hidden");
      }
    }
    updatePrimaryButton();
  }

  function updatePageHeading() {
    const convo = activeConversation();
    const title = convo && convo.title && convo.title !== "新对话" ? convo.title : "新对话";
    $("#pageTitle").textContent = title;
    $("#crumbTitle").textContent = title;
    document.title = `${title} · 紫语星枢`;
  }

  function updatePrimaryButton() {
    const label = $("#primaryLabel");
    const button = $("#primaryBtn");
    const rail = $("#railPrimaryBtn");
    button.classList.remove("recording");
    rail.classList.remove("recording");
    if (state.feature === "text") {
      label.textContent = state.busy ? "翻译中…" : "翻译";
      button.disabled = state.busy;
      rail.innerHTML = icon("spark");
      rail.title = "翻译";
    } else if (state.feature === "video") {
      const live = state.live && state.live.feature === "video";
      const sysLive = live && state.live.systemLoopback;
      label.textContent = live ? (sysLive ? "停止监听" : "停止识别") : (state.video.path ? "开始识别" : "监听系统声音");
      button.classList.toggle("recording", Boolean(live));
      rail.classList.toggle("recording", Boolean(live));
      rail.innerHTML = live ? icon("stop") : icon(state.video.path ? "mic" : "headphones");
      rail.title = label.textContent;
    } else if (state.feature === "game") {
      const live = state.live && state.live.feature === "game";
      label.textContent = live ? "停止监听" : "开始监听";
      button.classList.toggle("recording", Boolean(live));
      rail.classList.toggle("recording", Boolean(live));
      rail.innerHTML = live ? icon("stop") : icon("headphones");
      rail.title = live ? "停止监听" : "开始监听";
    } else {
      label.textContent = "翻译网页";
      button.disabled = false;
      rail.innerHTML = icon("globe");
      rail.title = "翻译网页";
    }
    const gameBtn = $("#gameStartBtn");
    if (gameBtn) {
      const live = state.live && state.live.feature === "game";
      gameBtn.innerHTML = `${icon(live ? "stop" : "mic")}<span>${live ? "停止监听" : "开始监听"}</span>`;
      gameBtn.classList.toggle("recording", Boolean(live));
    }
    const videoBtn = $("#videoAsrBtn");
    if (videoBtn) {
      const live = state.live && state.live.feature === "video" && !state.live.systemLoopback;
      videoBtn.innerHTML = `${icon(live ? "stop" : "mic")}<span>${live ? "停止识别" : "开始识别"}</span>`;
      videoBtn.classList.toggle("recording", Boolean(live));
    }
    const videoSysBtn = $("#videoSysAudioBtn");
    const videoPlayerSysBtn = $("#videoPlayerSysAudioBtn");
    const sysLive = state.live && state.live.feature === "video" && state.live.systemLoopback;
    if (videoSysBtn) {
      videoSysBtn.innerHTML = `${icon(sysLive ? "stop" : "headphones")}<span>${sysLive ? "停止系统监听" : "监听系统声音"}</span>`;
      videoSysBtn.classList.toggle("recording", Boolean(sysLive));
    }
    if (videoPlayerSysBtn) {
      videoPlayerSysBtn.innerHTML = `${icon(sysLive ? "stop" : "headphones")}<span>${sysLive ? "停止系统监听" : "系统声音监听"}</span>`;
      videoPlayerSysBtn.classList.toggle("recording", Boolean(sysLive));
    }
  }

  function updateControls() {
    const disabled = Boolean(state.live);
    $("#sourceLang").disabled = disabled;
    $("#targetLang").disabled = disabled;
    $("#asrLang").disabled = disabled;
    $("#asrTargetLang").disabled = disabled;
    $("#modeSelect").disabled = disabled;
    $("#sourceHint").textContent =
      state.feature === "text" || state.feature === "web"
        ? (state.source === "auto" ? "自动检测源语言" : `${langName(state.source)} → ${langName(state.target)}`)
        : `语音：${state.asrLang === "auto" ? "自动" : langName(state.asrLang)} → ${state.asrTarget === "auto" ? "智能对译" : langName(state.asrTarget)}`;
    const nllbReady = Boolean(state.health && state.health.nllb && state.health.nllb.available);
    const mode = state.mode === "offline" ? (nllbReady ? "本地 NLLB" : "本地回退") : "在线增强";
    $("#engineBadge").classList.toggle("offline", state.mode === "offline");
    $("#engineBadge").innerHTML = `<span></span>${state.mode === "offline" ? (nllbReady ? "本地 NLLB" : "Lilac 回退") : "腾讯神经引擎"}`;
    const engineMode = $("#engineMode");
    if (engineMode) engineMode.textContent = mode;
  }

  function updateStatusBars() {
    const health = state.health;
    if (!health) return;
    const asrOk = health.asr && health.asr.models && (health.asr.models.zh.available || health.asr.models.en.available);
    const nllb = health.nllb || {};
    const nllbOk = Boolean(nllb.available);
    $("#statusDot").className = "status-dot" + (asrOk && (state.mode !== "offline" || nllbOk) ? "" : " warn");
    $("#statusText").textContent = state.mode === "offline"
      ? (nllbOk ? "本地 NLLB 模式" : "本地 Lilac 回退")
      : "在线增强模式";
    $("#statusSub").textContent = state.mode === "offline"
      ? (nllbOk ? "NLLB 600M · 离线语音" : "本地模型就绪 · 离线语音")
      : "在线神经 · 离线语音";
    $("#backendStatus").textContent = "本地引擎已连接";
    const models = health.asr && health.asr.models ? health.asr.models : {};
    const asrParts = [];
    if (models.zh && models.zh.available) asrParts.push("中文");
    if (models.en && models.en.available) asrParts.push("英语");
    $("#asrStatus").textContent = asrParts.length ? `语音模型 · ${asrParts.join(" / ")}` : "语音模型未安装";
    $("#versionText").textContent = `v${health.version || "3.0"}`;
    const trans = $("#engineTrans");
    if (trans) {
      const online = state.mode === "online";
      trans.textContent = online ? "腾讯神经" : (nllbOk ? "NLLB 600M" : "Lilac 回退");
      trans.className = online || nllbOk ? "ok" : "bad";
      $("#engineAsr").textContent = asrParts.length ? asrParts.join(" / ") : "未安装";
      $("#engineAsr").className = asrParts.length ? "ok" : "bad";
      $("#engineLocal").textContent = nllbOk ? (nllb.loaded ? "NLLB 已加载" : "NLLB 加载中") : (health.local_model ? "Lilac 回退" : "不可用");
      $("#engineLocal").className = nllbOk ? "ok" : (health.local_model ? "" : "bad");
      $("#engineMode").textContent = state.mode === "offline" ? "本地" : "在线";
    }
  }

  // -------------------------------------------------------------- message UI
  function messageMeta(msg, index) {
    const time = msg.mediaTime != null ? formatClock(msg.mediaTime) : formatTime(msg.createdAt);
    const extras = [];
    if (msg.confidence != null) extras.push(`置信度 ${Math.round(msg.confidence * 100)}%`);
    if (msg.isOcr) extras.push("识屏 OCR");
    return `<div class="msg-meta"><span class="msg-index">${String(index + 1).padStart(2, "0")}</span>
      <span class="msg-time">${icon("history")}${escapeHtml(time)}</span>
      ${msg.source ? `<span>${escapeHtml(langName(msg.source))}</span>` : ""}
      ${extras.length ? `<span>${escapeHtml(extras.join(" · "))}</span>` : ""}</div>`;
  }

  function formatClock(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(total / 60);
    const secs = Math.floor(total % 60);
    return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  function buildMessageNode(msg, index, side) {
    const wrapper = document.createElement("article");
    wrapper.className = "msg";
    wrapper.dataset.msgId = msg.id;
    const text = side === "source" ? msg.original : msg.translated;
    if (text == null || text === "") {
      wrapper.innerHTML = `${messageMeta(msg, index)}<div class="loading-line"></div><div class="loading-line short"></div>`;
      return wrapper;
    }
    wrapper.innerHTML = `${messageMeta(msg, index)}<p class="msg-text${hasCjk(text) ? " zh-line" : ""}">${escapeHtml(text)}</p>
      <div class="msg-foot">
        ${msg.provider ? `<span class="msg-tag">${icon("cpu")}${escapeHtml(PROVIDER_NAMES[msg.provider] || msg.provider)}</span>` : ""}
        ${msg.isOcr ? `<span class="msg-tag">${icon("eye")}识屏</span>` : msg.feature === "web" ? `<span class="msg-tag">${icon("book")}网页</span>` : ""}
        <button class="msg-copy" data-copy-text="${escapeHtml(text)}" data-copy-side="${side}">${icon("copy")}复制</button>
      </div>`;
    wrapper.addEventListener("mouseenter", () => syncHighlight(msg.id, true));
    wrapper.addEventListener("mouseleave", () => syncHighlight(msg.id, false));
    return wrapper;
  }

  function syncHighlight(msgId, active) {
    $$(`[data-msg-id="${msgId}"]`).forEach((el) => el.classList.toggle("synced", active));
    $$(`.article-p[data-msg-id="${msgId}"]`).forEach((el) => el.classList.toggle("synced", active));
  }

  function renderMessages() {
    const sourceList = $("#sourceMessages");
    const targetList = $("#targetMessages");
    const sourceEmpty = $("#sourceEmpty");
    const targetEmpty = $("#targetEmpty");
    $$(".msg", sourceList).forEach((el) => el.remove());
    $$(".msg", targetList).forEach((el) => el.remove());
    $$(".article-page", sourceList).forEach((el) => el.remove());
    $$(".article-page", targetList).forEach((el) => el.remove());
    $("#targetIntro").classList.add("hidden");
    $("#targetIntro").innerHTML = "";

    const messages = state.messages;
    if (!messages.length) {
      sourceEmpty.classList.remove("hidden");
      targetEmpty.classList.remove("hidden");
      $("#sourceStat").textContent = "0 字";
      $("#providerStat").textContent = "等待翻译";
      $("#latencyStat").textContent = "—";
      $("#targetMeta").textContent = state.feature === "web" ? "等待网页或识屏" : "等待翻译";
      return;
    }
    sourceEmpty.classList.add("hidden");
    targetEmpty.classList.add("hidden");

    const latest = messages[messages.length - 1];
    if (latest.feature === "web" && latest.article) {
      $("#sourceMeta").textContent = `检测为 ${langName(latest.source)}`;
      renderArticle(latest, sourceList, targetList);
      return;
    }

    messages.forEach((msg, index) => {
      sourceList.appendChild(buildMessageNode(msg, index, "source"));
      targetList.appendChild(buildMessageNode(msg, index, "target"));
    });
    const totalChars = messages.reduce((sum, msg) => sum + String(msg.original || "").length, 0);
    $("#sourceStat").textContent = `${totalChars} 字 · ${messages.length} 段`;
    $("#providerStat").textContent = PROVIDER_NAMES[latest.provider] || latest.provider || "等待翻译";
    $("#latencyStat").textContent = latest.latencyMs ? `${Math.round(latest.latencyMs)} ms` : "—";
    $("#targetMeta").textContent = `${langName(latest.source)} → ${langName(latest.target)}`;
    $("#sourceMeta").textContent = latest.feature === "text" || latest.isOcr
      ? `检测为 ${langName(latest.source)}`
      : `${langName(latest.source)} · 语音识别`;
    scrollToBottom(sourceList);
    scrollToBottom(targetList);
  }

  function renderArticle(msg, sourceList, targetList) {
    const article = msg.article;
    const titleText = String(article.title || "").trim();
    const paragraphs = (article.paragraphs || []).filter((paragraph) => {
      const text = String(paragraph.original || "").trim();
      return text && text !== titleText;
    });
    const sourcePage = document.createElement("div");
    sourcePage.className = "article-page";
    sourcePage.innerHTML = `<div class="article-head">
      <span class="article-source-label">${icon("globe")}网页原文</span>
      <h2 class="article-title"></h2>
      <div class="article-url"></div>
    </div><div class="article-body"></div>`;
    $(".article-title", sourcePage).textContent = article.title || "网页正文";
    $(".article-url", sourcePage).textContent = article.url || "";
    const sourceBody = $(".article-body", sourcePage);
    paragraphs.forEach((paragraph, index) => {
      const p = document.createElement("p");
      p.className = "article-p";
      p.dataset.tag = paragraph.tag || "p";
      p.dataset.msgId = msg.id;
      p.dataset.paragraph = String(index);
      p.textContent = paragraph.original;
      p.addEventListener("mouseenter", () => highlightParagraph(index, true));
      p.addEventListener("mouseleave", () => highlightParagraph(index, false));
      sourceBody.appendChild(p);
    });
    sourceList.appendChild(sourcePage);

    const targetPage = document.createElement("div");
    targetPage.className = "article-page";
    targetPage.innerHTML = `<div class="article-head">
      <span class="article-source-label">${icon("spark")}网页译文 · ${escapeHtml(langName(msg.target))}</span>
      <h2 class="article-title"></h2>
      <div class="article-url"></div>
    </div><div class="article-body"></div>`;
    $(".article-title", targetPage).textContent = article.translated_title || article.title || "网页译文";
    $(".article-url", targetPage).textContent = `${paragraphs.length} 段 · ${PROVIDER_NAMES[msg.provider] || "神经翻译"}`;
    const targetBody = $(".article-body", targetPage);
    paragraphs.forEach((paragraph, index) => {
      const p = document.createElement("p");
      p.className = "article-p";
      p.dataset.tag = paragraph.tag || "p";
      p.dataset.msgId = msg.id;
      p.dataset.paragraph = String(index);
      const text = paragraph.translated || "…";
      const original = state.bilingual && paragraph.original
        ? `<span class="bilingual-original">${escapeHtml(paragraph.original)}</span>`
        : "";
      p.innerHTML = `${escapeHtml(text)}${original}`;
      p.addEventListener("mouseenter", () => highlightParagraph(index, true));
      p.addEventListener("mouseleave", () => highlightParagraph(index, false));
      targetBody.appendChild(p);
    });
    targetList.appendChild(targetPage);

    const latest = state.messages[state.messages.length - 1];
    $("#sourceStat").textContent = `${article.char_count || 0} 字 · ${paragraphs.length} 段`;
    $("#providerStat").textContent = PROVIDER_NAMES[latest.provider] || latest.provider || "等待翻译";
    $("#latencyStat").textContent = latest.latencyMs ? `${Math.round(latest.latencyMs)} ms` : "—";
    $("#targetMeta").textContent = `${langName(latest.source)} → ${langName(latest.target)}`;
    sourceList.scrollTop = 0;
    targetList.scrollTop = 0;
  }

  function highlightParagraph(index, active) {
    $$(`[data-paragraph="${index}"]`).forEach((el) => el.classList.toggle("synced", active));
  }

  // --------------------------------------------------------------- web page & Screen OCR
  async function translateWebPage() {
    const url = $("#webUrl").value.trim();
    if (!url) {
      showToast("请输入网址", "例如 https://example.com/article，或点击右侧“识屏翻译”", "info");
      $("#webUrl").focus();
      return;
    }
    if (state.busy) return;
    state.busy = true;
    updatePrimaryButton();
    $("#webTranslateBtn").disabled = true;
    $("#targetMeta").textContent = "正在抓取网页正文…";
    showTargetSkeleton("正在抓取网页并提取正文", "随后会自动翻译全部段落");
    try {
      const result = await api("/api/web/translate", {
        url,
        source: state.source,
        target: state.target,
        mode: state.mode,
      }, { timeout: 180000 });
      const article = {
        url: result.url,
        title: result.title,
        translated_title: result.translated_title,
        paragraphs: result.paragraphs,
        char_count: result.char_count,
      };
      state.web = { url: result.url, article, lastOcr: state.web.lastOcr };
      addMessage({
        feature: "web",
        original: result.title,
        translated: result.translated_title,
        source: result.detected_source || state.source,
        target: state.target,
        provider: result.provider,
        latencyMs: result.latency_ms,
        article,
      });
      state.lastDetected = result.detected_source || state.lastDetected;
      $("#sourceMeta").textContent = result.detected_source ? `检测为 ${langName(result.detected_source)}` : "自动检测";
      showToast("网页翻译完成", `已翻译 ${result.paragraphs ? result.paragraphs.length : 0} 段正文`, "success");
      updateFloat();
    } catch (error) {
      showToast("网页翻译失败", error.message, "error", 7000);
      $("#targetMeta").textContent = "翻译失败";
    } finally {
      state.busy = false;
      updatePrimaryButton();
      $("#webTranslateBtn").disabled = false;
      hideTargetSkeleton();
    }
  }

  async function startScreenOcr() {
    if (!desktop.isElectron) {
      showToast("仅桌面版可用", "识屏翻译需要在 Electron 桌面应用中运行。", "info");
      return;
    }
    showToast("正在准备识屏…", "请拖拽鼠标框选需要识别翻译的屏幕区域，或直接点击“识别整屏”。", "info", 2400);
    try {
      const fullDataUrl = await desktop.ocrFloating.capture({ hideMain: true });
      if (!fullDataUrl) throw new Error("未能捕获屏幕画面");
      const croppedDataUrl = await showOcrCropOverlay(fullDataUrl);
      if (!croppedDataUrl) return;
      await runOcrTranslation(croppedDataUrl);
    } catch (error) {
      showToast("识屏失败", error.message, "error", 5000);
    }
  }

  function showOcrCropOverlay(dataUrl) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:999;background:rgba(15,6,30,0.82);display:flex;flex-direction:column;align-items:center;justify-content:center;user-select:none;";
      overlay.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;color:#f5edff;font-size:12px;">
          <span>🖱️ 在下方画面上<strong>按住鼠标左键拖拽框选</strong>要识别的文字区域</span>
          <button id="ocrFullBtn" class="primary-btn small">识别整屏</button>
          <button id="ocrCancelBtn" class="ghost-btn small" style="color:#fff;background:rgba(255,255,255,0.12);">取消 (Esc)</button>
        </div>
        <div id="ocrCanvasWrap" style="position:relative;max-width:92vw;max-height:82vh;border-radius:12px;overflow:hidden;border:2px solid rgba(192,132,252,0.6);box-shadow:0 20px 60px rgba(0,0,0,0.7);cursor:crosshair;">
          <img id="ocrPreviewImg" src="${dataUrl}" style="display:block;max-width:92vw;max-height:82vh;pointer-events:none;" />
          <div id="ocrRectBox" style="position:absolute;border:2px solid #a855f7;background:rgba(168,85,247,0.18);display:none;pointer-events:none;"></div>
        </div>
      `;
      document.body.appendChild(overlay);

      const img = $("#ocrPreviewImg", overlay);
      const wrap = $("#ocrCanvasWrap", overlay);
      const box = $("#ocrRectBox", overlay);
      let dragging = false;
      let startX = 0;
      let startY = 0;

      const cleanup = (result) => {
        window.removeEventListener("keydown", onKey);
        overlay.remove();
        resolve(result);
      };

      const onKey = (e) => {
        if (e.key === "Escape") cleanup(null);
      };
      window.addEventListener("keydown", onKey);

      $("#ocrCancelBtn", overlay).addEventListener("click", () => cleanup(null));
      $("#ocrFullBtn", overlay).addEventListener("click", () => cleanup(dataUrl));

      wrap.addEventListener("pointerdown", (e) => {
        const rect = img.getBoundingClientRect();
        dragging = true;
        startX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        startY = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
        box.style.left = `${startX}px`;
        box.style.top = `${startY}px`;
        box.style.width = "0px";
        box.style.height = "0px";
        box.style.display = "block";
        wrap.setPointerCapture(e.pointerId);
      });

      wrap.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const rect = img.getBoundingClientRect();
        const curX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        const curY = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
        const x = Math.min(startX, curX);
        const y = Math.min(startY, curY);
        const w = Math.abs(curX - startX);
        const h = Math.abs(curY - startY);
        box.style.left = `${x}px`;
        box.style.top = `${y}px`;
        box.style.width = `${w}px`;
        box.style.height = `${h}px`;
      });

      wrap.addEventListener("pointerup", (e) => {
        if (!dragging) return;
        dragging = false;
        const rect = img.getBoundingClientRect();
        const curX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        const curY = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
        const x = Math.min(startX, curX);
        const y = Math.min(startY, curY);
        const w = Math.abs(curX - startX);
        const h = Math.abs(curY - startY);

        if (w < 14 || h < 14) {
          box.style.display = "none";
          return;
        }
        const scaleX = img.naturalWidth / rect.width;
        const scaleY = img.naturalHeight / rect.height;
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(w * scaleX);
        canvas.height = Math.round(h * scaleY);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(
          img,
          Math.round(x * scaleX),
          Math.round(y * scaleY),
          canvas.width,
          canvas.height,
          0,
          0,
          canvas.width,
          canvas.height
        );
        cleanup(canvas.toDataURL("image/png"));
      });
    });
  }

  async function runOcrTranslation(imageDataUrl) {
    if (!imageDataUrl) return;
    state.busy = true;
    showTargetSkeleton("正在识屏并翻译文字…", "调用本地 OCR 引擎提取画面文本");
    try {
      const res = await api("/api/ocr/translate", {
        image: imageDataUrl,
        source: state.source,
        target: state.target,
        mode: state.mode,
      }, { timeout: 60000 });

      if (res.empty || !res.original) {
        showToast("未识别到文字", res.message || "请框选包含清晰文字的区域重试。", "info", 4000);
        return;
      }

      const ocrPayload = {
        original: res.original,
        translated: res.translated,
        source: res.source_name || langName(res.source),
        target: res.target_name || langName(res.target),
        feature: "识屏翻译",
        live: false,
      };
      state.web.lastOcr = ocrPayload;

      addMessage({
        feature: "web",
        isOcr: true,
        original: res.original,
        translated: res.translated,
        source: res.source || state.source,
        target: res.target || state.target,
        provider: res.provider,
        latencyMs: res.latency_ms,
      });

      await desktop.ocrFloating.open(ocrPayload);
      state.ocrFloatOpen = true;
      updateOcrFloatButton();
      showToast("识屏翻译完成", "结果已同步至右侧与独立识屏浮窗。", "success", 3200);
    } catch (error) {
      showToast("识屏翻译失败", error.message, "error", 6000);
    } finally {
      state.busy = false;
      hideTargetSkeleton();
    }
  }

  async function toggleOcrFloat(forceOpen = null) {
    const shouldOpen = forceOpen == null ? !state.ocrFloatOpen : Boolean(forceOpen);
    if (shouldOpen) {
      const content = state.web.lastOcr || {
        original: "点击浮窗顶部“⚡ 立即识屏”或主界面“识屏翻译”抓取屏幕文字。",
        translated: "Screen OCR floating window is ready.",
        source: langName(state.source),
        target: langName(state.target),
        feature: "识屏翻译",
        live: false,
      };
      await desktop.ocrFloating.open(content);
      state.ocrFloatOpen = true;
      showToast("识屏浮窗已打开", "可随时点击浮窗上的“⚡ 立即识屏”捕获画面文字。", "success", 2800);
    } else {
      await desktop.ocrFloating.close();
      state.ocrFloatOpen = false;
    }
    updateOcrFloatButton();
  }

  function updateOcrFloatButton() {
    const btn = $("#webOcrFloatBtn");
    if (btn) btn.classList.toggle("active", state.ocrFloatOpen);
  }

  function showTargetSkeleton(title, text) {
    const list = $("#targetMessages");
    let skeleton = $("#targetSkeleton");
    if (!skeleton) {
      skeleton = document.createElement("div");
      skeleton.id = "targetSkeleton";
      skeleton.className = "article-page";
      list.appendChild(skeleton);
    }
    skeleton.innerHTML = `<div class="article-head"><span class="article-source-label">${icon("spark")}正在翻译</span>
      <h2 class="article-title">${escapeHtml(title)}</h2><div class="article-url">${escapeHtml(text)}</div></div>
      <div class="article-body"><div class="loading-line"></div><div class="loading-line"></div><div class="loading-line short"></div></div>`;
    $("#targetEmpty").classList.add("hidden");
  }

  function hideTargetSkeleton() {
    const skeleton = $("#targetSkeleton");
    if (skeleton) skeleton.remove();
    if (!state.messages.length) $("#targetEmpty").classList.remove("hidden");
  }

  // ------------------------------------------------------------------ video
  function pauseVideo() {
    const player = $("#videoPlayer");
    if (player && !player.paused) player.pause();
  }

  async function pickVideo() {
    const path = await desktop.openMediaDialog();
    if (path) loadVideoPath(path);
  }

  function loadVideoPath(path) {
    if (!path) {
      setFeature("video");
      return;
    }
    if (state.feature !== "video") setFeature("video");
    const url = `/media?path=${encodeURIComponent(path)}`;
    state.video.path = path;
    state.video.url = url;
    state.video.name = String(path).split(/[\\/]/).pop() || "video";
    const player = $("#videoPlayer");
    player.src = url;
    $("#videoDropzone").classList.add("hidden");
    $("#videoPlayerWrap").classList.remove("hidden");
    $("#videoName").textContent = state.video.name;
    $("#videoStatus").textContent = "就绪";
    $("#videoJob").classList.add("hidden");
    showToast("视频已导入", "播放视频后点击“开始识别”，或使用“整段解析”/“系统声音监听”。", "success");
  }

  async function startVideoJob() {
    if (!state.video.path) {
      await pickVideo();
      return;
    }
    if (state.feature !== "video") setFeature("video");
    if (state.live) {
      stopLive();
      return;
    }
    if (state.busy) return;
    state.busy = true;
    $("#parseVideoBtn").disabled = true;
    const jobBox = $("#videoJob");
    const bar = $("#videoJobBar");
    const text = $("#videoJobText");
    const pct = $("#videoJobPct");
    jobBox.classList.remove("hidden");
    bar.style.width = "2%";
    text.textContent = "正在解析音频…";
    pct.textContent = "2%";
    $("#videoStatus").textContent = "解析中";
    try {
      const start = await api("/api/asr/file", {
        path: state.video.path,
        language: state.asrLang,
        target: state.asrTarget,
        mode: state.mode,
      });
      state.video.job = start.job_id;
      await new Promise((resolve, reject) => {
        const poll = async () => {
          try {
            const data = await api(`/api/jobs/${start.job_id}`, null, { timeout: 15000 });
            const job = data.job;
            const progress = Math.round((job.progress || 0) * 100);
            bar.style.width = `${progress}%`;
            pct.textContent = `${progress}%`;
            if (job.status === "done") {
              resolve(job.result);
              return;
            }
            if (job.status === "error") {
              reject(new Error(job.error || "解析失败"));
              return;
            }
            text.textContent = progress < 55 ? "正在离线识别语音…" : "正在翻译字幕…";
            setTimeout(poll, 700);
          } catch (error) {
            reject(error);
          }
        };
        poll();
      }).then((result) => {
        bar.style.width = "100%";
        pct.textContent = "100%";
        text.textContent = "完成";
        $("#videoStatus").textContent = "识别完成";
        if (result && result.segments && result.segments.length) {
          result.segments.forEach((segment) => {
            addMessage({
              feature: "video",
              original: segment.text,
              translated: segment.translated || "…",
              source: result.language,
              target: result.target || state.asrTarget,
              provider: result.provider || "tencent",
              latencyMs: null,
              mediaTime: segment.start,
              confidence: segment.confidence,
            });
          });
          showToast("视频识别完成", `共 ${result.segments.length} 段字幕`, "success");
        } else {
          showToast("没有识别到语音", "请确认视频包含清晰的对话音轨。", "info");
        }
      });
    } catch (error) {
      showToast("视频解析失败", error.message, "error", 7000);
      $("#videoStatus").textContent = "失败";
    } finally {
      state.busy = false;
      $("#parseVideoBtn").disabled = false;
      jobBox.classList.add("hidden");
    }
  }

  async function toggleVideoStreaming() {
    if (state.live && state.live.feature === "video") {
      stopLive();
      return;
    }
    if (!state.video.path) {
      await pickVideo();
      return;
    }
    const player = $("#videoPlayer");
    if (!player) return;
    if (player.readyState < 2) {
      await new Promise((resolve) => {
        player.addEventListener("loadeddata", resolve, { once: true });
        player.load();
      });
    }
    try {
      if (player.paused) await player.play();
      let stream = null;
      if (typeof player.captureStream === "function") {
        stream = player.captureStream();
      } else if (typeof player.mozCaptureStream === "function") {
        stream = player.mozCaptureStream();
      }
      if (!stream || !stream.getAudioTracks().length) {
        showToast("无法捕获音轨", "正在切换为系统声音监听模式。", "info");
        await toggleVideoSystemAudio();
        return;
      }
      stream.getVideoTracks().forEach((track) => track.stop());
      await startLive("video", stream, { systemLoopback: false });
      $("#videoStatus").textContent = "实时识别中";
    } catch (error) {
      showToast("无法开始视频识别", error.message, "error", 6000);
    }
  }

  // Feature 1: System loopback audio listening inside Video Recognition workspace
  async function toggleVideoSystemAudio() {
    if (state.live && state.live.feature === "video") {
      stopLive();
      return;
    }
    if (state.health && state.health.asr && !state.health.asr.models.zh.available && !state.health.asr.models.en.available) {
      showToast("缺少语音模型", "请将 Vosk 中文 / 英语模型放入 models 目录后重试。", "error", 7000);
      return;
    }
    try {
      const player = $("#videoPlayer");
      if (state.video.path && player && player.paused) {
        player.play().catch(() => {});
      }
      const stream = await acquireSystemLoopbackStream();
      await startLive("video", stream, { systemLoopback: true });
      $("#videoStatus").textContent = "系统声音实时监听中";
      showToast("正在监听系统视频声音", "系统播放的任何视频声音都会边听边译，并同步到双语浮窗。", "success", 4000);
    } catch (error) {
      showToast("无法开启系统声音监听", error.message, "error", 6000);
    }
  }

  // ------------------------------------------------------------------- game & loopback helper
  async function acquireSystemLoopbackStream() {
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 2 }, height: { ideal: 2 }, frameRate: { ideal: 1 } },
        audio: true,
      });
    } catch (error) {
      try {
        const sources = await desktop.desktopSources();
        if (!sources.length) throw new Error("没有可用的屏幕源");
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: "desktop",
              chromeMediaSourceId: sources[0].id,
            },
          },
          video: {
            mandatory: {
              chromeMediaSource: "desktop",
              chromeMediaSourceId: sources[0].id,
              maxWidth: 2,
              maxHeight: 2,
              maxFrameRate: 1,
            },
          },
        });
      } catch (inner) {
        throw new Error("系统音频捕获被拒绝。请允许屏幕共享后重试。");
      }
    }
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error("当前屏幕源没有音频轨道，请选择“整个屏幕”并重试。");
    }
    stream.getVideoTracks().forEach((track) => track.stop());
    return stream;
  }

  async function startSystemCapture() {
    const stream = await acquireSystemLoopbackStream();
    await startLive("game", stream, { systemLoopback: true });
  }

  async function toggleGame() {
    if (state.live && state.live.feature === "game") {
      stopLive();
      return;
    }
    if (state.health && state.health.asr && !state.health.asr.models.zh.available && !state.health.asr.models.en.available) {
      showToast("缺少语音模型", "请将 Vosk 中文 / 英语模型放入 models 目录后重试。", "error", 7000);
      return;
    }
    setGameStage(true);
    try {
      await startSystemCapture();
      showToast("正在监听系统声音", "把游戏切到前台，浮窗会边听边译实时显示双语字幕。", "success", 4200);
    } catch (error) {
      setGameStage(false);
      showToast("无法开始监听", error.message, "error", 6500);
    }
  }

  function setGameStage(active) {
    $("#gameStage").classList.toggle("recording", active);
    $("#gameStatus").textContent = active ? "正在监听系统声音" : "等待开始";
    $("#gameHint").textContent = active
      ? "正在边听边译，双语字幕会实时同步在右侧列表与浮窗中。"
      : "捕获系统播放的声音，为游戏 / 直播 / 通话生成双语字幕。";
  }

  // -------------------------------------------------------------- live audio & simultaneous translation
  async function startLive(feature, stream, options = {}) {
    if (state.live) stopLive({ silent: true });
    const language = state.asrLang;
    let session;
    try {
      session = await api("/api/asr/start", { language }, { timeout: 60000 });
    } catch (error) {
      throw new Error("无法启动离线语音识别：" + error.message);
    }
    const pipeline = new AudioPipeline(stream, {
      onChunk: (chunk) => enqueueAudio(chunk),
      onLevel: (level) => updateLevel(level, feature),
    });
    state.live = {
      feature,
      systemLoopback: Boolean(options.systemLoopback),
      sessionId: session.session_id,
      language: session.languages && session.languages[0] ? session.languages[0] : "zh",
      startedAt: Date.now(),
      pipeline,
      partial: "",
      partialTranslated: "",
      lastPartialAsked: "",
      transcripts: 0,
      stream,
    };
    pipeline.start();
    $("#sourceLivePill").classList.remove("hidden");
    $("#targetLivePill").classList.remove("hidden");
    $("#sourcePartial").classList.remove("hidden");
    $("#targetPartial").classList.remove("hidden");
    $("#sourcePartialText").textContent = "正在聆听…";
    $("#targetPartialText").textContent = "等待语音输入…";
    const partialLabel = $("#targetPartialLabel");
    if (partialLabel) partialLabel.textContent = state.mode === "offline" ? "本地 NLLB" : "同步翻译中";
    $("#gameStage").classList.add("recording");
    $("#videoStatus").textContent = options.systemLoopback ? "系统声音监听中" : "实时识别中";
    updatePrimaryButton();
    updateControls();
    startGameTimer();
    updateFloat();
    if (feature === "game") {
      setGameStage(true);
    }
    if ((feature === "game" || options.systemLoopback) && !state.floatOpen) {
      setTimeout(() => openFloat(true), 400);
    }
  }

  function enqueueAudio(chunk) {
    if (!state.live) return;
    state.streamQueue.push(chunk);
    if (state.streamQueue.length > 28) state.streamQueue.shift();
    pumpAudio();
  }

  async function pumpAudio() {
    if (state.streamBusy || !state.live || !state.streamQueue.length) return;
    state.streamBusy = true;
    const chunk = state.streamQueue.shift();
    try {
      const response = await fetch(`/api/asr/feed?session=${encodeURIComponent(state.live.sessionId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: chunk,
      });
      const data = await response.json();
      if (data.ok) handleAsrResult(data);
    } catch (error) {
      console.warn("asr feed failed", error);
    } finally {
      state.streamBusy = false;
      if (state.streamQueue.length) setTimeout(pumpAudio, 0);
    }
  }

  function handleAsrResult(data) {
    if (!state.live) return;
    if (data.lang) state.live.language = data.lang;

    if (Array.isArray(data.finals) && data.finals.length) {
      for (const final of data.finals) {
        if (!final.text || final.text.trim().length === 0) continue;
        state.live.transcripts += 1;
        const cleanText = final.text.trim();
        const player = $("#videoPlayer");
        const mediaTime = state.live.feature === "video" && player && !state.live.systemLoopback
          ? player.currentTime
          : final.start;
        const lang = final.lang || state.live.language || "zh";
        const target = state.asrTarget === "auto"
          ? (lang === "zh" ? "en" : "zh")
          : state.asrTarget;

        const preTranslated =
          state.live.partialTranslated && state.live.lastPartialAsked === cleanText
            ? state.live.partialTranslated
            : null;

        const msg = addMessage({
          feature: state.live.feature,
          original: cleanText,
          translated: preTranslated,
          source: lang,
          target,
          provider: preTranslated ? (state.mode === "offline" ? "lilac-local" : "tencent") : null,
          latencyMs: null,
          mediaTime,
          confidence: final.confidence,
          // The partial translation is only a preview; always request the
          // final translation so a truncated partial cannot become the final
          // subtitle (for example a full sentence showing only "大家好").
          pending: true,
        });
        state.live.partial = "";
        state.live.partialTranslated = "";
        state.live.lastPartialAsked = "";
        queueTranslation(cleanText, lang, msg.id);
      }
    }

    if (data.partial !== undefined) {
      const nextPartial = (data.partial || "").trim();
      const changed = nextPartial !== state.live.partial;
      state.live.partial = nextPartial;

      if (changed) {
        $("#sourcePartialText").textContent = nextPartial || "正在聆听…";
        if (!nextPartial) {
          state.live.partialTranslated = "";
          const latestMsg = state.messages[state.messages.length - 1];
          $("#targetPartialText").textContent =
            latestMsg && latestMsg.translated ? `上一句：${latestMsg.translated}` : "等待语音…";
        } else if (state.mode === "offline") {
          state.live.partialTranslated = "";
          const partialLabel = $("#targetPartialLabel");
          if (partialLabel) partialLabel.textContent = "等待断句";
          $("#targetPartialText").textContent = "断句后本地 NLLB 翻译…";
        } else {
          schedulePartialTranslation(nextPartial);
        }
        updateFloat();
      }
    }
  }

  function schedulePartialTranslation(partialText) {
    if (state.mode === "offline") return;
    if (!partialText || partialText.length < 2) return;
    if (state.live && partialText === state.live.lastPartialAsked) return;
    clearTimeout(state.partialTransTimer);
    state.partialTransTimer = setTimeout(() => {
      translateLivePartial(partialText);
    }, 380);
  }

  async function translateLivePartial(partialText) {
    if (state.mode === "offline") return;
    if (!state.live || !partialText || state.partialTransBusy) return;
    const source = state.live.language || (hasCjk(partialText) ? "zh" : "en");
    const target = state.asrTarget === "auto" ? (source === "zh" ? "en" : "zh") : state.asrTarget;
    state.partialTransBusy = true;
    state.live.lastPartialAsked = partialText;
    try {
      const res = await api("/api/translate", {
        text: partialText,
        source,
        target,
        mode: state.mode,
      }, { timeout: 12000 });
      if (state.live && state.live.partial) {
        state.live.partialTranslated = res.translated || "";
        $("#targetPartialText").textContent = state.live.partialTranslated || "同步翻译中…";
        updateFloat();
      }
    } catch {
    } finally {
      state.partialTransBusy = false;
      if (state.live && state.live.partial && state.live.partial !== state.live.lastPartialAsked) {
        schedulePartialTranslation(state.live.partial);
      }
    }
  }

  function queueTranslation(text, source, messageId) {
    state.pending.push({ text, source, messageId });
    clearTimeout(state.pendingTimer);
    state.pendingTimer = setTimeout(flushTranslations, 120);
  }

  async function flushTranslations() {
    if (!state.pending.length) return;
    const batch = state.pending.splice(0, state.pending.length);
    const texts = batch.map((item) => item.text);
    const source = batch[0].source || "auto";
    const target = state.asrTarget === "auto"
      ? (source === "zh" ? "en" : "zh")
      : state.asrTarget;
    try {
      const result = await api("/api/translate", {
        texts,
        source,
        target,
        mode: state.mode,
      }, { timeout: 60000 });
      result.translations.forEach((translated, index) => {
        const item = batch[index];
        if (!item) return;
        updateMessage(item.messageId, {
          translated: translated || "…",
          provider: result.provider,
          latencyMs: result.latency_ms,
          pending: false,
          source: result.detected_source || item.source,
          target,
        });
        if (state.live && !state.live.partialTranslated && translated) {
          $("#targetPartialText").textContent = translated;
        }
      });
      updateFloat();
    } catch (error) {
      batch.forEach((item) => {
        updateMessage(item.messageId, { translated: "翻译暂不可用，请稍后重试。", provider: "none", pending: false });
      });
      showToast("逐句翻译失败", error.message, "error", 5000);
    }
  }

  function stopLive({ silent = false } = {}) {
    const live = state.live;
    if (!live) return;
    state.live = null;
    clearInterval(state.liveTimer);
    clearTimeout(state.pendingTimer);
    clearTimeout(state.partialTransTimer);
    state.partialTransBusy = false;
    state.streamQueue = [];
    if (live.pipeline) live.pipeline.stop();
    if (live.stream) live.stream.getTracks().forEach((track) => track.stop());
    $("#sourceLivePill").classList.add("hidden");
    $("#targetLivePill").classList.add("hidden");
    $("#sourcePartial").classList.add("hidden");
    $("#targetPartial").classList.add("hidden");
    $("#gameStage").classList.remove("recording");
    $("#videoStatus").textContent = state.video.path ? "就绪" : "";
    setGameStage(false);
    if (state.pending.length) {
      flushTranslations();
    }
    if (live.sessionId) {
      fetch(`/api/asr/stop?session=${encodeURIComponent(live.sessionId)}`, { method: "POST" })
        .then((response) => response.json())
        .then((data) => {
          if (data.ok && data.finals) {
            for (const final of data.finals) {
              if (!final.text) continue;
              const msg = addMessage({
                feature: live.feature,
                original: final.text.trim(),
                translated: null,
                source: final.lang || live.language,
                target: state.asrTarget === "auto" ? (final.lang === "zh" ? "en" : "zh") : state.asrTarget,
                pending: true,
                mediaTime: final.start,
                confidence: final.confidence,
              });
              queueTranslation(final.text.trim(), final.lang || live.language, msg.id);
            }
          }
        })
        .catch(() => {});
    }
    updatePrimaryButton();
    updateControls();
    updateFloat();
    if (!silent) showToast("已停止识别", "本次原文与译文已保存。", "info", 2500);
  }

  function startGameTimer() {
    clearInterval(state.liveTimer);
    const started = Date.now();
    state.liveTimer = setInterval(() => {
      if (!state.live) return;
      const seconds = Math.floor((Date.now() - started) / 1000);
      $("#gameTimer").textContent = formatClock(seconds);
    }, 1000);
  }

  function updateLevel(level, feature) {
    if (feature === "game") {
      const bars = $$("#waveBars i");
      const idx = Math.floor(level * (bars.length || 1));
      bars.forEach((bar, i) => {
        const height = 3 + Math.max(0, level * 26 * Math.sin((i + 1) * 0.7 + Date.now() / 180) ** 2);
        bar.style.height = `${Math.max(3, Math.min(26, height))}px`;
        bar.style.opacity = i < idx ? "0.9" : "0.45";
      });
      const orb = $("#soundOrb");
      if (orb) orb.style.transform = `scale(${1 + level * 0.05})`;
    }
  }

  // --------------------------------------------------------------- audio pipe
  class AudioPipeline {
    constructor(stream, handlers) {
      this.stream = stream;
      this.handlers = handlers;
      this.context = null;
      this.source = null;
      this.processor = null;
      this.buffer = [];
      this.stopped = false;
      this.lastLevelAt = 0;
      this.resampleRatio = 1;
    }

    start() {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.context = new AudioCtx();
      this.source = this.context.createMediaStreamSource(this.stream);
      this.processor = this.context.createScriptProcessor(4096, 1, 1);
      this.resampleRatio = this.context.sampleRate / 16000;
      this.source.connect(this.processor);
      this.processor.connect(this.context.destination);
      if (this.context.state === "suspended") this.context.resume().catch(() => {});
      this.processor.onaudioprocess = (event) => {
        if (this.stopped) return;
        const input = event.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
        const rms = Math.sqrt(sum / input.length);
        const now = performance.now();
        if (now - this.lastLevelAt > 60) {
          this.lastLevelAt = now;
          this.handlers.onLevel?.(Math.min(1, rms * 7));
        }
        const ratio = this.resampleRatio;
        const outLength = Math.floor(input.length / ratio);
        const out = new Float32Array(outLength);
        for (let i = 0; i < outLength; i++) {
          const pos = i * ratio;
          const idx = Math.floor(pos);
          const frac = pos - idx;
          const a = input[idx] || 0;
          const b = input[Math.min(idx + 1, input.length - 1)] || 0;
          out[i] = a + (b - a) * frac;
        }
        this.buffer.push(out);
        const total = this.buffer.reduce((sum2, arr) => sum2 + arr.length, 0);
        if (total >= 4000) {
          const merged = new Float32Array(total);
          let offset = 0;
          for (const arr of this.buffer) {
            merged.set(arr, offset);
            offset += arr.length;
          }
          this.buffer = [];
          const pcm = new Int16Array(merged.length);
          for (let i = 0; i < merged.length; i++) {
            const sample = Math.max(-1, Math.min(1, merged[i]));
            pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
          }
          this.handlers.onChunk?.(pcm.buffer);
        }
      };
    }

    stop() {
      this.stopped = true;
      try {
        this.processor?.disconnect();
        this.source?.disconnect();
        this.context?.close();
      } catch {}
    }
  }

  // ---------------------------------------------------------------- text flow
  async function translateText() {
    if (state.busy) return;
    const text = $("#sourceInput").value.trim();
    if (!text) {
      showToast("还没有原文", "输入或粘贴文本后再翻译。", "info");
      $("#sourceInput").focus();
      return;
    }
    if (state.source !== "auto" && state.source === state.target) {
      showToast("语言相同", "原文与译文语言不能相同。", "info");
      return;
    }
    state.busy = true;
    $("#primaryBtn").disabled = true;
    $("#targetMeta").textContent = "正在翻译…";
    showTargetSkeleton("正在生成译文", "保留段落与语气的神经翻译");
    try {
      const result = await api("/api/translate", {
        text,
        source: state.source,
        target: state.target,
        mode: state.mode,
      }, { timeout: 60000 });
      let finalResult = result;
      if (
        state.source === "auto" &&
        result.detected_source &&
        result.detected_source !== "auto" &&
        result.detected_source === state.target &&
        String(result.translated || "").trim() === text
      ) {
        const switched = state.target === "zh" ? "en" : "zh";
        state.target = switched;
        syncLanguageControls();
        saveSettings({ target: switched });
        finalResult = await api("/api/translate", {
          text,
          source: result.detected_source,
          target: switched,
          mode: state.mode,
        }, { timeout: 60000 });
        showToast("已自动切换译文语言", `检测到原文为${langName(result.detected_source)}，已改译为${langName(switched)}。`, "info", 3200);
      }
      const msg = addMessage({
        feature: "text",
        original: text,
        translated: finalResult.translated || "",
        source: finalResult.detected_source || state.source,
        target: finalResult.target || state.target,
        provider: finalResult.provider,
        latencyMs: finalResult.latency_ms,
      });
      state.lastDetected = finalResult.detected_source || state.lastDetected;
      if (state.source === "auto" && finalResult.detected_source && finalResult.detected_source !== "auto") {
        $("#sourceMeta").textContent = `检测为 ${langName(finalResult.detected_source)}`;
      }
      $("#targetMeta").textContent = `${langName(msg.source)} → ${langName(msg.target)}`;
      $("#sourceInput").value = "";
      updateInputCount();
      showToast("翻译完成", `${PROVIDER_NAMES[finalResult.provider] || "神经翻译"} · ${Math.round(finalResult.latency_ms || 0)} ms`, "success", 2200);
      setTimeout(() => $("#sourceInput").focus(), 60);
    } catch (error) {
      showToast("翻译失败", error.message, "error", 7000);
      $("#targetMeta").textContent = "翻译失败";
    } finally {
      state.busy = false;
      $("#primaryBtn").disabled = false;
      hideTargetSkeleton();
      updatePrimaryButton();
      updateFloat();
    }
  }

  function updateInputCount() {
    const length = $("#sourceInput").value.trim().length;
    $("#inputCount").textContent = `${length} 字`;
  }

  // --------------------------------------------------------------- float sync (Fixed!)
  function latestFloatContent() {
    const messages = state.messages;
    const latest = messages[messages.length - 1];
    const live = state.live;

    if (live) {
      const srcCode = live.language || (latest && latest.source) || state.asrLang || "zh";
      const tgtCode = state.asrTarget === "auto" ? (srcCode === "zh" ? "en" : "zh") : state.asrTarget;

      const displayOriginal =
        live.partial ||
        (latest && latest.original) ||
        "正在聆听系统声音…";

      let displayTranslated = "";
      if (live.partial && live.partialTranslated) {
        displayTranslated = live.partialTranslated;
      } else if (latest && latest.translated) {
        displayTranslated = live.partial
          ? `${latest.translated}  (${state.mode === "offline" ? "等待断句翻译" : "同步翻译中"}…)`
          : latest.translated;
      } else if (live.partial) {
        displayTranslated = state.mode === "offline" ? "断句后本地 NLLB 翻译…" : "正在实时翻译…";
      } else {
        displayTranslated = "等待语音，识别与译文会实时同步显示。";
      }

      return {
        original: displayOriginal,
        translated: displayTranslated,
        source: langName(srcCode),
        target: langName(tgtCode),
        feature: featureName(live.feature),
        live: true,
      };
    }

    if (!latest) {
      return {
        original: "紫语星枢已就绪，等待你的第一段原文。",
        translated: "LilacLingua AI is ready. Your bilingual subtitles will appear here.",
        source: "中文",
        target: "English",
        feature: featureName(state.feature),
        live: false,
      };
    }
    if (latest.feature === "web" && latest.article) {
      const first = (latest.article.paragraphs || []).find((p) => p.translated);
      return {
        original: latest.article.title || latest.original,
        translated: first ? first.translated : latest.translated,
        source: langName(latest.source),
        target: langName(latest.target),
        feature: "网页翻译",
        live: false,
      };
    }
    return {
      original: latest.original,
      translated: latest.translated || "正在翻译…",
      source: langName(latest.source),
      target: langName(latest.target),
      feature: latest.isOcr ? "识屏翻译" : featureName(latest.feature),
      live: false,
    };
  }

  async function openFloat(forceOpen = null) {
    const shouldOpen = forceOpen == null ? !state.floatOpen : Boolean(forceOpen);
    if (shouldOpen) {
      await desktop.floating.open(latestFloatContent());
      state.floatOpen = true;
      showToast("双语浮窗已打开", "拖动顶部移动，拖动右下角缩放。", "success", 2800);
    } else {
      await desktop.floating.close();
      state.floatOpen = false;
    }
    updateFloatButtons();
  }

  function updateFloat() {
    if (!state.floatOpen) return;
    desktop.floating.update(latestFloatContent());
  }

  function updateFloatButtons() {
    $$("#floatOpenBtn, #topFloatBtn, #railFloatBtn, #floatTargetBtn").forEach((button) => {
      button.classList.toggle("on", state.floatOpen);
    });
  }

  // ------------------------------------------------------------------- status
  async function loadHealth() {
    try {
      const health = await waitBackend();
      state.health = health;
      updateStatusBars();
      if (health.nllb && health.nllb.available && !health.nllb.loaded && !state.nllbRefreshTimer) {
        state.nllbRefreshTimer = setTimeout(() => {
          state.nllbRefreshTimer = null;
          loadHealth();
        }, 2500);
      }
      if (!health.local_model) {
        showToast("本地模型未加载", "仍可使用在线翻译与语音识别。", "info", 5000);
      }
      if (health.asr && health.asr.models) {
        const available = Object.values(health.asr.models).filter((m) => m.available).length;
        if (!available) showToast("语音模型缺失", "视频 / 游戏识别需要 models 目录中的 Vosk 模型。", "error", 7000);
      }
      return health;
    } catch (error) {
      $("#statusDot").className = "status-dot error";
      $("#statusText").textContent = "引擎未连接";
      $("#statusSub").textContent = "请重启应用";
      $("#backendStatus").textContent = "本地引擎未连接";
      showToast("无法连接本地引擎", error.message, "error", 8000);
      return null;
    }
  }

  // ------------------------------------------------------------------ controls
  function populateLanguages() {
    const sourceSelect = $("#sourceLang");
    const targetSelect = $("#targetLang");
    const asrTarget = $("#asrTargetLang");
    const options = state.languages.length
      ? state.languages
      : [
          { code: "zh", name: "中文" }, { code: "en", name: "英语" }, { code: "ja", name: "日语" },
          { code: "ko", name: "韩语" }, { code: "fr", name: "法语" }, { code: "de", name: "德语" },
          { code: "es", name: "西班牙语" }, { code: "ru", name: "俄语" }, { code: "ar", name: "阿拉伯语" },
          { code: "pt", name: "葡萄牙语" }, { code: "it", name: "意大利语" }, { code: "th", name: "泰语" },
        ];
    sourceSelect.innerHTML = `<option value="auto">自动检测</option>` +
      options.map((item) => `<option value="${item.code}">${item.name}</option>`).join("");
    targetSelect.innerHTML = options.map((item) => `<option value="${item.code}">${item.name}</option>`).join("");
    asrTarget.innerHTML = `<option value="auto">智能对译</option>` +
      options.map((item) => `<option value="${item.code}">${item.name}</option>`).join("");
    sourceSelect.value = state.source;
    targetSelect.value = state.target;
    asrTarget.value = state.asrTarget;
  }

  function syncLanguageControls() {
    $("#sourceLang").value = state.source;
    $("#targetLang").value = state.target;
    $("#asrLang").value = state.asrLang;
    $("#asrTargetLang").value = state.asrTarget;
    $("#modeSelect").value = state.mode;
  }

  function swapLanguages() {
    if (state.feature === "video" || state.feature === "game") {
      showToast("语音识别无需交换", "识别语言由声学模型决定，可修改右侧译文语言。", "info");
      return;
    }
    const currentSource = state.source === "auto" ? (state.lastDetected || "en") : state.source;
    const newSource = state.target;
    const newTarget = currentSource;
    state.source = newSource;
    state.target = newTarget;
    syncLanguageControls();
    updateControls();
    $("#sourceMeta").textContent = langName(state.source);
    showToast("语言已交换", `${langName(state.source)} → ${langName(state.target)}`, "info", 2200);
  }

  function setFeature(feature) {
    if (!FEATURES[feature]) return;
    if (state.feature === feature) return;
    if (state.live) stopLive({ silent: true });
    if (state.feature === "video") pauseVideo();
    const convo = activeConversation();
    if (convo && convo.messages.length) {
      const lastFeature = convo.messages[convo.messages.length - 1].feature;
      if (lastFeature && lastFeature !== feature) {
        newChat(false);
      }
    }
    state.feature = feature;
    applyFeatureUI();
    renderMessages();
    updatePageHeading();
    updateControls();
    if (feature === "text") setTimeout(() => $("#sourceInput").focus(), 100);
    if (feature === "web") setTimeout(() => $("#webUrl").focus(), 100);
  }

  // ------------------------------------------------------------------ dialogs
  function openModal(id) {
    $(`#${id}`).classList.remove("hidden");
  }

  function closeModal(id) {
    $(`#${id}`).classList.add("hidden");
  }

  function confirmDialog(title, text, okLabel = "确认") {
    return new Promise((resolve) => {
      $("#confirmTitle").textContent = title;
      $("#confirmText").textContent = text;
      $("#confirmOk").textContent = okLabel;
      openModal("confirmModal");
      const cleanup = (value) => {
        closeModal("confirmModal");
        $("#confirmOk").removeEventListener("click", onOk);
        $("#confirmCancel").removeEventListener("click", onCancel);
        resolve(value);
      };
      const onOk = () => cleanup(true);
      const onCancel = () => cleanup(false);
      $("#confirmOk").addEventListener("click", onOk);
      $("#confirmCancel").addEventListener("click", onCancel);
    });
  }

  async function loadSettings() {
    try {
      const settings = await desktop.settings.get();
      state.settings = settings || {};
      state.collapsed = Boolean(settings.sidebarCollapsed);
      $("#sidebar").classList.toggle("collapsed", state.collapsed);
      if (settings.floatPinned != null) $("#setFloatPinned").checked = Boolean(settings.floatPinned);
      const opacity = Math.round((settings.floatOpacity ?? 0.96) * 100);
      $("#setFloatOpacity").value = opacity;
      $("#opacityValue").textContent = `${opacity}%`;
      const font = Math.round((settings.floatFont ?? 1) * 100);
      $("#setFloatFont").value = font;
      $("#fontValue").textContent = `${font}%`;
      if (settings.mode === "online" || settings.mode === "offline") state.mode = settings.mode;
      if (settings.source) state.source = settings.source;
      if (settings.target) state.target = settings.target;
      if (settings.asrTarget) state.asrTarget = settings.asrTarget;
    } catch (error) {
      console.warn("settings load failed", error);
    }
  }

  async function saveSettings(patch) {
    try {
      const next = await desktop.settings.patch(patch);
      state.settings = next || { ...state.settings, ...patch };
    } catch {}
  }

  // ------------------------------------------------------------------- window
  function bindWindowControls() {
    $("#minBtn").addEventListener("click", () => desktop.window.minimize());
    $("#maxBtn").addEventListener("click", async () => {
      const maximized = await desktop.window.maximize();
      const use = maximized ? "restore" : "max";
      $("#maxBtn").innerHTML = icon(use);
    });
    $("#closeBtn").addEventListener("click", () => desktop.window.close());
    desktop.window.onMaximized((maximized) => {
      $("#maxBtn").innerHTML = icon(maximized ? "restore" : "max");
    });
    desktop.onBackendDown(() => {
      $("#statusDot").className = "status-dot error";
      $("#statusText").textContent = "引擎已断开";
      $("#backendStatus").textContent = "本地引擎已断开";
      showToast("本地引擎已断开", "请重新启动应用。", "error", 10000);
    });
  }

  function bindFloatEvents() {
    desktop.floating.onVisibility((visible) => {
      state.floatOpen = Boolean(visible);
      updateFloatButtons();
    });
    if (desktop.ocrFloating) {
      desktop.ocrFloating.onVisibility((visible) => {
        state.ocrFloatOpen = Boolean(visible);
        updateOcrFloatButton();
      });
      desktop.ocrFloating.onCapturedFromFloat(async (payload) => {
        if (payload && payload.dataUrl) {
          await runOcrTranslation(payload.dataUrl);
        }
      });
    }
  }

  // ------------------------------------------------------------------- events
  function bindEvents() {
    bindWindowControls();
    bindFloatEvents();

    $$(".feature-tab").forEach((tab) => tab.addEventListener("click", () => setFeature(tab.dataset.feature)));
    $$(".ws-item").forEach((item) => item.addEventListener("click", () => setFeature(item.dataset.feature)));

    $("#sidebarToggle").addEventListener("click", () => {
      state.collapsed = !state.collapsed;
      $("#sidebar").classList.toggle("collapsed", state.collapsed);
      saveSettings({ sidebarCollapsed: state.collapsed });
    });

    $("#newChatBtn").addEventListener("click", () => newChat(true));
    $("#clearHistoryBtn").addEventListener("click", clearHistory);

    $("#sourceLang").addEventListener("change", (event) => {
      state.source = event.target.value;
      if (state.source !== "auto") state.lastDetected = state.source;
      updateControls();
      saveSettings({ source: state.source });
    });
    $("#targetLang").addEventListener("change", (event) => {
      state.target = event.target.value;
      updateControls();
      saveSettings({ target: state.target });
    });
    $("#asrLang").addEventListener("change", (event) => {
      if (state.live) stopLive({ silent: true });
      state.asrLang = event.target.value;
      updateControls();
      $("#sourceMeta").textContent = state.asrLang === "auto" ? "自动识别 · 中英" : langName(state.asrLang);
    });
    $("#asrTargetLang").addEventListener("change", (event) => {
      state.asrTarget = event.target.value;
      updateControls();
      saveSettings({ asrTarget: state.asrTarget });
    });
    $("#modeSelect").addEventListener("change", (event) => {
      state.mode = event.target.value;
      saveSettings({ mode: state.mode });
      updateControls();
      updateStatusBars();
      if (state.mode === "offline") {
        const ready = state.health && state.health.nllb && state.health.nllb.available;
        showToast(
          "已切换到本地 NLLB",
          ready ? "翻译由本机 NLLB-200 600M 完成，数据不会离开电脑。" : "NLLB 模型不可用，已回退到 Lilac 本地模型。",
          "info",
          4200
        );
      }
    });

    $("#swapLangBtn").addEventListener("click", swapLanguages);
    $("#railSwapBtn").addEventListener("click", swapLanguages);
    $("#primaryBtn").addEventListener("click", runPrimary);
    $("#railPrimaryBtn").addEventListener("click", runPrimary);

    $("#sourceInput").addEventListener("input", updateInputCount);
    $("#sourceInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        translateText();
      }
    });

    $("#speakBtn").addEventListener("click", () => speakText($("#sourceInput").value || lastOriginal(), state.source === "auto" ? state.lastDetected || "zh" : state.source));
    $("#speakTargetBtn").addEventListener("click", () => speakText(lastTranslated(), state.target));
    $("#copySourceBtn").addEventListener("click", () => copyText(allOriginal(), "原文已复制"));
    $("#copyTargetBtn").addEventListener("click", () => copyText(allTranslated(), "译文已复制"));
    $("#floatTargetBtn").addEventListener("click", () => openFloat());
    $("#floatOpenBtn").addEventListener("click", () => openFloat());
    $("#topFloatBtn").addEventListener("click", () => openFloat());
    $("#railFloatBtn").addEventListener("click", () => openFloat());
    $("#clearBtn").addEventListener("click", clearCurrent);
    $("#clearSourceBtn").addEventListener("click", clearCurrent);

    $("#sourceMessages").addEventListener("click", (event) => {
      const button = event.target.closest(".msg-copy");
      if (button) copyText(button.dataset.copyText || "", "已复制");
      const sample = event.target.closest("[data-sample]");
      if (sample) {
        $("#sourceInput").value = sample.dataset.sample;
        updateInputCount();
        $("#sourceInput").focus();
      }
    });
    $("#targetMessages").addEventListener("click", (event) => {
      const button = event.target.closest(".msg-copy");
      if (button) copyText(button.dataset.copyText || "", "已复制");
    });

    $("#pickVideoBtn").addEventListener("click", pickVideo);
    $("#changeVideoBtn").addEventListener("click", pickVideo);
    $("#videoAsrBtn").addEventListener("click", toggleVideoStreaming);
    $("#videoParseBtn").addEventListener("click", startVideoJob);
    $("#parseVideoBtn").addEventListener("click", startVideoJob);
    $("#videoSysAudioBtn")?.addEventListener("click", toggleVideoSystemAudio);
    $("#videoPlayerSysAudioBtn")?.addEventListener("click", toggleVideoSystemAudio);
    $("#gameStartBtn").addEventListener("click", toggleGame);
    $("#gameFloatBtn").addEventListener("click", () => openFloat(true));

    $("#webTranslateBtn").addEventListener("click", translateWebPage);
    $("#webOcrBtn")?.addEventListener("click", startScreenOcr);
    $("#webOcrFloatBtn")?.addEventListener("click", () => toggleOcrFloat());
    $("#webUrl").addEventListener("keydown", (event) => {
      if (event.key === "Enter") translateWebPage();
    });
    $("#webUrlClear").addEventListener("click", () => {
      $("#webUrl").value = "";
      $("#webUrl").focus();
    });
    $("#webOpenBtn").addEventListener("click", () => {
      const url = $("#webUrl").value.trim() || (state.web.article && state.web.article.url);
      if (url) desktop.openExternal(url);
      else showToast("还没有网址", "先输入一个网页链接。", "info");
    });

    $("#settingsBtn").addEventListener("click", () => openModal("settingsModal"));
    $("#helpBtn").addEventListener("click", () => openModal("helpModal"));
    $$("[data-close-modal]").forEach((button) => {
      button.addEventListener("click", () => closeModal(button.dataset.closeModal));
    });
    $$(".modal-backdrop").forEach((backdrop) => {
      backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop && backdrop.id !== "confirmModal") closeModal(backdrop.id);
      });
    });
    $("#setFloatPinned").addEventListener("change", (event) => {
      desktop.floating.setPinned(event.target.checked);
      showToast(event.target.checked ? "浮窗已置顶" : "浮窗取消置顶", "", "info", 1800);
    });
    $("#setFloatOpacity").addEventListener("input", (event) => {
      const value = Number(event.target.value);
      $("#opacityValue").textContent = `${value}%`;
      desktop.floating.setOpacity(value / 100);
    });
    $("#setFloatFont").addEventListener("input", (event) => {
      const value = Number(event.target.value);
      $("#fontValue").textContent = `${value}%`;
      desktop.floating.setFont(value / 100);
    });
    $("#setFloatOpen").addEventListener("click", () => openFloat(true));
    $("#openLogBtn").addEventListener("click", () => desktop.showItem("log"));
    $("#openDataBtn").addEventListener("click", () => desktop.showItem("userData"));
    $("#aboutQuit").addEventListener("click", async () => {
      const ok = await confirmDialog("退出紫语星枢？", "识别与翻译会立即停止，历史已自动保存。", "退出");
      if (ok) desktop.quit();
    });

    ["dragenter", "dragover"].forEach((name) => {
      document.addEventListener(name, (event) => {
        if (event.dataTransfer && Array.from(event.dataTransfer.types || []).includes("Files")) {
          event.preventDefault();
          if (state.feature === "video") $("#dropOverlay").classList.remove("hidden");
        }
      });
    });
    document.addEventListener("dragleave", (event) => {
      if (!event.relatedTarget) $("#dropOverlay").classList.add("hidden");
    });
    document.addEventListener("drop", async (event) => {
      event.preventDefault();
      $("#dropOverlay").classList.add("hidden");
      if (state.feature !== "video") return;
      const file = event.dataTransfer.files && event.dataTransfer.files[0];
      if (!file) return;
      const path = desktop.getPathForFile(file);
      if (path) loadVideoPath(path);
      else {
        state.video.url = URL.createObjectURL(file);
        state.video.name = file.name;
        $("#videoPlayer").src = state.video.url;
        $("#videoDropzone").classList.add("hidden");
        $("#videoPlayerWrap").classList.remove("hidden");
        $("#videoName").textContent = file.name;
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        $$(".modal-backdrop:not(.hidden)").forEach((modal) => {
          if (modal.id !== "confirmModal") closeModal(modal.id);
        });
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        newChat(true);
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        openFloat();
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && state.feature === "text") {
        event.preventDefault();
        translateText();
      }
    });

    window.addEventListener("beforeunload", () => {
      if (state.live) stopLive({ silent: true });
    });
  }

  function runPrimary() {
    if (state.feature === "text") return translateText();
    if (state.feature === "web") return translateWebPage();
    if (state.feature === "video") {
      if (state.video.path) return toggleVideoStreaming();
      return toggleVideoSystemAudio();
    }
    if (state.feature === "game") return toggleGame();
  }

  // ------------------------------------------------------------------ utility
  async function copyText(text, successMessage = "已复制") {
    if (!text) {
      showToast("没有可复制的内容", "", "info", 1800);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast(successMessage, "", "success", 1600);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
      showToast(successMessage, "", "success", 1600);
    }
  }

  function speakText(text, lang) {
    if (!text) {
      showToast("没有可朗读的内容", "", "info", 1800);
      return;
    }
    if (!("speechSynthesis" in window)) {
      showToast("系统不支持朗读", "", "info");
      return;
    }
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text.slice(0, 1200));
    const voices = {
      zh: "zh-CN", en: "en-US", ja: "ja-JP", ko: "ko-KR", fr: "fr-FR",
      de: "de-DE", es: "es-ES", ru: "ru-RU", ar: "ar-SA", pt: "pt-PT",
      it: "it-IT", th: "th-TH",
    };
    utterance.lang = voices[lang] || "zh-CN";
    utterance.rate = 0.98;
    speechSynthesis.speak(utterance);
  }

  function allOriginal() {
    return state.messages.map((msg) => (msg.feature === "web" && msg.article ? msg.article.title : msg.original)).join("\n\n");
  }

  function allTranslated() {
    return state.messages.map((msg) => (msg.feature === "web" && msg.article ? msg.article.translated_title : msg.translated)).filter(Boolean).join("\n\n");
  }

  function lastOriginal() {
    const latest = state.messages[state.messages.length - 1];
    return latest ? latest.original : "";
  }

  function lastTranslated() {
    const latest = state.messages[state.messages.length - 1];
    return latest ? latest.translated : "";
  }

  async function clearCurrent() {
    if (state.live) stopLive({ silent: true });
    const convo = activeConversation();
    if (!convo || !convo.messages.length) {
      $("#sourceInput").value = "";
      updateInputCount();
      $("#webUrl").value = "";
      state.web = { url: "", article: null, lastOcr: null };
      renderAll();
      return;
    }
    const ok = await confirmDialog("清空当前对话？", "当前原文与译文会被移除，并同步从历史记录中删除。", "清空");
    if (!ok) return;
    state.conversations = state.conversations.filter((item) => item.id !== convo.id);
    state.activeId = null;
    state.messages = [];
    $("#sourceInput").value = "";
    $("#webUrl").value = "";
    state.web = { url: "", article: null, lastOcr: null };
    persistHistory();
    renderAll();
    showToast("已清空", "", "success", 1600);
  }

  // --------------------------------------------------------------------- boot
  async function init() {
    bindEvents();
    const waveBars = $("#waveBars");
    if (waveBars && !waveBars.children.length) {
      for (let i = 0; i < 26; i++) {
        const bar = document.createElement("i");
        bar.style.height = `${3 + (i % 5)}px`;
        waveBars.appendChild(bar);
      }
    }
    await loadSettings();
    populateLanguages();
    syncLanguageControls();
    const health = await loadHealth();
    if (health && health.languages && health.languages.length) {
      state.languages = health.languages;
      populateLanguages();
      syncLanguageControls();
    }
    try {
      const history = await desktop.history.load();
      state.conversations = Array.isArray(history.conversations) ? history.conversations : [];
      state.historyLoaded = true;
      state.activeId = state.conversations.some((c) => c.id === history.activeId) ? history.activeId : null;
      if (state.activeId) {
        const convo = activeConversation();
        state.messages = convo ? convo.messages : [];
        const last = state.messages[state.messages.length - 1];
        if (last && last.feature) state.feature = last.feature;
        if (last && last.feature === "web" && last.article) {
          state.web = { url: last.article.url, article: last.article, lastOcr: null };
          $("#webUrl").value = last.article.url || "";
        }
      }
    } catch (error) {
      state.historyLoaded = true;
      console.warn("history load failed", error);
    }
    try {
      const info = await desktop.appInfo();
      if (info && info.version) $("#versionText").textContent = `v${info.version}`;
    } catch {}
    state.floatOpen = false;
    renderAll();
    updateFloatButtons();
    setTimeout(() => {
      $("#boot").classList.add("done");
      $("#appShell").classList.add("ready");
      if (state.feature === "text") $("#sourceInput").focus();
    }, 420);

    window.__lilacTest = {
      state,
      setFeature,
      newChat,
      translateText,
      translateWebPage,
      startScreenOcr,
      toggleOcrFloat,
      runOcrTranslation,
      loadVideoPath,
      startVideoJob,
      toggleVideoStreaming,
      toggleVideoSystemAudio,
      toggleGame,
      stopLive,
      openFloat,
      loadConversation,
      messages: () => state.messages,
    };
  }

  document.addEventListener("DOMContentLoaded", init);
})();
