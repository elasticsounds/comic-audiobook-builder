# Comic Audiobook Studio

A fully **client-side** web app that turns a PDF comic into a single MP3 audiobook:

1. **Drop a PDF** into the page.
2. It renders the pages locally and sends them to **GPT (vision)** to produce a TTS transcript.
3. **Review & edit** the transcript (per-line table + raw JSON), saved automatically in your browser.
4. **Generate audiobook** — each line is voiced with OpenAI TTS, you watch live progress + a console log…
5. …then the stitched **MP3 downloads** to your computer.

No server, no build step. Everything runs in the browser and your OpenAI API key never leaves it (except in the direct calls to `api.openai.com`).

---

## Run locally

ES modules require an HTTP server (opening `index.html` via `file://` won't work). From the repo root:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Open **⚙ Settings**, paste your OpenAI API key, confirm the model IDs, and you're ready.

## Deploy to GitHub Pages

The app lives at the repo root (`index.html`, `css/`, `js/`, `vendor/`), so serving it is one setting:

1. Push the repo to GitHub.
2. Repo **Settings → Pages → Build and deployment**: Source = *Deploy from a branch*, Branch = `main`, Folder = `/ (root)`.
3. Your app is at `https://<user>.github.io/<repo>/`.

> GitHub Pages serves over HTTPS, so the vendored ES modules and OpenAI calls work without extra config. The `.nojekyll` file disables Jekyll so the `vendor/` and `.mjs` files are served untouched.

## Settings

| Setting | Default | Notes |
|---|---|---|
| OpenAI API key | — | Transcript (vision) + OpenAI TTS. Stored in `localStorage`, sent only to `api.openai.com`. |
| Google Gemini API key | — | Only for Gemini TTS models. Sent only to `generativelanguage.googleapis.com`. |
| Transcript model | `gpt-5.5` | Must be **vision-capable** and on the **Responses API**. Change if your exact model ID differs. |
| TTS model | `gpt-4o-mini-tts` | Pick from the dropdown — see TTS models below. |
| Max pages to read | `40` | Caps vision cost; extra pages are skipped with a warning. |
| Page image width | `1024` px | Higher = sharper but pricier vision calls. |
| MP3 bitrate | `128` kbps | Final encode quality. |

### TTS models

| Model | Provider | Notes |
|---|---|---|
| `gpt-4o-mini-tts` | OpenAI | Steerable — honors the per-line `instructions` (tone, pace, accent). |
| `tts-1` | OpenAI | Fast, lower quality. Ignores `instructions`. |
| `tts-1-hd` | OpenAI | Higher quality. Ignores `instructions`. |
| `gemini-2.5-flash-preview-tts` | Gemini | Fast. No `instructions` field — delivery notes are folded into the spoken prompt. |
| `gemini-2.5-pro-preview-tts` | Gemini | Higher quality. Same prompt-based steering. |

OpenAI and Gemini use **different voice sets** (e.g. `alloy`/`onyx` vs `Kore`/`Puck`). Switching the model between providers automatically re-maps each character to a distinct voice in the new provider's set; you can also hit **↻ Auto-assign distinct voices** or pick per character. Use **▶** next to each character to audition before generating. The transcript step is always OpenAI (vision), so an OpenAI key is required regardless of which TTS provider you use.

## How it works

- **PDF** → [`pdf.js`](https://mozilla.github.io/pdf.js/) renders each page to a JPEG and pulls any embedded text.
- **Transcript** → pages are sent to the OpenAI **Responses API** with a strict JSON schema, returning `{ title, voices, items[] }`. Each item has `id, page, panel, type, speaker, voice, emotion, instructions, text, pause_after_ms`.
- **TTS** → each item is voiced (with retry). OpenAI returns MP3; Gemini returns base64 PCM (16-bit/24 kHz/mono). Both are decoded to a Web Audio buffer.
- **Stitching** → an `OfflineAudioContext` concatenates every segment at 44.1 kHz mono, inserting `pause_after_ms` of silence after each line.
- **MP3** → the mixed buffer is encoded with [`lamejs`](https://github.com/zhuker/lamejs) and downloaded.

## Security note

Calling OpenAI directly from the browser means the API key lives in the page. That's fine for a personal/local tool where **each user supplies their own key**. Do **not** hardcode a key into the source or deploy a copy with your key embedded — anyone visiting the page could use it.

## Files

```
index.html        app shell
css/styles.css    styling
js/app.js         all logic
vendor/           pdf.js + lamejs (committed, no CDN needed)
.nojekyll         disables Jekyll on GitHub Pages
```

## Relation to `process.py`

`process.py` (in the repo root) is the original local Python pipeline (reads `script.json`, calls OpenAI TTS, stitches one MP3 with `pydub`/ffmpeg). This web app reimplements that flow entirely in the browser and adds PDF → transcript generation. The `items` schema is compatible, so a JSON exported here can also be fed to the Python script.
