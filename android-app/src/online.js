// Онлайн-просмотр: прямые ссылки на видео и прокси для CDN без CORS.
// Прокси живёт в нативной части (MediaProxy.java): https://localhost/_proxy/https/host/path?q
// отдаёт содержимое https://host/path?q так, будто оно с того же адреса, что и приложение.

import { Capacitor } from "@capacitor/core";
import { qualitiesFor } from "./links.js";
import { directMp4, isHls } from "./downloads.js";

const native = () => Capacitor.isNativePlatform();

export function proxify(url) {
  if (!native() || !url) return url;
  const abs = url.startsWith("//") ? `https:${url}` : url;
  if (abs.startsWith(location.origin)) return abs;
  const m = /^(https?):\/\/(.+)$/i.exec(abs);
  return m ? `${location.origin}/_proxy/${m[1].toLowerCase()}/${m[2]}` : abs;
}

// Загрузчик hls.js, который пускает все запросы (плейлисты, куски, ключи) через прокси
export function proxyLoader(Hls) {
  if (!native()) return undefined;
  const Base = Hls.DefaultConfig.loader;
  return class ProxyLoader extends Base {
    load(context, config, callbacks) {
      context.url = proxify(context.url);
      super.load(context, config, callbacks);
    }
  };
}

const num = (q) => parseInt(q, 10) || 0;

// Ссылки серии по качествам: [{ quality, sources:[{src,type}] }], от лучшего к худшему
export async function onlineQualities(episodeUrl) {
  const list = await qualitiesFor(episodeUrl);
  return list.slice().sort((a, b) => num(b.quality) - num(a.quality));
}

// Ближайшее к желаемому качество, не выше него (как при загрузке)
export function pickOnlineQuality(qualities, want) {
  const w = num(want) || 720;
  return qualities.find((q) => q.quality === String(want))
    || qualities.filter((q) => num(q.quality) && num(q.quality) <= w)[0]
    || qualities[qualities.length - 1];
}

// Варианты воспроизведения для качества, в порядке попыток:
// цельный MP4 (у Kodik он лежит за HLS-ссылкой; браузеру для него CORS не нужен), затем сам поток через прокси.
export function candidatesFor(q) {
  const out = [];
  for (const s of q.sources) {
    const mp4 = directMp4(s.src);
    if (mp4) out.push({ src: mp4, hls: false });
    if (isHls(s)) out.push({ src: s.src, hls: true });
    else out.push({ src: /sibnet/i.test(s.src) ? proxify(s.src) : s.src, hls: false });
  }
  return out;
}
