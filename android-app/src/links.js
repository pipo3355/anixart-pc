// Прямые ссылки на видео из страниц плееров (Kodik, Sibnet, …) — через парсеры AnixartJS.

import { KodikParser, SibnetParser, RutubeParser, VKVideoParser, OKParser, AniLibriaParser } from "anixartjs";
import { sleep } from "./device.js";

// На мобильной сети цепочка из 2–3 запросов может идти долго — даём с запасом
const PARSE = { timeoutMs: 45_000 };
const ATTEMPTS = 3;
const delay = sleep; // повторы должны идти и в свёрнутом приложении

export function normalizeUrl(raw) {
  if (!raw) throw new Error("У серии нет ссылки на видео");
  const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Неподдерживаемая ссылка");
  return url.toString();
}

function why(err) {
  if (!err) return "";
  if (err.name === "TimeoutError" || err.name === "AbortError") return "источник слишком долго не отвечал";
  return err.message || String(err);
}

async function kodik(url) {
  let firstErr = null;
  try {
    const links = await KodikParser.getDirectLinks(url, PARSE);
    if (links) return links;
  } catch (e) {
    firstErr = e;
    console.warn("[kodik] getDirectLinks:", why(e));
  }
  // Kodik иногда меняет адрес служебного запроса — берём актуальный из скрипта плеера
  let endpointPath = null;
  try {
    endpointPath = await KodikParser.getLatestLink(url, PARSE);
  } catch (e) {
    console.warn("[kodik] getLatestLink:", why(e));
    if (!firstErr) firstErr = e;
  }
  if (endpointPath) {
    console.log("[kodik] новый адрес:", endpointPath);
    const links = await KodikParser.getDirectLinks(url, { ...PARSE, endpointPath });
    if (links) return links;
  }
  throw new Error(firstErr ? `Kodik: ${why(firstErr)}` : "Kodik не отдал ссылку на видео");
}

async function resolve(url) {
  const host = new URL(url).hostname;
  if (host.includes("kodik")) return kodik(url);
  if (host.includes("sibnet")) return SibnetParser.getDirectLinks(url, PARSE);
  if (host.includes("rutube")) return RutubeParser.getDirectLinks(url, PARSE);
  if (host.includes("vk.com") || host.includes("vkvideo")) return VKVideoParser.getDirectLinks(url, PARSE);
  if (host.includes("ok.ru")) return OKParser.getDirectLinks(url, PARSE);
  if (host.includes("libria") || host.includes("aniliberty")) return AniLibriaParser.getDirectLinks(url, PARSE);
  throw new Error(`Источник ${host} пока не поддерживается`);
}

// [{ quality: "720", sources: [{src, type}] }, …] от лучшего к худшему.
// Несколько попыток: на мобильной сети первая часто падает по таймауту.
export async function qualitiesFor(rawUrl) {
  const url = normalizeUrl(rawUrl);
  let lastErr = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const links = await resolve(url);
      const list = Object.entries(links || {})
        .map(([quality, sources]) => ({ quality, sources: (sources || []).filter((s) => s && s.src) }))
        .filter((q) => q.sources.length)
        .sort((a, b) => (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0));
      if (list.length) {
        console.log(`[links] ${new URL(url).hostname}: ${list.map((q) => q.quality).join(", ")}`);
        return list;
      }
      lastErr = new Error("Источник не отдал ни одной ссылки на видео");
    } catch (err) {
      lastErr = err;
    }
    console.warn(`[links] попытка ${attempt}/${ATTEMPTS} не удалась:`, why(lastErr), url);
    if (attempt < ATTEMPTS) await delay(2000 * attempt);
  }
  throw new Error(`Не удалось получить ссылку на видео: ${why(lastErr)}`);
}
