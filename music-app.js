(function () {
  "use strict";

  const PLAYLISTS_MANIFEST = "resources/playlists/manifest.json";
  const PLAYLISTS_DIR = "resources/playlists/";
  const LYRICS_DIR = "resources/lyrics/";

  const musicDetails = document.querySelector(".accordion-item--music");
  if (!musicDetails) return;

  const el = {
    playlistsView: document.getElementById("music-view-playlists"),
    tracksView: document.getElementById("music-view-tracks"),
    karaokeView: document.getElementById("music-view-karaoke"),
    playlistList: document.getElementById("music-playlist-list"),
    tracksTitle: document.getElementById("music-tracks-title"),
    tracksBody: document.getElementById("music-tracks-tbody"),
    karaokeTitle: document.getElementById("music-karaoke-title"),
    karaokeMeta: document.getElementById("music-karaoke-meta"),
    progressBar: document.getElementById("music-progress-bar"),
    progressWrap: document.getElementById("music-progress"),
    progressElapsed: document.getElementById("music-progress-elapsed"),
    progressTotal: document.getElementById("music-progress-total"),
    karaokeLines: document.getElementById("music-karaoke-lines"),
    fetchError: document.getElementById("music-fetch-error"),
    breadcrumb: document.getElementById("music-breadcrumb"),
    bcPlaylists: document.getElementById("music-bc-playlists"),
    bcPlaylist: document.getElementById("music-bc-playlist"),
    bcTrack: document.getElementById("music-bc-track"),
    bcSep1: document.getElementById("music-bc-sep-1"),
    bcSep2: document.getElementById("music-bc-sep-2"),
  };

  let playlistsLoaded = false;
  let rafId = null;
  let playStartPerf = 0;
  let currentDurationMs = 0;
  let lineElements = [];
  let lineTiming = [];
  let lastActiveLine = -1;

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

  function stopKaraoke() {
    cancelRaf();
    lineElements = [];
    lineTiming = [];
    lastActiveLine = -1;
  }

  function setView(name) {
    el.playlistsView.hidden = name !== "playlists";
    el.tracksView.hidden = name !== "tracks";
    el.karaokeView.hidden = name !== "karaoke";
    if (name !== "karaoke") stopKaraoke();

    const showBc = name !== "playlists";
    el.breadcrumb.hidden = !showBc;
    el.bcSep1.hidden = name === "playlists";
    el.bcPlaylist.hidden = name === "playlists";
    el.bcSep2.hidden = name !== "karaoke";
    el.bcTrack.hidden = name !== "karaoke";
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

  function tickKaraoke() {
    const elapsed = performance.now() - playStartPerf;
    const clamped = Math.min(elapsed, currentDurationMs);
    const pct = currentDurationMs > 0 ? (clamped / currentDurationMs) * 100 : 0;

    el.progressBar.style.width = `${pct}%`;
    if (el.progressWrap) el.progressWrap.setAttribute("aria-valuenow", String(Math.round(pct)));
    el.progressElapsed.textContent = formatMmSs(clamped);
    el.progressTotal.textContent = formatMmSs(currentDurationMs);

    let activeIndex = -1;
    for (let i = 0; i < lineTiming.length; i++) {
      const { start, end } = lineTiming[i];
      if (clamped >= start && clamped <= end) {
        activeIndex = i;
        break;
      }
    }

    lineElements.forEach((node, i) => {
      node.classList.toggle("music-line--active", i === activeIndex);
    });
    if (activeIndex !== lastActiveLine && activeIndex >= 0 && lineElements[activeIndex]) {
      lineElements[activeIndex].scrollIntoView({ block: "center", behavior: "smooth" });
      lastActiveLine = activeIndex;
    }

    if (elapsed < currentDurationMs + 500) {
      rafId = requestAnimationFrame(tickKaraoke);
    } else {
      rafId = null;
    }
  }

  function startKaraokeTimer(durationMs) {
    cancelRaf();
    lastActiveLine = -1;
    currentDurationMs = durationMs;
    playStartPerf = performance.now();
    rafId = requestAnimationFrame(tickKaraoke);
  }

  async function openTrack(track, playlistLabelText) {
    if (track.hasLyrics === false) return;

    const trackId = track.track_id;
    const webUrl = `https://open.spotify.com/track/${trackId}`;
    window.open(webUrl, "_blank", "noopener,noreferrer");

    el.karaokeTitle.textContent = track.track_name || "Track";
    el.karaokeMeta.textContent = [track.artist_names, track.album_name].filter(Boolean).join(" · ");
    el.bcTrack.textContent = track.track_name || trackId;

    el.karaokeLines.innerHTML = "";
    el.progressBar.style.width = "0%";
    el.progressElapsed.textContent = "0:00";
    const dur = Number(track.duration_ms) || 0;
    el.progressTotal.textContent = formatMmSs(dur);

    let lyrics;
    try {
      lyrics = await fetchJson(`${LYRICS_DIR}${encodeURIComponent(trackId)}.json`);
    } catch {
      el.karaokeLines.innerHTML =
        '<p class="music-karaoke-missing">No lyrics file found for this track. Generate <code>resources/lyrics/' +
        trackId +
        ".json</code> with the fetch script.</p>";
      setView("karaoke");
      el.bcPlaylist.textContent = playlistLabelText;
      startKaraokeTimer(dur);
      return;
    }

    const lines = Array.isArray(lyrics.lines) ? lyrics.lines : [];
    lineTiming = buildLineTimings(lines, dur);

    lines.forEach((line, i) => {
      const row = document.createElement("div");
      row.className = "music-line";
      row.dataset.lineIndex = String(i);

      const orig = document.createElement("div");
      orig.className = "music-line-original";
      orig.textContent = line.original || "";

      const trans = document.createElement("div");
      trans.className = "music-line-translation";
      trans.textContent = line.translation || "";

      row.appendChild(orig);
      row.appendChild(trans);
      el.karaokeLines.appendChild(row);
    });

    lineElements = Array.from(el.karaokeLines.querySelectorAll(".music-line"));

    setView("karaoke");
    el.bcPlaylist.textContent = playlistLabelText;
    startKaraokeTimer(dur);
  }

  async function renderTracks(tracks, playlistFilename, playlistLabelText) {
    el.tracksTitle.textContent = playlistLabelText;
    el.tracksTitle.dataset.playlistFile = playlistFilename;
    el.bcPlaylist.textContent = playlistLabelText;
    setView("tracks");
    el.tracksBody.innerHTML = `
      <tr>
        <td colspan="4" class="music-loading-row">Checking lyrics files…</td>
      </tr>
    `;

    const enriched = await enrichTracksWithLyrics(tracks);
    el.tracksBody.innerHTML = "";

    enriched.forEach((track) => {
      const hasLyrics = track.hasLyrics === true;
      const tr = document.createElement("tr");
      tr.className = "music-track-row" + (hasLyrics ? "" : " music-track-row--no-lyrics");
      if (!hasLyrics) tr.setAttribute("aria-disabled", "true");
      tr.title = hasLyrics ? "" : "No lyrics JSON in resources/lyrics/ for this track";

      const lyricsCell = hasLyrics
        ? `<td class="music-td-lyrics"></td>`
        : `<td class="music-td-lyrics"><span class="music-lyrics-missing">No lyrics</span></td>`;

      tr.innerHTML = `
        <td class="music-td-name">${escapeHtml(track.track_name || "")}</td>
        <td class="music-td-artist">${escapeHtml(track.artist_names || "")}</td>
        <td class="music-td-dur">${formatMmSs(Number(track.duration_ms) || 0)}</td>
        ${lyricsCell}
      `;

      if (hasLyrics) {
        tr.addEventListener("click", () => {
          openTrack(track, playlistLabelText);
        });
        tr.tabIndex = 0;
        tr.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openTrack(track, playlistLabelText);
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

  musicDetails.addEventListener("toggle", () => {
    if (musicDetails.open) {
      loadPlaylists();
    } else {
      setView("playlists");
      if (el.fetchError) el.fetchError.hidden = true;
    }
  });

})();
