"""FastAPI entry point for rag-query service."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Response

from . import config
from .artifact_loader import is_ready, load_artifact
from .models import QueryRequest, QueryResponse, SearchResult, StatsResponse, ContextMessage
from .query_engine import (
    close_client,
    ensure_collection,
    get_stats,
    init_client,
    search_messages,
)

logging.basicConfig(
    level=getattr(logging, config.LOG_LEVEL.upper(), logging.INFO),
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger("rag-query")

_artifact_version: str | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _artifact_version

    # Startup: load artifact + init Qdrant client
    logger.info("Starting rag-query service...")
    try:
        load_artifact()
        _artifact_version = config.RAG_ARTIFACT_VERSION
        init_client()
        ensure_collection()
        logger.info("Service ready — collection verified")
    except Exception:
        logger.exception("Startup failed — service will not be ready")

    yield

    # Shutdown
    logger.info("Shutting down...")
    close_client()


app = FastAPI(title="rag-query", lifespan=lifespan)


@app.get("/healthz")
async def healthz():
    return Response(content="ok", media_type="text/plain")


@app.get("/readyz")
async def readyz():
    if not is_ready():
        return Response(content="not ready", status_code=503, media_type="text/plain")

    # Verify Qdrant collection is accessible
    try:
        from .query_engine import get_client, COLLECTION_NAME

        client = get_client()
        if not client.collection_exists(COLLECTION_NAME):
            return Response(
                content="collection not found",
                status_code=503,
                media_type="text/plain",
            )
    except Exception:
        return Response(
            content="qdrant unavailable", status_code=503, media_type="text/plain"
        )

    return Response(content="ready", media_type="text/plain")


@app.post("/query", response_model=QueryResponse)
async def query(req: QueryRequest):
    if not is_ready():
        return QueryResponse(ok=False, query=req.query)

    results = search_messages(
        query=req.query,
        limit=req.limit,
        channel=req.channel,
        user=req.user,
        start_date=req.start_date,
        end_date=req.end_date,
        include_thread_context=req.include_thread_context,
    )

    search_results = []
    for r in results:
        context_msgs = [ContextMessage(**c) for c in r.get("context", [])]
        thread_msgs = [ContextMessage(**t) for t in r.get("thread_preview", [])]
        search_results.append(
            SearchResult(
                score=r["score"],
                channel=r.get("channel"),
                date=r.get("date"),
                ts=r.get("ts"),
                thread_ts=r.get("thread_ts"),
                user_name=r.get("user_name"),
                text=r.get("text"),
                permalink=r.get("permalink"),
                context=context_msgs,
                thread_preview=thread_msgs,
            )
        )

    return QueryResponse(
        ok=True,
        results=search_results,
        count=len(search_results),
        query=req.query,
    )


@app.get("/stats", response_model=StatsResponse)
async def stats():
    if not is_ready():
        return StatsResponse(ok=False)

    raw = get_stats()
    return StatsResponse(
        ok=True,
        collection=raw.get("collection", ""),
        embedding_model=raw.get("embedding_model", ""),
        indexed_files=raw.get("indexed_files", 0),
        indexed_messages=raw.get("indexed_messages", 0),
        indexed_channels=raw.get("indexed_channels", 0),
        last_indexed=raw.get("last_indexed"),
        qdrant_points=raw.get("qdrant_points", 0),
        artifact_version=_artifact_version,
    )
