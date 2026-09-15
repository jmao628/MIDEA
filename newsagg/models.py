"""Data models for the collection layer.

Two shapes come out of step 1:

* ``RawItem`` — a single article / video / post carrying text that a human
  wrote an opinion in. This is what the step-2 LLM normalizer consumes.
* ``MentionEntry`` — a per-ticker social-mention count. This is *popularity
  raw material* only (from Ape Wisdom); it never becomes a seed on its own,
  it just gets joined onto seeds downstream.

Everything here is plain dataclasses so the collection layer has no hard
dependency on pydantic and stays trivially serializable to JSON.
"""

from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum


class Source(str, Enum):
    """Where a raw item came from."""

    SEEKING_ALPHA = "seekingalpha"
    SUBSTACK = "substack"
    SCHWAB_YOUTUBE = "schwab_youtube"
    APE_WISDOM = "apewisdom"


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


@dataclass(slots=True)
class RawItem:
    """One collected document, pre-normalization.

    ``body`` is the full text when we could get it (SeekingAlpha via login
    cookie, Substack by default, YouTube via transcript). When we could not,
    ``body`` is ``None`` and ``summary`` (RSS description / video description)
    is what the LLM has to work with.

    ``tickers`` is a *hint* list — e.g. the ticker whose SA feed produced this
    item, or tickers parsed out of a video title. The LLM makes the final call
    on which ticker a piece is actually about.
    """

    source: Source
    url: str
    title: str
    author: str | None = None
    published: datetime | None = None
    summary: str | None = None
    body: str | None = None
    tickers: list[str] = field(default_factory=list)
    # Publication / channel / feed the item belongs to (substack slug,
    # SA author, YT channel title). Useful for author-weight lookup later.
    publisher: str | None = None
    # Anything source-specific we want to keep but don't model explicitly.
    raw: dict = field(default_factory=dict)

    @property
    def source_id(self) -> str:
        """Stable id for this item, used to de-duplicate across runs.

        The canonical url is the natural key; we hash it so ids are a fixed
        length and safe as a filename / DB key.
        """
        basis = self.url or f"{self.source.value}:{self.title}:{_iso(self.published)}"
        return hashlib.sha1(basis.encode("utf-8")).hexdigest()[:16]

    @property
    def has_full_text(self) -> bool:
        return bool(self.body and self.body.strip())

    def to_dict(self) -> dict:
        d = asdict(self)
        d["source"] = self.source.value
        d["published"] = _iso(self.published)
        d["source_id"] = self.source_id
        d["has_full_text"] = self.has_full_text
        return d


@dataclass(slots=True)
class MentionEntry:
    """A single ticker's social-mention snapshot from Ape Wisdom."""

    ticker: str
    name: str | None = None
    mentions: int = 0
    upvotes: int = 0
    rank: int | None = None
    mentions_24h_ago: int | None = None
    rank_24h_ago: int | None = None
    # The Ape Wisdom filter this came from (e.g. "all-stocks", "wallstreetbets").
    filter_name: str = "all-stocks"
    as_of: datetime | None = None

    @property
    def mention_delta(self) -> int | None:
        if self.mentions_24h_ago is None:
            return None
        return self.mentions - self.mentions_24h_ago

    def to_dict(self) -> dict:
        d = asdict(self)
        d["as_of"] = _iso(self.as_of)
        d["mention_delta"] = self.mention_delta
        return d
