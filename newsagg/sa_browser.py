"""Shared browser launcher tuned to get past SeekingAlpha's bot detection.

SA blocks the vanilla Playwright Chromium (it advertises automation). Three
things together get a manual login and subsequent scraping through reliably:

1. Use the *real* Google Chrome install (``channel="chrome"``) instead of the
   bundled Chromium — its fingerprint matches a normal user.
2. Drop the automation flags (``--enable-automation``,
   ``AutomationControlled``) and hide ``navigator.webdriver``.
3. Use a *persistent* profile dir, so cookies / local storage survive between
   the login step and every later scrape — exactly like a normal browser that
   stays logged in.

If real Chrome isn't installed we fall back to bundled Chromium (may still be
blocked; installing Chrome is the fix).
"""

from __future__ import annotations

import json
import logging

from newsagg.config import Settings

logger = logging.getLogger("newsagg.sa_browser")

# A Cookie-Editor / EditThisCookie JSON export dropped here logs us in without
# any automated login (which SA blocks). See README "Log in via cookie export".
COOKIE_FILE = "sa_cookies.json"

_STEALTH_JS = """
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
window.chrome = window.chrome || { runtime: {} };
Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
"""


def profile_dir(settings: Settings) -> str:
    return str(settings.output_dir / "sa_profile")


async def launch_context(pw, settings: Settings, *, headless: bool):
    """Launch a persistent, low-detection browser context.

    Returns a Playwright ``BrowserContext`` (persistent contexts own their own
    browser process, so close the context, not a separate browser).
    """
    settings.output_dir.mkdir(parents=True, exist_ok=True)
    common = dict(
        user_data_dir=profile_dir(settings),
        headless=headless,
        args=["--disable-blink-features=AutomationControlled", "--no-first-run"],
        ignore_default_args=["--enable-automation"],
        user_agent=settings.user_agent,
        viewport={"width": 1440, "height": 2200},
    )

    try:
        context = await pw.chromium.launch_persistent_context(channel="chrome", **common)
        logger.info("launched real Google Chrome (channel=chrome)")
    except Exception as exc:  # noqa: BLE001 — Chrome not installed / not found
        logger.warning("real Chrome unavailable (%s); falling back to bundled Chromium", exc)
        context = await pw.chromium.launch_persistent_context(**common)

    await context.add_init_script(_STEALTH_JS)
    return context


_SAMESITE = {"lax": "Lax", "strict": "Strict", "no_restriction": "None", "none": "None"}


def _to_playwright_cookie(c: dict) -> dict | None:
    """Convert one Cookie-Editor / EditThisCookie record to Playwright's shape."""
    name, value = c.get("name"), c.get("value")
    domain = c.get("domain")
    if not name or value is None or not domain:
        return None
    out: dict = {
        "name": name,
        "value": value,
        "domain": domain,
        "path": c.get("path", "/"),
        "httpOnly": bool(c.get("httpOnly", False)),
        "secure": bool(c.get("secure", False)),
    }
    exp = c.get("expirationDate") or c.get("expires")
    if exp and not c.get("session"):
        out["expires"] = float(exp)
    ss = _SAMESITE.get(str(c.get("sameSite") or "").lower())
    if ss:
        out["sameSite"] = ss
    return out


async def import_cookie_file(context, settings: Settings) -> int:
    """Load a cookie-export JSON (if present) into the context. Returns count.

    Accepts the Cookie-Editor / EditThisCookie export format (a JSON array of
    cookie objects). The file stays on the user's machine and is gitignored.
    """
    path = settings.output_dir / COOKIE_FILE
    if not path.exists():
        return 0
    try:
        raw = json.loads(path.read_text())
    except (ValueError, OSError) as exc:
        logger.warning("could not read %s: %s", path, exc)
        return 0

    records = raw.get("cookies", raw) if isinstance(raw, dict) else raw
    cookies = [pc for c in records if (pc := _to_playwright_cookie(c))]
    if not cookies:
        logger.warning("%s had no usable cookies", path)
        return 0

    try:
        await context.add_cookies(cookies)
    except Exception as exc:  # noqa: BLE001 — retry without sameSite, which is finicky
        for c in cookies:
            c.pop("sameSite", None)
        try:
            await context.add_cookies(cookies)
        except Exception as exc2:  # noqa: BLE001
            logger.warning("add_cookies failed: %s / %s", exc, exc2)
            return 0
    logger.info("imported %d cookies from %s", len(cookies), path)
    return len(cookies)
