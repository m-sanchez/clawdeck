const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "ocelin",
  Object.freeze({
    state: () => ipcRenderer.invoke("ocelin:state"),
    action: (name, args) => ipcRenderer.invoke("ocelin:action", name, args),
    subscribe: (callback) => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on("ocelin:state", listener);
      return () => ipcRenderer.removeListener("ocelin:state", listener);
    },
  }),
);
