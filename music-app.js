(function () {
  "use strict";

  const PLAYLISTS_MANIFEST = "resources/playlists/manifest.json";
  const PLAYLISTS_DIR = "resources/playlists/";
  const LYRICS_DIR = "resources/lyrics/";
  const START_DELAY_MS = 2000;

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

  function hideLyricsDock() {
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
      el.dock.hidden = false;
      el.dock.setAttribute("aria-hidden", "false");
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
      orig.textContent = line.original || "";

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
