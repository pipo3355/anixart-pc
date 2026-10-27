// Тайминги опенинга и эндинга (OP/ED) для серии.
// 1) Kodik: в странице плеера есть строка skipButton с точными отрезками.
// 2) AniSkip (api.aniskip.com) по MAL ID; MAL ID ищем через Shikimori (у Shikimori те же ID).
// Подход взят из AniXFlow (https://github.com/MjKey/AniXFlow, GPL-2.0), переписан под этот проект.
//
// Модуль общий: его использует и ПК-версия (главный процесс Electron), и Android-приложение
// (esbuild собирает его в бандл). Нужен только fetch.
//
// Важно различать «таймингов нет» (результат null — можно запомнить) и «не получилось спросить»
// (сеть, таймаут, ограничение частоты запросов — getSkipTimes бросает SkipLookupError,
// и вызывающий код попробует позже, а не запомнит «нет» на несколько дней).

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const TIMEOUT_MS = 15_000;
const SHIKI_HOSTS = ["shikimori.io", "shikimori.one"]; // Shikimori переехал на .io, старый домен — запасной
const malCache = new Map(); // releaseId -> MAL ID | null (null только если точно не нашли)

class SkipLookupError extends Error {}

// null — 404 (ничего нет); бросает при сети, таймауте, 429, 5xx
async function getJson(url) {
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new SkipLookupError(`${new URL(url).hostname}: ${(err && err.message) || err}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new SkipLookupError(`${new URL(url).hostname}: HTTP ${res.status}`);
  try { return await res.json(); } catch { throw new SkipLookupError(`${new URL(url).hostname}: не JSON`); }
}

function parseTime(str) {
  const p = String(str).trim().split(":").map((x) => parseInt(x, 10) || 0);
  return p.reduce((acc, n) => acc * 60 + n, 0);
}

function interval(str) {
  const [a, b] = String(str || "").split("-");
  if (a == null || b == null) return null;
  const start = parseTime(a);
  const end = parseTime(b);
  return end > start ? { start, end } : null;
}

// «0:20-1:50,21:30-23:00» → { op, ed }
function parseKodikSkip(s) {
  const parts = String(s || "").split(",");
  return { op: interval(parts[0]), ed: interval(parts[1]) };
}

// Kodik — необязательный источник: если страница не открылась, просто идём в AniSkip
async function fromKodik(episodeUrl) {
  if (!episodeUrl || !/kodik/i.test(episodeUrl)) return null;
  try {
    const url = episodeUrl.startsWith("//") ? `https:${episodeUrl}` : episodeUrl;
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const html = await res.text();
    const m = /skipButton\s*=\s*parseSkipButton\(\s*"([^"]*)"/.exec(html);
    if (!m) return null;
    const r = parseKodikSkip(m[1]);
    return r.op || r.ed ? r : null;
  } catch {
    return null;
  }
}

function cleanTitle(t) {
  return String(t || "")
    .replace(/\d+\s*(сезон|season|часть|part)/gi, "")
    .replace(/(сезон|season|часть|part)\s*\d+/gi, "")
    .replace(/\(.*?\)|\[.*?\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ID или null (точно не нашлось); бросает, если ни один адрес Shikimori не ответил
async function searchShikimori(query, year) {
  let lastErr = null;
  for (const host of SHIKI_HOSTS) {
    try {
      const list = await getJson(`https://${host}/api/animes?search=${encodeURIComponent(query)}&limit=5`);
      if (!Array.isArray(list)) { lastErr = new SkipLookupError(`${host}: неожиданный ответ`); continue; }
      if (!list.length) return null;
      // при нескольких совпадениях предпочитаем тот же год выхода
      const byYear = year && list.find((a) => String(a.aired_on || "").startsWith(String(year)));
      return (byYear || list[0]).id || null;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new SkipLookupError("Shikimori недоступен");
}

async function resolveMalId(release) {
  if (malCache.has(release.id)) return malCache.get(release.id);
  const tries = [release.titleOriginal, release.titleRu, cleanTitle(release.titleOriginal), cleanTitle(release.titleRu)];
  let failed = null;
  for (const q of [...new Set(tries.filter(Boolean))]) {
    try {
      const id = await searchShikimori(q, release.year);
      if (id) { malCache.set(release.id, id); return id; }
    } catch (err) {
      failed = err;
    }
  }
  if (failed) throw failed; // не смогли спросить — не запоминаем «не нашли»
  malCache.set(release.id, null);
  return null;
}

async function fromAniSkip(release, episodeNumber) {
  const malId = await resolveMalId(release);
  if (!malId) return null;
  const data = await getJson(`https://api.aniskip.com/v2/skip-times/${malId}/${episodeNumber}?types=op&types=ed&episodeLength=0`);
  if (!data || !data.found || !Array.isArray(data.results)) return null;
  const out = { op: null, ed: null };
  for (const r of data.results) {
    const iv = r.interval && { start: Number(r.interval.startTime), end: Number(r.interval.endTime) };
    if (!iv || !(iv.end > iv.start)) continue;
    if (r.skipType === "op") out.op = iv;
    if (r.skipType === "ed") out.ed = iv;
  }
  return out.op || out.ed ? out : null;
}

/**
 * release: { id, titleOriginal, titleRu, year }
 * episode: { position, url }
 * → { op: {start,end}|null, ed: {start,end}|null, source: "kodik"|"aniskip" } или null (таймингов нет).
 * Бросает SkipLookupError, если не удалось спросить (нет сети и т.п.) — тогда стоит попробовать позже.
 */
async function getSkipTimes(release, episode) {
  const kodik = await fromKodik(episode.url);
  if (kodik) return { ...kodik, source: "kodik" };
  const aniskip = await fromAniSkip(release, episode.position);
  if (aniskip) return { ...aniskip, source: "aniskip" };
  return null;
}

module.exports = { getSkipTimes, parseKodikSkip, SkipLookupError };
