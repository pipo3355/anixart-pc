// Мост для окна плеера: получить серию, сохранить прогресс, переключить серию.
const { contextBridge, ipcRenderer } = require("electron");

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("player", {
  init: call("player:init"),
  progress: call("player:progress"),
  next: call("player:next"),
  prev: call("player:prev"),
  settings: call("settings:get"),
  onSettings(callback) {
    ipcRenderer.on("settings:changed", (_e, value) => callback(value));
  },
});
