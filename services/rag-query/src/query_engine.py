"""
Query-only fork of slack_librarian_engine.py.
Semantic search over pre-built Qdrant + SQLite index.
"""

import os
import re
import sqlite3
from datetime import date, datetime
from typing import Any, Optional

import ollama
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    FieldCondition,
    Filter,
    MatchValue,
    Range,
    VectorParams,
)

from . import config

COLLECTION_NAME = config.COLLECTION_NAME

EMBEDDING_MODEL = config.EMBEDDING_MODEL
EMBEDDING_DIM = config.EMBEDDING_DIM
MAX_EMBED_CHARS = config.MAX_EMBED_CHARS

TOKEN_RE = re.compile(r"[a-z0-9#@._-]+")

# Persistent client — initialized at startup, stays open
_client: QdrantClient | None = None


def init_client() -> QdrantClient:
    """Initialize persistent Qdrant client. Called once at startup."""
    global _client
    if _client is not None:
        return _client
    _client = QdrantClient(path=str(config.QDRANT_PATH), prefer_grpc=False)
    return _client


def get_client() -> QdrantClient:
    """Get the persistent Qdrant client."""
    if _client is None:
        raise RuntimeError("Qdrant client not initialized — call init_client() first")
    return _client


def close_client() -> None:
    """Close the Qdrant client on shutdown."""
    global _client
    if _client is not None:
        try:
            _client.close()
        except Exception:
            pass
        _client = None


def ensure_collection() -> QdrantClient:
    """Verify the collection exists (read-only — creates only if missing)."""
    client = get_client()
    if not client.collection_exists(COLLECTION_NAME):
        client.create_collection(
            collection_name=COLLECTION_NAME,
            vectors_config=VectorParams(size=EMBEDDING_DIM, distance=Distance.COSINE),
        )
    return client


def get_embedding(text: str) -> list[float]:
    """Get embedding vector from Ollama sidecar."""
    if len(text) > MAX_EMBED_CHARS:
        text = text[:MAX_EMBED_CHARS]
    host = os.getenv("OLLAMA_HOST", "http://localhost:11434")
    client = ollama.Client(host=host)
    response = client.embeddings(model=EMBEDDING_MODEL, prompt=text)
    return response["embedding"]


def _keyword_terms(query: str) -> set[str]:
    return set(TOKEN_RE.findall(query.lower()))


def _keyword_overlap(query_terms: set[str], text: str) -> float:
    if not query_terms:
        return 0.0
    text_terms = set(TOKEN_RE.findall(text.lower()))
    if not text_terms:
        return 0.0
    overlap = len(query_terms.intersection(text_terms))
    return overlap / len(query_terms)


def _recency_boost(date_str: str) -> float:
    try:
        msg_date = datetime.strptime(date_str, "%Y-%m-%d").date()
        age_days = (date.today() - msg_date).days
        clamped = max(0, min(age_days, 3650))
        return 1.0 - (clamped / 3650.0)
    except Exception:
        return 0.0


def _date_to_unix(value: str, end_of_day: bool = False) -> float:
    suffix = "T23:59:59+00:00" if end_of_day else "T00:00:00+00:00"
    return datetime.fromisoformat(value + suffix).timestamp()


def _get_source_window(
    source_file: str, message_index: int, before: int = 1, after: int = 2
) -> list[dict]:
    client = get_client()
    points: list[Any] = []
    offset = None

    while True:
        batch, offset = client.scroll(
            collection_name=COLLECTION_NAME,
            scroll_filter=Filter(
                must=[
                    FieldCondition(
                        key="source_file", match=MatchValue(value=source_file)
                    )
                ]
            ),
            limit=500,
            offset=offset,
            with_payload=[
                "message_index",
                "text",
                "user_name",
                "ts",
                "date",
                "channel",
            ],
            with_vectors=False,
        )
        if not batch:
            break
        points.extend(batch)
        if offset is None:
            break

    if not points:
        return []

    ordered = sorted(
        points, key=lambda point: point.payload.get("message_index", 0)
    )
    current_pos = None
    for pos, point in enumerate(ordered):
        if point.payload.get("message_index") == message_index:
            current_pos = pos
            break

    if current_pos is None:
        return []

    start = max(0, current_pos - before)
    end = min(len(ordered), current_pos + after + 1)
    results: list[dict] = []
    for point in ordered[start:end]:
        payload = point.payload
        results.append(
            {
                "channel": payload.get("channel"),
                "date": payload.get("date"),
                "ts": payload.get("ts"),
                "user_name": payload.get("user_name"),
                "text": payload.get("text"),
            }
        )
    return results


def get_thread_messages(
    channel: str, thread_ts: str, limit: int = 200
) -> list[dict]:
    client = get_client()
    cap = max(1, min(limit, 1000))
    offset = None
    points: list[Any] = []

    while len(points) < cap:
        batch, offset = client.scroll(
            collection_name=COLLECTION_NAME,
            scroll_filter=Filter(
                must=[
                    FieldCondition(
                        key="channel_lower",
                        match=MatchValue(value=channel.lower()),
                    ),
                    FieldCondition(
                        key="thread_ts",
                        match=MatchValue(value=str(thread_ts)),
                    ),
                ]
            ),
            limit=min(300, cap - len(points)),
            offset=offset,
            with_payload=[
                "channel",
                "date",
                "ts",
                "ts_float",
                "user_name",
                "text",
                "is_reply",
                "source_file",
                "message_index",
                "permalink",
            ],
            with_vectors=False,
        )
        if not batch:
            break
        points.extend(batch)
        if offset is None:
            break

    ordered = sorted(
        points, key=lambda point: point.payload.get("ts_float", 0)
    )
    return [dict(point.payload) for point in ordered]


def search_messages(
    query: str,
    limit: int = 15,
    channel: Optional[str] = None,
    user: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    include_thread_context: bool = True,
) -> list[dict]:
    client = get_client()
    limit = max(1, min(limit, 100))

    conditions: list[FieldCondition] = []
    if channel:
        conditions.append(
            FieldCondition(
                key="channel_lower",
                match=MatchValue(value=channel.lower()),
            )
        )
    if user:
        conditions.append(
            FieldCondition(
                key="user_name_lower",
                match=MatchValue(value=user.lower()),
            )
        )
    if start_date or end_date:
        range_kwargs: dict[str, float] = {}
        if start_date:
            range_kwargs["gte"] = _date_to_unix(start_date, end_of_day=False)
        if end_date:
            range_kwargs["lte"] = _date_to_unix(end_date, end_of_day=True)
        conditions.append(
            FieldCondition(key="ts_float", range=Range(**range_kwargs))
        )

    query_filter = Filter(must=conditions) if conditions else None
    query_vector = get_embedding(query)

    raw_results = client.query_points(
        collection_name=COLLECTION_NAME,
        query=query_vector,
        query_filter=query_filter,
        limit=max(40, limit * 8),
    ).points

    query_terms = _keyword_terms(query)
    rescored: list[dict] = []

    for hit in raw_results:
        payload = hit.payload
        lexical = _keyword_overlap(query_terms, payload.get("text", ""))
        recency = _recency_boost(payload.get("date", ""))
        score = float(hit.score) + (0.20 * lexical) + (0.05 * recency)

        rescored.append(
            {
                "score": score,
                "vector_score": float(hit.score),
                "channel": payload.get("channel"),
                "date": payload.get("date"),
                "ts": payload.get("ts"),
                "thread_ts": payload.get("thread_ts"),
                "user_id": payload.get("user_id"),
                "user_name": payload.get("user_name"),
                "text": payload.get("text"),
                "source_file": payload.get("source_file"),
                "message_index": payload.get("message_index"),
                "permalink": payload.get("permalink"),
            }
        )

    rescored.sort(key=lambda result: result["score"], reverse=True)
    top = rescored[:limit]

    for item in top:
        item["context"] = _get_source_window(
            source_file=item["source_file"],
            message_index=item["message_index"],
            before=1,
            after=2,
        )
        if include_thread_context:
            item["thread_preview"] = get_thread_messages(
                channel=item["channel"],
                thread_ts=item["thread_ts"],
                limit=12,
            )
        else:
            item["thread_preview"] = []

    return top


def list_indexed_channels(
    limit: int = 100, name_contains: Optional[str] = None
) -> list[dict]:
    conn = sqlite3.connect(config.STATE_DB_PATH)
    cursor = conn.cursor()

    if name_contains:
        cursor.execute(
            """
            SELECT channel, COUNT(*) AS file_count, SUM(message_count) AS message_count, MAX(indexed_at) AS last_indexed
            FROM indexed_files
            WHERE LOWER(channel) LIKE ?
            GROUP BY channel
            ORDER BY message_count DESC
            LIMIT ?
            """,
            (f"%{name_contains.lower()}%", limit),
        )
    else:
        cursor.execute(
            """
            SELECT channel, COUNT(*) AS file_count, SUM(message_count) AS message_count, MAX(indexed_at) AS last_indexed
            FROM indexed_files
            GROUP BY channel
            ORDER BY message_count DESC
            LIMIT ?
            """,
            (limit,),
        )

    rows = cursor.fetchall()
    conn.close()

    return [
        {
            "channel": row[0],
            "file_count": row[1],
            "message_count": row[2] or 0,
            "last_indexed": row[3],
        }
        for row in rows
    ]


def get_stats() -> dict:
    conn = sqlite3.connect(config.STATE_DB_PATH)
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT
            COUNT(*) AS indexed_files,
            COALESCE(SUM(message_count), 0) AS indexed_messages,
            COUNT(DISTINCT channel) AS indexed_channels,
            MAX(indexed_at) AS last_indexed
        FROM indexed_files
        """
    )
    row = cursor.fetchone()
    conn.close()

    qdrant_count = 0
    try:
        client = get_client()
        qdrant_count = int(
            client.count(collection_name=COLLECTION_NAME, exact=True).count
        )
    except Exception:
        qdrant_count = 0

    return {
        "db_root": str(config.RAG_INDEX_DIR),
        "collection": COLLECTION_NAME,
        "embedding_model": EMBEDDING_MODEL,
        "indexed_files": int(row[0] or 0),
        "indexed_messages": int(row[1] or 0),
        "indexed_channels": int(row[2] or 0),
        "last_indexed": row[3],
        "qdrant_points": qdrant_count,
    }
