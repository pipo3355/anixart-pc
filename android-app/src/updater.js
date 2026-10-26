// Обновление изнутри приложения: находим новый релиз android-v* на GitHub, качаем APK
// к себе в кэш и открываем системный установщик. В браузер не уходим.

import { App } from "@capacitor/app";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { FileTransfer } from "@capacitor/file-transfer";
import { Device } from "./device.js";

const REPO = "pipo3355/anixart-pc";

function newer(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

class Updater {
  constructor(currentVersion) {
    this.current = currentVersion;
    this.state = { status: "idle" }; // idle | checking | available | downloading | ready | none | error
    this.listeners = new Set();
    this.apkPath = null;
    this.waitingPermission = false;
    App.addListener("resume", () => {
      // вернулись из настроек «Установка из неизвестных источников» — пробуем снова
      if (this.waitingPermission) { this.waitingPermission = false; this.install().catch(() => {}); }
    });
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  set(patch) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) try { fn(this.state); } catch {}
  }

  async check() {
    this.set({ status: "checking", error: null });
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!res.ok) throw new Error(`GitHub ответил ${res.status}`);
      const list = await res.json();
      const rel = (Array.isArray(list) ? list : []).find((r) => /^android-v/.test(r.tag_name) && !r.draft && !r.prerelease);
      const version = rel ? rel.tag_name.replace(/^android-v/, "") : null;
      const apk = rel && (rel.assets || []).find((a) => a.name.endsWith(".apk"));
      if (version && apk && newer(version, this.current)) {
        this.set({ status: "available", version, url: apk.browser_download_url, size: apk.size, notes: rel.body || "" });
      } else {
        this.set({ status: "none" });
      }
    } catch (err) {
      console.warn("[update] проверка:", err.message);
      this.set({ status: "error", error: "Не удалось проверить обновления" });
    }
    return this.state;
  }

  async download() {
    const { url, version, size } = this.state;
    if (!url) return;
    this.set({ status: "downloading", percent: 0 });
    const name = `update-${version}.apk`;
    try {
      await Filesystem.deleteFile({ path: name, directory: Directory.Cache }).catch(() => {});
      const target = (await Filesystem.getUri({ path: name, directory: Directory.Cache })).uri;
      const handle = await FileTransfer.addListener("progress", (p) => {
        if (p.url !== url && !String(p.url).includes("github")) return;
        const total = p.lengthComputable && p.contentLength ? p.contentLength : size;
        if (total) this.set({ percent: Math.min(99, Math.floor((p.bytes / total) * 100)) });
      });
      try {
        await FileTransfer.downloadFile({ url, path: target, progress: true, connectTimeout: 30000, readTimeout: 60000 });
      } finally {
        handle.remove();
      }
      const st = await Filesystem.stat({ path: name, directory: Directory.Cache });
      if (size && st.size !== size) throw new Error("Файл скачался не полностью");
      this.apkPath = target;
      this.set({ status: "ready", percent: 100 });
      await this.install();
    } catch (err) {
      console.warn("[update] загрузка:", err.message || err);
      this.set({ status: "error", error: `Не удалось скачать обновление: ${err.message || err}` });
    }
  }

  async install() {
    if (!this.apkPath) return;
    try {
      await Device.installApk({ path: this.apkPath });
    } catch (err) {
      if (err && err.code === "NEED_PERMISSION") {
        // Android просит один раз разрешить установку из этого приложения
        this.waitingPermission = true;
        this.set({ status: "ready", needPermission: true });
        await Device.openInstallSettings();
        return;
      }
      this.set({ status: "error", error: err.message || String(err) });
    }
  }
}

export const createUpdater = (version) => new Updater(version);
