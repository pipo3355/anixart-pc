// Безопасный мост: интерфейс видит только эти функции, а не весь Node.js.
const { contextBridge, ipcRenderer } = require("electron");

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

// События из главного процесса, на которые интерфейс может подписаться
const EVENTS = ["downloads:changed", "episode:watched", "progress:changed", "net:offline", "marks:synced", "settings:changed", "update:status"];

contextBridge.exposeInMainWorld("api", {
  session: call("session:get"),
  signIn: call("auth:signIn"),
  signOut: call("auth:signOut"),
  search: call("search:releases"),
  release: call("release:get"),
  related: call("related:get"),
  list: call("list:get"),
  favorites: call("favorites:get"),
  history: call("history:get"),
  schedule: call("schedule:get"),
  updates: call("updates:get"),
  setList: call("list:set"),
  setFavorite: call("favorite:set"),
  dubbers: call("episode:types"),
  sources: call("episode:sources"),
  episodes: call("episode:list"),
  watch: call("episode:watch"),
  unwatch: call("episode:unwatch"),
  progress: call("progress:get"),
  pendingMarks: call("marks:pending"),
  settings: call("settings:get"),
  saveSettings: call("settings:set"),
  resetSettings: call("settings:reset"),
  appInfo: call("app:info"),
  checkUpdate: call("update:check"),
  installUpdate: call("update:install"),
  feedback: call("feedback:open"),
  openPlayer: call("player:open"),
  openDownload: call("player:openDownload"),
  downloads: call("downloads:list"),
  download: call("downloads:add"),
  cancelDownload: call("downloads:cancel"),
  retryDownload: call("downloads:retry"),
  removeDownload: call("downloads:remove"),
  openDownloadsFolder: call("downloads:openFolder"),
  exportDownload: call("downloads:export"),
  openExternal: call("shell:openExternal"),
  on(event, callback) {
    if (!EVENTS.includes(event)) throw new Error(`Неизвестное событие: ${event}`);
    const listener = (_e, payload) => callback(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
});
