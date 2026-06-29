import json
import os
import re
from io import BytesIO
from pathlib import Path

from openai import OpenAI
from pydub import AudioSegment

# ----------------------------------------------------
# Configuration
# ----------------------------------------------------

API_KEY = os.getenv("OPENAI_API_KEY") or "YOUR_API_KEY_HERE"

MODEL = "gpt-4o-mini-tts"

OUTPUT_DIR = Path("output")
OUTPUT_DIR.mkdir(exist_ok=True)

client = OpenAI(api_key=API_KEY)

# ----------------------------------------------------
# Load Script
# ----------------------------------------------------

with open("script.json", "r", encoding="utf-8") as f:
    data = json.load(f)

items = data["items"]
title = data.get("title", "audiobook")

slug = re.sub(r"[^a-z0-9]+", "_", title.lower()).strip("_") or "audiobook"
output_file = OUTPUT_DIR / f"{slug}.mp3"

# ----------------------------------------------------
# Generate Audio and Stitch Into One File
# ----------------------------------------------------

book = AudioSegment.empty()

for i, line in enumerate(items, 1):

    print(f"[{i}/{len(items)}] {line['id']} ({line['speaker']})")

    with client.audio.speech.with_streaming_response.create(
        model=MODEL,
        voice=line["voice"],
        input=line["text"],
        instructions=line["instructions"],
        response_format="mp3",
    ) as response:
        audio_bytes = response.read()

    book += AudioSegment.from_file(BytesIO(audio_bytes), format="mp3")

    pause_ms = line.get("pause_after_ms", 0)
    if pause_ms:
        book += AudioSegment.silent(duration=pause_ms)

book.export(output_file, format="mp3")

print(f"Done. Wrote {output_file} ({len(book) / 1000:.1f}s, {len(items)} lines).")
