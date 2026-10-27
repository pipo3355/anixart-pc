// Фоновые загрузки: пока что-то качается, нативная служба держит приложение живым
// (свёрнутое, с погашенным экраном) и показывает прогресс в уведомлении.

import { Capacitor } from "@capacitor/core";
import { Device, later } from "./device.js";

const UPDATE_MS = 1500; // чаще обновлять уведомление незачем — Android сам режет частые обновления

export function keepDownloadsAlive(downloads) {
  if (!Capacitor.isNativePlatform()) return;
  let running = false;
  let asked = false;
  let lastSent = 0;
  let lastText = "";
  let timer = null;

  const describe = (list) => {
    const active = list.find((it) => it.status === "downloading");
    const queued = list.filter((it) => it.status === "queued").length;
    // Между сериями и без сети служба не выключается: из свёрнутого приложения Android
    // не даст запустить её снова, и следующая серия ждала бы, пока приложение откроют.
    if (!active) {
      if (!queued) return null;
      return { text: downloads.waiting ? `Жду интернет… · в очереди ${queued}` : `Начинаю следующую серию… · в очереди ${queued}`, progress: -1 };
    }
    const pct = Math.round((active.progress || 0) * 100);
    let text = `${active.releaseTitle} — ${active.name} · ${pct}%`;
    if (queued) text += ` · ещё ${queued} в очереди`;
    return { text, progress: active.progress ? pct : -1 };
  };

  const sync = (list) => {
    const info = describe(list);
    if (!info) {
      if (timer) timer.cancel();
      timer = null;
      if (running) { running = false; Device.downloadsIdle().catch(() => {}); }
      return;
    }
    if (!asked) { asked = true; Device.askNotifications().catch(() => {}); }
    const send = () => {
      timer = null;
      const now = describe(downloads.list());
      if (!now) return;
      if (running && now.text === lastText) return;
      lastSent = Date.now();
      lastText = now.text;
      running = true;
      Device.downloadsActive(now).catch((e) => console.warn("[background]", e && e.message));
    };
    const wait = UPDATE_MS - (Date.now() - lastSent);
    if (!running || wait <= 0) send();
    else if (!timer) timer = later(send, wait);
  };

  downloads.on(sync);
  sync(downloads.list());
}
