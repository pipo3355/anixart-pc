// Главный процесс: держит клиент Anixart, хранит токен, прогресс просмотра и загрузки,
// открывает окна плеера. Все сетевые запросы идут отсюда (Node), поэтому нет проблем с CORS.

const {
  app, BrowserWindow, ipcMain, safeStorage, shell, protocol, net, nativeTheme, dialog,
  session: electronSession,
} = require("electron");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const {
  Anixart, AnixartError, HttpError, BookmarkSortType,
  KodikParser, SibnetParser, RutubeParser, VKVideoParser, OKParser, AniLibriaParser,
} = require("anixartjs");
const { DownloadManager, createMediaHandler } = require("./downloads");
const { getSkipTimes } = require("./skiptimes");

// electron-updater есть только в собранном приложении с установленными зависимостями;
// при запуске из исходников без него приложение тоже работает
let autoUpdater = null;
try { ({ autoUpdater } = require("electron-updater")); } catch {}

const REPO_URL = "https://github.com/pipo3355/anixart-pc";

const client = new Anixart({});
const REQ = { timeoutMs: 20_000 };
const PARSE = { timeoutMs: 45_000 }; // цепочка из 2–3 запросов на медленной сети
const PLAYER_PARTITION = "persist:player";
const MEDIA_SCHEME = "anixdl"; // anixdl://media/<id>/<файл> — скачанные серии
// Так приложение Anixart встраивает плееры; часть источников без этого отдаёт заглушку
const EMBED_REFERRER = "https://anixart.tv/";
const WATCHED_AT = 0.85; // серия считается просмотренной после 85%

// Схему для скачанных файлов нужно объявить до готовности приложения
protocol.registerSchemesAsPrivileged([{
  scheme: MEDIA_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

const APP_ICON = path.join(__dirname, "build", "icon.png");

let mainWindow = null;
let downloads = null;

function sendToMain(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---------- Сессия (токен хранится зашифрованным средствами ОС) ----------

let session = { token: null, profileId: null, login: null };
const sessionFile = () => path.join(app.getPath("userData"), "session.bin");

// В новых Electron синхронное шифрование помечено устаревшим — используем асинхронное,
// а если его нет (старая версия), откатываемся на прежнее.
const hasAsyncCrypto = typeof safeStorage.encryptStringAsync === "function";

async function cryptoAvailable() {
  try {
    return hasAsyncCrypto
      ? Boolean(await safeStorage.isAsyncEncryptionAvailable())
      : safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

async function encrypt(text) {
  return hasAsyncCrypto ? safeStorage.encryptStringAsync(text) : safeStorage.encryptString(text);
}

async function decrypt(buf) {
  if (!hasAsyncCrypto) return safeStorage.decryptString(buf);
  const res = await safeStorage.decryptStringAsync(buf);
  return typeof res === "string" ? res : res.result;
}

async function saveSession() {
  const json = JSON.stringify(session);
  const data = (await cryptoAvailable()) ? await encrypt(json) : Buffer.from(json, "utf8");
  fs.writeFileSync(sessionFile(), data);
}

async function loadSession() {
  try {
    const buf = fs.readFileSync(sessionFile());
    const json = (await cryptoAvailable()) ? await decrypt(buf) : buf.toString("utf8");
    session = { ...session, ...JSON.parse(json) };
    if (session.token) client.setToken(session.token);
  } catch {
    // файла ещё нет или он не расшифровался — просто начинаем без входа
  }
}

function clearSession() {
  session = { token: null, profileId: null, login: null };
  client.setToken(undefined);
  try { fs.unlinkSync(sessionFile()); } catch {}
}

// ---------- Настройки ----------

const DEFAULT_SETTINGS = {
  theme: "dark", // "dark" | "light" | "system"
  accent: "#3b82f6",
  seekStep: 10, // стрелки ← → в плеере, секунд
  skipOpening: 85, // Shift+→ и кнопка «Пропустить опенинг», если точных таймингов нет, секунд
  skipMode: "button", // OP/ED: "auto" — пропускать сразу, "button" — показывать кнопку, "off"
};
let settings = { ...DEFAULT_SETTINGS };
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// Проверяет значения, чтобы в файл не попало ничего странного
function sanitizeSettings(input) {
  const out = { ...settings };
  if (["dark", "light", "system"].includes(input.theme)) out.theme = input.theme;
  if (typeof input.accent === "string" && /^#[0-9a-f]{6}$/i.test(input.accent)) out.accent = input.accent;
  if ("seekStep" in input) out.seekStep = clampInt(input.seekStep, 1, 120, out.seekStep);
  if ("skipOpening" in input) out.skipOpening = clampInt(input.skipOpening, 1, 600, out.skipOpening);
  if (["auto", "button", "off"].includes(input.skipMode)) out.skipMode = input.skipMode;
  return out;
}

function loadSettings() {
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) };
    settings = sanitizeSettings(settings);
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  nativeTheme.themeSource = settings.theme;
}

// Новые настройки сразу применяются во всех открытых окнах, включая плееры
function broadcastSettings() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("settings:changed", settings);
  }
}

// ---------- Прогресс просмотра (локально, на этом компьютере) ----------
// { "<releaseId>:<position>": { t: секунды, d: длительность, at: время } }

let progress = {};
let progressTimer = null;
const progressFile = () => path.join(app.getPath("userData"), "progress.json");

function loadProgress() {
  try { progress = JSON.parse(fs.readFileSync(progressFile(), "utf8")); } catch { progress = {}; }
}

function saveProgressSoon() {
  clearTimeout(progressTimer);
  progressTimer = setTimeout(() => {
    fsp.writeFile(progressFile(), JSON.stringify(progress)).catch(() => {});
  }, 1500);
}

function progressFor(releaseId) {
  const out = {};
  for (const [key, val] of Object.entries(progress)) {
    const [rid, pos] = key.split(":");
    if (Number(rid) === releaseId) out[pos] = val;
  }
  return out;
}

// ---------- Ошибки ----------

const SIGNIN_ERRORS = { 2: "Неверный логин", 3: "Неверный пароль" };

function describeError(err, where) {
  if (err instanceof AnixartError) {
    if (where === "signIn" && SIGNIN_ERRORS[err.code]) return SIGNIN_ERRORS[err.code];
    return `Anixart вернул ошибку: ${err.codeName || err.code}`;
  }
  if (err instanceof HttpError) {
    if (err.status === 401 || err.status === 403) return "Сессия истекла, войдите заново";
    return `Ошибка сети (HTTP ${err.status})`;
  }
  if (err && err.name === "TimeoutError") return "Сервер не ответил вовремя";
  return (err && err.message) || String(err);
}

// ---------- Офлайн-кэш ответов API ----------
// Всё, что приложение получило от Anixart (страницы тайтлов, серии, списки, расписание),
// сохраняется на диск. Без сети показываем сохранённую версию.

const CACHE_MAX_AGE = 60 * 24 * 3600 * 1000; // неиспользуемый кэш удаляем через 60 дней
const cacheDir = () => path.join(app.getPath("userData"), "cache");
const cacheFile = (channel, args) =>
  path.join(cacheDir(), require("crypto").createHash("sha1").update(channel + JSON.stringify(args)).digest("hex") + ".json");

function writeCache(channel, args, data) {
  fsp.mkdir(cacheDir(), { recursive: true })
    .then(() => fsp.writeFile(cacheFile(channel, args), JSON.stringify(data)))
    .catch(() => {});
}

async function readCache(channel, args) {
  try {
    const file = cacheFile(channel, args);
    const data = JSON.parse(await fsp.readFile(file, "utf8"));
    fsp.utimes(file, new Date(), new Date()).catch(() => {}); // отметка «использовался недавно»
    return data;
  } catch {
    return undefined;
  }
}

async function pruneCache() {
  const files = await fsp.readdir(cacheDir()).catch(() => []);
  const now = Date.now();
  for (const f of files) {
    const p = path.join(cacheDir(), f);
    const st = await fsp.stat(p).catch(() => null);
    if (st && now - st.mtimeMs > CACHE_MAX_AGE) await fsp.rm(p, { force: true });
  }
}

// Ошибка сети (нет интернета, сервер недоступен) — в отличие от ответа «нельзя» от Anixart
function isNetworkError(err) {
  if (err instanceof AnixartError || err instanceof LoginRequiredError) return false;
  if (err instanceof HttpError) return err.status >= 500;
  return true;
}

// Без сети картинки из интернета не загрузятся — подменяем постеры скачанных тайтлов локальными
function localizePosters(data) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      if (typeof out.id === "number" && typeof out.image === "string" && downloads && downloads.posterFile(out.id)) {
        out.image = `${MEDIA_SCHEME}://poster/${out.id}`;
      }
      return out;
    }
    return v;
  };
  return walk(data);
}

let lastOfflineNotice = 0;
function notifyOffline() {
  if (Date.now() - lastOfflineNotice < 30_000) return;
  lastOfflineNotice = Date.now();
  sendToMain("net:offline");
}

// Обёртка: каждый обработчик возвращает { ok, data } или { ok:false, error }.
// cache: true — ответ сохраняется и отдаётся из кэша, если нет сети.
const CACHE_WAIT_MS = 3000; // сколько ждём сервер, прежде чем показать сохранённую копию
const OFFLINE_HOLD_MS = 30_000; // после сбоя сети какое-то время сразу берём сохранённое
let offlineUntil = 0;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const looksOffline = () => !net.isOnline() || Date.now() < offlineUntil;

function fromCache(cached) {
  notifyOffline();
  return { ok: true, data: localizePosters(cached), offline: true };
}

// Обёртка: каждый обработчик возвращает { ok, data } или { ok:false, error }.
// cache: true — ответ сохраняется на диск. Если сервер молчит дольше 3 секунд
// или не отвечает вовсе, показываем сохранённую копию, а запрос продолжается в фоне
// и обновит копию, когда (если) ответ придёт.
function handle(channel, fn, { withSender = false, cache = false } = {}) {
  ipcMain.handle(channel, async (event, ...args) => {
    const run = () => (withSender ? fn(event.sender, ...args) : fn(...args));
    const fail = (err) => {
      console.error(`[${channel}]`, err);
      return { ok: false, error: describeError(err, channel.split(":")[1]) };
    };

    if (!cache) {
      try { return { ok: true, data: await run() }; } catch (err) { return fail(err); }
    }

    const cachedPromise = readCache(channel, args);
    const request = Promise.resolve().then(run).then(
      (data) => {
        offlineUntil = 0;
        writeCache(channel, args, data);
        if (pendingMarks.length) flushPendingMarks().catch(() => {});
        return { ok: true, data };
      },
      (err) => ({ ok: false, err }),
    );

    // похоже, сети нет — не ждём вовсе, если есть копия
    if (looksOffline()) {
      const cached = await cachedPromise;
      if (cached !== undefined) {
        request.catch(() => {});
        return fromCache(cached);
      }
    }

    const first = await Promise.race([request, delay(CACHE_WAIT_MS).then(() => null)]);
    if (first === null) {
      // сервер молчит — отдаём копию, если она есть
      const cached = await cachedPromise;
      if (cached !== undefined) {
        console.warn(`[${channel}] сервер не отвечает, показана сохранённая версия`);
        offlineUntil = Date.now() + OFFLINE_HOLD_MS;
        return fromCache(cached);
      }
    }

    const res = first || (await request);
    if (res.ok) return res;
    if (isNetworkError(res.err)) {
      offlineUntil = Date.now() + OFFLINE_HOLD_MS;
      const cached = await cachedPromise;
      if (cached !== undefined) return fromCache(cached);
      return { ok: false, error: "Нет соединения с Anixart, а сохранённой версии этой страницы нет. Откройте её хотя бы раз с интернетом." };
    }
    return fail(res.err);
  });
}

const handleCached = (channel, fn) => handle(channel, fn, { cache: true });

// Для вызовов из окна плеера: первым аргументом приходит само окно
const handlePlayer = (channel, fn) => handle(channel, fn, { withSender: true });

class LoginRequiredError extends Error {}

function requireLogin() {
  if (!session.token) throw new LoginRequiredError("Нужно войти в аккаунт Anixart");
}

const page = (res) => ({
  items: res.content || [],
  page: res.current_page ?? 0,
  totalPages: res.total_page_count ?? 1,
});

// ---------- API для интерфейса ----------

handle("session:get", async () => ({
  loggedIn: Boolean(session.token),
  login: session.login,
  profileId: session.profileId,
}));

handle("auth:signIn", async (login, password) => {
  const res = await client.endpoints.auth.signIn({ login, password }, REQ);
  const token = res.profileToken && res.profileToken.token;
  if (!token) throw new Error("Сервер не вернул токен");
  session = { token, profileId: res.profile.id, login: res.profile.login };
  client.setToken(token);
  await saveSession();
  return { login: session.login, profileId: session.profileId };
});

handle("auth:signOut", async () => {
  clearSession();
  pendingMarks = []; // очередь относится к вышедшему аккаунту
  savePendingMarks();
  // в кэше личные списки аккаунта — после выхода они не должны показываться
  await fsp.rm(cacheDir(), { recursive: true, force: true }).catch(() => {});
  return true;
});

handleCached("search:releases", async (query, pageNum = 0) => {
  const res = await client.endpoints.search.releases({ query, searchBy: 0 }, pageNum, REQ);
  // API v2 отдаёт { releases }, старый формат — { content, total_page_count }
  if (Array.isArray(res.releases)) {
    return { items: res.releases, page: pageNum, totalPages: res.releases.length ? pageNum + 2 : pageNum + 1 };
  }
  return page(res);
});

handleCached("release:get", async (id) => (await client.endpoints.release.get(id, true, REQ)).release);

handleCached("list:get", async (status, pageNum = 0) => {
  requireLogin();
  return page(await client.endpoints.profileList.get(status, pageNum, BookmarkSortType.NewToOldAddTime, 0, REQ));
});

handleCached("favorites:get", async (pageNum = 0) => {
  requireLogin();
  return page(await client.endpoints.favorite.all(BookmarkSortType.NewToOldAddTime, 0, pageNum, REQ));
});

handleCached("history:get", async (pageNum = 0) => {
  requireLogin();
  return page(await client.endpoints.history.get(pageNum, REQ));
});

handleCached("schedule:get", async () => {
  const res = await client.endpoints.schedule.get(REQ);
  const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  return Object.fromEntries(days.map((d) => [d, res[d] || []]));
});

// Новые серии в тайтлах, на которые подписан аккаунт
handleCached("updates:get", async (pageNum = 0) => {
  requireLogin();
  return page(await client.endpoints.notification.episodes(pageNum, REQ));
});

// newStatus: 0 — убрать из списков, 1..5 — BookmarkType
handle("list:set", async (releaseId, newStatus, oldStatus) => {
  requireLogin();
  if (newStatus > 0) await client.endpoints.profileList.add(releaseId, newStatus, REQ);
  else if (oldStatus > 0) await client.endpoints.profileList.delete(releaseId, oldStatus, REQ);
  return newStatus;
});

handle("favorite:set", async (releaseId, value) => {
  requireLogin();
  if (value) await client.endpoints.favorite.add(releaseId, REQ);
  else await client.endpoints.favorite.delete(releaseId, REQ);
  return value;
});

handleCached("episode:types", async (releaseId) =>
  (await client.endpoints.episode.types(releaseId, REQ)).types || []);

handleCached("episode:sources", async (releaseId, dubberId) =>
  (await client.endpoints.episode.sources(releaseId, dubberId, REQ)).sources || []);

handleCached("episode:list", async (releaseId, dubberId, sourceId) =>
  (await client.endpoints.episode.episodes(releaseId, dubberId, sourceId, 0, REQ)).episodes || []);

// Отметка серии — так прогресс появляется и в приложении на телефоне
// ---------- Отметки «просмотрено» с очередью ----------
// Если отметить серию без интернета, отметка сохраняется в pending-marks.json
// и уходит в аккаунт, как только сеть появится. Для одной серии действует последнее действие.

let pendingMarks = [];
let flushing = false;
const pendingFile = () => path.join(app.getPath("userData"), "pending-marks.json");

function loadPendingMarks() {
  try { pendingMarks = JSON.parse(fs.readFileSync(pendingFile(), "utf8")); } catch { pendingMarks = []; }
}

// Записи идут по очереди и через временный файл — иначе быстрые подряд записи портят файл
let pendingWriteChain = Promise.resolve();
function savePendingMarks() {
  pendingWriteChain = pendingWriteChain.then(async () => {
    const tmp = pendingFile() + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(pendingMarks));
    await fsp.rename(tmp, pendingFile());
  }).catch((e) => console.warn("[marks] не удалось сохранить очередь:", e.message));
  return pendingWriteChain;
}

async function sendMark({ releaseId, sourceId, position, watched }) {
  if (watched) {
    await client.endpoints.episode.watch(releaseId, sourceId, position, REQ);
    await client.endpoints.history.add(releaseId, sourceId, position, REQ);
  } else {
    await client.endpoints.episode.unwatch(releaseId, sourceId, position, REQ);
  }
}

function enqueueMark(mark) {
  pendingMarks = pendingMarks.filter((m) => !(m.releaseId === mark.releaseId && m.position === mark.position));
  pendingMarks.push({ ...mark, at: Date.now() });
  savePendingMarks();
}

// Ставит отметку; без сети — кладёт в очередь. Возвращает { queued }.
async function setWatched(releaseId, sourceId, position, watched) {
  const mark = { releaseId, sourceId, position, watched };
  // если по этой серии уже ждёт отметка, новая встаёт после неё, а не обгоняет
  const waiting = pendingMarks.some((m) => m.releaseId === releaseId && m.position === position);
  let queued = false;
  if (waiting || looksOffline()) {
    enqueueMark(mark);
    queued = true;
  } else {
    try {
      await sendMark(mark);
    } catch (err) {
      if (!isNetworkError(err)) throw err;
      offlineUntil = Date.now() + OFFLINE_HOLD_MS;
      enqueueMark(mark);
      queued = true;
    }
  }
  sendToMain("episode:watched", { releaseId, position, watched, queued });
  if (queued) console.log(`[marks] нет сети, отметка серии ${position} отложена (в очереди: ${pendingMarks.length})`);
  return { queued };
}

// Отправляет накопленные отметки по одной; при сбое сети останавливается до следующей попытки
async function flushPendingMarks() {
  if (flushing || !pendingMarks.length || !session.token || !net.isOnline()) return;
  flushing = true;
  let sent = 0;
  try {
    while (pendingMarks.length) {
      const mark = pendingMarks[0];
      try {
        await sendMark(mark);
        sent += 1;
      } catch (err) {
        if (isNetworkError(err)) break; // сети всё ещё нет — попробуем позже
        console.warn("[marks] отметка отклонена сервером и удалена из очереди:", describeError(err));
      }
      pendingMarks.shift();
      savePendingMarks();
    }
  } finally {
    flushing = false;
  }
  if (sent) {
    offlineUntil = 0;
    console.log(`[marks] отправлено отложенных отметок: ${sent}`);
    sendToMain("marks:synced", { count: sent, left: pendingMarks.length });
  }
}

async function markWatched(releaseId, sourceId, position) {
  return setWatched(releaseId, sourceId, position, true);
}

handle("episode:watch", async (releaseId, sourceId, position) => {
  requireLogin();
  return setWatched(releaseId, sourceId, position, true);
});

handle("episode:unwatch", async (releaseId, sourceId, position) => {
  requireLogin();
  return setWatched(releaseId, sourceId, position, false);
});

handle("marks:pending", async () => pendingMarks.length);

// ---------- О программе, обновления, обратная связь ----------

let updateState = { status: "idle" }; // idle | checking | available | downloading | ready | none | error | dev

function setUpdateState(next) {
  updateState = { ...updateState, ...next };
  sendToMain("update:status", updateState);
}

function setupUpdater() {
  if (!autoUpdater || !app.isPackaged) {
    updateState = { status: "dev" }; // из исходников (npm start) обновления не проверяем
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // если не перезапустить сразу — поставится при выходе
  autoUpdater.on("checking-for-update", () => setUpdateState({ status: "checking", error: null }));
  autoUpdater.on("update-available", (info) => setUpdateState({ status: "downloading", version: info.version, percent: 0 }));
  autoUpdater.on("update-not-available", () => setUpdateState({ status: "none" }));
  autoUpdater.on("download-progress", (p) => setUpdateState({ status: "downloading", percent: Math.floor(p.percent || 0) }));
  autoUpdater.on("update-downloaded", (info) => setUpdateState({ status: "ready", version: info.version }));
  autoUpdater.on("error", (err) => {
    console.warn("[update]", err && err.message);
    setUpdateState({ status: "error", error: "Не удалось проверить обновления" });
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 8000); // после запуска, чтобы не мешать загрузке
  setInterval(check, 6 * 3600 * 1000); // и раз в 6 часов
}

handle("app:info", async () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  os: `${process.platform} ${require("os").release()}`,
  repo: REPO_URL,
  update: updateState,
}));

handle("update:check", async () => {
  if (updateState.status === "dev") throw new Error("Обновления проверяются только в установленной версии");
  await autoUpdater.checkForUpdates();
  return true;
});

handle("update:install", async () => {
  if (updateState.status !== "ready") throw new Error("Обновление ещё не скачано");
  setImmediate(() => autoUpdater.quitAndInstall(false, true)); // тихо поставить и сразу запустить
  return true;
});

// Открывает форму нового отзыва на GitHub с уже заполненной версией и системой
handle("feedback:open", async (kind) => {
  const template = kind === "idea" ? "idea.yml" : "bug.yml";
  const url = new URL(`${REPO_URL}/issues/new`);
  url.searchParams.set("template", template);
  url.searchParams.set("version", app.getVersion());
  url.searchParams.set("os", `Windows ${require("os").release()}`);
  await shell.openExternal(url.toString());
  return true;
});

handle("settings:get", async () => settings);

handle("settings:set", async (patch) => {
  settings = sanitizeSettings(patch || {});
  nativeTheme.themeSource = settings.theme;
  await fsp.writeFile(settingsFile(), JSON.stringify(settings, null, 2));
  broadcastSettings();
  return settings;
});

handle("settings:reset", async () => {
  settings = { ...DEFAULT_SETTINGS };
  nativeTheme.themeSource = settings.theme;
  await fsp.rm(settingsFile(), { force: true });
  broadcastSettings();
  return settings;
});

handle("progress:get", async (releaseId) => progressFor(releaseId));

// ---------- Ссылки на видео ----------

function normalizeUrl(raw) {
  if (!raw) throw new Error("У серии нет ссылки на видео");
  const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Неподдерживаемая ссылка");
  return url.toString();
}

// Достаёт прямые ссылки на видео: { "720": [{src,type}], ... } или null
async function resolveDirectLinks(url) {
  const host = new URL(url).hostname;

  if (host.includes("kodik")) {
    let links = null;
    try { links = await KodikParser.getDirectLinks(url, PARSE); } catch (e) { console.warn("[kodik]", e.message); }
    if (links) return links;
    // Kodik иногда меняет адрес служебного запроса — берём актуальный из скрипта плеера
    const endpointPath = await KodikParser.getLatestLink(url, PARSE).catch(() => null);
    if (endpointPath) return KodikParser.getDirectLinks(url, { ...PARSE, endpointPath });
    return null;
  }
  if (host.includes("sibnet")) return SibnetParser.getDirectLinks(url, PARSE);
  if (host.includes("rutube")) return RutubeParser.getDirectLinks(url, PARSE);
  if (host.includes("vk.com") || host.includes("vkvideo")) return VKVideoParser.getDirectLinks(url, PARSE);
  if (host.includes("ok.ru")) return OKParser.getDirectLinks(url, PARSE);
  if (host.includes("libria") || host.includes("aniliberty")) return AniLibriaParser.getDirectLinks(url, PARSE);
  return null;
}

// Сортирует качества: 1080, 720, 480 … , затем неизвестные
function toQualityList(links) {
  return Object.entries(links || {})
    .map(([quality, sources]) => ({ quality, sources: sources.filter((s) => s && s.src) }))
    .filter((q) => q.sources.length)
    .sort((a, b) => (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0));
}

// Несколько попыток: источник иногда не отвечает с первого раза
async function qualitiesFor(rawUrl) {
  const url = normalizeUrl(rawUrl);
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const list = toQualityList(await resolveDirectLinks(url));
      if (list.length) return list;
      lastErr = new Error("Источник не отдал ссылку на видео");
    } catch (err) {
      lastErr = err;
    }
    console.warn(`[links] попытка ${attempt}/3 не удалась:`, lastErr && lastErr.message);
    if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  throw lastErr;
}

// ---------- Загрузки ----------

handle("downloads:list", async () => downloads.list());
handle("downloads:add", async (items) => (Array.isArray(items) ? items : [items]).map((it) => downloads.add(it)));
handle("downloads:cancel", async (id) => downloads.cancel(id));
handle("downloads:retry", async (id) => downloads.retry(id));
handle("downloads:remove", async (id) => downloads.remove(id));
// «Сохранить файлом»: серия одним видеофайлом с понятным именем, куда выберет пользователь
handle("downloads:export", async (id) => {
  const info = await downloads.exportInfo(id);
  const clean = (t) => String(t || "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  const name = `${clean(info.it.releaseTitle)} — ${clean(info.it.name)}${info.it.dubberName ? ` (${clean(info.it.dubberName.split(",")[0])})` : ""}.${info.ext}`;
  const res = await dialog.showSaveDialog(mainWindow, {
    title: "Сохранить серию",
    defaultPath: path.join(app.getPath("videos"), name),
    filters: [{ name: "Видео", extensions: [info.ext] }],
  });
  if (res.canceled || !res.filePath) return null;
  await downloads.exportTo(id, res.filePath);
  shell.showItemInFolder(res.filePath);
  return res.filePath;
});

handle("downloads:openFolder", async () => {
  await shell.openPath(downloads.dir);
  return true;
});

// ---------- Плеер ----------
// У каждого окна плеера свой «контекст»: какой тайтл, какие серии, какая сейчас.

// ---------- Тайминги опенинга/эндинга ----------
// Храним найденные тайминги на диске (skips.json), чтобы не искать заново и работать офлайн.

let skips = {}; // "<releaseId>:<position>" -> { op, ed, source } | { none: true, at }
let skipsTimer = null;
const skipsFile = () => path.join(app.getPath("userData"), "skips.json");
const SKIP_RETRY_MS = 3 * 24 * 3600 * 1000; // «не нашлось» перепроверяем через 3 дня

function loadSkips() {
  try { skips = JSON.parse(fs.readFileSync(skipsFile(), "utf8")); } catch { skips = {}; }
}
function saveSkipsSoon() {
  clearTimeout(skipsTimer);
  skipsTimer = setTimeout(() => fsp.writeFile(skipsFile(), JSON.stringify(skips)).catch(() => {}), 1500);
}

// release: { id, titleOriginal, titleRu, year }, episode: { position, url }
async function skipTimesFor(release, episode) {
  const key = `${release.id}:${episode.position}`;
  const known = skips[key];
  if (known && !known.none) return known;
  if (known && known.none && Date.now() - known.at < SKIP_RETRY_MS) return null;
  if (looksOffline()) return null;
  if (!release.titleOriginal && !release.titleRu) {
    try {
      const r = (await client.endpoints.release.get(release.id, false, REQ)).release;
      Object.assign(release, { titleOriginal: r.title_original, titleRu: r.title_ru, year: r.year });
    } catch {}
  }
  const found = await getSkipTimes(release, episode).catch(() => null);
  skips[key] = found || { none: true, at: Date.now() };
  saveSkipsSoon();
  if (found) console.log(`[skip] ${release.titleRu || release.titleOriginal} #${episode.position}:`, JSON.stringify(found));
  return found;
}

// Ищем тайминги в фоне и отправляем в окно плеера, когда найдутся
function sendSkipTimes(win, ctx, data) {
  const ep = ctx.episodes[ctx.index];
  const local = downloads.findDone(ctx.releaseId, ep.position, ctx.sourceId);
  if (local && local.skip) {
    win.webContents.send("player:skip", { position: data.position, skip: local.skip });
    return;
  }
  const release = { id: ctx.releaseId, titleOriginal: ctx.releaseOriginal, titleRu: ctx.releaseTitle, year: ctx.releaseYear };
  skipTimesFor(release, { position: ep.position, url: ep.url })
    .then((skip) => {
      if (!win.isDestroyed() && skip) win.webContents.send("player:skip", { position: data.position, skip });
    })
    .catch(() => {});
}

const players = new Map(); // webContents.id -> ctx

// Сессия только для окон плеера: CDN видео часто не присылают CORS-заголовки,
// без которых hls.js не может читать плейлисты; Sibnet требует свой Referer.
function setupPlayerSession() {
  const ses = electronSession.fromPartition(PLAYER_PARTITION);

  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const headers = { ...details.requestHeaders };
    try {
      if (new URL(details.url).hostname.includes("sibnet")) headers.Referer = "https://video.sibnet.ru/";
    } catch {}
    cb({ requestHeaders: headers });
  });

  ses.webRequest.onHeadersReceived((details, cb) => {
    const headers = {};
    for (const [k, v] of Object.entries(details.responseHeaders || {})) {
      if (!/^access-control-allow-(origin|headers|methods)$/i.test(k)) headers[k] = v;
    }
    headers["Access-Control-Allow-Origin"] = ["*"];
    headers["Access-Control-Allow-Headers"] = ["*"];
    cb({ responseHeaders: headers });
  });

  ses.protocol.handle(MEDIA_SCHEME, createMediaHandler(downloads));
}

function createPlayerWindow(title) {
  const win = new BrowserWindow({
    width: 1280,
    height: 760,
    title: title || "Плеер",
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    icon: APP_ICON,
    webPreferences: {
      partition: PLAYER_PARTITION,
      preload: path.join(__dirname, "player-preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Всплывающие окна плееров — почти всегда реклама, не открываем их
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // F12 — инструменты разработчика, чтобы видеть ошибки плеера
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type === "keyDown" && input.key === "F12") {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });
  // Ошибки страницы плеера дублируем в консоль, где запущен npm start
  win.webContents.on("console-message", (event, legacyLevel, legacyMessage) => {
    const level = event.level ?? legacyLevel;
    const text = event.message ?? legacyMessage;
    if (level === "error" || level === "warning" || level === 2 || level === 3) console.log(`[player] ${text}`);
  });
  const id = win.webContents.id;
  win.on("closed", () => players.delete(id));
  return win;
}

// Готовит данные серии для плеера: сначала ищем скачанную копию, потом — онлайн
async function prepareEpisode(ctx) {
  const ep = ctx.episodes[ctx.index];
  const label = ep.name || `${ep.position} серия`;
  const saved = progress[`${ctx.releaseId}:${ep.position}`];
  const base = {
    title: `${ctx.releaseTitle} — ${label}`,
    position: ep.position,
    resumeAt: saved && saved.d && saved.t < saved.d - 30 && saved.t > 10 ? saved.t : 0,
    hasNext: queueInfo(ctx).hasNext,
    hasPrev: ctx.index > 0,
  };

  const local = downloads.findDone(ctx.releaseId, ep.position, ctx.sourceId);
  if (local) {
    ctx.currentSourceId = local.sourceId;
    const src = `${MEDIA_SCHEME}://media/${local.id}/${local.entry}`;
    return {
      ...base,
      offline: true,
      qualities: [{
        quality: local.quality || "auto",
        sources: [{ src, type: local.kind === "hls" ? "application/vnd.apple.mpegurl" : "video/mp4" }],
      }],
    };
  }

  ctx.currentSourceId = ctx.sourceId;
  let qualities = [];
  try {
    qualities = await qualitiesFor(ep.url);
  } catch (err) {
    console.warn("[player] не удалось получить прямые ссылки:", err.message);
  }
  if (qualities.length) return { ...base, offline: false, qualities };
  return { ...base, embedUrl: normalizeUrl(ep.url) };
}

// Показывает подготовленную серию в окне: свой плеер или страница источника
async function showEpisode(win, ctx, data) {
  ctx.current = data;
  ctx.marked = false;
  win.setTitle(data.title);
  if (data.embedUrl) {
    // встроенный плеер источника — следить за прогрессом нельзя, отмечаем сразу
    ctx.inPlayerPage = false;
    if (session.token) markWatched(ctx.releaseId, ctx.currentSourceId, data.position).catch(() => {});
    await win.loadURL(data.embedUrl, { httpReferrer: EMBED_REFERRER });
    return { mode: "embed" };
  }
  if (!ctx.inPlayerPage) {
    ctx.inPlayerPage = true;
    await win.loadFile(path.join(__dirname, "renderer", "player.html"));
  }
  sendSkipTimes(win, ctx, data);
  return { mode: data.offline ? "offline" : "direct" };
}

async function openPlayer(ctx) {
  const data = await prepareEpisode(ctx);
  const win = createPlayerWindow(data.title);
  players.set(win.webContents.id, ctx);
  return showEpisode(win, ctx, data);
}

// info: { releaseId, releaseTitle, sourceId, position, episodes:[{position,name,url}] }
handle("player:open", async (info) => {
  const index = Math.max(0, info.episodes.findIndex((e) => e.position === info.position));
  return openPlayer({ ...info, index });
});

// Просмотр из раздела «Загрузки»: следующими сериями будут другие скачанные серии тайтла
handle("player:openDownload", async (id) => {
  const it = downloads.get(id);
  if (!it || it.status !== "done") throw new Error("Серия ещё не скачана");
  const siblings = downloads.list()
    .filter((d) => d.releaseId === it.releaseId && d.status === "done")
    .sort((a, b) => a.position - b.position)
    .filter((d, i, arr) => i === 0 || arr[i - 1].position !== d.position);
  const episodes = siblings.map((d) => ({ position: d.position, name: d.name, url: d.url }));
  return openPlayer({
    releaseId: it.releaseId,
    releaseTitle: it.releaseTitle,
    releaseOriginal: it.releaseOriginal,
    releaseYear: it.releaseYear,
    sourceId: it.sourceId,
    episodes,
    index: Math.max(0, episodes.findIndex((e) => e.position === it.position)),
    fromDownloads: true, // список серий = скачанные; докачавшиеся добавляются на ходу
  });
});

// ---------- Подхват серий, докачавшихся во время просмотра ----------

function doneSiblings(releaseId) {
  return downloads.list()
    .filter((d) => d.releaseId === releaseId && d.status === "done")
    .sort((a, b) => a.position - b.position)
    .filter((d, i, arr) => i === 0 || arr[i - 1].position !== d.position);
}

// Следующая по номеру серия этого тайтла, которая ещё качается или ждёт в очереди
function pendingAfter(ctx) {
  const cur = ctx.episodes[ctx.index];
  return downloads.list()
    .filter((d) => d.releaseId === ctx.releaseId && d.position > cur.position && (d.status === "queued" || d.status === "downloading"))
    .sort((a, b) => a.position - b.position)[0] || null;
}

function queueInfo(ctx) {
  const pending = ctx.fromDownloads ? pendingAfter(ctx) : null;
  return {
    hasPrev: ctx.index > 0,
    hasNext: ctx.index < ctx.episodes.length - 1 || Boolean(pending),
    waiting: ctx.waitFor != null && pending
      ? { name: pending.name, status: pending.status, percent: Math.floor((pending.progress || 0) * 100) }
      : null,
  };
}

function syncPlayersWithDownloads() {
  for (const [id, ctx] of players) {
    if (!ctx.fromDownloads || !ctx.current) continue;
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.id === id);
    if (!win) continue;
    const cur = ctx.episodes[ctx.index];
    const done = doneSiblings(ctx.releaseId);
    if (!done.some((d) => d.position === cur.position)) continue; // текущую удалили — не трогаем
    const known = new Set(ctx.episodes.map((e) => e.position));
    ctx.episodes = done.map((d) => ({ position: d.position, name: d.name, url: d.url }));
    ctx.index = ctx.episodes.findIndex((e) => e.position === cur.position);
    const added = done.find((d) => !known.has(d.position) && d.position > cur.position);

    // ждали эту серию — включаем сами
    if (ctx.waitFor != null && done.some((d) => d.position === ctx.waitFor)) {
      ctx.index = ctx.episodes.findIndex((e) => e.position === ctx.waitFor);
      ctx.waitFor = null;
      prepareEpisode(ctx)
        .then((data) => showEpisode(win, ctx, data).then(() => win.webContents.send("player:load", data)))
        .catch((e) => console.warn("[player] автозапуск:", e.message));
      continue;
    }
    if (ctx.waitFor != null && !pendingAfter(ctx)) ctx.waitFor = null; // загрузку отменили или она упала
    win.webContents.send("player:queue", { ...queueInfo(ctx), added: ctx.waitFor == null && added ? added.name : null });
  }
}

// --- вызовы из окна плеера ---

function ctxOf(sender) {
  const ctx = players.get(sender.id);
  if (!ctx) throw new Error("Окно плеера не найдено");
  return ctx;
}

handlePlayer("player:init", async (sender) => ctxOf(sender).current);

handlePlayer("player:progress", async (sender, time, duration) => {
  const ctx = ctxOf(sender);
  const data = ctx.current;
  if (!data || !duration || !isFinite(duration)) return false;
  const key = `${ctx.releaseId}:${data.position}`;
  progress[key] = { t: Math.round(time), d: Math.round(duration), at: Date.now() };
  saveProgressSoon();
  sendToMain("progress:changed", { releaseId: ctx.releaseId, position: data.position, ...progress[key] });

  if (!ctx.marked && time / duration >= WATCHED_AT && session.token) {
    ctx.marked = true;
    markWatched(ctx.releaseId, ctx.currentSourceId, data.position)
      .catch((e) => { ctx.marked = false; console.warn("[player] отметка не сохранилась:", e.message); });
  }
  return true;
});

async function step(sender, delta) {
  const ctx = ctxOf(sender);
  const nextIndex = ctx.index + delta;
  if (delta > 0 && nextIndex >= ctx.episodes.length && ctx.fromDownloads) {
    const pending = pendingAfter(ctx);
    if (!pending) return null;
    ctx.waitFor = pending.position; // включим, как только скачается
    return { waiting: queueInfo(ctx).waiting };
  }
  if (nextIndex < 0 || nextIndex >= ctx.episodes.length) return null;
  ctx.waitFor = null;
  ctx.index = nextIndex;
  const data = await prepareEpisode(ctx);
  const win = BrowserWindow.fromWebContents(sender);
  const res = await showEpisode(win, ctx, data);
  return res.mode === "embed" ? null : data;
}

handlePlayer("player:next", async (sender) => step(sender, 1));
handlePlayer("player:prev", async (sender) => step(sender, -1));

handle("shell:openExternal", async (rawUrl) => {
  await shell.openExternal(normalizeUrl(rawUrl));
  return true;
});

// ---------- Главное окно ----------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: "Anixart PC",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#121214" : "#f6f6f8",
    autoHideMenuBar: true,
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

if (process.platform === "win32") app.setAppUserModelId("local.anixart.pc");

app.whenReady().then(async () => {
  await loadSession();
  loadProgress();
  loadSettings();
  loadSkips();
  loadPendingMarks();
  // отложенные отметки: пробуем отправить вскоре после запуска и затем раз в минуту
  setTimeout(() => flushPendingMarks().catch(() => {}), 5000);
  setInterval(() => flushPendingMarks().catch(() => {}), 60_000);
  downloads = new DownloadManager({
    dir: path.join(app.getPath("userData"), "downloads"),
    resolveLinks: qualitiesFor,
    resolveSkips: (it) => skipTimesFor(
      { id: it.releaseId, titleOriginal: it.releaseOriginal, titleRu: it.releaseTitle, year: it.releaseYear },
      { position: it.position, url: it.url },
    ),
    isOnline: () => net.isOnline(),
    onChange: (list) => {
      sendToMain("downloads:changed", list);
      syncPlayersWithDownloads();
    },
  });
  await downloads.init();
  setupUpdater();
  // скачанное (постеры) нужно и главному окну, и окнам плеера
  protocol.handle(MEDIA_SCHEME, createMediaHandler(downloads));
  setupPlayerSession();
  pruneCache().catch(() => {});
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Перед выходом дописываем прогресс на диск
app.on("before-quit", () => {
  clearTimeout(progressTimer);
  try { fs.writeFileSync(progressFile(), JSON.stringify(progress)); } catch {}
});
