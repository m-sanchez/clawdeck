const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "ocelin",
  Object.freeze({
    state: () => ipcRenderer.invoke("ocelin:state"),
    action: (name, args) => ipcRenderer.invoke("ocelin:action", name, args),
    panelReady: () => ipcRenderer.send("ocelin:panel-ready"),
    onPanelOpen: (callback) => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on("ocelin:panel-open", listener);
      return () => ipcRenderer.removeListener("ocelin:panel-open", listener);
    },
    subscribe: (callback) => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on("ocelin:state", listener);
      return () => ipcRenderer.removeListener("ocelin:state", listener);
    },
  }),
);
