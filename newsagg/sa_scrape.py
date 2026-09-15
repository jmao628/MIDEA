"""SeekingAlpha scraper — top analysts, their Buy/Strong Buy calls, and the
homepage tech-sector ticker widgets.

These SA pages are JS-rendered and personalized behind a paywall, so plain HTTP
won't cut it. We drive a real headless browser (Playwright) with your login
cookie, read the rendered DOM, and *also* capture the JSON the page fetches from
SA's internal API (robust to markup churn).

Because SA changes its markup often and this can't be tested without live
access, every run writes recon artifacts to ``data/newsagg/sa_debug/``:
screenshots, rendered HTML, and every ``/api/`` JSON response. If extraction
comes back empty, those artifacts are how we lock in exact selectors.

Usage:
    python -m newsagg.sa_scrape                 # one scrape -> JSON + debug
    python -m newsagg.sa_scrape --recon         # capture artifacts only
    python -m newsagg.sa_scrape --watch 15      # re-scrape every 15 minutes
    python -m newsagg.sa_scrape --headed        # show the browser (debugging)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from newsagg.config import Settings, load_settings
from newsagg.sa_models import AnalystPick, AnalystProfile, SAScrapeResult

logger = logging.getLogger("newsagg.sa_scrape")

TOP_ANALYSTS_URL = "https://seekingalpha.com/top-performing-analysts"
HOME_URL = "https://seekingalpha.com/"

_AUTHOR_HREF = re.compile(r"/author/([a-z0-9\-]+)")

# Extractor for the "My Analysts" article feed: one record per article link,
# pulling its rating badge, ticker, author, title and date text from the row.
_MY_ANALYSTS_JS = r"""
() => {
  const norm = s => (s || "").replace(/\s+/g, " ").trim();
  const out = [];
  const seen = new Set();
  document.querySelectorAll('a[href*="/article/"]').forEach(a => {
    const title = norm(a.textContent);
    const href = a.getAttribute("href") || "";
    if (title.length < 8 || seen.has(href)) return;

    let card = a.closest("article") || a.parentElement;
    for (let i = 0; i < 5 && card && !card.querySelector('a[href*="/symbol/"]')
                     && card.parentElement; i++) {
      card = card.parentElement;
    }
    if (!card) return;
    const text = norm(card.innerText);
    const symA = card.querySelector('a[href*="/symbol/"]');
    const authA = card.querySelector('a[href*="/author/"]');
    const tick = symA && (symA.getAttribute("href").match(/\/symbol\/([A-Z][A-Z.:\-]{0,7})/) || [])[1];
    const rating = (text.match(/strong buy|buy|hold|sell/i) || [""])[0];
    const dateM = text.match(/yesterday|today|(?:sun|mon|tue|wed|thu|fri|sat),?\s+[a-z]{3}\s+\d{1,2}|[a-z]{3}\s+\d{1,2}/i);

    seen.add(href);
    out.push({
      title, href,
      ticker: tick || null,
      rating: rating || null,
      author: authA ? norm(authA.textContent) : null,
      date: dateM ? dateM[0] : null,
    });
  });
  return out;
}
"""

_MONTHS = {
    m: i
    for i, m in enumerate(
        ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
        start=1,
    )
}


def parse_feed_date(text: str | None, now: datetime) -> date | None:
    """Parse SA's relative feed dates ('Yesterday', 'Mon, Jul 6', 'Jun 15')."""
    if not text:
        return None
    t = text.strip().lower()
    if "today" in t:
        return now.date()
    if "yesterday" in t:
        return (now - timedelta(days=1)).date()
    m = re.search(r"([a-z]{3})\s+(\d{1,2})", t)
    if not m:
        return None
    mon = _MONTHS.get(m.group(1))
    if not mon:
        return None
    try:
        d = date(now.year, mon, int(m.group(2)))
    except ValueError:
        return None
    # A month ahead of "now" means it's last year's article.
    if d > now.date():
        try:
            d = date(now.year - 1, mon, int(m.group(2)))
        except ValueError:
            return None
    return d

# In-page extractor for the SA logged-in homepage widgets. Walks the DOM in
# document order per widget: it tracks the current cap-size column header
# (Large/Mid/Small Cap, S&P 500, ...) and, for every ticker link, emits a row
# with the ticker plus the company / rating / article / analyst read from the
# row's own text. Structure-based (not class-name-based) so it survives SA's
# frequent CSS churn.
_HOME_WIDGETS_JS = r"""
() => {
  const norm = s => (s || "").replace(/\s+/g, " ").trim();
  const lc = s => norm(s).toLowerCase();

  const EXPLICIT = [
    "latest quant ratings",
    "latest analyst coverage",
    "top quant stocks by market cap",
    "latest strong buys",
  ];
  const GROUPS = new Set([
    "large cap", "mid cap", "small cap",
    "s&p 500", "mid cap 400", "small cap 600",
    "quant strong buys", "analyst strong buys",
  ]);

  const heads = [...document.querySelectorAll("h1,h2,h3,h4,h5,strong,div,span,a")];

  // Target every whitelisted widget plus any "… Ideas" analyst-thesis widget
  // (Most Compelling / Latest Value / Dividend Growth / Latest Growth / …).
  const targets = [];
  const seen = new Set();
  for (const h of heads) {
    const x = lc(h.textContent);
    if (x.length < 5 || x.length >= 90) continue;
    const raw = norm(h.textContent);
    // A real "… IDEAS" widget heading is an all-caps section title; this
    // excludes author names / nav links that merely end in "Ideas".
    const isIdeas = /\bideas$/.test(x) && /[A-Z]/.test(raw) && raw === raw.toUpperCase();
    if (!(EXPLICIT.some((t) => x.includes(t)) || isIdeas)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    targets.push(h);
  }

  const widgets = [];
  for (const head of targets) {
    const title = norm(head.textContent);

    // Climb to the widget container (an ancestor holding several ticker links).
    let box = head;
    for (let i = 0; i < 10 && box.parentElement; i++) {
      box = box.parentElement;
      if (box.querySelectorAll('a[href*="/symbol/"]').length >= 4) break;
    }

    // Short description line under the title.
    let description = "";
    const descEl = [...box.querySelectorAll("p,div,span")].find(e => {
      const x = norm(e.textContent);
      return x.length > 25 && x.length < 160
        && !e.querySelector('a[href*="/symbol/"]') && x !== title;
    });
    if (descEl) description = norm(descEl.textContent);
    // The description element sometimes prepends a copy of the title.
    if (description.toLowerCase().startsWith(title.toLowerCase())) {
      description = norm(description.slice(title.length));
    }

    // Document-order walk: switch column on a group header, emit a row per ticker.
    const groups = [];
    let cur = null;
    const rowSeen = new Set();
    for (const el of box.querySelectorAll("*")) {
      if (el.children.length === 0 && GROUPS.has(lc(el.textContent))) {
        cur = { label: norm(el.textContent), rows: [] };
        groups.push(cur);
        continue;
      }
      if (!(el.matches && el.matches('a[href*="/symbol/"]'))) continue;
      const m = el.getAttribute("href").match(/\/symbol\/([A-Z][A-Z.:\-]{0,7})/);
      if (!m) continue;
      const ticker = m[1];

      let row = el.closest("tr") || el.closest("li") || el.parentElement;
      for (let i = 0; i < 3 && row && norm(row.innerText).length < ticker.length + 3
                       && row.parentElement; i++) {
        row = row.parentElement;
      }
      const text = norm(row ? row.innerText : el.textContent);
      const key = ticker + "|" + (cur ? cur.label : "") + "|" + text.slice(0, 24);
      if (rowSeen.has(key)) continue;
      rowSeen.add(key);

      const rating = (text.match(/\b[0-5]\.\d{2}\b/)
        || text.match(/strong buy|buy|hold|sell/i) || [""])[0];
      const artA = row && row.querySelector('a[href*="/article/"], a[href*="/news/"]');
      const authA = row && row.querySelector('a[href*="/author/"]');
      let company = text;
      [ticker, rating].forEach(s => { if (s) company = company.replace(s, "").trim(); });
      // Strip trailing "RATING: STRONG BUY" / bare "STRONG BUY" labels SA
      // appends to the row text, leaving just the company name.
      company = company
        .replace(/rating:\s*(strong buy|buy|hold|sell)/i, "")
        .replace(/\b(strong buy|buy|hold|sell)\b/i, "")
        .replace(/\s{2,}/g, " ")
        .replace(/[·|,\s]+$/, "")
        .trim();

      if (!cur) { cur = { label: "", rows: [] }; groups.push(cur); }
      cur.rows.push({
        ticker,
        company: artA ? null : norm(company).slice(0, 60),
        rating: rating || null,
        article: artA ? norm(artA.textContent) : null,
        article_url: artA ? artA.href : null,
        analyst: authA ? norm(authA.textContent) : null,
      });
    }

    const nonEmpty = groups.filter(g => g.rows.length);
    if (nonEmpty.length) widgets.push({ title, description, groups: nonEmpty });
  }
  return widgets;
}
"""


def parse_key_comparisons(captures: list[tuple[str, dict]]) -> list[dict]:
    """Parse SA's homepage ``key_comparisons`` API response into named baskets.

    The response is JSON:API: ``data`` holds each comparison (name + ticker id
    refs), ``included`` holds the ticker objects. We resolve the refs to real
    symbols + company names. Returns [{"name", "tickers": [{ticker, company}]}].
    """
    for url, body in captures:
        if "key_comparisons?" not in url or not isinstance(body, dict):
            continue
        included = {
            (i.get("type"), i.get("id")): i for i in body.get("included", []) if isinstance(i, dict)
        }
        baskets: list[dict] = []
        for item in body.get("data", []):
            name = (item.get("attributes") or {}).get("name")
            refs = (item.get("relationships") or {}).get("tickers", {}).get("data", [])
            tickers = []
            for ref in refs:
                inc = included.get(("ticker", ref.get("id")))
                if not inc:
                    continue
                attrs = inc.get("attributes") or {}
                sym = attrs.get("name")
                if sym:
                    tickers.append({"ticker": sym, "company": attrs.get("companyName")})
            if name and tickers:
                baskets.append({"name": name, "tickers": tickers})
        return baskets
    return []


# --------------------------------------------------------------------------
# cookie handling
# --------------------------------------------------------------------------
def parse_cookie_header(cookie: str) -> list[dict]:
    """Turn a raw ``Cookie:`` header string into Playwright cookie dicts."""
    cookies: list[dict] = []
    for part in cookie.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        name, _, value = part.partition("=")
        cookies.append(
            {
                "name": name.strip(),
                "value": value.strip(),
                "domain": ".seekingalpha.com",
                "path": "/",
            }
        )
    return cookies


# --------------------------------------------------------------------------
# scraper
# --------------------------------------------------------------------------
class SeekingAlphaScraper:
    def __init__(self, settings: Settings, *, headed: bool = False, recon: bool = False) -> None:
        self.settings = settings
        self.headed = headed
        self.recon = recon
        self.debug_dir = settings.output_dir / "sa_debug"
        self._api_captures: list[tuple[str, dict]] = []

    async def run(self) -> SAScrapeResult:
        from playwright.async_api import async_playwright

        result = SAScrapeResult(generated_at=datetime.now(timezone.utc))
        self.debug_dir.mkdir(parents=True, exist_ok=True)

        from newsagg.sa_browser import (
            COOKIE_FILE,
            import_cookie_file,
            launch_context,
            profile_dir,
        )

        async with async_playwright() as pw:
            from pathlib import Path

            context = await launch_context(pw, self.settings, headless=not self.headed)

            # Auth strategy — keep the session self-renewing:
            # The persistent profile stores whatever cookies SA hands back on
            # each visit, so a session that gets rolled forward stays alive by
            # itself as long as we scrape regularly. We therefore import the
            # sa_cookies.json export ONLY when there's no session yet, or when
            # the user has dropped a fresh export (file newer than our marker).
            # Re-importing every run would keep resetting to the aging export
            # and defeat the self-renewal.
            profile_ok = Path(profile_dir(self.settings)).joinpath("Default").exists()
            cookies_path = self.settings.output_dir / COOKIE_FILE
            marker = self.settings.output_dir / ".sa_cookies_imported"

            fresh_export = cookies_path.exists() and (
                not marker.exists()
                or cookies_path.stat().st_mtime > marker.stat().st_mtime
            )
            imported = 0
            if not profile_ok or fresh_export:
                imported = await import_cookie_file(context, self.settings)
                if imported:
                    marker.write_text(str(cookies_path.stat().st_mtime))
            elif profile_ok:
                logger.info("reusing self-renewing session from persistent profile")

            cookie = self.settings.seekingalpha.cookie
            if not imported and not profile_ok and cookie:
                try:
                    await context.add_cookies(parse_cookie_header(cookie))
                except Exception:  # noqa: BLE001
                    pass
            elif not imported and not profile_ok and not cookie:
                logger.warning(
                    "no auth found — drop a Cookie-Editor export at %s "
                    "(see README) for paywalled/personalized data",
                    cookies_path,
                )

            page = context.pages[0] if context.pages else await context.new_page()
            page.on("response", self._on_response)

            try:
                await self._scrape_homepage(page, result)
                # My Analysts (/account/people) is hard-blocked by PerimeterX on
                # direct load; disabled — homepage widgets already carry broad
                # analyst coverage. (_scrape_my_analysts remains for later use.)
                await self._scrape_top_analysts(page, result)
            except Exception as exc:  # noqa: BLE001 — keep whatever we got
                logger.exception("scrape error")
                result.errors.append(str(exc))
            finally:
                self._dump_api_captures()
                await context.close()

        return result

    # --- network capture ----------------------------------------------------
    def _on_response(self, response) -> None:
        url = response.url
        if "/api/" not in url:
            return

        async def grab() -> None:
            try:
                if "json" not in (response.headers.get("content-type") or ""):
                    return
                data = await response.json()
                self._api_captures.append((url, data))
            except Exception:  # noqa: BLE001
                pass

        # response handlers must not await inline; schedule it.
        asyncio.ensure_future(grab())

    def _dump_api_captures(self) -> None:
        if not self._api_captures:
            return
        out = self.debug_dir / "api_captures.json"
        payload = [{"url": u, "body": b} for u, b in self._api_captures]
        out.write_text(json.dumps(payload, ensure_ascii=False, indent=2)[:5_000_000])
        logger.info("saved %d API captures -> %s", len(self._api_captures), out)

    async def _save_debug(self, page, label: str) -> None:
        try:
            await page.screenshot(path=str(self.debug_dir / f"{label}.png"), full_page=True)
            (self.debug_dir / f"{label}.html").write_text(await page.content())
            logger.info("saved recon artifacts for %s", label)
        except Exception as exc:  # noqa: BLE001
            logger.warning("could not save debug for %s: %s", label, exc)

    # --- homepage tech widgets ---------------------------------------------
    async def _scrape_homepage(self, page, result: SAScrapeResult) -> None:
        await page.goto(HOME_URL, wait_until="domcontentloaded", timeout=60_000)
        await _settle(page)

        # The homepage widgets are lazy-rendered as you scroll, so a single
        # pass often catches nothing. Scroll + extract, and retry until we get
        # widgets (or give up) so runs are deterministic.
        widgets: list[dict] = []
        for attempt in range(1, 8):
            await self._scroll_through(page)
            widgets = await self._extract_home_widgets(page)
            if widgets:
                break
            logger.info("homepage: no widgets yet (attempt %d/7), waiting…", attempt)
            await page.wait_for_timeout(2500)

        await self._save_debug(page, "homepage")
        result.home_widgets = widgets
        rows = sum(len(g["rows"]) for w in result.home_widgets for g in w["groups"])
        logger.info(
            "homepage: %d widgets, %d total rows", len(result.home_widgets), rows
        )
        for w in result.home_widgets:
            logger.info(
                "  widget %r: %d groups, %d rows",
                w["title"][:48],
                len(w["groups"]),
                sum(len(g["rows"]) for g in w["groups"]),
            )

    async def _scroll_through(self, page) -> None:
        """Scroll top→bottom to trigger lazy rendering, then back to top."""
        try:
            for _ in range(8):
                await page.mouse.wheel(0, 1600)
                await page.wait_for_timeout(400)
            await page.evaluate("window.scrollTo(0, 0)")
            await page.wait_for_timeout(600)
        except Exception:  # noqa: BLE001
            pass

    async def _load_past_block(self, page, url: str, label: str, tries: int = 3) -> bool:
        """Navigate to a deep SA page, retrying through PerimeterX blocks.

        Deep pages (my-analysts, top-analysts) are more aggressively bot-walled
        than the homepage. A little human-like mouse movement plus a
        reload-after-wait often clears the challenge once the session cookie is
        present. Returns True if we landed on real content.
        """
        for attempt in range(1, tries + 1):
            try:
                for x, y in [(320, 280), (640, 520), (900, 380), (480, 680)]:
                    await page.mouse.move(x, y)
                    await page.wait_for_timeout(200)
            except Exception:  # noqa: BLE001
                pass
            await page.goto(url, wait_until="domcontentloaded", timeout=60_000)
            await _settle(page, quiet_ms=1800)
            title = (await page.title() or "").lower()
            html_len = len(await page.content())
            if "denied" not in title and "access to this page" not in title and html_len > 20_000:
                return True
            logger.info("%s blocked by bot wall (attempt %d/%d); waiting…", label, attempt, tries)
            await page.wait_for_timeout(6000)
        return False

    async def _spa_open(self, page, href_hint: str) -> bool:
        """Open a deep page by clicking an in-app link instead of a full load.

        SA's logged-in area is a SPA, so an internal-link click routes
        client-side (XHR only) and skips the full-document PerimeterX gate that
        blocks direct navigation. Returns True if it landed on real content.
        """
        try:
            link = await page.query_selector(
                f'a[href*="{href_hint}"], a[href*="/account/people"], a[href*="my-analysts"]'
            )
            if not link:
                return False
            await link.scroll_into_view_if_needed()
            await link.click()
            await _settle(page, quiet_ms=2000)
            title = (await page.title() or "").lower()
            return "denied" not in title and len(await page.content()) > 20_000
        except Exception:  # noqa: BLE001
            return False

    # --- My Analysts feed --------------------------------------------------
    async def _scrape_my_analysts(self, page, result: SAScrapeResult) -> None:
        """Extract recent Buy/Strong Buy articles from the analysts you follow."""
        cfg = self.settings.seekingalpha
        # Method A: SPA click from the current (homepage) tab — avoids the
        # full-page load PerimeterX blocks. Method B: direct nav with retry.
        loaded = await self._spa_open(page, "people") or await self._load_past_block(
            page, cfg.my_analysts_url, "my-analysts"
        )
        if not loaded:
            await self._save_debug(page, "my_analysts")
            logger.warning("my-analysts blocked; skipping (see sa_debug/my_analysts.*)")
            result.errors.append("my-analysts blocked by bot wall")
            return
        # The feed is infinite-scroll; load enough to cover the lookback window.
        for _ in range(14):
            await page.mouse.wheel(0, 2200)
            await page.wait_for_timeout(450)
        await self._save_debug(page, "my_analysts")

        try:
            items = await page.evaluate(_MY_ANALYSTS_JS)
        except Exception as exc:  # noqa: BLE001
            logger.warning("my-analysts extraction failed: %s", exc)
            return

        now = datetime.now(timezone.utc)
        picks: list[dict] = []
        seen: set[str] = set()
        for it in items or []:
            rating = (it.get("rating") or "").strip().lower()
            ticker = (it.get("ticker") or "").strip().upper()
            if rating not in ("buy", "strong buy") or not ticker:
                continue
            d = parse_feed_date(it.get("date"), now)
            if d is not None and (now.date() - d).days > cfg.my_analysts_lookback_days:
                continue
            href = it.get("href") or ""
            key = f"{ticker}|{href}"
            if key in seen:
                continue
            seen.add(key)
            picks.append(
                {
                    "ticker": ticker,
                    "rating": "Strong Buy" if rating == "strong buy" else "Buy",
                    "article_title": it.get("title", ""),
                    "article_url": href
                    if href.startswith("http")
                    else f"https://seekingalpha.com{href}",
                    "author": it.get("author"),
                    "published": d.isoformat() if d else None,
                }
            )

        result.my_analyst_picks = picks
        logger.info(
            "my analysts: %d Buy/Strong-Buy picks (≤%dd)",
            len(picks),
            cfg.my_analysts_lookback_days,
        )

    async def _extract_home_widgets(self, page) -> list[dict]:
        try:
            widgets = await page.evaluate(_HOME_WIDGETS_JS)
        except Exception as exc:  # noqa: BLE001
            logger.warning("home widget extraction failed: %s", exc)
            return []
        # A homepage widget column holds ~10 rows. Cap each group to bound the
        # occasional over-grab (container-climb swallowing a whole section)
        # WITHOUT dropping the widget — dropping could zero out the homepage.
        MAX_GROUP_ROWS = 15
        clean = []
        for w in widgets or []:
            groups = [g for g in w.get("groups", []) if g.get("rows")]
            for g in groups:
                g["rows"] = g["rows"][:MAX_GROUP_ROWS]
            if groups:
                clean.append(
                    {"title": w.get("title", ""), "description": w.get("description", ""), "groups": groups}
                )
        return clean

    # --- top analysts + their picks ----------------------------------------
    async def _scrape_top_analysts(self, page, result: SAScrapeResult) -> None:
        await page.goto(TOP_ANALYSTS_URL, wait_until="domcontentloaded", timeout=60_000)
        await _settle(page)
        await self._save_debug(page, "top_analysts")

        result.top_analysts = await self._extract_analysts(page)
        logger.info("top analysts: found %d", len(result.top_analysts))

        if self.recon:
            return

        top_n = self.settings.seekingalpha.top_n_analysts
        for analyst in result.top_analysts[:top_n]:
            try:
                picks = await self._extract_analyst_picks(page, analyst)
                result.analyst_picks.extend(picks)
            except Exception as exc:  # noqa: BLE001
                logger.warning("picks for %s failed: %s", analyst.name, exc)
        logger.info("analyst picks (Buy/Strong Buy): %d", len(result.analyst_picks))

    async def _extract_analysts(self, page) -> list[AnalystProfile]:
        js = """
        () => {
          const seen = new Set();
          const out = [];
          document.querySelectorAll('a[href*="/author/"]').forEach(a => {
            const href = a.getAttribute('href');
            const m = href.match(/\\/author\\/([a-z0-9\\-]+)/);
            if (!m) return;
            const name = (a.textContent || '').trim();
            if (!name || seen.has(m[1])) return;
            seen.add(m[1]);
            const row = a.closest('tr,li,div');
            out.push({
              name,
              url: href.startsWith('http') ? href : 'https://seekingalpha.com' + href,
              rowText: row ? row.innerText.replace(/\\n/g,' | ').trim() : ''
            });
          });
          return out;
        }
        """
        try:
            rows = await page.evaluate(js)
        except Exception as exc:  # noqa: BLE001
            logger.warning("analyst extraction failed: %s", exc)
            return []
        out: list[AnalystProfile] = []
        for i, r in enumerate(rows, start=1):
            if len(r["name"]) < 2:
                continue
            out.append(
                AnalystProfile(
                    name=r["name"],
                    profile_url=r["url"],
                    rank=i,
                    stats={"row": r.get("rowText", "")},
                )
            )
        return out

    async def _extract_analyst_picks(self, page, analyst: AnalystProfile) -> list[AnalystPick]:
        """Open an analyst's articles and keep their Buy / Strong Buy calls.

        Best-effort and defensive: SA marks ratings inconsistently across
        layouts. Returns [] rather than raising so one bad profile doesn't sink
        the run — recon artifacts tell us how to tighten this.
        """
        articles_url = analyst.profile_url.rstrip("/") + "/analysis"
        await page.goto(articles_url, wait_until="domcontentloaded", timeout=45_000)
        await _settle(page, quiet_ms=1200)

        js = """
        () => {
          const out = [];
          document.querySelectorAll('article, [data-test-id="post-list-item"], li').forEach(card => {
            const link = card.querySelector('a[href*="/article/"], a[href*="/news/"]');
            if (!link) return;
            const title = (link.textContent || '').trim();
            const href = link.getAttribute('href') || '';
            const text = (card.innerText || '');
            const tick = text.match(/\\b([A-Z]{1,5})\\b/);
            const symLink = card.querySelector('a[href*="/symbol/"]');
            const symMatch = symLink ? (symLink.getAttribute('href').match(/\\/symbol\\/([A-Z.\\-]{1,7})/)) : null;
            const rating = (text.match(/strong buy|buy|hold|sell/i) || [null])[0];
            out.push({
              title, href,
              ticker: symMatch ? symMatch[1] : (tick ? tick[1] : ''),
              rating: rating || ''
            });
          });
          return out.slice(0, 25);
        }
        """
        try:
            rows = await page.evaluate(js)
        except Exception:  # noqa: BLE001
            return []

        picks: list[AnalystPick] = []
        for r in rows:
            rating = (r.get("rating") or "").strip()
            ticker = (r.get("ticker") or "").strip().upper()
            if not ticker or rating.lower() not in ("buy", "strong buy"):
                continue
            href = r.get("href", "")
            picks.append(
                AnalystPick(
                    analyst=analyst.name,
                    profile_url=analyst.profile_url,
                    ticker=ticker,
                    rating="Strong Buy" if rating.lower() == "strong buy" else "Buy",
                    article_title=r.get("title", ""),
                    article_url=href if href.startswith("http") else f"https://seekingalpha.com{href}",
                    rank=analyst.rank,
                )
            )
        return picks


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
async def _settle(page, quiet_ms: int = 800) -> None:
    """Give client-side rendering a moment; ignore networkidle timeouts."""
    try:
        await page.wait_for_load_state("networkidle", timeout=15_000)
    except Exception:  # noqa: BLE001
        pass
    await page.wait_for_timeout(quiet_ms)


def _is_empty(result_dict: dict) -> bool:
    c = result_dict.get("counts", {})
    return not (c.get("home_widget_rows") or c.get("analyst_picks") or c.get("top_analysts"))


def _payload_tickers(payload: dict) -> set[str]:
    return {
        (r.get("ticker") or "").strip().upper()
        for w in payload.get("home_widgets", [])
        for g in w.get("groups", [])
        for r in g.get("rows", [])
        if r.get("ticker")
    }


def _merge_carryover(payload: dict, output_dir: Path, run_date: date) -> dict:
    """Keep the seed universe cumulative, but bounded by a recency window.

    A partial scrape (weakened cookie, SA layout change) would otherwise shrink
    latest.json, dropping names the user expects to persist. So tickers missing
    from this run are carried forward from prior snapshots. To stop the universe
    growing without limit, a ticker is only carried while it has been SEEN FRESH
    (in a real scrape or a manual watchlist) within the last ``CARRY_DAYS`` days
    (env, default 30). Names that stop appearing for that long age out.

    ``seed_seen.json`` = {ticker: last-fresh date} tracks this. On the very first
    run with this window, everything already known is grandfathered to today so
    nothing drops abruptly — the clock starts now.
    """
    carry_days = int(os.environ.get("CARRY_DAYS", "30"))
    seen_path = output_dir / "seed_seen.json"
    try:
        seen: dict[str, str] = json.loads(seen_path.read_text()) if seen_path.exists() else {}
    except (ValueError, OSError):
        seen = {}
    first_time = not seen
    today = run_date.isoformat()
    cutoff = run_date - timedelta(days=carry_days) if carry_days > 0 else None

    # Everything in THIS payload (fresh scrape + manual watchlists) = seen today.
    have = _payload_tickers(payload)
    for tk in have:
        seen[tk] = today

    def recent(tk: str) -> bool:
        if cutoff is None or first_time:
            return True
        d = seen.get(tk)
        if not d:
            return False
        try:
            return date.fromisoformat(d) >= cutoff
        except ValueError:
            return True

    carry: list[dict] = []
    done: set[str] = set()
    # Newest first (so the freshest prior row wins): "latest" sorts after dates.
    for path in sorted(output_dir.glob("seekingalpha_*.json"), reverse=True):
        try:
            prev = json.loads(path.read_text())
        except (ValueError, OSError):
            continue
        for w in prev.get("home_widgets", []):
            for g in w.get("groups", []):
                for r in g.get("rows", []):
                    tk = (r.get("ticker") or "").strip().upper()
                    if tk and tk not in have and tk not in done and recent(tk):
                        done.add(tk)
                        carry.append(r)
                        if first_time:
                            seen.setdefault(tk, today)  # grandfather in

    if carry:
        payload.setdefault("home_widgets", []).append(
            {
                "title": "Carried Over",
                "description": "seen in a recent scrape, kept so the universe never shrinks on a weak run",
                "groups": [{"label": "", "rows": carry}],
            }
        )
        logger.info("carried over %d tickers (within %d-day window)", len(carry), carry_days)

    # Prune aged-out names from the tracker so it stays bounded too.
    if cutoff and not first_time:
        seen = {tk: d for tk, d in seen.items() if tk in have or recent(tk)}
    try:
        seen_path.write_text(json.dumps(seen))
    except OSError:
        pass
    return payload


def write_result(result: SAScrapeResult, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    payload = result.to_dict()
    latest = output_dir / "seekingalpha_latest.json"

    # Safety net: never let an empty OR drastically weakened scrape (widgets
    # didn't render, cookie expired, SA layout change) clobber a previously-good
    # latest.json the web page is showing. Returning early here also skips the
    # carryover bookkeeping below, so seed_seen.json isn't pruned by a bad run —
    # that pruning is what let one 7-row scrape age out a 767-name universe.
    prev: dict | None = None
    if latest.exists():
        try:
            prev = json.loads(latest.read_text())
        except (ValueError, OSError):
            prev = None
    if prev is not None and not _is_empty(prev):
        if _is_empty(payload):
            logger.warning("scrape came back empty; keeping previous seekingalpha_latest.json")
            return latest
        # A run that sees fewer than WEAK_SCRAPE_RATIO of the prior universe is a
        # broken scrape (expired cookie / layout change), not a real shrink.
        weak_ratio = float(os.environ.get("WEAK_SCRAPE_RATIO", "0.5"))
        fresh_n = len(_payload_tickers(payload))
        prev_n = len(_payload_tickers(prev))
        if prev_n >= 20 and fresh_n < prev_n * weak_ratio:
            logger.warning(
                "scrape looks broken (%d names vs %d previously) — keeping previous "
                "seekingalpha_latest.json; check the SA login cookie",
                fresh_n, prev_n,
            )
            return latest

    # Keep the universe cumulative (bounded to a recency window) so a partial
    # scrape never drops seeds, but stale names age out.
    payload = _merge_carryover(payload, output_dir, result.generated_at.date())

    latest.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    day = result.generated_at.date().isoformat()
    (output_dir / f"seekingalpha_{day}.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2)
    )
    return latest


def write_health(result: SAScrapeResult, output_dir: Path) -> None:
    """Record scrape health so the dashboard can warn when login expires.

    ``auth_ok`` is false when a run produced no logged-in widgets — the usual
    sign the SeekingAlpha session cookie has expired and needs refreshing.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / "health.json"
    prev: dict = {}
    if path.exists():
        try:
            prev = json.loads(path.read_text())
        except (ValueError, OSError):
            prev = {}

    widgets = len(result.home_widgets)
    auth_ok = widgets > 0
    now = result.generated_at.isoformat()
    path.write_text(
        json.dumps(
            {
                "last_attempt": now,
                "last_success": now if auth_ok else prev.get("last_success"),
                "auth_ok": auth_ok,
                "widgets": widgets,
            },
            indent=2,
        )
    )


_TICKER_RE = re.compile(r"^[A-Z]{1,5}(?:[.\-][A-Z]{1,3})?$")
# Common all-caps tokens that show up in pasted screener tables but aren't the
# symbol we want (financial-metric column noise). Kept tight so real tickers
# aren't dropped.
_TICKER_STOP = {
    "TTM", "NM", "PE", "EPS", "YOY", "USD", "ETF", "NA", "LTM", "YTD",
    "EV", "ROE", "ROA", "PEG", "DIV", "MKT", "CAP", "VS", "AND", "THE",
}


def _extract_tickers(text: str) -> list[str]:
    """Pull ticker symbols out of a pasted screener / list.

    Preferred (and cleanest) shape is one field per line, so the Symbol sits
    alone on its own line — we take every line that is *exactly* a ticker. That
    ignores company-name abbreviations (TD SYNNEX → TD, RF Industries → RF) and
    topic text (AI and Machine Learning). If almost none are found, we fall back
    to the first ticker-like token on each line so a single-line table still
    works.
    """
    strict: list[str] = []
    seen: set[str] = set()
    for line in text.splitlines():
        s = line.strip()
        if _TICKER_RE.match(s) and s not in _TICKER_STOP and s not in seen:
            seen.add(s)
            strict.append(s)
    if len(strict) >= 3:
        return strict

    loose: list[str] = []
    seen = set()
    for line in text.splitlines():
        for tok in re.split(r"[,\t;| ]+", line.strip()):
            if _TICKER_RE.match(tok) and tok not in _TICKER_STOP:
                if tok not in seen:
                    seen.add(tok)
                    loose.append(tok)
                break  # first symbol-like token per line = the Symbol column
    return loose


def load_manual_watchlists(output_dir: Path) -> list[dict]:
    """Fold user-maintained ticker lists into the seed universe — zero scraping.

    Drop one file per list in ``data/newsagg/screeners/`` (``.txt`` or ``.csv``).
    You paste/export the Symbol column from any SA screener (or anywhere) while
    logged in to normal Chrome; SA's bot wall never enters the picture. Each
    file becomes its own widget, so the whole funnel picks the tickers up.
    """
    d = output_dir / "screeners"
    if not d.exists():
        return []
    widgets: list[dict] = []
    for path in sorted(d.glob("*.txt")) + sorted(d.glob("*.csv")):
        try:
            text = path.read_text()
        except OSError:
            continue
        tickers = _extract_tickers(text)
        if not tickers:
            continue
        title = path.stem.replace("_", " ").replace("-", " ").strip().title() or "Watchlist"
        rows = [
            {"ticker": t, "company": None, "rating": "BUY",
             "article": None, "article_url": None, "analyst": None}
            for t in tickers
        ]
        widgets.append(
            {"title": title, "description": f"manual watchlist · {path.name}",
             "groups": [{"label": "", "rows": rows}]}
        )
        logger.info("watchlist %r: %d tickers (%s)", title, len(tickers), path.name)
    return widgets


async def _run_once(settings: Settings, args: argparse.Namespace) -> SAScrapeResult:
    scraper = SeekingAlphaScraper(settings, headed=args.headed, recon=args.recon)
    result = await scraper.run()
    # Merge in any user-maintained watchlists (robust even if the scrape was
    # blocked — these are pure local file reads).
    result.home_widgets.extend(load_manual_watchlists(settings.output_dir))
    path = write_result(result, settings.output_dir)
    write_health(result, settings.output_dir)
    print("\n=== SeekingAlpha scrape ===")
    print(json.dumps(result.to_dict()["counts"], indent=2))
    if result.errors:
        print("errors:", result.errors)
    print(f"wrote: {path}")
    print(f"debug: {settings.output_dir / 'sa_debug'}")
    return result


async def _main(args: argparse.Namespace) -> int:
    settings = load_settings(args.config)
    if args.watch:
        logger.info("watch mode: scraping every %d min (Ctrl-C to stop)", args.watch)
        while True:
            await _run_once(settings, args)
            await asyncio.sleep(args.watch * 60)
    result = await _run_once(settings, args)
    return 0 if not result.errors else 1


def main() -> int:
    p = argparse.ArgumentParser(description="SeekingAlpha scraper")
    p.add_argument("--config", default=None)
    p.add_argument("--recon", action="store_true", help="capture debug artifacts only")
    p.add_argument("--headed", action="store_true", help="show the browser window")
    p.add_argument("--watch", type=int, metavar="MIN", help="re-scrape every MIN minutes")
    p.add_argument("--verbose", "-v", action="store_true")
    args = p.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
        datefmt="%H:%M:%S",
    )
    try:
        return asyncio.run(_main(args))
    except KeyboardInterrupt:
        print("\nstopped")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
