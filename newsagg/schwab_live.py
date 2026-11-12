"""Resolve the Schwab channel's *current* live video via the YouTube Data API
and write it into the dashboard config, so the panel embeds the actual live
broadcast (reliable) and shows a clean "offline" state when nothing is live.

The bare ``live_stream?channel=`` embed is flaky and renders "video
unavailable" whenever the channel isn't live; embedding the resolved video id
is far more dependable. This also yields the live video url the LLM
caption/signal pipeline needs for audio capture.

Run it periodically during market hours:
    python -m newsagg.schwab_live

Needs YOUTUBE_API_KEY in .env and either schwabChannelId in
data/newsagg/dashboard.json or schwab_youtube.channel_id in config.yaml.
"""

from __future__ import annotations

import asyncio
import json
import logging

from newsagg.config import load_settings
from newsagg.http import fetch, get_client

logger = logging.getLogger("newsagg.schwab_live")

SEARCH_API = "https://www.googleapis.com/youtube/v3/search"


async def resolve() -> str | None:
    settings = load_settings()
    settings.output_dir.mkdir(parents=True, exist_ok=True)
    cfg_path = settings.output_dir / "dashboard.json"

    cfg: dict = {}
    if cfg_path.exists():
        try:
            cfg = json.loads(cfg_path.read_text())
        except ValueError:
            cfg = {}

    channel = cfg.get("schwabChannelId") or settings.schwab_youtube.channel_id
    key = settings.schwab_youtube.api_key
    if not channel:
        logger.warning("no schwabChannelId in dashboard.json / config; skipping")
        return None
    if not key:
        logger.warning("YOUTUBE_API_KEY unset; cannot resolve live video")
        return None

    video_id: str | None = None
    async with get_client(user_agent=settings.user_agent) as client:
        resp = await fetch(
            client,
            SEARCH_API,
            params={
                "part": "snippet",
                "channelId": channel,
                "eventType": "live",
                "type": "video",
                "maxResults": 1,
                "key": key,
            },
        )
        if resp is not None:
            items = resp.json().get("items", [])
            if items:
                video_id = items[0]["id"]["videoId"]

    cfg["schwabChannelId"] = channel
    cfg["schwabVideoId"] = video_id  # None => resolver ran and channel is offline
    cfg_path.write_text(json.dumps(cfg, indent=2))
    logger.info("schwab live: %s", video_id or "offline")
    return video_id


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    vid = asyncio.run(resolve())
    print(f"live video: {vid}" if vid else "Schwab is offline (no live broadcast)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
