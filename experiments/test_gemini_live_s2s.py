#!/usr/bin/env python3
"""
Standalone experiment to test Google Gemini Live API (Speech-to-Speech / bidiGenerateContent)
using the GEMINI_API_KEY (or GOOGLE_API_KEY) stored in ../.env.
"""

import asyncio
import os
import sys
import time
import wave
from pathlib import Path

from dotenv import load_dotenv
from google import genai
from google.genai import types

REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = REPO_ROOT / ".env"
OUT_WAV = Path(__file__).resolve().parent / "gemini_live_test_output.wav"

load_dotenv(ENV_PATH, override=True)

API_KEY = (
    os.getenv("GEMINI_API_KEY")
    or os.getenv("GOOGLE_API_KEY")
    or os.getenv("GOOGLE_GEMINI_API")
    or ""
).strip().strip('"').strip("'")


async def main():
    if not API_KEY:
        print(f"ERROR: No GEMINI_API_KEY or GOOGLE_API_KEY found in {ENV_PATH}")
        sys.exit(1)

    print(f"[1/3] Loaded API key from {ENV_PATH} (len={len(API_KEY)})")
    client = genai.Client(api_key=API_KEY, http_options={"api_version": "v1beta"})

    # 1. Discover Live-capable (bidiGenerateContent) models on this key
    print("[2/3] Listing Gemini Live (bidiGenerateContent) models available on this key...")
    live_models: list[str] = []
    try:
        for m in client.models.list():
            actions = getattr(m, "supported_actions", None) or []
            name = (getattr(m, "name", "") or "").replace("models/", "")
            if "bidiGenerateContent" in actions or "live" in name.lower():
                live_models.append(name)
    except Exception as e:
        print(f"  Warning listing models: {e}")

    print(f"  Found {len(live_models)} Live-capable model(s): {live_models}")

    # Pick preferred live model
    candidates = [
        "gemini-2.5-flash-native-audio-preview-12-2025",
        "gemini-2.5-flash-native-audio-preview-09-2025",
        "gemini-3.1-flash-live-preview",
        "gemini-2.0-flash-live-001",
    ]
    model_to_test = next((c for c in candidates if c in live_models), None)
    if not model_to_test:
        model_to_test = live_models[0] if live_models else "gemini-2.5-flash-native-audio-preview-12-2025"

    print(f"[3/3] Connecting to Gemini Live WebSocket with model: {model_to_test} ...")
    config = types.LiveConnectConfig(
        response_modalities=[types.Modality.AUDIO],
        output_audio_transcription=types.AudioTranscriptionConfig(),
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Kore")
            )
        ),
    )

    t0 = time.time()
    pcm_chunks: list[bytes] = []
    transcript_parts: list[str] = []
    first_audio_dt: float | None = None

    async with client.aio.live.connect(model=model_to_test, config=config) as session:
        print(f"  WebSocket connected in {time.time() - t0:.2f}s! Sending test prompt...")
        t_send = time.time()
        await session.send_client_content(
            turns=types.Content(
                role="user",
                parts=[
                    types.Part(
                        text="Say hello in one short friendly sentence and confirm Gemini Live speech-to-speech is working."
                    )
                ],
            ),
            turn_complete=True,
        )

        async for msg in session.receive():
            sc = getattr(msg, "server_content", None)
            if not sc:
                continue
            mt = getattr(sc, "model_turn", None)
            if mt and getattr(mt, "parts", None):
                for part in mt.parts:
                    inline = getattr(part, "inline_data", None)
                    if inline and inline.data:
                        if first_audio_dt is None:
                            first_audio_dt = time.time() - t_send
                        pcm_chunks.append(inline.data)
            out_tx = getattr(sc, "output_transcription", None)
            if out_tx and getattr(out_tx, "text", None):
                transcript_parts.append(out_tx.text)
            if getattr(sc, "turn_complete", False):
                break

    total_pcm = b"".join(pcm_chunks)
    total_dt = time.time() - t_send

    if total_pcm:
        with wave.open(str(OUT_WAV), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)  # 16-bit PCM
            wf.setframerate(24000)  # Gemini Live outputs 24 kHz PCM
            wf.writeframes(total_pcm)
        duration_s = len(total_pcm) / (24000 * 2)
        print(
            f"SUCCESS! First audio in {first_audio_dt:.2f}s | total={total_dt:.2f}s | "
            f"audio={len(total_pcm)} bytes (~{duration_s:.2f}s @ 24kHz) -> {OUT_WAV}"
        )
    else:
        print("FAILED: Connected, but received 0 audio bytes.")

    if transcript_parts:
        print("Transcript:", "".join(transcript_parts).strip())


if __name__ == "__main__":
    asyncio.run(main())
