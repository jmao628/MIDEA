"""Tests for collector shaping logic that needs no network."""

from newsagg.collectors.schwab_youtube import _guess_tickers, _vtt_to_text
from newsagg.collectors.seekingalpha import _extract_article_text


def test_guess_tickers_prefers_dollar_and_dedupes():
    text = "Why $CMI and NVDA are buys — also $CMI again"
    out = _guess_tickers(text)
    assert "CMI" in out and "NVDA" in out
    assert out.count("CMI") == 1


def test_vtt_to_text_strips_timings_and_dupes():
    vtt = """WEBVTT
Kind: captions
Language: en

00:00:01.000 --> 00:00:03.000
Cummins has a huge <c>power</c> order

00:00:03.000 --> 00:00:05.000
Cummins has a huge power order
that will drive growth
"""
    text = _vtt_to_text(vtt)
    assert "Cummins has a huge power order" in text
    assert "-->" not in text
    assert "<c>" not in text
    # rolling-caption duplicate line collapsed
    assert text.count("Cummins has a huge power order") == 1


def test_extract_article_text_uses_content_container():
    body = "<p>" + ("Cummins power systems growth thesis. " * 30) + "</p>"
    html = f'<html><body><div data-test-id="content-container">{body}</div></body></html>'
    out = _extract_article_text(html)
    assert out and "Cummins power systems" in out


def test_extract_article_text_none_on_stub():
    html = "<html><body><div>Subscribe to read</div></body></html>"
    assert _extract_article_text(html) is None
