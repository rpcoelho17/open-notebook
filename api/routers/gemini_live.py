import asyncio
import base64
import json
import os
from typing import List, Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from loguru import logger

from open_notebook.ai.models import model_manager
from open_notebook.domain.notebook import (
    resolve_notebook_scope,
    text_search,
    vector_search,
)

router = APIRouter()

DEFAULT_GEMINI_LIVE_MODEL = "gemini-2.5-flash-native-audio-latest"
DEFAULT_GEMINI_LIVE_VOICE = "Kore"
# Keep system_instruction and turn payloads well within Gemini Live's 128k-token
# window (dense API/code docs average ~2 chars/token), preventing 1007 errors.
MAX_SYSTEM_INSTRUCTION_CHARS = 110_000
MAX_TURN_TEXT_CHARS = 50_000
LIVE_TOOL_RAG_MAX_CHARS = 18_000


async def _run_notebook_rag(
    query: str,
    notebook_id: str,
    allowed_parent_ids: Optional[List[str]] = None,
    max_chars: int = LIVE_TOOL_RAG_MAX_CHARS,
    limit: int = 12,
    minimum_score: float = 0.22,
) -> str:
    """Run vector RAG (with text fallback) scoped to the active notebook's checked items."""
    q = (query or "").strip()
    if not q or not notebook_id:
        return ""

    try:
        notebook_ids = await resolve_notebook_scope([notebook_id])
        results = []
        if await model_manager.get_embedding_model():
            results = await vector_search(
                keyword=q,
                results=limit,
                source=True,
                note=True,
                minimum_score=minimum_score,
                notebook_ids=notebook_ids,
            )
        if not results:
            results = await text_search(
                keyword=q,
                results=limit,
                source=True,
                note=True,
                notebook_ids=notebook_ids,
            )
    except Exception as exc:
        logger.warning(f"Gemini Live RAG search failed for query {q!r}: {exc}")
        return ""

    allowed_set = set(allowed_parent_ids or [])
    blocks: List[str] = []
    used = 0
    for item in results or []:
        pid = str(item.get("parent_id") or "")
        item_id = str(item.get("id") or "")
        if allowed_set and pid not in allowed_set and item_id not in allowed_set:
            continue

        title = str(item.get("title") or pid or "Source")
        sim = item.get("similarity")
        sim_str = f"{sim:.3f}" if isinstance(sim, (int, float)) else "n/a"
        raw_matches = item.get("matches") or item.get("content") or ""
        if isinstance(raw_matches, list):
            body = "\n\n".join(str(m) for m in raw_matches if m)
        else:
            body = str(raw_matches)
        body = body.strip()
        if not body:
            continue

        chunk = f"[Retrieved from: {title} | similarity={sim_str}]\n{body}"
        if used + len(chunk) > max_chars:
            remaining = max_chars - used
            if remaining > 400:
                blocks.append(chunk[:remaining])
            break
        blocks.append(chunk)
        used += len(chunk)

    return "\n\n".join(blocks)


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
    enable_rag_tool = bool(setup.get("enable_rag_tool", False))
    notebook_id: Optional[str] = (setup.get("notebook_id") or "").strip() or None
    raw_allowed = setup.get("allowed_parent_ids")
    allowed_parent_ids: List[str] = (
        [str(x) for x in raw_allowed if x] if isinstance(raw_allowed, list) else []
    )
    system_instruction: Optional[str] = (setup.get("system_instruction") or "").strip() or None
    if system_instruction and len(system_instruction) > MAX_SYSTEM_INSTRUCTION_CHARS:
        logger.warning(
            f"Truncating Gemini Live system_instruction from {len(system_instruction):,} "
            f"to {MAX_SYSTEM_INSTRUCTION_CHARS:,} chars to stay within Live API limits."
        )
        system_instruction = (
            system_instruction[:MAX_SYSTEM_INSTRUCTION_CHARS]
            + "\n\n[Additional source content omitted for Live context budget; use per-turn retrieved passages.]"
        )

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
    if enable_rag_tool and notebook_id:
        config_kwargs["tools"] = [
            types.Tool(
                function_declarations=[
                    types.FunctionDeclaration(
                        name="search_notebook",
                        description=(
                            "Search the active notebook's indexed sources and notes for "
                            "the most relevant passages to answer the user's question. "
                            "Always call this before answering any factual question about "
                            "the notebook when passages were not already provided in the turn."
                        ),
                        parameters=types.Schema(
                            type=types.Type.OBJECT,
                            properties={
                                "query": types.Schema(
                                    type=types.Type.STRING,
                                    description="Focused search query with key terms from the user's question.",
                                )
                            },
                            required=["query"],
                        ),
                    )
                ]
            )
        ]

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
                                if len(text) > MAX_TURN_TEXT_CHARS:
                                    text = text[:MAX_TURN_TEXT_CHARS]
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
                            tool_call = getattr(response, "tool_call", None)
                            if tool_call and getattr(tool_call, "function_calls", None):
                                fn_responses = []
                                for fc in tool_call.function_calls:
                                    if fc.name == "search_notebook" and notebook_id:
                                        args = fc.args or {}
                                        query = str(args.get("query") or "").strip()
                                        logger.info(
                                            f"Gemini Live tool call search_notebook(query={query!r}) "
                                            f"on {notebook_id}"
                                        )
                                        await websocket.send_json(
                                            {
                                                "type": "status",
                                                "status": "searching_sources",
                                                "query": query,
                                            }
                                        )
                                        passages = await _run_notebook_rag(
                                            query=query,
                                            notebook_id=notebook_id,
                                            allowed_parent_ids=allowed_parent_ids,
                                        )
                                        fn_responses.append(
                                            types.FunctionResponse(
                                                id=fc.id,
                                                name=fc.name,
                                                response={
                                                    "passages": passages
                                                    or "No matching passages found in the selected notebook sources."
                                                },
                                            )
                                        )
                                if fn_responses:
                                    await session.send_tool_response(
                                        function_responses=fn_responses
                                    )
                                    await websocket.send_json(
                                        {"type": "status", "status": "idle"}
                                    )
                                continue

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
