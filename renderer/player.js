"use strict";

const $ = (id) => document.getElementById(id);
const video = $("video");
const qualitySelect = $("quality");
const bar = $("bar");
const message = $("message");

const NEXT_DELAY = 5; // секунд до автоперехода
const HLS_MISSING = !window.Hls;
if (HLS_MISSING) console.error("hls.js не загрузился: нет файла node_modules/hls.js/dist/hls.min.js (нужен npm install)");

let hls = null;
let data = null; // текущая серия от главного процесса
let switching = false;
let settings = { seekStep: 10, skipOpening: 85, accent: "#3b82f6" };

const OPENING_ZONE = 600; // кнопка «Пропустить опенинг» видна первые 10 минут серии

function applySettings(st) {
  if (!st) return;
  settings = st;
  const root = document.documentElement;
  root.style.setProperty("--accent", st.accent);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(st.accent.slice(i, i + 2), 16));
  root.style.setProperty("--on-accent", (r * 299 + g * 587 + b * 114) / 1000 > 170 ? "#16161a" : "#ffffff");
  $("skip").title = `Перемотать на ${st.skipOpening} с вперёд (Shift+→)`;
}

window.player.settings().then((res) => res.ok && applySettings(res.data)).catch(() => {});
window.player.onSettings(applySettings);

// Перемотка с накоплением: быстрые нажатия складываются, а прыжок делается один —
// через 200 мс после последнего нажатия. Иначе плеер на каждое нажатие бросает
// загрузку и начинает новую, и при частых нажатиях всё начинает тормозить.
const SEEK_DEBOUNCE_MS = 200;
let seekTarget = null;
let seekTimer = null;

function seekBy(delta) {
  if (!video.duration || !isFinite(video.duration)) return;
  const base = seekTarget ?? video.currentTime;
  seekTarget = Math.max(0, Math.min(video.duration - 0.5, base + delta));
  const total = seekTarget - video.currentTime;
  const sign = total >= 0 ? "+" : "−";
  notice(`${sign}${Math.round(Math.abs(total))} с → ${fmt(seekTarget)}`, 1000);
  clearTimeout(seekTimer);
  seekTimer = setTimeout(() => {
    video.currentTime = seekTarget;
    seekTarget = null;
  }, SEEK_DEBOUNCE_MS);
}

function skipOpening() {
  seekBy(settings.skipOpening);
}

$("skip").addEventListener("click", skipOpening);
video.addEventListener("timeupdate", () => {
  $("skip").hidden = !(video.currentTime < OPENING_ZONE && video.duration > OPENING_ZONE);
});

// ---------- Мелочи интерфейса ----------

function showError(text) {
  message.textContent = text;
  message.hidden = false;
}

let noticeTimer;
function notice(text, ms = 3000) {
  const n = $("notice");
  n.textContent = text;
  n.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (n.hidden = true), ms);
}

function fmt(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function savedQuality() {
  try { return localStorage.getItem("quality"); } catch { return null; }
}
function saveQuality(q) {
  try { localStorage.setItem("quality", q); } catch {}
}

// ---------- Воспроизведение ----------

const isHls = (s) => /m3u8/i.test(s.src) || /mpegurl/i.test(s.type || "");

function play(source, startAt = 0) {
  clearTimeout(seekTimer);
  seekTarget = null;
  message.hidden = true;
  if (hls) { hls.destroy(); hls = null; }
  video.removeAttribute("src");
  console.log("Воспроизведение:", source.src);

  const resume = () => {
    if (startAt > 0) video.currentTime = startAt;
    video.play().catch(() => {});
  };

  if (isHls(source) && HLS_MISSING) {
    showError("Не найден hls.js. Закройте приложение, выполните в его папке npm install и запустите снова.");
    return;
  }

  if (isHls(source) && window.Hls.isSupported()) {
    let networkRetries = 0;
    let mediaRecoveries = [];
    let lastNudge = 0;
    hls = new window.Hls({
      enableWorker: false,
      maxBufferHole: 0.5, // мелкие «дыры» между кусками видео перепрыгиваем, а не застреваем
      nudgeMaxRetry: 10,
      backBufferLength: 90, // держим 90 с позади — перемотка назад не грузит заново
    });
    hls.on(window.Hls.Events.MANIFEST_PARSED, resume);
    hls.on(window.Hls.Events.FRAG_LOADED, () => { networkRetries = 0; });
    hls.on(window.Hls.Events.ERROR, (_e, info) => {
      // "aborted" и прочие нефатальные — hls.js справляется сам (например, при перемотке)
      if (!info.fatal) return;
      const E = window.Hls.ErrorDetails;

      // Застряли на «дыре» в буфере (часто после быстрой перемотки) — просто чуть сдвигаемся.
      // Пересоздавать видео тут нельзя: это рождает новые дыры, и плеер зависает по кругу.
      if ([E.BUFFER_SEEK_OVER_HOLE, E.BUFFER_STALLED_ERROR, E.BUFFER_NUDGE_ON_STALL].includes(info.details)) {
        const now = Date.now();
        if (now - lastNudge > 500) {
          lastNudge = now;
          video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 0.3);
          hls.startLoad(video.currentTime);
        }
        return;
      }

      console.warn("hls.js:", info.type, info.details, info.response && info.response.code, info.url || "");
      if (info.type === window.Hls.ErrorTypes.NETWORK_ERROR && networkRetries < 3) {
        networkRetries += 1;
        hls.startLoad();
      } else if (info.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
        // восстановление не чаще пары раз за 10 секунд, потом — перезапуск источника с того же места
        const now = Date.now();
        mediaRecoveries = mediaRecoveries.filter((t) => now - t < 10_000);
        mediaRecoveries.push(now);
        if (mediaRecoveries.length === 1) hls.recoverMediaError();
        else if (mediaRecoveries.length === 2) { hls.swapAudioCodec(); hls.recoverMediaError(); }
        else play(source, video.currentTime || 0);
      } else {
        tryNextSource(source, `Видео не загрузилось (${info.details}).`);
      }
    });
    hls.loadSource(source.src);
    hls.attachMedia(video);
  } else {
    video.src = source.src;
    video.addEventListener("loadedmetadata", resume, { once: true });
  }
}

function currentQuality() {
  return data && data.qualities.find((x) => x.quality === qualitySelect.value);
}

// В одном качестве бывает несколько зеркал — при ошибке переходим к следующему
function tryNextSource(failed, errorText) {
  const list = currentQuality() ? currentQuality().sources : [];
  const next = list[list.indexOf(failed) + 1];
  if (next) play(next, video.currentTime || 0);
  else showError(errorText);
}

video.addEventListener("error", () => {
  if (hls || !video.getAttribute("src")) return; // ошибки hls.js обрабатываются выше
  const q = currentQuality();
  const current = q && q.sources.find((s) => video.src === s.src);
  const err = video.error;
  console.error("Ошибка видео:", err && err.code, err && err.message, video.currentSrc);
  tryNextSource(current, `Видео не воспроизводится в этом качестве (код ${err ? err.code : "?"}). Попробуйте другое.`);
});

function label(q) {
  return /^\d+$/.test(q) ? `${q}p` : "Авто";
}

// Показывает серию: заголовок, качества, кнопки, продолжение с места
function load(next) {
  data = next;
  hideUpNext();
  $("title").textContent = data.title;
  document.title = data.title;
  $("offline").hidden = !data.offline;
  $("prev").hidden = !data.hasPrev;
  $("next").hidden = !data.hasNext;

  qualitySelect.replaceChildren();
  for (const q of data.qualities) {
    const opt = document.createElement("option");
    opt.value = q.quality;
    opt.textContent = label(q.quality);
    qualitySelect.append(opt);
  }
  qualitySelect.disabled = data.qualities.length < 2;

  if (!data.qualities.length) {
    showError("Нет ссылок на видео.");
    return;
  }
  const preferred = savedQuality();
  if (preferred && data.qualities.some((q) => q.quality === preferred)) qualitySelect.value = preferred;
  play(currentQuality().sources[0], data.resumeAt || 0);
  if (data.resumeAt) notice(`Продолжаем с ${fmt(data.resumeAt)}`);
}

qualitySelect.addEventListener("change", () => {
  const q = currentQuality();
  if (!q) return;
  saveQuality(q.quality);
  play(q.sources[0], video.currentTime || 0);
});

// ---------- Прогресс ----------

let lastReport = 0;
function report(force = false) {
  if (!data || switching || !video.duration || !isFinite(video.duration)) return;
  const now = Date.now();
  if (!force && now - lastReport < 5000) return;
  lastReport = now;
  window.player.progress(video.currentTime, video.duration).catch(() => {});
}

video.addEventListener("timeupdate", () => report());
video.addEventListener("pause", () => report(true));
video.addEventListener("seeked", () => report(true));
window.addEventListener("beforeunload", () => report(true));

// ---------- Переключение серий ----------

async function go(direction) {
  if (switching || !data) return;
  if ((direction > 0 && !data.hasNext) || (direction < 0 && !data.hasPrev)) {
    notice(direction > 0 ? "Это последняя серия" : "Это первая серия");
    return;
  }
  report(true);
  switching = true;
  hideUpNext();
  video.pause();
  notice(direction > 0 ? "Загружаю следующую серию…" : "Загружаю предыдущую серию…", 20000);
  try {
    const res = await (direction > 0 ? window.player.next() : window.player.prev());
    if (!res.ok) throw new Error(res.error);
    if (res.data && res.data.waiting) {
      // следующая серия ещё качается — включится сама
      showWaiting(res.data.waiting);
    } else if (res.data) {
      // null — окно переключилось на плеер источника, эта страница сейчас закроется
      $("notice").hidden = true;
      load(res.data);
    }
  } catch (err) {
    notice("Не удалось переключить серию", 4000);
    console.error(err);
  } finally {
    switching = false;
  }
}

$("next").addEventListener("click", () => go(1));
$("prev").addEventListener("click", () => go(-1));

// ---------- Подхват докачавшихся серий ----------

function showWaiting(w) {
  const text = w.status === "downloading"
    ? `${w.name} ещё качается — ${w.percent}%. Включится сама, как только скачается`
    : `${w.name} в очереди на загрузку. Включится сама, как только скачается`;
  notice(text, 24 * 3600 * 1000);
}

window.player.onQueue((q) => {
  if (!data) return;
  data.hasNext = q.hasNext;
  data.hasPrev = q.hasPrev;
  $("next").hidden = !q.hasNext;
  $("prev").hidden = !q.hasPrev;
  if (q.waiting) showWaiting(q.waiting);
  else if (q.added) notice(`Скачалась ${q.added} — добавлена в очередь`);
});

// дождались следующую серию — главный процесс уже подготовил её
window.player.onLoad((next) => {
  $("notice").hidden = true;
  load(next);
});

// Автопереход после окончания серии
let countdownTimer = null;
function hideUpNext() {
  clearInterval(countdownTimer);
  countdownTimer = null;
  $("upnext").hidden = true;
}

video.addEventListener("ended", () => {
  report(true);
  if (!data || !data.hasNext) {
    notice("Это была последняя серия", 5000);
    return;
  }
  let left = NEXT_DELAY;
  $("countdown").textContent = left;
  $("upnext").hidden = false;
  countdownTimer = setInterval(() => {
    left -= 1;
    $("countdown").textContent = left;
    if (left <= 0) {
      hideUpNext();
      go(1);
    }
  }, 1000);
});
$("upnext-cancel").addEventListener("click", hideUpNext);
$("upnext-go").addEventListener("click", () => { hideUpNext(); go(1); });

// ---------- Своя панель управления ----------

const controls = $("controls");
const seek = $("seek");
const seekTip = $("seek-tip");
const playBtn = $("play");
const muteBtn = $("mute");
const volume = $("volume");
let dragging = false;

function togglePlay() {
  if (!video.getAttribute("src") && !hls) return;
  video.paused ? video.play().catch(() => {}) : video.pause();
}

function toggleFullscreen() {
  document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
}

// Полоса: сыгранное — акцентом, загруженное — светлее, остальное — фоном
function paintSeek(pos) {
  const d = video.duration;
  if (!d || !isFinite(d)) {
    seek.style.setProperty("--track", "rgba(255,255,255,.25)");
    return;
  }
  let buffered = pos;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= pos + 1 && video.buffered.end(i) > buffered) buffered = video.buffered.end(i);
  }
  const p = (pos / d) * 100;
  const b = (buffered / d) * 100;
  seek.style.setProperty("--track",
    `linear-gradient(to right, var(--accent) ${p}%, rgba(255,255,255,.5) ${p}%, rgba(255,255,255,.5) ${b}%, rgba(255,255,255,.2) ${b}%)`);
}

function updateTime() {
  const d = video.duration && isFinite(video.duration) ? video.duration : 0;
  const pos = dragging ? (seek.value / 1000) * d : (seekTarget ?? video.currentTime);
  $("time").textContent = `${fmt(pos || 0)} / ${fmt(d)}`;
  if (!dragging) seek.value = d ? Math.round((pos / d) * 1000) : 0;
  paintSeek(pos || 0);
}

["timeupdate", "durationchange", "progress", "loadedmetadata", "seeking"].forEach((ev) => video.addEventListener(ev, updateTime));
video.addEventListener("play", () => { playBtn.textContent = "❚❚"; });
video.addEventListener("pause", () => { playBtn.textContent = "▶"; });

seek.addEventListener("input", () => {
  dragging = true;
  updateTime();
});
seek.addEventListener("change", () => {
  const d = video.duration;
  if (d && isFinite(d)) {
    clearTimeout(seekTimer);
    seekTarget = null;
    video.currentTime = (seek.value / 1000) * d;
  }
  dragging = false;
  updateTime();
});

// Подсказка со временем над полосой при наведении
seek.addEventListener("mousemove", (e) => {
  const d = video.duration;
  if (!d || !isFinite(d)) return;
  const rect = seek.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  seekTip.textContent = fmt(ratio * d);
  seekTip.style.left = `${e.clientX}px`;
  seekTip.hidden = false;
});
seek.addEventListener("mouseleave", () => { seekTip.hidden = true; });

// Громкость запоминается между запусками
function paintVolume() {
  const v = video.muted ? 0 : video.volume;
  volume.value = Math.round(v * 100);
  volume.style.setProperty("--track", `linear-gradient(to right, #fff ${v * 100}%, rgba(255,255,255,.25) ${v * 100}%)`);
  muteBtn.textContent = v === 0 ? "🔇" : v < 0.5 ? "🔉" : "🔊";
}
try {
  const saved = JSON.parse(localStorage.getItem("volume"));
  if (saved) { video.volume = saved.v; video.muted = saved.m; }
} catch {}
video.addEventListener("volumechange", () => {
  paintVolume();
  try { localStorage.setItem("volume", JSON.stringify({ v: video.volume, m: video.muted })); } catch {}
});
volume.addEventListener("input", () => {
  video.volume = volume.value / 100;
  video.muted = video.volume === 0;
});
muteBtn.addEventListener("click", () => {
  if (video.muted && video.volume === 0) video.volume = 0.5;
  video.muted = !video.muted;
});
paintVolume();

playBtn.addEventListener("click", togglePlay);
$("fullscreen").addEventListener("click", toggleFullscreen);

// Клик по видео — пауза, двойной клик — полный экран (одиночный ждёт, не двойной ли это)
let clickTimer = null;
video.addEventListener("click", () => {
  clearTimeout(clickTimer);
  clickTimer = setTimeout(togglePlay, 220);
});
video.addEventListener("dblclick", () => {
  clearTimeout(clickTimer);
  toggleFullscreen();
});

// Кнопки не забирают фокус: иначе Пробел «нажимал» бы последнюю кликнутую кнопку
document.addEventListener("mousedown", (e) => {
  if (e.target.closest("button")) e.preventDefault();
});

// ---------- Горячие клавиши ----------
// Слушаем на самом раннем этапе (capture) и гасим событие — чтобы клавишу
// не обработал ещё кто-то (кнопка в фокусе, ползунок и т. п.) и не было двойного срабатывания.

const KEYS = {
  " ": () => togglePlay(), k: () => togglePlay(), "л": () => togglePlay(),
  f: () => toggleFullscreen(), "а": () => toggleFullscreen(),
  m: () => muteBtn.click(), "ь": () => muteBtn.click(),
  n: () => go(1), "т": () => go(1),
  p: () => go(-1), "з": () => go(-1),
  arrowright: (e) => (e.shiftKey ? skipOpening() : seekBy(settings.seekStep)),
  arrowleft: () => seekBy(-settings.seekStep),
  arrowup: () => { video.muted = false; video.volume = Math.min(1, video.volume + 0.1); },
  arrowdown: () => { video.volume = Math.max(0, video.volume - 0.1); },
};

window.addEventListener("keydown", (e) => {
  if (e.target === qualitySelect || e.ctrlKey || e.altKey || e.metaKey) return;
  const action = KEYS[e.key.toLowerCase()];
  if (!action) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat && !e.key.startsWith("Arrow")) return; // зажатый пробел не мигает паузой
  action(e);
  wake();
}, true);

// Пробел на отпускании тоже гасим — кнопки срабатывают именно на нём
window.addEventListener("keyup", (e) => {
  if (e.key === " " && e.target !== qualitySelect) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

// ---------- Скрытие панелей ----------
// Обе панели и курсор прячутся через 2,5 с без движения мыши, если видео играет
// и мышь не над панелью.

let idleTimer;
let overPanel = false;
for (const panel of [bar, controls]) {
  panel.addEventListener("mouseenter", () => { overPanel = true; wake(); });
  panel.addEventListener("mouseleave", () => { overPanel = false; wake(); });
}

function wake() {
  bar.classList.remove("hide");
  controls.classList.remove("hide");
  document.body.style.cursor = "";
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!video.paused && !overPanel && !dragging) {
      bar.classList.add("hide");
      controls.classList.add("hide");
      seekTip.hidden = true;
      document.body.style.cursor = "none";
    }
  }, 2500);
}
document.addEventListener("mousemove", wake);
document.addEventListener("mouseleave", () => { overPanel = false; });
video.addEventListener("pause", wake);
video.addEventListener("play", wake);
wake();

// ---------- Старт ----------

window.player.init()
  .then((res) => {
    if (!res.ok || !res.data) throw new Error(res.error || "Нет данных о серии");
    load(res.data);
  })
  .catch((err) => showError(err.message));
