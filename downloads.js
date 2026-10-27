// Менеджер загрузок: скачивает серии в папку приложения, чтобы смотреть их без интернета.
// HLS-потоки (Kodik и др.) сохраняются как плейлист + куски видео, обычные файлы — целиком.
// Загрузки идут по одной; после перезапуска приложения недокачанное продолжается.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const SEGMENT_WORKERS = 4;
const RETRIES = 3;

const POSTER_EXTS = ["jpg", "png", "webp"];
// «…/720.mp4:hls:manifest.m3u8» → «…/720.mp4»
function directMp4(src) {
  const m = /^(.*\.mp4):hls:manifest\.m3u8(\?.*)?$/i.exec(String(src || ""));
  if (!m) return null;
  return (m[1].startsWith("//") ? `https:${m[1]}` : m[1]) + (m[2] || "");
}

const isHlsSource = (s) => /m3u8/i.test(s.src) || /mpegurl/i.test(s.type || "");

function requestHeaders(url) {
  const headers = { "User-Agent": USER_AGENT };
  if (new URL(url).hostname.includes("sibnet")) headers.Referer = "https://video.sibnet.ru/";
  return headers;
}

async function fetchOk(url, signal) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    signal.throwIfAborted();
    try {
      const res = await fetch(url, { headers: requestHeaders(url), signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      if (signal.aborted) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  throw lastErr;
}

// ---------- Разбор HLS-плейлистов ----------

function parseAttributes(line) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) attrs[m[1]] = m[3] !== undefined ? m[3] : m[2];
  return attrs;
}

// Если это мастер-плейлист с вариантами качества — берём вариант с наибольшим битрейтом
function pickVariant(text, baseUrl) {
  if (!/#EXT-X-STREAM-INF/i.test(text)) return null;
  const lines = text.split(/\r?\n/);
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    if (!/^#EXT-X-STREAM-INF/i.test(lines[i])) continue;
    const bw = Number(parseAttributes(lines[i]).BANDWIDTH) || 0;
    const uri = (lines.slice(i + 1).find((l) => l.trim() && !l.startsWith("#")) || "").trim();
    if (uri && (!best || bw > best.bw)) best = { bw, url: new URL(uri, baseUrl).href };
  }
  return best && best.url;
}

// Превращает плейлист в локальный: каждая ссылка заменяется именем файла на диске
function planMediaPlaylist(text, baseUrl) {
  const files = []; // { url, name }
  let seg = 0;
  let extra = 0;
  const out = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (/^#EXT-X-(KEY|MAP|SESSION-KEY)/i.test(line) && /URI="/i.test(line)) {
      out.push(line.replace(/URI="([^"]*)"/i, (_m, uri) => {
        const name = `extra${String(++extra).padStart(3, "0")}.bin`;
        files.push({ url: new URL(uri, baseUrl).href, name });
        return `URI="${name}"`;
      }));
      continue;
    }
    if (line.startsWith("#")) {
      out.push(line);
      continue;
    }
    const name = `s${String(++seg).padStart(5, "0")}.ts`;
    files.push({ url: new URL(line, baseUrl).href, name, segment: true });
    out.push(name);
  }

  if (!out.some((l) => /^#EXT-X-ENDLIST/i.test(l))) out.push("#EXT-X-ENDLIST");
  return { playlist: out.join("\n") + "\n", files };
}

// ---------- Менеджер ----------

class DownloadManager {
  constructor({ dir, resolveLinks, resolveSkips = null, onChange, isOnline = () => true }) {
    this.dir = dir;
    this.resolveSkips = resolveSkips; // (item) => {op, ed} | null — тайминги для офлайна
    this.isOnline = isOnline;
    this._waitTimer = null;
    this.indexFile = path.join(dir, "downloads.json");
    this.resolveLinks = resolveLinks; // (url) => [{ quality, sources:[{src,type}] }]
    this.onChange = onChange;
    this.items = [];
    this.active = null; // { id, controller }
    this._saveTimer = null;
    this._notifyTimer = null;
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    try {
      this.items = JSON.parse(await fsp.readFile(this.indexFile, "utf8"));
    } catch {
      this.items = [];
    }
    // прерванные при закрытии загрузки ставим обратно в очередь
    for (const it of this.items) if (it.status === "downloading") it.status = "queued";
    this._save(true);
    // постеры для загрузок, сделанных до появления этой функции
    const seen = new Set();
    for (const it of this.items) {
      if (seen.has(it.releaseId)) continue;
      seen.add(it.releaseId);
      this.savePoster(it.releaseId, it.poster).catch(() => {});
    }
    this._next();
  }

  list() {
    return this.items.map((it) => ({ ...it }));
  }

  get(id) {
    return this.items.find((it) => it.id === id) || null;
  }

  // ---------- постеры (чтобы страницы скачанных тайтлов открывались без интернета) ----------

  get postersDir() {
    return path.join(this.dir, "posters");
  }

  posterFile(releaseId) {
    if (!Number.isInteger(releaseId)) return null;
    for (const ext of POSTER_EXTS) {
      const p = path.join(this.postersDir, `${releaseId}.${ext}`);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  async savePoster(releaseId, url) {
    if (!url || !Number.isInteger(releaseId) || this.posterFile(releaseId)) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await fetchOk(url, ctrl.signal);
      const type = (res.headers.get("content-type") || "").toLowerCase();
      const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
      await fsp.mkdir(this.postersDir, { recursive: true });
      await fsp.writeFile(path.join(this.postersDir, `${releaseId}.${ext}`), Buffer.from(await res.arrayBuffer()));
    } finally {
      clearTimeout(timer);
    }
  }

  async _removePosterIfUnused(releaseId) {
    if (this.items.some((it) => it.releaseId === releaseId)) return;
    const p = this.posterFile(releaseId);
    if (p) await fsp.rm(p, { force: true });
  }

  // Готовая скачанная серия; предпочитаем ту же озвучку/источник
  findDone(releaseId, position, sourceId) {
    const done = this.items.filter((it) => it.releaseId === releaseId && it.position === position && it.status === "done");
    return done.find((it) => it.sourceId === sourceId) || done[0] || null;
  }

  filePath(id, name) {
    if (!/^[a-f0-9]{16}$/.test(id) || !/^[\w.-]+$/.test(name)) return null;
    return path.join(this.dir, id, name);
  }

  add(info) {
    const existing = this.items.find((it) =>
      it.releaseId === info.releaseId && it.sourceId === info.sourceId &&
      it.position === info.position && it.status !== "error" && it.status !== "canceled");
    if (existing) return existing.id;

    const item = {
      id: crypto.randomBytes(8).toString("hex"),
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
      kind: null, // "hls" | "file"
      skip: undefined, // тайминги OP/ED: {op, ed} | null (не нашлись) | undefined (ещё не искали)
      entry: null, // файл, с которого начинается просмотр
      status: "queued",
      progress: 0,
      bytes: 0,
      error: null,
      createdAt: Date.now(),
    };
    this.items.push(item);
    this.savePoster(item.releaseId, item.poster).catch((e) => console.warn("[downloads] постер не сохранён:", e.message));
    this._save();
    this._notify();
    this._next();
    return item.id;
  }

  retry(id) {
    const it = this.get(id);
    if (!it || (it.status !== "error" && it.status !== "canceled")) return false;
    Object.assign(it, { status: "queued", error: null });
    this._save();
    this._notify();
    this._next();
    return true;
  }

  cancel(id) {
    const it = this.get(id);
    if (!it) return false;
    if (this.active && this.active.id === id) this.active.controller.abort();
    if (it.status === "queued" || it.status === "downloading") it.status = "canceled";
    this._save();
    this._notify();
    return true;
  }

  async remove(id) {
    const it = this.get(id);
    this.cancel(id);
    this.items = this.items.filter((x) => x.id !== id);
    await fsp.rm(path.join(this.dir, id), { recursive: true, force: true });
    if (it) await this._removePosterIfUnused(it.releaseId);
    this._save();
    this._notify();
    return true;
  }

  // ---------- внутреннее ----------

  _next() {
    if (this.active) return;
    const it = this.items.find((x) => x.status === "queued");
    if (!it) return;
    // без интернета очередь ждёт, а не заваливается ошибками
    if (!this.isOnline()) {
      clearTimeout(this._waitTimer);
      this._waitTimer = setTimeout(() => this._next(), 10_000);
      return;
    }
    const controller = new AbortController();
    this.active = { id: it.id, controller };
    it.status = "downloading";
    it.error = null;
    this._notify();

    this._run(it, controller.signal)
      .then(() => {
        it.status = "done";
        it.progress = 1;
      })
      .catch((err) => {
        if (controller.signal.aborted) {
          if (it.status === "downloading") it.status = "canceled";
        } else if (!this.isOnline()) {
          it.status = "queued"; // пропал интернет — продолжим, когда появится
        } else {
          console.error("[download]", it.releaseTitle, it.name, err);
          it.status = "error";
          it.error = err.message || String(err);
        }
      })
      .finally(() => {
        this.active = null;
        this._save(true);
        this._notify(true);
        this._next();
      });
  }

  _pickQuality(qualities, want) {
    const num = (q) => parseInt(q.quality, 10) || 0;
    const wantN = parseInt(want, 10) || 720;
    return (
      qualities.find((q) => q.quality === want) ||
      qualities.filter((q) => num(q) && num(q) <= wantN).sort((a, b) => num(b) - num(a))[0] ||
      qualities.slice().sort((a, b) => num(a) - num(b))[0]
    );
  }

  async _run(it, signal) {
    const qualities = await this.resolveLinks(it.url);
    if (!qualities || !qualities.length) throw new Error("Не удалось получить ссылку на видео");
    const q = this._pickQuality(qualities, it.wantQuality);
    it.quality = q.quality;

    const dir = path.join(this.dir, it.id);
    await fsp.mkdir(dir, { recursive: true });

    let lastErr;
    let ok = false;
    for (const source of q.sources) {
      try {
        // У Kodik за HLS-ссылкой «…/720.mp4:hls:manifest.m3u8» обычно лежит цельный MP4 —
        // пробуем его: одна загрузка вместо сотен кусков и файл открывается любым плеером.
        const mp4 = directMp4(source.src);
        if (mp4) {
          try {
            await this._downloadFile(it, mp4, dir, signal, { requireVideo: true });
            ok = true;
            break;
          } catch (err) {
            if (signal.aborted) throw err;
            console.warn("[download] прямой MP4 не подошёл, качаю кусками:", err.message);
          }
        }
        if (isHlsSource(source)) await this._downloadHls(it, source.src, dir, signal);
        else await this._downloadFile(it, source.src, dir, signal);
        ok = true;
        break;
      } catch (err) {
        if (signal.aborted) throw err;
        lastErr = err;
      }
    }
    if (!ok) throw lastErr || new Error("Источник недоступен");

    // тайминги опенинга/эндинга сохраняем вместе с серией — чтобы пропуск работал без интернета
    if (this.resolveSkips && it.skip === undefined) {
      // undefined — спросить не получилось (спросим ещё раз при просмотре), null — таймингов нет
      it.skip = await this.resolveSkips(it).catch(() => undefined);
      if (it.skip === undefined) delete it.skip;
    }
  }

  // ---------- выгрузка серии одним файлом ----------

  // Путь к готовому видеофайлу или список кусков HLS
  async exportInfo(id) {
    const it = this.get(id);
    if (!it || it.status !== "done") throw new Error("Серия ещё не скачана");
    const dir = path.join(this.dir, it.id);
    if (it.kind === "file") return { it, file: path.join(dir, it.entry), ext: path.extname(it.entry).slice(1) || "mp4" };
    const names = (await fsp.readdir(dir)).sort();
    if (names.some((n) => n.startsWith("extra"))) {
      throw new Error("Эта серия скачана в зашифрованном виде — одним файлом её сохранить нельзя");
    }
    return { it, segments: names.filter((n) => /^s\d+\.ts$/.test(n)).map((n) => path.join(dir, n)), ext: "ts" };
  }

  // Копирует MP4 или склеивает куски HLS (MPEG-TS склеивается как есть) в один файл
  async exportTo(id, target) {
    const info = await this.exportInfo(id);
    if (info.file) {
      await fsp.copyFile(info.file, target);
      return target;
    }
    const out = fs.createWriteStream(target);
    try {
      for (const seg of info.segments) {
        await pipeline(fs.createReadStream(seg), out, { end: false });
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    return target;
  }

  async _downloadHls(it, url, dir, signal) {
    let text = await (await fetchOk(url, signal)).text();
    let base = url;
    const variant = pickVariant(text, base);
    if (variant) {
      base = variant;
      text = await (await fetchOk(variant, signal)).text();
    }
    const { playlist, files } = planMediaPlaylist(text, base);
    if (!files.some((f) => f.segment)) throw new Error("Пустой плейлист");

    it.kind = "hls";
    let done = 0;
    let queue = 0;

    const worker = async () => {
      while (queue < files.length) {
        const f = files[queue++];
        const target = path.join(dir, f.name);
        const stat = await fsp.stat(target).catch(() => null);
        if (!stat || stat.size === 0) {
          const buf = Buffer.from(await (await fetchOk(f.url, signal)).arrayBuffer());
          await fsp.writeFile(target + ".part", buf);
          await fsp.rename(target + ".part", target);
          it.bytes += buf.length;
        } else {
          it.bytes += stat.size; // докачка: кусок уже скачан раньше
        }
        done += 1;
        it.progress = done / files.length;
        this._notify();
      }
    };
    it.bytes = 0;
    await Promise.all(Array.from({ length: SEGMENT_WORKERS }, worker));

    await fsp.writeFile(path.join(dir, "index.m3u8"), playlist);
    it.entry = "index.m3u8";
  }

  async _downloadFile(it, url, dir, signal, { requireVideo = false } = {}) {
    const res = await fetchOk(url, signal);
    const type = (res.headers.get("content-type") || "").split(";")[0].trim();
    const total0 = Number(res.headers.get("content-length")) || 0;
    if (requireVideo && (/text|html|json|mpegurl/i.test(type) || (total0 && total0 < 1_000_000))) {
      await res.body?.cancel();
      throw new Error(`не видео (${type || "без типа"}, ${total0} байт)`);
    }
    const ext = type.includes("webm") ? "webm" : "mp4";
    const total = Number(res.headers.get("content-length")) || 0;
    const name = `video.${ext}`;
    const part = path.join(dir, name + ".part");

    it.kind = "file";
    it.bytes = 0;
    const counter = new (require("stream").Transform)({
      transform: (chunk, _enc, cb) => {
        it.bytes += chunk.length;
        if (total) it.progress = it.bytes / total;
        this._notify();
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(part), { signal });
    await fsp.rename(part, path.join(dir, name));
    it.entry = name;
  }

  _save(now = false) {
    clearTimeout(this._saveTimer);
    // записи идут строго по очереди, иначе две одновременные мешают друг другу
    const write = () => {
      this._writeChain = (this._writeChain || Promise.resolve()).then(async () => {
        const data = JSON.stringify(this.items, null, 1);
        await fsp.writeFile(this.indexFile + ".tmp", data);
        await fsp.rename(this.indexFile + ".tmp", this.indexFile);
      }).catch((e) => console.error("[downloads] не удалось сохранить список:", e.message));
    };
    if (now) write();
    else this._saveTimer = setTimeout(write, 1000);
  }

  // Интерфейс обновляем не чаще пары раз в секунду
  _notify(now = false) {
    if (now) {
      clearTimeout(this._notifyTimer);
      this._notifyTimer = null;
      this.onChange(this.list());
      return;
    }
    if (this._notifyTimer) return;
    this._notifyTimer = setTimeout(() => {
      this._notifyTimer = null;
      this.onChange(this.list());
    }, 400);
  }
}

// ---------- Раздача скачанного плееру ----------
// Обработчик для адресов anixdl://media/<id>/<файл>; поддерживает перемотку (Range) для mp4.

const MIME = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".bin": "application/octet-stream",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function createMediaHandler(manager) {
  return async function serve(request) {
    const url = new URL(request.url);
    const [id, name] = decodeURIComponent(url.pathname).split("/").filter(Boolean);
    let file = null;
    if (url.hostname === "media" && id && name) file = manager.filePath(id, name);
    else if (url.hostname === "poster" && /^\d+$/.test(id || "")) file = manager.posterFile(Number(id));
    const stat = file ? await fsp.stat(file).catch(() => null) : null;
    if (!stat || !stat.isFile()) return new Response("Not found", { status: 404 });

    const headers = {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Access-Control-Allow-Origin": "*",
      "Accept-Ranges": "bytes",
    };
    const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get("range") || "");
    if (range && (range[1] || range[2])) {
      let start;
      let end;
      if (range[1]) {
        start = Number(range[1]);
        end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      } else {
        // bytes=-500 — последние 500 байт
        start = Math.max(0, stat.size - Number(range[2]));
        end = stat.size - 1;
      }
      if (start > end || start >= stat.size) {
        return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${stat.size}` } });
      }
      return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
        status: 206,
        headers: { ...headers, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${stat.size}` },
      });
    }
    return new Response(Readable.toWeb(fs.createReadStream(file)), {
      status: 200,
      headers: { ...headers, "Content-Length": String(stat.size) },
    });
  };
}

module.exports = { DownloadManager, createMediaHandler, planMediaPlaylist, pickVariant, isHlsSource, directMp4 };
