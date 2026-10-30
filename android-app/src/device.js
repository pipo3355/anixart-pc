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
    async setOrientation() {},
    async setImmersive() {},
    async sleep({ ms }) { await new Promise((r) => setTimeout(r, ms)); },
    async addListener() { return { remove() {} }; },
  }),
});

// Таймер, который срабатывает и в свёрнутом приложении: setTimeout там замирает,
// поэтому параллельно ставим нативный (Device.sleep) — что сработает раньше, то и вызовет fn.
export function later(fn, ms) {
  let done = false;
  const fire = () => { if (done) return; done = true; clearTimeout(t); fn(); };
  const t = setTimeout(fire, ms);
  Device.sleep({ ms }).then(fire, () => {});
  return { cancel() { done = true; clearTimeout(t); } };
}

export const sleep = (ms) => new Promise((r) => later(r, ms));
