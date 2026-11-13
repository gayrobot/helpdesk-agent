# Dependency review: fastembed

Status: **not added.** Waiting on Skylar's decision (see "Options").

Phase 4 step 3 needs local embeddings so retrieval can be compared as BM25 vs embeddings vs hybrid. `fastembed` was the candidate in `docs/plan.md`. The code is ready for it: `retrieval.FastEmbedEmbedder` imports it lazily, and `helpdesk-agent eval-retrieval --embeddings` scores all three retrievers once it is installed.

## What it is

- Local text embeddings using ONNX models, from Qdrant (the vector database company). Apache-2.0.
- Default model for this project: `BAAI/bge-small-en-v1.5` (about 130 MB of ONNX weights, MIT licence).

## What it pulls in

Resolved on 2026-11-13 for Python 3.12 with the 7-day cooldown: `fastembed==0.9.1` plus **27 packages**:

anyio, certifi, charset-normalizer, click, filelock, flatbuffers, fsspec, h11, hf-xet, httpcore, httpx, huggingface-hub, idna, loguru, mmh3, numpy, onnxruntime, packaging, pillow, protobuf, py-rust-stemmers, pyyaml, requests, tokenizers, tqdm, typing-extensions, urllib3.

The heavy or risky ones:

- **onnxruntime**: large native binary (Microsoft). Runs the model.
- **huggingface-hub / hf-xet**: downloads model weights **at runtime** from Hugging Face. This is a second supply-chain path that `uv.lock` doesn't cover: the weights aren't hashed in the lockfile.
- **tokenizers, py-rust-stemmers, mmh3**: native extensions.
- **pillow**: image support we don't need (fastembed also supports image models).

Today the project has one runtime dependency (`anthropic`). This would multiply the installed surface many times over.

## Risks and mitigations if added

| Risk | Mitigation |
| --- | --- |
| Model weights fetched unpinned at runtime | Pin the model revision (commit hash) and check the file hash on first load. Keep a local cache directory under `.cache/` (gitignored). |
| CI needs network for weights | Only run embeddings locally. CI keeps the BM25 eval. |
| Big native wheels | Pin exact versions in an optional extra so the default install stays small. |
| Telemetry or network calls besides the model download | Set `HF_HUB_DISABLE_TELEMETRY=1` and `HF_HUB_OFFLINE=1` after the first download. |

## Options

1. **Optional extra, local only (recommended).** Add `fastembed==0.9.1` under `[project.optional-dependencies] embeddings`, pin the model revision, and run `eval-retrieval --embeddings` locally. CI stays BM25-only. Keep embeddings in the agent only if they beat BM25 on recall@3 and MRR (the plan's rule).
2. **Skip local embeddings.** BM25 scores recall@3 0.974 and MRR 0.891 on the 38-question set. The write-up can say embeddings weren't worth the dependencies at this size, and try Voyage later as the plan's optional hosted retriever.
3. **Full dependency with CI.** Cache the model in CI. This has the most surface and the least benefit for 14 runbooks.

Before adding it, also check how widely it's used and how actively it's maintained on its PyPI and GitHub pages (release cadence, open security advisories). That wasn't checked in this review.
