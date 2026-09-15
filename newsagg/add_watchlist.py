"""Interactive helper to save SA screeners (or any ticker list) as watchlist
files — reads the clipboard on your cue, so terminal paste/quoting never bites.

    python -m newsagg.add_watchlist

For each list: type a name, then go to Chrome and copy the screener's rows,
come back and press Enter. The clipboard is read *after* you copy, so it never
matters how you launched this. Writes data/newsagg/screeners/<name>.txt, which
the scraper folds into the seed universe on the next run.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

from newsagg.config import load_settings
from newsagg.sa_scrape import load_manual_watchlists


def _clipboard() -> str:
    try:
        return subprocess.run(["pbpaste"], capture_output=True, text=True).stdout
    except FileNotFoundError:
        return ""


def _parsed_count(output_dir: Path, filename: str) -> tuple[int, list[str]]:
    for w in load_manual_watchlists(output_dir):
        if w["description"].endswith(filename):
            rows = w["groups"][0]["rows"]
            return len(rows), [r["ticker"] for r in rows[:12]]
    return 0, []


def main() -> int:
    settings = load_settings(None)
    d = settings.output_dir / "screeners"
    d.mkdir(parents=True, exist_ok=True)

    print("\n=== 保存自选清单 / SA screener ===")
    print(f"文件夹: {d}")
    print("每个清单:输入名字 → 去 Chrome 选中表格 Cmd+C → 回来按 Enter。")
    print("名字留空并回车 = 结束。\n")

    saved = 0
    while True:
        try:
            name = input("清单名字 (如 Top-Technology,留空结束): ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not name:
            break
        input(f"→ 去 Chrome 选中「{name}」的表格,Cmd+C 复制,然后回到这里按 Enter…")
        text = _clipboard()
        if not text.strip():
            print("  剪贴板是空的,跳过。先复制表格再按 Enter。\n")
            continue

        fname = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-") + ".txt"
        path = d / fname
        path.write_text(text)
        n, sample = _parsed_count(settings.output_dir, fname)
        if n == 0:
            print(f"  ⚠️ 存了 {fname},但没解析出 ticker。可能没复制到表格?可重做。\n")
        else:
            saved += 1
            print(f"  ✓ {fname} · 解析出 {n} 只: {sample}{' …' if n > 12 else ''}\n")

    print(f"完成,共保存 {saved} 个清单。")
    if saved:
        print("接着跑:  PROXY=http://127.0.0.1:3213 bash newsagg/deploy/run_now.sh")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
