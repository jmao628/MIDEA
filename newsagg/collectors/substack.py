"""Substack collector.

Each configured publication exposes a full-text RSS feed at:

    https://{publication}.substack.com/feed

Substack puts the whole post in ``content:encoded`` for free posts, so unlike
SeekingAlpha we get the body straight from the feed — no page scraping needed.
(Paywalled posts still only give a preview; that's just what the feed returns.)
"""

from __future__ import annotations

import logging

from bs4 import BeautifulSoup

from newsagg.collectors.base import BaseCollector, fetch_feed
from newsagg.models import RawItem, Source

logger = logging.getLogger("newsagg.collectors.substack")

FEED_TMPL = "https://{pub}.substack.com/feed"


class SubstackCollector(BaseCollector):
    name = Source.SUBSTACK.value

    async def collect(self) -> list[RawItem]:
        pubs = [p.strip() for p in self.settings.substack.publications if p.strip()]
        if not pubs:
            logger.info("Substack: no publications configured, skipping")
            return []

        items: list[RawItem] = []
        for pub in pubs:
            items.extend(await self._collect_pub(pub))
        logger.info("Substack: collected %d items across %d publications", len(items), len(pubs))
        return items

    async def _collect_pub(self, pub: str) -> list[RawItem]:
        # Allow either "slug" or a full "slug.substack.com" in config.
        slug = pub.replace(".substack.com", "").strip("/ ")
        url = FEED_TMPL.format(pub=slug)
        feed = await fetch_feed(self.client, url)
        if feed is None:
            return []

        feed_author = feed.feed_title
        out: list[RawItem] = []
        for entry in feed.entries:
            if not entry.link or not entry.title:
                continue
            # Substack puts the full post in content:encoded; fall back to summary.
            body_html = entry.content or entry.summary
            out.append(
                RawItem(
                    source=Source.SUBSTACK,
                    url=entry.link,
                    title=entry.title,
                    author=entry.author or feed_author,
                    published=entry.published,
                    summary=_to_text(entry.summary),
                    body=_to_text(body_html),
                    publisher=slug,
                    raw={"publication": slug},
                )
            )
        return out


def _to_text(html: str | None) -> str | None:
    if not html:
        return None
    text = BeautifulSoup(html, "html.parser").get_text("\n", strip=True)
    return text or None
