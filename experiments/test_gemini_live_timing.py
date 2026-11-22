#!/usr/bin/env python3
"""Experiment: measure Gemini Live audio vs output_transcription timing alignment.

Records every 24kHz PCM audio chunk and every output_transcription chunk with
exact wall-clock arrival times and cumulative scheduled audio duration, then
compares them against faster-whisper word_timestamps ground truth on the same
recorded audio.
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
OUT_WAV = Path(__file__).resolve().parent / "gemini_live_timing_probe.wav"

load_dotenv(ENV_PATH, override=True)

API_KEY = (
    os.getenv("GOOGLE_GEMINI_API")
    or os.getenv("GEMINI_API_KEY")
    or os.getenv("GOOGLE_API_KEY")
    or ""
).strip().strip('"').strip("'")

MODEL = "gemini-2.5-flash-native-audio-latest"
SAMPLE_RATE = 24000
BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000.0  # 48 bytes per ms (16-bit mono PCM)


async def run_probe():
    if not API_KEY:
        print("ERROR: No Gemini API key in .env")
        sys.exit(1)

    client = genai.Client(api_key=API_KEY, http_options={"api_version": "v1beta"})
    config = types.LiveConnectConfig(
        response_modalities=[types.Modality.AUDIO],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Kore")
            )
        ),
        output_audio_transcription=types.AudioTranscriptionConfig(),
    )

    pcm_chunks: list[bytes] = []
    events: list[dict] = []
    cum_audio_bytes = 0

    async with client.aio.live.connect(model=MODEL, config=config) as session:
        t0 = time.perf_counter()
        await session.send_client_content(
            turns=types.Content(
                role="user",
                parts=[
                    types.Part(
                        text="In two clear sentences, explain what a p-value means in hypothesis testing."
                    )
                ],
            ),
            turn_complete=True,
        )

        async for msg in session.receive():
            now_ms = (time.perf_counter() - t0) * 1000.0
            sc = getattr(msg, "server_content", None)
            if not sc:
                continue

            mt = getattr(sc, "model_turn", None)
            if mt and getattr(mt, "parts", None):
                for part in mt.parts:
                    inline = getattr(part, "inline_data", None)
                    if inline and inline.data:
                        data = inline.data
                        pcm_chunks.append(data)
                        prev_audio_ms = cum_audio_bytes / BYTES_PER_MS
                        cum_audio_bytes += len(data)
                        new_audio_ms = cum_audio_bytes / BYTES_PER_MS
                        events.append(
                            {
                                "kind": "audio",
                                "wall_ms": round(now_ms, 1),
                                "audio_start_ms": round(prev_audio_ms, 1),
                                "audio_end_ms": round(new_audio_ms, 1),
                                "chunk_ms": round(len(data) / BYTES_PER_MS, 1),
                            }
                        )

            ot = getattr(sc, "output_transcription", None)
            if ot and getattr(ot, "text", None):
                events.append(
                    {
                        "kind": "text",
                        "wall_ms": round(now_ms, 1),
                        "cum_audio_ms": round(cum_audio_bytes / BYTES_PER_MS, 1),
                        "text": ot.text,
                    }
                )

            if getattr(sc, "turn_complete", False):
                break

    all_pcm = b"".join(pcm_chunks)
    total_audio_ms = len(all_pcm) / BYTES_PER_MS
    with wave.open(str(OUT_WAV), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(all_pcm)

    text_events = [e for e in events if e["kind"] == "text"]
    audio_events = [e for e in events if e["kind"] == "audio"]
    full_text = "".join(e["text"] for e in text_events)

    print(f"MODEL: {MODEL}")
    print(f"AUDIO CHUNKS: {len(audio_events)}, TOTAL AUDIO: {total_audio_ms:.0f} ms")
    print(f"TEXT CHUNKS: {len(text_events)}")
    print(f"FULL TRANSCRIPT: {full_text}\n")
    print("TEXT ARRIVAL TIMELINE (wall_ms | cum_audio_ms_at_arrival | text):")
    for idx, ev in enumerate(text_events):
        print(
            f"  [{idx:02d}] wall={ev['wall_ms']:7.1f}ms | cum_audio={ev['cum_audio_ms']:7.1f}ms | {ev['text']!r}"
        )

    # Compare against faster-whisper ground truth word timestamps!
    try:
        from faster_whisper import WhisperModel

        print("\nRunning faster-whisper word_timestamps ground truth on recorded audio...")
        wm = WhisperModel("base.en", device="cpu", compute_type="int8")
        segs, _ = wm.transcribe(str(OUT_WAV), word_timestamps=True)
        words = []
        for seg in segs:
            for w in seg.words or []:
                words.append((w.word.strip(), round(w.start * 1000), round(w.end * 1000)))
        print(f"GROUND TRUTH WORDS ({len(words)}):")
        for w, s_ms, e_ms in words[:25]:
            print(f"  {s_ms:5d}ms - {e_ms:5d}ms : {w}")
        if len(words) > 25:
            print(f"  ... ({len(words) - 25} more words)")
    except Exception as e:
        print(f"Whisper ground-truth skipped: {e}")


if __name__ == "__main__":
    asyncio.run(run_probe())
