"""Schwab YouTube collector.

Pulls the newest uploads from Schwab's channel via the YouTube Data API v3 and
returns each video's title + description (the title itself usually names the
ticker and the thesis). When ``fetch_transcripts`` is on we shell out to
``yt-dlp`` to grab the auto-captions so the LLM gets the full spoken argument.

Setup needed:
    * A YouTube Data API v3 key in env ``YOUTUBE_API_KEY``.
    * The channel id (UC...) or handle (@...) in config.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime

from newsagg.collectors.base import BaseCollector
from newsagg.http import fetch
from newsagg.models import RawItem, Source

logger = logging.getLogger("newsagg.collectors.schwab_youtube")

API_BASE = "https://www.googleapis.com/youtube/v3"
WATCH_URL = "https://www.youtube.com/watch?v={vid}"

# $TICKER or bare 1-5 char uppercase tokens; used only as a hint for the LLM.
_TICKER_RE = re.compile(r"\$([A-Z]{1,5})\b|\b([A-Z]{2,5})\b")


class SchwabYouTubeCollector(BaseCollector):
    name = Source.SCHWAB_YOUTUBE.value

    async def collect(self) -> list[RawItem]:
        cfg = self.settings.schwab_youtube
        if not cfg.api_key:
            logger.warning("Schwab YouTube: YOUTUBE_API_KEY unset, skipping")
            return []
        if not (cfg.channel_id or cfg.channel_handle):
            logger.warning("Schwab YouTube: no channel_id/channel_handle configured, skipping")
            return []

        channel_id = cfg.channel_id or await self._resolve_handle(cfg.channel_handle, cfg.api_key)
        if not channel_id:
            logger.warning("Schwab YouTube: could not resolve channel, skipping")
            return []

        uploads_playlist = await self._uploads_playlist(channel_id, cfg.api_key)
        if not uploads_playlist:
            return []

        videos = await self._recent_uploads(uploads_playlist, cfg.api_key, cfg.max_results)
        items = [self._to_item(v) for v in videos]

        if cfg.fetch_transcripts:
            await self._hydrate_transcripts(items)

        logger.info("Schwab YouTube: collected %d videos", len(items))
        return items

    # --- YouTube Data API calls -------------------------------------------------

    async def _resolve_handle(self, handle: str, api_key: str) -> str | None:
        h = handle.lstrip("@")
        resp = await fetch(
            self.client,
            f"{API_BASE}/channels",
            params={"part": "id", "forHandle": h, "key": api_key},
        )
        if resp is None:
            return None
        items = resp.json().get("items", [])
        return items[0]["id"] if items else None

    async def _uploads_playlist(self, channel_id: str, api_key: str) -> str | None:
        resp = await fetch(
            self.client,
            f"{API_BASE}/channels",
            params={"part": "contentDetails", "id": channel_id, "key": api_key},
        )
        if resp is None:
            return None
        items = resp.json().get("items", [])
        if not items:
            logger.warning("Schwab YouTube: channel %s returned no data", channel_id)
            return None
        return items[0]["contentDetails"]["relatedPlaylists"]["uploads"]

    async def _recent_uploads(self, playlist_id: str, api_key: str, max_results: int) -> list[dict]:
        resp = await fetch(
            self.client,
            f"{API_BASE}/playlistItems",
            params={
                "part": "snippet,contentDetails",
                "playlistId": playlist_id,
                "maxResults": min(max_results, 50),
                "key": api_key,
            },
        )
        if resp is None:
            return []
        return resp.json().get("items", [])

    # --- Shaping ----------------------------------------------------------------

    def _to_item(self, video: dict) -> RawItem:
        snippet = video.get("snippet", {})
        vid = video.get("contentDetails", {}).get("videoId") or snippet.get(
            "resourceId", {}
        ).get("videoId")
        title = snippet.get("title", "")
        description = snippet.get("description", "")
        published = _parse_iso(snippet.get("publishedAt"))
        return RawItem(
            source=Source.SCHWAB_YOUTUBE,
            url=WATCH_URL.format(vid=vid),
            title=title,
            author=snippet.get("channelTitle"),
            published=published,
            summary=description,
            tickers=_guess_tickers(f"{title}\n{description}"),
            publisher=snippet.get("channelTitle"),
            raw={"video_id": vid},
        )

    # --- Transcripts via yt-dlp -------------------------------------------------

    async def _hydrate_transcripts(self, items: list[RawItem]) -> None:
        for item in items:
            vid = item.raw.get("video_id")
            if not vid:
                continue
            transcript = await _fetch_transcript(item.url)
            if transcript:
                item.body = transcript
        got = sum(1 for it in items if it.has_full_text)
        logger.info("Schwab YouTube: pulled transcripts for %d/%d videos", got, len(items))


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _guess_tickers(text: str) -> list[str]:
    """Best-effort ticker hints from title/description. LLM decides for real."""
    found: list[str] = []
    for dollar, bare in _TICKER_RE.findall(text):
        tok = dollar or bare
        if tok and tok not in found:
            found.append(tok)
    # $-prefixed tickers are high-confidence; keep those first, cap the noise.
    return found[:8]


async def _fetch_transcript(url: str) -> str | None:
    """Run yt-dlp to fetch auto-captions and flatten them to plain text.

    yt-dlp writes the auto-captions into a temp dir as WebVTT; we read the
    file back and flatten it. yt-dlp must be installed (``pip install yt-dlp``).
    Returns None on failure.
    """
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as tmp:
        cmd = [
            "yt-dlp",
            "--skip-download",
            "--write-auto-subs",
            "--sub-langs",
            "en.*",
            "--sub-format",
            "vtt",
            "--paths",
            tmp,
            "-o",
            "%(id)s.%(ext)s",
            url,
        ]
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await proc.communicate()
        except FileNotFoundError:
            logger.warning("yt-dlp not installed; cannot fetch transcripts")
            return None
        if proc.returncode != 0:
            logger.info("yt-dlp failed for %s: %s", url, stderr.decode()[-300:])
            return None
        vtts = list(Path(tmp).glob("*.vtt"))
        if not vtts:
            return None
        return _vtt_to_text(vtts[0].read_text(encoding="utf-8", errors="ignore"))


def _vtt_to_text(vtt: str) -> str:
    """Strip WebVTT cue timings/tags and de-duplicate rolling caption lines."""
    lines: list[str] = []
    for raw in vtt.splitlines():
        line = raw.strip()
        if not line or line == "WEBVTT" or "-->" in line or line.isdigit():
            continue
        if line.startswith(("NOTE", "Kind:", "Language:")):
            continue
        line = re.sub(r"<[^>]+>", "", line)  # inline <c> timing tags
        if line and (not lines or lines[-1] != line):
            lines.append(line)
    return " ".join(lines)
