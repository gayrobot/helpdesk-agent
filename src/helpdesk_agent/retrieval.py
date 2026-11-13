"""Retrieval over the synthetic runbooks (Phase 4).

Runbooks are Markdown files chunked by ``##`` heading. Three retrievers share one
interface so the retrieval eval can compare them with numbers:

- ``BM25Retriever``: keyword baseline, no dependencies.
- ``EmbeddingRetriever``: cosine similarity over vectors from any ``Embedder``. The
  local ONNX embedder (fastembed) is an optional extra, local only; see
  ``docs/dependency-reviews/fastembed.md``.
- ``HybridRetriever``: reciprocal rank fusion of any retrievers.

Runbook text is untrusted data. One runbook carries a planted injection on purpose.
"""

from __future__ import annotations

import hashlib
import math
import os
import re
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache
from importlib import resources
from pathlib import Path
from typing import Protocol

TOP_K = 3

STOPWORDS = frozenset(
    {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "but",
        "by",
        "can",
        "do",
        "does",
        "for",
        "from",
        "has",
        "have",
        "how",
        "i",
        "if",
        "in",
        "is",
        "it",
        "its",
        "me",
        "my",
        "no",
        "not",
        "of",
        "on",
        "or",
        "our",
        "so",
        "that",
        "the",
        "their",
        "them",
        "then",
        "there",
        "they",
        "this",
        "to",
        "too",
        "up",
        "us",
        "was",
        "we",
        "what",
        "when",
        "where",
        "which",
        "who",
        "why",
        "will",
        "with",
        "you",
        "your",
        "i'm",
        "i've",
        "can't",
        "don't",
    }
)


@dataclass(frozen=True)
class Chunk:
    id: str  # "<runbook>#<section-slug>"
    runbook: str  # file stem, e.g. "vpn-setup"
    title: str
    section: str
    text: str

    @property
    def search_text(self) -> str:
        return f"{self.title}\n{self.section}\n{self.text}"


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def chunk_markdown(runbook: str, markdown: str) -> list[Chunk]:
    title = runbook
    section = "Overview"
    body: list[str] = []
    chunks: list[Chunk] = []

    def flush() -> None:
        text = "\n".join(body).strip()
        if text:
            chunks.append(Chunk(f"{runbook}#{_slug(section)}", runbook, title, section, text))

    for line in markdown.splitlines():
        if line.startswith("# ") and not chunks and not "".join(body).strip():
            title = line[2:].strip()
        elif line.startswith("## "):
            flush()
            section, body = line[3:].strip(), []
        else:
            body.append(line)
    flush()
    return chunks


def load_runbooks(path: Path | None = None) -> list[Chunk]:
    """All chunks, in a stable order (sorted by file name, then position)."""
    if path is None:
        root = resources.files("helpdesk_agent").joinpath("data/runbooks")
        files = sorted((f for f in root.iterdir() if f.name.endswith(".md")), key=lambda f: f.name)
        sources = [(f.name[:-3], f.read_text(encoding="utf-8")) for f in files]
    else:
        sources = [(p.stem, p.read_text(encoding="utf-8")) for p in sorted(path.glob("*.md"))]
    chunks: list[Chunk] = []
    for runbook, text in sources:
        chunks.extend(chunk_markdown(runbook, text))
    return chunks


def tokenize(text: str) -> list[str]:
    tokens = []
    for tok in re.findall(r"[a-z0-9]+(?:'[a-z]+)?", text.lower()):
        if tok in STOPWORDS:
            continue
        # Light plural folding: "groups" -> "group"; "access" is left alone.
        if len(tok) > 3 and tok.endswith("s") and not tok.endswith("ss"):
            tok = tok[:-1]
        tokens.append(tok)
    return tokens


class Retriever(Protocol):
    name: str

    def search(self, query: str, k: int = TOP_K) -> list[tuple[Chunk, float]]: ...


class BM25Retriever:
    name = "bm25"

    def __init__(self, chunks: Sequence[Chunk], k1: float = 1.5, b: float = 0.75) -> None:
        self.chunks = list(chunks)
        self.k1, self.b = k1, b
        self.docs = [Counter(tokenize(c.search_text)) for c in self.chunks]
        self.lengths = [sum(d.values()) for d in self.docs]
        self.avg_len = sum(self.lengths) / max(len(self.lengths), 1)
        df: Counter[str] = Counter()
        for doc in self.docs:
            df.update(doc.keys())
        n = len(self.docs)
        self.idf = {t: math.log(1 + (n - f + 0.5) / (f + 0.5)) for t, f in df.items()}

    def search(self, query: str, k: int = TOP_K) -> list[tuple[Chunk, float]]:
        terms = tokenize(query)
        scored = []
        for chunk, doc, length in zip(self.chunks, self.docs, self.lengths, strict=True):
            score = 0.0
            for term in terms:
                tf = doc.get(term, 0)
                if not tf:
                    continue
                norm = (
                    tf
                    * (self.k1 + 1)
                    / (tf + self.k1 * (1 - self.b + self.b * length / self.avg_len))
                )
                score += self.idf[term] * norm
            if score > 0:
                scored.append((chunk, score))
        scored.sort(key=lambda pair: (-pair[1], pair[0].id))
        return scored[:k]


class Embedder(Protocol):
    def embed(self, texts: Sequence[str]) -> list[list[float]]: ...


def _cosine(a: Sequence[float], b: Sequence[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


class EmbeddingRetriever:
    name = "embeddings"

    def __init__(self, chunks: Sequence[Chunk], embedder: Embedder) -> None:
        self.chunks = list(chunks)
        self.embedder = embedder
        self.vectors = embedder.embed([c.search_text for c in self.chunks])

    def search(self, query: str, k: int = TOP_K) -> list[tuple[Chunk, float]]:
        q = self.embedder.embed([query])[0]
        scored = [(c, _cosine(q, v)) for c, v in zip(self.chunks, self.vectors, strict=True)]
        scored.sort(key=lambda pair: (-pair[1], pair[0].id))
        return scored[:k]


class HybridRetriever:
    """Reciprocal rank fusion: score = sum over retrievers of 1 / (rrf_k + rank)."""

    name = "hybrid"

    def __init__(self, retrievers: Sequence[Retriever], rrf_k: int = 60, depth: int = 20) -> None:
        self.retrievers = list(retrievers)
        self.rrf_k, self.depth = rrf_k, depth

    def search(self, query: str, k: int = TOP_K) -> list[tuple[Chunk, float]]:
        scores: dict[str, float] = {}
        by_id: dict[str, Chunk] = {}
        for retriever in self.retrievers:
            for rank, (chunk, _) in enumerate(retriever.search(query, self.depth), start=1):
                scores[chunk.id] = scores.get(chunk.id, 0.0) + 1 / (self.rrf_k + rank)
                by_id[chunk.id] = chunk
        ranked = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))
        return [(by_id[cid], score) for cid, score in ranked[:k]]


class ModelIntegrityError(RuntimeError):
    """A downloaded model file doesn't match its pinned hash."""


# The embedding model is pinned to one Hugging Face commit, and every file is checked
# against the SHA-256 recorded here. fastembed on its own would download whatever the
# repo's latest revision is, outside uv.lock. Hashes recorded 2026-11-13; the ONNX hash
# matches the one Hugging Face publishes for the LFS object. These are public file
# hashes, not secrets: gitleaks flags the "token" file names, hence the inline allows.
MODEL_NAME = "BAAI/bge-small-en-v1.5"
MODEL_REPO = "Qdrant/bge-small-en-v1.5-onnx-Q"
MODEL_REVISION = "aa8f8b060edb00e03bfdd08813a2949946c8ba55"
MODEL_FILES = {
    "config.json": "13582bcf2effc85b7bf3d3f5532e686bc1c9ce86bb009d10f0ec33cbe92299dd",
    "model_optimized.onnx": "51f1bd0addd6e859e42c2c8021a5e5461385bb676a649f4b269aa445449f2431",
    "ort_config.json": "99881c45e073696289224931dd48694398bc6bcd1fe7cb7018bca1e0cc00e1fc",
    "special_tokens_map.json": "5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a",  # gitleaks:allow  # noqa: E501
    "tokenizer.json": "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",  # gitleaks:allow  # noqa: E501
    "tokenizer_config.json": "0b29c7bfc889e53b36d9dd3e686dd4300f6525110eaa98c76a5dafceb2029f53",  # gitleaks:allow  # noqa: E501
    "vocab.txt": "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3",
}
MODEL_CACHE = Path(".cache/fastembed")


def verify_model_dir(path: Path, expected: dict[str, str] = MODEL_FILES) -> None:
    """Raise ``ModelIntegrityError`` unless every pinned file is present and matches."""
    for name, digest in expected.items():
        file = path / name
        if not file.is_file():
            raise ModelIntegrityError(f"missing model file {name}")
        actual = hashlib.sha256(file.read_bytes()).hexdigest()
        if actual != digest:
            raise ModelIntegrityError(f"{name} hash {actual[:12]}… doesn't match the pin")


class FastEmbedEmbedder:
    """Local ONNX embeddings via fastembed (optional extra: ``uv sync --extra embeddings``).

    Downloads the pinned model revision once into ``.cache/fastembed`` (gitignored),
    checks every file's hash, then loads fastembed from that folder so it makes no
    download of its own. Imported lazily so nothing else in the project needs it.
    """

    def __init__(self, cache_dir: Path = MODEL_CACHE) -> None:
        os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
        from fastembed import TextEmbedding  # type: ignore[import-not-found]
        from huggingface_hub import snapshot_download  # type: ignore[import-not-found]

        model_dir = Path(
            snapshot_download(
                MODEL_REPO,
                revision=MODEL_REVISION,
                cache_dir=str(cache_dir),
                allow_patterns=sorted(MODEL_FILES),
            )
        )
        verify_model_dir(model_dir)
        self.model = TextEmbedding(
            model_name=MODEL_NAME, specific_model_path=str(model_dir), cache_dir=str(cache_dir)
        )

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [list(map(float, v)) for v in self.model.embed(list(texts))]


RETRIEVER_ENV = "HELPDESK_RETRIEVER"  # "auto" (default) or "bm25"


@lru_cache(maxsize=1)
def default_retriever() -> Retriever:
    """The retriever behind the ``search_runbooks`` tool.

    Hybrid (BM25 + local embeddings) when the ``embeddings`` extra is installed, since it
    beat BM25 on the retrieval eval; BM25 otherwise, or when ``HELPDESK_RETRIEVER=bm25``.
    Only a missing package falls back. A failed download or hash check raises, and the
    gate turns that into a tool error.
    """
    chunks = load_runbooks()
    bm25 = BM25Retriever(chunks)
    if os.environ.get(RETRIEVER_ENV, "auto") == "bm25":
        return bm25
    try:
        embedder = FastEmbedEmbedder()
    except ImportError:
        return bm25
    return HybridRetriever([bm25, EmbeddingRetriever(chunks, embedder)])
