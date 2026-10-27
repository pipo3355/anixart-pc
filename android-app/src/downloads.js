// Загрузки на телефон. HLS-потоки (Kodik и др.) сохраняются как плейлист + куски видео,
// обычные файлы — целиком. Файлы качает нативный код (FileTransfer), очередь — здесь.
// Загрузки идут по одной; недокачанное продолжается после перезапуска с того же места.

import { Capacitor } from "@capacitor/core";
import { Filesystem, Encoding } from "@capacitor/filesystem";
import { FileTransfer } from "@capacitor/file-transfer";
import { Network } from "@capacitor/network";
import { DATA, prefs, readJson, writeJson, exists, removePath, serial } from "./storage.js";
import { qualitiesFor } from "./links.js";
import { getSkipTimes } from "../../skiptimes.js";
import { Device, later, sleep } from "./device.js";

const ROOT = "downloads";
const INDEX = `${ROOT}/index.json`;
const POSTERS = "posters";
const WORKERS = 3; // кусков HLS одновременно
const RETRIES = 3;
const FILE_TIMEOUT_MS = 120_000;
const RESUME_RETRIES = 6; // попыток подряд без прогресса при докачке целого файла
const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36";

// «…/720.mp4:hls:manifest.m3u8» → «…/720.mp4»
export function directMp4(src) {
  const m = /^(.*\.mp4):hls:manifest\.m3u8(\?.*)?$/i.exec(String(src || ""));
  if (!m) return null;
  return (m[1].startsWith("//") ? `https:${m[1]}` : m[1]) + (m[2] || "");
}

export const isHls = (s) => /m3u8/i.test(s.src) || /mpegurl/i.test(s.type || "");

function headersFor(url) {
  const h = { "User-Agent": UA };
  try { if (new URL(url).hostname.includes("sibnet")) h.Referer = "https://video.sibnet.ru/"; } catch {}
  return h;
}

const delay = sleep; // работает и в свёрнутом приложении (см. device.js)
// обрыв соединения (а не «сервер отказал» или «не видео»)
const isNetworkError = (err) => !!err && (err.code === "NETWORK" || err instanceof TypeError
  || /network|timeout|timed out|connection|unreachable|reset|failed to fetch|обрыв|оборвал|не отвечает/i.test(String(err.message || "")));
const uriOf = async (path) => (await Filesystem.getUri({ path, directory: DATA })).uri;

// Идущие нативные загрузки по пути файла. Остановить нативную загрузку нельзя, поэтому
// повторная попытка или «продолжить» после паузы подхватывают уже идущую, а не запускают вторую
// в тот же файл (из-за двух параллельных загрузок полоска прыгала туда-сюда).
const activeTransfers = new Map();

function abortPromise(signal) {
  if (!signal) return null;
  return new Promise((_, reject) => {
    const fail = () => reject(new DOMException("Отменено", "AbortError"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

async function downloadTo(url, path, { progress = false, signal } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    if (signal && signal.aborted) throw new DOMException("Отменено", "AbortError");
    try {
      const target = await uriOf(path);
      let job = activeTransfers.get(path);
      if (!job) {
        job = FileTransfer.downloadFile({ url, path: target, headers: headersFor(url), progress, connectTimeout: 20000, readTimeout: 60000 })
          .finally(() => activeTransfers.delete(path));
        job.catch(() => {}); // если мы перестали ждать (пауза), ошибка не должна всплыть необработанной
        activeTransfers.set(path, job);
      }
      const races = [job];
      // Кусок видео — небольшой, общий лимит времени уместен. Целый MP4 может качаться долго:
      // зависание там ловит сам нативный readTimeout.
      if (!progress) races.push(delay(FILE_TIMEOUT_MS).then(() => { throw new Error("Сервер слишком долго не отвечает"); }));
      const abort = abortPromise(signal);
      if (abort) races.push(abort);
      await Promise.race(races);
      const st = await exists(path);
      if (!st || !st.size) throw new Error("Пустой файл");
      return st.size;
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      lastErr = err;
      console.warn(`[file] попытка ${attempt}/${RETRIES}:`, (err && (err.message || err.code)) || err, url.slice(0, 120));
      await delay(800 * attempt);
    }
  }
  throw new Error(`Не удалось скачать кусок видео: ${(lastErr && (lastErr.message || lastErr.code)) || lastErr}`);
}

async function fetchText(url) {
  const res = await fetch(url, { headers: headersFor(url) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { text: await res.text(), url: res.url || url };
}

// ---------- Плейлисты HLS ----------

function attrs(line) {
  const out = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
  return out;
}

function pickVariant(text, base) {
  if (!/#EXT-X-STREAM-INF/i.test(text)) return null;
  const lines = text.split(/\r?\n/);
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    if (!/^#EXT-X-STREAM-INF/i.test(lines[i])) continue;
    const bw = Number(attrs(lines[i]).BANDWIDTH) || 0;
    const uri = (lines.slice(i + 1).find((l) => l.trim() && !l.startsWith("#")) || "").trim();
    if (uri && (!best || bw > best.bw)) best = { bw, url: new URL(uri, base).href };
  }
  return best && best.url;
}

function planPlaylist(text, base) {
  const files = [];
  const out = [];
  let seg = 0;
  let extra = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#EXT-X-(KEY|MAP|SESSION-KEY)/i.test(line) && /URI="/i.test(line)) {
      out.push(line.replace(/URI="([^"]*)"/i, (_m, uri) => {
        const name = `extra${String(++extra).padStart(3, "0")}.bin`;
        files.push({ url: new URL(uri, base).href, name });
        return `URI="${name}"`;
      }));
    } else if (line.startsWith("#")) {
      out.push(line);
    } else {
      const name = `s${String(++seg).padStart(5, "0")}.ts`;
      files.push({ url: new URL(line, base).href, name, segment: true });
      out.push(name);
    }
  }
  if (!out.some((l) => /^#EXT-X-ENDLIST/i.test(l))) out.push("#EXT-X-ENDLIST");
  return { playlist: out.join("\n") + "\n", files };
}

// ---------- Менеджер ----------

function randomId() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

class Downloads {
  constructor() {
    this.items = [];
    this.active = null;
    this.listeners = new Set();
    this.save = serial();
    this.onlyWifi = false;
    this._notifyTimer = null;
    this._waitTimer = null;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  notify(now = false) {
    const fire = () => { this._notifyTimer = null; for (const fn of this.listeners) try { fn(this.list()); } catch {} };
    if (now) { if (this._notifyTimer) this._notifyTimer.cancel(); fire(); return; }
    if (!this._notifyTimer) this._notifyTimer = later(fire, 400);
  }

  persist() {
    return this.save(() => writeJson(INDEX, this.items));
  }

  async init() {
    this.items = (await readJson(INDEX, [])) || [];
    for (const it of this.items) if (it.status === "downloading") it.status = "queued";
    // До 0.5.2 сбой сети при поиске таймингов записывался как «таймингов нет» — один раз ищем заново
    if (!(await prefs.get("skipsRecheck2", false))) {
      for (const it of this.items) if (it.skip === null) delete it.skip;
      await prefs.set("skipsRecheck2", true);
    }
    await this.persist();
    Network.addListener("networkStatusChange", () => this.next());
    this.next();
  }

  list() { return this.items.map((it) => ({ ...it })); }
  get(id) { return this.items.find((it) => it.id === id) || null; }

  findFor(releaseId, position, sourceId) {
    const same = this.items.filter((d) => d.releaseId === releaseId && d.position === position);
    return same.find((d) => d.sourceId === sourceId) || same.find((d) => d.status === "done") || same[0] || null;
  }

  add(info) {
    const existing = this.findFor(info.releaseId, info.position, info.sourceId);
    if (existing && existing.sourceId === info.sourceId) {
      if (existing.status === "error" || existing.status === "canceled") this.retry(existing.id);
      return existing.id;
    }
    const item = {
      id: randomId(),
      releaseId: info.releaseId,
      releaseTitle: info.releaseTitle,
      releaseOriginal: info.releaseOriginal || "",
      releaseYear: info.releaseYear || null,
      poster: info.poster || null,
      dubberName: info.dubberName || "",
      sourceId: info.sourceId,
      position: info.position,
      name: info.name || `${info.position} серия`,
      url: info.url,
      wantQuality: String(info.quality || "720"),
      quality: null,
      kind: null,
      entry: null,
      skip: undefined, // тайминги OP/ED: {op, ed} | null | undefined (ещё не искали)
      status: "queued",
      progress: 0,
      bytes: 0,
      error: null,
      watched: Boolean(info.watched),
      createdAt: Date.now(),
    };
    this.items.push(item);
    this.savePoster(item.releaseId, item.poster).catch(() => {});
    this.persist();
    this.notify(true);
    this.next();
    return item.id;
  }

  retry(id) {
    const it = this.get(id);
    if (!it || (it.status !== "error" && it.status !== "canceled")) return;
    Object.assign(it, { status: "queued", error: null });
    this.persist();
    this.notify(true);
    this.next();
  }

  pause(id) {
    const it = this.get(id);
    if (!it) return;
    if (this.active && this.active.id === id) this.active.controller.abort();
    if (it.status === "queued" || it.status === "downloading") it.status = "canceled";
    this.persist();
    this.notify(true);
  }

  async remove(id) {
    const it = this.get(id);
    this.pause(id);
    this.items = this.items.filter((x) => x.id !== id);
    await removePath(`${ROOT}/${id}`);
    if (it && !this.items.some((x) => x.releaseId === it.releaseId)) await removePath(`${POSTERS}/${it.releaseId}.jpg`);
    await this.persist();
    this.notify(true);
  }

  setWatched(releaseId, position, watched) {
    let changed = false;
    for (const it of this.items) {
      if (it.releaseId === releaseId && it.position === position && it.watched !== watched) {
        it.watched = watched;
        changed = true;
      }
    }
    if (changed) { this.persist(); this.notify(); }
  }

  // ---------- воспроизведение и постеры ----------

  async playUrl(it) {
    return Capacitor.convertFileSrc(await uriOf(`${ROOT}/${it.id}/${it.entry}`));
  }

  async posterUrl(releaseId) {
    const path = `${POSTERS}/${releaseId}.jpg`;
    if (!(await exists(path))) return null;
    return Capacitor.convertFileSrc(await uriOf(path));
  }

  async savePoster(releaseId, url) {
    if (!url) return;
    const path = `${POSTERS}/${releaseId}.jpg`;
    if (await exists(path)) return;
    await Filesystem.mkdir({ path: POSTERS, directory: DATA, recursive: true }).catch(() => {});
    await downloadTo(url, path);
  }

  // ---------- очередь ----------

  async canDownloadNow() {
    try {
      const s = await Network.getStatus();
      if (!s.connected) return false;
      if (this.onlyWifi && s.connectionType !== "wifi") return false;
      return true;
    } catch {
      return true;
    }
  }

  async next() {
    if (this.active) return;
    const it = this.items.find((x) => x.status === "queued");
    if (!it) { if (this.waiting) { this.waiting = false; this.notify(true); } return; }
    if (!(await this.canDownloadNow())) {
      if (!this.waiting) { this.waiting = true; this.notify(true); }
      if (this._waitTimer) this._waitTimer.cancel();
      this._waitTimer = later(() => this.next(), 15_000);
      return;
    }
    if (this.active) return;
    let retryIn = 50;
    this.waiting = false;
    const controller = new AbortController();
    this.active = { id: it.id, controller };
    it.status = "downloading";
    it.error = null;
    this.notify(true);
    try {
      await this.run(it, controller.signal);
      it.status = "done";
      it.progress = 1;
    } catch (err) {
      if (controller.signal.aborted) {
        if (it.status === "downloading") it.status = "canceled";
      } else if (!(await this.canDownloadNow()) || isNetworkError(err)) {
        // пропала или сменилась сеть — продолжим с того же места чуть позже
        it.status = "queued";
        retryIn = 15_000;
      } else {
        console.error("[download]", it.releaseTitle, it.name, err);
        it.status = "error";
        it.error = (err && err.message) || String(err);
      }
    } finally {
      this.active = null;
      this.waiting = retryIn > 50;
      await this.persist();
      this.notify(true);
      if (this._waitTimer) this._waitTimer.cancel();
      // таймер с нативной подстраховкой: следующая серия начнётся и в свёрнутом приложении
      this._waitTimer = later(() => this.next(), retryIn);
    }
  }

  pickQuality(qualities, want) {
    const num = (q) => parseInt(q.quality, 10) || 0;
    const w = parseInt(want, 10) || 720;
    return qualities.find((q) => q.quality === want)
      || qualities.filter((q) => num(q) && num(q) <= w).sort((a, b) => num(b) - num(a))[0]
      || qualities.slice().sort((a, b) => num(a) - num(b))[0];
  }

  async run(it, signal) {
    console.log(`[download] ${it.releaseTitle} — ${it.name}: ищу ссылку`);
    // тайминги ищем сразу, параллельно с загрузкой — они готовы раньше самой серии
    const skipJob = this.needsSkips(it) ? this.fetchSkips(it).catch(() => {}) : null;
    const qualities = await qualitiesFor(it.url);
    const q = this.pickQuality(qualities, it.wantQuality);
    it.quality = q.quality;
    const dir = `${ROOT}/${it.id}`;
    await Filesystem.mkdir({ path: dir, directory: DATA, recursive: true }).catch(() => {});
    let lastErr;
    let ok = false;
    for (const source of q.sources) {
      try {
        // У Kodik за «…/720.mp4:hls:manifest.m3u8» обычно лежит цельный MP4 — один файл вместо сотен кусков
        const mp4 = directMp4(source.src);
        if (mp4) {
          try {
            await this.runFile(it, mp4, dir, signal, { requireVideo: true });
            ok = true;
            break;
          } catch (err) {
            if (signal.aborted) throw err;
            // обрыв сети — не повод переходить на куски: недокачанный MP4 оставляем и продолжим его позже
            if (!(err && err.notVideo)) throw err;
            console.warn("[download] прямой MP4 не подошёл, качаю кусками:", err && err.message);
            it.fileTotal = 0;
            await Filesystem.deleteFile({ path: `${dir}/video.mp4`, directory: DATA }).catch(() => {});
          }
        }
        if (isHls(source)) await this.runHls(it, source.src, dir, signal);
        else await this.runFile(it, source.src, dir, signal);
        ok = true;
        break;
      } catch (err) {
        if (signal.aborted) throw err;
        console.warn(`[download] зеркало не подошло (${q.quality}):`, err && err.message, source.src);
        lastErr = err;
      }
    }
    if (!ok) throw lastErr || new Error("Источник недоступен");
    if (skipJob) await skipJob;
    if (it.skip === undefined) await this.fetchSkips(it); // первая попытка не удалась — ещё раз
  }

  // Тайминги опенинга/эндинга — сохраняем вместе с серией, чтобы пропуск работал офлайн
  // Нужно ли искать тайминги: ещё не искали или не нашли давно (могли быть без сети)
  needsSkips(it) {
    if (it.skip === undefined) return true;
    return it.skip === null && Date.now() - (it.skipCheckedAt || 0) > 3 * 24 * 3600e3;
  }

  async fetchSkips(it) {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return it.skip;
    try {
      const found = await getSkipTimes(
        { id: it.releaseId, titleOriginal: it.releaseOriginal, titleRu: it.releaseTitle, year: it.releaseYear },
        { position: it.position, url: it.url },
      );
      it.skip = found ? { op: found.op, ed: found.ed } : null;
      it.skipCheckedAt = Date.now(); // «не нашли» перепроверим через несколько дней
      if (found) console.log(`[skip] ${it.releaseTitle} #${it.position}: ${found.source}`);
    } catch (err) {
      // не смогли спросить (сеть, ограничение запросов) — не запоминаем «нет», спросим ещё раз позже
      console.warn(`[skip] ${it.releaseTitle} #${it.position}: не удалось получить тайминги —`, err && err.message);
      it.skip = undefined;
    }
    this.persist();
    return it.skip;
  }

  async runHls(it, url, dir, signal) {
    let { text, url: base } = await fetchText(url);
    const variant = pickVariant(text, base);
    if (variant) ({ text, url: base } = await fetchText(variant));
    const { playlist, files } = planPlaylist(text, base);
    if (!files.some((f) => f.segment)) throw new Error("Пустой плейлист");
    console.log(`[download] плейлист: ${files.length} файлов`);
    it.kind = "hls";
    it.bytes = 0;
    let done = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < files.length) {
        if (signal.aborted) throw new DOMException("Отменено", "AbortError");
        const f = files[cursor++];
        const path = `${dir}/${f.name}`;
        const st = await exists(path);
        it.bytes += st && st.size ? st.size : await downloadTo(f.url, path, { signal });
        done += 1;
        it.progress = done / files.length;
        this.notify();
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, worker));
    await Filesystem.writeFile({ path: `${dir}/index.m3u8`, directory: DATA, data: playlist, encoding: Encoding.UTF8 });
    it.entry = "index.m3u8";
  }

  async runFile(it, url, dir, signal, { requireVideo = false } = {}) {
    if (requireVideo) {
      // проверяем, что по ссылке действительно видео, а не страница с ошибкой
      const res = await fetch(url, { method: "HEAD", headers: headersFor(url) });
      const type = res.headers.get("content-type") || "";
      const len = Number(res.headers.get("content-length")) || 0;
      if (!res.ok || /text|html|json|mpegurl/i.test(type) || (len && len < 1_000_000)) {
        const err = new Error(`не видео (HTTP ${res.status}, ${type || "без типа"}, ${len} байт)`);
        err.notVideo = true;
        throw err;
      }
    }
    it.kind = "file";
    const path = `${dir}/video.mp4`;
    if (Capacitor.isNativePlatform()) return this.runFileResumable(it, url, path, signal);
    const handle = await FileTransfer.addListener("progress", (p) => {
      if (p.url !== url) return;
      it.bytes = p.bytes;
      if (p.lengthComputable && p.contentLength) it.progress = Math.max(it.progress || 0, p.bytes / p.contentLength);
      this.notify();
    });
    try {
      // на паузе нативная загрузка продолжается в фоне; «продолжить» подхватит её (см. downloadTo)
      it.bytes = await downloadTo(url, path, { progress: true, signal });
    } finally {
      handle.remove();
    }
    it.entry = "video.mp4";
  }

  // Целый файл с докачкой (нативный ResumableDownloader): обрыв сети, смена Wi-Fi на мобильный,
  // пауза — продолжаем с того же места, а не с нуля.
  async runFileResumable(it, url, path, signal) {
    const target = await uriOf(path);
    const handle = await Device.addListener("downloadProgress", (p) => {
      if (p.id !== it.id) return;
      it.bytes = p.bytes;
      if (p.total > 0) { it.fileTotal = p.total; it.progress = p.bytes / p.total; }
      this.notify();
    });
    const onAbort = () => Device.cancelDownload({ id: it.id }).catch(() => {});
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      let fails = 0;
      for (;;) {
        if (signal.aborted) throw new DOMException("Отменено", "AbortError");
        const before = it.bytes || 0;
        try {
          const r = await Device.downloadFile({ id: it.id, url, path: target, headers: headersFor(url), expectTotal: it.fileTotal || 0 });
          it.bytes = r.size;
          it.fileTotal = r.total;
          break;
        } catch (err) {
          if (signal.aborted || (err && err.code === "CANCELED")) throw new DOMException("Отменено", "AbortError");
          if (err && err.code === "HTTP") { const e = new Error(err.message); e.notVideo = !(it.bytes > 0); throw e; }
          // сеть: если что-то успело скачаться — попытка не считается неудачной
          fails = (it.bytes || 0) > before ? 0 : fails + 1;
          console.warn(`[file] обрыв (${fails}/${RESUME_RETRIES}), продолжу с ${Math.round((it.bytes || 0) / 1e6)} МБ:`, err && err.message);
          if (fails >= RESUME_RETRIES) throw err;
          this.persist();
          await delay(2000 * fails);
        }
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      handle.remove();
    }
    it.entry = "video.mp4";
  }
}

export const downloads = new Downloads();
