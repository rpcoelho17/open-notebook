#!/usr/bin/env python3
"""
Experiment: Validate Hybrid Vector RAG (Opening TOC + SurrealDB bge-base-en-v1.5 vector_search)
against the live Statistics for Managers textbook in Open Notebook.
"""

import json
import time
import urllib.request

API_BASE = "http://127.0.0.1:5055/api"
BRIDGE_CHAT_URL = "http://127.0.0.1:8088/v1/chat/completions"


def get_json(url: str):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def post_json(url: str, payload: dict, timeout: int = 45):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _item_text(item: dict) -> str:
    raw = item.get("content") or item.get("matches") or ""
    if isinstance(raw, list):
        return "\n".join(str(x) for x in raw if x)
    return str(raw)


def main():
    print("=== 1. Inspecting Notebooks & Statistics Textbook ===")
    notebooks = get_json(f"{API_BASE}/notebooks")
    target_nb = None
    for nb in notebooks:
        if "stat" in (nb.get("name") or "").lower() or "manager" in (nb.get("name") or "").lower():
            target_nb = nb
            break
    if not target_nb:
        print("Available notebooks:", [(n["id"], n["name"]) for n in notebooks])
        raise SystemExit("Could not find Statistics notebook.")

    nb_id = target_nb["id"]
    print(f"Found notebook: {nb_id} | {target_nb['name']!r}")

    sources = get_json(f"{API_BASE}/sources?notebook_id={nb_id}")
    print(f"Sources in notebook: {len(sources)}")
    toc_snippet = ""
    for s in sources:
        sid = s["id"]
        detail = get_json(f"{API_BASE}/sources/{sid}")
        ft = detail.get("full_text") or ""
        print(
            f"  - {sid} | {detail.get('title')!r} | status={s.get('status')} | "
            f"embedded={detail.get('embedded')} | chunks={detail.get('embedded_chunks')} | "
            f"full_text={len(ft):,} chars"
        )
        if ft:
            toc_snippet += f"[Opening / TOC of {detail.get('title')}]\n{ft[:8000]}\n\n"

    questions = [
        "Which hypothesis testing methods and statistical tests does this book cover?",
        "How does the book explain p-value approach vs critical value approach in hypothesis testing?",
    ]

    for q in questions:
        print("\n" + "=" * 72)
        print(f"QUERY: {q}")
        t0 = time.time()
        res = post_json(
            f"{API_BASE}/search",
            {
                "query": q,
                "type": "vector",
                "limit": 20,
                "search_sources": True,
                "search_notes": True,
                "minimum_score": 0.2,
                "scope_notebook_ids": [nb_id],
            },
        )
        dt_ms = (time.time() - t0) * 1000
        results = res.get("results") or []
        print(f"Vector search returned {len(results)} chunks in {dt_ms:.0f} ms")
        for idx, item in enumerate(results[:5], 1):
            sim = item.get("similarity", 0)
            txt = _item_text(item).replace("\n", " ")[:140]
            print(f"  #{idx} [sim={sim:.3f}] ({item.get('title', '')[:35]}) {txt}...")

        # Build Hybrid RAG context: Opening TOC (~8k chars) + Top 20 vector chunks (~8k chars)
        rag_chunks = "\n\n".join(
            f"[Chunk #{i} | source={item.get('title', '')} | similarity={item.get('similarity', 0):.3f}]\n"
            f"{_item_text(item)}"
            for i, item in enumerate(results, 1)
        )
        hybrid_context = f"{toc_snippet}TOP VECTOR-RETRIEVED PASSAGES:\n---\n{rag_chunks}\n---"
        print(f"Hybrid context size: {len(hybrid_context):,} chars (~{len(hybrid_context)//4:,} tokens)")

        # Verify LLM answer quality & latency via local bridge
        t_llm = time.time()
        llm_res = post_json(
            BRIDGE_CHAT_URL,
            {
                "model": "gpt-6-luna",
                "reasoning_effort": "none",
                "stream": False,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "Answer the user's question accurately using ONLY the textbook TOC "
                            "and retrieved passages below. List specific chapter numbers and test names."
                            f"\n\n{hybrid_context}"
                        ),
                    },
                    {"role": "user", "content": q},
                ],
            },
            timeout=60,
        )
        answer = (llm_res["choices"][0]["message"]["content"] or "").strip()
        print(f"LLM answer ({time.time() - t_llm:.2f}s):\n{answer[:900]}")


if __name__ == "__main__":
    main()
