// Прямые ссылки на видео из страниц плееров (Kodik, Sibnet, …) — через парсеры AnixartJS.

import { KodikParser, SibnetParser, RutubeParser, VKVideoParser, OKParser, AniLibriaParser } from "anixartjs";

const PARSE = { timeoutMs: 20_000 };

export function normalizeUrl(raw) {
  if (!raw) throw new Error("У серии нет ссылки на видео");
  const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Неподдерживаемая ссылка");
  return url.toString();
}

async function resolve(url) {
  const host = new URL(url).hostname;
  if (host.includes("kodik")) {
    let links = null;
    try { links = await KodikParser.getDirectLinks(url, PARSE); } catch (e) { console.warn("[kodik]", e.message); }
    if (links) return links;
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

// [{ quality: "720", sources: [{src, type}] }, …] от лучшего к худшему
export async function qualitiesFor(rawUrl) {
  const links = await resolve(normalizeUrl(rawUrl));
  return Object.entries(links || {})
    .map(([quality, sources]) => ({ quality, sources: (sources || []).filter((s) => s && s.src) }))
    .filter((q) => q.sources.length)
    .sort((a, b) => (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0));
}
