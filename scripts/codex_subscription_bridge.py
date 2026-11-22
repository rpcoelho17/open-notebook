#!/usr/bin/env python3
"""
OpenAI-Compatible Local API Bridge for OpenAI Codex / ChatGPT Subscription
Allows tools like Open Notebook to use OpenAI models via your ChatGPT Plus/Pro subscription
without paying per-token API charges.
"""

import asyncio
import glob
import io
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer
from pathlib import Path

_WHISPER_MODEL = None
_WHISPER_LOCK = threading.Lock()
_KOKORO_MODEL = None
_KOKORO_LOCK = threading.Lock()

REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = REPO_ROOT / ".env"
KOKORO_DIR = REPO_ROOT / "models" / "kokoro"
KOKORO_MODEL_PATH = KOKORO_DIR / "kokoro-v1.0.onnx"
KOKORO_VOICES_PATH = KOKORO_DIR / "voices-v1.0.bin"
EXA_URL = "https://api.exa.ai"

def get_exa_api_key() -> str:
    key = os.environ.get("EXA_API_KEY", "").strip()
    if key:
        return key
    if ENV_PATH.is_file():
        try:
            for line in ENV_PATH.read_text(encoding="utf-8-sig").splitlines():
                stripped = line.strip()
                if not stripped or stripped.startswith("#") or "=" not in stripped:
                    continue
                k, v = stripped.split("=", 1)
                if k.strip() == "EXA_API_KEY":
                    return v.strip().strip('"').strip("'")
        except OSError:
            pass
    return ""

def get_whisper_model():
    global _WHISPER_MODEL
    if _WHISPER_MODEL is None:
        with _WHISPER_LOCK:
            if _WHISPER_MODEL is None:
                from faster_whisper import WhisperModel
                print("[Codex Bridge] Loading local faster-whisper (base.en, int8)...")
                _WHISPER_MODEL = WhisperModel("base.en", device="cpu", compute_type="int8")
                print("[Codex Bridge] faster-whisper ready!")
    return _WHISPER_MODEL

def get_kokoro_model():
    global _KOKORO_MODEL
    if _KOKORO_MODEL is None:
        with _KOKORO_LOCK:
            if _KOKORO_MODEL is None:
                if not KOKORO_MODEL_PATH.is_file() or not KOKORO_VOICES_PATH.is_file():
                    raise FileNotFoundError(
                        f"Kokoro model files missing in {KOKORO_DIR}. Expected {KOKORO_MODEL_PATH.name} and {KOKORO_VOICES_PATH.name}."
                    )
                from kokoro_onnx import Kokoro
                print("[Codex Bridge] Loading local Kokoro-82M ONNX TTS...")
                _KOKORO_MODEL = Kokoro(str(KOKORO_MODEL_PATH), str(KOKORO_VOICES_PATH))
                print("[Codex Bridge] Kokoro-82M TTS ready!")
    return _KOKORO_MODEL

DEFAULT_PORT = 8088
DEFAULT_MODEL = "gpt-6.2-sol"
DEFAULT_REASONING_EFFORT = os.environ.get("CODEX_REASONING_EFFORT", "none")
DEFAULT_MAX_CONTEXT_TOKENS = None  # None = model max (capped to Codex's 1M-char transport limit)
CODEX_HARD_MAX_CHARS = 980_000
GEMINI_MODELS = [
    "gemini-3.1-pro-preview",
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite",
    "gemini-2.5-pro",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
]
SUPPORTED_MODELS = [
    "gpt-6.2-sol",
    "gpt-6.1-terra",
    "gpt-6-luna",
    "gpt-6.2-astra",
    "gpt-6.1-sol",
    "gpt-6-sol",
] + GEMINI_MODELS

def find_gemini_binary() -> str | None:
    """Find installed gemini.cmd / gemini CLI."""
    for name in ("gemini.cmd", "gemini.exe", "gemini"):
        for p in os.environ.get("PATH", "").split(os.pathsep):
            candidate = Path(p) / name
            if candidate.is_file():
                return str(candidate)
    appdata = os.environ.get("APPDATA")
    if appdata:
        candidate = Path(appdata) / "npm" / "gemini.cmd"
        if candidate.is_file():
            return str(candidate)
    return None

GEMINI_BIN = find_gemini_binary()
if GEMINI_BIN:
    print(f"[Codex Bridge] Found Gemini CLI binary: {GEMINI_BIN}")

def stream_gemini_cli(model: str, prompt: str, timeout: float = 180.0):
    """Run @google/gemini-cli headless with stream-json and yield live text deltas."""
    if not GEMINI_BIN:
        raise RuntimeError("Gemini CLI not installed. Run: npm install -g @google/gemini-cli")
    cmd = [GEMINI_BIN, "-m", model, "-o", "stream-json", "--skip-trust", "-p", ""]
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        bufsize=1,
    )
    assert proc.stdin is not None and proc.stdout is not None
    try:
        proc.stdin.write(prompt)
        proc.stdin.close()
    except Exception:
        pass

    yielded_any = False
    for raw_line in proc.stdout:
        line = raw_line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except Exception:
            continue
        ev_type = ev.get("type")
        if ev_type == "message" and ev.get("role") == "assistant":
            content = ev.get("content") or ""
            if content:
                yielded_any = True
                yield content
        elif ev_type == "error":
            raise RuntimeError(ev.get("message") or str(ev))

    rc = proc.wait(timeout=timeout)
    if rc != 0 and not yielded_any:
        err_text = (proc.stderr.read() if proc.stderr else "").strip()
        raise RuntimeError(err_text or f"gemini CLI exited with code {rc} (run `gemini` once to sign in)")

def find_codex_binary() -> str:
    """Find the installed codex.exe on Windows or codex on Linux."""
    # Check PATH first
    path_dirs = os.environ.get("PATH", "").split(os.pathsep)
    for p in path_dirs:
        for name in ("codex.exe", "codex"):
            candidate = Path(p) / name
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return str(candidate)

    # Windows user AppData search
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        candidates = glob.glob(
            os.path.join(local_app_data, "OpenAI", "Codex", "bin", "*", "codex.exe")
        )
        if candidates:
            # Return the latest one by mtime
            candidates.sort(key=lambda x: os.path.getmtime(x), reverse=True)
            return candidates[0]

    raise RuntimeError("Could not find codex binary. Ensure OpenAI Codex is installed.")

CODEX_BIN = find_codex_binary()
print(f"[Codex Bridge] Using Codex binary: {CODEX_BIN}")

class CodexAppServer:
    """Persistent warm `codex app-server` client with true token-by-token streaming."""
    def __init__(self):
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._proc = None
        self._next_id = 1
        self._pending_rpc: dict[int, queue.Queue] = {}
        self._thread_queues: dict[str, queue.Queue] = {}
        self._item_phases: dict[str, str] = {}
        self._ready = False

    def _ensure_started(self):
        with self._lock:
            if self._proc is not None and self._proc.poll() is None and self._ready:
                return
            self._start_locked()

    def _start_locked(self):
        if self._proc is not None:
            try:
                self._proc.terminate()
            except Exception:
                pass
        self._proc = subprocess.Popen(
            [CODEX_BIN, "app-server", "-c", "mcp_servers={}"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self._ready = False
        self._pending_rpc.clear()
        self._thread_queues.clear()
        reader = threading.Thread(target=self._reader_loop, args=(self._proc,), daemon=True)
        reader.start()

        init_res = self._rpc_call("initialize", {
            "clientInfo": {"name": "open-notebook", "version": "1.0"}
        }, timeout=15)
        if "error" in init_res:
            raise RuntimeError(f"codex app-server init error: {init_res['error']}")
        self._send_raw({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self._ready = True
        print("[Codex Bridge] Warm codex app-server ready (true token streaming enabled)!")

    def _send_raw(self, payload: dict):
        with self._write_lock:
            if not self._proc or not self._proc.stdin:
                raise RuntimeError("codex app-server stdin unavailable")
            self._proc.stdin.write(json.dumps(payload) + "\n")
            self._proc.stdin.flush()

    def _reader_loop(self, proc):
        try:
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                if "id" in ev and ev["id"] in self._pending_rpc:
                    q = self._pending_rpc.pop(ev["id"], None)
                    if q is not None:
                        q.put(ev)
                    continue
                method = ev.get("method")
                params = ev.get("params") or {}
                tid = params.get("threadId")
                if tid and tid in self._thread_queues:
                    if method == "item/started":
                        item = params.get("item") or {}
                        item_id = item.get("id")
                        phase = item.get("phase") or ""
                        if item_id:
                            self._item_phases[item_id] = phase
                    elif method == "item/agentMessage/delta":
                        item_id = params.get("itemId") or ""
                        if self._item_phases.get(item_id) == "commentary":
                            continue
                        delta = params.get("delta", "")
                        if delta:
                            self._thread_queues[tid].put(("delta", delta))
                    elif method == "turn/completed":
                        self._thread_queues[tid].put(("done", None))
                    elif method == "error":
                        self._thread_queues[tid].put(("error", str(params)))
        except Exception as e:
            print(f"[Codex Bridge] app-server reader exited: {e}")
        finally:
            self._ready = False
            for q in list(self._pending_rpc.values()):
                q.put({"error": "app-server disconnected"})
            for q in list(self._thread_queues.values()):
                q.put(("error", "app-server disconnected"))

    def _rpc_call(self, method: str, params: dict, timeout: float = 20.0) -> dict:
        with self._write_lock:
            req_id = self._next_id
            self._next_id += 1
            q: queue.Queue = queue.Queue()
            self._pending_rpc[req_id] = q
            self._proc.stdin.write(json.dumps({
                "jsonrpc": "2.0",
                "id": req_id,
                "method": method,
                "params": params,
            }) + "\n")
            self._proc.stdin.flush()
        try:
            return q.get(timeout=timeout)
        except queue.Empty:
            self._pending_rpc.pop(req_id, None)
            raise TimeoutError(f"codex app-server RPC timeout on {method}")

    def stream_turn(self, model: str, effort: str, prompt: str, timeout: float = 180.0):
        """Yields live text deltas as they arrive from OpenAI."""
        self._ensure_started()
        res = self._rpc_call("thread/start", {
            "model": model,
            "approvalPolicy": "never",
            "sandbox": "read-only",
        }, timeout=20)
        if "error" in res:
            raise RuntimeError(str(res["error"]))
        thread_id = res["result"]["thread"]["id"]
        q: queue.Queue = queue.Queue()
        self._thread_queues[thread_id] = q
        try:
            turn_res = self._rpc_call("turn/start", {
                "threadId": thread_id,
                "effort": effort,
                "input": [{"type": "text", "text": prompt}],
            }, timeout=20)
            if "error" in turn_res:
                raise RuntimeError(str(turn_res["error"]))

            deadline = time.time() + timeout
            while True:
                remaining = max(0.1, deadline - time.time())
                try:
                    kind, payload = q.get(timeout=remaining)
                except queue.Empty:
                    raise TimeoutError("Codex streaming turn timed out")
                if kind == "delta":
                    yield payload
                elif kind == "done":
                    break
                elif kind == "error":
                    raise RuntimeError(payload or "Codex streaming error")
        finally:
            self._thread_queues.pop(thread_id, None)

APP_SERVER = CodexAppServer()

class CodexBridgeHandler(BaseHTTPRequestHandler):
    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With")

    def do_OPTIONS(self):
        self.send_response(200)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0].rstrip("/")
        if path in ("", "/health"):
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": "ok",
                "provider": "codex-subscription",
                "kokoro_ready": KOKORO_MODEL_PATH.is_file() and KOKORO_VOICES_PATH.is_file(),
                "edge_tts": True,
                "exa_configured": bool(get_exa_api_key()),
            }).encode())
            return

        if path in ("/v1/models", "/models"):
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()

            models_data = [
                {
                    "id": m,
                    "object": "model",
                    "created": 1700000000,
                    "owned_by": "openai-subscription"
                }
                for m in SUPPORTED_MODELS
            ]
            self.wfile.write(json.dumps({"object": "list", "data": models_data}).encode())
            return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        global DEFAULT_REASONING_EFFORT, DEFAULT_MAX_CONTEXT_TOKENS
        path = self.path.split("?")[0].rstrip("/")
        if path in ("/v1/audio/transcriptions", "/audio/transcriptions"):
            self._handle_transcription()
            return
        if path in ("/v1/audio/speech", "/audio/speech"):
            self._handle_speech()
            return
        if path in ("/v1/search", "/search"):
            self._handle_exa_search()
            return
        if path in ("/v1/config", "/config"):
            content_length = int(self.headers.get("Content-Length", 0))
            try:
                cfg = json.loads(self.rfile.read(content_length).decode("utf-8")) if content_length > 0 else {}
                eff = str(cfg.get("reasoning_effort") or "").strip().lower()
                if eff in ("none", "low", "medium", "high"):
                    DEFAULT_REASONING_EFFORT = eff
                    print(f"[Codex Bridge] Default reasoning_effort updated to: {DEFAULT_REASONING_EFFORT}")
                if "max_context_tokens" in cfg:
                    raw_tok = cfg.get("max_context_tokens")
                    if raw_tok is None:
                        DEFAULT_MAX_CONTEXT_TOKENS = None
                    else:
                        tok_int = int(raw_tok)
                        if tok_int >= 8000:
                            DEFAULT_MAX_CONTEXT_TOKENS = tok_int
                    print(f"[Codex Bridge] Default max_context_tokens updated to: {DEFAULT_MAX_CONTEXT_TOKENS}")
                body = json.dumps({
                    "status": "ok",
                    "reasoning_effort": DEFAULT_REASONING_EFFORT,
                    "max_context_tokens": DEFAULT_MAX_CONTEXT_TOKENS,
                }).encode()
                self.send_response(200)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:
                self.send_response(400)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
            return

        if path not in ("/v1/chat/completions", "/chat/completions"):
            self.send_response(404)
            self.end_headers()
            return

        content_length = int(self.headers.get("Content-Length", 0))
        post_data = self.rfile.read(content_length)

        try:
            req = json.loads(post_data.decode("utf-8"))
        except Exception as e:
            self.send_response(400)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": f"Invalid JSON: {str(e)}"}).encode())
            return

        model = req.get("model") or DEFAULT_MODEL
        if model not in SUPPORTED_MODELS:
            model = DEFAULT_MODEL

        messages = req.get("messages", [])
        is_stream = req.get("stream", False)

        # Build prompt from conversation messages
        prompt_parts = []
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if isinstance(content, list):
                # Handle multimodal content blocks
                text_parts = [part.get("text", "") for part in content if part.get("type") == "text"]
                content = "\n".join(text_parts)

            if role == "system":
                prompt_parts.append(f"[System Instruction]\n{content}")
            elif role == "user":
                prompt_parts.append(f"[User]\n{content}")
            elif role == "assistant":
                prompt_parts.append(f"[Assistant]\n{content}")

        prompt_parts.append("[Assistant]")
        final_prompt = "\n\n".join(prompt_parts)
        # Respect configured context window slider (and Codex's hard 1M-char transport cap)
        # while always preserving the user's latest question at the tail of the prompt.
        req_max_tokens = req.get("max_context_tokens") or DEFAULT_MAX_CONTEXT_TOKENS
        budget_chars = CODEX_HARD_MAX_CHARS
        if isinstance(req_max_tokens, (int, float)) and req_max_tokens >= 8000:
            budget_chars = min(int(req_max_tokens * 4), CODEX_HARD_MAX_CHARS)
        if len(final_prompt) > budget_chars:
            tail_keep = min(16000, budget_chars // 4)
            head_keep = max(4000, budget_chars - tail_keep - 120)
            final_prompt = (
                final_prompt[:head_keep]
                + "\n\n[...middle source text trimmed to fit configured context window...]\n\n"
                + final_prompt[-tail_keep:]
            )

        # Route Gemini models to @google/gemini-cli (OAuth subscription), GPT models to Codex app-server
        effort = req.get("reasoning_effort") or DEFAULT_REASONING_EFFORT
        resp_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
        created_time = int(time.time())
        is_gemini = model in GEMINI_MODELS or model.startswith("gemini-")

        if is_stream:
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()

            chunk_role = {
                "id": resp_id,
                "object": "chat.completion.chunk",
                "created": created_time,
                "model": model,
                "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]
            }
            self.wfile.write(f"data: {json.dumps(chunk_role)}\n\n".encode())
            self.wfile.flush()

            try:
                stream_iter = (
                    stream_gemini_cli(model, final_prompt)
                    if is_gemini
                    else APP_SERVER.stream_turn(model, effort, final_prompt)
                )
                for delta in stream_iter:
                    chunk_content = {
                        "id": resp_id,
                        "object": "chat.completion.chunk",
                        "created": created_time,
                        "model": model,
                        "choices": [{"index": 0, "delta": {"content": delta}, "finish_reason": None}]
                    }
                    self.wfile.write(f"data: {json.dumps(chunk_content)}\n\n".encode())
                    self.wfile.flush()
            except BrokenPipeError:
                return
            except Exception as e:
                print(f"[Codex Bridge] Streaming error ({model}): {e}")

            try:
                chunk_end = {
                    "id": resp_id,
                    "object": "chat.completion.chunk",
                    "created": created_time,
                    "model": model,
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]
                }
                self.wfile.write(f"data: {json.dumps(chunk_end)}\n\n".encode())
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except BrokenPipeError:
                pass
            return

        # Non-streaming: route Gemini CLI or warm Codex app-server
        assistant_text = ""
        input_tokens = 0
        output_tokens = 0
        if is_gemini:
            try:
                assistant_text = "".join(stream_gemini_cli(model, final_prompt)).strip()
            except Exception as e:
                body = json.dumps({"error": str(e)}).encode()
                self.send_response(500)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
        else:
            try:
                chunks = []
                for delta in APP_SERVER.stream_turn(model, effort, final_prompt):
                    chunks.append(delta)
                assistant_text = "".join(chunks).strip()
            except Exception as app_err:
                print(f"[Codex Bridge] app-server fallback to exec: {app_err}")
                cmd = [
                    CODEX_BIN,
                    "exec",
                    "--skip-git-repo-check",
                    "--ephemeral",
                    "--model",
                    model,
                    "-c",
                    f'model_reasoning_effort="{effort}"',
                    "--json",
                    "-"
                ]
                try:
                    proc = subprocess.Popen(
                        cmd,
                        stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True,
                        encoding="utf-8"
                    )
                    stdout_data, _ = proc.communicate(input=final_prompt, timeout=180)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    self.send_response(504)
                    self._send_cors_headers()
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "Codex execution timed out"}).encode())
                    return
                except Exception as e:
                    self.send_response(500)
                    self._send_cors_headers()
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": f"Failed to execute codex: {str(e)}"}).encode())
                    return

                for line in stdout_data.splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                        ev_type = event.get("type")
                        if ev_type == "item.completed":
                            item = event.get("item", {})
                            if item.get("type") == "agent_message":
                                assistant_text += item.get("text", "")
                        elif ev_type == "turn.completed":
                            usage = event.get("usage", {})
                            input_tokens += usage.get("input_tokens", 0)
                            output_tokens += usage.get("output_tokens", 0)
                    except Exception:
                        continue
                if not assistant_text and stdout_data:
                    assistant_text = stdout_data.strip()

        # Standard JSON format
        resp = {
            "id": resp_id,
            "object": "chat.completion",
            "created": created_time,
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": assistant_text
                    },
                    "finish_reason": "stop"
                }
            ],
            "usage": {
                "prompt_tokens": input_tokens,
                "completion_tokens": output_tokens,
                "total_tokens": input_tokens + output_tokens
            }
        }
        body = json.dumps(resp).encode()
        self.send_response(200)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_transcription(self):
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length <= 0:
            self.send_response(400)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Empty audio payload"}).encode())
            return

        raw_body = self.rfile.read(content_length)
        content_type = (self.headers.get("Content-Type") or "").lower()
        suffix = ".webm"
        if "wav" in content_type:
            suffix = ".wav"
        elif "mp4" in content_type or "m4a" in content_type:
            suffix = ".m4a"
        elif "ogg" in content_type:
            suffix = ".ogg"

        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                tmp.write(raw_body)
                tmp_path = tmp.name

            model = get_whisper_model()
            segments, _ = model.transcribe(tmp_path, language="en", vad_filter=True)
            text = " ".join(seg.text.strip() for seg in segments).strip()

            body = json.dumps({"text": text}).encode()
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            print(f"[Codex Bridge] Transcription error: {e}")
            body = json.dumps({"error": str(e)}).encode()
            self.send_response(500)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        finally:
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass

    def _handle_speech(self):
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length <= 0:
            self.send_response(400)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Empty TTS payload"}).encode())
            return

        try:
            req = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except Exception as e:
            self.send_response(400)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": f"Invalid JSON: {e}"}).encode())
            return

        text = (req.get("input") or req.get("text") or "").strip()
        if not text:
            self.send_response(400)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Missing input text"}).encode())
            return

        provider = (req.get("provider") or req.get("model") or "kokoro").lower()
        speed = float(req.get("speed") or 1.0)

        try:
            if "edge" in provider:
                import edge_tts
                voice = req.get("voice") or "en-US-AvaMultilingualNeural"

                async def _gen_edge() -> bytes:
                    comm = edge_tts.Communicate(text, voice=voice)
                    chunks = []
                    async for chunk in comm.stream():
                        if chunk.get("type") == "audio":
                            chunks.append(chunk["data"])
                    return b"".join(chunks)

                audio_bytes = asyncio.run(_gen_edge())
                content_type = "audio/mpeg"
            else:
                import soundfile as sf
                voice = req.get("voice") or "af_heart"
                lang = "en-gb" if voice.startswith("b") else "en-us"
                kokoro = get_kokoro_model()
                samples, sample_rate = kokoro.create(text, voice=voice, speed=speed, lang=lang)
                buf = io.BytesIO()
                sf.write(buf, samples, sample_rate, format="WAV")
                audio_bytes = buf.getvalue()
                content_type = "audio/wav"

            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(audio_bytes)))
            self.end_headers()
            self.wfile.write(audio_bytes)
        except Exception as e:
            print(f"[Codex Bridge] TTS error ({provider}): {e}")
            body = json.dumps({"error": str(e)}).encode()
            self.send_response(500)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def _handle_exa_search(self):
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length <= 0:
            self.send_response(400)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Empty search payload"}).encode())
            return

        try:
            req = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except Exception as e:
            self.send_response(400)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": f"Invalid JSON: {e}"}).encode())
            return

        query = (req.get("query") or "").strip()
        if not query:
            self.send_response(400)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Missing query"}).encode())
            return

        api_key = get_exa_api_key()
        if not api_key:
            self.send_response(500)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "EXA_API_KEY not configured in .env"}).encode())
            return

        num_results = min(max(int(req.get("num_results") or 5), 1), 10)
        max_chars = min(max(int(req.get("max_characters") or 4500), 500), 15000)
        exa_payload = {
            "query": query,
            "type": "auto",
            "numResults": num_results,
            "contents": {
                "text": {"maxCharacters": max_chars},
                "highlights": {"maxCharacters": 1200},
            },
        }

        try:
            exa_req = urllib.request.Request(
                f"{EXA_URL}/search",
                data=json.dumps(exa_payload).encode("utf-8"),
                headers={
                    "x-api-key": api_key,
                    "content-type": "application/json",
                    "accept": "application/json",
                    "user-agent": "OpenNotebook-ExaBridge/1.0",
                },
                method="POST",
            )
            with urllib.request.urlopen(exa_req, timeout=30) as resp:
                raw_data = json.loads(resp.read().decode("utf-8"))

            results = []
            for r in raw_data.get("results") or []:
                if not isinstance(r, dict) or not r.get("url"):
                    continue
                results.append({
                    "title": r.get("title") or r.get("url"),
                    "url": r.get("url"),
                    "published": r.get("publishedDate"),
                    "author": r.get("author"),
                    "text": (r.get("text") or "")[:max_chars],
                    "highlights": r.get("highlights") or [],
                })

            body = json.dumps({
                "query": query,
                "results": results,
                "cost_usd": (raw_data.get("costDollars") or {}).get("total"),
            }).encode("utf-8")
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except urllib.error.HTTPError as e:
            err_detail = e.read().decode("utf-8", errors="ignore")
            print(f"[Codex Bridge] Exa HTTP error {e.code}: {err_detail}")
            body = json.dumps({"error": f"Exa API returned HTTP {e.code}", "detail": err_detail}).encode()
            self.send_response(502)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            print(f"[Codex Bridge] Exa search error: {e}")
            body = json.dumps({"error": str(e)}).encode()
            self.send_response(500)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

def run_server(port=DEFAULT_PORT):
    server_address = ("127.0.0.1", port)
    httpd = ThreadingHTTPServer(server_address, CodexBridgeHandler)
    print(f"[Codex Bridge] Running at http://127.0.0.1:{port}/v1")
    print(f"[Codex Bridge] Ready for Open Notebook connections (Chat + Local Whisper STT + Local Kokoro & Edge TTS)!")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[Codex Bridge] Stopping...")
        httpd.server_close()

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    run_server(port)
