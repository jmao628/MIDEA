"""Minimal RSS 2.0 / Atom parser built on the stdlib.

We deliberately avoid ``feedparser``: its hard dependency on ``sgmllib3k`` fails
to build on modern/Debian setuptools, and we only need a handful of fields. This
covers RSS 2.0 (with ``content:encoded`` and ``dc:creator``) and Atom, which is
everything SeekingAlpha and Substack emit.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from xml.etree import ElementTree as ET

logger = logging.getLogger("newsagg.rss")

_NS = {
    "content": "http://purl.org/rss/1.0/modules/content/",
    "dc": "http://purl.org/dc/elements/1.1/",
    "atom": "http://www.w3.org/2005/Atom",
}


@dataclass
class FeedEntry:
    title: str = ""
    link: str = ""
    author: str | None = None
    published: datetime | None = None
    summary: str | None = None
    content: str | None = None  # full body (content:encoded / atom content)
    guid: str | None = None


@dataclass
class ParsedFeed:
    feed_title: str | None = None
    entries: list[FeedEntry] = field(default_factory=list)


def parse(content: bytes | str) -> ParsedFeed:
    """Parse feed bytes into a :class:`ParsedFeed`. Never raises on bad XML."""
    try:
        root = ET.fromstring(content)
    except ET.ParseError as exc:
        logger.warning("feed XML did not parse: %s", exc)
        return ParsedFeed()

    tag = _localname(root.tag)
    if tag == "feed":  # Atom
        return _parse_atom(root)
    return _parse_rss(root)  # rss / rdf


def _parse_rss(root: ET.Element) -> ParsedFeed:
    channel = root.find("channel")
    scope = channel if channel is not None else root
    feed = ParsedFeed(feed_title=_text(scope.find("title")))

    # RSS 2.0 items live under channel; RDF items are siblings under root.
    items = scope.findall("item") or root.findall("item")
    for item in items:
        content = _text(item.find("content:encoded", _NS))
        feed.entries.append(
            FeedEntry(
                title=_text(item.find("title")) or "",
                link=_rss_link(item),
                author=_text(item.find("dc:creator", _NS)) or _text(item.find("author")),
                published=_parse_date(
                    _text(item.find("pubDate"))
                    or _text(item.find("dc:date", _NS))
                    or _text(item.find("published"))
                ),
                summary=_text(item.find("description")),
                content=content,
                guid=_text(item.find("guid")),
            )
        )
    return feed


def _parse_atom(root: ET.Element) -> ParsedFeed:
    feed = ParsedFeed(feed_title=_text(root.find("atom:title", _NS)))
    for entry in root.findall("atom:entry", _NS):
        author = entry.find("atom:author/atom:name", _NS)
        content = _text(entry.find("atom:content", _NS))
        feed.entries.append(
            FeedEntry(
                title=_text(entry.find("atom:title", _NS)) or "",
                link=_atom_link(entry),
                author=_text(author),
                published=_parse_date(
                    _text(entry.find("atom:published", _NS))
                    or _text(entry.find("atom:updated", _NS))
                ),
                summary=_text(entry.find("atom:summary", _NS)),
                content=content,
                guid=_text(entry.find("atom:id", _NS)),
            )
        )
    return feed


# --- helpers ---------------------------------------------------------------


def _localname(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _text(elem: ET.Element | None) -> str | None:
    if elem is None:
        return None
    text = "".join(elem.itertext()).strip()
    return text or None


def _rss_link(item: ET.Element) -> str:
    link = item.find("link")
    if link is not None and (link.text or "").strip():
        return link.text.strip()
    # Some feeds only carry a permalink guid.
    guid = item.find("guid")
    if guid is not None and (guid.get("isPermaLink") != "false") and (guid.text or "").strip():
        return guid.text.strip()
    return ""


def _atom_link(entry: ET.Element) -> str:
    # Prefer rel="alternate"; fall back to the first link with an href.
    fallback = ""
    for link in entry.findall("atom:link", _NS):
        href = link.get("href")
        if not href:
            continue
        if link.get("rel", "alternate") == "alternate":
            return href
        fallback = fallback or href
    return fallback


def _parse_date(value: str | None) -> datetime | None:
    if not value:
        return None
    value = value.strip()
    # RFC 822 (RSS pubDate).
    try:
        dt = parsedate_to_datetime(value)
        if dt is not None:
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        pass
    # ISO 8601 (Atom).
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None
