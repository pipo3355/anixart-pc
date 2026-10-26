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
  // список серий изменился (докачалась новая) / пора включить дождавшуюся серию
  onQueue(callback) {
    ipcRenderer.on("player:queue", (_e, value) => callback(value));
  },
  onLoad(callback) {
    ipcRenderer.on("player:load", (_e, value) => callback(value));
  },
  onSkip(callback) {
    ipcRenderer.on("player:skip", (_e, value) => callback(value));
  },
});
