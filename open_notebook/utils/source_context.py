"""Generic, model-agnostic source context preparation and output validation.

Used by background transformations (Dense Summary, Table of Contents, etc.) and
Studio report/infographic generation so every model provider (Codex, Claude Code,
Anthropic, OpenAI, Gemini, Ollama) receives clean, high-signal source content
and never persists raw CLI/transport error logs as insights or notes.
"""

from __future__ import annotations

import json
import re
from typing import List, Optional, Tuple

from open_notebook.database.repository import ensure_record_id, repo_query
from open_notebook.domain.notebook import Source, vector_search
from open_notebook.utils.github_ingest import GITHUB_INDEXED_FILES_MARKER

_FILE_BLOCK_RE = re.compile(
    r"<!--\s*GITHUB_FILE_START:\s*(.+?)\s*-->\s*([\s\S]*?)<!--\s*GITHUB_FILE_END\s*-->"
)


def looks_like_provider_error_dump(text: str) -> Optional[str]:
    """Detect raw CLI/transport JSONL error dumps returned as assistant text.

    Returns a short diagnostic string if ``text`` appears to be a failed-turn
    transport log rather than real model output, otherwise ``None``.
    """
    stripped = (text or "").strip()
    if not stripped:
        return "Model returned empty output."

    lines = [line.strip() for line in stripped.splitlines() if line.strip()]
    if not lines:
        return "Model returned empty output."

    # Check JSONL event streams emitted by Codex CLI, Claude Code CLI, or Gemini CLI
    if lines[0].startswith("{") and lines[0].endswith("}"):
        parsed_events = []
        for line in lines[:20]:
            if not (line.startswith("{") and line.endswith("}")):
                continue
            try:
                ev = json.loads(line)
                if isinstance(ev, dict):
                    parsed_events.append(ev)
            except Exception:
                continue

        if parsed_events:
            for ev in parsed_events:
                ev_type = str(ev.get("type") or "").lower()
                if ev_type in ("turn.failed", "error"):
                    err = ev.get("error") or ev.get("message") or "Model turn failed"
                    return f"Provider CLI error event: {str(err)[:300]}"
                if ev.get("is_api_error_message") is True or ev.get("is_error") is True:
                    err = ev.get("result") or ev.get("error") or "Provider API error"
                    return f"Provider CLI error: {str(err)[:300]}"

    # Catch raw single-object OpenAI/Anthropic error payloads accidentally returned as text
    if (
        stripped.startswith("{")
        and stripped.endswith("}")
        and '"invalid_request_error"' in stripped
        and '"error"' in stripped
    ):
        return f"Raw provider error payload: {stripped[:300]}"

    return None


def _github_file_summary_priority(path: str) -> Tuple[int, int, str]:
    """Prioritize READMEs, skill/doc markdown, manifests, and top-level modules for summarization."""
    lower = path.lower()
    base = lower.rsplit("/", 1)[-1]
    depth = path.count("/")

    if base.startswith("readme"):
        return (0, depth, lower)
    if base in ("skill.md", "plugin.json", "marketplace.json", "package.json", "pyproject.toml"):
        return (1, depth, lower)
    if lower.endswith((".md", ".mdx")):
        return (2, depth, lower)
    if any(t in lower for t in ("/test/", "/tests/", "__tests__", ".test.", ".spec.")):
        return (5, depth, lower)
    return (3, depth, lower)


def prepare_source_for_summary(
    title: str,
    full_text: str,
    max_chars: int = 180_000,
) -> str:
    """Prepare a single source's text for summarization/transformation within ``max_chars``.

    - Short/medium sources (<= max_chars): returned verbatim.
    - GitHub repository sources: always preserves the complete Overview, Directory Tree,
      Main Files table, Architecture, and Tech Stack at the top, then packs prioritized
      files (READMEs, SKILL.md/docs, manifests, core code) below up to ``max_chars``.
    - Massive books/PDFs: keeps head (55%, TOC + opening), middle (25%), and tail (20%)
      so summaries reflect the full document rather than just the preface.
    """
    raw = (full_text or "").strip()
    if not raw:
        return ""

    if len(raw) <= max_chars:
        return f"### Source: {title}\n{raw}"

    gh_idx = raw.find(GITHUB_INDEXED_FILES_MARKER)
    if gh_idx != -1:
        summary_part = raw[:gh_idx].rstrip("-\n ")
        files_section = raw[gh_idx + len(GITHUB_INDEXED_FILES_MARKER) :]
        remaining = max_chars - len(summary_part) - 250

        if remaining <= 1000:
            return f"### Source: {title}\n{summary_part[:max_chars]}"

        matches = _FILE_BLOCK_RE.findall(files_section)
        if matches:
            ranked = sorted(matches, key=lambda pair: _github_file_summary_priority(pair[0]))
            packed_blocks: List[str] = []
            used = 0
            included_count = 0
            per_file_cap = max(2500, min(8000, remaining // 12))

            for path, body in ranked:
                clean_body = body.strip()
                if len(clean_body) > per_file_cap:
                    clean_body = (
                        clean_body[:per_file_cap].rstrip()
                        + f"\n... [truncated {len(clean_body) - per_file_cap:,} chars]"
                    )
                block = f"#### File: `{path}`\n{clean_body}\n"
                if used + len(block) > remaining and packed_blocks:
                    continue
                packed_blocks.append(block)
                used += len(block)
                included_count += 1
                if used >= remaining - 300:
                    break

            omitted = max(0, len(matches) - included_count)
            note = (
                f"\n[Showing {included_count} of {len(matches)} indexed repository files prioritized for summary; {omitted} lower-priority files omitted to fit budget.]\n"
                if omitted > 0
                else ""
            )
            return (
                f"### Source: {title}\n"
                f"{summary_part}\n\n"
                f"## Key Indexed Repository Files\n{note}\n"
                + "\n".join(packed_blocks)
            )

        # Fallback if marker present without individual file blocks
        return (
            f"### Source: {title}\n"
            f"{summary_part}\n\n"
            f"{files_section[:remaining].strip()}"
        )

    # Generic large document / textbook sampling: head (55%) + middle (25%) + tail (20%)
    head_size = int(max_chars * 0.55)
    mid_size = int(max_chars * 0.25)
    tail_size = max(4000, max_chars - head_size - mid_size - 200)
    mid_start = max(head_size, (len(raw) - mid_size) // 2)

    return (
        f"### Source: {title} ({len(raw):,} chars total — structured full-span excerpts)\n"
        f"{raw[:head_size]}\n\n"
        f"[...middle section excerpt...]\n\n"
        f"{raw[mid_start : mid_start + mid_size]}\n\n"
        f"[...closing section excerpt...]\n\n"
        f"{raw[-tail_size:]}"
    )


async def _retrieve_focused_passages(
    focus_query: str,
    allowed_source_ids: set[str],
    max_chars: int = 75_000,
) -> str:
    """Retrieve vector-matched passages strictly scoped to ``allowed_source_ids``."""
    query = (focus_query or "").strip()
    if not query or not allowed_source_ids:
        return ""
    try:
        from open_notebook.ai.models import model_manager

        if not await model_manager.get_embedding_model():
            return ""

        results = await vector_search(
            keyword=query[:600],
            results=30,
            source=True,
            note=False,
            minimum_score=0.2,
        )
        if not results:
            return ""

        blocks: List[str] = []
        used = 0
        for item in results:
            parent_id = str(item.get("parent_id") or "")
            item_id = str(item.get("id") or "")
            if parent_id not in allowed_source_ids and item_id not in allowed_source_ids:
                continue
            title = str(item.get("title") or parent_id or "Source")
            matches = item.get("matches")
            if isinstance(matches, list):
                text = "\n".join(str(m) for m in matches if m).strip()
            else:
                text = str(matches or "").strip()
            if not text:
                continue
            similarity = item.get("similarity")
            sim_tag = f" (relevance {float(similarity):.2f})" if isinstance(similarity, (int, float)) else ""
            block = f"### Focused Passage from {title}{sim_tag}\n{text}"
            if used + len(block) > max_chars and blocks:
                break
            blocks.append(block)
            used += len(block) + 2

        if not blocks:
            return ""
        return (
            "## Focused Source Passages Matching Custom Prompt\n"
            "(Prioritize these vector-retrieved passages when following the user's focus instructions.)\n\n"
            + "\n\n".join(blocks)
        )
    except Exception:
        return ""


async def build_notebook_studio_context(
    notebook_id: str,
    source_ids: Optional[List[str]] = None,
    max_total_chars: int = 220_000,
    focus_query: Optional[str] = None,
) -> Tuple[str, int]:
    """Load real ``full_text`` for selected notebook sources directly from SurrealDB.

    Always reads the actual source content (never corrupted/truncated insights-only
    summaries) and distributes ``max_total_chars`` cleanly across sources. When
    ``focus_query`` is supplied and any source is large (>35k chars), also prepends
    strictly scoped vector-matched passages for that focus topic.
    Returns ``(combined_context, source_count)``.
    """
    target_ids: List[str] = list(source_ids or [])

    if not target_ids:
        rows = await repo_query(
            "SELECT VALUE in FROM reference WHERE out = $notebook_id",
            {"notebook_id": ensure_record_id(notebook_id)},
        )
        target_ids = [str(r) for r in (rows or []) if r]

    if not target_ids:
        return "", 0

    loaded_sources: List[Source] = []
    for sid in target_ids:
        try:
            src = await Source.get(sid)
            if src and src.full_text and src.full_text.strip():
                loaded_sources.append(src)
        except Exception:
            continue

    if not loaded_sources:
        return "", 0

    focused_section = ""
    has_large_source = any(len(src.full_text or "") > 35_000 for src in loaded_sources)
    if focus_query and focus_query.strip() and has_large_source:
        allowed_ids = {str(src.id) for src in loaded_sources if src.id}
        focused_budget = min(75_000, int(max_total_chars * 0.4))
        focused_section = await _retrieve_focused_passages(
            focus_query=focus_query,
            allowed_source_ids=allowed_ids,
            max_chars=focused_budget,
        )

    remaining_budget = max(
        32_000,
        max_total_chars - (len(focused_section) + 120 if focused_section else 0),
    )
    per_source_budget = max(24_000, remaining_budget // len(loaded_sources))
    blocks = [
        prepare_source_for_summary(
            title=src.title or str(src.id or "Source"),
            full_text=src.full_text or "",
            max_chars=per_source_budget,
        )
        for src in loaded_sources
    ]
    base_combined = "\n\n---\n\n".join(b for b in blocks if b)
    combined = (
        f"{focused_section}\n\n---\n\n{base_combined}"
        if focused_section
        else base_combined
    )
    return combined[:max_total_chars], len(loaded_sources)
