"""Collection pipeline — run every collector, de-dupe, dump to disk.

This is step 1's entrypoint. It produces two artifacts under ``output_dir``:

    raw_items_{date}.json   — list of RawItem dicts (feeds the LLM normalizer)
    mentions_{date}.json    — list of MentionEntry dicts (heat signal)

Downstream (step 2) reads ``raw_items`` and turns each into a bullish seed.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path

from newsagg.collectors import (
    ApeWisdomCollector,
    SchwabYouTubeCollector,
    SeekingAlphaCollector,
    SubstackCollector,
)
from newsagg.config import Settings, load_settings
from newsagg.http import get_client
from newsagg.models import MentionEntry, RawItem

logger = logging.getLogger("newsagg.pipeline")


@dataclass
class CollectionResult:
    raw_items: list[RawItem] = field(default_factory=list)
    mentions: list[MentionEntry] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    @property
    def summary(self) -> dict:
        by_source: dict[str, int] = {}
        for item in self.raw_items:
            by_source[item.source.value] = by_source.get(item.source.value, 0) + 1
        return {
            "total_items": len(self.raw_items),
            "with_full_text": sum(1 for i in self.raw_items if i.has_full_text),
            "by_source": by_source,
            "mentions": len(self.mentions),
            "errors": self.errors,
        }


def dedupe(items: list[RawItem]) -> list[RawItem]:
    """Drop exact duplicates by source_id (same url collected twice).

    NOTE: this is only the cheap syntactic de-dup. The semantic de-dup the spec
    calls for (same ticker + catalyst type + nearby date) happens in step 2,
    after the LLM has extracted ticker and catalyst.
    """
    seen: set[str] = set()
    out: list[RawItem] = []
    for item in items:
        if item.source_id in seen:
            continue
        seen.add(item.source_id)
        out.append(item)
    return out


async def run_collection(settings: Settings | None = None) -> CollectionResult:
    settings = settings or load_settings()
    result = CollectionResult()

    async with get_client(
        user_agent=settings.user_agent,
        timeout_s=settings.request_timeout_s,
    ) as client:
        # SeekingAlpha needs the cookie on its client; give it a dedicated one.
        sa_client = get_client(
            user_agent=settings.user_agent,
            timeout_s=settings.request_timeout_s,
            cookie=settings.seekingalpha.cookie,
        )

        article_collectors = [
            SeekingAlphaCollector(settings, sa_client),
            SubstackCollector(settings, client),
            SchwabYouTubeCollector(settings, client),
        ]
        try:
            for collector in article_collectors:
                try:
                    result.raw_items.extend(await collector.collect())
                except Exception as exc:  # one bad source shouldn't sink the run
                    msg = f"{collector.name}: {exc}"
                    logger.exception("collector failed: %s", msg)
                    result.errors.append(msg)

            try:
                result.mentions = await ApeWisdomCollector(settings, client).collect()
            except Exception as exc:
                msg = f"apewisdom: {exc}"
                logger.exception("collector failed: %s", msg)
                result.errors.append(msg)
        finally:
            await sa_client.aclose()

    result.raw_items = dedupe(result.raw_items)
    return result


def write_result(result: CollectionResult, output_dir: Path, run_date: date | None = None) -> dict:
    run_date = run_date or datetime.now(timezone.utc).date()
    output_dir.mkdir(parents=True, exist_ok=True)

    items_path = output_dir / f"raw_items_{run_date.isoformat()}.json"
    mentions_path = output_dir / f"mentions_{run_date.isoformat()}.json"

    items_path.write_text(
        json.dumps([i.to_dict() for i in result.raw_items], ensure_ascii=False, indent=2)
    )
    mentions_path.write_text(
        json.dumps([m.to_dict() for m in result.mentions], ensure_ascii=False, indent=2)
    )
    return {"raw_items": str(items_path), "mentions": str(mentions_path)}
