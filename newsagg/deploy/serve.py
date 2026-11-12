"""Local static file server (no-cache) with a small live-quote endpoint.

`python -m http.server` lets the browser cache index.html, so a freshly
rebuilt dashboard keeps showing the old bundle until you manually clear the
cache. This server tells the browser never to cache, so a plain refresh always
shows the latest build.

It also serves ONE dynamic route so a ticker's chart + technicals refresh the
moment you open it, instead of only once a day when the launchd job runs:

    GET /api/quote?ticker=NVDA
        → live yfinance fetch for that one ticker, computed through the same
          newsagg.technical math, returned as JSON (same shape as a row in
          technical_latest.json) + a `generated_at` timestamp.

The fetch needs Yahoo reachable — behind a VPN, run the web job with a proxy
(install_mac.sh passes PROXY= into the plist; yfinance honours HTTPS_PROXY).

    python newsagg/deploy/serve.py [PORT] [DIRECTORY]
"""

from __future__ import annotations

import functools
import json
import os
import sys
import time
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/quote":
            self._serve_quote()
            return
        if path == "/api/quotes":
            self._serve_quotes()
            return
        if path == "/api/watchlist":
            self._serve_watchlist_get()
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        if urlparse(self.path).path == "/api/watchlist":
            self._serve_watchlist_post()
            return
        self._send_json(404, {"error": "not found"})

    def _send_json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_quote(self) -> None:
        params = parse_qs(urlparse(self.path).query)
        ticker = (params.get("ticker", [""])[0] or "").strip().upper()
        if not ticker:
            self._send_json(400, {"error": "missing ticker"})
            return
        from newsagg import technical as tech

        # live_ticker splices the reliable fast_info price onto the series, so the
        # price + day's % are stable (not from a flickering intraday tail bar).
        # The yfinance fetch through the VPN proxy fails intermittently, though —
        # and a single failure falls back to the STALE daily snapshot, making the
        # day's % flip between the live and the snapshot value. Retry a few times
        # so a transient miss doesn't surface the stale %.
        out = None
        for i in range(4):
            try:
                out = tech.live_ticker(ticker)
            except Exception:  # noqa: BLE001
                out = None
            if out and out.get("price"):
                break
            time.sleep(0.4 * (i + 1))

        # Contamination guard: yfinance-through-a-proxy occasionally returns
        # ANOTHER ticker's data under concurrency (e.g. a $131 name coming back as
        # $5.72). If the fresh price is wildly off the stored daily close, it's a
        # wrong-ticker response — discard it and serve the trusted stored row.
        stored = self._stored_tech(ticker)
        if out and out.get("price") and stored and stored.get("price"):
            base = stored["price"]
            if base > 0 and abs(out["price"] - base) / base > 0.40:
                out = None
        if not out:
            if stored and stored.get("price"):
                out = dict(stored)
                out["from_snapshot"] = True  # fresh fetch failed/contaminated → trusted snapshot
            else:
                self._send_json(404, {"error": f"no data for {ticker}"})
                return
        out["ticker"] = ticker
        out["generated_at"] = datetime.now(timezone.utc).isoformat()
        self._send_json(200, out)

    def _stored_tech(self, ticker: str) -> dict | None:
        """The last daily row for a ticker from technical_latest.json — a trusted
        magnitude anchor for the contamination guard + a fallback when the live
        fetch fails."""
        try:
            path = os.path.join(self.directory, "data", "newsagg", "technical_latest.json")
            with open(path, encoding="utf-8") as f:
                return json.load(f).get("tickers", {}).get(ticker)
        except (OSError, ValueError):
            return None

    def _serve_quotes(self) -> None:
        """Batch today's-move for many tickers in ONE yfinance call, so the
        Strong-Buy leaderboard can refresh + re-rank live (per-ticker /api/quote
        would be hundreds of calls). Returns {ticker: change_pct}."""
        import re

        params = parse_qs(urlparse(self.path).query)
        raw = (params.get("tickers", [""])[0] or "").strip().upper()
        tickers = [x for x in re.split(r"[^A-Z0-9.\-]+", raw) if x][:500]
        if not tickers:
            self._send_json(400, {"error": "no tickers"})
            return
        ymap = {t: t.replace(".", "-") for t in tickers}
        out: dict[str, float] = {}
        try:
            import yfinance as yf

            # timeout so a down Yahoo/VPN fails this endpoint in seconds instead
            # of hanging — the live-quote overlay is optional, the page must not
            # wait on it.
            df = yf.download(list(ymap.values()), period="2d", auto_adjust=False, progress=False, threads=True, timeout=8)
            # df["Close"] works for both: a DataFrame (multi-ticker, columns = tickers)
            # or a Series (single ticker). `multi` distinguishes them.
            closes = df["Close"]
            multi = hasattr(closes, "columns")
            cols = set(closes.columns) if multi else set()
            for tk, y in ymap.items():
                try:
                    if multi:
                        if y not in cols:
                            continue
                        vals = [float(x) for x in closes[y].tolist() if x == x]
                    else:
                        if len(ymap) != 1:
                            continue
                        vals = [float(x) for x in closes.tolist() if x == x]
                    if len(vals) >= 2 and vals[-2]:
                        out[tk] = round(100 * (vals[-1] / vals[-2] - 1), 2)
                except Exception:  # noqa: BLE001, PERF203
                    continue
        except Exception as exc:  # noqa: BLE001
            self._send_json(502, {"error": f"batch failed: {exc}"})
            return
        self._send_json(200, {"quotes": out, "generated_at": datetime.now(timezone.utc).isoformat()})

    # The backtest watchlist, persisted server-side so the daily price-track job
    # (newsagg.track) can pick it up and grow a dated history for those names.
    def _watchlist_path(self) -> str:
        import os

        return os.path.join(self.directory, "data", "newsagg", "watchlist.json")

    def _serve_watchlist_get(self) -> None:
        try:
            with open(self._watchlist_path(), encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            data = {"tickers": []}
        self._send_json(200, data)

    def _serve_watchlist_post(self) -> None:
        import os
        import re

        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            self._send_json(400, {"error": "bad json"})
            return
        tickers = body.get("tickers") if isinstance(body, dict) else None
        if not isinstance(tickers, list):
            self._send_json(400, {"error": "tickers must be a list"})
            return
        clean: list[str] = []
        seen: set[str] = set()
        for t in tickers:
            s = str(t).strip().upper()
            if s and re.fullmatch(r"[A-Z0-9.\-]{1,8}", s) and s not in seen:
                seen.add(s)
                clean.append(s)
        payload = {"tickers": clean, "updated_at": datetime.now(timezone.utc).isoformat()}
        path = self._watchlist_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        self._send_json(200, payload)

    # Quieter logging — the default logs every poll request.
    def log_message(self, *args) -> None:  # noqa: D401
        pass


def _repo_root() -> str:
    # serve.py lives at <repo>/newsagg/deploy/serve.py, so the repo root is three
    # levels up. Deriving it from __file__ (not cwd) means the server ALWAYS
    # serves the right tree no matter what directory it's launched from — the
    # cause of the recurring "dashboard 404 from a stale/wrong-cwd process".
    return os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    # Absolute repo root, resolved from THIS file's location — ignore cwd. An
    # explicit dir arg still wins (made absolute) but is no longer required.
    directory = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else _repo_root()
    # Make `newsagg` importable for the live-quote endpoint (directory = repo root).
    if directory not in sys.path:
        sys.path.insert(0, directory)
    handler = functools.partial(NoCacheHandler, directory=directory)
    print(f"serving {directory} on http://localhost:{port} (no-cache, +live quotes)")
    # ThreadingHTTPServer (not HTTPServer): the live-quote endpoints do slow
    # yfinance fetches that can hang for seconds. On a single-threaded server that
    # blocks EVERY other request — the page stalls waiting for a quote batch. One
    # thread per request keeps static files + JSON serving instantly regardless.
    ThreadingHTTPServer(("", port), handler).serve_forever()


if __name__ == "__main__":
    main()
