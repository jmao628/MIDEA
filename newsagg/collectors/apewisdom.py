"""Ape Wisdom collector — social-mention counts (popularity raw material).

Ape Wisdom (https://apewisdom.io) aggregates ticker mentions across social
boards and exposes a free JSON API — no key required:

    https://apewisdom.io/api/v1.0/filter/{filter}/page/{n}

Each page returns up to 100 tickers ranked by mentions. We scan the top pages
and keep the ones in our watchlist. This does NOT produce bullish seeds — the
mention counts are joined onto seeds later as a heat/popularity signal.
"""

from __future__ import annotations

import logging

from newsagg.config import Settings
from newsagg.http import fetch
from newsagg.models import MentionEntry

logger = logging.getLogger("newsagg.collectors.apewisdom")

API_TMPL = "https://apewisdom.io/api/v1.0/filter/{filter}/page/{page}"


class ApeWisdomCollector:
    """Not a RawItem source — returns per-ticker mention snapshots.

    Kept separate from :class:`BaseCollector` on purpose: its output feeds a
    different table (heat signal), not the bullish-seed pipeline.
    """

    name = "apewisdom"

    def __init__(self, settings: Settings, client) -> None:
        self.settings = settings
        self.client = client

    async def collect(self) -> list[MentionEntry]:
        cfg = self.settings.apewisdom
        watchlist = set(self.settings.effective_watchlist)
        if cfg.filter_to_watchlist and not watchlist:
            logger.info("ApeWisdom: watchlist empty and filtering on, skipping")
            return []

        entries: list[MentionEntry] = []
        for page in range(1, cfg.max_pages + 1):
            page_entries = await self._collect_page(cfg.filter_name, page)
            if not page_entries:
                break
            entries.extend(page_entries)
            # If we're only after the watchlist and already have all of it, stop.
            if cfg.filter_to_watchlist:
                have = {e.ticker for e in entries} & watchlist
                if have >= watchlist:
                    break

        if cfg.filter_to_watchlist:
            entries = [e for e in entries if e.ticker in watchlist]

        logger.info("ApeWisdom: collected %d mention entries", len(entries))
        return entries

    async def _collect_page(self, filter_name: str, page: int) -> list[MentionEntry]:
        url = API_TMPL.format(filter=filter_name, page=page)
        resp = await fetch(self.client, url)
        if resp is None:
            return []
        try:
            results = resp.json().get("results", [])
        except ValueError:
            logger.warning("ApeWisdom: page %d returned non-JSON", page)
            return []

        out: list[MentionEntry] = []
        for r in results:
            ticker = (r.get("ticker") or "").strip().upper()
            if not ticker:
                continue
            out.append(
                MentionEntry(
                    ticker=ticker,
                    name=r.get("name"),
                    mentions=_int(r.get("mentions")),
                    upvotes=_int(r.get("upvotes")),
                    rank=_int_or_none(r.get("rank")),
                    mentions_24h_ago=_int_or_none(r.get("mentions_24h_ago")),
                    rank_24h_ago=_int_or_none(r.get("rank_24h_ago")),
                    filter_name=filter_name,
                )
            )
        return out


def _int(value) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _int_or_none(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
