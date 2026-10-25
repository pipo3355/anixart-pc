// Хранение данных приложения.
// Мелкие настройки и состояние — Preferences, большие JSON (кэш, список загрузок) — файлы.

import { Preferences } from "@capacitor/preferences";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";

export const DATA = Directory.Data;

export const prefs = {
  async get(key, fallback = null) {
    try {
      const { value } = await Preferences.get({ key });
      return value == null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  async set(key, value) {
    await Preferences.set({ key, value: JSON.stringify(value) });
  },
  async remove(key) {
    await Preferences.remove({ key });
  },
};

export async function readJson(path, fallback = null) {
  try {
    const { data } = await Filesystem.readFile({ path, directory: DATA, encoding: Encoding.UTF8 });
    return JSON.parse(typeof data === "string" ? data : await data.text());
  } catch {
    return fallback;
  }
}

// Запись через временный файл: если приложение закроют посреди записи, старый файл уцелеет
export async function writeJson(path, value) {
  const tmp = `${path}.tmp`;
  await Filesystem.writeFile({ path: tmp, directory: DATA, data: JSON.stringify(value), encoding: Encoding.UTF8, recursive: true });
  try {
    await Filesystem.rename({ from: tmp, to: path, directory: DATA, toDirectory: DATA });
  } catch {
    await Filesystem.writeFile({ path, directory: DATA, data: JSON.stringify(value), encoding: Encoding.UTF8, recursive: true });
  }
}

export async function exists(path) {
  try {
    const st = await Filesystem.stat({ path, directory: DATA });
    return st;
  } catch {
    return null;
  }
}

export async function removePath(path) {
  try {
    await Filesystem.rmdir({ path, directory: DATA, recursive: true });
  } catch {
    try { await Filesystem.deleteFile({ path, directory: DATA }); } catch {}
  }
}

// Короткий устойчивый хэш строки — для имён файлов кэша
export function hash(str) {
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

// Последовательная очередь: следующая запись начнётся только после предыдущей
export function serial() {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
}
