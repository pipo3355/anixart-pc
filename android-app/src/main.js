// Anixart Offline — интерфейс приложения.
// Вкладки: Загрузки · Поиск · Списки · Профиль. Поверх вкладок открываются экраны
// тайтла (выбор озвучки и серий для загрузки) и скачанного тайтла (просмотр офлайн).

import { App } from "@capacitor/app";
import { log } from "./log.js";
import { installNativeFetch, isNative } from "./net.js";
import * as A from "./api.js";
import { downloads } from "./downloads.js";
import { settings } from "./settings.js";
import { player } from "./player.js";
import { Device } from "./device.js";
import { createUpdater } from "./updater.js";

installNativeFetch();

const APP_VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";
const REPO = "pipo3355/anixart-pc";
const STATUS = { 1: "Смотрю", 2: "В планах", 3: "Просмотрено", 4: "Отложено", 5: "Брошено" };
const QUALITIES = ["1080", "720", "480", "360"];

const state = {
  tab: "downloads",
  stack: [], // открытые поверх вкладки экраны: { type, ... }
  session: { loggedIn: false },
  downloads: [],
  query: "",
  listStatus: 1,
  update: null,
};

// ---------- утилиты ----------

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

const $ = (id) => document.getElementById(id);

let toastTimer;
function toast(text, isError = false, ms) {
  const t = $("toast");
  t.textContent = text;
  t.className = "toast" + (isError ? " error" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms || (isError ? 4500 : 2500));
}

function fmtSize(bytes) {
  if (!bytes) return "0 МБ";
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} ГБ` : `${Math.max(1, Math.round(mb))} МБ`;
}

function fmtTime(sec) {
  sec = Math.floor(sec || 0);
  const m = Math.floor(sec / 60);
  return `${m}:${String(sec % 60).padStart(2, "0")}`;
}

// Внешние ссылки открываются в браузере телефона: Capacitor сам перехватывает переход на чужой сайт
function openExternal(url) {
  if (isNative()) window.location.href = url;
  else window.open(url, "_blank");
}

const qLabel = (q) => (/^\d+$/.test(q || "") ? `${q}p` : q ? "Авто" : "");

// Постер: из папки приложения (работает без интернета), иначе из сети
const posterCache = new Map();
function poster(releaseId, remote, cls = "poster") {
  const img = el("img", { class: cls, alt: "", loading: "lazy" });
  const setRemote = () => { if (remote && img.src !== remote) img.src = remote; };
  if (posterCache.has(releaseId)) img.src = posterCache.get(releaseId) || remote || "";
  else {
    downloads.posterUrl(releaseId).then((u) => {
      posterCache.set(releaseId, u);
      if (u) img.src = u; else setRemote();
    }).catch(setRemote);
  }
  img.addEventListener("error", setRemote, { once: true });
  return img;
}

function spinner(text = "Загрузка…") {
  return el("div", { class: "muted pad", text });
}

function errorBox(err) {
  return el("div", { class: "error pad", text: err.message || String(err) });
}

// ---------- навигация ----------

function render() {
  for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("on", b.dataset.tab === state.tab && !state.stack.length);
  const top = state.stack[state.stack.length - 1];
  const view = $("view");
  view.replaceChildren();
  view.scrollTop = 0;
  if (top && top.type === "release") renderRelease(view, top);
  else if (top && top.type === "dlTitle") renderDownloadedTitle(view, top);
  else if (state.tab === "downloads") renderDownloads(view);
  else if (state.tab === "search") renderSearch(view);
  else if (state.tab === "lists") renderLists(view);
  else renderProfile(view);
}

function push(screen) { state.stack.push(screen); render(); }
function pop() { state.stack.pop(); render(); }

function header(title, { back = false, actions = [] } = {}) {
  return el("header", { class: "bar" },
    back ? el("button", { class: "icon-btn", "aria-label": "Назад", text: "←", onclick: pop }) : null,
    el("h1", { text: title }),
    el("div", { class: "grow" }),
    actions,
  );
}

$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  state.tab = b.dataset.tab;
  state.stack = [];
  render();
});

App.addListener("backButton", () => {
  if (document.body.classList.contains("playing")) return; // плеер закрывается сам
  if (state.stack.length) pop();
  else if (state.tab !== "downloads") { state.tab = "downloads"; render(); }
  else App.exitApp();
});

// ---------- Загрузки ----------

const isActive = (d) => d.status === "queued" || d.status === "downloading";

function groupDownloads() {
  const groups = new Map();
  for (const d of state.downloads) {
    if (!groups.has(d.releaseId)) groups.set(d.releaseId, []);
    groups.get(d.releaseId).push(d);
  }
  return [...groups.values()].map((items) => {
    items.sort((a, b) => a.position - b.position);
    const done = items.filter((d) => d.status === "done");
    return {
      releaseId: items[0].releaseId,
      title: items[0].releaseTitle,
      poster: items[0].poster,
      items,
      done,
      unwatched: done.filter((d) => !d.watched).length,
      active: items.filter(isActive),
      paused: items.filter((d) => d.status === "canceled" || d.status === "error"),
      bytes: items.reduce((s, d) => s + (d.bytes || 0), 0),
      recent: Math.max(...items.map((d) => d.createdAt)),
    };
  });
}

function applySortFilter(groups) {
  const { sort, filter } = settings.get();
  let out = groups;
  if (filter === "unwatched") out = out.filter((g) => g.unwatched > 0);
  else if (filter === "watched") out = out.filter((g) => g.done.length && g.unwatched === 0);
  else if (filter === "active") out = out.filter((g) => g.active.length || g.paused.length);
  const cmp = {
    recent: (a, b) => b.recent - a.recent,
    title: (a, b) => a.title.localeCompare(b.title, "ru"),
    size: (a, b) => b.bytes - a.bytes,
    unwatched: (a, b) => b.unwatched - a.unwatched || b.recent - a.recent,
  }[sort] || ((a, b) => b.recent - a.recent);
  return out.slice().sort(cmp);
}

function storageBar() {
  const used = state.downloads.reduce((s, d) => s + (d.bytes || 0), 0);
  const text = el("div", { class: "storage-text", text: `Занято загрузками: ${fmtSize(used)}` });
  const fill = el("div", { class: "storage-fill" });
  const box = el("div", { class: "storage" }, text, el("div", { class: "storage-track" }, fill));
  Device.storage().then(({ free, total }) => {
    if (!total) return;
    text.textContent = `Загрузки: ${fmtSize(used)} · свободно ${fmtSize(free)} из ${fmtSize(total)}`;
    fill.style.width = `${Math.min(100, ((total - free) / total) * 100)}%`;
    fill.style.setProperty("--dl", `${Math.min(100, (used / Math.max(1, total - free)) * 100)}%`);
  }).catch(() => {});
  return box;
}

function chips(options, value, onPick) {
  return el("div", { class: "chips" },
    options.map(([v, label]) => el("button", { class: "chip" + (v === value ? " on" : ""), text: label, onclick: () => onPick(v) })));
}

function renderDownloads(view) {
  const st = settings.get();
  const groups = applySortFilter(groupDownloads());
  view.append(
    header("Загрузки"),
    storageBar(),
    el("div", { class: "toolbar" },
      chips([["all", "Все"], ["unwatched", "Не досмотрено"], ["watched", "Досмотрено"], ["active", "Качаются"]], st.filter,
        (v) => settings.set({ filter: v }).then(render)),
      el("select", { class: "sort", onchange: (e) => settings.set({ sort: e.target.value }).then(render) },
        [["recent", "Сначала новые"], ["title", "По названию"], ["size", "По размеру"], ["unwatched", "Недосмотренные сверху"]]
          .map(([v, l]) => el("option", { value: v, text: l, selected: v === st.sort }))),
    ),
  );
  if (!state.downloads.length) {
    view.append(el("div", { class: "empty" },
      el("div", { class: "empty-ico", text: "⤓" }),
      el("p", { text: "Здесь будут скачанные серии." }),
      el("button", { text: "Найти аниме", onclick: () => { state.tab = "search"; render(); } })));
    return;
  }
  if (!groups.length) { view.append(el("div", { class: "muted pad", text: "Ничего не подходит под фильтр." })); return; }

  const list = el("div", { class: "list" });
  for (const g of groups) {
    const current = g.items.find((d) => d.status === "downloading");
    const overall = g.items.reduce((s, d) => s + (d.status === "done" ? 1 : d.progress || 0), 0) / g.items.length;
    const lines = [`Скачано ${g.done.length} из ${g.items.length} · ${fmtSize(g.bytes)}`];
    let sub = "";
    if (current) sub = `Качается: ${current.name} — ${Math.floor((current.progress || 0) * 100)}%`;
    else if (g.active.length) sub = `В очереди: ${g.active.length}`;
    else if (g.paused.length) sub = `На паузе или с ошибкой: ${g.paused.length}`;
    list.append(el("button", { class: "row-card", onclick: () => push({ type: "dlTitle", releaseId: g.releaseId }) },
      poster(g.releaseId, g.poster, "thumb"),
      el("div", { class: "row-main" },
        el("div", { class: "row-title", text: g.title }),
        el("div", { class: "row-sub", text: lines[0] }),
        sub ? el("div", { class: "row-sub", text: sub }) : null,
        g.active.length ? el("div", { class: "bar-bg" }, el("div", { class: "bar-fg", style: `width:${Math.floor(overall * 100)}%` })) : null,
      ),
      g.unwatched ? el("span", { class: "badge", text: String(g.unwatched), title: "Не досмотрено" }) : null,
    ));
  }
  view.append(list);
}

// ---------- Скачанный тайтл ----------

async function playFrom(releaseId, position) {
  const items = state.downloads
    .filter((d) => d.releaseId === releaseId && d.status === "done")
    .sort((a, b) => a.position - b.position)
    .filter((d, i, arr) => i === 0 || arr[i - 1].position !== d.position);
  if (!items.length) { toast("Серии ещё не скачаны"); return; }
  const index = Math.max(0, items.findIndex((d) => d.position === position));
  await player.open({ releaseTitle: items[0].releaseTitle, items, index }, () => render());
}

async function continueTarget(items) {
  const done = items.filter((d) => d.status === "done").sort((a, b) => a.position - b.position);
  if (!done.length) return null;
  const prog = await A.getProgress();
  let best = null;
  for (const d of done) {
    const p = prog[`${d.releaseId}:${d.position}`];
    if (p && (!best || p.at > best.p.at)) best = { d, p };
  }
  if (best) {
    const finished = best.p.d && best.p.t / best.p.d >= 0.85;
    if (!finished) return { item: best.d, at: best.p.t };
    const next = done.find((d) => d.position > best.d.position);
    if (next) return { item: next, at: 0 };
  }
  const firstUnwatched = done.find((d) => !d.watched);
  return { item: firstUnwatched || done[0], at: 0 };
}

function dlStatusText(d) {
  if (d.status === "done") return `${qLabel(d.quality)} · ${fmtSize(d.bytes)}`;
  if (d.status === "downloading") return `Качается ${Math.floor((d.progress || 0) * 100)}%${d.bytes ? ` · ${fmtSize(d.bytes)}` : ""}`;
  if (d.status === "queued") return "В очереди";
  if (d.status === "canceled") return `На паузе${d.progress ? ` — ${Math.floor(d.progress * 100)}%` : ""}`;
  return `Ошибка: ${d.error || "неизвестно"}`;
}

function renderDownloadedTitle(view, screen) {
  const items = state.downloads.filter((d) => d.releaseId === screen.releaseId).sort((a, b) => a.position - b.position);
  if (!items.length) { pop(); return; }
  const first = items[0];
  const bytes = items.reduce((s, d) => s + (d.bytes || 0), 0);
  const active = items.filter(isActive);
  const paused = items.filter((d) => d.status === "canceled" || d.status === "error");

  const continueBtn = el("button", { class: "primary", hidden: true });
  continueTarget(items).then((t) => {
    if (!t) return;
    continueBtn.hidden = false;
    continueBtn.textContent = t.at > 10 ? `▶ Продолжить: ${t.item.name} с ${fmtTime(t.at)}` : `▶ Смотреть: ${t.item.name}`;
    continueBtn.onclick = () => playFrom(t.item.releaseId, t.item.position);
  });

  view.append(
    header(first.releaseTitle, { back: true }),
    el("div", { class: "title-head" },
      poster(first.releaseId, first.poster, "thumb big"),
      el("div", { class: "title-info" },
        el("div", { class: "row-sub", text: `Скачано ${items.filter((d) => d.status === "done").length} из ${items.length} · ${fmtSize(bytes)}` }),
        el("div", { class: "row-sub", text: first.dubberName }),
        el("div", { class: "btn-row" },
          continueBtn,
          active.length ? el("button", { class: "ghost", text: "⏸ Пауза", onclick: () => active.forEach((d) => downloads.pause(d.id)) }) : null,
          paused.length ? el("button", { class: "ghost", text: "⟳ Продолжить загрузку", onclick: () => paused.forEach((d) => downloads.retry(d.id)) }) : null,
          el("button", { class: "ghost", text: "＋ Скачать ещё", onclick: () => push({ type: "release", releaseId: first.releaseId }) }),
          el("button", {
            class: "ghost danger", text: "Удалить всё",
            onclick: async () => {
              if (!confirm(`Удалить все серии «${first.releaseTitle}» (${fmtSize(bytes)})?`)) return;
              for (const d of items) await downloads.remove(d.id);
              toast("Удалено");
            },
          }),
        ),
      ),
    ),
  );

  const list = el("div", { class: "list" });
  A.getProgress().then((prog) => {
    for (const d of items) {
      const p = prog[`${d.releaseId}:${d.position}`];
      const ratio = p && p.d ? p.t / p.d : 0;
      const acts = [];
      if (d.status === "done") acts.push(el("button", { class: "mini", text: "▶", onclick: (e) => { e.stopPropagation(); playFrom(d.releaseId, d.position); } }));
      if (isActive(d)) acts.push(el("button", { class: "mini ghost", text: "⏸", onclick: (e) => { e.stopPropagation(); downloads.pause(d.id); } }));
      if (d.status === "canceled" || d.status === "error") acts.push(el("button", { class: "mini ghost", text: "⟳", onclick: (e) => { e.stopPropagation(); downloads.retry(d.id); } }));
      acts.push(el("button", {
        class: "mini ghost", text: "🗑",
        onclick: (e) => { e.stopPropagation(); if (confirm(`Удалить «${d.name}»?`)) downloads.remove(d.id); },
      }));
      list.append(el("div", { class: "ep-row" + (d.watched ? " watched" : ""), onclick: () => d.status === "done" && playFrom(d.releaseId, d.position) },
        el("div", { class: "row-main" },
          el("div", { class: "row-title", text: `${d.name}${d.watched ? " ✓" : ""}` }),
          el("div", { class: "row-sub" + (d.status === "error" ? " err" : ""), text: dlStatusText(d) }),
          d.status === "downloading" ? el("div", { class: "bar-bg" }, el("div", { class: "bar-fg", style: `width:${Math.floor((d.progress || 0) * 100)}%` })) : null,
          ratio > 0.02 && ratio < 0.95 ? el("div", { class: "watch-bar" }, el("div", { style: `width:${ratio * 100}%` })) : null,
        ),
        el("div", { class: "acts" }, acts),
      ));
    }
  });
  view.append(list);
}

// ---------- Поиск ----------

function releaseCard(r) {
  const sub = [r.year, r.episodes_total ? `${r.episodes_released ?? "?"}/${r.episodes_total} эп.` : null].filter(Boolean).join(" · ");
  return el("button", { class: "row-card", onclick: () => push({ type: "release", releaseId: r.id }) },
    poster(r.id, r.image, "thumb"),
    el("div", { class: "row-main" },
      el("div", { class: "row-title", text: r.title_ru || r.title_original }),
      el("div", { class: "row-sub", text: sub }),
      r.profile_list_status ? el("div", { class: "row-sub accent", text: STATUS[r.profile_list_status] }) : null,
    ),
  );
}

function pagedList(container, fetchPage) {
  let pageNum = 0;
  let busy = false;
  const list = el("div", { class: "list" });
  const more = el("button", { class: "ghost wide", text: "Показать ещё", hidden: true });
  const status = spinner();
  container.append(list, status, more);
  const load = async () => {
    if (busy) return;
    busy = true;
    more.hidden = true;
    status.hidden = false;
    try {
      const res = await fetchPage(pageNum);
      for (const r of res.items) list.append(releaseCard(r));
      status.hidden = list.children.length > 0;
      status.textContent = list.children.length ? "" : "Ничего не найдено.";
      more.hidden = !res.items.length || pageNum + 1 >= res.totalPages;
    } catch (err) {
      status.replaceWith(errorBox(err));
    } finally {
      busy = false;
    }
  };
  more.onclick = () => { pageNum += 1; load(); };
  load();
}

function renderSearch(view) {
  const input = el("input", { type: "search", placeholder: "Название аниме", value: state.query, enterkeyhint: "search" });
  const results = el("div");
  const form = el("form", { class: "search", onsubmit: (e) => {
    e.preventDefault();
    state.query = input.value.trim();
    input.blur();
    results.replaceChildren();
    if (state.query) pagedList(results, (p) => A.api.search(state.query, p));
  } }, input, el("button", { text: "Найти" }));
  view.append(header("Поиск"), form, results);
  if (state.query) pagedList(results, (p) => A.api.search(state.query, p));
  else setTimeout(() => input.focus(), 50);
}

// ---------- Списки ----------

function needLogin(view) {
  view.append(el("div", { class: "empty" },
    el("p", { text: "Войдите в аккаунт Anixart, чтобы видеть свои списки." }),
    el("button", { text: "Войти", onclick: () => { state.tab = "profile"; render(); } })));
}

function renderLists(view) {
  view.append(header("Мои списки"));
  if (!state.session.loggedIn) { needLogin(view); return; }
  view.append(chips([...Object.entries(STATUS).map(([k, v]) => [Number(k), v]), ["fav", "★ Избранное"]], state.listStatus,
    (v) => { state.listStatus = v; render(); }));
  const box = el("div");
  view.append(box);
  pagedList(box, (p) => (state.listStatus === "fav" ? A.api.favorites(p) : A.api.list(state.listStatus, p)));
}

// ---------- Тайтл: выбор озвучки и серий для загрузки ----------

function renderRelease(view, screen) {
  view.append(header("Тайтл", { back: true }));
  const body = el("div");
  view.append(body);
  body.append(spinner());
  A.api.release(screen.releaseId).then((r) => {
    body.replaceChildren();
    const meta = [r.year, r.status && r.status.name, r.episodes_total ? `${r.episodes_released ?? "?"} из ${r.episodes_total} эп.` : null].filter(Boolean).join(" · ");
    body.append(el("div", { class: "title-head" },
      poster(r.id, r.image, "thumb big"),
      el("div", { class: "title-info" },
        el("h2", { text: r.title_ru || r.title_original }),
        el("div", { class: "row-sub", text: meta }),
        r.genres ? el("div", { class: "row-sub", text: r.genres }) : null,
        state.downloads.some((d) => d.releaseId === r.id)
          ? el("button", { class: "ghost", text: "Открыть загрузки тайтла", onclick: () => push({ type: "dlTitle", releaseId: r.id }) })
          : null,
      ),
    ));
    if (r.description) {
      const d = el("p", { class: "desc clamp", text: r.description, onclick: () => d.classList.toggle("clamp") });
      body.append(d);
    }
    if (r.is_play_disabled || r.is_view_blocked) {
      body.append(el("div", { class: "muted pad", text: "Этот тайтл недоступен для просмотра." }));
      return;
    }
    episodePicker(body, r);
  }).catch((err) => body.replaceChildren(errorBox(err)));
}

function episodePicker(box, r) {
  const st = settings.get();
  const dubSel = el("select");
  const srcSel = el("select");
  const qSel = el("select", { onchange: (e) => settings.set({ quality: e.target.value }) },
    QUALITIES.map((q) => el("option", { value: q, text: `${q}p`, selected: q === st.quality })));
  const info = spinner("Загрузка озвучек…");
  const list = el("div", { class: "list" });
  const dlBtn = el("button", { class: "primary", text: "Скачать выбранные", disabled: true });
  const allBtn = el("button", { class: "ghost", text: "Выбрать все" });
  box.append(
    el("div", { class: "picker" },
      el("label", {}, "Озвучка", dubSel),
      el("label", {}, "Источник", srcSel),
      el("label", {}, "Качество", qSel)),
    el("div", { class: "btn-row sticky" }, allBtn, dlBtn),
    info, list);

  const saved = JSON.parse(localStorage.getItem(`pick:${r.id}`) || "{}");
  const lastEp = r.last_view_episode;
  const lastDub = lastEp && lastEp.source && lastEp.source.type && lastEp.source.type.id;
  let dubbers = [];
  let sources = [];
  let eps = [];
  const selected = new Set();

  const refreshButtons = () => {
    dlBtn.disabled = !selected.size;
    dlBtn.textContent = selected.size ? `⤓ Скачать выбранные (${selected.size})` : "Скачать выбранные";
    const selectable = eps.filter((e) => !isDownloaded(e));
    allBtn.textContent = selectable.length && selectable.every((e) => selected.has(e.position)) ? "Снять выбор" : "Выбрать все";
  };
  const isDownloaded = (ep) => {
    const d = downloads.findFor(r.id, ep.position, Number(srcSel.value));
    return d && d.sourceId === Number(srcSel.value) && d.status !== "error" && d.status !== "canceled";
  };

  async function loadSources() {
    srcSel.replaceChildren(); list.replaceChildren(); selected.clear(); refreshButtons();
    info.textContent = "Загрузка источников…"; info.hidden = false;
    try {
      sources = await A.api.sources(r.id, Number(dubSel.value));
      for (const s of sources) srcSel.append(el("option", { value: s.id, text: `${s.name} · ${s.episodes_count} эп.` }));
      if (saved.sourceId && sources.some((s) => s.id === saved.sourceId)) srcSel.value = String(saved.sourceId);
      if (!sources.length) { info.textContent = "Для этой озвучки нет источников."; return; }
      await loadEpisodes();
    } catch (err) { info.textContent = err.message; }
  }

  async function loadEpisodes() {
    list.replaceChildren(); selected.clear(); refreshButtons();
    info.textContent = "Загрузка серий…"; info.hidden = false;
    saved.dubberId = Number(dubSel.value);
    saved.sourceId = Number(srcSel.value);
    localStorage.setItem(`pick:${r.id}`, JSON.stringify(saved));
    try {
      eps = await A.api.episodes(r.id, saved.dubberId, saved.sourceId);
      info.hidden = Boolean(eps.length);
      info.textContent = eps.length ? "" : "Серий нет.";
      drawEpisodes();
    } catch (err) { info.textContent = err.message; }
  }

  function drawEpisodes() {
    list.replaceChildren();
    for (const ep of eps) {
      const d = downloads.findFor(r.id, ep.position, saved.sourceId);
      const mine = d && d.sourceId === saved.sourceId ? d : null;
      let badge = "";
      if (mine && mine.status === "done") badge = "💾";
      else if (mine && isActive(mine)) badge = mine.status === "downloading" ? `${Math.floor((mine.progress || 0) * 100)}%` : "…";
      else if (mine && mine.status === "canceled") badge = "⏸";
      else if (mine && mine.status === "error") badge = "⚠";
      const locked = mine && mine.status !== "error" && mine.status !== "canceled";
      const row = el("button", {
        class: "ep-pick" + (selected.has(ep.position) ? " on" : "") + (locked ? " locked" : "") + (ep.is_watched ? " watched" : ""),
        onclick: () => {
          if (locked) { if (mine.status === "done") playFrom(r.id, ep.position); return; }
          if (selected.has(ep.position)) selected.delete(ep.position); else selected.add(ep.position);
          row.classList.toggle("on");
          refreshButtons();
        },
      },
        el("span", { class: "check" }),
        el("span", { class: "ep-name", text: ep.name || `${ep.position} серия` }),
        ep.is_watched ? el("span", { class: "muted", text: "✓" }) : null,
        el("span", { class: "ep-badge", text: badge }),
      );
      list.append(row);
    }
    refreshButtons();
  }

  allBtn.onclick = () => {
    const selectable = eps.filter((e) => !isDownloaded(e));
    const all = selectable.every((e) => selected.has(e.position));
    selected.clear();
    if (!all) selectable.forEach((e) => selected.add(e.position));
    drawEpisodes();
  };

  dlBtn.onclick = () => {
    const dub = dubbers.find((d) => d.id === saved.dubberId);
    const src = sources.find((s) => s.id === saved.sourceId);
    let n = 0;
    for (const ep of eps.filter((e) => selected.has(e.position))) {
      downloads.add({
        releaseId: r.id,
        releaseTitle: r.title_ru || r.title_original,
        poster: r.image,
        dubberName: [dub && dub.name, src && src.name].filter(Boolean).join(", "),
        sourceId: saved.sourceId,
        position: ep.position,
        name: ep.name || `${ep.position} серия`,
        url: ep.url,
        quality: qSel.value,
        watched: ep.is_watched,
      });
      n += 1;
    }
    selected.clear();
    drawEpisodes();
    toast(settings.get().onlyWifi ? `Добавлено серий: ${n}. Загрузка начнётся по Wi-Fi` : `Добавлено в загрузки: ${n}`);
  };

  const off = downloads.on(() => {
    if (!list.isConnected) { off(); return; }
    drawEpisodes();
  });

  (async () => {
    try {
      dubbers = await A.api.dubbers(r.id);
      if (!dubbers.length) { info.textContent = "Серий пока нет."; return; }
      for (const d of dubbers) dubSel.append(el("option", { value: d.id, text: `${d.name}${d.is_sub ? " (субтитры)" : ""} · ${d.episodes_count} эп.` }));
      const pick = [saved.dubberId, lastDub].find((id) => dubbers.some((d) => d.id === id));
      if (pick) dubSel.value = String(pick);
      dubSel.onchange = loadSources;
      srcSel.onchange = loadEpisodes;
      await loadSources();
    } catch (err) { info.textContent = err.message; }
  })();
}

// ---------- Профиль и настройки ----------

function renderProfile(view) {
  view.append(header("Профиль"));
  const st = settings.get();

  if (!state.session.loggedIn) {
    const login = el("input", { placeholder: "Логин или почта", autocomplete: "username", autocapitalize: "off" });
    const pass = el("input", { type: "password", placeholder: "Пароль", autocomplete: "current-password" });
    const err = el("div", { class: "error" });
    const btn = el("button", { class: "primary", text: "Войти" });
    view.append(el("form", { class: "card form", onsubmit: async (e) => {
      e.preventDefault();
      btn.disabled = true; err.textContent = "";
      try {
        state.session = await A.signIn(login.value.trim(), pass.value);
        toast(`Привет, ${state.session.login}!`);
        render();
      } catch (ex) { err.textContent = ex.message; } finally { btn.disabled = false; }
    } },
      el("h2", { text: "Вход в Anixart" }),
      el("p", { class: "muted", text: "Тот же аккаунт, что в Anixart: списки и отметки «просмотрено» будут общими." }),
      login, pass, err, btn));
  } else {
    const pending = A.pendingCount();
    view.append(el("div", { class: "card" },
      el("div", { class: "row-title", text: `Вы вошли как ${state.session.login}` }),
      pending ? el("div", { class: "row-sub", text: `Ждут отправки в аккаунт: ${pending} отметок (уйдут, когда появится интернет)` }) : null,
      el("button", { class: "ghost danger", text: "Выйти", onclick: async () => {
        if (!confirm("Выйти из аккаунта? Скачанные серии останутся.")) return;
        await A.signOut();
        state.session = A.getSession();
        render();
      } })));
  }

  const seg = (options, value, key) => chips(options, value, (v) => settings.set({ [key]: v }).then(() => {
    if (key === "onlyWifi") downloads.onlyWifi = v;
    render();
  }));

  view.append(el("div", { class: "card" },
    el("h2", { text: "Загрузки" }),
    el("div", { class: "row-sub", text: "Качество по умолчанию" }),
    seg(QUALITIES.map((q) => [q, `${q}p`]), st.quality, "quality"),
    el("div", { class: "row-sub", text: "Скачивать" }),
    seg([[false, "По любой сети"], [true, "Только по Wi-Fi"]], st.onlyWifi, "onlyWifi"),
  ));

  view.append(el("div", { class: "card" },
    el("h2", { text: "Плеер" }),
    el("div", { class: "row-sub", text: "Двойное касание слева/справа перематывает на" }),
    seg([[5, "5 с"], [10, "10 с"], [15, "15 с"], [30, "30 с"]], st.seekStep, "seekStep"),
    el("div", { class: "row-sub", text: "Кнопка «пропустить» перематывает на" }),
    seg([[80, "80 с"], [85, "85 с"], [90, "90 с"], [120, "120 с"]], st.skipOpening, "skipOpening"),
  ));

  const logBox = el("pre", { class: "log", hidden: true });
  view.append(el("div", { class: "card" },
    el("h2", { text: "Журнал" }),
    el("div", { class: "row-sub", text: "Если что-то не работает — скопируйте журнал и пришлите его." }),
    el("div", { class: "btn-row" },
      el("button", { class: "ghost", text: "Показать", onclick: () => {
        logBox.textContent = log.text() || "Пусто";
        logBox.hidden = !logBox.hidden;
      } }),
      el("button", { class: "ghost", text: "Скопировать", onclick: async () => {
        try {
          await navigator.clipboard.writeText(`Anixart Offline ${APP_VERSION}\n${navigator.userAgent}\n\n${log.text()}`);
          toast("Журнал скопирован");
        } catch {
          logBox.textContent = log.text();
          logBox.hidden = false;
          toast("Не удалось скопировать — выделите текст вручную", true);
        }
      } }),
      el("button", { class: "ghost", text: "Очистить", onclick: () => { log.clear(); logBox.textContent = ""; toast("Журнал очищен"); } }),
    ),
    logBox));

  view.append(aboutCard());
}

function updateText(u) {
  switch (u.status) {
    case "checking": return "Проверяю обновления…";
    case "available": return `Доступна версия ${u.version}${u.size ? ` (${fmtSize(u.size)})` : ""}`;
    case "downloading": return `Скачиваю обновление ${u.version}… ${u.percent || 0}%`;
    case "ready": return u.needPermission
      ? "Разрешите установку из этого приложения в открывшихся настройках и вернитесь назад"
      : `Версия ${u.version} скачана — подтвердите установку`;
    case "none": return "У вас последняя версия";
    case "error": return u.error || "Ошибка обновления";
    default: return "";
  }
}

function aboutCard() {
  const u = updater.state;
  const main = {
    available: el("button", { class: "primary", text: "⤓ Обновить", onclick: () => updater.download() }),
    downloading: el("button", { class: "primary", text: `Скачивается… ${u.percent || 0}%`, disabled: true }),
    ready: el("button", { class: "primary", text: "Установить", onclick: () => updater.install() }),
  }[u.status] || el("button", {
    class: "ghost", text: "Проверить обновления", disabled: u.status === "checking",
    onclick: async () => {
      const r = await updater.check();
      if (r.status === "none") toast("У вас последняя версия");
    },
  });
  const card = el("div", { class: "card", id: "about-card" },
    el("h2", { text: "О приложении" }),
    el("div", { class: "row-sub", text: `Anixart Offline ${APP_VERSION}. Неофициальное приложение, не связано с разработчиками Anixart.` }),
    updateText(u) ? el("div", { class: "row-sub" + (u.status === "error" ? " err" : " accent"), text: updateText(u) }) : null,
    u.status === "downloading" ? el("div", { class: "bar-bg" }, el("div", { class: "bar-fg", style: `width:${u.percent || 0}%` })) : null,
    el("div", { class: "btn-row" },
      main,
      el("button", { class: "ghost", text: "🐞 Сообщить о проблеме", onclick: () => openExternal(issueUrl("bug.yml")) }),
      el("button", { class: "ghost", text: "💡 Идея", onclick: () => openExternal(issueUrl("idea.yml")) }),
    ));
  return card;
}

function issueUrl(template) {
  const u = new URL(`https://github.com/${REPO}/issues/new`);
  u.searchParams.set("template", template);
  u.searchParams.set("version", `Android ${APP_VERSION}`);
  u.searchParams.set("os", navigator.userAgent.match(/Android [\d.]+/)?.[0] || "Android");
  return u.toString();
}

// ---------- обновления (релизы android-v* на GitHub, ставятся изнутри приложения) ----------

const updater = createUpdater(APP_VERSION);
let lastUpdateStatus = null;
updater.on((u) => {
  if (u.status === "available" && lastUpdateStatus !== "available") toast(`Доступна версия ${u.version} — обновить можно в «Профиле»`, false, 4000);
  lastUpdateStatus = u.status;
  // карточку «О приложении» обновляем на месте, не перерисовывая весь профиль
  const card = document.getElementById("about-card");
  if (card) card.replaceWith(aboutCard());
  const dot = document.querySelector('#tabs button[data-tab="profile"]');
  if (dot) dot.classList.toggle("has-update", u.status === "available" || u.status === "ready");
});

// ---------- события ----------

downloads.on((list) => {
  const before = state.downloads;
  state.downloads = list;
  const top = state.stack[state.stack.length - 1];
  // перерисовываем только экраны, где видны загрузки (страница тайтла обновляется сама)
  if (!document.body.classList.contains("playing") && (top ? top.type === "dlTitle" : state.tab === "downloads")) {
    const y = $("view").scrollTop;
    render();
    $("view").scrollTop = y;
  }
  const justDone = list.filter((d) => d.status === "done" && before.some((b) => b.id === d.id && b.status !== "done"));
  if (justDone.length === 1) toast(`Скачано: ${justDone[0].releaseTitle} — ${justDone[0].name}`);
});

A.events.on((type, data) => {
  if (type === "offline") toast("Нет интернета — показана сохранённая версия");
  if (type === "marksSynced") toast(`Отметки отправлены в аккаунт: ${data.count}`);
  if (type === "watched" && data.queued) toast("Нет сети — отметка уйдёт, когда появится интернет");
});

// ---------- старт ----------

(async function start() {
  console.log(`Anixart Offline ${APP_VERSION} · ${navigator.userAgent}`);
  await settings.load();
  await A.init();
  state.session = A.getSession();
  downloads.onlyWifi = settings.get().onlyWifi;
  await downloads.init();
  state.downloads = downloads.list();
  render();
  if (isNative()) setTimeout(() => updater.check(), 5000);
  else window.__app = { downloads, player, state, render, updaterCheck: () => updater.check() }; // для отладки в браузере
})();
