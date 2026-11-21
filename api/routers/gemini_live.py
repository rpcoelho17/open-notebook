import asyncio
import base64
import json
import os
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from loguru import logger

router = APIRouter()

DEFAULT_GEMINI_LIVE_MODEL = "gemini-2.5-flash-native-audio-latest"
DEFAULT_GEMINI_LIVE_VOICE = "Kore"


def _get_env_gemini_key() -> str:
    return (
        os.getenv("GOOGLE_GEMINI_API")
        or os.getenv("GEMINI_API_KEY")
        or os.getenv("GOOGLE_API_KEY")
        or ""
    ).strip().strip('"').strip("'")


@router.get("/gemini-live/status")
async def gemini_live_status():
    key = _get_env_gemini_key()
    return {
        "configured": bool(key),
        "default_model": DEFAULT_GEMINI_LIVE_MODEL,
        "default_voice": DEFAULT_GEMINI_LIVE_VOICE,
        "key_source": "env" if key else "none",
    }


@router.websocket("/gemini-live/ws")
async def gemini_live_ws(websocket: WebSocket):
    await websocket.accept()

    try:
        from google import genai
        from google.genai import types
    except Exception as exc:
        await websocket.send_json(
            {"type": "error", "message": f"google-genai SDK not installed: {exc}"}
        )
        await websocket.close(code=1011)
        return

    try:
        raw_setup = await asyncio.wait_for(websocket.receive_text(), timeout=15.0)
        setup = json.loads(raw_setup)
    except Exception as exc:
        await websocket.send_json({"type": "error", "message": f"Invalid setup payload: {exc}"})
        await websocket.close(code=1008)
        return

    api_key = (setup.get("api_key") or "").strip() or _get_env_gemini_key()
    if not api_key:
        await websocket.send_json(
            {
                "type": "error",
                "message": "No Gemini API key configured in .env (GOOGLE_GEMINI_API / GEMINI_API_KEY).",
            }
        )
        await websocket.close(code=1008)
        return

    model = (setup.get("model") or DEFAULT_GEMINI_LIVE_MODEL).strip()
    voice = (setup.get("voice") or DEFAULT_GEMINI_LIVE_VOICE).strip()
    system_instruction: Optional[str] = (setup.get("system_instruction") or "").strip() or None

    config_kwargs = dict(
        response_modalities=[types.Modality.AUDIO],
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice)
            )
        ),
    )
    if system_instruction:
        config_kwargs["system_instruction"] = system_instruction

    config = types.LiveConnectConfig(**config_kwargs)
    client = genai.Client(api_key=api_key, http_options={"api_version": "v1beta"})

    try:
        async with client.aio.live.connect(model=model, config=config) as session:
            await websocket.send_json({"type": "ready", "model": model, "voice": voice})

            async def client_to_gemini():
                try:
                    while True:
                        raw = await websocket.receive_text()
                        msg = json.loads(raw)
                        msg_type = msg.get("type")

                        if msg_type == "audio":
                            b64 = msg.get("data")
                            if b64:
                                pcm_bytes = base64.b64decode(b64)
                                await session.send_realtime_input(
                                    audio=types.Blob(
                                        data=pcm_bytes, mime_type="audio/pcm;rate=16000"
                                    )
                                )
                        elif msg_type == "audio_stream_end":
                            await session.send_realtime_input(audio_stream_end=True)
                        elif msg_type == "text":
                            text = (msg.get("text") or "").strip()
                            if text:
                                await session.send_client_content(
                                    turns=types.Content(
                                        role="user", parts=[types.Part(text=text)]
                                    ),
                                    turn_complete=True,
                                )
                        elif msg_type == "close":
                            break
                except WebSocketDisconnect:
                    pass
                except asyncio.CancelledError:
                    pass
                except Exception as exc:
                    logger.warning(f"Gemini Live client_to_gemini error: {exc}")

            async def gemini_to_client():
                try:
                    while True:
                        async for response in session.receive():
                            sc = getattr(response, "server_content", None)
                            if not sc:
                                continue

                            if getattr(sc, "interrupted", False):
                                await websocket.send_json({"type": "interrupted"})

                            in_tx = getattr(sc, "input_transcription", None)
                            if in_tx and getattr(in_tx, "text", None):
                                await websocket.send_json(
                                    {"type": "input_transcript", "text": in_tx.text}
                                )

                            out_tx = getattr(sc, "output_transcription", None)
                            if out_tx and getattr(out_tx, "text", None):
                                await websocket.send_json(
                                    {"type": "output_transcript", "text": out_tx.text}
                                )

                            mt = getattr(sc, "model_turn", None)
                            if mt and getattr(mt, "parts", None):
                                for part in mt.parts:
                                    inline = getattr(part, "inline_data", None)
                                    if inline and inline.data:
                                        b64_audio = base64.b64encode(inline.data).decode("ascii")
                                        await websocket.send_json(
                                            {"type": "audio", "data": b64_audio}
                                        )

                            if getattr(sc, "turn_complete", False):
                                await websocket.send_json({"type": "turn_complete"})
                except WebSocketDisconnect:
                    pass
                except asyncio.CancelledError:
                    pass
                except Exception as exc:
                    logger.warning(f"Gemini Live gemini_to_client error: {exc}")
                    try:
                        await websocket.send_json({"type": "error", "message": str(exc)})
                    except Exception:
                        pass

            t_in = asyncio.create_task(client_to_gemini())
            t_out = asyncio.create_task(gemini_to_client())
            done, pending = await asyncio.wait(
                {t_in, t_out}, return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

    except Exception as exc:
        logger.error(f"Gemini Live WebSocket session failed: {exc}")
        try:
            await websocket.send_json({"type": "error", "message": str(exc)})
            await websocket.close(code=1011)
        except Exception:
            pass
