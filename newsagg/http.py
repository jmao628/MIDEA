"""Shared async HTTP client with retry/backoff.

All collectors go through :func:`get_client` so they share connection pooling,
a browser-ish User-Agent (several of these hosts block default clients), and a
single retry policy for transient failures.
"""

from __future__ import annotations

import asyncio
import logging

import httpx

logger = logging.getLogger("newsagg.http")

# Statuses worth retrying: rate limits and transient server errors.
_RETRY_STATUSES = {429, 500, 502, 503, 504}


def get_client(
    *,
    user_agent: str,
    timeout_s: float = 30.0,
    cookie: str | None = None,
    headers: dict[str, str] | None = None,
) -> httpx.AsyncClient:
    base_headers = {
        "User-Agent": user_agent,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
    }
    if cookie:
        base_headers["Cookie"] = cookie
    if headers:
        base_headers.update(headers)
    return httpx.AsyncClient(
        headers=base_headers,
        timeout=timeout_s,
        follow_redirects=True,
    )


async def fetch(
    client: httpx.AsyncClient,
    url: str,
    *,
    params: dict | None = None,
    max_retries: int = 4,
    base_delay: float = 2.0,
) -> httpx.Response | None:
    """GET ``url`` with exponential backoff. Returns ``None`` on give-up.

    Backoff schedule mirrors the repo's git-op convention: 2s, 4s, 8s, 16s.
    Only transient failures (network errors and 429/5xx) are retried. Other
    4xx — including 403/407 egress-policy denials and 404s — return ``None``
    immediately; retrying a policy denial just wastes time.
    """
    for attempt in range(max_retries + 1):
        try:
            resp = await client.get(url, params=params)
        except httpx.TransportError as exc:
            if attempt >= max_retries:
                logger.warning("GET %s failed after %d attempts: %s", url, attempt + 1, exc)
                return None
            await _backoff(url, str(exc), attempt, base_delay)
            continue

        if resp.status_code < 400:
            return resp
        if resp.status_code not in _RETRY_STATUSES:
            logger.warning("GET %s returned %d (not retryable)", url, resp.status_code)
            return None
        if attempt >= max_retries:
            logger.warning(
                "GET %s failed after %d attempts: %d", url, attempt + 1, resp.status_code
            )
            return None
        await _backoff(url, str(resp.status_code), attempt, base_delay)
    return None


async def _backoff(url: str, reason: str, attempt: int, base_delay: float) -> None:
    delay = base_delay * (2**attempt)
    logger.info("GET %s failed (%s); retrying in %.0fs", url, reason, delay)
    await asyncio.sleep(delay)
