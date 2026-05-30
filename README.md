View on [GitHub Pages](https://roelfie.github.io/bahasa-indonesia/).

## Local preview (Music & JSON)

The Music section loads `resources/playlists/manifest.json` and playlist/lyrics JSON via `fetch`. Open the site over HTTP, not as a `file://` URL:

```bash
cd /path/to/bahasa-indonesia
python3 -m http.server 8080
```

Then open `http://localhost:8080/`.

Playlist files are listed in `resources/playlists/manifest.json` (add a filename when you add a new `*.json` playlist). Lyrics are read from `resources/lyrics/{track_id}.json`.

Use a virtual python environment:

In the project home directory:
source .venv/bin/activate
python resources/my-script.py

Or in the resources folder:
cd resources
../.venv/bin/python my-script.py


