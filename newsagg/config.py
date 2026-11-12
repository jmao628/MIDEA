"""Configuration for the collection layer.

Non-sensitive settings (watchlists, channel ids, feature toggles) live in a
YAML file — ``newsagg/config.yaml`` by default. Copy ``config.example.yaml``
to ``config.yaml`` and fill in your lists.

Secrets (SeekingAlpha login cookie, YouTube API key) come from environment
variables / a ``.env`` file and are **never** written to YAML.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml

_PKG_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG_PATH = _PKG_DIR / "config.yaml"


def _load_dotenv() -> None:
    """Minimal .env loader so we don't force a python-dotenv import.

    Looks for a .env in the repo root and the package dir. Existing env vars
    win — we never overwrite something already set in the environment.
    """
    for candidate in (_PKG_DIR.parent / ".env", _PKG_DIR / ".env"):
        if not candidate.exists():
            continue
        for line in candidate.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip().strip('"').strip("'")
            os.environ.setdefault(key, value)


@dataclass
class SeekingAlphaConfig:
    # Tickers whose /api/sa/combined/{TICKER}.xml feed we subscribe to.
    tickers: list[str] = field(default_factory=list)
    # When true and a cookie is present, fetch each article page for full text.
    fetch_full_text: bool = True
    # Login cookie string (from env SA_COOKIE). Enables paywalled full text.
    cookie: str | None = None
    # Scraper (top-analysts page): how many top analysts to open for their
    # Buy/Strong Buy picks. Higher = slower.
    top_n_analysts: int = 15
    # "My Analysts" feed: pull recent Buy/Strong Buy articles from the analysts
    # you follow, within this many days.
    my_analysts_url: str = "https://seekingalpha.com/account/people"
    my_analysts_lookback_days: int = 60


@dataclass
class SubstackConfig:
    # Publication subdomains, e.g. "stockmarketnerd" -> stockmarketnerd.substack.com/feed
    publications: list[str] = field(default_factory=list)


@dataclass
class SchwabYouTubeConfig:
    # The channel to watch. Provide either a channel_id (UC...) or a handle.
    channel_id: str | None = None
    channel_handle: str | None = None  # e.g. "@SchwabNetwork"
    # How many recent uploads to pull per run.
    max_results: int = 15
    # Pull yt-dlp transcripts for the full spoken content (slower).
    fetch_transcripts: bool = False
    api_key: str | None = None  # from env YOUTUBE_API_KEY


@dataclass
class ApeWisdomConfig:
    # Which Ape Wisdom board to read. "all-stocks" aggregates the subreddits.
    filter_name: str = "all-stocks"
    # Only keep tickers that are in `watchlist` (the union universe).
    filter_to_watchlist: bool = True
    # How many pages (100 tickers each) to scan for our watchlist tickers.
    max_pages: int = 3


@dataclass
class Settings:
    seekingalpha: SeekingAlphaConfig = field(default_factory=SeekingAlphaConfig)
    substack: SubstackConfig = field(default_factory=SubstackConfig)
    schwab_youtube: SchwabYouTubeConfig = field(default_factory=SchwabYouTubeConfig)
    apewisdom: ApeWisdomConfig = field(default_factory=ApeWisdomConfig)
    # Union universe of tickers we care about (used to filter Ape Wisdom).
    watchlist: list[str] = field(default_factory=list)
    # Where collected raw items get dumped.
    output_dir: Path = _PKG_DIR.parent / "data" / "newsagg"
    # Shared HTTP tuning.
    request_timeout_s: float = 30.0
    user_agent: str = (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )

    @property
    def effective_watchlist(self) -> list[str]:
        """Watchlist, falling back to the SA ticker list if unset."""
        wl = self.watchlist or self.seekingalpha.tickers
        return [t.strip().upper() for t in wl if t.strip()]


def load_settings(path: str | Path | None = None) -> Settings:
    """Load YAML config, then overlay secrets from the environment."""
    _load_dotenv()

    cfg_path = Path(path) if path else DEFAULT_CONFIG_PATH
    data: dict = {}
    if cfg_path.exists():
        data = yaml.safe_load(cfg_path.read_text()) or {}

    sa = data.get("seekingalpha", {}) or {}
    sub = data.get("substack", {}) or {}
    yt = data.get("schwab_youtube", {}) or {}
    ape = data.get("apewisdom", {}) or {}

    settings = Settings(
        seekingalpha=SeekingAlphaConfig(
            tickers=[t.upper() for t in sa.get("tickers", [])],
            fetch_full_text=sa.get("fetch_full_text", True),
            cookie=os.environ.get("SA_COOKIE"),
            top_n_analysts=sa.get("top_n_analysts", 15),
            my_analysts_url=sa.get("my_analysts_url", "https://seekingalpha.com/account/people"),
            my_analysts_lookback_days=sa.get("my_analysts_lookback_days", 60),
        ),
        substack=SubstackConfig(
            publications=sub.get("publications", []),
        ),
        schwab_youtube=SchwabYouTubeConfig(
            channel_id=yt.get("channel_id"),
            channel_handle=yt.get("channel_handle"),
            max_results=yt.get("max_results", 15),
            fetch_transcripts=yt.get("fetch_transcripts", False),
            api_key=os.environ.get("YOUTUBE_API_KEY"),
        ),
        apewisdom=ApeWisdomConfig(
            filter_name=ape.get("filter_name", "all-stocks"),
            filter_to_watchlist=ape.get("filter_to_watchlist", True),
            max_pages=ape.get("max_pages", 3),
        ),
        watchlist=[t.upper() for t in data.get("watchlist", [])],
    )

    if "output_dir" in data:
        settings.output_dir = Path(data["output_dir"])
    if "request_timeout_s" in data:
        settings.request_timeout_s = float(data["request_timeout_s"])
    if "user_agent" in data:
        settings.user_agent = data["user_agent"]

    return settings
