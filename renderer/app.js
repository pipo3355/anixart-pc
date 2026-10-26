"use strict";

const STATUS = { 0: "Не в списке", 1: "Смотрю", 2: "В планах", 3: "Просмотрено", 4: "Отложено", 5: "Брошено" };
const DAYS = [
  ["monday", "Понедельник"], ["tuesday", "Вторник"], ["wednesday", "Среда"], ["thursday", "Четверг"],
  ["friday", "Пятница"], ["saturday", "Суббота"], ["sunday", "Воскресенье"],
];
const DL_STATUS = { queued: "В очереди", downloading: "Скачивается", done: "Скачано", error: "Ошибка", canceled: "На паузе" };
const $ = (id) => document.getElementById(id);

const state = {
  loggedIn: false,
  login: null,
  view: { type: "search", status: 0 },
  query: "",
  page: 0,
  totalPages: 0,
  loadToken: 0,
  downloads: [],
  settings: { theme: "dark", accent: "#3b82f6", seekStep: 10, skipOpening: 85 },
  // открытая страница тайтла: id и «живые» элементы серий, чтобы обновлять их по событиям
  release: null, // { id, eps: Map<position, {setWatched, setProgress, setDownload}> }
};

// ---------- Утилиты ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "style") node.style.cssText = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) node.append(c);
  return node;
}

async function call(fn, ...args) {
  const res = await fn(...args);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " error" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 5000 : 2500);
}

function setStatus(msg, isError = false) {
  const s = $("status");
  s.textContent = msg || "";
  s.className = "status" + (isError ? " error" : "");
}

const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} },
};

function fmtTime(sec) {
  sec = Math.floor(sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function fmtSize(bytes) {
  if (!bytes) return "";
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} ГБ` : `${Math.round(mb)} МБ`;
}

function fmtAgo(unixSeconds) {
  if (!unixSeconds) return "";
  const diff = Date.now() / 1000 - unixSeconds;
  if (diff < 3600) return `${Math.max(1, Math.round(diff / 60))} мин назад`;
  if (diff < 86400) return `${Math.round(diff / 3600)} ч назад`;
  if (diff < 86400 * 7) return `${Math.round(diff / 86400)} дн назад`;
  return new Date(unixSeconds * 1000).toLocaleDateString("ru-RU");
}

// ---------- Аккаунт ----------

function renderAccount() {
  const box = $("account");
  box.replaceChildren();
  if (state.loggedIn) {
    box.append(
      el("div", { class: "who", text: `Вы вошли как ${state.login}` }),
      el("button", { class: "ghost", text: "Выйти", onclick: signOut }),
    );
  } else {
    box.append(
      el("div", { class: "who", text: "Войдите, чтобы видеть свои списки" }),
      el("button", { text: "Войти", onclick: openLogin }),
    );
  }
}

function openLogin() {
  $("login-error").textContent = "";
  $("login-dialog").showModal();
  $("login-name").focus();
}

$("login-cancel").addEventListener("click", () => $("login-dialog").close());

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("login-submit");
  btn.disabled = true;
  $("login-error").textContent = "";
  try {
    const me = await call(window.api.signIn, $("login-name").value.trim(), $("login-pass").value);
    state.loggedIn = true;
    state.login = me.login;
    $("login-pass").value = "";
    $("login-dialog").close();
    renderAccount();
    toast(`Привет, ${me.login}!`);
    switchView({ type: "list", status: 1 });
  } catch (err) {
    $("login-error").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

async function signOut() {
  await call(window.api.signOut);
  state.loggedIn = false;
  state.login = null;
  renderAccount();
  switchView({ type: "search" });
}

// ---------- Разделы ----------

const NEEDS_LOGIN = new Set(["list", "favorites", "history", "updates"]);
const PAGED = new Set(["search", "list", "favorites", "history", "updates"]);

function viewTitle(v) {
  return {
    search: "Поиск", favorites: "Избранное", history: "История", updates: "Обновления",
    schedule: "Расписание", downloads: "Загрузки", settings: "Настройки",
  }[v.type] || STATUS[v.status];
}

function highlightNav() {
  for (const b of document.querySelectorAll("#nav button")) {
    const same = b.dataset.view === state.view.type &&
      (b.dataset.view !== "list" || Number(b.dataset.status) === state.view.status);
    b.classList.toggle("active", same);
  }
}

function switchView(v) {
  state.view = { type: v.type, status: v.status || 0 };
  showListView();
  highlightNav();
  $("list-title").textContent = viewTitle(state.view);
  $("search-form").hidden = state.view.type !== "search";
  $("dl-tools").hidden = state.view.type !== "downloads";
  loadPage(true);
}

async function fetchPage(pageNum) {
  const v = state.view;
  if (v.type === "search") return call(window.api.search, state.query, pageNum);
  if (v.type === "favorites") return call(window.api.favorites, pageNum);
  if (v.type === "history") return call(window.api.history, pageNum);
  if (v.type === "updates") return call(window.api.updates, pageNum);
  return call(window.api.list, v.status, pageNum);
}

async function loadPage(reset) {
  // Каждая загрузка получает номер; если пока ждали ответа, пользователь открыл
  // другой раздел, устаревший ответ просто выбрасываем (и ничего не блокируем).
  const token = ++state.loadToken;
  const stale = () => token !== state.loadToken;
  const grid = $("grid");
  const type = state.view.type;
  if (reset) {
    grid.replaceChildren();
    grid.className = "grid";
    state.page = 0;
    state.totalPages = 0;
  }
  $("more").hidden = true;

  if (type === "downloads") { renderDownloads(); return; }
  if (type === "settings") { renderSettings(); return; }
  if (type === "search" && !state.query) {
    setStatus("Введите название, чтобы найти аниме.");
    return;
  }
  if (NEEDS_LOGIN.has(type) && !state.loggedIn) {
    setStatus("Этот раздел доступен после входа в аккаунт.");
    return;
  }

  setStatus("Загрузка…");
  try {
    if (type === "schedule") {
      const days = await call(window.api.schedule);
      if (stale()) return;
      renderSchedule(days);
      setStatus("");
      return;
    }
    const res = await fetchPage(state.page);
    if (stale()) return;
    for (const item of res.items) grid.append(type === "updates" ? updateCard(item) : card(item));
    state.totalPages = res.totalPages;
    const nothing = grid.children.length === 0;
    setStatus(nothing ? "Здесь пока пусто." : "");
    $("more").hidden = !PAGED.has(type) || nothing || res.items.length === 0 || state.page + 1 >= res.totalPages;
  } catch (err) {
    if (!stale()) setStatus(err.message, true);
  }
}

$("more").addEventListener("click", () => {
  state.page += 1;
  loadPage(false);
});

function cardShell(releaseId, image, title, sub, extra) {
  return el("div", {
    class: "card",
    tabindex: "0",
    onclick: () => openRelease(releaseId),
    onkeydown: (e) => { if (e.key === "Enter") openRelease(releaseId); },
  },
    el("img", { class: "poster", src: image, alt: "", loading: "lazy" }),
    el("div", { class: "card-title" }, title, extra),
    el("div", { class: "card-sub", text: sub }),
  );
}

function card(r) {
  const sub = [r.year, r.episodes_total ? `${r.episodes_released ?? "?"}/${r.episodes_total} эп.` : null]
    .filter(Boolean).join(" · ");
  return cardShell(r.id, r.image, r.title_ru || r.title_original, sub);
}

// Карточка из раздела «Обновления»: какая серия и в какой озвучке вышла
function updateCard(n) {
  const ep = n.episode || {};
  const rel = ep.release || {};
  const dub = ep.source && ep.source.type && ep.source.type.name;
  const sub = [ep.name, dub, fmtAgo(n.timestamp)].filter(Boolean).join(" · ");
  return cardShell(rel.id, rel.image, rel.title_ru || "", sub, n.is_new ? el("span", { class: "badge-new", text: "новое" }) : null);
}

function renderSchedule(days) {
  const grid = $("grid");
  grid.className = "grid sections";
  const today = (new Date().getDay() + 6) % 7; // 0 — понедельник
  DAYS.forEach(([key, name], i) => {
    const items = days[key] || [];
    if (!items.length) return;
    grid.append(el("section", { class: "day" + (i === today ? " today" : "") },
      el("h2", { text: i === today ? `${name} — сегодня` : name }),
      el("div", { class: "grid" }, items.map(card)),
    ));
  });
  if (!grid.children.length) setStatus("Расписание пустое.");
}

$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  state.query = $("search-input").value.trim();
  loadPage(true);
});

$("nav").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  switchView({ type: b.dataset.view, status: Number(b.dataset.status) || 0 });
});

// ---------- Настройки ----------

const ACCENTS = ["#3b82f6", "#e5484d", "#22c55e", "#a855f7", "#f97316", "#ec4899"];

// Применяет тему и цвет ко всему окну
function applySettings(st) {
  state.settings = st;
  const root = document.documentElement;
  root.dataset.theme = st.theme;
  root.style.setProperty("--accent", st.accent);
  root.style.setProperty("--accent-2", st.accent);
  // на светлом акценте белый текст плохо читается — подбираем цвет надписей на кнопках
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(st.accent.slice(i, i + 2), 16));
  root.style.setProperty("--on-accent", (r * 299 + g * 587 + b * 114) / 1000 > 170 ? "#16161a" : "#ffffff");
}

async function saveSettings(patch) {
  try {
    applySettings(await call(window.api.saveSettings, { ...state.settings, ...patch }));
    if (state.view.type === "settings") renderSettings();
  } catch (err) {
    toast(err.message, true);
  }
}

window.api.on("settings:changed", (st) => {
  applySettings(st);
  if (state.view.type === "settings" && !$("view-list").hidden) renderSettings();
});

function segmented(options, value, onPick) {
  return el("div", { class: "segmented" },
    options.map(([v, label]) => el("button", {
      type: "button", class: v === value ? "on" : null, text: label, onclick: () => onPick(v),
    })));
}

// Поле «N секунд» с быстрыми вариантами
function secondsField(value, presets, min, max, onSave) {
  const input = el("input", { type: "number", min: String(min), max: String(max), value: String(value) });
  input.addEventListener("change", () => {
    const n = Math.round(Number(input.value));
    if (!Number.isFinite(n) || n < min || n > max) {
      toast(`Введите число от ${min} до ${max}`, true);
      input.value = String(value);
      return;
    }
    onSave(n);
  });
  return el("div", { class: "num-row" },
    input, el("span", { class: "muted", text: "сек" }),
    presets.map((p) => el("button", { type: "button", class: "chip" + (p === value ? " on" : ""), text: `${p} с`, onclick: () => onSave(p) })),
  );
}

function aboutSection() {
  const info = state.appInfo;
  const u = state.update;
  const buttons = [];
  if (u.status === "ready") buttons.push(el("button", { type: "button", text: "Перезапустить и обновить", onclick: installUpdate }));
  else if (u.status !== "dev") {
    buttons.push(el("button", {
      type: "button", class: "ghost", text: "Проверить обновления",
      disabled: u.status === "checking" || u.status === "downloading",
      onclick: async () => { try { await call(window.api.checkUpdate); } catch (err) { toast(err.message, true); } },
    }));
  }
  buttons.push(
    el("button", { type: "button", class: "ghost", text: "🐞 Сообщить о проблеме", onclick: () => call(window.api.feedback, "bug").catch((e) => toast(e.message, true)) }),
    el("button", { type: "button", class: "ghost", text: "💡 Предложить идею", onclick: () => call(window.api.feedback, "idea").catch((e) => toast(e.message, true)) }),
  );
  if (info) buttons.push(el("button", { type: "button", class: "ghost", text: "Страница проекта", onclick: () => call(window.api.openExternal, info.repo) }));

  return el("section", { class: "setting" },
    el("h2", { text: "О программе" }),
    el("p", { text: "Неофициальный клиент Anixart. Не связан с разработчиками Anixart." }),
    el("div", { class: "about-meta", text: info ? `Версия ${info.version}` : "" }),
    el("div", { class: "about-meta", text: updateText(u) }),
    el("div", { class: "about-row" }, buttons),
  );
}

function renderSettings() {
  const grid = $("grid");
  grid.className = "grid settings-view";
  setStatus("");
  const st = state.settings;

  const custom = el("input", { type: "color", value: st.accent, title: "Свой цвет" });
  custom.addEventListener("change", () => saveSettings({ accent: custom.value }));

  grid.replaceChildren(
    el("section", { class: "setting" },
      el("h2", { text: "Тема" }),
      el("p", { text: "Оформление главного окна." }),
      segmented([["dark", "Тёмная"], ["light", "Светлая"], ["system", "Как в системе"]], st.theme, (v) => saveSettings({ theme: v })),
    ),
    el("section", { class: "setting" },
      el("h2", { text: "Акцентный цвет" }),
      el("p", { text: "Цвет кнопок, выделения и полос прогресса — и в окне, и в плеере." }),
      el("div", { class: "swatches" },
        ACCENTS.map((c) => el("button", {
          type: "button", class: "swatch" + (c.toLowerCase() === st.accent.toLowerCase() ? " on" : ""),
          style: `background:${c}`, title: c, onclick: () => saveSettings({ accent: c }),
        })),
        custom,
      ),
    ),
    el("section", { class: "setting" },
      el("h2", { text: "Перемотка стрелками" }),
      el("p", { text: "На сколько секунд плеер перематывает по клавишам ← и →." }),
      secondsField(st.seekStep, [5, 10, 15, 30], 1, 120, (n) => saveSettings({ seekStep: n })),
    ),
    el("section", { class: "setting" },
      el("h2", { text: "Опенинг и эндинг" }),
      el("p", { text: "Точные отрезки берутся с Kodik или из базы AniSkip и видны на полосе перемотки. Сохраняются вместе со скачанной серией — работают и без интернета." }),
      segmented([["auto", "Пропускать сразу"], ["button", "Показывать кнопку"], ["off", "Не пропускать"]], st.skipMode || "button", (v) => saveSettings({ skipMode: v })),
    ),
    el("section", { class: "setting" },
      el("h2", { text: "Пропуск опенинга без таймингов" }),
      el("p", { text: "Если точных отрезков для серии нет, Shift+→ и кнопка «Пропустить опенинг» просто перематывают вперёд на столько секунд. Обычный опенинг — около 90 секунд." }),
      secondsField(st.skipOpening, [80, 85, 90, 120], 1, 600, (n) => saveSettings({ skipOpening: n })),
    ),
    aboutSection(),
    el("div", { class: "settings-footer" },
      el("button", {
        type: "button", class: "ghost", text: "Сбросить настройки",
        onclick: async () => {
          if (!confirm("Вернуть все настройки по умолчанию?")) return;
          try {
            applySettings(await call(window.api.resetSettings));
            renderSettings();
          } catch (err) {
            toast(err.message, true);
          }
        },
      }),
    ),
  );
}

// ---------- Обновления ----------

state.update = { status: "idle" };
state.appInfo = null;

function updateText(u) {
  switch (u.status) {
    case "checking": return "Проверяю обновления…";
    case "downloading": return `Скачивается версия ${u.version || ""}${u.percent ? ` — ${u.percent}%` : ""}`;
    case "ready": return `Версия ${u.version} готова к установке`;
    case "none": return "У вас последняя версия";
    case "error": return u.error || "Не удалось проверить обновления";
    case "dev": return "Запущено из исходников — обновления проверяются только в установленной версии";
    default: return "";
  }
}

async function installUpdate() {
  try { await call(window.api.installUpdate); } catch (err) { toast(err.message, true); }
}

function renderUpdateBanner() {
  const b = $("update-banner");
  const u = state.update;
  b.replaceChildren();
  if (u.status === "ready") {
    b.append(
      el("div", { text: `Доступна версия ${u.version}` }),
      el("button", { text: "Перезапустить и обновить", onclick: installUpdate }),
    );
    b.hidden = false;
  } else if (u.status === "downloading") {
    b.append(el("div", { class: "muted", text: updateText(u) }));
    b.hidden = false;
  } else {
    b.hidden = true;
  }
}

window.api.on("update:status", (u) => {
  const wasReady = state.update.status === "ready";
  state.update = u;
  renderUpdateBanner();
  if (u.status === "ready" && !wasReady) toast(`Обновление ${u.version} скачано — перезапустите, когда удобно`);
  if (state.view.type === "settings" && !$("view-list").hidden) renderSettings();
});

// ---------- Загрузки ----------

const dlQuality = () => $("dl-quality").value;
$("dl-quality").value = store.get("dlQuality") || "720";
$("dl-quality").addEventListener("change", () => store.set("dlQuality", dlQuality()));
$("dl-folder").addEventListener("click", () => call(window.api.openDownloadsFolder).catch((e) => toast(e.message, true)));

function updateDlCounter() {
  const active = state.downloads.filter((d) => d.status === "queued" || d.status === "downloading").length;
  $("dl-count").textContent = active;
  $("dl-count").hidden = active === 0;
}

function dlStatusText(d) {
  if (d.status === "downloading") {
    return `Скачивается ${Math.floor((d.progress || 0) * 100)}%${d.bytes ? ` · ${fmtSize(d.bytes)}` : ""}`;
  }
  if (d.status === "done") return `Скачано${d.bytes ? ` · ${fmtSize(d.bytes)}` : ""}`;
  if (d.status === "error") return `Ошибка: ${d.error || "неизвестно"}`;
  if (d.status === "canceled") {
    const pct = Math.floor((d.progress || 0) * 100);
    return pct ? `На паузе — скачано ${pct}%` : "На паузе";
  }
  return DL_STATUS[d.status] || d.status;
}

async function dlAction(fn, id) {
  try { await call(fn, id); } catch (err) { toast(err.message, true); }
}

const isActive = (d) => d.status === "queued" || d.status === "downloading";
const qualityLabel = (q) => (q ? (/^\d+$/.test(q) ? `${q}p` : q) : null);
const dlOpen = new Set(); // какие тайтлы в «Загрузках» развёрнуты

// Кнопки для одной серии
function episodeDlActions(d) {
  const actions = [];
  if (d.status === "done") {
    actions.push(el("button", { text: "▶", title: "Смотреть", onclick: () => playDownload(d.id) }));
    actions.push(el("button", {
      class: "ghost", text: "💾", title: "Сохранить одним видеофайлом",
      onclick: async () => {
        try {
          const saved = await call(window.api.exportDownload, d.id);
          if (saved) toast("Сохранено");
        } catch (err) {
          toast(err.message, true);
        }
      },
    }));
  }
  if (isActive(d)) {
    actions.push(el("button", { class: "ghost", text: "⏸", title: "Остановить (можно продолжить)", onclick: () => dlAction(window.api.cancelDownload, d.id) }));
  }
  if (d.status === "canceled") {
    actions.push(el("button", { class: "ghost", text: "⟳", title: "Продолжить загрузку", onclick: () => dlAction(window.api.retryDownload, d.id) }));
  }
  if (d.status === "error") {
    actions.push(el("button", { class: "ghost", text: "↻", title: "Повторить", onclick: () => dlAction(window.api.retryDownload, d.id) }));
  }
  actions.push(el("button", {
    class: "ghost", text: "🗑", title: "Удалить серию",
    onclick: () => { if (confirm(`Удалить «${d.releaseTitle} — ${d.name}»?`)) dlAction(window.api.removeDownload, d.id); },
  }));
  return actions;
}

async function forEachDownload(list, fn) {
  for (const d of list) await dlAction(fn, d.id);
}

// Постер из папки загрузок (работает без интернета), если его нет — из сети
function posterImg(d) {
  const img = el("img", { src: `anixdl://poster/${d.releaseId}`, alt: "" });
  img.addEventListener("error", () => {
    if (d.poster && img.src !== d.poster) img.src = d.poster;
  }, { once: true });
  return img;
}

// Группирует загрузки по тайтлам: свежие тайтлы сверху, серии внутри — по порядку
function groupDownloads() {
  const groups = new Map();
  for (const d of state.downloads) {
    if (!groups.has(d.releaseId)) groups.set(d.releaseId, []);
    groups.get(d.releaseId).push(d);
  }
  return [...groups.values()]
    .map((items) => items.sort((a, b) => a.position - b.position))
    .sort((a, b) => Math.max(...b.map((d) => d.createdAt)) - Math.max(...a.map((d) => d.createdAt)));
}

function renderDownloads() {
  const grid = $("grid");
  grid.className = "grid rows";
  grid.replaceChildren();
  const groups = groupDownloads();
  setStatus(groups.length ? "" : "Скачанных серий пока нет. Скачать можно на странице тайтла кнопкой ⤓ у серии.");

  for (const items of groups) {
    const first = items[0];
    const done = items.filter((d) => d.status === "done");
    const active = items.filter(isActive);
    const failed = items.filter((d) => d.status === "error");
    const canceled = items.filter((d) => d.status === "canceled");
    const counted = items;
    const bytes = items.reduce((sum, d) => sum + (d.bytes || 0), 0);
    const current = items.find((d) => d.status === "downloading");
    const open = dlOpen.has(first.releaseId);

    // строка сводки по тайтлу
    const summary = [
      `Скачано ${done.length} из ${counted.length}`,
      bytes ? fmtSize(bytes) : null,
      failed.length ? `ошибок: ${failed.length}` : null,
      canceled.length ? `на паузе: ${canceled.length}` : null,
    ].filter(Boolean).join(" · ");
    const nowText = current
      ? `Сейчас: ${current.name} — ${Math.floor((current.progress || 0) * 100)}%`
      : active.length ? `В очереди: ${active.length}` : "";
    const overall = counted.length
      ? counted.reduce((s, d) => s + (d.status === "done" ? 1 : d.progress || 0), 0) / counted.length
      : 0;

    const actions = [];
    if (done.length) actions.push(el("button", { text: "▶", title: "Смотреть скачанное", onclick: () => playDownload(done[0].id) }));
    if (active.length) {
      actions.push(el("button", {
        class: "ghost", text: "⏸", title: "Остановить загрузки тайтла (можно продолжить)",
        onclick: () => forEachDownload(active, window.api.cancelDownload),
      }));
    }
    const resumable = [...canceled, ...failed];
    if (resumable.length) {
      actions.push(el("button", {
        class: "ghost", text: "⟳ Продолжить",
        title: canceled.length && failed.length ? "Продолжить остановленные и повторить серии с ошибкой"
          : canceled.length ? "Продолжить остановленные загрузки" : "Повторить серии с ошибкой",
        onclick: () => forEachDownload(resumable, window.api.retryDownload),
      }));
    }
    actions.push(el("button", {
      class: "ghost", text: "🗑", title: "Удалить весь тайтл",
      onclick: () => {
        if (confirm(`Удалить все скачанные серии «${first.releaseTitle}» (${items.length})?`)) forEachDownload(items, window.api.removeDownload);
      },
    }));
    actions.push(el("button", {
      class: "ghost", text: open ? "▴" : "▾", title: open ? "Свернуть" : "Показать серии",
      onclick: () => { open ? dlOpen.delete(first.releaseId) : dlOpen.add(first.releaseId); renderDownloads(); },
    }));

    const group = el("div", { class: "dl-group" },
      el("div", { class: "dl-row" },
        posterImg(first),
        el("div", {},
          el("div", { class: "t", text: first.releaseTitle, title: "Открыть тайтл", onclick: () => openRelease(first.releaseId) }),
          el("div", { class: "s", text: summary }),
          nowText ? el("div", { class: "s", text: nowText }) : null,
          active.length
            ? el("div", { class: "bar-bg" }, el("div", { class: "bar-fg", style: `width:${Math.floor(overall * 100)}%` }))
            : null,
        ),
        el("div", { class: "actions" }, actions),
      ),
    );

    // развёрнутый список серий
    if (open) {
      const list = el("div", { class: "dl-episodes" });
      for (const d of items) {
        const details = [d.name, d.dubberName, qualityLabel(d.quality)].filter(Boolean).join(" · ");
        list.append(el("div", { class: "dl-ep" },
          el("div", {},
            el("div", { class: "s strong", text: details }),
            el("div", { class: "s" + (d.status === "error" ? " err" : ""), text: dlStatusText(d) }),
            d.status === "downloading"
              ? el("div", { class: "bar-bg" }, el("div", { class: "bar-fg", style: `width:${Math.floor((d.progress || 0) * 100)}%` }))
              : null,
          ),
          el("div", { class: "actions" }, episodeDlActions(d)),
        ));
      }
      group.append(list);
    }
    grid.append(group);
  }
}

async function playDownload(id) {
  try {
    await call(window.api.openDownload, id);
  } catch (err) {
    toast(err.message, true);
  }
}

window.api.on("downloads:changed", (list) => {
  state.downloads = list;
  updateDlCounter();
  if (state.view.type === "downloads" && !$("view-list").hidden) renderDownloads();
  if (state.release) {
    for (const [position, view] of state.release.eps) view.setDownload(findDownload(state.release.id, position, view.sourceId));
  }
});

window.api.on("net:offline", () => {
  toast("Нет соединения с Anixart — показана сохранённая версия");
});

window.api.on("episode:watched", ({ releaseId, position, watched }) => {
  const view = state.release && state.release.id === releaseId && state.release.eps.get(position);
  if (view) view.setWatched(watched !== false);
});

window.api.on("marks:synced", ({ count, left }) => {
  toast(`Отложенные отметки отправлены в аккаунт: ${count}${left ? ` (ещё ждут: ${left})` : ""}`);
});

window.api.on("progress:changed", (p) => {
  if (state.release && state.release.id === p.releaseId) {
    state.release.progress[p.position] = p;
    const view = state.release.eps.get(p.position);
    if (view) view.setProgress(p);
  }
});

function findDownload(releaseId, position, sourceId) {
  const same = state.downloads.filter((d) => d.releaseId === releaseId && d.position === position);
  return same.find((d) => d.sourceId === sourceId) || same.find((d) => d.status === "done") || null;
}

// ---------- Страница тайтла ----------

function showListView() {
  $("view-release").hidden = true;
  $("view-list").hidden = false;
  state.release = null;
}

$("back").addEventListener("click", () => {
  showListView();
  // обновим раздел: статус тайтла или загрузки могли измениться
  if (state.view.type !== "search") loadPage(true);
});

async function openRelease(id) {
  if (!id) return;
  $("view-list").hidden = true;
  $("view-release").hidden = false;
  state.release = { id, eps: new Map(), progress: {} };
  const box = $("release");
  box.replaceChildren(el("div", { class: "muted", text: "Загрузка…" }));
  $("main").scrollTop = 0;
  try {
    const [r, prog] = await Promise.all([
      call(window.api.release, id),
      call(window.api.progress, id).catch(() => ({})),
    ]);
    if (!state.release || state.release.id !== id) return;
    state.release.progress = prog;
    renderRelease(r);
  } catch (err) {
    box.replaceChildren(el("div", { class: "error", text: err.message }));
  }
}

function renderRelease(r) {
  const meta = [
    ["Год", r.year],
    ["Статус", r.status && r.status.name],
    ["Эпизоды", r.episodes_total ? `${r.episodes_released ?? "?"} из ${r.episodes_total}` : r.episodes_released],
    ["Жанры", r.genres],
    ["Студия", r.studio],
    ["Рейтинг", r.grade ? Number(r.grade).toFixed(1) : null],
  ].filter(([, v]) => v);

  // --- статус в списках
  let currentStatus = r.profile_list_status || 0;
  const statusSelect = el("select", { disabled: !state.loggedIn, title: state.loggedIn ? null : "Нужен вход" },
    Object.entries(STATUS).map(([v, label]) =>
      el("option", { value: v, text: label, selected: Number(v) === currentStatus })));
  statusSelect.addEventListener("change", async () => {
    const next = Number(statusSelect.value);
    statusSelect.disabled = true;
    try {
      await call(window.api.setList, r.id, next, currentStatus);
      currentStatus = next;
      toast(next ? `Добавлено в «${STATUS[next]}»` : "Убрано из списков");
    } catch (err) {
      statusSelect.value = String(currentStatus);
      toast(err.message, true);
    } finally {
      statusSelect.disabled = false;
    }
  });

  // --- избранное
  let fav = Boolean(r.is_favorite);
  const favBtn = el("button", { class: "ghost fav", disabled: !state.loggedIn });
  const paintFav = () => {
    favBtn.textContent = fav ? "★ В избранном" : "☆ В избранное";
    favBtn.classList.toggle("on", fav);
  };
  paintFav();
  favBtn.addEventListener("click", async () => {
    favBtn.disabled = true;
    try {
      await call(window.api.setFavorite, r.id, !fav);
      fav = !fav;
      paintFav();
    } catch (err) {
      toast(err.message, true);
    } finally {
      favBtn.disabled = false;
    }
  });

  const head = el("div", { class: "release-head" },
    el("img", { class: "poster", src: r.image, alt: "" }),
    el("div", {},
      el("h1", { text: r.title_ru || r.title_original }),
      el("div", { class: "orig", text: [r.title_original, r.title_alt].filter(Boolean).join(" · ") }),
      el("dl", { class: "meta" }, meta.map(([k, v]) => [el("dt", { text: k }), el("dd", { text: String(v) })])),
      el("div", { class: "controls" }, statusSelect, favBtn),
      el("div", { class: "desc", text: r.description || "" }),
    ),
  );

  const watch = el("div", { class: "watch" }, el("h2", { text: "Смотреть" }));
  $("release").replaceChildren(head, watch);

  if (r.is_play_disabled || r.is_view_blocked) {
    watch.append(el("div", { class: "muted", text: "Просмотр этого тайтла недоступен." }));
    return;
  }
  setupEpisodes(r, watch);
}

// С какой серии продолжить: локальный прогресс, иначе — последняя серия с сервера (например, с телефона)
function continuePoint(r, eps) {
  const positions = new Set(eps.map((e) => e.position));
  const entries = Object.entries(state.release.progress)
    .map(([pos, p]) => ({ position: Number(pos), ...p }))
    .filter((p) => positions.has(p.position))
    .sort((a, b) => b.at - a.at);

  let pos = null;
  let at = 0;
  if (entries.length) {
    const last = entries[0];
    const finished = last.d && last.t / last.d >= 0.85;
    pos = finished ? last.position + 1 : last.position;
    at = finished ? 0 : last.t;
  } else if (r.last_view_episode && r.last_view_episode.position) {
    pos = r.last_view_episode.is_watched ? r.last_view_episode.position + 1 : r.last_view_episode.position;
  }
  if (pos == null || !positions.has(pos)) return null;
  return { position: pos, at };
}

async function setupEpisodes(r, box) {
  const dubSelect = el("select");
  const srcSelect = el("select");
  const actions = el("div", { class: "watch-actions" });
  const list = el("div", { class: "episodes" });
  const info = el("div", { class: "muted", text: "Загрузка озвучек…" });
  box.append(el("div", { class: "pickers" }, dubSelect, srcSelect), actions, info, list);

  const saved = store.get(`pick:${r.id}`) || {};
  const lastEp = r.last_view_episode;
  const lastDubber = lastEp && lastEp.source && lastEp.source.type && lastEp.source.type.id;

  let dubbers;
  try {
    dubbers = await call(window.api.dubbers, r.id);
  } catch (err) {
    info.textContent = err.message;
    info.className = "error";
    return;
  }
  if (!dubbers.length) {
    info.textContent = "Серий пока нет.";
    return;
  }
  for (const d of dubbers) {
    dubSelect.append(el("option", { value: d.id, text: `${d.name}${d.is_sub ? " (субтитры)" : ""} · ${d.episodes_count} эп.` }));
  }
  const pickDub = [saved.dubberId, lastDubber].find((id) => dubbers.some((d) => d.id === id));
  if (pickDub) dubSelect.value = String(pickDub);

  let sources = [];

  async function loadSources() {
    srcSelect.replaceChildren();
    list.replaceChildren();
    actions.replaceChildren();
    info.textContent = "Загрузка источников…";
    try {
      sources = await call(window.api.sources, r.id, Number(dubSelect.value));
      for (const s of sources) srcSelect.append(el("option", { value: s.id, text: `${s.name} · ${s.episodes_count} эп.` }));
      if (saved.sourceId && sources.some((s) => s.id === saved.sourceId)) srcSelect.value = String(saved.sourceId);
      if (!sources.length) { info.textContent = "Для этой озвучки нет источников."; return; }
      await loadEpisodes();
    } catch (err) {
      info.textContent = err.message;
    }
  }

  async function loadEpisodes() {
    list.replaceChildren();
    actions.replaceChildren();
    state.release.eps.clear();
    info.textContent = "Загрузка серий…";
    const dubberId = Number(dubSelect.value);
    const sourceId = Number(srcSelect.value);
    store.set(`pick:${r.id}`, { dubberId, sourceId });
    saved.dubberId = dubberId;
    saved.sourceId = sourceId;

    const dubber = dubbers.find((d) => d.id === dubberId);
    const source = sources.find((s) => s.id === sourceId);
    const ctx = {
      release: r,
      sourceId,
      dubberName: [dubber && dubber.name, source && source.name].filter(Boolean).join(", "),
      eps: [],
    };

    try {
      ctx.eps = await call(window.api.episodes, r.id, dubberId, sourceId);
      if (!state.release || state.release.id !== r.id) return;
      info.textContent = ctx.eps.length ? "" : "Серий нет.";
      for (const ep of ctx.eps) list.append(episodeItem(ctx, ep));
      renderActions(ctx);
    } catch (err) {
      info.textContent = err.message;
    }
  }

  function renderActions(ctx) {
    actions.replaceChildren();
    if (!ctx.eps.length) return;
    const point = continuePoint(r, ctx.eps);
    if (point) {
      const ep = ctx.eps.find((e) => e.position === point.position);
      const label = ep.name || `${ep.position} серия`;
      actions.append(el("button", {
        text: point.at ? `▶ Продолжить: ${label} с ${fmtTime(point.at)}` : `▶ Продолжить: ${label}`,
        onclick: () => openPlayer(ctx, ep),
      }));
    }
    actions.append(el("button", {
      class: "ghost",
      text: `⤓ Скачать все (${ctx.eps.length})`,
      title: `Качество: ${dlQuality()}p, меняется в разделе «Загрузки»`,
      onclick: () => downloadEpisodes(ctx, ctx.eps),
    }));
  }

  dubSelect.addEventListener("change", loadSources);
  srcSelect.addEventListener("change", loadEpisodes);
  loadSources();
}

async function openPlayer(ctx, ep) {
  toast("Получаю ссылку на видео…");
  try {
    const res = await call(window.api.openPlayer, {
      releaseId: ctx.release.id,
      releaseTitle: ctx.release.title_ru || ctx.release.title_original,
      releaseOriginal: ctx.release.title_original || "",
      releaseYear: ctx.release.year || null,
      sourceId: ctx.sourceId,
      position: ep.position,
      episodes: ctx.eps.map((e) => ({ position: e.position, name: e.name, url: e.url })),
    });
    if (res && res.mode === "embed") toast("Прямую ссылку получить не удалось — открыт плеер источника");
  } catch (err) {
    toast(err.message, true);
  }
}

async function downloadEpisodes(ctx, eps) {
  let resumed = 0;
  const items = eps
    .filter((ep) => {
      const d = findDownload(ctx.release.id, ep.position, ctx.sourceId);
      if (d && (d.status === "error" || d.status === "canceled")) {
        dlAction(window.api.retryDownload, d.id); // уже начатые — продолжаем, а не качаем заново
        resumed += 1;
        return false;
      }
      return !d;
    })
    .map((ep) => ({
      releaseId: ctx.release.id,
      releaseTitle: ctx.release.title_ru || ctx.release.title_original,
      releaseOriginal: ctx.release.title_original || "",
      releaseYear: ctx.release.year || null,
      poster: ctx.release.image,
      dubberName: ctx.dubberName,
      sourceId: ctx.sourceId,
      position: ep.position,
      name: ep.name || `${ep.position} серия`,
      url: ep.url,
      quality: dlQuality(),
    }));
  if (!items.length) {
    toast(resumed ? `Продолжена загрузка серий: ${resumed}` : "Эти серии уже скачаны или в очереди");
    return;
  }
  try {
    await call(window.api.download, items);
    const added = items.length === 1 ? `«${items[0].name}» добавлена в загрузки` : `В загрузки добавлено серий: ${items.length}`;
    toast(resumed ? `${added}, продолжено: ${resumed}` : added);
  } catch (err) {
    toast(err.message, true);
  }
}

function episodeItem(ctx, ep) {
  const r = ctx.release;
  let watched = Boolean(ep.is_watched);
  const label = ep.name || `${ep.position} серия`;
  const item = el("div", { class: "ep" });
  const play = el("button", { class: "play", text: label, title: "Смотреть" });
  const dl = el("button", { class: "dl" });
  const mark = el("button", { class: "mark", text: "✓" });
  const bar = el("div", { class: "ep-progress", hidden: true });

  const view = {
    sourceId: ctx.sourceId,
    setWatched(value) {
      watched = value;
      item.classList.toggle("watched", watched);
      mark.title = watched ? "Снять отметку" : "Отметить просмотренной";
    },
    setProgress(p) {
      const ratio = p && p.d ? p.t / p.d : 0;
      bar.hidden = !(ratio > 0.02 && ratio < 0.95);
      bar.style.width = `${Math.min(100, ratio * 100)}%`;
      play.title = ratio > 0.02 && ratio < 0.95 ? `Смотреть (остановились на ${fmtTime(p.t)})` : "Смотреть";
    },
    setDownload(d) {
      view.download = d;
      dl.className = "dl";
      if (!d) {
        dl.textContent = "⤓";
        dl.title = "Скачать";
      } else if (d.status === "canceled") {
        dl.textContent = "⟳";
        dl.title = "Загрузка на паузе — нажмите, чтобы продолжить";
      } else if (d.status === "done") {
        dl.textContent = "💾";
        dl.title = "Скачано — смотрится без интернета";
        dl.classList.add("saved");
      } else if (d.status === "error") {
        dl.textContent = "⚠";
        dl.title = `Ошибка загрузки: ${d.error || ""}. Нажмите, чтобы повторить`;
      } else {
        dl.textContent = d.status === "downloading" ? `${Math.floor((d.progress || 0) * 100)}%` : "…";
        dl.title = d.status === "downloading" ? "Скачивается" : "В очереди";
        dl.classList.add("busy");
      }
    },
  };
  view.setWatched(watched);
  view.setProgress(state.release.progress[ep.position]);
  view.setDownload(findDownload(r.id, ep.position, ctx.sourceId));
  state.release.eps.set(ep.position, view);

  play.addEventListener("click", async () => {
    play.disabled = true;
    await openPlayer(ctx, ep);
    play.disabled = false;
  });

  dl.addEventListener("click", () => {
    const d = view.download;
    if (d && (d.status === "error" || d.status === "canceled")) return dlAction(window.api.retryDownload, d.id);
    if (d && d.status === "done") return toast("Серия уже скачана");
    if (d && (d.status === "queued" || d.status === "downloading")) return toast("Серия уже скачивается");
    downloadEpisodes(ctx, [ep]);
  });

  mark.addEventListener("click", async () => {
    if (!state.loggedIn) { toast("Нужно войти в аккаунт", true); return; }
    const value = !watched;
    try {
      const res = await call(value ? window.api.watch : window.api.unwatch, r.id, ctx.sourceId, ep.position);
      view.setWatched(value);
      if (res && res.queued) toast("Нет сети — отметка сохранена и уйдёт в аккаунт, когда появится интернет");
    } catch (err) {
      toast(err.message, true);
    }
  });

  item.append(play, dl, mark, bar);
  return item;
}

// ---------- Старт ----------

(async function init() {
  try {
    applySettings(await call(window.api.settings));
  } catch {}
  try {
    state.appInfo = await call(window.api.appInfo);
    state.update = state.appInfo.update;
    renderUpdateBanner();
  } catch {}
  try {
    const s = await call(window.api.session);
    state.loggedIn = s.loggedIn;
    state.login = s.login;
  } catch {}
  try {
    state.downloads = await call(window.api.downloads);
    updateDlCounter();
  } catch {}
  renderAccount();
  switchView(state.loggedIn ? { type: "list", status: 1 } : { type: "search" });
})();
