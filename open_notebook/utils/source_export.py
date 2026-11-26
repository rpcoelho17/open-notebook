"""
RAG-optimized exporter for combining all sources of a notebook into a single
Markdown (.md) or Plain Text (.txt) knowledge-base document.

Supports an optional two-stage "Export and clean" pipeline:
  1. Deterministic boilerplate & web-chrome removal (empty bullets, social icon
     links, repeated site navigation menus, copyright/legal footers, scraper headers).
  2. LLM-assisted cleaning & lean RAG formatting using the configured default
     language model (with graceful fallback to Stage 1 on timeout/error).
"""

from __future__ import annotations

import asyncio
import os
import re
from collections import Counter
from datetime import datetime, timezone
from typing import Dict, List, Literal, Optional, Set, Tuple

from loguru import logger

from open_notebook.domain.notebook import Source

ExportFormat = Literal["md", "txt"]

SOURCE_SEPARATOR = "=" * 80

# Internal UI markers inserted by GitHub repo ingestion
_INTERNAL_MARKERS = (
    "<!-- GITHUB_INDEXED_FILES_START -->",
    "<!-- GITHUB_INDEXED_FILES_END -->",
)

# Standalone "Term: Definition" line (excludes URLs like https:// and code-like syntax)
_DEF_LINE_RE = re.compile(
    r"^(?P<bullet>[-*]\s+)?(?P<term>[A-Za-z0-9][A-Za-z0-9 /&()'._-]{1,46}):\s+(?P<desc>\S.+)$"
)

# Standalone quoted paragraph ("..." or “...”)
_QUOTED_LINE_RE = re.compile(r'^(["“])(.{12,})(["”])$')

# Unicode bullet characters
_UNICODE_BULLET_RE = re.compile(r"^(\s*)[•▪◦‣●○■□]\s+")

# Pure navigation/icon link line (bulleted or standalone): "* [Label](https://...)" or "[Label](https://...)"
_PURE_LINK_BULLET_RE = re.compile(
    r"^\s*(?:[-*•]\s+)*\[[^\]]*\]\([^)]+\)(?:\s*Use\s+[←→↑↓/]+\s+to\s+navigate)?\s*$",
    re.IGNORECASE,
)

# Empty bullet or bullet containing only an empty markdown link: "*   [](https://...)" or "- "
_EMPTY_BULLET_RE = re.compile(r"^\s*[-*•]\s*(?:\[\s*\]\([^)]*\)\s*)*$")

# Linked or standalone generic scraped logo/image line: "[![Image 1](...)](...)" or "![Image 1](...)"
_GENERIC_IMAGE_LINE_RE = re.compile(
    r"^\s*(?:\[\s*!\[[^\]]*\]\([^)]+\)\s*\]\([^)]+\)|!\[(?:image\s*\d*|logo|icon)?\]\([^)]+\))\s*$",
    re.IGNORECASE,
)

# Jina / web scraper envelope lines at the start of scraped markdown
_SCRAPER_HEADER_RE = re.compile(
    r"^(?:Title|URL Source|Published Time|Markdown Content)\s*:\s*.*$",
    re.IGNORECASE,
)

# Copyright / all-rights-reserved lines
_COPYRIGHT_LINE_RE = re.compile(
    r"^(?:©|\(c\)|copyright\b).*(?:all\s+rights?\s+reserved|\b(?:19|20)\d{2}\b).*$",
    re.IGNORECASE,
)

# Unmistakable web UI / footer boilerplate lines
_BOILERPLATE_LINE_PATTERNS = (
    re.compile(r"^use\s+[←→↑↓/]+\s+to\s+navigate$", re.IGNORECASE),
    re.compile(r"^\d+\s+categories\s+loaded$", re.IGNORECASE),
    re.compile(r"^\[?\s*skip\s+to\s+(?:main\s+)?content\s*\]?(?:\([^)]*\))?$", re.IGNORECASE),
    re.compile(r"^\[?\s*jump\s+to\s+(?:main\s+)?content\s*\]?(?:\([^)]*\))?$", re.IGNORECASE),
    re.compile(r"^press\s+ctrl\+k\s+to\s+open\s+search$", re.IGNORECASE),
    re.compile(r"^ctrl\+k$", re.IGNORECASE),
    re.compile(r"^auto\s*\(system\s+theme\)\s+light\s+dark$", re.IGNORECASE),
    re.compile(r"^was\s+this\s+(?:article|page|doc|document)\s+helpful\??$", re.IGNORECASE),
    re.compile(r"^back\s+to\s+top$", re.IGNORECASE),
    re.compile(r"^follow\s+us(?:\s+on)?\s*:?$", re.IGNORECASE),
    re.compile(r"^\s*[-*•]\s+\[(?:legal\s+disclaimer|privacy\s+policy|terms\s+of\s+(?:service|use)|cookie\s+policy|we\s+are\s+hiring|careers|contact\s+us)\]\([^)]+\)\s*$", re.IGNORECASE),
    re.compile(r"^(?:legal\s+disclaimer|privacy\s+policy|terms\s+of\s+(?:service|use)|cookie\s+policy|cookie\s+settings|accept\s+all\s+cookies)$", re.IGNORECASE),
    re.compile(r"^>\s*##\s*Documentation\s+Index\s*$", re.IGNORECASE),
    re.compile(r"^>\s*Fetch\s+the\s+complete\s+documentation\s+index\s+at\s*:", re.IGNORECASE),
    re.compile(r"^>\s*Use\s+this\s+file\s+to\s+discover\s+all\s+available\s+pages\s+before\s+exploring\s+further\.?$", re.IGNORECASE),
)

# Short footer/sidebar category headings that become orphaned once their link lists are removed
_ORPHAN_FOOTER_HEADINGS = {
    "learn",
    "company",
    "follow us",
    "follow us on",
    "legal",
    "connect",
    "social",
    "search",
    "resources",
    "support",
    "community",
    "navigation",
    "on this page",
    "table of contents",
}

# Max per-source character length eligible for LLM cleaning (larger sources use Stage 1 only)
LLM_CLEAN_MAX_SOURCE_CHARS = 24_000
LLM_CLEAN_CONCURRENCY = 4
LLM_CLEAN_TIMEOUT_SEC = 75.0


def sanitize_export_filename(notebook_name: str, fmt: ExportFormat = "md") -> str:
    """Turn a notebook name into a filesystem-safe filename with the requested extension."""
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', " ", (notebook_name or "").strip())
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")
    if not cleaned:
        cleaned = "notebook-sources"
    ext = "txt" if fmt == "txt" else "md"
    return f"{cleaned}.{ext}"


def resolve_source_origin(source: Source) -> Tuple[str, str, str]:
    """Return (origin_label, origin_value, source_type) for a source."""
    url = (source.asset.url if source.asset and source.asset.url else "").strip()
    file_path = (
        source.asset.file_path if source.asset and source.asset.file_path else ""
    ).strip()

    if url:
        low = url.lower()
        if "github.com/" in low:
            kind = "GitHub Repository"
        elif "youtube.com/" in low or "youtu.be/" in low:
            kind = "YouTube Video"
        else:
            kind = "Web Page"
        return ("Origin URL", url, kind)

    if file_path:
        filename = os.path.basename(file_path.rstrip("/\\")) or file_path
        ext = os.path.splitext(filename)[1].lstrip(".").upper()
        kind = f"{ext} Document" if ext else "Uploaded File"
        return ("Origin File", filename, kind)

    return ("Origin", "Inline Text / Manual Entry", "Text")


def _clean_raw_text(raw: str) -> str:
    """Normalize line endings, strip internal UI comments, and collapse excess blank lines."""
    text = (raw or "").replace("\r\n", "\n").replace("\r", "\n")
    for marker in _INTERNAL_MARKERS:
        text = text.replace(marker, "")
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _detect_repeated_nav_links(sources: List[Source]) -> Set[str]:
    """
    Identify pure navigation/footer link bullets (`* [Label](url)`) that repeat
    verbatim across multiple sources in the same notebook (e.g., site header/footer
    or sidebar menus scraped from documentation sites).
    """
    if len(sources) < 3:
        return set()

    threshold = max(3, min(5, len(sources) // 3))
    counts: Counter[str] = Counter()
    for src in sources:
        seen_in_doc: Set[str] = set()
        for raw_line in (src.full_text or "").splitlines():
            s = raw_line.strip()
            if s and _PURE_LINK_BULLET_RE.match(s):
                seen_in_doc.add(s)
        for line in seen_in_doc:
            counts[line] += 1

    return {line for line, cnt in counts.items() if cnt >= threshold}


def _strip_web_boilerplate(
    raw_text: str, repeated_nav_links: Optional[Set[str]] = None
) -> str:
    """
    Stage 1 deterministic cleaner: removes empty bullets, social icon links,
    repeated site nav/footer links, scraper envelope headers, cookie/feedback
    prompts, and copyright lines while preserving code blocks and real content.
    """
    cleaned = _clean_raw_text(raw_text)
    if not cleaned:
        return ""

    repeated_nav = repeated_nav_links or set()
    lines = cleaned.split("\n")
    kept: List[str] = []
    in_code_fence = False

    for idx, line in enumerate(lines):
        stripped = line.strip()

        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_code_fence = not in_code_fence
            kept.append(line)
            continue
        if in_code_fence:
            kept.append(line)
            continue

        # Strip scraper metadata lines near the top of the document
        if idx < 12 and _SCRAPER_HEADER_RE.match(stripped):
            continue

        # Drop empty blockquote lines left behind after removing Doc Index notice
        if stripped == ">":
            continue

        # Strip empty bullets and icon-only link bullets ("* [](https://...)")
        if stripped and _EMPTY_BULLET_RE.match(stripped):
            continue

        # Strip generic scraped logo / icon images
        if stripped and _GENERIC_IMAGE_LINE_RE.match(stripped):
            continue

        # Strip copyright / all-rights-reserved lines
        if stripped and _COPYRIGHT_LINE_RE.match(stripped):
            continue

        # Strip known web UI / footer boilerplate patterns
        if stripped and any(p.match(stripped) for p in _BOILERPLATE_LINE_PATTERNS):
            continue

        # Strip navigation/footer link bullets repeated across multiple sources
        if stripped and stripped in repeated_nav:
            continue

        kept.append(line)

    # Second pass: prune orphaned footer/sidebar section labels (e.g. "Learn",
    # "Company", "Follow us on") that now have no real content under them.
    pruned: List[str] = []
    n = len(kept)
    for i, line in enumerate(kept):
        stripped = line.strip()
        low = stripped.lstrip("#").strip().rstrip(":").lower()
        if low in _ORPHAN_FOOTER_HEADINGS:
            # Look ahead to next non-empty line
            j = i + 1
            while j < n and not kept[j].strip():
                j += 1
            if j >= n:
                continue
            next_low = kept[j].strip().lstrip("#").strip().rstrip(":").lower()
            if next_low in _ORPHAN_FOOTER_HEADINGS:
                continue
        pruned.append(line)

    result = "\n".join(pruned)
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result.strip()


def _enhance_markdown_for_rag(raw_text: str) -> str:
    """
    Format source text into clean, LLM/RAG-friendly Markdown:
    - Preserves fenced code blocks and Markdown tables untouched.
    - Demotes `#` / `##` inside source content to `###` / `####` so top-level `#`
      and `## Source N:` boundaries remain unambiguous for RAG header splitters.
    - Normalizes unicode bullets into `- ` Markdown lists.
    - Emphasizes standalone `Term: definition` entries and standalone quotes (`> *...*`).
    """
    cleaned = _clean_raw_text(raw_text)
    if not cleaned:
        return "*(No extracted text available for this source.)*"

    lines = cleaned.split("\n")
    out: List[str] = []
    in_code_fence = False

    for line in lines:
        stripped = line.strip()

        # Toggle fenced code blocks — never alter code contents
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_code_fence = not in_code_fence
            out.append(line)
            continue
        if in_code_fence:
            out.append(line)
            continue

        # Preserve Markdown tables verbatim
        if stripped.startswith("|") and stripped.endswith("|"):
            out.append(line)
            continue

        # Normalize heading hierarchy inside each source (shift # -> ###, ## -> ####)
        heading_match = re.match(r"^(#{1,6})\s+(.+)$", stripped)
        if heading_match:
            level = len(heading_match.group(1))
            heading_text = heading_match.group(2).strip()
            new_level = min(6, level + 2) if level <= 2 else level
            out.append(f"{'#' * new_level} {heading_text}")
            continue

        # Normalize unicode bullets to standard Markdown bullets
        line = _UNICODE_BULLET_RE.sub(r"\1- ", line)
        stripped = line.strip()

        # Preserve existing blockquotes cleanly
        if stripped.startswith(">"):
            out.append(line)
            continue

        # Convert standalone quoted lines into italicized blockquotes
        quote_match = _QUOTED_LINE_RE.match(stripped)
        if quote_match:
            inner = quote_match.group(2).strip()
            out.append(f'> *"{inner}"*')
            continue

        # Highlight clean "Term: Definition" lines (skip URLs, JSON-like lines, already bolded)
        if (
            not stripped.startswith("**")
            and "://" not in stripped
            and not stripped.startswith("{")
            and not stripped.startswith('"')
        ):
            def_match = _DEF_LINE_RE.match(stripped)
            if def_match:
                term = def_match.group("term").strip()
                desc = def_match.group("desc").strip()
                if len(term.split()) <= 5 and not term.endswith((".", "?", "!")):
                    indent = line[: len(line) - len(line.lstrip())]
                    prefix = def_match.group("bullet") or "- "
                    out.append(f"{indent}{prefix}**{term}:** {desc}")
                    continue

        out.append(line)

    result = "\n".join(out)
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result.strip()


def _markdown_to_clean_plaintext(raw_text: str) -> str:
    """Convert Markdown-ish source content into clean, readable plain text for .txt RAG export."""
    cleaned = _clean_raw_text(raw_text)
    if not cleaned:
        return "(No extracted text available for this source.)"

    lines = cleaned.split("\n")
    out: List[str] = []
    in_code_fence = False

    for line in lines:
        stripped = line.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_code_fence = not in_code_fence
            out.append("---")
            continue
        if in_code_fence:
            out.append(line)
            continue

        heading_match = re.match(r"^#{1,6}\s+(.+)$", stripped)
        if heading_match:
            heading_text = heading_match.group(1).strip()
            out.append(heading_text.upper() if len(heading_text) <= 80 else heading_text)
            continue

        text_line = _UNICODE_BULLET_RE.sub(r"\1- ", line)
        text_line = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1 (\2)", text_line)
        text_line = re.sub(r"</?u>", "", text_line, flags=re.IGNORECASE)
        text_line = re.sub(r"\*\*([^*]+)\*\*", r"\1", text_line)
        text_line = re.sub(r"__([^_]+)__", r"\1", text_line)
        text_line = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"\1", text_line)
        text_line = re.sub(r"`([^`]+)`", r"\1", text_line)
        out.append(text_line)

    result = "\n".join(out)
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result.strip()


async def _llm_clean_source_text(
    model,
    title: str,
    text: str,
    fmt: ExportFormat,
) -> Optional[str]:
    """
    Ask the configured LLM to strip any remaining non-relevant web/document junk
    and produce a lean, high-signal, RAG-optimized version of a single source.
    """
    from langchain_core.messages import HumanMessage, SystemMessage
    from open_notebook.utils import clean_thinking_content
    from open_notebook.utils.text_utils import extract_text_content

    if fmt == "txt":
        format_rules = (
            "- Output clean, lean PLAIN TEXT (no Markdown syntax like **, ##, or HTML tags).\n"
            "- Use clear UPPERCASE subheadings, concise '-' bullets, and preserve code/JSON blocks cleanly."
        )
    else:
        format_rules = (
            "- Output clean, lean RAG-optimized MARKDOWN.\n"
            "- Use `###` and `####` subheadings (NEVER `#` or `##`, which are reserved for top-level source boundaries).\n"
            "- Use **bold** for key terms/parameters/labels, `<u>...</u>` sparingly for key definitions or section titles, *italics* for notes/quotes, `> *...*` for notable quotes, and `- ` bullets for lists.\n"
            "- Keep all code blocks, API endpoints, JSON payloads, tables, parameters, status codes, and technical rules intact."
        )

    system_prompt = (
        "You are an expert RAG Knowledge-Base Curator. Your job is to clean and format "
        "a single scraped source document so an LLM can ingest it with zero wasted tokens.\n\n"
        "STRICT RULES:\n"
        "1. REMOVE all non-relevant boilerplate and junk: navigation menus, sidebar links, "
        "breadcrumbs, empty bullets, social media links, cookie/login/feedback prompts, "
        "copyright notices, legal/privacy footer links, decorative image placeholders, and filler.\n"
        "2. PRESERVE 100% of substantive technical facts, API paths, HTTP methods, headers, "
        "parameters, schemas, code/JSON examples, procedures, definitions, quotes, and numbers. "
        "NEVER invent facts and NEVER summarize away concrete technical details.\n"
        "3. Do NOT repeat the top-level document title or origin URL (those are already in the section header).\n"
        "4. Return ONLY the cleaned body text — no preamble, no commentary, no closing remarks.\n"
        f"{format_rules}"
    )

    user_prompt = f"Source Title: {title}\n\nRAW SOURCE TEXT:\n{text}"

    try:
        response = await asyncio.wait_for(
            model.ainvoke(
                [SystemMessage(content=system_prompt), HumanMessage(content=user_prompt)]
            ),
            timeout=LLM_CLEAN_TIMEOUT_SEC,
        )
        raw_out = extract_text_content(getattr(response, "content", response))
        cleaned_out = clean_thinking_content(raw_out).strip()
        if cleaned_out:
            return cleaned_out
    except Exception as exc:
        logger.warning(f"LLM clean skipped for source '{title}': {exc}")
    return None


# Fast/cheap model preference scoring by provider family (higher score = faster/cheaper)
_FAST_MODEL_PATTERNS: Tuple[Tuple[str, int], ...] = (
    # OpenAI / Codex fast tier (Luna, Nano, Mini, Spark)
    ("luna", 100),
    ("nano", 98),
    ("4o-mini", 95),
    ("mini", 92),
    ("spark", 90),
    # Anthropic / Claude fast tier (Haiku, Fable)
    ("haiku", 100),
    ("fable", 95),
    # Google Gemini fast tier (Flash-Lite, Flash)
    ("flash-lite", 100),
    ("flash", 92),
    # Mistral / Meta / Local small fast models
    ("ministral", 90),
    ("tiny", 88),
    ("lite", 85),
    ("small", 82),
    ("fast", 80),
    ("3b", 78),
    ("7b", 76),
    ("8b", 75),
)

# Heavy flagship models penalized when searching for a fast/cheap cleaning model
_HEAVY_MODEL_PATTERNS: Tuple[str, ...] = (
    "opus",
    "sol",
    "pro",
    "hydrogen",
    "o1",
    "o3",
    "ultra",
    "max",
    "large",
    "70b",
    "405b",
)


def _score_fast_cheap_model(model_name: str) -> int:
    """Rank a language model name by how fast/cheap it is for boilerplate cleaning."""
    name = (model_name or "").strip().lower()
    score = 50
    for token, pts in _FAST_MODEL_PATTERNS:
        if token in name:
            score = max(score, pts)
    for heavy in _HEAVY_MODEL_PATTERNS:
        if heavy in name:
            score -= 25
    return score


def _detect_model_family(provider: str, model_name: str) -> str:
    """Classify a configured model into a provider family ('openai', 'claude', 'google', or raw provider)."""
    p = (provider or "").strip().lower()
    n = (model_name or "").strip().lower()
    if "anthropic" in p or "claude" in n or n in ("sonnet", "opus", "haiku", "fable"):
        return "claude"
    if "google" in p or "gemini" in n:
        return "google"
    if "openai" in p or n.startswith("gpt-") or n.startswith("o1") or n.startswith("o3"):
        return "openai"
    return p or "other"


async def resolve_export_clean_model(
    explicit_model_id: Optional[str] = None,
    effort: str = "low",
) -> Tuple[Optional[object], str]:
    """
    Resolve and provision the LangChain chat model for AI 'Export and clean',
    configured for the requested reasoning effort (default: 'low').

    Selection order:
      1. Explicit `export_clean_model` from ContentSettings (or request override).
      2. Auto-selected cheapest/fastest configured language model matching the
         active chat model's provider family (e.g., gpt-6-luna for OpenAI,
         claude-haiku for Anthropic/Claude, gemini-flash for Google).
      3. Fallback to default chat model.

    Returns (langchain_model, human_readable_label).
    """
    from open_notebook.ai.models import DefaultModels, Model, model_manager
    from open_notebook.domain.content_settings import ContentSettings

    settings: ContentSettings = await ContentSettings.get_instance()  # type: ignore[assignment]
    target_model_id = explicit_model_id or settings.export_clean_model
    resolved_effort = (effort or settings.export_clean_effort or "low").strip().lower()
    if resolved_effort not in ("low", "medium", "high"):
        resolved_effort = "low"

    chosen_record: Optional[Model] = None
    selection_mode = "explicit"

    if target_model_id and target_model_id.lower() != "auto":
        try:
            chosen_record = await Model.get(target_model_id)
        except Exception as exc:
            logger.warning(
                f"Configured export_clean_model {target_model_id!r} not found ({exc}); "
                "falling back to auto fast-model selection."
            )

    if chosen_record is None:
        selection_mode = "auto"
        defaults = await DefaultModels.get_instance()
        default_chat: Optional[Model] = None
        if defaults.default_chat_model:
            try:
                default_chat = await Model.get(defaults.default_chat_model)
            except Exception:
                default_chat = None

        all_lang_models = await Model.get_models_by_type("language")
        if all_lang_models:
            active_family = (
                _detect_model_family(default_chat.provider, default_chat.name)
                if default_chat
                else None
            )
            same_family = [
                m
                for m in all_lang_models
                if active_family
                and _detect_model_family(m.provider, m.name) == active_family
            ]
            pool = same_family if same_family else all_lang_models
            chosen_record = max(
                pool,
                key=lambda m: (
                    _score_fast_cheap_model(m.name),
                    # Tie-breaker: prefer same credential as default chat model
                    1
                    if default_chat and str(m.credential) == str(default_chat.credential)
                    else 0,
                ),
            )
        else:
            chosen_record = default_chat

    if chosen_record is None or not chosen_record.id:
        return None, ""

    esp_model = await model_manager.get_model(str(chosen_record.id), max_tokens=8192)
    if esp_model is None:
        return None, ""

    lc_model = esp_model.to_langchain()

    # Apply low/selected reasoning effort cleanly (supported by ChatOpenAI & our unified bridge)
    try:
        if hasattr(lc_model, "reasoning_effort"):
            setattr(lc_model, "reasoning_effort", resolved_effort)
        elif hasattr(lc_model, "model_kwargs") and isinstance(lc_model.model_kwargs, dict):
            lc_model.model_kwargs = {
                **lc_model.model_kwargs,
                "reasoning_effort": resolved_effort,
            }
    except Exception as exc:
        logger.debug(f"Could not set reasoning_effort={resolved_effort} on {chosen_record.name}: {exc}")

    label = f"{chosen_record.name} ({resolved_effort} effort)"
    logger.info(
        f"Export & Clean selected model ({selection_mode}): {chosen_record.provider}/{chosen_record.name} "
        f"[id={chosen_record.id}, effort={resolved_effort}]"
    )
    return lc_model, label


async def build_sources_export_async(
    notebook_name: str,
    sources: List[Source],
    fmt: ExportFormat = "md",
    clean: bool = False,
    clean_model_id: Optional[str] = None,
    clean_effort: Optional[str] = None,
) -> Tuple[str, Dict[str, object]]:
    """
    Build a single RAG-ready knowledge-base document containing all provided sources
    in either Markdown ('md') or Plain Text ('txt') format.

    When `clean=True`, runs Stage 1 deterministic boilerplate stripping across all
    sources followed by Stage 2 parallel LLM cleaning & RAG formatting using the
    configured fast/cheap cleaning model at low effort (with graceful fallback).

    Returns (exported_text, stats_dict).
    """
    original_raw_chars = sum(len(s.full_text or "") for s in sources)
    repeated_nav = _detect_repeated_nav_links(sources) if clean else set()

    # Stage 1 per-source preprocessing
    stage1_texts: List[str] = []
    for src in sources:
        raw = src.full_text or ""
        if clean:
            stage1_texts.append(_strip_web_boilerplate(raw, repeated_nav))
        else:
            stage1_texts.append(_clean_raw_text(raw))

    llm_cleaned_count = 0
    cleaning_model_label = ""
    final_bodies: List[str] = list(stage1_texts)

    # Stage 2: LLM cleaning & lean RAG formatting when `clean=True`
    if clean and sources:
        model = None
        try:
            model, cleaning_model_label = await resolve_export_clean_model(
                explicit_model_id=clean_model_id,
                effort=clean_effort or "",
            )
        except Exception as exc:
            logger.warning(
                f"Could not provision Export & Clean model; "
                f"using deterministic Stage 1 cleaner only: {exc}"
            )

        if model is not None:
            sem = asyncio.Semaphore(LLM_CLEAN_CONCURRENCY)

            async def _clean_one(idx: int, src: Source, text: str) -> None:
                nonlocal llm_cleaned_count
                if not text or len(text) > LLM_CLEAN_MAX_SOURCE_CHARS:
                    return
                async with sem:
                    polished = await _llm_clean_source_text(
                        model=model,
                        title=(src.title or f"Source {idx + 1}").strip(),
                        text=text,
                        fmt=fmt,
                    )
                    if polished:
                        # Re-apply empty-bullet/copyright guard in case LLM echoed any
                        polished = _strip_web_boilerplate(polished, set())
                        if polished:
                            final_bodies[idx] = polished
                            llm_cleaned_count += 1

            await asyncio.gather(
                *(_clean_one(i, src, stage1_texts[i]) for i, src in enumerate(sources))
            )

    exported = _assemble_export_document(
        notebook_name=notebook_name,
        sources=sources,
        bodies=final_bodies,
        fmt=fmt,
        cleaned=clean,
        already_llm_formatted=llm_cleaned_count > 0,
    )

    stats: Dict[str, object] = {
        "original_char_count": original_raw_chars,
        "char_count": len(exported),
        "llm_cleaned_count": llm_cleaned_count,
        "cleaning_model": cleaning_model_label or None,
    }
    return exported, stats


def build_sources_export(
    notebook_name: str,
    sources: List[Source],
    fmt: ExportFormat = "md",
    clean: bool = False,
) -> str:
    """Synchronous deterministic export helper (Stage 1 cleaning when clean=True)."""
    repeated_nav = _detect_repeated_nav_links(sources) if clean else set()
    bodies = [
        _strip_web_boilerplate(s.full_text or "", repeated_nav)
        if clean
        else _clean_raw_text(s.full_text or "")
        for s in sources
    ]
    return _assemble_export_document(
        notebook_name=notebook_name,
        sources=sources,
        bodies=bodies,
        fmt=fmt,
        cleaned=clean,
        already_llm_formatted=False,
    )


def _assemble_export_document(
    notebook_name: str,
    sources: List[Source],
    bodies: List[str],
    fmt: ExportFormat,
    cleaned: bool,
    already_llm_formatted: bool,
) -> str:
    nb_title = (notebook_name or "Notebook").strip() or "Notebook"
    exported_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    total = len(sources)
    mode_label = "Cleaned & RAG-Optimized" if cleaned else "RAG-Optimized"

    if fmt == "txt":
        parts: List[str] = [
            f"NOTEBOOK KNOWLEDGE BASE: {nb_title}",
            f"Exported: {exported_at}",
            f"Total Sources: {total}",
            f"Format: Plain Text ({mode_label})",
            "",
            "TABLE OF CONTENTS",
            "-" * 40,
        ]
        for idx, src in enumerate(sources, start=1):
            title = (src.title or f"Untitled Source {idx}").strip()
            origin_label, origin_val, _ = resolve_source_origin(src)
            parts.append(f"{idx}. {title} ({origin_label}: {origin_val})")

        parts.append("")
        parts.append(SOURCE_SEPARATOR)
        parts.append("")

        for idx, (src, raw_body) in enumerate(zip(sources, bodies), start=1):
            title = (src.title or f"Untitled Source {idx}").strip()
            origin_label, origin_val, kind = resolve_source_origin(src)
            topics = [t.strip() for t in (src.topics or []) if t and t.strip()]
            body = _markdown_to_clean_plaintext(raw_body)

            section_lines = [
                f"SOURCE {idx} OF {total}: {title}",
                f"{origin_label}: {origin_val}",
                f"Source Type: {kind}",
            ]
            if topics:
                section_lines.append(f"Topics: {', '.join(topics)}")
            section_lines.extend(["", body, "", SOURCE_SEPARATOR, ""])
            parts.append("\n".join(section_lines))

        return "\n".join(parts).rstrip() + "\n"

    # Default: RAG-optimized Markdown (.md)
    md_parts: List[str] = [
        f"# {nb_title}",
        "",
        (
            "> *Consolidated RAG Knowledge Base exported from Open Notebook. "
            "Each source begins with structured metadata (title, origin URL or filename, "
            "and type) and ends with a full row of `=` characters for unambiguous source boundaries.*"
        ),
        "",
        f"- **Notebook:** <u>{nb_title}</u>",
        f"- **Exported:** *{exported_at}*",
        f"- **Total Sources:** **{total}**",
        f"- **Format:** *Markdown ({mode_label})*",
        "",
        "## Table of Contents",
        "",
    ]

    for idx, src in enumerate(sources, start=1):
        title = (src.title or f"Untitled Source {idx}").strip()
        origin_label, origin_val, _ = resolve_source_origin(src)
        md_parts.append(f"{idx}. **{title}** — *{origin_label}: {origin_val}*")

    md_parts.extend(["", SOURCE_SEPARATOR, ""])

    for idx, (src, raw_body) in enumerate(zip(sources, bodies), start=1):
        title = (src.title or f"Untitled Source {idx}").strip()
        origin_label, origin_val, kind = resolve_source_origin(src)
        topics = [t.strip() for t in (src.topics or []) if t and t.strip()]
        body = (
            _enhance_markdown_for_rag(raw_body)
            if not already_llm_formatted
            else _enhance_markdown_for_rag(raw_body)
        )

        section_lines = [
            f"## Source {idx}: {title}",
            "",
            f"- **Title:** <u>{title}</u>",
            f"- **{origin_label}:** *{origin_val}*",
            f"- **Source Type:** *{kind}*",
        ]
        if topics:
            section_lines.append(f"- **Topics:** *{', '.join(topics)}*")
        section_lines.extend(
            [
                "",
                "### Source Content",
                "",
                body,
                "",
                SOURCE_SEPARATOR,
                "",
            ]
        )
        md_parts.append("\n".join(section_lines))

    return "\n".join(md_parts).rstrip() + "\n"
