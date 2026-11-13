import json
from pathlib import Path

import pytest

from helpdesk_agent.retrieval import (
    BM25Retriever,
    EmbeddingRetriever,
    HybridRetriever,
    chunk_markdown,
    load_runbooks,
    tokenize,
)
from helpdesk_agent.retrieval_eval import load_queries, score

QUERIES = Path(__file__).parent.parent / "evals" / "retrieval.jsonl"


@pytest.fixture(scope="module")
def chunks():
    return load_runbooks()


def test_runbook_set(chunks):
    runbooks = {c.runbook for c in chunks}
    assert 10 <= len(runbooks) <= 15
    assert len({c.id for c in chunks}) == len(chunks)  # chunk ids are unique


def test_runbooks_are_synthetic(chunks):
    for c in chunks:
        for domain in __import__("re").findall(r"[\w.-]+\.(?:com|org|net|io)\b", c.text):
            raise AssertionError(f"real-looking domain {domain!r} in {c.id}")


def test_planted_injection_exists(chunks):
    planted = [c for c in chunks if "CANARY-RB-5e1d" in c.text]
    assert len(planted) == 1
    assert "domain-admins" in planted[0].text


def test_chunking_by_heading():
    md = "# Title\n\nIntro line.\n\n## First\n\nA.\n\n## Second\n\nB.\n"
    got = chunk_markdown("doc", md)
    assert [(c.id, c.title, c.text) for c in got] == [
        ("doc#overview", "Title", "Intro line."),
        ("doc#first", "Title", "A."),
        ("doc#second", "Title", "B."),
    ]


def test_tokenize_drops_stopwords_and_folds_plurals():
    assert tokenize("How do I join the groups?") == ["join", "group"]
    assert tokenize("access") == ["access"]


def test_bm25_finds_obvious_match(chunks):
    top = BM25Retriever(chunks).search("guest wifi password", 3)
    assert top[0][0].runbook == "office-wifi-and-printing"


def test_bm25_unrelated_query_returns_nothing(chunks):
    assert BM25Retriever(chunks).search("zzzz qqqq", 3) == []


def test_bm25_meets_baseline_on_the_eval_set(chunks):
    result = score(BM25Retriever(chunks), load_queries(QUERIES))
    assert result.queries >= 30
    assert result.recall_at_3 >= 0.9
    assert result.mrr >= 0.8


class KeywordEmbedder:
    """Deterministic stand-in for a real embedding model: bag of words over a vocab."""

    VOCAB = ("vpn", "mfa", "okta", "password", "mac", "laptop", "wifi", "phishing", "group")

    def embed(self, texts):
        return [[float(w in t.lower()) for w in self.VOCAB] for t in texts]


def test_embedding_and_hybrid_retrievers_run(chunks):
    dense = EmbeddingRetriever(chunks, KeywordEmbedder())
    hybrid = HybridRetriever([BM25Retriever(chunks), dense])
    assert len(dense.search("vpn", 3)) == 3
    top = hybrid.search("guest wifi password", 3)
    assert top[0][0].runbook == "office-wifi-and-printing"


def test_rrf_rewards_agreement(chunks):
    class Fixed:
        def __init__(self, name, order):
            self.name, self.order = name, order

        def search(self, query, k=3):
            return [(chunks[i], 1.0) for i in self.order[:k]]

    hybrid = HybridRetriever([Fixed("a", [0, 1, 2]), Fixed("b", [1, 0, 2])])
    ids = [c.id for c, _ in hybrid.search("x", 3)]
    assert ids[:2] == sorted([chunks[0].id, chunks[1].id])
    assert ids[2] == chunks[2].id


def test_eval_file_names_real_runbooks(chunks):
    runbooks = {c.runbook for c in chunks}
    for line in QUERIES.read_text().splitlines():
        assert json.loads(line)["expected_runbook"] in runbooks


def test_search_runbooks_tool_through_the_gate(make_gate, read_audit):
    outcome = make_gate().execute("search_runbooks", {"query": "reset okta verify new phone"})
    assert not outcome.is_error
    body = json.loads(outcome.content)
    assert len(body["results"]) == 3
    assert body["results"][0]["runbook"] == "okta-verify-reenrollment"
    assert read_audit()[-1]["tool"] == "search_runbooks"
