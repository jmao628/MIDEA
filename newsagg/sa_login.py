"""Interactive SeekingAlpha login — save your session once, reuse it forever.

Run this once (and again whenever the session expires):

    python -m newsagg.sa_login

A real browser window opens. Log into your SeekingAlpha account there yourself
— including any captcha or 2-factor step. When you're logged in, come back to
the terminal and press Enter. Your session (cookies + local storage) is saved
to ``data/newsagg/sa_auth.json`` on THIS machine only. Nothing is transmitted
anywhere, and the file is gitignored so it never gets committed.

The scraper (``newsagg.sa_scrape``) automatically picks up that saved session,
so you never have to hand-copy a cookie string.
"""

from __future__ import annotations

import argparse
import asyncio
import logging

from newsagg.config import load_settings

logger = logging.getLogger("newsagg.sa_login")

LOGIN_URL = "https://seekingalpha.com/"


async def _prompt(message: str) -> None:
    """Non-blocking input() so the browser stays responsive while we wait."""
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, input, message)


async def _main(args: argparse.Namespace) -> int:
    settings = load_settings(args.config)

    from playwright.async_api import async_playwright

    from newsagg.sa_browser import launch_context, profile_dir

    async with async_playwright() as pw:
        # Persistent + real-Chrome context so SA doesn't flag us as a bot and
        # the login survives for later scrapes.
        context = await launch_context(pw, settings, headless=False)
        page = context.pages[0] if context.pages else await context.new_page()
        await page.goto(LOGIN_URL, wait_until="domcontentloaded")

        print("\n" + "=" * 64)
        print("A browser window just opened.")
        print("  1) Log into your SeekingAlpha account in that window.")
        print("     (do any captcha / 2-factor step yourself — that's fine)")
        print("  2) Once the page shows you're logged in, come back here.")
        print("=" * 64)
        await _prompt("Press Enter to save your session... ")

        # The persistent profile already holds the session; this file is just a
        # portable backup the scraper can also read.
        auth_path = settings.output_dir / "sa_auth.json"
        await context.storage_state(path=str(auth_path))
        print(f"\n✓ Saved your SeekingAlpha session (profile: {profile_dir(settings)})")
        print("  Now run:  python -m newsagg.sa_scrape")
        await context.close()
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Save a SeekingAlpha login session")
    p.add_argument("--config", default=None)
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    try:
        return asyncio.run(_main(args))
    except KeyboardInterrupt:
        print("\ncancelled")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
