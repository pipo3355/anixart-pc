// Сетевой слой. В WebView браузерные запросы к чужим сайтам упираются в CORS и
// не могут менять Referer/User-Agent, поэтому все внешние запросы (API Anixart,
// плееры Kodik/Sibnet/…) уводим в нативный HTTP Android через CapacitorHttp.
// AnixartJS и парсеры видео пользуются обычным fetch — его и подменяем.

import { Capacitor, CapacitorHttp } from "@capacitor/core";

const originalFetch = window.fetch.bind(window);
const NO_BODY = new Set([101, 204, 205, 304]);

function headersToObject(h) {
  const out = {};
  if (!h) return out;
  if (h instanceof Headers) h.forEach((v, k) => { out[k] = v; });
  else if (Array.isArray(h)) for (const [k, v] of h) out[k] = String(v);
  else for (const [k, v] of Object.entries(h)) if (v != null) out[k] = String(v);
  return out;
}

// Нативной стороне тело удобнее отдавать объектом: формы и JSON она кодирует сама
function convertBody(body, headers) {
  if (body == null) return undefined;
  const type = (Object.entries(headers).find(([k]) => k.toLowerCase() === "content-type") || [])[1] || "";
  if (body instanceof URLSearchParams) return Object.fromEntries(body.entries());
  if (typeof body === "string") {
    if (type.includes("application/json")) {
      try { return JSON.parse(body); } catch { return body; }
    }
    if (type.includes("x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(body).entries());
    return body;
  }
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  return body;
}

function withSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

async function nativeFetch(input, init = {}) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  // локальные файлы приложения и относительные адреса — обычным способом
  if (!/^https?:/i.test(url) || url.startsWith(window.location.origin)) return originalFetch(input, init);

  const headers = headersToObject(init.headers || (input instanceof Request ? input.headers : undefined));
  if (!Object.keys(headers).some((k) => k.toLowerCase() === "user-agent")) headers["User-Agent"] = navigator.userAgent;
  const request = CapacitorHttp.request({
    url,
    method: (init.method || "GET").toUpperCase(),
    headers,
    data: convertBody(init.body, headers),
    responseType: "text",
    connectTimeout: 30000,
    readTimeout: 45000,
  });
  let res;
  const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();
  try {
    res = await withSignal(request, init.signal);
  } catch (err) {
    console.warn(`[net] ${host}:`, err && err.name === "TimeoutError" ? "таймаут" : (err && err.message) || err);
    if (err && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
    throw new TypeError(`Нет соединения: ${err && err.message ? err.message : err}`);
  }
  if (res.status >= 400) console.warn(`[net] ${host}: HTTP ${res.status}`);
  const text = typeof res.data === "string" ? res.data : res.data == null ? "" : JSON.stringify(res.data);
  const response = new Response(NO_BODY.has(res.status) ? null : text, {
    status: res.status || 200,
    headers: headersToObject(res.headers),
  });
  Object.defineProperty(response, "url", { value: res.url || url });
  return response;
}

export function installNativeFetch() {
  if (Capacitor.isNativePlatform()) window.fetch = nativeFetch;
}

export const isNative = () => Capacitor.isNativePlatform();
