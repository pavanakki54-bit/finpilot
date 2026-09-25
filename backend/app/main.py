"""FastAPI service exposing the FinPilot support agent."""
from __future__ import annotations

import logging
import uuid
from collections import Counter
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import agent
from .config import ROOT, settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("finpilot")

app = FastAPI(
    title="FinPilot Support Agent API",
    version="1.0.0",
    description="Agentic RAG customer-support chatbot for a (fictional) retail bank.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

METRICS: Counter = Counter()


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=2000)
    session_id: str | None = Field(None, max_length=64)


class Feedback(BaseModel):
    session_id: str | None = None
    message_id: str | None = None
    helpful: bool
    comment: str | None = Field(None, max_length=500)


@app.get("/api/health")
def health() -> dict:
    return {
        "status": "ok",
        "faqs": len(agent.KB.faqs),
        "llm": settings.llm_model if settings.llm_enabled else None,
    }


@app.post("/api/chat")
def chat(req: ChatRequest) -> dict:
    session_id = req.session_id or uuid.uuid4().hex
    result = agent.chat(req.message, session_id)
    METRICS["messages"] += 1
    METRICS[f"intent:{result['intent']}"] += 1
    for flag in result["guardrails"]:
        METRICS[f"guardrail:{flag}"] += 1
    # Only the redacted text is ever logged.
    log.info("session=%s intent=%s conf=%.2f latency=%sms", session_id[:8], result["intent"],
             result["confidence"], result["latency_ms"])
    return {"session_id": session_id, **result}


@app.get("/api/faqs")
def faqs() -> dict:
    return {
        "bank_name": agent.KB.bank_name,
        "categories": sorted({f.category for f in agent.KB.faqs}),
        "starters": agent.STARTERS,
    }


@app.post("/api/feedback")
def feedback(fb: Feedback) -> dict:
    METRICS["feedback:up" if fb.helpful else "feedback:down"] += 1
    return {"ok": True}


@app.get("/api/metrics")
def metrics() -> dict:
    return dict(METRICS)


# Serve the web UI from the same container (handy for Render / Docker).
WEB = Path(ROOT / "web")
if WEB.exists():
    app.mount("/assets", StaticFiles(directory=WEB / "assets"), name="assets")
    app.mount("/data", StaticFiles(directory=WEB / "data"), name="data")

    @app.get("/", include_in_schema=False)
    def index() -> FileResponse:
        return FileResponse(WEB / "index.html")
