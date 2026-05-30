(function () {
  "use strict";

  const PLAYLISTS_MANIFEST = "resources/playlists/manifest.json";
  const PLAYLISTS_DIR = "resources/playlists/";
  const LYRICS_DIR = "resources/lyrics/";
  const START_DELAY_MS = 3500;

  const musicDetails = document.querySelector(".accordion-item--music");
  if (!musicDetails) return;

  const el = {
    playlistsView: document.getElementById("music-view-playlists"),
    tracksView: document.getElementById("music-view-tracks"),
    playlistList: document.getElementById("music-playlist-list"),
    tracksTitle: document.getElementById("music-tracks-title"),
    tracksBody: document.getElementById("music-tracks-tbody"),
    fetchError: document.getElementById("music-fetch-error"),
    breadcrumb: document.getElementById("music-breadcrumb"),
    bcPlaylists: document.getElementById("music-bc-playlists"),
    bcPlaylist: document.getElementById("music-bc-playlist"),
    bcSep1: document.getElementById("music-bc-sep-1"),
    overlay: document.getElementById("music-lyrics-overlay"),
    minimizeBtn: document.getElementById("music-lyrics-minimize"),
    closeBtn: document.getElementById("music-lyrics-close"),
    dock: document.getElementById("music-lyrics-dock"),
    dockInner: document.getElementById("music-lyrics-dock-inner"),
    dockTitle: document.getElementById("music-lyrics-dock-title"),
    dockTime: document.getElementById("music-lyrics-dock-time"),
    dockExpand: document.getElementById("music-lyrics-dock-expand"),
    lyricsTitle: document.getElementById("music-lyrics-title"),
    lyricsMeta: document.getElementById("music-lyrics-meta"),
    progressBar: document.getElementById("music-lyrics-progress-bar"),
    progressWrap: document.getElementById("music-lyrics-progress"),
    progressElapsed: document.getElementById("music-lyrics-elapsed"),
    progressTotal: document.getElementById("music-lyrics-total"),
    lyricsLines: document.getElementById("music-lyrics-lines"),
    btnBack: document.getElementById("music-lyrics-btn-back"),
    btnPlayPause: document.getElementById("music-lyrics-btn-playpause"),
    btnNext: document.getElementById("music-lyrics-btn-next"),
  };

  let playlistsLoaded = false;
  let rafId = null;
  /** Wall clock: elapsed = now - playbackAnchorPerf (when not paused). */
  let playbackAnchorPerf = 0;
  let paused = false;
  let pausedElapsed = 0;
  let currentDurationMs = 0;
  let lineElements = [];
  let lineTiming = [];
  let lastActiveLine = -1;
  /** Previous line index for clearing per-word karaoke classes. */
  let lastWordHighlightLine = -1;
  /** { tracks: enriched[], playlistLabelText } */
  let playlistContext = null;
  /** Lyrics session running (RAF, timeline); stays true when minimized. */
  let lyricsSessionActive = false;
  /** Full-screen overlay visible (false when minimized). */
  let lyricsUIFullscreen = false;
  let currentTrackIndex = -1;

  function formatMmSs(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  }

  function playlistLabel(filename) {
    const stem = filename.replace(/\.json$/i, "");
    return stem.replace(/_/g, " ");
  }

  function showFetchError(msg) {
    if (el.fetchError) {
      el.fetchError.textContent = msg;
      el.fetchError.hidden = false;
    }
  }

  async function fetchJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  async function lyricsFileExists(trackId) {
    if (!trackId) return false;
    const url = `${LYRICS_DIR}${encodeURIComponent(trackId)}.json`;
    try {
      const res = await fetch(url, { method: "HEAD", cache: "no-store" });
      if (res.ok) return true;
      if (res.status === 404) return false;
      const res2 = await fetch(url, { method: "GET", cache: "no-store" });
      return res2.ok;
    } catch {
      return false;
    }
  }

  async function enrichTracksWithLyrics(tracks) {
    const flags = await Promise.all(tracks.map((t) => lyricsFileExists(t.track_id)));
    return tracks.map((track, i) => ({ ...track, hasLyrics: flags[i] }));
  }

  function cancelRaf() {
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function stopLyricsPlayback() {
    cancelRaf();
    lineElements = [];
    lineTiming = [];
    lastActiveLine = -1;
    lastWordHighlightLine = -1;
    paused = false;
    pausedElapsed = 0;
  }

  function getElapsed() {
    if (paused) return pausedElapsed;
    return Math.min(currentDurationMs, Math.max(0, performance.now() - playbackAnchorPerf));
  }

  function setPlayPauseLabel() {
    if (!el.btnPlayPause) return;
    const pauseIcon =
      '<svg class="music-lyrics-icon music-lyrics-icon--playpause" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 6h3v12H8V6zm5 0h3v12h-3V6z"/></svg>';
    const playIcon =
      '<svg class="music-lyrics-icon music-lyrics-icon--playpause" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 6v12l10-6-10-6z"/></svg>';
    el.btnPlayPause.innerHTML = paused ? playIcon : pauseIcon;
    el.btnPlayPause.setAttribute("aria-label", paused ? "Play" : "Pause");
    el.btnPlayPause.setAttribute("title", paused ? "Play" : "Pause");
  }

  function tickKaraoke() {
    if (!lyricsSessionActive) return;

    const clamped = getElapsed();
    const pct = currentDurationMs > 0 ? (clamped / currentDurationMs) * 100 : 0;

    if (lyricsUIFullscreen) {
      if (el.progressBar) el.progressBar.style.width = `${pct}%`;
      if (el.progressWrap) el.progressWrap.setAttribute("aria-valuenow", String(Math.round(pct)));
      el.progressElapsed.textContent = formatMmSs(clamped);
      el.progressTotal.textContent = formatMmSs(currentDurationMs);
    } else if (el.dockTime) {
      el.dockTime.textContent = `${formatMmSs(clamped)} / ${formatMmSs(currentDurationMs)}`;
    }

    let activeIndex = -1;
    for (let i = 0; i < lineTiming.length; i++) {
      const { start, end } = lineTiming[i];
      if (clamped >= start && clamped <= end) {
        activeIndex = i;
        break;
      }
    }

    if (lyricsUIFullscreen) {
      lineElements.forEach((node, i) => {
        node.classList.toggle("music-lyrics-line--active", i === activeIndex);
      });

      if (lastWordHighlightLine !== activeIndex) {
        if (lastWordHighlightLine >= 0 && lineElements[lastWordHighlightLine]) {
          clearWordHighlightOnRow(lineElements[lastWordHighlightLine]);
        }
        lastWordHighlightLine = activeIndex;
      }
      if (activeIndex >= 0 && lineElements[activeIndex]) {
        updateWordSpansForRow(lineElements[activeIndex], clamped);
      }

      if (activeIndex !== lastActiveLine && activeIndex >= 0 && lineElements[activeIndex]) {
        lineElements[activeIndex].scrollIntoView({ block: "center", behavior: "smooth" });
        lastActiveLine = activeIndex;
      }
    }

    const rawElapsed = paused ? pausedElapsed : performance.now() - playbackAnchorPerf;
    if (rawElapsed < currentDurationMs + 500) {
      rafId = requestAnimationFrame(tickKaraoke);
    } else {
      rafId = null;
    }
  }

  function startLyricsRaf() {
    cancelRaf();
    rafId = requestAnimationFrame(tickKaraoke);
  }

  /** Begin timeline: optional delay before elapsed moves from 0 (Spotify startup). */
  function armPlaybackWithDelay(delayMs) {
    paused = false;
    pausedElapsed = 0;
    lastActiveLine = -1;
    lastWordHighlightLine = -1;
    playbackAnchorPerf = performance.now() + delayMs;
    setPlayPauseLabel();
    startLyricsRaf();
  }

  function seekFromProgressPointer(clientX) {
    if (!lyricsSessionActive || !lyricsUIFullscreen || !el.progressWrap || currentDurationMs <= 0) return;
    const rect = el.progressWrap.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    seekToElapsedMs(Math.round(ratio * currentDurationMs));
  }

  function seekToElapsedMs(ms) {
    const clamped = Math.max(0, Math.min(currentDurationMs, ms));
    paused = false;
    pausedElapsed = 0;
    playbackAnchorPerf = performance.now() - clamped;
    lastActiveLine = -1;
    lastWordHighlightLine = -1;
    setPlayPauseLabel();
    cancelRaf();
    if (lyricsSessionActive) startLyricsRaf();
  }

  function togglePause() {
    if (!lyricsSessionActive || !lyricsUIFullscreen) return;
    if (paused) {
      playbackAnchorPerf = performance.now() - pausedElapsed;
      paused = false;
      pausedElapsed = 0;
      setPlayPauseLabel();
      startLyricsRaf();
    } else {
      pausedElapsed = getElapsed();
      paused = true;
      setPlayPauseLabel();
      cancelRaf();
    }
  }

  const DOCK_POS_STORAGE_KEY = "bahasa-indonesia-music-dock-pos";
  const DOCK_DRAG_THRESHOLD_SQ = 8 * 8;

  /** @type {{ pointerId: number, startX: number, startY: number, originLeft: number, originTop: number, dragging: boolean } | null} */
  let dockPointerDrag = null;

  function readVisualViewportBox() {
    const vv = window.visualViewport;
    if (vv) {
      return {
        left: vv.offsetLeft,
        top: vv.offsetTop,
        width: vv.width,
        height: vv.height,
      };
    }
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }

  function clampDockLeftTop(left, top, dockW, dockH) {
    const vv = readVisualViewportBox();
    const pad = 8;
    const minX = vv.left + pad;
    const minY = vv.top + pad;
    const maxX = vv.left + vv.width - dockW - pad;
    const maxY = vv.top + vv.height - dockH - pad;
    return {
      left: Math.min(Math.max(minX, left), Math.max(minX, maxX)),
      top: Math.min(Math.max(minY, top), Math.max(minY, maxY)),
    };
  }

  function loadDockScreenPosition() {
    try {
      const raw = localStorage.getItem(DOCK_POS_STORAGE_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (typeof p.left !== "number" || typeof p.top !== "number") return null;
      return { left: p.left, top: p.top };
    } catch {
      return null;
    }
  }

  function saveDockScreenPosition(left, top) {
    try {
      localStorage.setItem(DOCK_POS_STORAGE_KEY, JSON.stringify({ left, top }));
    } catch {
      /* private mode / quota */
    }
  }

  /** Clamp and apply fixed left/top; dock must be visible for correct width/height. */
  function setDockCustomPixels(left, top) {
    if (!el.dock) return { left: 0, top: 0 };
    el.dock.classList.add("music-lyrics-dock--custom");
    el.dock.style.right = "auto";
    el.dock.style.bottom = "auto";
    el.dock.style.transform = "none";
    const w = el.dock.offsetWidth;
    const h = el.dock.offsetHeight;
    const c = clampDockLeftTop(left, top, w, h);
    el.dock.style.left = `${Math.round(c.left)}px`;
    el.dock.style.top = `${Math.round(c.top)}px`;
    return c;
  }

  function resetDockLayoutToCssDefault() {
    if (!el.dock) return;
    el.dock.classList.remove("music-lyrics-dock--custom", "music-lyrics-dock--dragging");
    el.dock.style.left = "";
    el.dock.style.top = "";
    el.dock.style.right = "";
    el.dock.style.bottom = "";
    el.dock.style.width = "";
    el.dock.style.transform = "";
    el.dock.removeAttribute("aria-grabbed");
  }

  function finishDockDragCommitPosition() {
    if (!el.dock) return;
    el.dock.style.width = "";
    el.dock.classList.remove("music-lyrics-dock--dragging");
    el.dock.setAttribute("aria-grabbed", "false");
    const left = parseFloat(el.dock.style.left);
    const top = parseFloat(el.dock.style.top);
    if (Number.isFinite(left) && Number.isFinite(top)) {
      const c = setDockCustomPixels(left, top);
      saveDockScreenPosition(c.left, c.top);
    }
  }

  function syncDockPositionAfterResize() {
    if (!el.dock || el.dock.hidden || !el.dock.classList.contains("music-lyrics-dock--custom")) return;
    const left = parseFloat(el.dock.style.left);
    const top = parseFloat(el.dock.style.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return;
    const c = setDockCustomPixels(left, top);
    saveDockScreenPosition(c.left, c.top);
  }

  function showDockWithOptionalSavedPosition() {
    if (!el.dock) return;
    el.dock.hidden = false;
    el.dock.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => {
      if (!el.dock || el.dock.hidden) return;
      const saved = loadDockScreenPosition();
      if (saved) {
        setDockCustomPixels(saved.left, saved.top);
      } else {
        resetDockLayoutToCssDefault();
      }
    });
  }

  function endDockPointerDrag(commitPosition) {
    if (!dockPointerDrag || !el.dockInner) return;
    const dragging = dockPointerDrag.dragging;
    const pid = dockPointerDrag.pointerId;
    dockPointerDrag = null;
    try {
      el.dockInner.releasePointerCapture(pid);
    } catch {
      /* not captured */
    }
    el.dockInner.removeEventListener("pointermove", onDockPointerMove);
    el.dockInner.removeEventListener("pointerup", onDockPointerEnd);
    el.dockInner.removeEventListener("pointercancel", onDockPointerEnd);
    if (commitPosition && dragging) {
      finishDockDragCommitPosition();
    } else if (el.dock) {
      el.dock.classList.remove("music-lyrics-dock--dragging");
      el.dock.style.width = "";
      el.dock.setAttribute("aria-grabbed", "false");
    }
  }

  function onDockPointerMove(e) {
    if (!dockPointerDrag || e.pointerId !== dockPointerDrag.pointerId || !el.dock) return;
    const dx = e.clientX - dockPointerDrag.startX;
    const dy = e.clientY - dockPointerDrag.startY;
    if (!dockPointerDrag.dragging) {
      if (dx * dx + dy * dy < DOCK_DRAG_THRESHOLD_SQ) return;
      dockPointerDrag.dragging = true;
      el.dock.classList.add("music-lyrics-dock--dragging");
      el.dock.setAttribute("aria-grabbed", "true");
      el.dock.style.width = `${el.dock.offsetWidth}px`;
      setDockCustomPixels(dockPointerDrag.originLeft, dockPointerDrag.originTop);
    }
    e.preventDefault();
    const left = dockPointerDrag.originLeft + (e.clientX - dockPointerDrag.startX);
    const top = dockPointerDrag.originTop + (e.clientY - dockPointerDrag.startY);
    const w = el.dock.offsetWidth;
    const h = el.dock.offsetHeight;
    const c = clampDockLeftTop(left, top, w, h);
    el.dock.style.left = `${Math.round(c.left)}px`;
    el.dock.style.top = `${Math.round(c.top)}px`;
  }

  function onDockPointerEnd(e) {
    if (!dockPointerDrag || e.pointerId !== dockPointerDrag.pointerId) return;
    const commit = dockPointerDrag.dragging;
    endDockPointerDrag(commit);
  }

  function onDockPointerDown(e) {
    if (!el.dock || el.dock.hidden || !el.dockInner) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.target.closest(".music-lyrics-dock-expand")) return;

    const rect = el.dock.getBoundingClientRect();
    dockPointerDrag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originLeft: rect.left,
      originTop: rect.top,
      dragging: false,
    };
    el.dockInner.setPointerCapture(e.pointerId);
    el.dockInner.addEventListener("pointermove", onDockPointerMove);
    el.dockInner.addEventListener("pointerup", onDockPointerEnd);
    el.dockInner.addEventListener("pointercancel", onDockPointerEnd);
  }

  function hideLyricsDock() {
    if (dockPointerDrag) {
      const commit = dockPointerDrag.dragging;
      endDockPointerDrag(commit);
    }
    if (el.dock) {
      el.dock.hidden = true;
      el.dock.setAttribute("aria-hidden", "true");
    }
  }

  function openLyricsOverlay() {
    if (!el.overlay) return;
    lyricsSessionActive = true;
    lyricsUIFullscreen = true;
    el.overlay.hidden = false;
    el.overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("music-lyrics-open");
    hideLyricsDock();
    if (el.closeBtn) el.closeBtn.focus();
  }

  function minimizeLyricsOverlay() {
    if (!lyricsSessionActive || !lyricsUIFullscreen) return;
    lyricsUIFullscreen = false;
    el.overlay.hidden = true;
    el.overlay.setAttribute("aria-hidden", "true");
    document.body.classList.remove("music-lyrics-open");
    if (el.dock) {
      if (el.dockTitle) el.dockTitle.textContent = el.lyricsTitle ? el.lyricsTitle.textContent : "";
      const clamped = getElapsed();
      if (el.dockTime) {
        el.dockTime.textContent = `${formatMmSs(clamped)} / ${formatMmSs(currentDurationMs)}`;
      }
      showDockWithOptionalSavedPosition();
    }
    if (el.dockExpand) el.dockExpand.focus();
  }

  function expandLyricsOverlayFromDock() {
    if (!lyricsSessionActive) return;
    lyricsUIFullscreen = true;
    el.overlay.hidden = false;
    el.overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("music-lyrics-open");
    hideLyricsDock();
    cancelRaf();
    startLyricsRaf();
    if (el.closeBtn) el.closeBtn.focus();
  }

  function closeLyricsOverlay() {
    if (!el.overlay) return;
    lyricsSessionActive = false;
    lyricsUIFullscreen = false;
    stopLyricsPlayback();
    el.overlay.hidden = true;
    el.overlay.setAttribute("aria-hidden", "true");
    document.body.classList.remove("music-lyrics-open");
    el.lyricsLines.innerHTML = "";
    hideLyricsDock();
  }

  function setView(name) {
    el.playlistsView.hidden = name !== "playlists";
    el.tracksView.hidden = name !== "tracks";

    const showBc = name !== "playlists";
    el.breadcrumb.hidden = !showBc;
    el.bcSep1.hidden = name === "playlists";
    el.bcPlaylist.hidden = name === "playlists";
  }

  function buildLineTimings(lines, durationMs) {
    const n = lines.length;
    if (!n) return [];

    return lines.map((line, i) => {
      let start = line.start_ms;
      let end = line.end_ms;

      if (start == null || typeof start !== "number") {
        start = Math.round((i / n) * durationMs);
      }
      if (end == null || typeof end !== "number") {
        if (i + 1 < n) {
          const next = lines[i + 1];
          let nextStart = next.start_ms;
          if (nextStart == null || typeof nextStart !== "number") {
            nextStart = Math.round(((i + 1) / n) * durationMs);
          }
          end = nextStart - 1;
        } else {
          end = durationMs;
        }
      }
      return { start, end };
    });
  }

  function tokenizeWords(text) {
    if (!text || !String(text).trim()) return [];
    return String(text).trim().match(/\S+/g) || [];
  }

  /** Split line duration across words, weighted by character length (karaoke-style). */
  function buildWordAbsoluteTimings(words, lineStart, lineEnd) {
    const lineDur = Math.max(1, lineEnd - lineStart);
    const weights = words.map((w) => Math.max(1, w.length));
    const sumW = weights.reduce((a, b) => a + b, 0);
    let t = lineStart;
    const out = words.map((word, i) => {
      const slice = (lineDur * weights[i]) / sumW;
      const start = t;
      const end = t + slice;
      t = end;
      return { word, start, end };
    });
    if (out.length) out[out.length - 1].end = lineEnd;
    return out;
  }

  function fillOriginalWithWordSpans(origDiv, text, lineStart, lineEnd) {
    origDiv.textContent = "";
    const words = tokenizeWords(text);
    if (!words.length) {
      origDiv.textContent = text || "";
      return;
    }
    const segs = buildWordAbsoluteTimings(words, lineStart, lineEnd);
    segs.forEach((seg, idx) => {
      if (idx > 0) origDiv.appendChild(document.createTextNode(" "));
      const span = document.createElement("span");
      span.className = "music-lyrics-word";
      span.textContent = seg.word;
      span.dataset.wStart = String(Math.round(seg.start));
      span.dataset.wEnd = String(Math.round(seg.end));
      origDiv.appendChild(span);
    });
  }

  function clearWordHighlightOnRow(row) {
    const spans = row._wordSpans;
    if (!spans) return;
    for (const s of spans) {
      s.classList.remove("music-lyrics-word--sung", "music-lyrics-word--current", "music-lyrics-word--pending");
      s.style.removeProperty("--wprog");
    }
  }

  function updateWordSpansForRow(row, clamped) {
    const spans = row._wordSpans;
    if (!spans || !spans.length) return;
    for (const s of spans) {
      const ws = Number(s.dataset.wStart);
      const we = Number(s.dataset.wEnd);
      s.classList.remove("music-lyrics-word--sung", "music-lyrics-word--current", "music-lyrics-word--pending");
      if (clamped >= we) {
        s.classList.add("music-lyrics-word--sung");
      } else if (clamped < ws) {
        s.classList.add("music-lyrics-word--pending");
      } else {
        s.classList.add("music-lyrics-word--current");
        const denom = Math.max(1, we - ws);
        const p = (clamped - ws) / denom;
        s.style.setProperty("--wprog", String(Math.max(0, Math.min(1, p))));
      }
    }
  }

  function findNextLyricIndex(fromIndex) {
    if (!playlistContext) return -1;
    const { tracks } = playlistContext;
    for (let j = fromIndex + 1; j < tracks.length; j++) {
      if (tracks[j].hasLyrics) return j;
    }
    return -1;
  }

  async function openTrack(track, playlistLabelText, trackIndex) {
    if (track.hasLyrics === false) return;

    stopLyricsPlayback();

    currentTrackIndex = trackIndex;

    const trackId = track.track_id;
    window.open(`https://open.spotify.com/track/${trackId}`, "_blank", "noopener,noreferrer");

    el.lyricsTitle.textContent = track.track_name || "Track";
    el.lyricsMeta.textContent = [track.artist_names, track.album_name].filter(Boolean).join(" · ");

    el.lyricsLines.innerHTML = '<p class="music-lyrics-fetch-msg">Loading lyrics…</p>';
    if (el.progressBar) el.progressBar.style.width = "0%";
    el.progressElapsed.textContent = "0:00";
    currentDurationMs = Number(track.duration_ms) || 0;
    el.progressTotal.textContent = formatMmSs(currentDurationMs);

    openLyricsOverlay();

    let lyrics;
    try {
      lyrics = await fetchJson(`${LYRICS_DIR}${encodeURIComponent(trackId)}.json`);
    } catch {
      el.lyricsLines.innerHTML =
        '<p class="music-lyrics-fetch-msg music-lyrics-fetch-msg--error">No lyrics file found. Add <code>resources/lyrics/' +
        trackId +
        ".json</code>.</p>";
      lineTiming = [];
      lineElements = [];
      const nextIdx = findNextLyricIndex(currentTrackIndex);
      if (el.btnNext) el.btnNext.disabled = nextIdx < 0;
      armPlaybackWithDelay(START_DELAY_MS);
      return;
    }

    const lines = Array.isArray(lyrics.lines) ? lyrics.lines : [];
    lineTiming = buildLineTimings(lines, currentDurationMs);

    el.lyricsLines.innerHTML = "";
    lines.forEach((line, i) => {
      const row = document.createElement("div");
      row.className = "music-lyrics-line";
      row.dataset.lineIndex = String(i);
      row.dataset.startMs = String(lineTiming[i].start);

      const orig = document.createElement("div");
      orig.className = "music-lyrics-line-original";
      const timing = lineTiming[i];
      fillOriginalWithWordSpans(orig, line.original || "", timing.start, timing.end);
      row._wordSpans =
        orig.querySelectorAll(".music-lyrics-word").length > 0
          ? Array.from(orig.querySelectorAll(".music-lyrics-word"))
          : null;

      const trans = document.createElement("div");
      trans.className = "music-lyrics-line-translation";
      trans.textContent = line.translation || "";

      row.appendChild(orig);
      row.appendChild(trans);
      row.addEventListener("click", () => {
        const start = Number(row.dataset.startMs);
        if (!Number.isFinite(start)) return;
        seekToElapsedMs(start);
      });
      el.lyricsLines.appendChild(row);
    });

    lineElements = Array.from(el.lyricsLines.querySelectorAll(".music-lyrics-line"));

    const nextIdx = findNextLyricIndex(currentTrackIndex);
    if (el.btnNext) el.btnNext.disabled = nextIdx < 0;

    armPlaybackWithDelay(START_DELAY_MS);
  }

  async function renderTracks(tracks, playlistFilename, playlistLabelText) {
    el.tracksTitle.textContent = playlistLabelText;
    el.tracksTitle.dataset.playlistFile = playlistFilename;
    el.bcPlaylist.textContent = playlistLabelText;
    setView("tracks");
    el.tracksBody.innerHTML = `
      <tr>
        <td colspan="5" class="music-loading-row">Checking lyrics files…</td>
      </tr>
    `;

    const enriched = await enrichTracksWithLyrics(tracks);
    playlistContext = { tracks: enriched, playlistLabelText };

    el.tracksBody.innerHTML = "";

    enriched.forEach((track, idx) => {
      const hasLyrics = track.hasLyrics === true;
      const tr = document.createElement("tr");
      tr.className = "music-track-row" + (hasLyrics ? "" : " music-track-row--no-lyrics");
      if (!hasLyrics) tr.setAttribute("aria-disabled", "true");
      tr.title = hasLyrics ? "" : "No lyrics JSON in resources/lyrics/ for this track";

      const lyricsCell = hasLyrics
        ? `<td class="music-td-lyrics"></td>`
        : `<td class="music-td-lyrics"><span class="music-lyrics-missing">No lyrics</span></td>`;

      tr.innerHTML = `
        <td class="music-td-index">${idx + 1}</td>
        <td class="music-td-name">${escapeHtml(track.track_name || "")}</td>
        <td class="music-td-artist">${escapeHtml(track.artist_names || "")}</td>
        <td class="music-td-dur">${formatMmSs(Number(track.duration_ms) || 0)}</td>
        ${lyricsCell}
      `;

      if (hasLyrics) {
        tr.addEventListener("click", () => {
          openTrack(track, playlistLabelText, idx);
        });
        tr.tabIndex = 0;
        tr.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openTrack(track, playlistLabelText, idx);
          }
        });
      } else {
        tr.tabIndex = -1;
      }

      el.tracksBody.appendChild(tr);
    });
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  async function openPlaylist(filename) {
    const label = playlistLabel(filename);
    try {
      const tracks = await fetchJson(PLAYLISTS_DIR + encodeURIComponent(filename));
      if (!Array.isArray(tracks)) throw new Error("playlist JSON must be an array");
      if (el.fetchError) el.fetchError.hidden = true;
      await renderTracks(tracks, filename, label);
    } catch (e) {
      showFetchError(`Could not load playlist: ${filename} (${e.message})`);
    }
  }

  async function loadPlaylists() {
    if (playlistsLoaded) return;
    const hint = document.getElementById("music-playlists-hint");
    if (el.fetchError) el.fetchError.hidden = true;
    el.playlistList.innerHTML = "";
    try {
      const manifest = await fetchJson(PLAYLISTS_MANIFEST);
      const files = Array.isArray(manifest) ? manifest : manifest.playlists;
      if (!Array.isArray(files) || files.length === 0) {
        el.playlistList.innerHTML = "<li>No playlists in manifest.</li>";
        playlistsLoaded = true;
        if (hint) hint.hidden = true;
        return;
      }
      files.forEach((filename) => {
        if (!filename.endsWith(".json") || filename === "manifest.json") return;
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "music-playlist-btn";
        btn.textContent = playlistLabel(filename);
        btn.addEventListener("click", () => openPlaylist(filename));
        li.appendChild(btn);
        el.playlistList.appendChild(li);
      });
      playlistsLoaded = true;
      if (hint) hint.hidden = true;
    } catch (e) {
      if (hint) hint.hidden = false;
      showFetchError(
        "Could not load playlists (open this site over http(s), not file://). " + e.message
      );
      el.playlistList.innerHTML = "";
    }
  }

  el.bcPlaylists.addEventListener("click", () => {
    setView("playlists");
  });
  el.bcPlaylist.addEventListener("click", () => {
    setView("tracks");
  });

  if (el.closeBtn) el.closeBtn.addEventListener("click", closeLyricsOverlay);
  if (el.minimizeBtn) el.minimizeBtn.addEventListener("click", minimizeLyricsOverlay);
  if (el.dockExpand) el.dockExpand.addEventListener("click", expandLyricsOverlayFromDock);
  if (el.dockInner) el.dockInner.addEventListener("pointerdown", onDockPointerDown);

  let resizeDockTimer = null;
  function scheduleDockResizeSync() {
    clearTimeout(resizeDockTimer);
    resizeDockTimer = setTimeout(syncDockPositionAfterResize, 120);
  }
  window.addEventListener("resize", scheduleDockResizeSync);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", scheduleDockResizeSync);
    window.visualViewport.addEventListener("scroll", scheduleDockResizeSync);
  }

  if (el.btnBack) {
    el.btnBack.addEventListener("click", () => {
      if (!lyricsSessionActive || !lyricsUIFullscreen) return;
      seekToElapsedMs(0);
    });
  }

  if (el.btnPlayPause) {
    el.btnPlayPause.addEventListener("click", togglePause);
  }

  if (el.progressWrap) {
    el.progressWrap.addEventListener("click", (e) => {
      seekFromProgressPointer(e.clientX);
    });
  }

  if (el.btnNext) {
    el.btnNext.addEventListener("click", async () => {
      if (!playlistContext || !lyricsSessionActive || !lyricsUIFullscreen) return;
      const nextIdx = findNextLyricIndex(currentTrackIndex);
      if (nextIdx < 0) return;
      const t = playlistContext.tracks[nextIdx];
      stopLyricsPlayback();
      await openTrack(t, playlistContext.playlistLabelText, nextIdx);
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && lyricsSessionActive) {
      e.preventDefault();
      closeLyricsOverlay();
    }
  });

  musicDetails.addEventListener("toggle", () => {
    if (musicDetails.open) {
      loadPlaylists();
    } else {
      closeLyricsOverlay();
      setView("playlists");
      if (el.fetchError) el.fetchError.hidden = true;
    }
  });
})();
