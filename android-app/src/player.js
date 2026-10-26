// Полноэкранный плеер для скачанных серий. Раскладка как в Anixart:
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
          <button class="p-ic" data-a="lock">${I.unlock}</button>
        </div>
        <div class="p-center">
          <button class="p-round" data-a="prev">${I.prev}</button>
          <button class="p-round big" data-a="play">${I.play}</button>
          <button class="p-round" data-a="next">${I.next}</button>
        </div>
        <div class="p-bottom">
          <input class="p-seek" type="range" min="0" max="1000" value="0" step="1" />
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
    try { await ScreenOrientation.lock({ orientation: "landscape" }); } catch {}
    try { await StatusBar.hide(); } catch {}
    try { await KeepAwake.keepAwake(); } catch {}
    await this.load();
  }

  async close() {
    if (!this.ctx) return;
    this.report(true);
    this.stopCountdown();
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
    try { await ScreenOrientation.unlock(); } catch {}
    try { await StatusBar.show(); } catch {}
    try { await KeepAwake.allowSleep(); } catch {}
    if (this.onClose) this.onClose();
  }

  current() { return this.ctx.items[this.ctx.index]; }

  // Список серий в плеере = все скачанные серии тайтла. Если, пока смотришь,
  // докачалась ещё одна — она сразу появляется в очереди (кнопка ⏭, автопереход).
  syncItems(list) {
    if (!this.ctx) return;
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
    const it = this.current();
    this.marked = false;
    this.stopCountdown();
    $(".p-t1", this.root).textContent = this.ctx.releaseTitle;
    $(".p-t2", this.root).textContent = it.name;
    $(".p-q", this.root).textContent = /^\d+$/.test(it.quality || "") ? `${it.quality}p` : "Авто";
    this.updateNavButtons();

    const src = await downloads.playUrl(it);
    const saved = await progressOf(it.releaseId, it.position);
    const resumeAt = saved && saved.d && saved.t > 10 && saved.t < saved.d - 30 ? saved.t : 0;

    if (this.hls) { this.hls.destroy(); this.hls = null; }
    const start = () => {
      if (resumeAt) { this.video.currentTime = resumeAt; this.toast(`Продолжаем с ${fmt(resumeAt)}`); }
      this.video.playbackRate = settings.get().speed || 1;
      this.video.play().catch(() => {});
    };
    if (it.kind === "hls" && window.Hls && window.Hls.isSupported()) {
      this.hls = new window.Hls({ enableWorker: false, maxBufferHole: 0.5, backBufferLength: 90 });
      this.hls.on(window.Hls.Events.MANIFEST_PARSED, start);
      this.hls.on(window.Hls.Events.ERROR, (_e, info) => {
        if (!info.fatal) return;
        if (info.type === window.Hls.ErrorTypes.MEDIA_ERROR) this.hls.recoverMediaError();
        else this.toast(`Файл серии повреждён (${info.details}). Удалите и скачайте её заново.`, 6000);
      });
      this.hls.loadSource(src);
      this.hls.attachMedia(this.video);
    } else {
      this.video.src = src;
      this.video.addEventListener("loadedmetadata", start, { once: true });
    }
    this.updateSpeedLabel();
    this.showUi();
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

  startCountdown() {
    if (this.ctx.index >= this.ctx.items.length - 1) {
      if (this.nextPending(downloads.list())) { this.go(1); this.showUi(); return; }
      this.toast("Это была последняя скачанная серия", 3000);
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
    v.addEventListener("timeupdate", () => this.report());
    v.addEventListener("pause", () => { this.updatePlayIcon(); this.report(true); this.showUi(); });
    v.addEventListener("play", () => { this.updatePlayIcon(); this.showUi(); });
    v.addEventListener("ratechange", () => this.updateSpeedLabel());
    v.addEventListener("ended", () => { this.report(true); this.startCountdown(); });
    v.addEventListener("error", () => this.toast("Не удалось открыть файл серии. Удалите её и скачайте заново.", 6000));

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

    const swipeSeconds = (dx) => {
      // весь экран по ширине = 2 минуты (или вся серия, если она короче); к краям быстрее
      const span = Math.min(v.duration || 120, 120);
      const ratio = dx / window.innerWidth;
      return Math.sign(ratio) * Math.pow(Math.abs(ratio), 1.4) * span * 1.6;
    };

    gesture.addEventListener("pointerdown", (e) => {
      if (this.locked || !v.duration) return;
      touch = { id: e.pointerId, x: e.clientX, y: e.clientY, t0: v.currentTime, swiping: false, target: v.currentTime };
    });
    gesture.addEventListener("pointermove", (e) => {
      if (!touch || e.pointerId !== touch.id) return;
      const dx = e.clientX - touch.x;
      const dy = e.clientY - touch.y;
      if (!touch.swiping) {
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
      if (touch) { swipeBox.hidden = true; this.seeking = false; touch = null; }
    });

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
          const s = settings.get().skipOpening || 85;
          this.seekBy(s);
          this.toast(`+${s} с`);
          this.showUi();
          break;
        }
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
          const q = /^\d+$/.test(it.quality || "") ? `${it.quality}p` : "Авто";
          this.menu("Качество", [[it.quality, q, "скачано"]], it.quality, null);
          break;
        }
        case "upnext-cancel": this.stopCountdown(); this.showUi(); break;
        case "upnext-go": this.stopCountdown(); this.go(1); break;
      }
    });
  }
}

export const player = new Player();
