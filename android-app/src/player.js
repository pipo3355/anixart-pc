// Полноэкранный плеер: скачанные серии и онлайн-просмотр (ctx.online). Раскладка как в Anixart:
// сверху «назад», название и серия, скорость, качество, замок;
// по центру предыдущая / пауза / следующая; снизу полоса, время, «пропустить», PiP, растянуть.

import { App } from "@capacitor/app";
import { StatusBar } from "@capacitor/status-bar";
import { ScreenOrientation } from "@capacitor/screen-orientation";
import { KeepAwake } from "@capacitor-community/keep-awake";
import { Device } from "./device.js";
import { downloads } from "./downloads.js";
import { setProgress, progressOf, setWatched } from "./api.js";
import { settings } from "./settings.js";
import { onlineQualities, pickOnlineQuality, candidatesFor, proxyLoader } from "./online.js";
import { getSkipTimes } from "../../skiptimes.js";

const WATCHED_AT = 0.85;
const HIDE_AFTER_MS = 3000;
const NEXT_DELAY = 5;
const SPEEDS = [[0.5, "0.5×"], [0.75, "0.75×"], [1, "Обычн."], [1.25, "1.25×"], [1.5, "1.5×"], [2, "2×"]];

const I = {
  back: '<svg viewBox="0 0 24 24"><path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zM18.5 5.6v12.8a.8.8 0 0 1-1.2.7L9.5 12.7a.8.8 0 0 1 0-1.4l7.8-6.4a.8.8 0 0 1 1.2.7z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M16 5h2v14h-2zM5.5 5.6v12.8a.8.8 0 0 0 1.2.7l7.8-6.4a.8.8 0 0 0 0-1.4L6.7 4.9a.8.8 0 0 0-1.2.7z"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><path d="M17 9h-1V7a4 4 0 0 0-8 0v2H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zm-7-2a2 2 0 0 1 4 0v2h-4zm2 11a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/></svg>',
  unlock: '<svg viewBox="0 0 24 24"><path d="M17 9H10V7a2 2 0 0 1 3.9-.6l1.9-.6A4 4 0 0 0 8 7v2H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zm-5 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/></svg>',
  speed: '<svg viewBox="0 0 24 24"><path d="M12 4a8 8 0 1 0 8 8h-2a6 6 0 1 1-6-6zm.9 8.4 4.6-4.6-1.4-1.4-4.6 4.6a1.5 1.5 0 1 0 1.4 1.4z"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" class="chev"><path d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z"/></svg>',
  skip: '<svg viewBox="0 0 24 24"><path d="M5.6 6 4.2 7.4 8.8 12l-4.6 4.6L5.6 18l6-6zm7 0-1.4 1.4 4.6 4.6-4.6 4.6 1.4 1.4 6-6z"/></svg>',
  pip: '<svg viewBox="0 0 24 24"><path d="M19 7h-8v6h8zm2-4H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16H3V5h18z"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M12.3 2a10 10 0 1 0 9.7 12.5A8 8 0 0 1 12.3 2z"/></svg>',
  fit: '<svg viewBox="0 0 24 24"><path d="M14 3h7v7h-2V6.4l-4.3 4.3-1.4-1.4L17.6 5H14zM3 14h2v3.6l4.3-4.3 1.4 1.4L6.4 19H10v2H3z"/></svg>',
};

const $ = (sel, root = document) => root.querySelector(sel);
const fmt = (sec) => {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
};

class Player {
  constructor() {
    this.root = null;
    this.hls = null;
    this.ctx = null; // { releaseTitle, items:[download], index }
    this.marked = false;
    this.locked = false;
    this.fill = false;
    this.hideTimer = null;
    this.lastReport = 0;
    this.countdown = null;
    this.backHandle = null;
    this.pipHandle = null;
    this.onClose = null;
  }

  build() {
    const root = document.createElement("div");
    root.className = "player";
    root.hidden = true;
    root.innerHTML = `
      <video playsinline webkit-playsinline preload="auto"></video>
      <div class="p-gesture"></div>
      <div class="p-boost" hidden></div>
      <div class="p-swipe" hidden><b class="p-swipe-delta"></b><span class="p-swipe-to"></span></div>
      <div class="p-ripple left"><span></span></div>
      <div class="p-ripple right"><span></span></div>
      <div class="p-ui">
        <div class="p-shade"></div>
        <div class="p-top">
          <button class="p-ic" data-a="back">${I.back}</button>
          <div class="p-titles"><div class="p-t1"></div><div class="p-t2"></div></div>
          <div class="p-sp"></div>
          <button class="p-pill" data-a="speed">${I.speed}<span class="p-speed">Обычн.</span>${I.chevron}</button>
          <button class="p-pill" data-a="quality"><b class="p-hq">HQ</b><span class="p-q"></span>${I.chevron}</button>
          <button class="p-pill" data-a="sleep">${I.moon}<span class="p-sleep">Сон</span></button>
          <button class="p-ic" data-a="lock">${I.unlock}</button>
        </div>
        <div class="p-center">
          <button class="p-round" data-a="prev">${I.prev}</button>
          <button class="p-round big" data-a="play">${I.play}</button>
          <button class="p-round" data-a="next">${I.next}</button>
        </div>
        <div class="p-bottom">
          <div class="p-seek-wrap">
            <input class="p-seek" type="range" min="0" max="1000" value="0" step="1" />
            <div class="p-marks"></div>
          </div>
          <div class="p-row">
            <span class="p-time">00:00 / 00:00</span>
            <div class="p-sp"></div>
            <button class="p-ic" data-a="skip">${I.skip}</button>
            <button class="p-ic" data-a="pip">${I.pip}</button>
            <button class="p-ic" data-a="fit">${I.fit}</button>
          </div>
        </div>
      </div>
      <button class="p-unlock" data-a="unlock" hidden>${I.lock}</button>
      <div class="p-toast" hidden></div>
      <div class="p-menu" hidden><div class="p-menu-box"></div></div>
      <div class="p-wait" hidden></div>
      <button class="p-skipseg" data-a="skipseg" hidden></button>
      <div class="p-upnext" hidden>
        <div>Следующая серия через <b class="p-count">5</b>…</div>
        <div class="p-upnext-row"><button data-a="upnext-cancel" class="ghost">Отмена</button><button data-a="upnext-go">Смотреть</button></div>
      </div>`;
    document.body.append(root);
    this.root = root;
    this.video = $("video", root);
    this.seek = $(".p-seek", root);
    this.bindEvents();
  }

  // ---------- открыть / закрыть ----------

  async open(ctx, onClose) {
    if (!this.root) this.build();
    this.ctx = ctx;
    this.onClose = onClose;
    this.root.hidden = false;
    document.body.classList.add("playing");
    this.locked = false;
    this.applyLock();
    this.offDownloads = downloads.on((list) => this.syncItems(list));
    this.backHandle = await App.addListener("backButton", () => this.close());
    this.pipHandle = await Device.addListener("pipChanged", ({ active }) => {
      this.root.classList.toggle("pip", active);
      if (active) this.hideUi(true);
    });
    // горизонтально в обе стороны (по датчику); стандартный lock("landscape") держит только одну сторону
    try { await Device.setOrientation({ mode: "landscape" }); } catch { try { await ScreenOrientation.lock({ orientation: "landscape" }); } catch {} }
    // полный экран: строка состояния и навигация не возвращаются от касаний, только свайпом от края
    try { await Device.setImmersive({ on: true }); } catch { try { await StatusBar.hide(); } catch {} }
    try { await KeepAwake.keepAwake(); } catch {}
    await this.load();
  }

  async close() {
    if (!this.ctx) return;
    if (this.stopBoost) this.stopBoost();
    clearInterval(this.sleepTick); this.sleepTick = null; this.sleepAt = 0; this.sleepAtEnd = false;
    if (this.root) $(".p-sleep", this.root).textContent = "Сон";
    this.report(true);
    this.stopCountdown();
    this.loadToken = (this.loadToken || 0) + 1; // недогруженная онлайн-серия не должна включиться после закрытия
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.root.hidden = true;
    document.body.classList.remove("playing");
    this.ctx = null;
    this.waitFor = null;
    $(".p-wait", this.root).hidden = true;
    if (this.offDownloads) { this.offDownloads(); this.offDownloads = null; }
    if (this.backHandle) { this.backHandle.remove(); this.backHandle = null; }
    if (this.pipHandle) { this.pipHandle.remove(); this.pipHandle = null; }
    try { await Device.setOrientation({ mode: "any" }); } catch { try { await ScreenOrientation.unlock(); } catch {} }
    try { await Device.setImmersive({ on: false }); } catch { try { await StatusBar.show(); } catch {} }
    try { await KeepAwake.allowSleep(); } catch {}
    if (this.onClose) this.onClose();
  }

  current() { return this.ctx.items[this.ctx.index]; }

  // Список серий в плеере = все скачанные серии тайтла. Если, пока смотришь,
  // докачалась ещё одна — она сразу появляется в очереди (кнопка ⏭, автопереход).
  syncItems(list) {
    if (!this.ctx || this.ctx.online) return; // онлайн: список серий = все серии озвучки
    const cur = this.current();
    const done = list
      .filter((d) => d.releaseId === cur.releaseId && d.status === "done")
      .sort((a, b) => a.position - b.position)
      .filter((d, i, arr) => i === 0 || arr[i - 1].position !== d.position);
    if (!done.some((d) => d.position === cur.position)) return; // текущую удалили — не трогаем
    const known = new Set(this.ctx.items.map((d) => d.position));
    this.ctx.items = done;
    this.ctx.index = done.findIndex((d) => d.position === cur.position);
    this.updateNavButtons();
    if (this.waitFor == null) {
      const added = done.find((d) => !known.has(d.position) && d.position > cur.position);
      if (added) this.toast(`Скачалась ${added.name} — добавлена в очередь`, 2500);
    }
    // ждали следующую серию — она готова
    if (this.waitFor != null) {
      const ready = done.find((d) => d.position === this.waitFor);
      if (ready) {
        this.waitFor = null;
        $(".p-wait", this.root).hidden = true;
        this.ctx.index = done.indexOf(ready);
        this.load();
      } else {
        this.renderWait(list);
      }
    }
  }

  updateNavButtons() {
    $('[data-a="prev"]', this.root).disabled = this.ctx.index === 0;
    $('[data-a="next"]', this.root).disabled = this.ctx.index >= this.ctx.items.length - 1 && !this.nextPending(downloads.list());
  }

  // Следующая по номеру серия, которая ещё качается или стоит в очереди
  nextPending(list) {
    if (this.ctx.online) return null;
    const cur = this.current();
    return list
      .filter((d) => d.releaseId === cur.releaseId && d.position > cur.position && (d.status === "queued" || d.status === "downloading"))
      .sort((a, b) => a.position - b.position)[0] || null;
  }

  renderWait(list) {
    const d = list.find((x) => x.releaseId === this.current().releaseId && x.position === this.waitFor);
    const box = $(".p-wait", this.root);
    if (!d || (d.status !== "queued" && d.status !== "downloading")) {
      this.waitFor = null;
      box.hidden = true;
      this.toast("Следующую серию не удалось скачать", 3000);
      return;
    }
    box.textContent = d.status === "downloading"
      ? `${d.name} ещё качается — ${Math.floor((d.progress || 0) * 100)}%. Включится сама, как только скачается`
      : `${d.name} в очереди на загрузку. Включится сама, как только скачается`;
    box.hidden = false;
  }

  async load() {
    if (this.stopBoost) this.stopBoost();
    const it = this.current();
    this.marked = false;
    this.stopCountdown();
    this.skip = it.skip || null;
    this.skipped = { op: false, ed: false };
    $(".p-marks", this.root).replaceChildren();
    $(".p-skipseg", this.root).hidden = true;
    if (it.online) {
      const copy = this.localCopy(it);
      if (copy && copy.skip) this.skip = copy.skip;
      else if (it.skip === undefined) this.fetchOnlineSkips(it);
    } else if (downloads.needsSkips(it)) {
      // тайминги ещё не искали (серия скачана старой версией) — ищем, пока есть интернет
      downloads.fetchSkips(it).then((skip) => {
        if (this.ctx && this.current().id === it.id && skip) { this.skip = skip; this.drawMarks(); }
      }).catch(() => {});
    }
    $(".p-t1", this.root).textContent = this.ctx.releaseTitle;
    $(".p-t2", this.root).textContent = it.name;
    $(".p-q", this.root).textContent = it.online ? "…" : /^\d+$/.test(it.quality || "") ? `${it.quality}p` : "Авто";
    this.updateNavButtons();

    const saved = await progressOf(it.releaseId, it.position);
    const resumeAt = this.resumeOverride != null ? this.resumeOverride
      : saved && saved.d && saved.t > 10 && saved.t < saved.d - 30 ? saved.t : 0;
    this.resumeOverride = null;
    const token = (this.loadToken = (this.loadToken || 0) + 1);

    if (this.hls) { this.hls.destroy(); this.hls = null; }
    this.video.removeAttribute("src");
    this.candidates = [];

    // онлайн-серия, которая уже скачана, — играем с телефона
    const local = it.online ? this.localCopy(it) : it;
    if (local) {
      this.online = false;
      const src = await downloads.playUrl(local);
      if (token !== this.loadToken) return;
      $(".p-q", this.root).textContent = /^\d+$/.test(local.quality || "") ? `${local.quality}p` : "Авто";
      this.attach({ src, hls: local.kind === "hls" }, resumeAt);
    } else {
      this.online = true;
      const wait = $(".p-wait", this.root);
      wait.textContent = "Загружаю видео…";
      wait.hidden = false;
      try {
        if (!it.qualities) it.qualities = await onlineQualities(it.url);
        if (token !== this.loadToken) return;
        if (!it.qualities.length) throw new Error("Нет доступных ссылок на видео");
        const q = pickOnlineQuality(it.qualities, it.quality || settings.get().onlineQuality || settings.get().quality);
        it.quality = q.quality;
        $(".p-q", this.root).textContent = /^\d+$/.test(q.quality) ? `${q.quality}p` : "Авто";
        this.candidates = candidatesFor(q);
        wait.hidden = true;
        this.attach(this.candidates.shift(), resumeAt);
      } catch (err) {
        if (token !== this.loadToken) return;
        wait.hidden = true;
        this.toast(`Не удалось загрузить видео: ${(err && err.message) || err}`, 6000);
      }
    }
    this.updateSpeedLabel();
    this.showUi();
  }

  // Скачанная копия онлайн-серии (та же озвучка и источник)
  localCopy(it) {
    const d = downloads.findFor(it.releaseId, it.position, it.sourceId);
    return d && d.status === "done" && d.sourceId === it.sourceId ? d : null;
  }

  // Подключить источник к <video>. При ошибке онлайн-источника пробуем следующий вариант.
  attach(cand, resumeAt) {
    const token = this.loadToken;
    const start = () => {
      if (token !== this.loadToken) return;
      this.attachStarted = true;
      if (resumeAt) {
        this.video.currentTime = resumeAt;
        if (!this.quietResume) this.toast(`Продолжаем с ${fmt(resumeAt)}`);
      }
      this.quietResume = false;
      this.video.playbackRate = settings.get().speed || 1;
      this.video.play().catch(() => {});
    };
    this.attachStarted = false;
    this.attachResume = resumeAt;
    if (cand.hls && window.Hls && window.Hls.isSupported()) {
      // startPosition: hls.js сразу грузит нужное место, а не начало
      const cfg = { enableWorker: false, maxBufferHole: 0.5, backBufferLength: 90, startPosition: resumeAt > 0 ? resumeAt : -1 };
      const loader = this.online ? proxyLoader(window.Hls) : null;
      if (loader) cfg.loader = loader; // undefined здесь сломал бы загрузчик по умолчанию
      this.hls = new window.Hls(cfg);
      this.hls.on(window.Hls.Events.MANIFEST_PARSED, start);
      this.hls.on(window.Hls.Events.ERROR, (_e, info) => {
        if (!info.fatal || token !== this.loadToken) return;
        if (info.type === window.Hls.ErrorTypes.MEDIA_ERROR) { this.hls.recoverMediaError(); return; }
        if (this.online) {
          if (info.type === window.Hls.ErrorTypes.NETWORK_ERROR && this.attachStarted) { this.hls.startLoad(); return; }
          this.tryNextSource(info.details);
          return;
        }
        this.toast(`Файл серии повреждён (${info.details}). Удалите и скачайте её заново.`, 6000);
      });
      this.hls.loadSource(cand.src);
      this.hls.attachMedia(this.video);
    } else {
      this.video.src = cand.src;
      this.video.addEventListener("loadedmetadata", start, { once: true });
    }
  }

  // Где мы в серии. Пока новый источник (другое качество) не загрузился и не перемотан,
  // <video> показывает 0 — тогда верим месту, куда собирались перейти.
  position() {
    const v = this.video;
    if (this.attachStarted && v.readyState >= 1 && v.currentTime > 0.5) return v.currentTime;
    return this.attachResume || v.currentTime || 0;
  }

  tryNextSource(reason) {
    const next = this.candidates.shift();
    if (!next) {
      this.toast(`Видео не открылось${reason ? ` (${reason})` : ""}. Попробуйте другую озвучку или источник.`, 6000);
      return;
    }
    console.warn("[player] источник не открылся, пробую следующий:", reason);
    const at = this.position();
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    this.quietResume = true;
    this.attach(next, at);
  }

  // Онлайн: сменить качество, продолжив с того же места
  switchQuality(quality) {
    const it = this.current();
    if (it.quality === quality) return;
    it.quality = quality;
    settings.set({ onlineQuality: quality });
    this.resumeOverride = this.position();
    this.quietResume = true;
    this.load();
  }

  // Тайминги опенинга/эндинга для онлайн-серии (у скачанных они хранятся с серией)
  fetchOnlineSkips(it) {
    const r = this.ctx.release || {};
    getSkipTimes({ id: it.releaseId, titleOriginal: r.titleOriginal, titleRu: this.ctx.releaseTitle, year: r.year },
      { position: it.position, url: it.url })
      .then((found) => {
        it.skip = found ? { op: found.op, ed: found.ed } : null;
        if (this.ctx && this.current() === it && it.skip) { this.skip = it.skip; this.drawMarks(); }
      })
      .catch(() => {});
  }

  async go(delta) {
    const i = this.ctx.index + delta;
    if (delta > 0 && i >= this.ctx.items.length) {
      const pending = this.nextPending(downloads.list());
      if (pending) {
        this.report(true);
        this.waitFor = pending.position;
        this.renderWait(downloads.list());
      }
      return;
    }
    if (i < 0 || i >= this.ctx.items.length) return;
    this.report(true);
    this.ctx.index = i;
    await this.load();
  }

  // ---------- прогресс и отметки ----------

  report(force = false) {
    if (!this.ctx) return;
    const v = this.video;
    if (!v.duration || !isFinite(v.duration)) return;
    // новый источник ещё не перемотан на нужное место — не затираем прогресс нулём
    if (this.attachResume > 0 && !(this.attachStarted && v.currentTime > 0.5)) return;
    const now = Date.now();
    if (!force && now - this.lastReport < 5000) return;
    this.lastReport = now;
    const it = this.current();
    setProgress(it.releaseId, it.position, v.currentTime, v.duration);
    if (!this.marked && v.currentTime / v.duration >= WATCHED_AT) {
      this.marked = true;
      downloads.setWatched(it.releaseId, it.position, true);
      setWatched(it.releaseId, it.sourceId, it.position, true).catch(() => { this.marked = false; });
    }
  }

  // ---------- интерфейс ----------

  showUi() {
    if (this.locked) { this.flashUnlock(); return; }
    this.root.classList.remove("ui-hidden");
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hideUi(), HIDE_AFTER_MS);
  }

  hideUi(force = false) {
    if (!force && (this.video.paused || this.seeking || !$(".p-menu", this.root).hidden)) return;
    this.root.classList.add("ui-hidden");
  }

  toggleUi() {
    if (this.root.classList.contains("ui-hidden")) this.showUi();
    else this.hideUi(true);
  }

  applyLock() {
    this.root.classList.toggle("locked", this.locked);
    $(".p-unlock", this.root).hidden = !this.locked;
    if (this.locked) { this.root.classList.add("ui-hidden"); this.flashUnlock(); }
    else this.showUi();
  }

  flashUnlock() {
    const b = $(".p-unlock", this.root);
    b.classList.add("show");
    clearTimeout(this.unlockTimer);
    this.unlockTimer = setTimeout(() => b.classList.remove("show"), 2000);
  }

  toast(text, ms = 1600) {
    const t = $(".p-toast", this.root);
    t.textContent = text;
    t.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  ripple(side, text) {
    const r = $(`.p-ripple.${side}`, this.root);
    $("span", r).textContent = text;
    r.classList.remove("on");
    void r.offsetWidth;
    r.classList.add("on");
  }

  seekBy(sec) {
    const v = this.video;
    if (!v.duration) return;
    v.currentTime = Math.max(0, Math.min(v.duration - 0.5, v.currentTime + sec));
  }

  updateTime() {
    const v = this.video;
    const d = v.duration && isFinite(v.duration) ? v.duration : 0;
    const pos = this.seeking ? (this.seek.value / 1000) * d : v.currentTime;
    $(".p-time", this.root).textContent = `${fmt(pos)} / ${fmt(d)}`;
    if (!this.seeking) this.seek.value = d ? Math.round((v.currentTime / d) * 1000) : 0;
    let buf = pos;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= pos + 1 && v.buffered.end(i) > buf) buf = v.buffered.end(i);
    }
    const p = d ? (pos / d) * 100 : 0;
    const b = d ? (buf / d) * 100 : 0;
    this.seek.style.setProperty("--fill",
      `linear-gradient(to right, var(--accent) ${p}%, rgba(255,255,255,.55) ${p}%, rgba(255,255,255,.55) ${b}%, rgba(255,255,255,.3) ${b}%)`);
  }

  updatePlayIcon() {
    $('[data-a="play"]', this.root).innerHTML = this.video.paused ? I.play : I.pause;
  }

  updateSpeedLabel() {
    const s = this.video.playbackRate || 1;
    const found = SPEEDS.find(([v]) => v === s);
    $(".p-speed", this.root).textContent = found ? found[1] : `${s}×`;
  }

  menu(title, options, current, onPick) {
    const m = $(".p-menu", this.root);
    const box = $(".p-menu-box", m);
    box.innerHTML = "";
    const h = document.createElement("div");
    h.className = "p-menu-title";
    h.textContent = title;
    box.append(h);
    for (const [value, label, note] of options) {
      const b = document.createElement("button");
      b.className = "p-menu-item" + (value === current ? " on" : "");
      b.innerHTML = `<span>${label}</span>${note ? `<small>${note}</small>` : ""}`;
      b.addEventListener("click", (e) => { e.stopPropagation(); m.hidden = true; if (onPick) onPick(value); this.showUi(); });
      box.append(b);
    }
    m.hidden = false;
    clearTimeout(this.hideTimer);
  }

  // ---------- опенинг и эндинг ----------

  segmentAt(t) {
    if (!this.skip) return null;
    for (const kind of ["op", "ed"]) {
      const sg = this.skip[kind];
      if (sg && t >= sg.start && t < sg.end - 0.5) return { kind, ...sg };
    }
    return null;
  }

  drawMarks() {
    const box = $(".p-marks", this.root);
    box.replaceChildren();
    const d = this.video.duration;
    if (!this.skip || !d || !isFinite(d)) return;
    for (const kind of ["op", "ed"]) {
      const sg = this.skip[kind];
      if (!sg) continue;
      const m = document.createElement("div");
      m.className = `p-mark ${kind}`;
      m.style.left = `${(sg.start / d) * 100}%`;
      m.style.width = `${((Math.min(sg.end, d) - sg.start) / d) * 100}%`;
      box.append(m);
    }
  }

  jumpSegment(seg) {
    this.skipped[seg.kind] = true;
    this.video.currentTime = Math.min(seg.end, (this.video.duration || seg.end) - 0.3);
    this.toast(seg.kind === "op" ? "Опенинг пропущен" : "Эндинг пропущен");
  }

  checkSegments() {
    const mode = settings.get().skipMode || "button";
    const btn = $(".p-skipseg", this.root);
    const seg = mode === "off" ? null : this.segmentAt(this.video.currentTime);
    if (seg && mode === "auto" && !this.skipped[seg.kind]) {
      this.jumpSegment(seg);
      btn.hidden = true;
      return;
    }
    if (seg && mode === "button") {
      btn.textContent = seg.kind === "op" ? "Пропустить опенинг ⏩" : "Пропустить эндинг ⏩";
      btn.hidden = false;
    } else {
      btn.hidden = true;
    }
  }

  // ---------- таймер сна ----------
  // Через выбранное время (или в конце серии) — пауза. Живёт, пока открыт плеер.

  setSleep(value) {
    clearInterval(this.sleepTick);
    this.sleepTick = null;
    this.sleepAt = 0;
    this.sleepAtEnd = value === "end";
    const label = $(".p-sleep", this.root);
    label.textContent = "Сон";
    if (!value) { this.toast("Таймер сна выключен"); return; }
    if (this.sleepAtEnd) { label.textContent = "В конце"; this.toast("🌙 Пауза в конце этой серии"); return; }
    this.sleepAt = Date.now() + value * 60_000;
    this.toast(`🌙 Пауза через ${value} мин`);
    const tick = () => {
      const left = Math.max(0, this.sleepAt - Date.now());
      label.textContent = fmt(left / 1000);
      if (!left) this.fireSleep();
    };
    tick();
    this.sleepTick = setInterval(tick, 1000);
  }

  fireSleep() {
    clearInterval(this.sleepTick);
    this.sleepTick = null;
    this.sleepAt = 0;
    this.sleepAtEnd = false;
    $(".p-sleep", this.root).textContent = "Сон";
    this.stopCountdown();
    this.video.pause();
    this.toast("🌙 Таймер сна — пауза", 5000);
    this.showUi();
  }

  startCountdown() {
    if (this.ctx.index >= this.ctx.items.length - 1) {
      if (this.nextPending(downloads.list())) { this.go(1); this.showUi(); return; }
      this.toast(this.ctx.online ? "Это была последняя серия" : "Это была последняя скачанная серия", 3000);
      this.showUi();
      return;
    }
    let left = NEXT_DELAY;
    const box = $(".p-upnext", this.root);
    $(".p-count", box).textContent = left;
    box.hidden = false;
    this.countdown = setInterval(() => {
      left -= 1;
      $(".p-count", box).textContent = left;
      if (left <= 0) { this.stopCountdown(); this.go(1); }
    }, 1000);
  }

  stopCountdown() {
    clearInterval(this.countdown);
    this.countdown = null;
    if (this.root) $(".p-upnext", this.root).hidden = true;
  }

  // ---------- события ----------

  bindEvents() {
    const v = this.video;
    ["timeupdate", "durationchange", "progress", "loadedmetadata"].forEach((e) => v.addEventListener(e, () => this.updateTime()));
    v.addEventListener("timeupdate", () => { this.report(); this.checkSegments(); });
    v.addEventListener("durationchange", () => this.drawMarks());
    v.addEventListener("pause", () => { this.updatePlayIcon(); this.report(true); this.showUi(); });
    v.addEventListener("play", () => { this.updatePlayIcon(); this.showUi(); });
    v.addEventListener("ratechange", () => { if (this.boostedFrom == null) this.updateSpeedLabel(); });
    v.addEventListener("ended", () => {
      this.report(true);
      if (this.sleepAtEnd) { this.fireSleep(); return; } // «в конце серии» — следующую не включаем
      this.startCountdown();
    });
    v.addEventListener("error", () => {
      if (!this.ctx || this.hls || !v.getAttribute("src")) return; // ошибки hls.js обрабатываются отдельно
      if (this.online) { this.tryNextSource(v.error && v.error.message); return; }
      this.toast("Не удалось открыть файл серии. Удалите её и скачайте заново.", 6000);
    });

    this.seek.addEventListener("input", () => { this.seeking = true; this.updateTime(); clearTimeout(this.hideTimer); });
    this.seek.addEventListener("change", () => {
      if (v.duration) v.currentTime = (this.seek.value / 1000) * v.duration;
      this.seeking = false;
      this.showUi();
    });

    // Касания по видео:
    //  • одно — показать/скрыть панели;
    //  • двойное слева/справа — перемотка на шаг из настроек;
    //  • свайп влево/вправо — плавная перемотка, прыжок при отпускании пальца.
    const gesture = $(".p-gesture", this.root);
    const swipeBox = $(".p-swipe", this.root);
    let lastTap = 0;
    let tapTimer = null;
    let streak = 0;
    let touch = null; // { id, x, y, t0, swiping, target }
    let swallowClick = false;

    // Долгое нажатие: пока палец на экране — скорость ×2 от текущей (×1.5 → ×3)
    const HOLD_MS = 450;
    let holdTimer = null;
    const boostBox = $(".p-boost", this.root);
    this.stopBoost = () => {
      clearTimeout(holdTimer);
      holdTimer = null;
      if (this.boostedFrom == null) return;
      v.playbackRate = this.boostedFrom;
      this.boostedFrom = null;
      boostBox.hidden = true;
    };
    const startBoost = () => {
      holdTimer = null;
      if (!touch || touch.swiping || this.boostedFrom != null) return;
      this.boostedFrom = v.playbackRate || 1;
      v.playbackRate = Math.min(16, this.boostedFrom * 2);
      if (v.paused) v.play().catch(() => {});
      boostBox.textContent = `▶▶ ×${+v.playbackRate.toFixed(2)}`;
      boostBox.hidden = false;
      clearTimeout(tapTimer);
      try { navigator.vibrate && navigator.vibrate(15); } catch {}
    };

    const swipeSeconds = (dx) => {
      // весь экран по ширине = 2 минуты (или вся серия, если она короче); к краям быстрее
      const span = Math.min(v.duration || 120, 120);
      const ratio = dx / window.innerWidth;
      return Math.sign(ratio) * Math.pow(Math.abs(ratio), 1.4) * span * 1.6;
    };

    gesture.addEventListener("pointerdown", (e) => {
      if (this.locked || !v.duration) return;
      touch = { id: e.pointerId, x: e.clientX, y: e.clientY, t0: v.currentTime, swiping: false, target: v.currentTime };
      clearTimeout(holdTimer);
      holdTimer = setTimeout(startBoost, HOLD_MS);
    });
    gesture.addEventListener("pointermove", (e) => {
      if (!touch || e.pointerId !== touch.id) return;
      const dx = e.clientX - touch.x;
      const dy = e.clientY - touch.y;
      if (this.boostedFrom != null) return; // во время ускорения палец может двигаться
      if (!touch.swiping) {
        if (Math.abs(dx) > 12 || Math.abs(dy) > 12) { clearTimeout(holdTimer); holdTimer = null; }
        if (Math.abs(dx) < 18 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        touch.swiping = true;
        try { gesture.setPointerCapture(e.pointerId); } catch {}
        clearTimeout(tapTimer);
        clearTimeout(this.hideTimer);
        this.seeking = true;
      }
      touch.target = Math.max(0, Math.min(v.duration - 0.5, touch.t0 + swipeSeconds(dx)));
      const delta = touch.target - touch.t0;
      $(".p-swipe-delta", swipeBox).textContent = `${delta >= 0 ? "+" : "−"}${fmt(Math.abs(delta))}`;
      $(".p-swipe-to", swipeBox).textContent = `${fmt(touch.target)} / ${fmt(v.duration)}`;
      swipeBox.hidden = false;
      this.seek.value = Math.round((touch.target / v.duration) * 1000);
      this.updateTime();
    });
    const endSwipe = (e) => {
      if (!touch || (e && e.pointerId !== touch.id)) return;
      clearTimeout(holdTimer);
      holdTimer = null;
      if (this.boostedFrom != null) {
        this.stopBoost();
        swallowClick = true; // отпускание после долгого нажатия — не касание
        setTimeout(() => { swallowClick = false; }, 350);
        touch = null;
        return;
      }
      if (touch.swiping) {
        v.currentTime = touch.target;
        swallowClick = true; // после свайпа браузер пришлёт «клик» — его не считаем касанием
        setTimeout(() => { swallowClick = false; }, 350);
      }
      swipeBox.hidden = true;
      this.seeking = false;
      touch = null;
      this.updateTime();
    };
    gesture.addEventListener("pointerup", endSwipe);
    gesture.addEventListener("pointercancel", () => {
      this.stopBoost();
      if (touch) { swipeBox.hidden = true; this.seeking = false; touch = null; }
    });
    gesture.addEventListener("contextmenu", (e) => e.preventDefault()); // долгое нажатие не открывает меню

    gesture.addEventListener("click", (e) => {
      if (swallowClick) { swallowClick = false; this.showUi(); return; }
      if (this.locked) { this.flashUnlock(); return; }
      const now = Date.now();
      const x = e.clientX / window.innerWidth;
      const side = x < 0.4 ? "left" : x > 0.6 ? "right" : null;
      if (side && now - lastTap < 300) {
        clearTimeout(tapTimer);
        const step = settings.get().seekStep || 10;
        streak = streak + step;
        this.seekBy(side === "left" ? -step : step);
        this.ripple(side, `${side === "left" ? "−" : "+"}${streak} с`);
        lastTap = now;
        return;
      }
      streak = 0;
      lastTap = now;
      clearTimeout(tapTimer);
      tapTimer = setTimeout(() => this.toggleUi(), side ? 260 : 0);
    });

    this.root.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-a]");
      if (!btn) {
        if (e.target.closest(".p-menu") && !e.target.closest(".p-menu-box")) $(".p-menu", this.root).hidden = true;
        return;
      }
      e.stopPropagation();
      const a = btn.dataset.a;
      if (a !== "unlock" && this.locked) return;
      switch (a) {
        case "back": this.close(); break;
        case "play": v.paused ? v.play().catch(() => {}) : v.pause(); this.showUi(); break;
        case "prev": this.go(-1); break;
        case "next": this.go(1); this.showUi(); break;
        case "skip": {
          const seg = this.segmentAt(v.currentTime);
          if (seg) { this.jumpSegment(seg); this.showUi(); break; }
          const sec = settings.get().skipOpening || 85;
          this.seekBy(sec);
          this.toast(`+${sec} с`);
          this.showUi();
          break;
        }
        case "skipseg": {
          const seg = this.segmentAt(v.currentTime);
          if (seg) this.jumpSegment(seg);
          btn.hidden = true;
          break;
        }
        case "sleep":
          this.menu("Таймер сна", [[0, "Выключен"], [15, "15 минут"], [30, "30 минут"], [45, "45 минут"], [60, "1 час"], [90, "1,5 часа"], ["end", "В конце серии"]],
            this.sleepAtEnd ? "end" : this.sleepAt ? null : 0, (val) => this.setSleep(val));
          break;
        case "fit":
          this.fill = !this.fill;
          this.root.classList.toggle("fill", this.fill);
          this.toast(this.fill ? "Растянуть на экран" : "Вписать в экран");
          this.showUi();
          break;
        case "pip":
          try {
            await Device.enterPip({ width: v.videoWidth || 16, height: v.videoHeight || 9 });
          } catch (err) {
            this.toast(err.message || "Картинка в картинке недоступна", 3000);
          }
          break;
        case "lock": this.locked = true; this.applyLock(); break;
        case "unlock": this.locked = false; this.applyLock(); break;
        case "speed":
          this.menu("Скорость", SPEEDS.map(([s, l]) => [s, l]), v.playbackRate, (s) => {
            v.playbackRate = s;
            settings.set({ speed: s });
          });
          break;
        case "quality": {
          const it = this.current();
          const label = (x) => (/^\d+$/.test(x || "") ? `${x}p` : "Авто");
          if (this.online && it.qualities && it.qualities.length) {
            this.menu("Качество", it.qualities.map((q) => [q.quality, label(q.quality)]), it.quality, (val) => this.switchQuality(val));
          } else {
            const local = it.online ? this.localCopy(it) : it;
            const qq = local ? local.quality : it.quality;
            this.menu("Качество", [[qq, label(qq), "скачано"]], qq, null);
          }
          break;
        }
        case "upnext-cancel": this.stopCountdown(); this.showUi(); break;
        case "upnext-go": this.stopCountdown(); this.go(1); break;
      }
    });
  }
}

export const player = new Player();
