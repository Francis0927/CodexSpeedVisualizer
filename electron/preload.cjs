const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("speedPet", {
  getInitial: () => ipcRenderer.invoke("app:initial"),
  updateSettings: (patch) => ipcRenderer.invoke("app:settings", patch),
  resetHistory: () => ipcRenderer.invoke("app:resetHistory"),
  choosePetImage: () => ipcRenderer.invoke("app:choosePetImage"),
  clearPetImage: () => ipcRenderer.invoke("app:clearPetImage"),
  setPanelOpen: (open) => ipcRenderer.send("app:panel", open),
  setChromeHidden: (hidden) => ipcRenderer.send("app:chrome", hidden),
  checkUpdate: () => ipcRenderer.invoke("app:checkUpdate"),
  installUpdate: () => ipcRenderer.invoke("app:installUpdate"),
  hide: () => ipcRenderer.send("app:hide"),
  quit: () => ipcRenderer.send("app:quit"),
  onUsage: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("usage:update", listener);
    return () => ipcRenderer.removeListener("usage:update", listener);
  },
  onSettings: (callback) => {
    const listener = (_event, settings) => callback(settings);
    ipcRenderer.on("settings:update", listener);
    return () => ipcRenderer.removeListener("settings:update", listener);
  },
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("update:status", listener);
    return () => ipcRenderer.removeListener("update:status", listener);
  }
});
