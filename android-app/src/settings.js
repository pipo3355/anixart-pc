// Настройки приложения (хранятся на телефоне).

import { prefs } from "./storage.js";

const DEFAULTS = {
  seekStep: 10, // двойное касание слева/справа, секунд
  skipOpening: 85, // кнопка «пропустить», если точных таймингов нет, секунд
  skipMode: "button", // опенинг/эндинг: auto | button | off
  speed: 1,
  quality: "720", // качество загрузки
  onlyWifi: false,
  sort: "recent", // recent | title | size | unwatched
  filter: "all", // all | unwatched | watched | active
};

let current = { ...DEFAULTS };
const listeners = new Set();

export const settings = {
  async load() {
    current = { ...DEFAULTS, ...(await prefs.get("settings", {})) };
    return current;
  },
  get: () => current,
  async set(patch) {
    current = { ...current, ...patch };
    await prefs.set("settings", current);
    for (const fn of listeners) try { fn(current); } catch {}
    return current;
  },
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  defaults: DEFAULTS,
};
