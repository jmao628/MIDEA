"""Tests for the stdlib RSS/Atom parser."""

from newsagg import rss

RSS_2_0 = b"""<?xml version="1.0"?>
<rss version="2.0"
     xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title>Test Pub</title>
  <item>
    <title>Cummins is a buy</title>
    <link>https://example.com/a1</link>
    <dc:creator>Joseph Mwangi</dc:creator>
    <pubDate>Wed, 02 Jul 2026 12:00:00 GMT</pubDate>
    <description>Short teaser</description>
    <content:encoded><![CDATA[<p>Full body about power systems growth.</p>]]></content:encoded>
    <guid>https://example.com/a1</guid>
  </item>
</channel>
</rss>"""

ATOM = b"""<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Pub</title>
  <entry>
    <title>NVDA thesis</title>
    <link rel="alternate" href="https://ex.com/n1"/>
    <author><name>Jane</name></author>
    <published>2026-07-01T09:30:00Z</published>
    <summary>teaser</summary>
    <content>body text</content>
    <id>tag:ex.com,2026:1</id>
  </entry>
</feed>"""


def test_parse_rss_2_0():
    feed = rss.parse(RSS_2_0)
    assert feed.feed_title == "Test Pub"
    assert len(feed.entries) == 1
    e = feed.entries[0]
    assert e.title == "Cummins is a buy"
    assert e.link == "https://example.com/a1"
    assert e.author == "Joseph Mwangi"
    assert e.published.year == 2026 and e.published.month == 7 and e.published.day == 2
    assert "power systems" in e.content
    assert e.guid == "https://example.com/a1"


def test_parse_atom():
    feed = rss.parse(ATOM)
    assert feed.feed_title == "Atom Pub"
    e = feed.entries[0]
    assert e.title == "NVDA thesis"
    assert e.link == "https://ex.com/n1"
    assert e.author == "Jane"
    assert e.published.hour == 9 and e.published.minute == 30
    assert e.content == "body text"


def test_bad_xml_is_safe():
    assert rss.parse(b"<not valid xml").entries == []
    assert rss.parse(b"").entries == []


def test_guid_permalink_fallback():
    xml = b"""<?xml version="1.0"?>
    <rss version="2.0"><channel><title>x</title>
    <item><title>t</title><guid>https://ex.com/g</guid></item>
    </channel></rss>"""
    e = rss.parse(xml).entries[0]
    assert e.link == "https://ex.com/g"
