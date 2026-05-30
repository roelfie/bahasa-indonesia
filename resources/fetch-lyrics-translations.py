#!/usr/bin/env python3
"""Fetch lyrics for Spotify tracks and write English translations to resources/lyrics/.

Spotify does not expose lyrics via its public API. This script uses LRCLIB (lrclib.net),
a free lyrics database with optional synced (LRC) timestamps, then translates each line
to English via Google Translate (deep-translator).

Usage:
    cd resources
    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    .venv/bin/python fetch-lyrics-translations.py Indo_songs_sample.json
    ./fetch-lyrics-translations.py Indo_songs_-_Level_1.json --limit 3
    ./fetch-lyrics-translations.py Indo_songs_-_Level_1.json --skip-existing
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

try:
    from deep_translator import GoogleTranslator
except ImportError:
    print("Missing dependency: pip install -r requirements.txt", file=sys.stderr)
    raise SystemExit(1)

LRCLIB_GET = "https://lrclib.net/api/get"
LRCLIB_SEARCH = "https://lrclib.net/api/search"
USER_AGENT = "bahasa-indonesia-lyrics/1.0"

LRC_LINE = re.compile(
    r"^\[(\d+):(\d{2})(?:\.(\d{2,3}))?\]\s*(.*)$"
)
METADATA_TAG = re.compile(r"^\[[a-z]+:", re.I)

REQUIRED_TRACK_KEYS = {"track_id", "track_uri", "track_name", "artist_names", "duration_ms"}


def resources_dir() -> Path:
    return Path(__file__).resolve().parent


def lyrics_dir() -> Path:
    path = resources_dir() / "lyrics"
    path.mkdir(parents=True, exist_ok=True)
    return path


def http_get_json(url: str) -> object | None:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def duration_seconds(duration_ms: int) -> int:
    return max(1, round(duration_ms / 1000))


def primary_artist(artist_names: str) -> str:
    return artist_names.split(";")[0].split(",")[0].strip()


def fetch_lrclib(track: dict) -> dict | None:
    duration = duration_seconds(int(track["duration_ms"]))
    params = urllib.parse.urlencode(
        {
            "track_name": track["track_name"],
            "artist_name": primary_artist(track["artist_names"]),
            "album_name": track.get("album_name", ""),
            "duration": duration,
        }
    )
    result = http_get_json(f"{LRCLIB_GET}?{params}")
    if result:
        return result

    query = f"{primary_artist(track['artist_names'])} {track['track_name']}"
    search = http_get_json(f"{LRCLIB_SEARCH}?{urllib.parse.urlencode({'q': query})}")
    if not search:
        return None

    for candidate in search:
        if abs(candidate.get("duration", 0) - duration) <= 3:
            return candidate
    return search[0] if search else None


def lrc_timestamp_ms(minutes: str, seconds: str, fraction: str | None) -> int:
    mins = int(minutes)
    secs = int(seconds)
    frac_ms = 0
    if fraction:
        frac_ms = int(fraction.ljust(3, "0")[:3])
    return (mins * 60 + secs) * 1000 + frac_ms


def parse_lrc(synced: str) -> list[tuple[int | None, str]]:
    lines: list[tuple[int | None, str]] = []
    for raw in synced.splitlines():
        raw = raw.strip()
        if not raw or METADATA_TAG.match(raw):
            continue
        match = LRC_LINE.match(raw)
        if match:
            ms = lrc_timestamp_ms(match.group(1), match.group(2), match.group(3))
            text = match.group(4).strip()
            if text:
                lines.append((ms, text))
        elif raw and not raw.startswith("["):
            lines.append((None, raw))
    return lines


def parse_plain(plain: str) -> list[tuple[int | None, str]]:
    return [(None, line.strip()) for line in plain.splitlines() if line.strip()]


def lyrics_to_lines(lrclib_record: dict) -> list[tuple[int | None, str]]:
    synced = (lrclib_record.get("syncedLyrics") or "").strip()
    if synced:
        parsed = parse_lrc(synced)
        if parsed:
            return parsed

    plain = (lrclib_record.get("plainLyrics") or "").strip()
    if plain:
        return parse_plain(plain)

    return []


def compute_end_ms(lines: list[dict]) -> None:
    for i, line in enumerate(lines):
        if line["start_ms"] is None:
            line["end_ms"] = None
            continue
        end = None
        for j in range(i + 1, len(lines)):
            if lines[j]["start_ms"] is not None:
                end = lines[j]["start_ms"] - 1
                break
        line["end_ms"] = end


def translate_lines(
    lines: list[tuple[int | None, str]],
    *,
    source: str,
    target: str,
    delay_s: float,
) -> list[dict]:
    translator = GoogleTranslator(source=source, target=target)
    out: list[dict] = []

    for line_number, (start_ms, original) in enumerate(lines, start=1):
        try:
            translation = translator.translate(original)
        except Exception as e:
            raise RuntimeError(f"translation failed at line {line_number}: {original!r}") from e

        out.append(
            {
                "line_number": line_number,
                "original": original,
                "translation": translation or "",
                "start_ms": start_ms,
                "end_ms": None,
            }
        )
        if delay_s > 0:
            time.sleep(delay_s)

    compute_end_ms(out)
    return out


def build_song_document(
    track: dict,
    *,
    lines: list[dict],
    lyrics_source: str,
    source_language: str,
    target_language: str,
) -> dict:
    return {
        "track_id": track["track_id"],
        "track_uri": track["track_uri"],
        "track_name": track["track_name"],
        "album_name": track.get("album_name", ""),
        "artist_names": track["artist_names"],
        "duration_ms": track["duration_ms"],
        "source_language": source_language,
        "target_language": target_language,
        "lyrics_source": lyrics_source,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "lines": lines,
    }


def load_tracks(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("input JSON must be an array of track objects")

    tracks = []
    for i, item in enumerate(data):
        if not isinstance(item, dict):
            raise ValueError(f"track at index {i} is not an object")
        missing = REQUIRED_TRACK_KEYS - item.keys()
        if missing:
            raise ValueError(f"track at index {i} missing keys: {', '.join(sorted(missing))}")
        tracks.append(item)
    return tracks


def output_path(track_id: str) -> Path:
    return lyrics_dir() / f"{track_id}.json"


def process_track(
    track: dict,
    *,
    source_language: str,
    target_language: str,
    delay_s: float,
    skip_existing: bool,
) -> str:
    out_file = output_path(track["track_id"])
    if skip_existing and out_file.is_file():
        return "skipped"

    lrclib = fetch_lrclib(track)
    if not lrclib:
        raise LookupError("no lyrics found (LRCLIB)")

    raw_lines = lyrics_to_lines(lrclib)
    if not raw_lines:
        raise LookupError("lyrics record had no parseable text")

    translated = translate_lines(
        raw_lines,
        source=source_language,
        target=target_language,
        delay_s=delay_s,
    )

    doc = build_song_document(
        track,
        lines=translated,
        lyrics_source="lrclib",
        source_language=source_language,
        target_language=target_language,
    )
    out_file.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return "written"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fetch lyrics and English translations for tracks in a playlist JSON file."
    )
    parser.add_argument(
        "playlist_json",
        type=Path,
        help="JSON file with track_id, track_uri, track_name, artist_names, duration_ms, …",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="process at most N tracks (0 = all)",
    )
    parser.add_argument(
        "--skip-existing",
        action="store_true",
        help="skip tracks that already have a file in lyrics/",
    )
    parser.add_argument(
        "--source-lang",
        default="id",
        help="source language code for translation (default: id)",
    )
    parser.add_argument(
        "--target-lang",
        default="en",
        help="target language code for translation (default: en)",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.15,
        help="seconds to wait between translation requests (default: 0.15)",
    )
    args = parser.parse_args()

    playlist_path = args.playlist_json
    if not playlist_path.is_file():
        playlist_path = resources_dir() / args.playlist_json
    if not playlist_path.is_file():
        print(f"Error: file not found: {args.playlist_json}", file=sys.stderr)
        return 1

    try:
        tracks = load_tracks(playlist_path)
    except (json.JSONDecodeError, ValueError) as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    if args.limit > 0:
        tracks = tracks[: args.limit]

    written = skipped = failed = 0
    for track in tracks:
        name = track["track_name"]
        tid = track["track_id"]
        try:
            status = process_track(
                track,
                source_language=args.source_lang,
                target_language=args.target_lang,
                delay_s=args.delay,
                skip_existing=args.skip_existing,
            )
            if status == "skipped":
                skipped += 1
                print(f"  skip  {tid}  {name}")
            else:
                written += 1
                print(f"  ok    {tid}  {name}  -> lyrics/{tid}.json")
        except Exception as e:
            failed += 1
            print(f"  fail  {tid}  {name}  ({e})", file=sys.stderr)

    print(f"\nDone: {written} written, {skipped} skipped, {failed} failed -> {lyrics_dir()}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
