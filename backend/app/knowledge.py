"""Knowledge base loading and retrieval (the 'R' in RAG).

Uses TF-IDF (word + character n-grams) with cosine similarity. It is small,
fast, deterministic and needs no GPU or API key. The `Retriever` interface is
deliberately tiny so it can be swapped for FAISS / Azure AI Search /
OpenSearch vector retrieval without touching the agent graph.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.pipeline import FeatureUnion


@dataclass(frozen=True)
class FAQ:
    id: str
    category: str
    question: str
    answer: str
    tags: tuple[str, ...]

    @property
    def document(self) -> str:
        # Question and tags are weighted by repetition: they carry the intent.
        tags = " ".join(self.tags)
        return f"{self.question} {self.question} {tags} {tags} {self.answer}"


@dataclass(frozen=True)
class Hit:
    faq: FAQ
    score: float

    def as_source(self) -> dict:
        return {
            "id": self.faq.id,
            "category": self.faq.category,
            "question": self.faq.question,
            "score": round(self.score, 3),
        }


class KnowledgeBase:
    def __init__(self, path: Path):
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
        self.bank_name: str = raw["bank_name"]
        self.support: dict = raw["support"]
        self.disclaimer: str = raw["disclaimer"]
        self.faqs: list[FAQ] = [
            FAQ(f["id"], f["category"], f["question"], f["answer"], tuple(f["tags"]))
            for f in raw["faqs"]
        ]
        self.by_id = {f.id: f for f in self.faqs}


class Retriever:
    def __init__(self, kb: KnowledgeBase):
        self.kb = kb
        self.vectorizer = FeatureUnion(
            [
                ("word", TfidfVectorizer(ngram_range=(1, 2), stop_words="english", sublinear_tf=True)),
                ("char", TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), sublinear_tf=True)),
            ]
        )
        self.matrix = self.vectorizer.fit_transform([f.document for f in kb.faqs])
        norms = np.sqrt(self.matrix.multiply(self.matrix).sum(axis=1)).A1
        self._norms = np.where(norms == 0, 1, norms)

    def search(self, query: str, k: int = 3) -> list[Hit]:
        q = self.vectorizer.transform([query])
        q_norm = np.sqrt(q.multiply(q).sum()) or 1.0
        sims = (self.matrix @ q.T).toarray().ravel() / (self._norms * q_norm)
        order = np.argsort(-sims)[:k]
        return [Hit(self.kb.faqs[i], float(sims[i])) for i in order if sims[i] > 0]
