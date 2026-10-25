// Работа с Anixart: вход, запросы с кэшем для офлайна, отметки «просмотрено» с очередью.

import { Network } from "@capacitor/network";
import { Anixart, AnixartError, HttpError, BookmarkSortType } from "anixartjs";
import { prefs, readJson, writeJson, removePath, hash, serial } from "./storage.js";

const REQ = { timeoutMs: 20_000 };
const CACHE_WAIT_MS = 3000; // сколько ждём сервер, прежде чем показать сохранённое
const OFFLINE_HOLD_MS = 30_000; // после сбоя сети — сразу берём сохранённое

const client = new Anixart({});
let session = { token: null, profileId: null, login: null };
let online = true;
let offlineUntil = 0;
const listeners = new Set();

export const events = {
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  emit(type, data) { for (const fn of listeners) try { fn(type, data); } catch {} },
};

// ---------- Ошибки ----------

class LoginRequiredError extends Error {}
const SIGNIN_ERRORS = { 2: "Неверный логин", 3: "Неверный пароль" };

export function describeError(err, where) {
  if (err instanceof AnixartError) {
    if (where === "signIn" && SIGNIN_ERRORS[err.code]) return SIGNIN_ERRORS[err.code];
    return `Anixart вернул ошибку: ${err.codeName || err.code}`;
  }
  if (err instanceof HttpError) {
    if (err.status === 401 || err.status === 403) return "Сессия истекла, войдите заново";
    return `Ошибка сети (HTTP ${err.status})`;
  }
  if (err && (err.name === "TimeoutError" || err.name === "AbortError")) return "Сервер не ответил вовремя";
  return (err && err.message) || String(err);
}

function isNetworkError(err) {
  if (err instanceof AnixartError || err instanceof LoginRequiredError) return false;
  if (err instanceof HttpError) return err.status >= 500;
  return true;
}

function requireLogin() {
  if (!session.token) throw new LoginRequiredError("Нужно войти в аккаунт Anixart");
}

export const looksOffline = () => !online || Date.now() < offlineUntil;

// ---------- Кэш ----------

const cachePath = (key) => `cache/${hash(key)}.json`;

async function cached(key, fn) {
  const cachedValue = readJson(cachePath(key), undefined);
  const request = Promise.resolve().then(fn).then(
    (data) => {
      offlineUntil = 0;
      writeJson(cachePath(key), data).catch(() => {});
      if (pending.length) flushMarks().catch(() => {});
      return { ok: true, data };
    },
    (err) => ({ ok: false, err }),
  );

  if (looksOffline()) {
    const c = await cachedValue;
    if (c !== undefined) { request.catch(() => {}); events.emit("offline"); return c; }
  }
  const first = await Promise.race([request, new Promise((r) => setTimeout(() => r(null), CACHE_WAIT_MS))]);
  if (first === null) {
    const c = await cachedValue;
    if (c !== undefined) {
      offlineUntil = Date.now() + OFFLINE_HOLD_MS;
      events.emit("offline");
      return c;
    }
  }
  const res = first || (await request);
  if (res.ok) return res.data;
  if (isNetworkError(res.err)) {
    offlineUntil = Date.now() + OFFLINE_HOLD_MS;
    const c = await cachedValue;
    if (c !== undefined) { events.emit("offline"); return c; }
    throw new Error("Нет интернета, а сохранённой версии этой страницы нет");
  }
  throw new Error(describeError(res.err));
}

const page = (res) => ({
  items: res.content || [],
  page: res.current_page ?? 0,
  totalPages: res.total_page_count ?? 1,
});

// ---------- Сессия ----------

export async function init() {
  session = { ...session, ...(await prefs.get("session", {})) };
  if (session.token) client.setToken(session.token);
  pending = await prefs.get("pendingMarks", []);
  try {
    online = (await Network.getStatus()).connected;
  } catch {}
  Network.addListener("networkStatusChange", (s) => {
    const was = online;
    online = s.connected;
    if (online) offlineUntil = 0;
    events.emit("network", s);
    if (online && !was) flushMarks().catch(() => {});
  });
  setInterval(() => flushMarks().catch(() => {}), 60_000);
  setTimeout(() => flushMarks().catch(() => {}), 4000);
}

export const getSession = () => ({ loggedIn: Boolean(session.token), login: session.login, profileId: session.profileId });

export async function signIn(login, password) {
  try {
    const res = await client.endpoints.auth.signIn({ login, password }, REQ);
    const token = res.profileToken && res.profileToken.token;
    if (!token) throw new Error("Сервер не вернул токен");
    session = { token, profileId: res.profile.id, login: res.profile.login };
    client.setToken(token);
    await prefs.set("session", session);
    return getSession();
  } catch (err) {
    throw new Error(describeError(err, "signIn"));
  }
}

export async function signOut() {
  session = { token: null, profileId: null, login: null };
  client.setToken(undefined);
  await prefs.remove("session");
  pending = [];
  await prefs.set("pendingMarks", pending);
  await removePath("cache"); // в кэше личные списки аккаунта
}

// ---------- Данные ----------

export const api = {
  search: (query, pageNum = 0) => cached(`search:${query}:${pageNum}`, async () => {
    const res = await client.endpoints.search.releases({ query, searchBy: 0 }, pageNum, REQ);
    if (Array.isArray(res.releases)) {
      return { items: res.releases, page: pageNum, totalPages: res.releases.length ? pageNum + 2 : pageNum + 1 };
    }
    return page(res);
  }),
  release: (id) => cached(`release:${id}`, async () => (await client.endpoints.release.get(id, true, REQ)).release),
  list: (status, pageNum = 0) => cached(`list:${status}:${pageNum}`, async () => {
    requireLogin();
    return page(await client.endpoints.profileList.get(status, pageNum, BookmarkSortType.NewToOldAddTime, 0, REQ));
  }),
  favorites: (pageNum = 0) => cached(`fav:${pageNum}`, async () => {
    requireLogin();
    return page(await client.endpoints.favorite.all(BookmarkSortType.NewToOldAddTime, 0, pageNum, REQ));
  }),
  dubbers: (releaseId) => cached(`dub:${releaseId}`, async () => (await client.endpoints.episode.types(releaseId, REQ)).types || []),
  sources: (releaseId, dubberId) => cached(`src:${releaseId}:${dubberId}`, async () =>
    (await client.endpoints.episode.sources(releaseId, dubberId, REQ)).sources || []),
  episodes: (releaseId, dubberId, sourceId) => cached(`eps:${releaseId}:${dubberId}:${sourceId}`, async () =>
    (await client.endpoints.episode.episodes(releaseId, dubberId, sourceId, 0, REQ)).episodes || []),
};

// ---------- Отметки «просмотрено» ----------
// Без сети отметка ложится в очередь и уходит в аккаунт, когда интернет появится.

let pending = [];
let flushing = false;
const savePending = serial();

function storePending() {
  return savePending(() => prefs.set("pendingMarks", pending));
}

async function sendMark({ releaseId, sourceId, position, watched }) {
  if (watched) {
    await client.endpoints.episode.watch(releaseId, sourceId, position, REQ);
    await client.endpoints.history.add(releaseId, sourceId, position, REQ);
  } else {
    await client.endpoints.episode.unwatch(releaseId, sourceId, position, REQ);
  }
}

export async function setWatched(releaseId, sourceId, position, watched) {
  if (!session.token) return { queued: false, skipped: true };
  const mark = { releaseId, sourceId, position, watched, at: Date.now() };
  const waiting = pending.some((m) => m.releaseId === releaseId && m.position === position);
  let queued = false;
  if (waiting || looksOffline()) {
    queued = true;
  } else {
    try {
      await sendMark(mark);
    } catch (err) {
      if (!isNetworkError(err)) throw new Error(describeError(err));
      offlineUntil = Date.now() + OFFLINE_HOLD_MS;
      queued = true;
    }
  }
  if (queued) {
    pending = pending.filter((m) => !(m.releaseId === releaseId && m.position === position));
    pending.push(mark);
    await storePending();
  }
  events.emit("watched", { releaseId, position, watched, queued });
  return { queued };
}

export async function flushMarks() {
  if (flushing || !pending.length || !session.token || !online) return;
  flushing = true;
  let sent = 0;
  try {
    while (pending.length) {
      try {
        await sendMark(pending[0]);
        sent += 1;
      } catch (err) {
        if (isNetworkError(err)) break;
        console.warn("[marks] отметка отклонена сервером:", describeError(err));
      }
      pending.shift();
      await storePending();
    }
  } finally {
    flushing = false;
  }
  if (sent) events.emit("marksSynced", { count: sent, left: pending.length });
}

export const pendingCount = () => pending.length;

// ---------- Прогресс просмотра (на этом телефоне) ----------

let progress = null;
const saveProgress = serial();

export async function getProgress() {
  if (!progress) progress = await prefs.get("progress", {});
  return progress;
}

export async function setProgress(releaseId, position, t, d) {
  const p = await getProgress();
  p[`${releaseId}:${position}`] = { t: Math.round(t), d: Math.round(d), at: Date.now() };
  saveProgress(() => prefs.set("progress", p));
}

export async function progressOf(releaseId, position) {
  return (await getProgress())[`${releaseId}:${position}`] || null;
}
