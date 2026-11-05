// Поиск аниме не по Anixart: AniLibria (открытый API) и Kodik (нужен свой ключ API).
// Модуль общий: его использует и ПК-версия (главный процесс Electron), и Android-приложение.
//
// Результат приводится к виду «как у Anixart», чтобы страница тайтла, плеер и загрузки
// работали без отдельной логики:
//   тайтл:   { id: "al-413" | "kd-1735", title_ru, title_original, year, image, description, ... }
//   озвучки: [{ id, name, episodes_count, episodes: [{ position, name, url, skip? }] }]
// Ссылка серии AniLibria — адрес её записи в API (.../anime/releases/episodes/<id>);
// links-резолвер понимает такие ссылки (см. anilibriaEpisodeLinks). У Kodik ссылка серии —
// обычная страница плеера Kodik, её разбирает существующий парсер.

const AL = "https://anilibria.top";
const AL_API = `${AL}/api/v1`;
const KODIK_API = "https://kodikapi.com";
const SHIKI_IMG = "https://shikimori.io";
const TIMEOUT_MS = 20_000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

const isExternalId = (id) => typeof id === "string" && /^(al|kd)-/.test(id);

// Чем делать запросы. На ПК — net.fetch Electron (сетевой стек Chromium, как у окна приложения),
// на телефоне — обычный fetch приложения (он уже идёт через нативный HTTP Android).
let doFetch = (...args) => fetch(...args);
function configure({ fetch: f } = {}) {
  if (typeof f === "function") doFetch = f;
}

// Ошибка, которая не про сеть: нет ключа, ключ не подошёл, ничего не найдено
function fail(msg) {
  const e = new Error(msg);
  e.final = true;
  return e;
}

async function getJson(url) {
  let res;
  try {
    res = await doFetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`${new URL(url).hostname} не отвечает (${(err && err.message) || err})`);
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw fail(`${new URL(url).hostname}: доступ запрещён (HTTP ${res.status})`);
    if (res.status === 404) throw fail(`${new URL(url).hostname}: не найдено`);
    const e = new Error(`${new URL(url).hostname}: HTTP ${res.status}`);
    if (res.status < 500) e.final = true;
    throw e;
  }
  return res.json();
}

const abs = (p) => (!p ? null : /^https?:/i.test(p) ? p : p.startsWith("//") ? `https:${p}` : `${AL}${p}`);

// ---------- AniLibria ----------

function alTitle(r) {
  const poster = r.poster || {};
  return {
    id: `al-${r.id}`,
    provider: "anilibria",
    providerName: "AniLibria",
    title_ru: (r.name && r.name.main) || "",
    title_original: (r.name && (r.name.english || r.name.alternative)) || "",
    year: r.year || null,
    image: abs(poster.src || poster.preview || (poster.optimized && poster.optimized.src)),
    description: r.description || "",
    kind: r.type && r.type.description,
    episodes_total: r.episodes_total || null,
    genres: Array.isArray(r.genres) ? r.genres.map((g) => g.name).filter(Boolean).join(", ") : "",
    status: { name: r.is_ongoing ? "Онгоинг" : "Вышел" },
  };
}

async function searchAniLibria(query) {
  const list = await getJson(`${AL_API}/app/search/releases?query=${encodeURIComponent(query)}`);
  return (Array.isArray(list) ? list : []).map(alTitle);
}

async function getAniLibria(numId) {
  const r = await getJson(`${AL_API}/anime/releases/${numId}`);
  const title = alTitle(r);
  const episodes = (r.episodes || [])
    .slice()
    .sort((a, b) => (a.sort_order ?? a.ordinal) - (b.sort_order ?? b.ordinal))
    .map((e) => {
      const op = e.opening && e.opening.stop > (e.opening.start || 0) ? { start: e.opening.start || 0, end: e.opening.stop } : null;
      const ed = e.ending && e.ending.stop > (e.ending.start || 0) ? { start: e.ending.start || 0, end: e.ending.stop } : null;
      const position = Number(e.ordinal);
      return {
        position,
        name: e.name ? `${position} серия — ${e.name}` : `${position} серия`,
        url: `${AL_API}/anime/releases/episodes/${e.id}`,
        skip: op || ed ? { op, ed } : undefined,
      };
    })
    .filter((e) => Number.isFinite(e.position));
  title.translations = [{ id: 1, name: "AniLibria", episodes_count: episodes.length, episodes }];
  title.episodes_released = episodes.length;
  return title;
}

const AL_EPISODE_RE = /\/api\/v1\/anime\/releases\/episodes\/([\w-]+)/;
const isAniLibriaEpisodeUrl = (url) => AL_EPISODE_RE.test(String(url || "")) && /libria/i.test(String(url));

// Прямые ссылки серии AniLibria в формате парсеров AnixartJS: { "1080": [{src,type}], ... }
async function anilibriaEpisodeLinks(url) {
  const e = await getJson(url);
  const out = {};
  for (const q of ["1080", "720", "480"]) {
    const src = e[`hls_${q}`];
    if (src) out[q] = [{ src, type: "application/x-mpegURL" }];
  }
  if (!Object.keys(out).length) throw fail("AniLibria не отдала ссылку на эту серию");
  return out;
}

// ---------- Kodik (свой ключ API) ----------

function kdKey(r) {
  if (r.shikimori_id) return `kd-${r.shikimori_id}`;
  if (r.kinopoisk_id) return `kd-kp${r.kinopoisk_id}`;
  return `kd-id${r.id}`;
}

function kdQuery(key) {
  const k = key.replace(/^kd-/, "");
  if (k.startsWith("kp")) return `kinopoisk_id=${encodeURIComponent(k.slice(2))}`;
  if (k.startsWith("id")) return `id=${encodeURIComponent(k.slice(2))}`;
  return `shikimori_id=${encodeURIComponent(k)}`;
}

function kdTitle(r) {
  const m = r.material_data || {};
  return {
    id: kdKey(r),
    provider: "kodik",
    providerName: "Kodik",
    title_ru: m.anime_title || m.title || r.title || "",
    title_original: m.title_en || r.title_orig || "",
    year: r.year || m.year || null,
    image: m.anime_poster_url || m.poster_url || (r.shikimori_id ? `${SHIKI_IMG}/system/animes/original/${r.shikimori_id}.jpg` : null),
    description: m.anime_description || m.description || "",
    kind: /serial/.test(r.type || "") ? "Сериал" : "Фильм",
    episodes_total: m.episodes_total || r.episodes_count || null,
    genres: Array.isArray(m.anime_genres) ? m.anime_genres.join(", ") : "",
    status: m.anime_status ? { name: { released: "Вышел", ongoing: "Онгоинг", anons: "Анонс" }[m.anime_status] || m.anime_status } : null,
  };
}

async function searchKodik(query, token) {
  if (!token) throw fail("Для поиска по Kodik нужен ключ API — его можно вставить в настройках");
  const data = await getJson(`${KODIK_API}/search?token=${encodeURIComponent(token)}&title=${encodeURIComponent(query)}&types=anime,anime-serial&with_material_data=true&limit=100`);
  if (data && data.error) throw fail(`Kodik: ${data.error}`);
  // Kodik отдаёт по строке на каждую озвучку — собираем их в тайтлы
  const byKey = new Map();
  for (const r of (data && data.results) || []) {
    const key = kdKey(r);
    if (!byKey.has(key)) byKey.set(key, { ...kdTitle(r), translations_count: 0 });
    byKey.get(key).translations_count += 1;
  }
  return [...byKey.values()];
}

async function getKodik(key, token) {
  if (!token) throw fail("Для Kodik нужен ключ API — его можно вставить в настройках");
  const data = await getJson(`${KODIK_API}/search?token=${encodeURIComponent(token)}&${kdQuery(key)}&with_episodes=true&with_material_data=true&limit=100`);
  if (data && data.error) throw fail(`Kodik: ${data.error}`);
  const results = (data && data.results) || [];
  if (!results.length) throw fail("Kodik ничего не нашёл по этому тайтлу");
  const title = kdTitle(results[0]);
  title.translations = results.map((r) => {
    const episodes = [];
    if (r.seasons && Object.keys(r.seasons).length) {
      // у сериала серии по сезонам; берём сезоны по порядку, нумерацию сквозную по сезону
      const seasons = Object.keys(r.seasons).sort((a, b) => Number(a) - Number(b));
      const multi = seasons.length > 1;
      for (const s of seasons) {
        const eps = (r.seasons[s] && r.seasons[s].episodes) || {};
        for (const n of Object.keys(eps).sort((a, b) => Number(a) - Number(b))) {
          const link = typeof eps[n] === "string" ? eps[n] : eps[n] && eps[n].link;
          if (!link) continue;
          episodes.push({
            position: multi ? Number(s) * 1000 + Number(n) : Number(n),
            name: multi ? `${s} сезон, ${n} серия` : `${n} серия`,
            url: link.startsWith("//") ? `https:${link}` : link,
          });
        }
      }
    } else if (r.link) {
      episodes.push({ position: 1, name: "Фильм", url: r.link.startsWith("//") ? `https:${r.link}` : r.link });
    }
    const t = r.translation || {};
    return {
      id: Number(t.id) || r.id,
      name: t.title || "Озвучка",
      is_sub: t.type === "subtitles",
      episodes_count: episodes.length,
      episodes,
    };
  }).filter((t) => t.episodes.length);
  title.episodes_released = Math.max(0, ...title.translations.map((t) => t.episodes.length));
  return title;
}

// ---------- Общее ----------

async function searchExternal(provider, query, { kodikToken } = {}) {
  if (provider === "anilibria") return searchAniLibria(query);
  if (provider === "kodik") return searchKodik(query, kodikToken);
  throw fail(`Неизвестный источник: ${provider}`);
}

async function getExternal(id, { kodikToken } = {}) {
  if (/^al-\d+$/.test(id)) return getAniLibria(id.slice(3));
  if (/^kd-/.test(id)) return getKodik(id, kodikToken);
  throw fail("Неизвестный тайтл");
}

module.exports = { configure, searchExternal, getExternal, isExternalId, isAniLibriaEpisodeUrl, anilibriaEpisodeLinks };
