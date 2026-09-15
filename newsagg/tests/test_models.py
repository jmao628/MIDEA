"""Tests for RawItem / MentionEntry and pipeline de-dup."""

from datetime import datetime, timezone

from newsagg.models import MentionEntry, RawItem, Source
from newsagg.pipeline import dedupe


def test_rawitem_to_dict():
    item = RawItem(
        source=Source.SEEKING_ALPHA,
        url="https://sa.com/x",
        title="Cummins buy",
        author="Joseph Mwangi",
        published=datetime(2026, 7, 2, tzinfo=timezone.utc),
        summary="teaser",
        body="full text",
        tickers=["CMI"],
    )
    d = item.to_dict()
    assert d["source"] == "seekingalpha"
    assert d["has_full_text"] is True
    assert d["published"] == "2026-07-02T00:00:00+00:00"
    assert len(d["source_id"]) == 16


def test_rawitem_source_id_stable_by_url():
    a = RawItem(source=Source.SUBSTACK, url="https://s.com/p", title="one")
    b = RawItem(source=Source.SUBSTACK, url="https://s.com/p", title="two-different-title")
    assert a.source_id == b.source_id  # url is the natural key


def test_has_full_text_false_when_body_blank():
    assert RawItem(source=Source.SUBSTACK, url="u", title="t", body="  ").has_full_text is False


def test_dedupe_by_url():
    it = RawItem(source=Source.SEEKING_ALPHA, url="https://sa.com/x", title="a")
    dup = RawItem(source=Source.SEEKING_ALPHA, url="https://sa.com/x", title="dup")
    other = RawItem(source=Source.SUBSTACK, url="https://sub.com/y", title="y")
    out = dedupe([it, dup, other])
    assert len(out) == 2


def test_mention_delta():
    m = MentionEntry(ticker="CMI", mentions=120, mentions_24h_ago=100)
    assert m.mention_delta == 20
    assert m.to_dict()["mention_delta"] == 20
    assert MentionEntry(ticker="X", mentions=5).mention_delta is None
