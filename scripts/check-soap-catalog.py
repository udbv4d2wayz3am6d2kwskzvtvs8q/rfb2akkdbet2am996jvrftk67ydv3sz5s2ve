#!/usr/bin/env python3
"""Validate that published SOAP HLS masters are anonymously readable."""

from __future__ import annotations

import concurrent.futures
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "soap-movies.json"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"


def env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name) or default)
    except ValueError:
        return default


def env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name) or default)
    except ValueError:
        return default


scope = os.getenv("SOAP_CHECK_SCOPE") or "sample"
default_limit = 20 if scope == "sample" else 0
limit = env_int("SOAP_CHECK_LIMIT", default_limit)
timeout = env_int("SOAP_CHECK_TIMEOUT_MS", 8000) / 1000
concurrency = max(1, env_int("SOAP_CHECK_CONCURRENCY", 4))
min_ok_ratio = env_float("SOAP_CHECK_MIN_OK_RATIO", 1)
referer = os.getenv("SOAP_CHECK_REFERER") or ""
recent_first = os.getenv("SOAP_CHECK_RECENT") == "1"


def is_priority(movie: dict[str, Any]) -> bool:
    return movie.get("q") == "4K" or int(movie.get("w") or 0) > 1920 or int(movie.get("h") or 0) > 1080


def ordered_movies(movies: list[dict[str, Any]]) -> list[dict[str, Any]]:
    priority = [movie for movie in movies if is_priority(movie)]
    rest = [movie for movie in movies if not is_priority(movie)]
    if recent_first:
        priority.sort(key=lambda movie: int(movie.get("refreshed") or 0), reverse=True)
        rest.sort(key=lambda movie: int(movie.get("refreshed") or 0), reverse=True)
    if scope == "priority":
        return priority
    if scope == "all":
        return priority + rest
    return priority + rest


def read_catalog() -> tuple[dict[str, Any], list[dict[str, Any]]]:
    with CATALOG_PATH.open() as file:
        catalog = json.load(file)
    movies = [movie for movie in catalog.get("movies", []) if movie.get("m")]
    ordered = ordered_movies(movies)
    sample = ordered[:limit] if limit > 0 else ordered
    return catalog, sample


def check_movie(movie: dict[str, Any]) -> dict[str, Any]:
    headers = {
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "*/*",
    }
    if referer:
        headers["Referer"] = referer
    request = urllib.request.Request(movie["m"], headers=headers)
    status = 0
    body = ""
    message = ""
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = response.status
            body = response.read(65536).decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        status = error.code
        body = error.read(512).decode("utf-8", "replace") if error.fp else ""
        message = body[:80].replace("\n", " ")
    except Exception as error:
        message = f"{type(error).__name__}: {error}"

    ok = status == 200 and "#EXTM3U" in body and "#EXT-X-STREAM-INF" in body
    return {
        "id": movie.get("id"),
        "title": movie.get("t"),
        "quality": movie.get("q"),
        "ok": ok,
        "status": status,
        "message": message,
    }


def main() -> None:
    catalog, sample = read_catalog()
    if not sample:
        print(f"No SOAP movie masters found for scope={scope} in soap-movies.json", file=sys.stderr)
        raise SystemExit(1)

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(concurrency, len(sample))) as pool:
        results = list(pool.map(check_movie, sample))

    failed = [item for item in results if not item["ok"]]
    ok = len(results) - len(failed)
    priority_count = sum(1 for movie in catalog.get("movies", []) if is_priority(movie))
    print(
        f"SOAP catalog check: {ok}/{len(results)} manifests OK "
        f"(scope={scope}, priority={priority_count}, generated={catalog.get('generated') or '?'})"
    )
    for item in failed[:12]:
        print(
            f"FAIL {item['status'] or 'ERR'} id={item['id']} q={item['quality']} "
            f"\"{item['title']}\" {item['message']}"
        )
    if ok / len(results) < min_ok_ratio:
        print("Refresh soap-movies.json before deploying SOAP movies.")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
