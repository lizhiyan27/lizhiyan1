/**
 * 紫语星枢 · LilacLingua AI — Electron main process
 */
const {
  app,
  BrowserWindow,
  dialog,
  desktopCapturer,
  ipcMain,
  Menu,
  screen,
  session,
  shell,
  Tray,
  nativeImage,
} = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const APP_ID = "ai.lilaclingua.desktop";
const APP_NAME = "紫语星枢 LilacLingua AI";
const ROOT = path.join(__dirname, "..");
const USER_DATA = app.getPath("userData");
const SETTINGS_PATH = path.join(USER_DATA, "settings.json");
const HISTORY_PATH = path.join(USER_DATA, "history.json");
const BACKEND_LOG = path.join(USER_DATA, "backend.log");
const ICON_ICO = path.join(ROOT, "assets", "icon.ico");
const ICON_PNG = path.join(ROOT, "assets", "icon.png");

let mainWindow = null;
let floatWindow = null;
let ocrFloatWindow = null;
let splashWindow = null;
let tray = null;
let backendProcess = null;
let backendPort = 0;
let backendReady = false;
let quitting = false;
let floatPinned = true;
let ocrFloatPinned = true;

app.setAppUserModelId(APP_ID);
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("enable-features", "OverlayScrollbar");
if (!app.isPackaged) {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
    return true;
  } catch (error) {
    console.error("writeJson failed", file, error);
    return false;
  }
}

let settings = readJson(SETTINGS_PATH, {
  mainBounds: null,
  floatBounds: { width: 600, height: 260, x: null, y: null },
  ocrFloatBounds: { width: 520, height: 280, x: null, y: null },
  floatPinned: true,
  floatOpacity: 0.96,
  floatFont: 1,
  sidebarCollapsed: false,
});

function saveSettings(patch = {}) {
  settings = { ...settings, ...patch };
  writeJson(SETTINGS_PATH, settings);
}

function loadHistory() {
  const data = readJson(HISTORY_PATH, { conversations: [], activeId: null });
  if (!Array.isArray(data.conversations)) data.conversations = [];
  return data;
}

function resolvePython() {
  const candidates = [
    process.env.LILAC_PYTHON,
    path.join(ROOT, "runtime", "python", "python.exe"),
    path.join(process.resourcesPath || ROOT, "runtime", "python", "python.exe"),
    path.join(ROOT, ".venv", "Scripts", "python.exe"),
    path.join(ROOT, "venv", "Scripts", "python.exe"),
    "python",
    "python3",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === "python" || candidate === "python3") return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }
  return "python";
}

function backendLog(line) {
  try {
    fs.appendFileSync(BACKEND_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}

function startBackend() {
  return new Promise((resolve, reject) => {
    const python = resolvePython();
    backendLog(`starting backend with ${python}`);
    const args = ["-u", path.join(ROOT, "backend", "server.py"), "--port", "0"];
    backendProcess = spawn(python, args, {
      cwd: ROOT,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUNBUFFERED: "1",
        LILAC_DATA_DIR: path.join(USER_DATA, "data"),
      },
    });

    let settled = false;
    let buffer = "";
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("本地 AI 服务启动超时。请检查 Python 运行环境。"));
      }
    }, 45000);

    const onData = (data) => {
      const text = data.toString("utf8");
      buffer += text;
      backendLog(text.trim());
      const match = buffer.match(/LILAC_SERVER_READY\s+(\{.*\})/);
      if (match && !settled) {
        try {
          const info = JSON.parse(match[1]);
          backendPort = info.port;
          backendReady = true;
          settled = true;
          clearTimeout(timeout);
          resolve(info);
        } catch {}
      }
      if (buffer.length > 200000) buffer = buffer.slice(-5000);
    };
    backendProcess.stdout.on("data", onData);
    backendProcess.stderr.on("data", onData);
    backendProcess.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`无法启动本地 AI 服务：${error.message}`));
      }
    });
    backendProcess.on("exit", (code) => {
      backendLog(`backend exited with code ${code}`);
      backendReady = false;
      if (!settled && !quitting) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`本地 AI 服务异常退出（代码 ${code}）。请查看日志：${BACKEND_LOG}`));
      }
      if (!quitting && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("backend:down", { code });
      }
    });
  });
}

function stopBackend() {
  if (!backendProcess) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(backendProcess.pid), "/f", "/t"], {
        windowsHide: true,
      });
    } else {
      backendProcess.kill("SIGTERM");
    }
  } catch {}
  backendProcess = null;
}

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 430,
    height: 280,
    frame: false,
    resizable: false,
    transparent: true,
    show: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: "#00000000",
    webPreferences: { sandbox: true },
  });
  splashWindow.loadFile(path.join(ROOT, "ui", "splash.html"));
  splashWindow.on("closed", () => {
    splashWindow = null;
  });
}

function createMainWindow() {
  const bounds = settings.mainBounds || {};
  mainWindow = new BrowserWindow({
    width: bounds.width || 1440,
    height: bounds.height || 900,
    x: bounds.x,
    y: bounds.y,
    minWidth: 1080,
    minHeight: 700,
    frame: false,
    show: false,
    backgroundColor: "#F4EFFF",
    title: APP_NAME,
    icon: fs.existsSync(ICON_ICO) ? ICON_ICO : ICON_PNG,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadURL(`http://127.0.0.1:${backendPort}/app/index.html`);

  mainWindow.once("ready-to-show", () => {
    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    }, 450);
  });

  mainWindow.on("maximize", () => {
    mainWindow?.webContents.send("window:maximized", true);
  });
  mainWindow.on("unmaximize", () => {
    mainWindow?.webContents.send("window:maximized", false);
  });
  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${backendPort}`)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.webContents.send("app:info", {
      port: backendPort,
      version: app.getVersion(),
      userData: USER_DATA,
      settings,
    });
  });

  const saveBounds = debounce(() => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    const normal = mainWindow.isMaximized() ? settings.mainBounds : mainWindow.getBounds();
    saveSettings({ mainBounds: normal });
  }, 450);
  mainWindow.on("move", saveBounds);
  mainWindow.on("resize", saveBounds);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (backendReady) createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// -------------------------------------------------------------- Subtitle Floating UI
function defaultFloatBounds() {
  const display = screen.getPrimaryDisplay().workArea;
  const saved = settings.floatBounds || {};
  const width = Math.min(Math.max(saved.width || 620, 360), display.width - 40);
  const height = Math.min(Math.max(saved.height || 260, 160), display.height - 40);
  return {
    width,
    height,
    x: saved.x == null ? Math.round(display.x + (display.width - width) / 2) : saved.x,
    y: saved.y == null ? Math.round(display.y + display.height - height - 34) : saved.y,
  };
}

function createFloatWindow() {
  if (floatWindow && !floatWindow.isDestroyed()) return floatWindow;
  const bounds = defaultFloatBounds();
  floatWindow = new BrowserWindow({
    ...bounds,
    minWidth: 340,
    minHeight: 150,
    frame: false,
    transparent: true,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: floatPinned,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: "#00000000",
    title: "紫语星枢 · 双语浮窗",
    icon: fs.existsSync(ICON_ICO) ? ICON_ICO : ICON_PNG,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  floatWindow.loadFile(path.join(ROOT, "ui", "float.html"), { query: { mode: "subtitle" } });
  floatWindow.once("ready-to-show", () => {
    floatWindow.showInactive();
    floatWindow.webContents.send("float:state", {
      pinned: floatPinned,
      opacity: settings.floatOpacity,
      font: settings.floatFont,
      mode: "subtitle",
    });
  });
  floatWindow.setAlwaysOnTop(floatPinned, "floating");
  floatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const save = debounce(() => {
    if (!floatWindow || floatWindow.isDestroyed()) return;
    saveSettings({
      floatBounds: floatWindow.getBounds(),
      floatPinned,
    });
  }, 450);
  floatWindow.on("move", save);
  floatWindow.on("resize", save);
  floatWindow.on("closed", () => {
    floatWindow = null;
    notifyFloatVisibility(false);
  });
  return floatWindow;
}

function notifyFloatVisibility(visible) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("float:visibility", Boolean(visible));
  }
}

function toggleFloat(show, content) {
  if (show === false) {
    if (floatWindow && !floatWindow.isDestroyed()) floatWindow.hide();
    notifyFloatVisibility(false);
    return;
  }
  const win = createFloatWindow();
  if (content) {
    if (win.webContents.isLoading()) {
      win.webContents.once("did-finish-load", () => sendFloatContent(content));
    } else {
      sendFloatContent(content);
    }
    if (!win.isVisible()) win.showInactive();
  } else if (!win.isVisible()) {
    win.showInactive();
  }
  notifyFloatVisibility(true);
}

function sendFloatContent(content) {
  if (floatWindow && !floatWindow.isDestroyed()) {
    floatWindow.webContents.send("float:content", content);
  }
}

// -------------------------------------------------------------- Screen OCR Floating UI
function defaultOcrFloatBounds() {
  const display = screen.getPrimaryDisplay().workArea;
  const saved = settings.ocrFloatBounds || {};
  const width = Math.min(Math.max(saved.width || 520, 340), display.width - 40);
  const height = Math.min(Math.max(saved.height || 270, 170), display.height - 40);
  return {
    width,
    height,
    x: saved.x == null ? Math.round(display.x + display.width - width - 48) : saved.x,
    y: saved.y == null ? Math.round(display.y + 80) : saved.y,
  };
}

function createOcrFloatWindow() {
  if (ocrFloatWindow && !ocrFloatWindow.isDestroyed()) return ocrFloatWindow;
  const bounds = defaultOcrFloatBounds();
  ocrFloatWindow = new BrowserWindow({
    ...bounds,
    minWidth: 340,
    minHeight: 170,
    frame: false,
    transparent: true,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: ocrFloatPinned,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: "#00000000",
    title: "紫语星枢 · 识屏翻译浮窗",
    icon: fs.existsSync(ICON_ICO) ? ICON_ICO : ICON_PNG,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  ocrFloatWindow.loadFile(path.join(ROOT, "ui", "float.html"), { query: { mode: "ocr" } });
  ocrFloatWindow.once("ready-to-show", () => {
    ocrFloatWindow.showInactive();
    ocrFloatWindow.webContents.send("float:state", {
      pinned: ocrFloatPinned,
      opacity: settings.floatOpacity,
      font: settings.floatFont,
      mode: "ocr",
    });
  });
  ocrFloatWindow.setAlwaysOnTop(ocrFloatPinned, "floating");
  ocrFloatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const save = debounce(() => {
    if (!ocrFloatWindow || ocrFloatWindow.isDestroyed()) return;
    saveSettings({
      ocrFloatBounds: ocrFloatWindow.getBounds(),
    });
  }, 450);
  ocrFloatWindow.on("move", save);
  ocrFloatWindow.on("resize", save);
  ocrFloatWindow.on("closed", () => {
    ocrFloatWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("ocrFloat:visibility", false);
    }
  });
  return ocrFloatWindow;
}

function toggleOcrFloat(show, content) {
  if (show === false) {
    if (ocrFloatWindow && !ocrFloatWindow.isDestroyed()) ocrFloatWindow.hide();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("ocrFloat:visibility", false);
    }
    return;
  }
  const win = createOcrFloatWindow();
  if (content) {
    if (win.webContents.isLoading()) {
      win.webContents.once("did-finish-load", () => win.webContents.send("float:content", content));
    } else {
      win.webContents.send("float:content", content);
    }
  }
  if (!win.isVisible()) win.showInactive();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("ocrFloat:visibility", true);
  }
}

async function captureScreenDataUrl(rect = null, hideMain = false) {
  const floatWasVisible = floatWindow && !floatWindow.isDestroyed() && floatWindow.isVisible();
  const ocrWasVisible = ocrFloatWindow && !ocrFloatWindow.isDestroyed() && ocrFloatWindow.isVisible();
  const mainWasVisible = hideMain && mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();

  if (floatWasVisible) floatWindow.hide();
  if (ocrWasVisible) ocrFloatWindow.hide();
  if (mainWasVisible) mainWindow.hide();

  await new Promise((r) => setTimeout(r, 160));

  try {
    const primary = screen.getPrimaryDisplay();
    const scaleFactor = primary.scaleFactor || 1;
    const width = Math.round(primary.size.width * scaleFactor);
    const height = Math.round(primary.size.height * scaleFactor);

    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width, height },
    });
    if (!sources.length) throw new Error("未找到可用的屏幕源");
    let img = sources[0].thumbnail;
    if (rect && rect.width > 10 && rect.height > 10) {
      const x = Math.max(0, Math.min(width - 2, Math.round(rect.x * scaleFactor)));
      const y = Math.max(0, Math.min(height - 2, Math.round(rect.y * scaleFactor)));
      const cropRect = {
        x,
        y,
        width: Math.max(1, Math.min(width - x, Math.round(rect.width * scaleFactor))),
        height: Math.max(1, Math.min(height - y, Math.round(rect.height * scaleFactor))),
      };
      img = img.crop(cropRect);
    }
    return img.toDataURL();
  } finally {
    if (mainWasVisible && mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    if (floatWasVisible && floatWindow && !floatWindow.isDestroyed()) floatWindow.showInactive();
    if (ocrWasVisible && ocrFloatWindow && !ocrFloatWindow.isDestroyed()) ocrFloatWindow.showInactive();
  }
}

// ----------------------------------------------------------------------- tray
function createTray() {
  const iconPath = fs.existsSync(ICON_PNG) ? ICON_PNG : ICON_ICO;
  const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 });
  tray = new Tray(trayIcon);
  tray.setToolTip(APP_NAME);
  const updateMenu = () => {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "显示紫语星枢", click: showMainWindow },
        { label: "显示双语字幕浮窗", click: () => toggleFloat(true) },
        { label: "显示识屏翻译浮窗", click: () => toggleOcrFloat(true) },
        { type: "separator" },
        {
          label: "退出",
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ])
    );
  };
  updateMenu();
  tray.on("double-click", showMainWindow);
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function registerIpc() {
  ipcMain.handle("app:info", () => ({
    port: backendPort,
    version: app.getVersion(),
    userData: USER_DATA,
    settings,
    backendReady,
  }));

  ipcMain.handle("window:minimize", () => mainWindow?.minimize());
  ipcMain.handle("window:maximize", () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle("window:close", () => {
    mainWindow?.hide();
    return true;
  });
  ipcMain.handle("window:is-maximized", () => Boolean(mainWindow?.isMaximized()));
  ipcMain.handle("app:quit", () => {
    quitting = true;
    app.quit();
    return true;
  });

  ipcMain.handle("history:load", () => loadHistory());
  ipcMain.handle("history:save", (_event, data) => {
    if (!data || !Array.isArray(data.conversations)) return false;
    return writeJson(HISTORY_PATH, data);
  });
  ipcMain.handle("settings:get", () => settings);
  ipcMain.handle("settings:patch", (_event, patch) => {
    if (!patch || typeof patch !== "object") return settings;
    saveSettings(patch);
    return settings;
  });

  // Subtitle float IPC
  ipcMain.handle("float:open", (_event, content) => {
    toggleFloat(true, content);
    return true;
  });
  ipcMain.handle("float:close", (event) => {
    if (ocrFloatWindow && !ocrFloatWindow.isDestroyed() && event.sender === ocrFloatWindow.webContents) {
      toggleOcrFloat(false);
      return true;
    }
    toggleFloat(false);
    return true;
  });
  ipcMain.handle("float:update", (_event, content) => {
    sendFloatContent(content);
    return true;
  });
  ipcMain.handle("float:set-pinned", (event, pinned) => {
    if (ocrFloatWindow && !ocrFloatWindow.isDestroyed() && event.sender === ocrFloatWindow.webContents) {
      ocrFloatPinned = Boolean(pinned);
      ocrFloatWindow.setAlwaysOnTop(ocrFloatPinned, "floating");
      return ocrFloatPinned;
    }
    floatPinned = Boolean(pinned);
    if (floatWindow && !floatWindow.isDestroyed()) {
      floatWindow.setAlwaysOnTop(floatPinned, "floating");
    }
    saveSettings({ floatPinned });
    return floatPinned;
  });
  ipcMain.handle("float:set-opacity", (_event, opacity) => {
    const value = Math.min(1, Math.max(0.4, Number(opacity) || 0.96));
    saveSettings({ floatOpacity: value });
    if (floatWindow && !floatWindow.isDestroyed()) {
      floatWindow.webContents.send("float:appearance", { opacity: value });
    }
    if (ocrFloatWindow && !ocrFloatWindow.isDestroyed()) {
      ocrFloatWindow.webContents.send("float:appearance", { opacity: value });
    }
    return value;
  });
  ipcMain.handle("float:set-font", (_event, font) => {
    const value = Math.min(1.6, Math.max(0.75, Number(font) || 1));
    saveSettings({ floatFont: value });
    if (floatWindow && !floatWindow.isDestroyed()) {
      floatWindow.webContents.send("float:appearance", { font: value });
    }
    if (ocrFloatWindow && !ocrFloatWindow.isDestroyed()) {
      ocrFloatWindow.webContents.send("float:appearance", { font: value });
    }
    return value;
  });
  ipcMain.handle("float:set-size", (event, size) => {
    const targetWin =
      ocrFloatWindow && !ocrFloatWindow.isDestroyed() && event.sender === ocrFloatWindow.webContents
        ? ocrFloatWindow
        : floatWindow;
    if (!targetWin || targetWin.isDestroyed()) return false;
    const bounds = targetWin.getBounds();
    const newW = Math.max(340, Math.round(size.width || bounds.width));
    const newH = Math.max(150, Math.round(size.height || bounds.height));
    if (Math.abs(newW - bounds.width) < 2 && Math.abs(newH - bounds.height) < 2) return true;
    targetWin.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: newW,
      height: newH,
    });
    return true;
  });
  ipcMain.handle("float:set-click-through", (_event, enabled) => {
    if (floatWindow && !floatWindow.isDestroyed()) {
      floatWindow.setIgnoreMouseEvents(Boolean(enabled), { forward: true });
    }
    return Boolean(enabled);
  });
  ipcMain.handle("float:get-bounds", (event) => {
    const targetWin =
      ocrFloatWindow && !ocrFloatWindow.isDestroyed() && event.sender === ocrFloatWindow.webContents
        ? ocrFloatWindow
        : floatWindow;
    if (!targetWin || targetWin.isDestroyed()) return null;
    return targetWin.getBounds();
  });

  // OCR Float & Screen Capture IPC
  ipcMain.handle("ocrFloat:open", (_event, content) => {
    toggleOcrFloat(true, content);
    return true;
  });
  ipcMain.handle("ocrFloat:close", () => {
    toggleOcrFloat(false);
    return true;
  });
  ipcMain.handle("ocrFloat:update", (_event, content) => {
    if (ocrFloatWindow && !ocrFloatWindow.isDestroyed()) {
      ocrFloatWindow.webContents.send("float:content", content);
    }
    return true;
  });
  ipcMain.handle("ocr:capture", async (_event, options = {}) => {
    const dataUrl = await captureScreenDataUrl(options.rect || null, Boolean(options.hideMain));
    if (options.notifyMain && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("ocr:captured-from-float", { dataUrl });
    }
    return dataUrl;
  });

  ipcMain.handle("desktop:sources", async () => {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      displayId: source.display_id,
    }));
  });

  ipcMain.handle("dialog:open-media", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择视频或音频文件",
      properties: ["openFile"],
      filters: [
        { name: "媒体文件", extensions: ["mp4", "mkv", "mov", "webm", "avi", "m4v", "mp3", "wav", "m4a", "flac", "ogg"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("shell:open-external", (_event, url) => {
    if (typeof url === "string" && /^https?:/i.test(url)) shell.openExternal(url);
    return true;
  });
  ipcMain.handle("file:url", (_event, filePath) => {
    if (typeof filePath !== "string" || !filePath) return "";
    return pathToFileURL(filePath).href;
  });
  ipcMain.handle("file:stat", (_event, filePath) => {
    try {
      const stat = fs.statSync(filePath);
      return { exists: true, size: stat.size, name: path.basename(filePath) };
    } catch {
      return { exists: false };
    }
  });
  ipcMain.handle("shell:show-item", (_event, target) => {
    if (target === "userData") shell.openPath(USER_DATA);
    else if (target === "log") shell.openPath(BACKEND_LOG);
    else if (target === "project") shell.openPath(ROOT);
    return true;
  });
}

// ---------------------------------------------------------------------- boot
function getArgValue(prefix) {
  const arg = process.argv.find((item) => item.startsWith(prefix + "="));
  return arg ? arg.slice(prefix.length + 1) : "";
}

async function captureTo(win, file) {
  if (!win || win.isDestroyed()) return;
  const image = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, image.toPNG());
}

async function runSmoke(dir) {
  const errors = [];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  app.on("web-contents-created", (_event, contents) => {
    contents.on("console-message", (_e, level, message) => {
      if (level >= 2) errors.push(message);
    });
    contents.on("render-process-gone", (_e, details) => errors.push("render gone: " + JSON.stringify(details)));
  });
  const waitFor = async (fn, timeout = 20000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        if (await fn()) return true;
      } catch {}
      await sleep(250);
    }
    return false;
  };
  const ok = await waitFor(async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    return await mainWindow.webContents.executeJavaScript("Boolean(document.querySelector('.app-shell.ready'))");
  }, 30000);
  await sleep(1200);
  await captureTo(mainWindow, path.join(dir, "01-text.png"));

  const tabs = ["video", "game", "web"];
  for (let i = 0; i < tabs.length; i++) {
    await mainWindow.webContents.executeJavaScript(
      `document.querySelector('.feature-tab[data-feature="${tabs[i]}"]').click()`
    );
    await sleep(550);
    await captureTo(mainWindow, path.join(dir, `0${i + 2}-${tabs[i]}.png`));
  }
  await mainWindow.webContents.executeJavaScript(
    `document.querySelector('.feature-tab[data-feature="text"]').click()`
  );
  await sleep(400);
  await mainWindow.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector('#sourceInput');
      input.value = 'Artificial intelligence is transforming the way we understand and translate human languages.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#primaryBtn').click();
    })()
  `);
  await waitFor(async () => {
    const count = await mainWindow.webContents.executeJavaScript(
      "document.querySelectorAll('#targetMessages .msg').length"
    );
    return count > 0;
  }, 30000);
  await sleep(600);
  await captureTo(mainWindow, path.join(dir, "05-result.png"));

  // New conversation + history restore.
  await mainWindow.webContents.executeJavaScript("window.__lilacTest.newChat(false)");
  await sleep(400);
  await mainWindow.webContents.executeJavaScript(
    "document.querySelector('#historyList .history-item')?.click()"
  );
  await sleep(700);
  const historyMessages = await mainWindow.webContents.executeJavaScript(
    "document.querySelectorAll('#sourceMessages .msg').length"
  );
  await captureTo(mainWindow, path.join(dir, "05b-history-restore.png"));
  await mainWindow.webContents.executeJavaScript("window.__lilacTest.newChat(false)");
  await sleep(300);

  // Video pipeline: load the generated test clip and let the backend parse it.
  await mainWindow.webContents.executeJavaScript(`window.__lilacTest.setFeature('video')`);
  await mainWindow.webContents.executeJavaScript(`
    (() => {
      const select = document.querySelector('#asrLang');
      select.value = 'en';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await sleep(400);
  await mainWindow.webContents.executeJavaScript(
    `window.__lilacTest.loadVideoPath(${JSON.stringify(path.join(ROOT, "tests", "test_video.mp4"))})`
  );
  await sleep(1200);
  const videoInfo = await mainWindow.webContents.executeJavaScript(`
    (async () => {
      const v = document.querySelector('#videoPlayer');
      if (v.readyState < 2) await new Promise((resolve) => {
        v.addEventListener('loadeddata', resolve, { once: true });
        setTimeout(resolve, 3000);
      });
      let info = { src: v.currentSrc, readyState: v.readyState, duration: v.duration, audio: -1 };
      try {
        await v.play();
        await new Promise((resolve) => setTimeout(resolve, 900));
        const stream = v.captureStream ? v.captureStream() : null;
        info.audio = stream ? stream.getAudioTracks().length : -1;
        if (stream) stream.getTracks().forEach((track) => track.stop());
        v.pause();
        v.currentTime = 0;
      } catch (error) { info.error = String(error); }
      return info;
    })()
  `);
  await mainWindow.webContents.executeJavaScript(`window.__lilacTest.startVideoJob()`);
  await waitFor(async () => {
    const count = await mainWindow.webContents.executeJavaScript(
      "document.querySelectorAll('#sourceMessages .msg').length"
    );
    return count >= 2;
  }, 45000);
  await sleep(700);
  await captureTo(mainWindow, path.join(dir, "07-video-result.png"));

  // Live video capture path (video element -> WebAudio -> streaming Vosk).
  await mainWindow.webContents.executeJavaScript(`window.__lilacTest.newChat(false)`);
  await sleep(300);
  await mainWindow.webContents.executeJavaScript(
    `window.__lilacTest.loadVideoPath(${JSON.stringify(path.join(ROOT, "tests", "test_video.mp4"))})`
  );
  await sleep(900);
  await mainWindow.webContents.executeJavaScript(`
    (async () => {
      const v = document.querySelector('#videoPlayer');
      await v.play();
      document.querySelector('#videoAsrBtn').click();
    })()
  `);
  await sleep(4500);
  const videoLiveActive = await mainWindow.webContents.executeJavaScript(
    "Boolean(window.__lilacTest.state.live && window.__lilacTest.state.live.feature === 'video')"
  );
  await sleep(9000);
  await captureTo(mainWindow, path.join(dir, "07b-video-live.png"));
  const videoLiveMessages = await mainWindow.webContents.executeJavaScript(
    "document.querySelectorAll('#sourceMessages .msg').length"
  );
  await mainWindow.webContents.executeJavaScript("window.__lilacTest.stopLive({silent:true})");
  await sleep(1200);

  // System loopback capture path (game mode). This checks that Electron's
  // desktopCapturer returns an audio track; transcripts depend on audio output.
  await mainWindow.webContents.executeJavaScript(`window.__lilacTest.setFeature('game')`);
  await mainWindow.webContents.executeJavaScript(`
    (() => {
      const select = document.querySelector('#asrLang');
      select.value = 'en';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await sleep(400);
  await mainWindow.webContents.executeJavaScript("document.querySelector('#gameStartBtn').click()");
  await sleep(5000);
  const gameLiveActive = await mainWindow.webContents.executeJavaScript(
    "Boolean(window.__lilacTest.state.live && window.__lilacTest.state.live.feature === 'game')"
  );
  await captureTo(mainWindow, path.join(dir, "12-game-live.png"));
  if (floatWindow && !floatWindow.isDestroyed()) {
    await captureTo(floatWindow, path.join(dir, "12b-float-game.png"));
  }
  let gameTranscripts = 0;
  if (gameLiveActive) {
    // Play a real speech sample through the default output device so the
    // loopback capture has something to recognize.
    await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const audio = new Audio('/media?path=' + encodeURIComponent(${JSON.stringify(
          path.join(ROOT, "tests", "speech_en.wav")
        )}));
        audio.volume = 0.65;
        window.__gameTestAudio = audio;
        await audio.play();
      })()
    `);
    await sleep(11500);
    gameTranscripts = await mainWindow.webContents.executeJavaScript(
      "document.querySelectorAll('#sourceMessages .msg').length"
    );
    const sourceEmptyState = await mainWindow.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector('#sourceEmpty');
        return { className: el.className, display: getComputedStyle(el).display, children: document.querySelector('#sourceMessages').children.length };
      })()
    `);
    console.log("SOURCE_EMPTY_STATE", JSON.stringify(sourceEmptyState));
    await sleep(900);
    await captureTo(mainWindow, path.join(dir, "13-game-transcripts.png"));
    await mainWindow.webContents.executeJavaScript("window.__lilacTest.stopLive({silent:true})");
    await sleep(1200);
    await mainWindow.webContents.executeJavaScript("window.__lilacTest.openFloat(false)");
    await sleep(300);
  }

  // Web translation via a local fixture served by the backend tests.
  await mainWindow.webContents.executeJavaScript(`window.__lilacTest.setFeature('web')`);
  await mainWindow.webContents.executeJavaScript(`
    (() => {
      const target = document.querySelector('#targetLang');
      target.value = 'en';
      target.dispatchEvent(new Event('change', { bubbles: true }));
      const input = document.querySelector('#webUrl');
      input.value = 'http://127.0.0.1:52020/web_fixture.html';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#webTranslateBtn').click();
    })()
  `);
  await waitFor(async () => {
    const count = await mainWindow.webContents.executeJavaScript(
      "document.querySelectorAll('#sourceMessages .article-p').length"
    );
    return count >= 3;
  }, 45000);
  await sleep(900);
  await captureTo(mainWindow, path.join(dir, "08-web-result.png"));

  await mainWindow.webContents.executeJavaScript(`window.__lilacTest.setFeature('text')`);
  await sleep(400);
  await mainWindow.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector('#sourceInput');
      input.value = 'The world is full of stories waiting to be translated.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#primaryBtn').click();
    })()
  `);
  await waitFor(async () => {
    const count = await mainWindow.webContents.executeJavaScript(
      "document.querySelectorAll('#targetMessages .msg').length"
    );
    return count > 0;
  }, 30000);
  await sleep(500);
  await mainWindow.webContents.executeJavaScript("document.querySelector('#topFloatBtn').click()");
  await sleep(1200);
  if (floatWindow && !floatWindow.isDestroyed()) {
    await captureTo(floatWindow, path.join(dir, "09-float.png"));
    await floatWindow.webContents.executeJavaScript(
      "window.lilac.floating.setSize({width: 520, height: 220})"
    );
    await sleep(700);
    await captureTo(floatWindow, path.join(dir, "10-float-resized.png"));
  }

  await mainWindow.webContents.executeJavaScript("document.querySelector('#sidebarToggle').click()");
  await sleep(500);
  await captureTo(mainWindow, path.join(dir, "11-sidebar-collapsed.png"));
  await mainWindow.webContents.executeJavaScript("document.querySelector('#sidebarToggle').click()");
  await sleep(300);

  await mainWindow.webContents.executeJavaScript("document.querySelector('#sidebarToggle').click()");
  await sleep(300);

  mainWindow.setSize(1080, 720);
  await sleep(700);
  await captureTo(mainWindow, path.join(dir, "14-compact-1080.png"));
  mainWindow.setSize(1440, 900);
  await sleep(500);

  // OCR crop overlay (capture -> preview -> Esc cancel).
  await mainWindow.webContents.executeJavaScript(`window.__lilacTest.setFeature('web')`);
  await sleep(300);
  await mainWindow.webContents.executeJavaScript(`window.__lilacTest.startScreenOcr(); true`);
  await sleep(2600);
  const ocrOverlay = await mainWindow.webContents.executeJavaScript(
    "Boolean(document.querySelector('#ocrPreviewImg'))"
  );
  await captureTo(mainWindow, path.join(dir, "19-ocr-overlay.png"));
  await mainWindow.webContents.executeJavaScript(
    "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))"
  );
  await sleep(400);

  // OCR pipeline (backend Windows OCR + result card + OCR floating window).
  await mainWindow.webContents.executeJavaScript(`window.__lilacTest.setFeature('web')`);
  await sleep(400);
  const ocrB64 = fs.readFileSync(path.join(ROOT, "tests", "ocr_test.png")).toString("base64");
  await mainWindow.webContents.executeJavaScript(
    `window.__lilacTest.runOcrTranslation(${JSON.stringify("data:image/png;base64," + ocrB64)})`
  );
  await waitFor(async () => {
    const text = await mainWindow.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('#sourceMessages .msg-text')).map(el => el.textContent).join(' ')"
    );
    return /HELLO|LILAC/i.test(text);
  }, 45000);
  await sleep(800);
  await captureTo(mainWindow, path.join(dir, "15-ocr.png"));
  if (ocrFloatWindow && !ocrFloatWindow.isDestroyed()) {
    await captureTo(ocrFloatWindow, path.join(dir, "16-ocr-float.png"));
  }

  // Video workspace system-audio listening (new in v3.1).
  await mainWindow.webContents.executeJavaScript(`window.__lilacTest.newChat(false)`);
  await mainWindow.webContents.executeJavaScript(`window.__lilacTest.state.video.path = ""`);
  await mainWindow.webContents.executeJavaScript(`window.__lilacTest.setFeature('video')`);
  await sleep(400);
  await mainWindow.webContents.executeJavaScript(`
    (() => {
      const select = document.querySelector('#asrLang');
      select.value = 'en';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#videoSysAudioBtn').click();
    })()
  `);
  await sleep(5000);
  const videoSysLive = await mainWindow.webContents.executeJavaScript(
    "Boolean(window.__lilacTest.state.live && window.__lilacTest.state.live.feature === 'video' && window.__lilacTest.state.live.systemLoopback)"
  );
  let videoSysMessages = 0;
  if (videoSysLive) {
    await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const audio = new Audio('/media?path=' + encodeURIComponent(${JSON.stringify(path.join(ROOT, "tests", "speech_en.wav"))}));
        audio.volume = 0.65;
        window.__videoSysTestAudio = audio;
        await audio.play();
      })()
    `);
    await sleep(11000);
    videoSysMessages = await mainWindow.webContents.executeJavaScript(
      "document.querySelectorAll('#sourceMessages .msg').length"
    );
    await captureTo(mainWindow, path.join(dir, "17-video-system-audio.png"));
    await mainWindow.webContents.executeJavaScript("window.__lilacTest.stopLive({silent:true})");
    await sleep(1000);
    await mainWindow.webContents.executeJavaScript("window.__lilacTest.openFloat(false)");
  }

  // Web workspace layout at the minimum supported size.
  await mainWindow.webContents.executeJavaScript(`window.__lilacTest.setFeature('web')`);
  await sleep(400);
  mainWindow.setSize(1080, 720);
  await sleep(600);
  await captureTo(mainWindow, path.join(dir, "18-web-compact-1080.png"));
  mainWindow.setSize(1440, 900);
  await sleep(500);

  const summary = {
    ok,
    title: await mainWindow.webContents.executeJavaScript("document.title"),
    videoInfo,
    videoLiveActive,
    videoLiveMessages,
    gameLiveActive,
    gameTranscripts,
    historyMessages,
    videoSysLive,
    videoSysMessages,
    ocrOverlay,
    messages: await mainWindow.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('#sourceMessages .msg-text')).map(el => el.textContent)"
    ),
    translated: await mainWindow.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('#targetMessages .msg-text')).map(el => el.textContent)"
    ),
    errors,
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "smoke.json"), JSON.stringify(summary, null, 2), "utf8");
  await sleep(500);
  quitting = true;
  app.quit();
}

async function boot() {
  createSplash();
  try {
    await startBackend();
    registerIpc();
    createMainWindow();
    createTray();
    const smokeDir = getArgValue("--smoke");
    if (smokeDir) runSmoke(smokeDir);
  } catch (error) {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    dialog.showMessageBox({
      type: "error",
      title: "紫语星枢启动失败",
      message: String(error.message || error),
      detail:
        `日志位置：${BACKEND_LOG}\n\n` +
        "请确认项目内 .venv 或系统 Python 可用，并已安装 numpy / vosk。",
      buttons: ["退出"],
    });
    quitting = true;
    app.quit();
  }
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (["media", "audioCapture", "display-capture", "clipboard-read", "clipboard-sanitized-write"].includes(permission)) {
      return callback(true);
    }
    callback(true);
  });

  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ["screen"] });
        if (!sources.length) return callback({});
        callback({ video: sources[0], audio: "loopback" });
      } catch {
        callback({});
      }
    },
    { useSystemPicker: false }
  );

  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    contents.on("will-attach-webview", (_e, webPreferences) => {
      delete webPreferences.preload;
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
    });
  });

  boot();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && backendReady) createMainWindow();
  else showMainWindow();
});

app.on("before-quit", () => {
  quitting = true;
});

app.on("will-quit", () => {
  quitting = true;
  stopBackend();
});

app.on("window-all-closed", () => {});
