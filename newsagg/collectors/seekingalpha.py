"""SeekingAlpha collector.

For each watched ticker we read its combined RSS feed:

    https://seekingalpha.com/api/sa/combined/{TICKER}.xml

That gives us title, author, date, and a short summary for free. When a login
cookie is configured (``SA_COOKIE``) and ``fetch_full_text`` is on, we then GET
each article page with the cookie and extract the article body so the LLM has
the full argument, not just the teaser.

Full-text extraction is best-effort: SeekingAlpha is JS-heavy and behind
Cloudflare, so we degrade gracefully to the RSS summary when a page can't be
scraped.
"""

from __future__ import annotations

import asyncio
import logging

from bs4 import BeautifulSoup

from newsagg.collectors.base import BaseCollector, fetch_feed
from newsagg.http import fetch
from newsagg.models import RawItem, Source

logger = logging.getLogger("newsagg.collectors.seekingalpha")

FEED_TMPL = "https://seekingalpha.com/api/sa/combined/{ticker}.xml"

# Concurrency cap on article-page fetches so we don't hammer SA / trip rate limits.
_ARTICLE_CONCURRENCY = 3


class SeekingAlphaCollector(BaseCollector):
    name = Source.SEEKING_ALPHA.value

    async def collect(self) -> list[RawItem]:
        cfg = self.settings.seekingalpha
        tickers = [t.strip().upper() for t in cfg.tickers if t.strip()]
        if not tickers:
            logger.info("SeekingAlpha: no tickers configured, skipping")
            return []

        feeds = await asyncio.gather(*(self._collect_ticker(t) for t in tickers))
        items: list[RawItem] = [item for feed in feeds for item in feed]

        want_full = cfg.fetch_full_text and bool(cfg.cookie)
        if want_full:
            await self._hydrate_full_text(items)
        elif cfg.fetch_full_text and not cfg.cookie:
            logger.warning(
                "SeekingAlpha: fetch_full_text is on but SA_COOKIE is unset; "
                "returning RSS summaries only"
            )

        logger.info("SeekingAlpha: collected %d items across %d tickers", len(items), len(tickers))
        return items

    async def _collect_ticker(self, ticker: str) -> list[RawItem]:
        url = FEED_TMPL.format(ticker=ticker)
        feed = await fetch_feed(self.client, url)
        if feed is None:
            return []
        out: list[RawItem] = []
        for entry in feed.entries:
            if not entry.link or not entry.title:
                continue
            out.append(
                RawItem(
                    source=Source.SEEKING_ALPHA,
                    url=entry.link,
                    title=entry.title,
                    author=entry.author,
                    published=entry.published,
                    summary=_clean_summary(entry.summary),
                    tickers=[ticker],
                    publisher=entry.author,
                    raw={"feed_ticker": ticker, "guid": entry.guid},
                )
            )
        return out

    async def _hydrate_full_text(self, items: list[RawItem]) -> None:
        sem = asyncio.Semaphore(_ARTICLE_CONCURRENCY)

        async def one(item: RawItem) -> None:
            async with sem:
                body = await self._fetch_article_body(item.url)
                if body:
                    item.body = body

        await asyncio.gather(*(one(it) for it in items))
        got = sum(1 for it in items if it.has_full_text)
        logger.info("SeekingAlpha: pulled full text for %d/%d items", got, len(items))

    async def _fetch_article_body(self, url: str) -> str | None:
        resp = await fetch(self.client, url)
        if resp is None:
            return None
        return _extract_article_text(resp.text)


def _clean_summary(html: str | None) -> str | None:
    if not html:
        return None
    text = BeautifulSoup(html, "html.parser").get_text(" ", strip=True)
    return text or None


def _extract_article_text(html: str) -> str | None:
    """Pull the article body out of a SeekingAlpha page.

    SA marks the article content with ``data-test-id="content-container"`` (and
    historically an ``#a-body`` / ``[data-test-id=article-content]`` region).
    We try those, then fall back to the longest <article> / <div> text block so
    the extractor keeps working through markup churn.
    """
    soup = BeautifulSoup(html, "html.parser")

    selectors = [
        '[data-test-id="content-container"]',
        '[data-test-id="article-content"]',
        "div#a-body",
        "article",
    ]
    for sel in selectors:
        node = soup.select_one(sel)
        if node:
            text = node.get_text("\n", strip=True)
            if len(text) > 400:  # a real article, not a paywall stub
                return text

    # Fallback: densest text block on the page.
    candidates = soup.find_all(["article", "div"])
    best = max((c.get_text("\n", strip=True) for c in candidates), key=len, default="")
    return best if len(best) > 400 else None
