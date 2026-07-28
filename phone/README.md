# gallery-bridge — the phone's camera roll, on localhost

A web page cannot read a gallery. The most it can do is open a file picker,
which means picking the phone up and tapping twice — fine in the companion app,
where you are already holding it, and useless on the glasses, where the entire
point is not to.

So the phone runs a ~250-line Python script that serves its newest photos over
HTTP on loopback. The app runs **on that phone**, so it can just fetch it, and
the workflow becomes:

> shoot the sheet with the phone camera → look up → tap the temple

Nothing else in this repo depends on it. Without the bridge the companion app's
file picker still works and the glasses' Settings page says it is not
configured.

## Install

Termux, no dependencies beyond Python:

```bash
pkg install -y python
termux-setup-storage          # once, and grant the permission Android asks for
python3 ~/evens/phone/gallery.py
```

It prints the line you paste into the companion app:

```
gallery-bridge on http://127.0.0.1:8790
  ✓ /sdcard/DCIM/Camera
  ✗ /sdcard/Pictures

  paste this into the companion app's Settings tab:

    http://127.0.0.1:8790?t=Xf3k…
```

Open the companion app → **Photo** tab → *Phone gallery bridge* → paste → Save.
The glasses' Settings page reads the same setting; it is one web app on one
phone, so configuring it once configures both.

To keep it running across reboots, add it to Termux:Boot the same way
`lookcam/phone/termux-run.sh` does.

## Endpoints

| route | what |
|---|---|
| `GET /health` | is it up, and which directories exist. **No token** — the app has to be able to ask before it has been given one |
| `GET /recent.json?n=12` | the newest photos as metadata, no pixels |
| `GET /latest.json` | just the newest one's metadata |
| `GET /latest` | the newest photo itself |
| `GET /photo?id=…` | one specific photo from a listing |

## Why there is a token

Loopback binding stops anything **off** the phone reaching this. It does not
stop anything **on** it: without a token, any web page you happened to visit
while this was running could fetch `localhost:8790/latest` and read your camera
roll. So a token is generated on first run into `~/.evens-gallery-token`,
printed as part of the URL, and required on every route but `/health`.

`--allow-any` turns the check off. It is convenient while setting up and a bad
idea to leave on, which is why it says so on startup every time.

It never writes, deletes or moves anything, and serves only files under the
configured roots with an image extension. `id` is resolved against a fresh
listing rather than used as a path, so it cannot be walked out of the gallery.

## Options

| flag / env | default | |
|---|---|---|
| `--port` / `GALLERY_PORT` | `8790` | |
| `--host` / `GALLERY_HOST` | `127.0.0.1` | anything else exposes your camera roll to the network |
| `--roots` / `GALLERY_DIRS` | `DCIM/Camera`, `DCIM`, `Pictures`, `Download` | colon-separated in the env var |
| `--allow-any` | off | no token (see above) |
| `GALLERY_TOKEN` | generated | fix the token instead of reading the file |
