"""Runtime configuration, read from environment variables."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _list(value: str) -> list[str]:
    return [v.strip() for v in value.split(",") if v.strip()]


@dataclass(frozen=True)
class Settings:
    # Knowledge base shared with the web UI (single source of truth).
    kb_path: Path = Path(os.getenv("KB_PATH", ROOT / "web" / "data" / "faqs.json"))

    # Optional LLM. Any OpenAI-compatible endpoint works: OpenAI, Azure OpenAI
    # (via its /openai/v1 endpoint), Groq, Together, Ollama, vLLM, etc.
    # Leave LLM_API_KEY empty to run fully offline with grounded extractive answers.
    llm_api_key: str = os.getenv("LLM_API_KEY", "")
    llm_base_url: str = os.getenv("LLM_BASE_URL", "https://api.openai.com/v1")
    llm_model: str = os.getenv("LLM_MODEL", "gpt-4o-mini")
    llm_timeout: float = float(os.getenv("LLM_TIMEOUT", "20"))

    # Retrieval
    top_k: int = int(os.getenv("TOP_K", "3"))
    min_score: float = float(os.getenv("MIN_SCORE", "0.12"))

    cors_origins: list[str] = field(
        default_factory=lambda: _list(os.getenv("CORS_ORIGINS", "*"))
    )

    @property
    def llm_enabled(self) -> bool:
        return bool(self.llm_api_key)


settings = Settings()
