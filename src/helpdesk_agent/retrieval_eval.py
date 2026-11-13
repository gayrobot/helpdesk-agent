"""Retrieval eval: recall@3 and MRR per retriever, key-free.

Each line of ``evals/retrieval.jsonl`` is a how-to question and the runbook that should
answer it. A hit is any returned chunk from that runbook.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from helpdesk_agent.retrieval import TOP_K, Retriever

DEFAULT_QUERIES = Path("evals/retrieval.jsonl")
MRR_DEPTH = 10


@dataclass(frozen=True)
class RetrievalScore:
    retriever: str
    queries: int
    recall_at_3: float
    mrr: float
    misses: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "retriever": self.retriever,
            "queries": self.queries,
            "recall@3": round(self.recall_at_3, 4),
            "mrr": round(self.mrr, 4),
            "misses": self.misses,
        }


def load_queries(path: Path = DEFAULT_QUERIES) -> list[dict[str, str]]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def score(retriever: Retriever, queries: Sequence[dict[str, str]]) -> RetrievalScore:
    hits, reciprocal, misses = 0, 0.0, []
    for q in queries:
        ranked = [chunk.runbook for chunk, _ in retriever.search(q["query"], MRR_DEPTH)]
        expected = q["expected_runbook"]
        if expected in ranked[:TOP_K]:
            hits += 1
        else:
            misses.append(q["id"])
        if expected in ranked:
            reciprocal += 1 / (ranked.index(expected) + 1)
    n = len(queries)
    return RetrievalScore(retriever.name, n, hits / n, reciprocal / n, misses)


def format_table(scores: Sequence[RetrievalScore]) -> str:
    lines = [f"{'retriever':<12} {'queries':>7} {'recall@3':>9} {'MRR':>6}"]
    for s in scores:
        lines.append(f"{s.retriever:<12} {s.queries:>7} {s.recall_at_3:>9.3f} {s.mrr:>6.3f}")
    return "\n".join(lines)
