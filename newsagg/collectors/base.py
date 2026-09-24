"""Base class and RSS helpers shared by the article collectors."""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod

import httpx

from newsagg import rss
from newsagg.config import Settings
from newsagg.http import fetch
from newsagg.models import RawItem

logger = logging.getLogger("newsagg.collectors")


class BaseCollector(ABC):
    """A collector turns one source into a list of :class:`RawItem`.

    Collectors are constructed with the shared settings and an open
    ``httpx.AsyncClient`` (owned by the pipeline, not the collector).
    """

    name: str = "base"

    def __init__(self, settings: Settings, client: httpx.AsyncClient) -> None:
        self.settings = settings
        self.client = client

    @abstractmethod
    async def collect(self) -> list[RawItem]:
        ...


async def fetch_feed(
    client: httpx.AsyncClient,
    url: str,
) -> rss.ParsedFeed | None:
    """Fetch an RSS/Atom feed and parse it with the stdlib parser.

    We fetch bytes with our own client (so the browser UA / cookies apply) and
    only hand the body to the pure parser.
    """
    resp = await fetch(client, url)
    if resp is None:
        return None
    parsed = rss.parse(resp.content)
    if not parsed.entries:
        logger.warning("feed %s produced no entries", url)
    return parsed
