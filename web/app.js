(() => {
  "use strict";

  const C = window.RADIO_CONFIG;
  const $ = (id) => document.getElementById(id);
  const audio = $("audio");
  const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* 保存できない環境では無視 */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* 同上 */ } },
  };

  let ep = null;
  let starts = [];      // 各行の開始秒（空行は前の値を引き継ぐ）
  let lineEls = [];
  let current = -1;
  let posKey = "";
  let lastSaved = 0;
  let userScrolledAt = 0;

  const fmt = (sec) => {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
  };
  const fmtJa = (sec) => {
    sec = Math.floor(sec);
    const m = Math.floor(sec / 60), s = sec % 60;
    return (m ? m + "分" : "") + s + "秒";
  };
  const weekday = (iso) => "日月火水木金土"[new Date(iso + "T12:00:00Z").getUTCDay()];

  function notice(html, kind) {
    const n = $("notice");
    n.innerHTML = html;
    n.dataset.kind = kind || "info";
    n.hidden = false;
  }

  // ── 取得 ───────────────────────────────────────────────
  async function fetchEpisode() {
    const q = new URLSearchParams({
      select: "id,air_date,title,script,sources,audio_path,duration_sec,line_starts",
      status: "eq.ready",
      title: "not.like.【テスト】*",
      order: "air_date.desc,created_at.desc",
      limit: "1",
    });
    const date = new URLSearchParams(location.search).get("date");
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) q.set("air_date", "eq." + date);
    const r = await fetch(`${C.supabaseUrl}/rest/v1/radio_episodes?${q}`, {
      headers: { apikey: C.publishableKey, Authorization: "Bearer " + C.publishableKey },
      cache: "no-store",
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const rows = await r.json();
    return rows[0] || null;
  }

  // ── 行の開始時刻 ──────────────────────────────────────
  function computeStarts(lines, duration, given) {
    if (Array.isArray(given) && given.length === lines.length) {
      let prev = 0;
      return { exact: true, list: given.map((v) => (typeof v === "number" ? (prev = v) : prev)) };
    }
    // 推定：行間の無音を除いた時間を、文字数の比で各行に配分する
    let gaps = 0, chars = 0, seen = false;
    for (const l of lines) {
      const t = (l.text || "").trim();
      if (!t) continue;
      if (seen) gaps += l.section ? C.sectionGapSec : C.gapSec;
      seen = true;
      chars += t.length;
    }
    const perChar = Math.max(0, duration - gaps) / Math.max(1, chars);
    const list = [];
    let t = 0; seen = false;
    for (const l of lines) {
      const s = (l.text || "").trim();
      if (!s) { list.push(t); continue; }
      if (seen) t += l.section ? C.sectionGapSec : C.gapSec;
      seen = true;
      list.push(t);
      t += s.length * perChar;
    }
    return { exact: false, list };
  }

  function indexAt(time) {
    let lo = 0, hi = starts.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= time + 0.05) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    // 空行は直前の行と同じ開始秒を持つので、直前の空でない行を返す
    const lines = ep.script.lines;
    while (ans > 0 && !(lines[ans].text || "").trim()) ans--;
    return ans;
  }

  // ── 描画 ───────────────────────────────────────────────
  function render() {
    const lines = ep.script.lines || [];
    const dur = ep.duration_sec || 0;
    const [y, m, d] = ep.air_date.split("-").map(Number);

    document.title = `${ep.title} | モーニング・シグナル`;
    $("ep-title").textContent = ep.title;
    $("ep-meta").textContent = `${y}年${m}月${d}日（${weekday(ep.air_date)}）放送 ・ ${Math.round(dur / 60)}分`;

    const res = computeStarts(lines, dur, ep.line_starts);
    starts = res.list;
    $("sync-note").textContent = res.exact
      ? "行を押すと、その場面から再生します。"
      : "行を押すと、その場面から再生します。この回は字幕の位置を文字数から推定しているため、数秒ずれることがあります。";

    // 字幕
    const ol = $("transcript");
    ol.textContent = "";
    lineEls = lines.map((l, i) => {
      const li = document.createElement("li");
      if (l.section) li.className = "is-section";
      const b = document.createElement("button");
      b.type = "button";
      b.className = "line";
      b.dataset.speaker = l.speaker;
      b.dataset.i = i;
      const who = document.createElement("span");
      who.className = "line__who";
      who.textContent = C.cast[l.speaker] || l.speaker;
      const tx = document.createElement("span");
      tx.className = "line__text";
      tx.textContent = l.text;
      b.append(who, tx);
      b.setAttribute("aria-label", `${fmt(starts[i])}から再生：${who.textContent}「${l.text}」`);
      li.append(b);
      ol.append(li);
      return b;
    });
    ol.addEventListener("click", (e) => {
      const b = e.target.closest(".line");
      if (!b) return;
      seekTo(starts[+b.dataset.i] + 0.01, true);
    });
    $("transcript-sec").hidden = false;

    // 話題と出典（話題 n は n 番目の section 行から始まる）
    const topics = (ep.script.topics && ep.script.topics.length ? ep.script.topics : ep.sources) || [];
    const sectionIdx = lines.map((l, i) => (l.section ? i : -1)).filter((i) => i >= 0);
    const tl = $("topics");
    tl.textContent = "";
    topics.forEach((t, n) => {
      const li = document.createElement("li");
      const h = document.createElement("span");
      h.className = "topics__headline";
      h.textContent = t.headline;
      const meta = document.createElement("span");
      meta.className = "topics__meta";
      const src = document.createElement(t.url ? "a" : "span");
      src.textContent = "出典：" + (t.source_name || "不明");
      if (t.url) { src.href = t.url; src.rel = "noopener"; src.target = "_blank"; }
      meta.append(src);
      if (sectionIdx[n] != null) {
        const jump = document.createElement("button");
        jump.type = "button";
        jump.className = "topics__jump";
        jump.textContent = `${fmt(starts[sectionIdx[n]])} からこの話題を聞く`;
        jump.addEventListener("click", () => seekTo(starts[sectionIdx[n]] + 0.01, true));
        meta.append(jump);
      }
      li.append(h, meta);
      tl.append(li);
    });
    $("topics-sec").hidden = topics.length === 0;

    // 音声
    audio.src = `${C.supabaseUrl}/storage/v1/object/public/${C.bucket}/${ep.audio_path}`;
    $("seek").max = dur;
    $("t-dur").textContent = fmt(dur);
    $("player").hidden = false;

    setupSpeed();
    setupResume(dur);
    setupMediaSession();
    highlight(0, false);
  }

  // ── 再生速度 ───────────────────────────────────────────
  function setupSpeed() {
    const saved = parseFloat(store.get("ms:rate")) || 1;
    const box = $("speed");
    box.textContent = "";
    for (const s of SPEEDS) {
      const lab = document.createElement("label");
      lab.className = "speed__opt";
      const inp = document.createElement("input");
      inp.type = "radio"; inp.name = "speed"; inp.value = s;
      inp.checked = s === saved;
      const sp = document.createElement("span");
      sp.textContent = s + "倍";
      inp.addEventListener("change", () => setRate(s));
      lab.append(inp, sp);
      box.append(lab);
    }
    setRate(SPEEDS.includes(saved) ? saved : 1);
  }
  function setRate(s) {
    audio.playbackRate = s;
    audio.defaultPlaybackRate = s;
    store.set("ms:rate", String(s));
  }

  // ── 続きから再生 ───────────────────────────────────────
  function setupResume(dur) {
    posKey = "ms:pos:" + ep.id;
    const pos = parseFloat(store.get(posKey));
    if (pos > 10 && pos < dur - 15) {
      $("resume-text").textContent = `前回は ${fmt(pos)} まで聞きました。`;
      $("resume").hidden = false;
      $("resume-yes").onclick = () => { $("resume").hidden = true; seekTo(pos, true); };
      $("resume-no").onclick = () => { $("resume").hidden = true; store.del(posKey); seekTo(0, true); };
    }
  }
  function savePos(force) {
    if (!posKey) return;
    const now = Date.now();
    if (!force && now - lastSaved < 5000) return;
    lastSaved = now;
    const t = audio.currentTime;
    if (audio.ended || (audio.duration && t > audio.duration - 15)) store.del(posKey);
    else if (t > 10) store.set(posKey, String(t));
  }

  // ── 操作 ───────────────────────────────────────────────
  function seekTo(t, play) {
    const dur = ep.duration_sec || audio.duration || 0;
    t = Math.max(0, Math.min(t, dur));
    const go = () => {
      audio.currentTime = t;
      onTime();
      if (play) audio.play().catch(() => {});
    };
    if (audio.readyState >= 1) go();
    else audio.addEventListener("loadedmetadata", go, { once: true }), audio.load();
  }

  function highlight(i, scroll) {
    if (i === current) return;
    if (lineEls[current]) lineEls[current].classList.remove("is-current"), lineEls[current].removeAttribute("aria-current");
    current = i;
    const el = lineEls[i];
    if (!el) return;
    el.classList.add("is-current");
    el.setAttribute("aria-current", "true");
    const l = ep.script.lines[i];
    const sp = $("now-speaker");
    sp.textContent = C.cast[l.speaker] || l.speaker;
    sp.dataset.speaker = l.speaker;
    $("now-text").textContent = l.text;
    if (scroll && $("autoscroll").checked && Date.now() - userScrolledAt > 4000) {
      const r = el.getBoundingClientRect();
      if (r.top < 80 || r.bottom > innerHeight - 80) {
        el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      }
    }
  }

  function onTime() {
    const t = audio.currentTime;
    $("t-cur").textContent = fmt(t);
    const seek = $("seek");
    if (!seek.matches(":active")) seek.value = Math.floor(t);
    seek.setAttribute("aria-valuetext", `${fmtJa(t)}／全${fmtJa(ep.duration_sec || 0)}`);
    highlight(indexAt(t), !audio.paused);
    savePos(false);
  }

  function setPlayingUI(playing) {
    $("ic-play").hidden = playing;
    $("ic-pause").hidden = !playing;
    $("play").setAttribute("aria-label", playing ? "一時停止" : "再生");
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  }

  function setupMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const base = new URL(".", location.href).href;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: ep.title,
      artist: "ミオ・タクミ",
      album: "モーニング・シグナル",
      artwork: [
        { src: base + "icon-192.png", sizes: "192x192", type: "image/png" },
        { src: base + "icon-512.png", sizes: "512x512", type: "image/png" },
      ],
    });
    const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch { /* 未対応の操作 */ } };
    h("play", () => audio.play());
    h("pause", () => audio.pause());
    h("seekbackward", (d) => seekTo(audio.currentTime - (d.seekOffset || 15)));
    h("seekforward", (d) => seekTo(audio.currentTime + (d.seekOffset || 30)));
    h("seekto", (d) => seekTo(d.seekTime));
  }

  function bind() {
    $("play").addEventListener("click", () => {
      $("resume").hidden = true;
      if (audio.paused) audio.play().catch((e) => notice(`<p>再生できませんでした（${e.name}）。もう一度お試しください。</p>`, "error"));
      else audio.pause();
    });
    $("back").addEventListener("click", () => seekTo(audio.currentTime - 15));
    $("fwd").addEventListener("click", () => seekTo(audio.currentTime + 30));
    $("seek").addEventListener("input", (e) => { $("t-cur").textContent = fmt(+e.target.value); });
    $("seek").addEventListener("change", (e) => seekTo(+e.target.value));
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("play", () => setPlayingUI(true));
    audio.addEventListener("pause", () => { setPlayingUI(false); savePos(true); });
    audio.addEventListener("ended", () => { setPlayingUI(false); savePos(true); });
    audio.addEventListener("ratechange", () => {
      // 一部ブラウザは src 設定で速度が戻るため、保存値に合わせ直す
      const s = parseFloat(store.get("ms:rate")) || 1;
      if (audio.playbackRate !== s && !audio.seeking) audio.playbackRate = s;
    });
    audio.addEventListener("error", () => {
      notice("<p>音声ファイルを読み込めませんでした。音声は放送から7日で削除されます。</p>", "error");
    });
    addEventListener("pagehide", () => savePos(true));
    document.addEventListener("visibilitychange", () => { if (document.hidden) savePos(true); });
    const markScroll = () => { userScrolledAt = Date.now(); };
    addEventListener("wheel", markScroll, { passive: true });
    addEventListener("touchmove", markScroll, { passive: true });
    document.addEventListener("keydown", (e) => {
      if (e.target.closest("input, button, a, textarea, select")) return;
      if (e.key === " " || e.key === "k") { e.preventDefault(); $("play").click(); }
      else if (e.key === "ArrowLeft" || e.key === "j") seekTo(audio.currentTime - 15);
      else if (e.key === "ArrowRight" || e.key === "l") seekTo(audio.currentTime + 30);
    });
  }

  async function main() {
    bind();
    try {
      ep = await fetchEpisode();
    } catch (e) {
      $("ep-title").textContent = "読み込めませんでした";
      notice(`<p>番組の情報を取得できませんでした（${e.message}）。通信状況を確認して、ページを再読み込みしてください。</p>`, "error");
      return;
    }
    if (!ep || !ep.audio_path) {
      $("ep-title").textContent = "まだ再生できる回がありません";
      notice("<p>音声ができあがると、ここで聞けるようになります。毎朝6時15分ごろが目安です。</p>");
      return;
    }
    render();
  }

  if ("serviceWorker" in navigator) {
    addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
  main();
})();
