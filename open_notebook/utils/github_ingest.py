"""GitHub repository and directory ingestion for Open Notebook.

Fetches a public or private GitHub repository (or specific subdirectory),
builds a structured Markdown overview (Overview, Directory Tree Table of Contents,
Main Files table, Architecture & Entry Points, Tech Stack & Quickstart), and
appends the filtered, path-tagged source files below a machine-readable marker
for both clean UI rendering and Hybrid Vector RAG chunking.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import posixpath
import re
import tarfile
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

import httpx
from loguru import logger

GITHUB_INDEXED_FILES_MARKER = "<!-- GITHUB_INDEXED_FILES_START -->"
GITHUB_FILE_START_PREFIX = "<!-- GITHUB_FILE_START:"
GITHUB_FILE_END_MARKER = "<!-- GITHUB_FILE_END -->"

MAX_FILE_BYTES = 200_000  # 200 KB per file
DEFAULT_MAX_FILES = 250
DEFAULT_MAX_TOTAL_BYTES = 3_500_000  # ~3.5 MB of filtered text
TARBALL_MAX_BYTES = 80_000_000  # 80 MB compressed archive guard

EXCLUDED_DIRS = {
    ".git",
    ".github",
    ".gitlab",
    ".hg",
    ".svn",
    "node_modules",
    "bower_components",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".astro",
    ".vercel",
    ".turbo",
    ".cache",
    ".parcel-cache",
    "dist",
    "build",
    "out",
    "target",
    "vendor",
    "third_party",
    "venv",
    ".venv",
    "env",
    ".env",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".tox",
    "coverage",
    "htmlcov",
    ".idea",
    ".vscode",
    "pods",
    ".gradle",
    "site-packages",
    "bin",
    "obj",
}

EXCLUDED_FILENAMES = {
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
    "bun.lock",
    "uv.lock",
    "poetry.lock",
    "pipfile.lock",
    "cargo.lock",
    "go.sum",
    "composer.lock",
    "gemfile.lock",
    "flake.lock",
    "pods.lock",
    ".ds_store",
    "thumbs.db",
}

EXCLUDED_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
    ".ico",
    ".tif",
    ".tiff",
    ".psd",
    ".ai",
    ".eps",
    ".mp4",
    ".mov",
    ".avi",
    ".mkv",
    ".webm",
    ".mp3",
    ".wav",
    ".ogg",
    ".flac",
    ".m4a",
    ".aac",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".eot",
    ".zip",
    ".tar",
    ".gz",
    ".tgz",
    ".bz2",
    ".xz",
    ".7z",
    ".rar",
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".a",
    ".lib",
    ".o",
    ".obj",
    ".pyc",
    ".pyo",
    ".pyd",
    ".class",
    ".jar",
    ".war",
    ".ear",
    ".wasm",
    ".sqlite",
    ".sqlite3",
    ".db",
    ".parquet",
    ".feather",
    ".arrow",
    ".npy",
    ".npz",
    ".pt",
    ".pth",
    ".ckpt",
    ".safetensors",
    ".onnx",
    ".bin",
    ".dat",
    ".pak",
    ".map",
    ".svg",
}

MANIFEST_FILENAMES = {
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "setup.py",
    "setup.cfg",
    "cargo.toml",
    "go.mod",
    "gemfile",
    "composer.json",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
    "makefile",
    "justfile",
    "cmakelists.txt",
}

EXT_TO_LANG = {
    ".py": "python",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "jsx",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".md": "markdown",
    ".mdx": "markdown",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".kt": "kotlin",
    ".scala": "scala",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".hpp": "cpp",
    ".cc": "cpp",
    ".cs": "csharp",
    ".rb": "ruby",
    ".php": "php",
    ".swift": "swift",
    ".sh": "bash",
    ".bash": "bash",
    ".zsh": "bash",
    ".ps1": "powershell",
    ".bat": "batch",
    ".sql": "sql",
    ".html": "html",
    ".htm": "html",
    ".css": "css",
    ".scss": "scss",
    ".less": "less",
    ".xml": "xml",
    ".vue": "vue",
    ".svelte": "svelte",
    ".graphql": "graphql",
    ".gql": "graphql",
    ".proto": "protobuf",
    ".tf": "hcl",
    ".dockerfile": "dockerfile",
    ".ini": "ini",
    ".cfg": "ini",
    ".env.example": "bash",
    ".txt": "text",
    ".r": "r",
    ".lua": "lua",
    ".dart": "dart",
    ".ex": "elixir",
    ".exs": "elixir",
}


@dataclass
class GitHubTarget:
    owner: str
    repo: str
    kind: str  # "repo", "tree", "blob"
    raw_ref_path: str = ""  # everything after /tree/ or /blob/

    @property
    def full_name(self) -> str:
        return f"{self.owner}/{self.repo}"


def is_github_repo_url(raw_url: str) -> bool:
    """Return True if raw_url points to a GitHub repository or tree/directory."""
    try:
        parse_github_url(raw_url)
        return True
    except ValueError:
        return False


def parse_github_url(raw_url: str) -> GitHubTarget:
    """Parse and strictly validate a GitHub repository or directory URL.

    Accepts:
      - https://github.com/owner/repo
      - https://github.com/owner/repo/tree/branch/optional/subdir
      - https://github.com/owner/repo/blob/branch/path/to/file
      - github.com/owner/repo
      - owner/repo
    """
    value = (raw_url or "").strip()
    if not value:
        raise ValueError("Please provide a GitHub repository URL.")

    # Support shorthand "owner/repo"
    if re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", value):
        owner, repo = value.split("/", 1)
        repo = repo[:-4] if repo.endswith(".git") else repo
        return GitHubTarget(owner=owner, repo=repo, kind="repo")

    if not re.match(r"^https?://", value, re.IGNORECASE):
        value = f"https://{value}"

    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    if host not in ("github.com", "www.github.com"):
        raise ValueError(
            "Only github.com repository or directory URLs are supported."
        )

    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) < 2:
        raise ValueError(
            "GitHub URL must include both owner and repository (e.g. https://github.com/owner/repo)."
        )

    owner = parts[0]
    repo = parts[1]
    if repo.endswith(".git"):
        repo = repo[:-4]

    if not re.fullmatch(r"[A-Za-z0-9_.-]+", owner) or not re.fullmatch(
        r"[A-Za-z0-9_.-]+", repo
    ):
        raise ValueError("Invalid GitHub owner or repository name.")

    if len(parts) == 2:
        return GitHubTarget(owner=owner, repo=repo, kind="repo")

    section = parts[2].lower()
    if section in ("tree", "blob") and len(parts) >= 4:
        return GitHubTarget(
            owner=owner,
            repo=repo,
            kind=section,
            raw_ref_path="/".join(parts[3:]),
        )

    # Reject non-code GitHub pages like /issues/123, /pull/45, /releases
    if section in ("issues", "pull", "pulls", "discussions", "releases", "actions", "wiki"):
        raise ValueError(
            f"This looks like a GitHub {section} page rather than a repository or directory. "
            "Use the Link tab for single pages, or paste the repo/directory URL here."
        )

    return GitHubTarget(owner=owner, repo=repo, kind="repo")


def _github_headers(token: Optional[str] = None) -> Dict[str, str]:
    resolved = (token or "").strip() or (os.getenv("GITHUB_TOKEN") or "").strip()
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "Open-Notebook-GitHub-Ingest/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if resolved:
        headers["Authorization"] = f"Bearer {resolved}"
    return headers


def _handle_github_http_error(resp: httpx.Response, repo_label: str) -> None:
    if resp.status_code == 404:
        raise ValueError(
            f"GitHub repository '{repo_label}' was not found (or is private — add a GitHub token under Advanced options)."
        )
    if resp.status_code == 401:
        raise ValueError(
            "GitHub rejected the access token (401 Unauthorized). Check your token and try again."
        )
    if resp.status_code == 403:
        remaining = resp.headers.get("X-RateLimit-Remaining")
        if remaining == "0":
            raise ValueError(
                "GitHub API rate limit reached for unauthenticated requests. "
                "Provide a GitHub Personal Access Token under Advanced options (or set GITHUB_TOKEN in .env)."
            )
        raise ValueError(
            f"Access to '{repo_label}' was forbidden by GitHub (HTTP 403)."
        )
    if resp.status_code >= 400:
        raise ValueError(
            f"GitHub API returned HTTP {resp.status_code} for '{repo_label}'."
        )


async def _resolve_repo_ref_and_tree(
    client: httpx.AsyncClient,
    target: GitHubTarget,
    headers: Dict[str, str],
    subdir_override: Optional[str] = None,
) -> Dict[str, Any]:
    """Fetch repo metadata, resolve branch + subdir (supporting slashes in branch names), and fetch recursive tree."""
    repo_resp = await client.get(
        f"https://api.github.com/repos/{target.owner}/{target.repo}",
        headers=headers,
    )
    _handle_github_http_error(repo_resp, target.full_name)
    repo_meta = repo_resp.json()

    default_branch = repo_meta.get("default_branch") or "main"
    branch = default_branch
    subdir = ""
    single_file: Optional[str] = None

    if target.raw_ref_path:
        raw_parts = [p for p in target.raw_ref_path.split("/") if p]
        # Fast path: starts with default_branch (handles branches with slashes like release/v1)
        default_parts = default_branch.split("/")
        if raw_parts[: len(default_parts)] == default_parts:
            branch = default_branch
            rest = "/".join(raw_parts[len(default_parts) :])
        else:
            # Try progressively longer branch prefixes (up to 4 segments) against GitHub API
            matched_branch = None
            rest = ""
            max_prefix = min(len(raw_parts), 4)
            for idx in range(max_prefix, 0, -1):
                candidate = "/".join(raw_parts[:idx])
                b_resp = await client.get(
                    f"https://api.github.com/repos/{target.owner}/{target.repo}/branches/{candidate}",
                    headers=headers,
                )
                if b_resp.status_code == 200:
                    matched_branch = candidate
                    rest = "/".join(raw_parts[idx:])
                    break
            if matched_branch:
                branch = matched_branch
            else:
                # Could be a tag or commit SHA in the first segment
                branch = raw_parts[0]
                rest = "/".join(raw_parts[1:])

        if target.kind == "blob" and rest:
            single_file = rest.strip("/")
        elif rest:
            subdir = rest.strip("/")

    if subdir_override and subdir_override.strip():
        subdir = subdir_override.strip().strip("/")
        single_file = None

    # Fetch git tree recursively
    tree_resp = await client.get(
        f"https://api.github.com/repos/{target.owner}/{target.repo}/git/trees/{branch}",
        params={"recursive": "1"},
        headers=headers,
    )
    _handle_github_http_error(tree_resp, f"{target.full_name}@{branch}")
    tree_data = tree_resp.json()

    commit_sha = tree_data.get("sha") or branch
    # Try to get the actual commit SHA for display (tree sha != commit sha, both work for tarball)
    ref_resp = await client.get(
        f"https://api.github.com/repos/{target.owner}/{target.repo}/commits/{branch}",
        headers=headers,
    )
    if ref_resp.status_code == 200:
        commit_sha = ref_resp.json().get("sha") or commit_sha

    canonical_url = f"https://github.com/{target.owner}/{target.repo}"
    if single_file:
        canonical_url = f"{canonical_url}/blob/{branch}/{single_file}"
    elif subdir:
        canonical_url = f"{canonical_url}/tree/{branch}/{subdir}"
    elif branch != default_branch:
        canonical_url = f"{canonical_url}/tree/{branch}"

    return {
        "repo_meta": repo_meta,
        "branch": branch,
        "default_branch": default_branch,
        "commit_sha": commit_sha,
        "subdir": subdir,
        "single_file": single_file,
        "canonical_url": canonical_url,
        "tree": tree_data.get("tree") or [],
        "tree_truncated": bool(tree_data.get("truncated")),
    }


def _parse_ext_filter(include_ext: Optional[str]) -> Optional[set[str]]:
    if not include_ext or not include_ext.strip():
        return None
    exts: set[str] = set()
    for part in re.split(r"[,;\s]+", include_ext.strip()):
        token = part.strip().lower()
        if not token:
            continue
        if not token.startswith("."):
            token = f".{token}"
        exts.add(token)
    return exts or None


def _should_include_path(
    rel_path: str,
    size: int,
    ext_filter: Optional[set[str]] = None,
) -> bool:
    if size <= 0 or size > MAX_FILE_BYTES:
        return False

    parts = [p for p in rel_path.split("/") if p]
    if not parts:
        return False

    # Check excluded directory segments
    for segment in parts[:-1]:
        if segment.lower() in EXCLUDED_DIRS:
            return False

    filename = parts[-1]
    lower_name = filename.lower()
    if lower_name in EXCLUDED_FILENAMES:
        return False
    if lower_name.endswith(".min.js") or lower_name.endswith(".min.css"):
        return False
    if lower_name.endswith(".d.ts.map") or lower_name.endswith(".js.map"):
        return False

    _, ext = posixpath.splitext(lower_name)
    if ext in EXCLUDED_EXTENSIONS:
        return False

    if ext_filter is not None:
        if ext not in ext_filter:
            return False

    return True


def _file_priority_key(entry: Dict[str, Any]) -> Tuple[int, int, str]:
    """Order files so README, manifests, docs, and shallow core files are prioritized first."""
    path: str = entry["path"]
    lower = path.lower()
    base = posixpath.basename(lower)
    depth = path.count("/")

    if base.startswith("readme"):
        return (0, depth, path)
    if base in MANIFEST_FILENAMES:
        return (1, depth, path)
    if lower.endswith((".md", ".mdx")) and depth <= 1:
        return (2, depth, path)
    if any(
        token in lower
        for token in ("/test/", "/tests/", "__tests__", ".test.", ".spec.", "/fixtures/")
    ):
        return (5, depth, path)
    if lower.endswith((".json", ".yaml", ".yml", ".toml", ".ini", ".cfg")):
        return (4, depth, path)
    return (3, depth, path)


def _select_tree_files(
    tree: List[Dict[str, Any]],
    subdir: str = "",
    single_file: Optional[str] = None,
    include_ext: Optional[str] = None,
    max_files: int = DEFAULT_MAX_FILES,
    max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES,
) -> Tuple[List[Dict[str, Any]], int, int, bool]:
    """Filter and prioritize git tree blob entries.

    Returns (selected_entries, total_blobs_in_scope, skipped_count, budget_truncated).
    """
    ext_filter = _parse_ext_filter(include_ext)
    prefix = f"{subdir.strip('/')}/" if subdir.strip("/") else ""

    in_scope: List[Dict[str, Any]] = []
    for item in tree:
        if item.get("type") != "blob":
            continue
        full_path = item.get("path") or ""
        if single_file:
            if full_path != single_file:
                continue
            rel_path = full_path
        elif prefix:
            if not full_path.startswith(prefix):
                continue
            rel_path = full_path[len(prefix) :]
        else:
            rel_path = full_path

        in_scope.append(
            {
                "full_path": full_path,
                "path": rel_path,
                "size": int(item.get("size") or 0),
            }
        )

    candidates = [
        entry
        for entry in in_scope
        if _should_include_path(entry["path"], entry["size"], ext_filter)
    ]
    candidates.sort(key=_file_priority_key)

    selected: List[Dict[str, Any]] = []
    total_bytes = 0
    budget_truncated = False

    for entry in candidates:
        if len(selected) >= max_files:
            budget_truncated = True
            break
        if total_bytes + entry["size"] > max_total_bytes and len(selected) > 0:
            budget_truncated = True
            continue
        selected.append(entry)
        total_bytes += entry["size"]

    # Sort selected alphabetically for clean tree & readable output
    selected_sorted = sorted(selected, key=lambda e: e["path"].lower())
    skipped = len(in_scope) - len(selected_sorted)
    return selected_sorted, len(in_scope), skipped, budget_truncated


async def preview_github_repository(
    raw_url: str,
    subdir: Optional[str] = None,
    include_ext: Optional[str] = None,
    token: Optional[str] = None,
) -> Dict[str, Any]:
    """Fast 2-call GitHub API preview of a repository or subdirectory."""
    target = parse_github_url(raw_url)
    headers = _github_headers(token)

    async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
        info = await _resolve_repo_ref_and_tree(client, target, headers, subdir)

    selected, total_in_scope, skipped, budget_truncated = _select_tree_files(
        info["tree"],
        subdir=info["subdir"],
        single_file=info["single_file"],
        include_ext=include_ext,
    )

    if total_in_scope == 0:
        scope_desc = info["subdir"] or info["single_file"] or target.full_name
        raise ValueError(
            f"No files found at '{scope_desc}' on branch '{info['branch']}'."
        )

    lang_counts: Dict[str, int] = {}
    for entry in selected:
        _, ext = posixpath.splitext(entry["path"].lower())
        key = ext or posixpath.basename(entry["path"]).lower()
        lang_counts[key] = lang_counts.get(key, 0) + 1
    top_languages = dict(
        sorted(lang_counts.items(), key=lambda kv: kv[1], reverse=True)[:8]
    )

    repo_meta = info["repo_meta"]
    license_info = repo_meta.get("license") or {}

    return {
        "owner": target.owner,
        "repo": target.repo,
        "full_name": target.full_name,
        "canonical_url": info["canonical_url"],
        "branch": info["branch"],
        "commit_sha": (info["commit_sha"] or "")[:12],
        "subdir": info["subdir"] or None,
        "description": repo_meta.get("description") or "",
        "primary_language": repo_meta.get("language") or None,
        "stars": int(repo_meta.get("stargazers_count") or 0),
        "license": license_info.get("spdx_id") or license_info.get("name") or None,
        "total_files_in_scope": total_in_scope,
        "included_files": len(selected),
        "skipped_files": skipped,
        "estimated_bytes": sum(e["size"] for e in selected),
        "truncated": bool(info["tree_truncated"] or budget_truncated),
        "top_languages": top_languages,
        "sample_files": [e["path"] for e in selected[:20]],
    }


def _extract_files_from_tarball(
    tar_bytes: bytes,
    selected_by_full_path: Dict[str, str],
) -> Dict[str, str]:
    """Synchronously unpack only the selected text files from a GitHub tarball."""
    extracted: Dict[str, str] = {}
    with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:gz") as tf:
        for member in tf.getmembers():
            if not member.isfile():
                continue
            # GitHub tarballs wrap everything in "<owner>-<repo>-<sha>/"
            parts = member.name.split("/", 1)
            if len(parts) < 2:
                continue
            repo_rel = parts[1]
            display_path = selected_by_full_path.get(repo_rel)
            if not display_path:
                continue
            if member.size > MAX_FILE_BYTES:
                continue
            fobj = tf.extractfile(member)
            if not fobj:
                continue
            raw = fobj.read()
            # Skip binary files containing NUL bytes
            if b"\x00" in raw[:4096]:
                continue
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                text = raw.decode("utf-8", errors="replace")
            extracted[display_path] = text
    return extracted


async def _download_selected_files(
    client: httpx.AsyncClient,
    target: GitHubTarget,
    ref_sha: str,
    selected: List[Dict[str, Any]],
    headers: Dict[str, str],
) -> Dict[str, str]:
    """Download repository archive in a single HTTP request and extract selected files."""
    selected_by_full_path = {e["full_path"]: e["path"] for e in selected}
    tarball_url = (
        f"https://api.github.com/repos/{target.owner}/{target.repo}/tarball/{ref_sha}"
    )

    chunks: List[bytes] = []
    downloaded = 0
    async with client.stream("GET", tarball_url, headers=headers) as resp:
        _handle_github_http_error(resp, target.full_name)
        async for chunk in resp.aiter_bytes(chunk_size=131_072):
            downloaded += len(chunk)
            if downloaded > TARBALL_MAX_BYTES:
                raise ValueError(
                    f"Repository archive exceeds the {TARBALL_MAX_BYTES // 1_000_000} MB safety limit. "
                    "Try targeting a specific subfolder URL (e.g. /tree/main/src)."
                )
            chunks.append(chunk)

    tar_bytes = b"".join(chunks)
    return await asyncio.to_thread(
        _extract_files_from_tarball, tar_bytes, selected_by_full_path
    )


def build_directory_tree(
    paths: List[str], root_label: str, max_lines: int = 160
) -> str:
    """Render a clean monospace ASCII directory tree."""
    root: Dict[str, Any] = {}
    for p in sorted(paths, key=lambda s: s.lower()):
        node = root
        parts = [seg for seg in p.split("/") if seg]
        for idx, part in enumerate(parts):
            is_last = idx == len(parts) - 1
            if is_last:
                node.setdefault("__files__", []).append(part)
            else:
                node = node.setdefault(part, {})

    lines: List[str] = [f"{root_label}/"]

    def walk(node: Dict[str, Any], prefix: str) -> None:
        if len(lines) >= max_lines:
            return
        dirs = sorted(k for k in node.keys() if k != "__files__")
        files = sorted(node.get("__files__", []))
        entries: List[Tuple[str, bool]] = [(d, True) for d in dirs] + [
            (f, False) for f in files
        ]
        for idx, (name, is_dir) in enumerate(entries):
            if len(lines) >= max_lines:
                remaining = len(entries) - idx
                lines.append(f"{prefix}└── ... ({remaining} more entries)")
                return
            is_last_item = idx == len(entries) - 1
            connector = "└── " if is_last_item else "├── "
            if is_dir:
                lines.append(f"{prefix}{connector}{name}/")
                child_prefix = prefix + ("    " if is_last_item else "│   ")
                walk(node[name], child_prefix)
            else:
                lines.append(f"{prefix}{connector}{name}")

    walk(root, "")
    return "\n".join(lines)


def _extract_file_hint(path: str, content: str) -> str:
    """Fast deterministic 1-line summary extracted from docstrings, headings, or symbols."""
    lines = content.splitlines()
    lower = path.lower()

    # Markdown: first heading or non-empty line
    if lower.endswith((".md", ".mdx")):
        for line in lines[:20]:
            stripped = line.strip()
            if stripped.startswith("#"):
                return stripped.lstrip("#").strip()[:120]
        for line in lines[:20]:
            stripped = line.strip()
            if stripped and not stripped.startswith("![") and not stripped.startswith("[!"):
                return stripped[:120]

    # Python module docstring
    if lower.endswith(".py"):
        m = re.match(r'\s*(?:"""|\'\'\')(.+?)(?:"""|\'\'\')', content[:1500], re.DOTALL)
        if m:
            first_line = m.group(1).strip().splitlines()[0].strip()
            if first_line:
                return first_line[:120]

    # JS/TS/C/Rust/Go top JSDoc or comment block
    for line in lines[:12]:
        stripped = line.strip()
        if not stripped or stripped.startswith(("#!", '"use ', "'use ")):
            continue
        if stripped.startswith("/**") or stripped.startswith("/*"):
            cleaned = re.sub(r"^/\*+\s*|\*+/$", "", stripped).strip()
            if cleaned:
                return cleaned[:120]
            continue
        if stripped.startswith("* ") and not stripped.startswith("* @"):
            return stripped[2:].strip()[:120]
        if stripped.startswith(("//", "#")) and not stripped.startswith(("// eslint", "# noqa", "# type:")):
            cleaned = stripped.lstrip("/# ").strip()
            if len(cleaned) >= 10:
                return cleaned[:120]
        break

    # Fall back to listing top-level symbols
    symbols: List[str] = []
    for line in lines[:120]:
        m = re.match(
            r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:class|def|function|interface|type|struct|enum|fn)\s+([A-Za-z_][A-Za-z0-9_]*)",
            line,
        )
        if m and m.group(1) not in symbols:
            symbols.append(m.group(1))
        if len(symbols) >= 4:
            break
    if symbols:
        return f"Defines {', '.join(f'`{s}`' for s in symbols)}"

    return f"Source file ({len(lines)} lines)"


def _parse_manifest_summary(files: Dict[str, str]) -> List[str]:
    """Extract key dependencies and scripts from common manifest files."""
    notes: List[str] = []
    for path, content in files.items():
        base = posixpath.basename(path).lower()
        if base == "package.json":
            try:
                data = json.loads(content)
                deps = list((data.get("dependencies") or {}).keys())[:15]
                scripts = list((data.get("scripts") or {}).keys())[:8]
                if deps:
                    notes.append(f"- **Node/JS ({path}):** {', '.join(deps)}")
                if scripts:
                    notes.append(f"- **Scripts ({path}):** {', '.join(f'`{s}`' for s in scripts)}")
            except Exception:
                pass
        elif base == "pyproject.toml":
            deps = re.findall(r'"([A-Za-z0-9_.-]+)(?:[><=!~][^"]*)?"', content[:6000])
            unique_deps = list(dict.fromkeys(deps))[:15]
            if unique_deps:
                notes.append(f"- **Python ({path}):** {', '.join(unique_deps)}")
        elif base == "requirements.txt":
            pkgs = [
                re.split(r"[=<>!~\[]", line.strip())[0]
                for line in content.splitlines()[:25]
                if line.strip() and not line.strip().startswith("#")
            ]
            if pkgs:
                notes.append(f"- **Python ({path}):** {', '.join(pkgs[:15])}")
        elif base == "cargo.toml":
            notes.append(f"- **Rust ({path}):** Cargo project")
        elif base == "go.mod":
            first_line = content.splitlines()[0].strip() if content.splitlines() else ""
            notes.append(f"- **Go ({path}):** {first_line}")
    return notes


def _build_deterministic_summary(
    repo_meta: Dict[str, Any],
    files: Dict[str, str],
    tree_text: str,
    subdir: str,
) -> str:
    """Fallback structured summary when no default chat model is available."""
    description = (repo_meta.get("description") or "").strip()

    # Pull first 2 prose paragraphs from README if present
    readme_excerpt = ""
    for path, content in files.items():
        if posixpath.basename(path).lower().startswith("readme"):
            paragraphs: List[str] = []
            buf: List[str] = []
            for line in content.splitlines():
                s = line.strip()
                if not s:
                    if buf:
                        para = " ".join(buf)
                        if len(para) > 35 and not para.startswith(("![", "[!", "<img", "<a ", "<p ", "|")):
                            paragraphs.append(para)
                        buf = []
                    if len(paragraphs) >= 2:
                        break
                elif not s.startswith("#") and not s.startswith("```"):
                    buf.append(s)
            if buf and len(paragraphs) < 2:
                para = " ".join(buf)
                if len(para) > 35:
                    paragraphs.append(para)
            readme_excerpt = "\n\n".join(paragraphs[:2])
            break

    overview_parts = []
    if description:
        overview_parts.append(description)
    if readme_excerpt and readme_excerpt != description:
        overview_parts.append(readme_excerpt)
    if not overview_parts:
        scope = f"the `{subdir}` directory of `{repo_meta.get('full_name')}`" if subdir else f"`{repo_meta.get('full_name')}`"
        overview_parts.append(
            f"Source code repository snapshot for {scope}, containing {len(files)} indexed text and code files."
        )

    # Pick top ~20 key files for the Main Files table
    prioritized = sorted(
        [{"path": p, "size": len(c)} for p, c in files.items()],
        key=_file_priority_key,
    )[:22]
    table_rows = [
        "| File | What It Does |",
        "| --- | --- |",
    ]
    for entry in prioritized:
        p = entry["path"]
        hint = _extract_file_hint(p, files[p]).replace("|", "\\|").replace("\n", " ")
        table_rows.append(f"| `{p}` | {hint} |")

    manifest_notes = _parse_manifest_summary(files)
    stack_section = (
        "\n".join(manifest_notes)
        if manifest_notes
        else f"- **Primary Language:** {repo_meta.get('language') or 'Mixed'}"
    )

    sections = [
        "## Overview",
        "",
        "\n\n".join(overview_parts),
        "",
        "## Table of Contents",
        "",
        "```text",
        tree_text,
        "```",
        "",
        "## Main Files & What They Do",
        "",
        "\n".join(table_rows),
        "",
        "## Tech Stack & Dependencies",
        "",
        stack_section,
    ]
    return "\n".join(sections)


async def _generate_llm_summary(
    repo_meta: Dict[str, Any],
    files: Dict[str, str],
    tree_text: str,
    subdir: str,
) -> Optional[str]:
    """Generate Overview, Main Files table, Architecture, and Tech Stack in a single LLM pass."""
    try:
        from langchain_core.messages import HumanMessage, SystemMessage
        from open_notebook.ai.provision import provision_langchain_model
        from open_notebook.utils.text_utils import extract_text_content
    except Exception as e:
        logger.debug(f"LLM modules unavailable for GitHub summary: {e}")
        return None

    # Build a compact, high-signal digest for 1 single fast LLM call
    readme_text = ""
    for p, c in files.items():
        if posixpath.basename(p).lower().startswith("readme"):
            readme_text = c[:4500]
            break

    manifest_blocks: List[str] = []
    manifest_budget = 3500
    for p, c in files.items():
        if posixpath.basename(p).lower() in MANIFEST_FILENAMES and manifest_budget > 0:
            snippet = c[: min(1500, manifest_budget)]
            manifest_blocks.append(f"### {p}\n{snippet}")
            manifest_budget -= len(snippet)

    # Opening lines of up to 30 top priority non-README files
    prioritized = sorted(
        [{"path": p, "size": len(c)} for p, c in files.items()],
        key=_file_priority_key,
    )
    file_previews: List[str] = []
    preview_budget = 14_000
    for entry in prioritized:
        p = entry["path"]
        if posixpath.basename(p).lower().startswith("readme"):
            continue
        lines = files[p].splitlines()
        head = "\n".join(lines[:35])[:700]
        block = f"### {p} ({len(lines)} lines)\n{head}"
        if preview_budget - len(block) < 0:
            break
        file_previews.append(block)
        preview_budget -= len(block)
        if len(file_previews) >= 30:
            break

    scope_label = (
        f"{repo_meta.get('full_name')} (subdirectory: {subdir})"
        if subdir
        else str(repo_meta.get("full_name"))
    )

    system_prompt = (
        "You are a senior software architect creating a clear, factual reference guide "
        "for a GitHub repository imported into a knowledge notebook. "
        "Only state facts directly supported by the repository tree, README, manifests, and file excerpts. "
        "Return clean Markdown ONLY (no outer code fence)."
    )

    user_prompt = f"""Analyze this GitHub repository and write a concise, structured summary using EXACTLY these four Markdown sections:

1. `## Overview`
Write 1 to 2 clear paragraphs explaining what this repository (or directory) does, its core purpose, and who/what it is built for.

2. `## Main Files & What They Do`
Write a Markdown table (`| File | What It Does |`) covering the 10 to 25 most important files/modules with crisp 1-sentence descriptions of their responsibility. Use exact file paths from the tree below.

3. `## Architecture & Entry Points`
Write 3 to 6 concise bullet points describing the entry points (servers, CLIs, UI entry files, core graphs/pipelines) and how the major layers connect.

4. `## Tech Stack & Quickstart`
Write concise bullets listing the main languages, frameworks, key libraries, and primary install/run/test commands if present in the README or manifests.

Keep the entire response under 7,500 characters. Do NOT include a directory tree (it will be inserted automatically between Overview and Main Files).

---
Repository: {scope_label}
GitHub Description: {repo_meta.get("description") or "(none)"}
Primary Language: {repo_meta.get("language") or "Mixed"}
Total Indexed Files: {len(files)}

DIRECTORY TREE:
{tree_text[:4500]}

README EXCERPT:
{readme_text or "(no README found)"}

MANIFESTS / CONFIGS:
{chr(10).join(manifest_blocks) or "(none)"}

KEY FILE OPENING EXCERPTS:
{chr(10).join(file_previews)}
"""

    try:
        model = await provision_langchain_model(
            user_prompt,
            None,
            "chat",
            max_tokens=3072,
        )
        response = await asyncio.wait_for(
            model.ainvoke(
                [
                    SystemMessage(content=system_prompt),
                    HumanMessage(content=user_prompt),
                ]
            ),
            timeout=75.0,
        )
        text = extract_text_content(response.content).strip()
        if not text or "## Overview" not in text:
            return None

        # Strip accidental outer markdown fence if model wrapped it
        if text.startswith("```"):
            text = re.sub(r"^```(?:markdown|md)?\s*", "", text)
            text = re.sub(r"\s*```$", "", text).strip()

        # Insert our 100% factual deterministic Table of Contents right between
        # ## Overview and ## Main Files & What They Do
        toc_block = f"\n\n## Table of Contents\n\n```text\n{tree_text}\n```\n\n"
        main_files_match = re.search(r"\n##\s+Main Files", text)
        if main_files_match:
            idx = main_files_match.start()
            combined = text[:idx].rstrip() + toc_block + text[idx:].lstrip()
        else:
            combined = text + toc_block
        return combined
    except Exception as e:
        logger.warning(
            f"LLM GitHub summary generation failed (falling back to deterministic summary): {e}"
        )
        return None


def _fence_lang_for_path(path: str) -> str:
    lower = path.lower()
    base = posixpath.basename(lower)
    if base == "dockerfile" or base.startswith("dockerfile."):
        return "dockerfile"
    if base == "makefile":
        return "makefile"
    _, ext = posixpath.splitext(lower)
    return EXT_TO_LANG.get(ext, "")


def _format_indexed_files(files: Dict[str, str]) -> str:
    """Format all filtered files with path headers and machine-readable markers."""
    blocks: List[str] = [
        "",
        "---",
        "",
        GITHUB_INDEXED_FILES_MARKER,
        "",
        f"## Indexed Source Files ({len(files)})",
        "",
    ]
    for path in sorted(files.keys(), key=lambda s: s.lower()):
        content = files[path]
        line_count = len(content.splitlines())
        lang = _fence_lang_for_path(path)
        # Use a fence longer than any backtick run inside the file
        fence = "````" if "```" in content else "```"
        blocks.append(f"{GITHUB_FILE_START_PREFIX} {path} -->")
        blocks.append(f"### File: `{path}` ({line_count} lines)")
        blocks.append("")
        blocks.append(f"{fence}{lang}")
        blocks.append(content.rstrip("\n"))
        blocks.append(fence)
        blocks.append(GITHUB_FILE_END_MARKER)
        blocks.append("")
    return "\n".join(blocks)


async def ingest_github_repository(
    raw_url: str,
    subdir: Optional[str] = None,
    include_ext: Optional[str] = None,
    token: Optional[str] = None,
    use_llm_summary: bool = True,
) -> Tuple[str, str, Dict[str, Any]]:
    """Ingest a GitHub repository or directory into a structured Markdown document.

    Returns (title, full_markdown, metadata_dict).
    """
    target = parse_github_url(raw_url)
    headers = _github_headers(token)

    async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
        info = await _resolve_repo_ref_and_tree(client, target, headers, subdir)
        selected, total_in_scope, skipped, budget_truncated = _select_tree_files(
            info["tree"],
            subdir=info["subdir"],
            single_file=info["single_file"],
            include_ext=include_ext,
        )
        if not selected:
            scope = info["subdir"] or info["single_file"] or target.full_name
            raise ValueError(
                f"No indexable text/code files were found in '{scope}' (skipped {skipped} binary/excluded files)."
            )

        logger.info(
            f"Downloading GitHub archive for {target.full_name}@{info['branch']} "
            f"({len(selected)}/{total_in_scope} files selected)"
        )
        files = await _download_selected_files(
            client, target, info["commit_sha"], selected, headers
        )

    if not files:
        raise ValueError(
            f"Could not extract any readable text files from '{target.full_name}'."
        )

    repo_meta = info["repo_meta"]
    effective_subdir = info["subdir"] or ""
    root_label = (
        f"{target.repo}/{effective_subdir}" if effective_subdir else target.repo
    )
    tree_text = build_directory_tree(list(files.keys()), root_label=root_label)

    summary_md: Optional[str] = None
    if use_llm_summary:
        summary_md = await _generate_llm_summary(
            repo_meta, files, tree_text, effective_subdir
        )
    if not summary_md:
        summary_md = _build_deterministic_summary(
            repo_meta, files, tree_text, effective_subdir
        )

    short_sha = (info["commit_sha"] or "")[:10]
    license_info = repo_meta.get("license") or {}
    license_spdx = license_info.get("spdx_id") or license_info.get("name") or "Unspecified"
    primary_lang = repo_meta.get("language") or "Mixed"

    title = (
        f"{target.full_name} ({effective_subdir})"
        if effective_subdir
        else target.full_name
    )

    truncation_note = (
        f" *(capped at {len(files)} prioritized files)*"
        if budget_truncated or info["tree_truncated"]
        else ""
    )

    header_lines = [
        f"# {title}",
        "",
        (
            f"> **Repository:** [{target.full_name}]({info['canonical_url']})  \n"
            f"> **Branch:** `{info['branch']}` (`{short_sha}`) · "
            f"**Language:** {primary_lang} · "
            f"**License:** {license_spdx} · "
            f"**Indexed:** {len(files)} files{truncation_note}"
        ),
        "",
    ]

    full_markdown = (
        "\n".join(header_lines)
        + "\n"
        + summary_md.strip()
        + "\n"
        + _format_indexed_files(files)
    )

    metadata = {
        "source_type": "github",
        "owner": target.owner,
        "repo": target.repo,
        "branch": info["branch"],
        "commit_sha": info["commit_sha"],
        "subdir": effective_subdir or None,
        "canonical_url": info["canonical_url"],
        "indexed_files": len(files),
        "skipped_files": skipped,
        "truncated": bool(budget_truncated or info["tree_truncated"]),
    }

    return title, full_markdown, metadata
