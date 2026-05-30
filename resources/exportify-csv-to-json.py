#!/usr/bin/env python3
"""Convert an Exportify playlist CSV to a slim JSON file.

Usage:
    ./exportify-csv-to-json.py path/to/playlist.csv

Output: resources/playlists/<input-basename>.json (not beside the CSV)
"""

import csv
import json
import sys
from pathlib import Path

COLUMNS = {
    "Track URI": "track_uri",
    "Track Name": "track_name",
    "Album Name": "album_name",
    "Artist Name(s)": "artist_names",
    "Duration (ms)": "duration_ms",
}

INTEGER_FIELDS = {"duration_ms"}


def coerce(key: str, value: str):
    if key in INTEGER_FIELDS and value.strip().isdigit():
        return int(value.strip())
    return value


def track_id_from_uri(uri: str) -> str:
    uri = uri.strip()
    if not uri:
        return ""
    return uri.rsplit(":", 1)[-1]


def row_from_csv(row: dict) -> dict:
    fields = {prop: coerce(prop, row.get(header, "") or "") for header, prop in COLUMNS.items()}
    return {
        "track_id": track_id_from_uri(fields["track_uri"]),
        **fields,
    }


def playlists_dir() -> Path:
    path = Path(__file__).resolve().parent / "playlists"
    path.mkdir(parents=True, exist_ok=True)
    return path


def convert(csv_path: Path, out_dir: Path | None = None) -> tuple[Path, int]:
    json_path = (out_dir or playlists_dir()) / f"{csv_path.stem}.json"

    rows = []
    with csv_path.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None:
            raise ValueError("CSV has no header row")

        fieldnames = [name.strip() for name in reader.fieldnames]
        reader.fieldnames = fieldnames

        missing = [h for h in COLUMNS if h not in fieldnames]
        if missing:
            raise ValueError(f"missing column(s): {', '.join(missing)}")

        for row in reader:
            rows.append(row_from_csv(row))

    json_path.write_text(json.dumps(rows, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return json_path, len(rows)


def main() -> int:
    if len(sys.argv) != 2:
        print(f"Usage: {Path(sys.argv[0]).name} <exportify.csv>", file=sys.stderr)
        return 1

    csv_path = Path(sys.argv[1])
    if not csv_path.is_file():
        print(f"Error: file not found: {csv_path}", file=sys.stderr)
        return 1
    if csv_path.suffix.lower() != ".csv":
        print(f"Error: expected a .csv file: {csv_path}", file=sys.stderr)
        return 1

    try:
        json_path, count = convert(csv_path)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    print(f"Wrote {count} tracks to {json_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
