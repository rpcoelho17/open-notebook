#!/usr/bin/env python3
"""End-to-end verification of both Speech-to-Speech routes in Open Notebook."""

import asyncio
import base64
import json
import struct
import time
import urllib.request
import wave
from pathlib import Path

import websockets

SAMPLE_WAV = Path(__file__).resolve().parent / "gemini_live_test_output.wav"


async def test_route_1_gemini_live():
    print("=== ROUTE 1: Gemini Live (FastAPI WS proxy -> gemini-3.8-live) ===")
    with urllib.request.urlopen("http://127.0.0.1:5055/api/gemini-live/status", timeout=10) as r:
        st = json.loads(r.read().decode())
    print("  /api/gemini-live/status:", st)
    assert st.get("configured") is True, "Gemini key not configured!"

    # Load 24kHz sample WAV and resample to 16kHz PCM for real audio-in test
    with wave.open(str(SAMPLE_WAV), "rb") as wf:
        raw24 = wf.readframes(wf.getnframes())
    s24 = struct.unpack(f"<{len(raw24) // 2}h", raw24)
    n16 = int(len(s24) * 16000 / 24000)
    pcm16 = struct.pack(f"<{n16}h", *[s24[int(i * 24000 / 16000)] for i in range(n16)])

    t0 = time.time()
    async with websockets.connect("ws://127.0.0.1:5055/api/gemini-live/ws") as ws:
        await ws.send(
            json.dumps(
                {
                    "type": "setup",
                    "model": "gemini-2.5-flash-native-audio-latest",
                    "voice": "Kore",
                    "system_instruction": "Answer concisely in one short friendly sentence.",
                }
            )
        )
        ready = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
        assert ready.get("type") == "ready", f"Unexpected ready: {ready}"
        ws_dt = time.time() - t0

        t_send = time.time()
        for i in range(0, len(pcm16), 3200):
            b64 = base64.b64encode(pcm16[i : i + 3200]).decode("ascii")
            await ws.send(json.dumps({"type": "audio", "data": b64}))
            await asyncio.sleep(0.03)
        # Send 600ms of trailing silence so server-side VAD cleanly detects end-of-speech
        silence_b64 = base64.b64encode(b"\x00" * 3200).decode("ascii")
        for _ in range(6):
            await ws.send(json.dumps({"type": "audio", "data": silence_b64}))
            await asyncio.sleep(0.03)
        await ws.send(json.dumps({"type": "audio_stream_end"}))

        in_tx, out_tx, audio_bytes = [], [], 0
        first_audio = None
        while True:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=20))
            mtype = msg.get("type")
            if mtype == "input_transcript":
                in_tx.append(msg.get("text", ""))
            elif mtype == "output_transcript":
                out_tx.append(msg.get("text", ""))
            elif mtype == "audio":
                if first_audio is None:
                    first_audio = time.time() - t_send
                audio_bytes += len(base64.b64decode(msg["data"]))
            elif mtype == "turn_complete":
                break
            elif mtype == "error":
                raise RuntimeError(msg.get("message"))

        await ws.send(json.dumps({"type": "close"}))

    print(
        f"  PASS | ready={ws_dt:.2f}s | first_audio={first_audio:.2f}s | "
        f"out_audio={audio_bytes} bytes (~{audio_bytes / 48000:.2f}s)"
    )
    print("  IN :", "".join(in_tx).strip())
    print("  OUT:", "".join(out_tx).strip())
    assert audio_bytes > 4000, "Expected non-empty 24kHz audio output"


def test_route_2_local_voice():
    print("=== ROUTE 2: Local Voice + Chat Model (Whisper STT -> Streaming LLM -> Kokoro TTS) ===")
    wav_bytes = SAMPLE_WAV.read_bytes()

    # 1. Local Whisper STT
    req = urllib.request.Request(
        "http://127.0.0.1:8088/v1/audio/transcriptions",
        data=wav_bytes,
        headers={"Content-Type": "audio/wav"},
        method="POST",
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=20) as r:
        stt = json.loads(r.read().decode())
    print(f"  1. Whisper STT ({time.time() - t0:.2f}s):", stt.get("text"))
    assert stt.get("text", "").strip(), "Empty STT result"

    # 2. Streaming Chat LLM
    chat_payload = json.dumps(
        {
            "model": "gpt-6-luna",
            "reasoning_effort": "none",
            "stream": True,
            "messages": [
                {"role": "user", "content": "Reply with exactly: Local voice route is working."}
            ],
        }
    ).encode()
    req = urllib.request.Request(
        "http://127.0.0.1:8088/v1/chat/completions",
        data=chat_payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    reply_parts = []
    with urllib.request.urlopen(req, timeout=25) as r:
        for raw_line in r:
            line = raw_line.decode("utf-8", errors="ignore").strip()
            if not line.startswith("data:"):
                continue
            pl = line[5:].strip()
            if pl == "[DONE]":
                break
            try:
                ev = json.loads(pl)
                d = ev.get("choices", [{}])[0].get("delta", {}).get("content", "")
                if d:
                    reply_parts.append(d)
            except Exception:
                pass
    reply = "".join(reply_parts).strip()
    print(f"  2. Streaming LLM ({time.time() - t0:.2f}s):", reply)
    assert reply, "Empty LLM reply"

    # 3. Local Kokoro-82M TTS
    tts_payload = json.dumps(
        {
            "provider": "kokoro",
            "voice": "af_heart",
            "input": reply,
            "speed": 1.0,
        }
    ).encode()
    req = urllib.request.Request(
        "http://127.0.0.1:8088/v1/audio/speech",
        data=tts_payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=20) as r:
        audio = r.read()
    print(f"  3. Kokoro-82M TTS ({time.time() - t0:.2f}s): {len(audio)} bytes")
    assert len(audio) > 4000, "Expected non-empty Kokoro WAV audio"
    print("  PASS | All 3 local voice stages succeeded!")


async def main():
    await test_route_1_gemini_live()
    test_route_2_local_voice()


if __name__ == "__main__":
    asyncio.run(main())
