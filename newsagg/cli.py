"""Command-line entrypoint for the collection layer.

    python -m newsagg.cli                 # run all collectors, dump JSON
    python -m newsagg.cli --config path   # use a specific config.yaml
    python -m newsagg.cli --no-write      # print summary only, don't write files
    python -m newsagg.cli --verbose       # debug logging
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging

from newsagg.config import load_settings
from newsagg.pipeline import run_collection, write_result


def _setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
        datefmt="%H:%M:%S",
    )


async def _main(args: argparse.Namespace) -> int:
    settings = load_settings(args.config)
    result = await run_collection(settings)

    print("\n=== collection summary ===")
    print(json.dumps(result.summary, ensure_ascii=False, indent=2))

    if not args.no_write:
        paths = write_result(result, settings.output_dir)
        print("\nwrote:")
        for label, path in paths.items():
            print(f"  {label}: {path}")

    return 0 if not result.errors else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="newsagg collection layer")
    parser.add_argument("--config", help="path to config.yaml", default=None)
    parser.add_argument("--no-write", action="store_true", help="don't write output files")
    parser.add_argument("--verbose", "-v", action="store_true", help="debug logging")
    args = parser.parse_args()

    _setup_logging(args.verbose)
    return asyncio.run(_main(args))


if __name__ == "__main__":
    raise SystemExit(main())
