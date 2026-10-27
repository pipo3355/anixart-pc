// Свой нативный плагин (android/.../DevicePlugin.java): свободное место и «картинка в картинке».
// В браузере (при отладке) — заглушки.

import { registerPlugin } from "@capacitor/core";

export const Device = registerPlugin("Device", {
  web: () => ({
    async storage() {
      const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : {};
      return { free: (est.quota || 0) - (est.usage || 0), total: est.quota || 0 };
    },
    async enterPip() { throw new Error("Картинка в картинке есть только в приложении"); },
    async isPip() { return { active: false }; },
    async downloadsActive() {},
    async downloadsIdle() {},
    async askNotifications() {},
    async addListener() { return { remove() {} }; },
  }),
});
