/**
 * Narrow preload bridge. The renderer never gets Node.js access directly.
 */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

function subscribe(channel, callback) {
  if (typeof callback !== "function") return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("lilac", {
  isElectron: true,
  appInfo: () => ipcRenderer.invoke("app:info"),

  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    maximize: () => ipcRenderer.invoke("window:maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
    onMaximized: (callback) => subscribe("window:maximized", callback),
  },
  quit: () => ipcRenderer.invoke("app:quit"),

  history: {
    load: () => ipcRenderer.invoke("history:load"),
    save: (data) => ipcRenderer.invoke("history:save", data),
  },

  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    patch: (patch) => ipcRenderer.invoke("settings:patch", patch),
  },

  floating: {
    open: (content) => ipcRenderer.invoke("float:open", content),
    close: () => ipcRenderer.invoke("float:close"),
    update: (content) => ipcRenderer.invoke("float:update", content),
    setPinned: (pinned) => ipcRenderer.invoke("float:set-pinned", pinned),
    setOpacity: (opacity) => ipcRenderer.invoke("float:set-opacity", opacity),
    setFont: (font) => ipcRenderer.invoke("float:set-font", font),
    setSize: (size) => ipcRenderer.invoke("float:set-size", size),
    setClickThrough: (enabled) => ipcRenderer.invoke("float:set-click-through", enabled),
    getBounds: () => ipcRenderer.invoke("float:get-bounds"),
    onContent: (callback) => subscribe("float:content", callback),
    onState: (callback) => subscribe("float:state", callback),
    onAppearance: (callback) => subscribe("float:appearance", callback),
    onVisibility: (callback) => subscribe("float:visibility", callback),
  },

  ocrFloating: {
    open: (content) => ipcRenderer.invoke("ocrFloat:open", content),
    close: () => ipcRenderer.invoke("ocrFloat:close"),
    update: (content) => ipcRenderer.invoke("ocrFloat:update", content),
    capture: (options) => ipcRenderer.invoke("ocr:capture", options),
    onVisibility: (callback) => subscribe("ocrFloat:visibility", callback),
    onCapturedFromFloat: (callback) => subscribe("ocr:captured-from-float", callback),
  },

  desktopSources: () => ipcRenderer.invoke("desktop:sources"),
  openMediaDialog: () => ipcRenderer.invoke("dialog:open-media"),
  fileUrl: (filePath) => ipcRenderer.invoke("file:url", filePath),
  fileStat: (filePath) => ipcRenderer.invoke("file:stat", filePath),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },

  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  showItem: (target) => ipcRenderer.invoke("shell:show-item", target),

  onBackendDown: (callback) => subscribe("backend:down", callback),
  onAppInfo: (callback) => subscribe("app:info", callback),
});
