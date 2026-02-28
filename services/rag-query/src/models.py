"""Pydantic request/response schemas for rag-query service."""

from typing import Optional

from pydantic import BaseModel, Field


class QueryRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=2000, description="Search query")
    limit: int = Field(default=10, ge=1, le=25, description="Max results to return")
    channel: Optional[str] = Field(default=None, description="Filter by channel name")
    user: Optional[str] = Field(default=None, description="Filter by user name")
    start_date: Optional[str] = Field(
        default=None, description="Start date filter (YYYY-MM-DD)"
    )
    end_date: Optional[str] = Field(
        default=None, description="End date filter (YYYY-MM-DD)"
    )
    include_thread_context: bool = Field(
        default=True, description="Include thread preview in results"
    )


class ContextMessage(BaseModel):
    channel: Optional[str] = None
    date: Optional[str] = None
    ts: Optional[str] = None
    user_name: Optional[str] = None
    text: Optional[str] = None


class SearchResult(BaseModel):
    score: float
    channel: Optional[str] = None
    date: Optional[str] = None
    ts: Optional[str] = None
    thread_ts: Optional[str] = None
    user_name: Optional[str] = None
    text: Optional[str] = None
    permalink: Optional[str] = None
    context: list[ContextMessage] = []
    thread_preview: list[ContextMessage] = []


class QueryResponse(BaseModel):
    ok: bool = True
    results: list[SearchResult] = []
    count: int = 0
    query: str = ""


class StatsResponse(BaseModel):
    ok: bool = True
    collection: str = ""
    embedding_model: str = ""
    indexed_files: int = 0
    indexed_messages: int = 0
    indexed_channels: int = 0
    last_indexed: Optional[str] = None
    qdrant_points: int = 0
    artifact_version: Optional[str] = None
