"""Data models for the SeekingAlpha scraper (top analysts + tech widgets).

Separate from ``models.py`` (the RSS/LLM pipeline) because this is a distinct
data shape driving the live tracking page: analyst leaderboard, their Buy /
Strong Buy calls, and the homepage tech-sector ticker widgets.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


# Ratings we care about — the user wants Buy / Strong Buy only.
BULLISH_RATINGS = {"buy", "strong buy"}


@dataclass(slots=True)
class AnalystProfile:
    """A row from the Top Performing Analysts leaderboard."""

    name: str
    profile_url: str
    rank: int | None = None
    # Free-form stats as SA labels them (avg return, success rate, etc.).
    stats: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(slots=True)
class AnalystPick:
    """A Buy / Strong Buy article by a tracked analyst."""

    analyst: str
    profile_url: str
    ticker: str
    rating: str  # "Buy" | "Strong Buy"
    article_title: str = ""
    article_url: str = ""
    published: datetime | None = None
    rank: int | None = None  # analyst's leaderboard rank, denormalized for display

    @property
    def is_bullish(self) -> bool:
        return self.rating.strip().lower() in BULLISH_RATINGS

    def to_dict(self) -> dict:
        d = asdict(self)
        d["published"] = _iso(self.published)
        d["is_bullish"] = self.is_bullish
        return d


@dataclass(slots=True)
class TechTicker:
    """A ticker pulled from a homepage tech-sector widget."""

    ticker: str
    name: str | None = None
    # "quant" (Latest Quant Ratings) or "analyst" (Latest Analyst Coverage).
    widget: str = "quant"
    rating: str | None = None  # e.g. "Strong Buy", "Hold" as shown in the widget

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class SAScrapeResult:
    """Everything one scrape run produces — this is what the web page reads."""

    generated_at: datetime
    top_analysts: list[AnalystProfile] = field(default_factory=list)
    analyst_picks: list[AnalystPick] = field(default_factory=list)
    # Structured homepage widgets. Each is:
    #   {"title": str, "description": str, "groups": [
    #       {"label": str, "rows": [
    #           {"ticker","company","rating","article","article_url","analyst"}]}]}
    # This captures the SA layout: a widget title, its cap-size columns
    # (Large/Mid/Small Cap, S&P 500, ...), and each row's ticker + rating.
    home_widgets: list[dict] = field(default_factory=list)
    # Buy/Strong Buy articles from the analysts you follow ("My Analysts" feed),
    # extracted from text, within the lookback window. Each is:
    #   {ticker, rating, article_title, article_url, author, published}
    my_analyst_picks: list[dict] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "generated_at": _iso(self.generated_at),
            "top_analysts": [a.to_dict() for a in self.top_analysts],
            "analyst_picks": [p.to_dict() for p in self.analyst_picks],
            "home_widgets": self.home_widgets,
            "my_analyst_picks": self.my_analyst_picks,
            "errors": self.errors,
            "counts": {
                "top_analysts": len(self.top_analysts),
                "analyst_picks": len(self.analyst_picks),
                "home_widgets": len(self.home_widgets),
                "home_widget_rows": sum(
                    len(g.get("rows", [])) for w in self.home_widgets for g in w.get("groups", [])
                ),
                "my_analyst_picks": len(self.my_analyst_picks),
            },
        }
